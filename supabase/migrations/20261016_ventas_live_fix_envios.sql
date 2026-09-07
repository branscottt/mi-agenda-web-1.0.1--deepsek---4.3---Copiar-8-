-- ============================================================
-- MIGRACIÓN: Ventas Live — fix vl_envios_pendientes (alias arr)
-- Fecha: 2026-10-16
--
-- OBJETIVO: corregir jsonb_object_agg(grupo, arr) de la función
-- vl_envios_pendientes (20261014): el jsonb_agg interno no tenía
-- alias, por lo que la columna "arr" no existía.
-- Sin DO $$. Idempotente (CREATE OR REPLACE).
-- ============================================================

CREATE OR REPLACE FUNCTION public.vl_envios_pendientes()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_res jsonb;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    WITH fila AS (
        SELECT
            ev.id AS envio_id,
            ev.tipo,
            ev.empresa,
            ev.tracking,
            ev.fecha_programada,
            ev.estado AS envio_estado,
            pr.id AS proceso_id,
            c.tiktok_user, c.nombre_real, c.whatsapp, c.ciudad, c.comuna, c.direccion,
            CASE
                WHEN ev.estado = 'en_proceso' THEN 'en_proceso'
                WHEN ev.tipo = 'presencial' THEN 'presenciales'
                WHEN ev.estado = 'pendiente' AND ev.fecha_programada IS NULL THEN 'hoy'
                WHEN ev.estado = 'programado' AND ev.fecha_programada <= CURRENT_DATE THEN 'hoy'
                WHEN ev.estado = 'programado' AND ev.fecha_programada = CURRENT_DATE + 1 THEN 'manana'
                WHEN ev.estado = 'programado' AND ev.fecha_programada > CURRENT_DATE + 1 THEN 'proximos'
                ELSE 'hoy'
            END AS grupo
        FROM public.vl_envios ev
        JOIN public.vl_procesos pr ON pr.id = ev.proceso_id
        JOIN public.vl_clientes c ON c.id = pr.cliente_id
        WHERE ev.tenant_id = v_tenant
          AND ev.estado IN ('pendiente', 'programado', 'en_proceso')
          AND pr.cerrado_en IS NULL
    )
    SELECT jsonb_build_object(
        'ok', true,
        'grupos', COALESCE((
            SELECT jsonb_object_agg(grupo, arr)
            FROM (
                SELECT grupo, jsonb_agg(jsonb_build_object(
                    'envio_id', envio_id,
                    'proceso_id', proceso_id,
                    'tipo', tipo,
                    'empresa', empresa,
                    'tracking', tracking,
                    'fecha_programada', fecha_programada,
                    'envio_estado', envio_estado,
                    'cliente', jsonb_build_object(
                        'tiktok_user', tiktok_user, 'nombre_real', nombre_real,
                        'whatsapp', whatsapp, 'ciudad', ciudad,
                        'comuna', comuna, 'direccion', direccion
                    )
                ) ORDER BY fecha_programada ASC NULLS FIRST, tiktok_user ASC) AS arr
                FROM fila
                GROUP BY grupo
            ) g
        ), '{}'::jsonb)
    ) INTO v_res;

    RETURN v_res;
END;
$$;

REVOKE ALL ON FUNCTION public.vl_envios_pendientes() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_envios_pendientes() TO authenticated;

NOTIFY pgrst, 'reload schema';

SELECT '[FIX] vl_envios_pendientes alias arr OK' AS status;
