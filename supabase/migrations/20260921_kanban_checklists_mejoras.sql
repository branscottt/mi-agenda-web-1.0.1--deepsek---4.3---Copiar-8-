-- ============================================================
-- MIGRACIÓN: Checklists múltiples por tarjeta (estilo Trello)
-- + ampliación de tipos de archivo del bucket de adjuntos
-- Fecha: 2026-09-21
--
-- PROBLEMA: cada tarjeta tenía un único checklist implícito
-- (kanban_checklist_items.card_id). El usuario quiere poder
-- organizar varios checklists con nombre por tarjeta, como
-- Trello, y adjuntar más tipos de archivo (Word, PDF, Excel,
-- PowerPoint, etc.).
--
-- SOLUCIÓN:
--   - kanban_checklists: cabecera de checklist (card_id, titulo).
--   - kanban_checklist_items.checklist_id: FK al checklist
--     (se conserva card_id para RLS existente y compatibilidad).
--   - Migración de datos: cada tarjeta con items existentes
--     recibe un checklist "Checklist" y sus items se reasignan.
--   - RLS para kanban_checklists (misma cadena de JOIN al board).
--   - UPDATE del bucket: mime types ampliados (office, pdf,
--     presentaciones, texto, zip, audio/video).
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: Tabla kanban_checklists + columna checklist_id
-- ============================================================
CREATE TABLE IF NOT EXISTS public.kanban_checklists (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id uuid NOT NULL REFERENCES public.kanban_cards(id) ON DELETE CASCADE,
    titulo text NOT NULL DEFAULT 'Checklist',
    posicion integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kanban_checklists_card ON public.kanban_checklists(card_id, posicion);

ALTER TABLE public.kanban_checklist_items ADD COLUMN IF NOT EXISTS checklist_id uuid
    REFERENCES public.kanban_checklists(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_kanban_checklist_items_checklist
    ON public.kanban_checklist_items(checklist_id, posicion);

-- ============================================================
-- PASO 2: Migrar items existentes a un checklist por tarjeta
-- ============================================================
INSERT INTO public.kanban_checklists (card_id, titulo, posicion)
SELECT DISTINCT card_id, 'Checklist', 0
FROM public.kanban_checklist_items
WHERE card_id IS NOT NULL
ON CONFLICT DO NOTHING;

UPDATE public.kanban_checklist_items it
SET checklist_id = ch.id
FROM public.kanban_checklists ch
WHERE it.checklist_id IS NULL
  AND ch.card_id = it.card_id;

-- ============================================================
-- PASO 3: RLS para kanban_checklists (misma cadena de JOIN)
-- ============================================================
ALTER TABLE public.kanban_checklists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin gestiona checklists de su tenant" ON public.kanban_checklists;
CREATE POLICY "Admin gestiona checklists de su tenant" ON public.kanban_checklists
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
-- PASO 4: Ampliar tipos de archivo permitidos en el bucket
-- (Word, PDF, Excel, PowerPoint, texto, zip, audio/video...)
-- ============================================================
UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp', 'image/avif',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/rtf',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.oasis.opendocument.spreadsheet',
    'text/csv', 'text/tab-separated-values',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.presentation',
    'text/plain', 'text/markdown', 'application/json', 'application/xml',
    'application/zip', 'application/x-zip-compressed', 'application/x-7z-compressed',
    'video/mp4', 'video/quicktime', 'video/webm',
    'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4'
]
WHERE id = 'kanban-adjuntos';

-- ============================================================
-- PASO 5: Refresh schema cache + verificación
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '✅ Checklists múltiples + adjuntos ampliados (office/pdf/ppt/video/audio)' AS status;
