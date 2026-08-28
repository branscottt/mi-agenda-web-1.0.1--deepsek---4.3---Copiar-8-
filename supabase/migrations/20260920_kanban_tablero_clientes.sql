-- ============================================================
-- MIGRACIÓN: Tablero de información por cliente (estilo Trello)
-- Fecha: 2026-09-20
--
-- PROBLEMA: el admin no tiene dónde guardar información extendida
-- por cliente (notas, documentos, checklists, estado de pago).
-- Solo ve el historial de citas en "Mis Clientes".
--
-- SOLUCIÓN: tablero kanban por cliente (identificado por email,
-- igual que deduplicarClientes en ClientListView):
--   - kanban_boards      : un tablero por (tenant_id, cliente_email)
--   - kanban_lists       : columnas del tablero
--   - kanban_cards       : tarjetas; cita_id opcional la vincula a
--                          una cita programada; etiquetas jsonb
--                          guarda el estado de pago de la tarjeta.
--   - kanban_checklist_items : checklist de la tarjeta
--   - kanban_attachments : metadata de archivos subidos a Storage
--                          (el binario vive en el bucket privado
--                          'kanban-adjuntos', carpeta = tenant_id)
--   - citas.estado_pago  : columna sincronizada desde la etiqueta
--                          de pago de la tarjeta vinculada, para
--                          que "Citas Programadas" muestre el
--                          estado apenas se guarda.
--
-- RLS: mismo patrón validado en citas (20260901): authenticated +
-- get_user_tenant_id() + is_admin() (user_roles, no JWT metadata).
-- Las tablas hijas derivan el tenant por JOIN al board.
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: Tablas
-- ============================================================
CREATE TABLE IF NOT EXISTS public.kanban_boards (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    cliente_email text NOT NULL,
    cliente_nombre text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, cliente_email)
);

CREATE TABLE IF NOT EXISTS public.kanban_lists (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    board_id uuid NOT NULL REFERENCES public.kanban_boards(id) ON DELETE CASCADE,
    titulo text NOT NULL,
    posicion integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kanban_lists_board ON public.kanban_lists(board_id, posicion);

CREATE TABLE IF NOT EXISTS public.kanban_cards (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    list_id uuid NOT NULL REFERENCES public.kanban_lists(id) ON DELETE CASCADE,
    titulo text NOT NULL,
    descripcion text NOT NULL DEFAULT '',
    posicion integer NOT NULL DEFAULT 0,
    etiquetas jsonb NOT NULL DEFAULT '[]'::jsonb,
    cita_id text REFERENCES public.citas(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kanban_cards_list ON public.kanban_cards(list_id, posicion);
CREATE INDEX IF NOT EXISTS idx_kanban_cards_cita ON public.kanban_cards(cita_id);

CREATE TABLE IF NOT EXISTS public.kanban_checklist_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id uuid NOT NULL REFERENCES public.kanban_cards(id) ON DELETE CASCADE,
    texto text NOT NULL,
    completado boolean NOT NULL DEFAULT false,
    posicion integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kanban_checklist_card ON public.kanban_checklist_items(card_id, posicion);

CREATE TABLE IF NOT EXISTS public.kanban_attachments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id uuid NOT NULL REFERENCES public.kanban_cards(id) ON DELETE CASCADE,
    nombre text NOT NULL,
    tipo_mime text NOT NULL DEFAULT 'application/octet-stream',
    tamano bigint NOT NULL DEFAULT 0,
    storage_path text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kanban_attachments_card ON public.kanban_attachments(card_id);

-- ============================================================
-- PASO 2: updated_at automático (función existente set_updated_at)
-- ============================================================
DROP TRIGGER IF EXISTS trigger_set_updated_at_kanban_boards ON public.kanban_boards;
CREATE TRIGGER trigger_set_updated_at_kanban_boards
    BEFORE UPDATE ON public.kanban_boards
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trigger_set_updated_at_kanban_cards ON public.kanban_cards;
CREATE TRIGGER trigger_set_updated_at_kanban_cards
    BEFORE UPDATE ON public.kanban_cards
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- PASO 3: citas.estado_pago (sincronizado desde la tarjeta)
-- Claves: pagado / abonado / parcial / no_pagado
-- ============================================================
ALTER TABLE public.citas ADD COLUMN IF NOT EXISTS estado_pago text;
ALTER TABLE public.citas ADD COLUMN IF NOT EXISTS estado_pago_actualizado_en timestamptz;

ALTER TABLE public.citas DROP CONSTRAINT IF EXISTS citas_estado_pago_check;
ALTER TABLE public.citas ADD CONSTRAINT citas_estado_pago_check
    CHECK (estado_pago IN ('pagado', 'abonado', 'parcial', 'no_pagado'));

-- ============================================================
-- PASO 4: RLS — boards (tenant directo) e hijas (JOIN al board)
-- ============================================================
ALTER TABLE public.kanban_boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kanban_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kanban_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kanban_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kanban_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin gestiona tableros de su tenant" ON public.kanban_boards;
CREATE POLICY "Admin gestiona tableros de su tenant" ON public.kanban_boards
    FOR ALL TO authenticated
    USING (
        tenant_id = public.get_user_tenant_id()
        AND public.is_admin()
    )
    WITH CHECK (
        tenant_id = public.get_user_tenant_id()
        AND public.is_admin()
    );

DROP POLICY IF EXISTS "Admin gestiona listas de su tenant" ON public.kanban_lists;
CREATE POLICY "Admin gestiona listas de su tenant" ON public.kanban_lists
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.kanban_boards b
            WHERE b.id = board_id
              AND b.tenant_id = public.get_user_tenant_id()
        )
        AND public.is_admin()
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.kanban_boards b
            WHERE b.id = board_id
              AND b.tenant_id = public.get_user_tenant_id()
        )
        AND public.is_admin()
    );

DROP POLICY IF EXISTS "Admin gestiona tarjetas de su tenant" ON public.kanban_cards;
CREATE POLICY "Admin gestiona tarjetas de su tenant" ON public.kanban_cards
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.kanban_lists l
            JOIN public.kanban_boards b ON b.id = l.board_id
            WHERE l.id = list_id
              AND b.tenant_id = public.get_user_tenant_id()
        )
        AND public.is_admin()
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.kanban_lists l
            JOIN public.kanban_boards b ON b.id = l.board_id
            WHERE l.id = list_id
              AND b.tenant_id = public.get_user_tenant_id()
        )
        AND public.is_admin()
    );

DROP POLICY IF EXISTS "Admin gestiona checklist de su tenant" ON public.kanban_checklist_items;
CREATE POLICY "Admin gestiona checklist de su tenant" ON public.kanban_checklist_items
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.kanban_cards c
            JOIN public.kanban_lists l ON l.id = c.list_id
            JOIN public.kanban_boards b ON b.id = l.board_id
            WHERE c.id = card_id
              AND b.tenant_id = public.get_user_tenant_id()
        )
        AND public.is_admin()
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.kanban_cards c
            JOIN public.kanban_lists l ON l.id = c.list_id
            JOIN public.kanban_boards b ON b.id = l.board_id
            WHERE c.id = card_id
              AND b.tenant_id = public.get_user_tenant_id()
        )
        AND public.is_admin()
    );

DROP POLICY IF EXISTS "Admin gestiona adjuntos de su tenant" ON public.kanban_attachments;
CREATE POLICY "Admin gestiona adjuntos de su tenant" ON public.kanban_attachments
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.kanban_cards c
            JOIN public.kanban_lists l ON l.id = c.list_id
            JOIN public.kanban_boards b ON b.id = l.board_id
            WHERE c.id = card_id
              AND b.tenant_id = public.get_user_tenant_id()
        )
        AND public.is_admin()
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.kanban_cards c
            JOIN public.kanban_lists l ON l.id = c.list_id
            JOIN public.kanban_boards b ON b.id = l.board_id
            WHERE c.id = card_id
              AND b.tenant_id = public.get_user_tenant_id()
        )
        AND public.is_admin()
    );

-- ============================================================
-- PASO 5: Storage — bucket PRIVADO 'kanban-adjuntos'
-- (25MB; imágenes, pdf, word, excel, texto, csv, zip).
-- Carpeta raíz = tenant_id canónico (get_user_tenant_id), mismo
-- patrón que service-images. Descarga vía createSignedUrl (la
-- policy SELECT permite generarla).
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('kanban-adjuntos', 'kanban-adjuntos', false, 26214400, ARRAY[
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain', 'text/csv',
    'application/zip'
])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Kanban sube adjuntos de su tenant" ON storage.objects;
CREATE POLICY "Kanban sube adjuntos de su tenant" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'kanban-adjuntos'
        AND (storage.foldername(name))[1] = public.get_user_tenant_id()::text
    );

DROP POLICY IF EXISTS "Kanban lee adjuntos de su tenant" ON storage.objects;
CREATE POLICY "Kanban lee adjuntos de su tenant" ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'kanban-adjuntos'
        AND (storage.foldername(name))[1] = public.get_user_tenant_id()::text
    );

DROP POLICY IF EXISTS "Kanban elimina adjuntos de su tenant" ON storage.objects;
CREATE POLICY "Kanban elimina adjuntos de su tenant" ON storage.objects
    FOR DELETE TO authenticated
    USING (
        bucket_id = 'kanban-adjuntos'
        AND (storage.foldername(name))[1] = public.get_user_tenant_id()::text
    );

-- ============================================================
-- PASO 6: Refresh schema cache + verificación
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '✅ Kanban por cliente creado: boards/lists/cards/checklist/adjuntos + citas.estado_pago + bucket kanban-adjuntos (privado)' AS status;
