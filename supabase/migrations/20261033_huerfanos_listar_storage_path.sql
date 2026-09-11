-- ============================================================
-- MIGRACIÓN: la bandeja "Sin cliente" necesita poder VER el archivo
-- Fecha: 2026-10-33
--
-- PROBLEMA: admin_huerfanos_listar (20261032) no devolvía storage_path,
-- así que la bandeja no podía generar el enlace firmado para abrir el
-- archivo y decidir de quién es.
--
-- SOLUCIÓN: recrear el listado incluyendo storage_path. Sigue siendo
-- admin-only y del propio tenant (RLS + chequeos), así que exponer la
-- ruta del binario al admin de ese negocio no cambia la superficie de
-- acceso: el binario vive en el bucket privado del tenant.
--
-- Script lineal, idempotente, sin DO $$.
-- ============================================================

CREATE OR REPLACE FUNCTION public.admin_huerfanos_listar(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_actual uuid;
    v_items jsonb;
BEGIN
    SELECT public.get_user_tenant_id() INTO v_tenant_actual;
    IF v_tenant_actual IS DISTINCT FROM p_tenant_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador ve los archivos sin dueño');
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', h.id,
        'nombre_original', h.nombre_original,
        'nombre_archivo', h.nombre_archivo,
        'tipo_mime', h.tipo_mime,
        'tamano', h.tamano,
        'storage_path', h.storage_path,
        'estado', h.estado,
        'asignado_a_email', h.asignado_a_email,
        'created_at', h.created_at
    ) ORDER BY h.created_at), '[]'::jsonb)
    INTO v_items
    FROM public.clientes_archivos_huerfanos h
    WHERE h.tenant_id = p_tenant_id AND h.estado = 'pendiente';

    RETURN jsonb_build_object('ok', true, 'items', v_items);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_huerfanos_listar(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_huerfanos_listar(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

SELECT '✅ admin_huerfanos_listar devuelve storage_path (la bandeja puede ver el archivo)' AS status;
