-- ============================================================
-- MIGRACIÓN: Archivos por cliente (Carpeta del Cliente) +
-- Centro de Mudanza (importación masiva de clientes y archivos)
-- Fecha: 2026-10-22
--
-- PROBLEMA: los negocios que migran ya tienen datos en Excel,
-- Word y Drive (50-100 clientes). Cargarlos uno por uno es
-- tedioso y abandonan. Además no hay dónde guardar archivos
-- "de nivel cliente": hoy los adjuntos cuelgan de tarjetas
-- kanban individuales.
--
-- SOLUCIÓN:
--   - clientes_archivos           : archivo lógico por cliente
--                                   (tenant_id + cliente_email,
--                                   misma identidad que kanban_boards).
--                                   tipo 'subido' (binario en Storage)
--                                   o 'drive' (enlace externo).
--   - clientes_archivo_versiones  : historial de versiones de un
--                                   archivo subido (v1, v2, ...).
--                                   Cada versión conserva su binario
--                                   en Storage: nunca se pierde nada.
--   - Bucket 'kanban-adjuntos'    : se amplía la lista de MIME
--                                   permitidos (rtf/odt/ods/ppt/pptx).
--   - RPCs SECURITY DEFINER       : admin_archivo_crear_subido
--                                   (alta + v1, o nueva versión si el
--                                   archivo lógico ya existe),
--                                   admin_archivo_crear_drive,
--                                   admin_archivo_eliminar.
--
-- RLS: mismo patrón validado en kanban (20260920) y clientes
-- manuales (20261004): authenticated + get_user_tenant_id() +
-- is_admin() (user_roles, nunca JWT metadata). Las versiones
-- derivan el tenant por JOIN al archivo.
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: Tablas
-- ============================================================
CREATE TABLE IF NOT EXISTS public.clientes_archivos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    cliente_email text NOT NULL,
    nombre text NOT NULL,
    tipo text NOT NULL DEFAULT 'subido' CHECK (tipo IN ('subido', 'drive')),
    drive_url text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, cliente_email, nombre)
);
CREATE INDEX IF NOT EXISTS idx_clientes_archivos_tenant_email
    ON public.clientes_archivos (tenant_id, cliente_email);

CREATE TABLE IF NOT EXISTS public.clientes_archivo_versiones (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    archivo_id uuid NOT NULL REFERENCES public.clientes_archivos(id) ON DELETE CASCADE,
    numero integer NOT NULL,
    nombre_archivo text NOT NULL,
    tipo_mime text NOT NULL DEFAULT 'application/octet-stream',
    tamano bigint NOT NULL DEFAULT 0,
    storage_path text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (archivo_id, numero)
);
CREATE INDEX IF NOT EXISTS idx_clientes_archivo_versiones_archivo
    ON public.clientes_archivo_versiones (archivo_id, numero);

-- ============================================================
-- PASO 2: updated_at automático (función existente set_updated_at)
-- ============================================================
DROP TRIGGER IF EXISTS trigger_set_updated_at_clientes_archivos ON public.clientes_archivos;
CREATE TRIGGER trigger_set_updated_at_clientes_archivos
    BEFORE UPDATE ON public.clientes_archivos
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- PASO 3: RLS — archivos (tenant directo) y versiones (JOIN)
-- ============================================================
ALTER TABLE public.clientes_archivos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clientes_archivo_versiones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin gestiona archivos de clientes de su tenant" ON public.clientes_archivos;
CREATE POLICY "Admin gestiona archivos de clientes de su tenant" ON public.clientes_archivos
    FOR ALL TO authenticated
    USING (
        tenant_id = public.get_user_tenant_id()
        AND public.is_admin()
    )
    WITH CHECK (
        tenant_id = public.get_user_tenant_id()
        AND public.is_admin()
    );

DROP POLICY IF EXISTS "Admin gestiona versiones de archivos de su tenant" ON public.clientes_archivo_versiones;
CREATE POLICY "Admin gestiona versiones de archivos de su tenant" ON public.clientes_archivo_versiones
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.clientes_archivos a
            WHERE a.id = archivo_id
              AND a.tenant_id = public.get_user_tenant_id()
        )
        AND public.is_admin()
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.clientes_archivos a
            WHERE a.id = archivo_id
              AND a.tenant_id = public.get_user_tenant_id()
        )
        AND public.is_admin()
    );

-- ============================================================
-- PASO 4: RPC admin_archivo_crear_subido
-- Alta de un archivo subido con su versión 1, o nueva versión
-- si el archivo lógico (tenant, email, nombre) ya existe.
-- El binario ya está en Storage cuando se llama (subida previa
-- del cliente con la policy de INSERT del bucket).
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_archivo_crear_subido(
    p_tenant_id uuid,
    p_cliente_email text,
    p_nombre text,
    p_nombre_archivo text,
    p_tipo_mime text DEFAULT 'application/octet-stream',
    p_tamano bigint DEFAULT 0,
    p_storage_path text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_actual uuid;
    v_email text;
    v_archivo_id uuid;
    v_numero integer;
    v_ya_existia boolean;
    v_tipo_existente text;
BEGIN
    SELECT public.get_user_tenant_id() INTO v_tenant_actual;
    IF v_tenant_actual IS DISTINCT FROM p_tenant_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio');
    END IF;

    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador puede gestionar archivos');
    END IF;

    v_email := lower(btrim(p_cliente_email));
    IF v_email = '' OR v_email !~ '@' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Email de cliente inválido');
    END IF;

    IF p_nombre IS NULL OR trim(p_nombre) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El nombre del archivo es requerido');
    END IF;

    IF p_storage_path IS NULL OR btrim(p_storage_path) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Falta la ruta del archivo en Storage');
    END IF;

    -- ¿Ya existe el archivo lógico? Bloqueo la fila para serializar el número de versión.
    SELECT id, tipo INTO v_archivo_id, v_tipo_existente
    FROM public.clientes_archivos
    WHERE tenant_id = p_tenant_id
      AND lower(btrim(cliente_email)) = v_email
      AND nombre = btrim(p_nombre)
    FOR UPDATE;

    IF v_archivo_id IS NULL THEN
        INSERT INTO public.clientes_archivos (tenant_id, cliente_email, nombre, tipo)
        VALUES (p_tenant_id, v_email, btrim(p_nombre), 'subido')
        RETURNING id INTO v_archivo_id;
        v_numero := 1;
        v_ya_existia := false;
    ELSE
        IF v_tipo_existente = 'drive' THEN
            RETURN jsonb_build_object('ok', false, 'error', 'Ya existe un enlace de Drive con ese nombre: usá otro nombre para el archivo subido');
        END IF;
        SELECT COALESCE(MAX(numero), 0) + 1 INTO v_numero
        FROM public.clientes_archivo_versiones
        WHERE archivo_id = v_archivo_id;
        v_ya_existia := true;
    END IF;

    INSERT INTO public.clientes_archivo_versiones
        (archivo_id, numero, nombre_archivo, tipo_mime, tamano, storage_path)
    VALUES
        (v_archivo_id, v_numero, COALESCE(btrim(p_nombre_archivo), btrim(p_nombre)),
         COALESCE(btrim(p_tipo_mime), 'application/octet-stream'),
         COALESCE(p_tamano, 0), btrim(p_storage_path));

    RETURN jsonb_build_object(
        'ok', true,
        'archivo_id', v_archivo_id,
        'nombre', btrim(p_nombre),
        'numero', v_numero,
        'ya_existia', v_ya_existia
    );
END;
$$;

-- ============================================================
-- PASO 5: RPC admin_archivo_crear_drive
-- Guarda (o actualiza) un enlace externo (Google Drive, etc.)
-- como archivo del cliente. Sin versiones: vive en Drive.
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_archivo_crear_drive(
    p_tenant_id uuid,
    p_cliente_email text,
    p_nombre text,
    p_drive_url text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_actual uuid;
    v_email text;
    v_archivo_id uuid;
    v_tipo_existente text;
    v_ya_existia boolean;
BEGIN
    SELECT public.get_user_tenant_id() INTO v_tenant_actual;
    IF v_tenant_actual IS DISTINCT FROM p_tenant_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio');
    END IF;

    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador puede gestionar archivos');
    END IF;

    v_email := lower(btrim(p_cliente_email));
    IF v_email = '' OR v_email !~ '@' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Email de cliente inválido');
    END IF;

    IF p_nombre IS NULL OR trim(p_nombre) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El nombre del archivo es requerido');
    END IF;

    IF p_drive_url IS NULL OR btrim(p_drive_url) !~ '^https?://' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El enlace debe empezar con http:// o https://');
    END IF;

    SELECT id, tipo INTO v_archivo_id, v_tipo_existente
    FROM public.clientes_archivos
    WHERE tenant_id = p_tenant_id
      AND lower(btrim(cliente_email)) = v_email
      AND nombre = btrim(p_nombre)
    FOR UPDATE;

    IF v_archivo_id IS NULL THEN
        INSERT INTO public.clientes_archivos (tenant_id, cliente_email, nombre, tipo, drive_url)
        VALUES (p_tenant_id, v_email, btrim(p_nombre), 'drive', btrim(p_drive_url))
        RETURNING id INTO v_archivo_id;
        v_ya_existia := false;
    ELSE
        IF v_tipo_existente = 'subido' THEN
            RETURN jsonb_build_object('ok', false, 'error', 'Ya existe un archivo subido con ese nombre: usá otro nombre para el enlace de Drive');
        END IF;
        UPDATE public.clientes_archivos
        SET drive_url = btrim(p_drive_url)
        WHERE id = v_archivo_id;
        v_ya_existia := true;
    END IF;

    RETURN jsonb_build_object('ok', true, 'archivo_id', v_archivo_id, 'ya_existia', v_ya_existia);
END;
$$;

-- ============================================================
-- PASO 6: RPC admin_archivo_eliminar
-- Elimina el archivo lógico y TODAS sus versiones (cascade).
-- El cliente borra los binarios de Storage ANTES de llamar
-- (mismo orden que deleteAttachment de kanbanApi).
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_archivo_eliminar(
    p_tenant_id uuid,
    p_archivo_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_actual uuid;
    v_borradas integer;
BEGIN
    SELECT public.get_user_tenant_id() INTO v_tenant_actual;
    IF v_tenant_actual IS DISTINCT FROM p_tenant_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio');
    END IF;

    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador puede eliminar archivos');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.clientes_archivos
        WHERE id = p_archivo_id AND tenant_id = p_tenant_id
    ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El archivo no existe o no pertenece a este negocio');
    END IF;

    SELECT COUNT(*) INTO v_borradas FROM public.clientes_archivo_versiones WHERE archivo_id = p_archivo_id;

    DELETE FROM public.clientes_archivos WHERE id = p_archivo_id;

    RETURN jsonb_build_object('ok', true, 'versiones_borradas', v_borradas);
END;
$$;

-- ============================================================
-- PASO 7: Bucket — ampliar MIME permitidos de 'kanban-adjuntos'
-- (mantiene el límite de tamaño ya configurado; agrega
-- rtf/odt/ods/ppt/pptx que el cliente ya acepta en el tablero).
-- ============================================================
UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/rtf',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain', 'text/csv',
    'application/zip'
]
WHERE id = 'kanban-adjuntos';

-- ============================================================
-- PASO 8: Refresh schema cache + verificación
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '✅ clientes_archivos + versiones + RLS admin + RPCs subir/versión/drive/eliminar + bucket ampliado' AS status;
