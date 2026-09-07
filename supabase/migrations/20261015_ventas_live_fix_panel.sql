-- ============================================================
-- MIGRACIÓN: Ventas Live — fix vl_panel_procesos (dias_estado)
-- Fecha: 2026-10-15
--
-- OBJETIVO: corregir el cast inválido (interval → int) en el RPC
-- vl_panel_procesos introducido en 20261014. La columna dias_estado
-- ahora usa EXTRACT(EPOCH ...) / 86400 (días enteros).
-- Sin DO $$. Idempotente (CREATE OR REPLACE).
-- ============================================================

CREATE OR REPLACE FUNCTION public.vl_panel_procesos()
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

    WITH base AS (
        SELECT
            pr.id AS proceso_id,
            pr.estado,
            pr.creado_en,
            pr.updated_at,
            c.id AS cliente_id,
            c.tiktok_user,
            c.nombre_real,
            c.whatsapp,
            c.categoria,
            public.vl_saldo_proceso(pr.id) AS saldo,
            (SELECT count(*) FROM public.vl_items i
             WHERE i.proceso_id = pr.id AND i.estado IN ('adjudicada', 'pagada')) AS prendas,
            GREATEST(pr.creado_en, pr.updated_at) AS ultimo_evento,
            (SELECT ev.tipo FROM public.vl_envios ev WHERE ev.proceso_id = pr.id) AS envio_tipo,
            (SELECT ev.empresa FROM public.vl_envios ev WHERE ev.proceso_id = pr.id) AS envio_empresa,
            (SELECT ev.tracking FROM public.vl_envios ev WHERE ev.proceso_id = pr.id) AS envio_tracking,
            (SELECT ev.fecha_programada FROM public.vl_envios ev WHERE ev.proceso_id = pr.id) AS envio_fecha,
            CASE pr.estado
                WHEN 'esperando_whatsapp' THEN 'esperando_whatsapp'
                WHEN 'identificando_cliente' THEN 'esperando_whatsapp'
                WHEN 'esperando_pago' THEN 'esperando_pago'
                WHEN 'pago_parcial' THEN 'pago_parcial'
                WHEN 'pagara_presencial' THEN 'pagara_presencial'
                WHEN 'pagado' THEN CASE
                    WHEN public.vl_saldo_proceso(pr.id) > 0 THEN 'esperando_pago'
                    ELSE 'pagado_sin_decision'
                END
                WHEN 'acumulando' THEN CASE
                    WHEN public.vl_saldo_proceso(pr.id) > 0 THEN 'esperando_pago'
                    ELSE 'acumulando'
                END
                WHEN 'listo_preparar' THEN 'listo_preparar'
                WHEN 'envio_programado' THEN 'envio_programado'
                WHEN 'envio_proceso' THEN 'envio_proceso'
                WHEN 'entrega_presencial' THEN 'entrega_presencial'
                ELSE pr.estado
            END AS grupo
        FROM public.vl_procesos pr
        JOIN public.vl_clientes c ON c.id = pr.cliente_id
        WHERE pr.tenant_id = v_tenant AND pr.cerrado_en IS NULL
    )
    SELECT jsonb_build_object(
        'ok', true,
        'procesos', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'proceso_id', proceso_id,
                'estado', estado,
                'grupo', grupo,
                'saldo', saldo,
                'prendas', prendas,
                'dias_espera', (CURRENT_DATE - creado_en::date),
                'dias_estado', GREATEST(0, EXTRACT(EPOCH FROM (now() - updated_at))::int / 86400),
                'envio', CASE WHEN envio_tipo IS NULL THEN NULL ELSE jsonb_build_object(
                    'tipo', envio_tipo, 'empresa', envio_empresa,
                    'tracking', envio_tracking, 'fecha_programada', envio_fecha
                ) END,
                'cliente', jsonb_build_object(
                    'cliente_id', cliente_id, 'tiktok_user', tiktok_user,
                    'nombre_real', nombre_real, 'whatsapp', whatsapp, 'categoria', categoria
                )
            ) ORDER BY (grupo = 'esperando_whatsapp') DESC, saldo DESC, updated_at ASC)
            FROM base
        ), '[]'::jsonb),
        'conteos', COALESCE((
            SELECT jsonb_object_agg(grupo, n)
            FROM (SELECT grupo, count(*) AS n FROM base GROUP BY grupo) g
        ), '{}'::jsonb)
    ) INTO v_res;

    RETURN v_res;
END;
$$;

REVOKE ALL ON FUNCTION public.vl_panel_procesos() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_panel_procesos() TO authenticated;

NOTIFY pgrst, 'reload schema';

SELECT '[FIX] vl_panel_procesos dias_estado OK' AS status;
