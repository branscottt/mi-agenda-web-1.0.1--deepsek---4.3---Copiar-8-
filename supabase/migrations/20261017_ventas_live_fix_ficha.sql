-- ============================================================
-- MIGRACIÓN: Ventas Live — fix vl_ficha_cliente (contadores)
-- Fecha: 2026-10-17
--
-- OBJETIVO: corregir ERROR 42803 en vl_ficha_cliente (20261014):
-- el bloque 'contadores' usaba subconsultas correlacionadas
-- (pr.id) dentro de agregados. Se reemplazan por subconsultas
-- escalares autocontenidas. Sin DO $$. Idempotente.
-- ============================================================

CREATE OR REPLACE FUNCTION public.vl_ficha_cliente(p_cliente_id uuid)
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

    IF NOT EXISTS (SELECT 1 FROM public.vl_clientes WHERE id = p_cliente_id AND tenant_id = v_tenant) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Cliente no encontrado');
    END IF;

    SELECT jsonb_build_object(
        'ok', true,
        'cliente', (
            SELECT jsonb_build_object(
                'cliente_id', c.id, 'tiktok_user', c.tiktok_user,
                'nombre_real', c.nombre_real, 'whatsapp', c.whatsapp,
                'ciudad', c.ciudad, 'comuna', c.comuna, 'direccion', c.direccion,
                'entrega_preferida', c.entrega_preferida, 'categoria', c.categoria,
                'notas', c.notas, 'creado_en', c.creado_en, 'updated_at', c.updated_at
            )
            FROM public.vl_clientes c WHERE c.id = p_cliente_id
        ),
        'proceso_activo', (
            SELECT jsonb_build_object(
                'proceso_id', pr.id, 'estado', pr.estado, 'creado_en', pr.creado_en,
                'saldo', public.vl_saldo_proceso(pr.id),
                'prendas', (SELECT count(*) FROM public.vl_items i
                            WHERE i.proceso_id = pr.id AND i.estado IN ('adjudicada', 'pagada')),
                'items', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'id', i.id, 'descripcion', i.descripcion, 'precio', i.precio,
                        'abonado', i.abonado, 'estado', i.estado, 'creado_en', i.creado_en
                    ) ORDER BY i.creado_en)
                    FROM public.vl_items i WHERE i.proceso_id = pr.id
                ), '[]'::jsonb),
                'pagos', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'id', pg.id, 'monto', pg.monto, 'metodo', pg.metodo,
                        'nota', pg.nota, 'confirmado_en', pg.confirmado_en
                    ) ORDER BY pg.confirmado_en)
                    FROM public.vl_pagos pg WHERE pg.proceso_id = pr.id
                ), '[]'::jsonb),
                'envio', (
                    SELECT jsonb_build_object(
                        'envio_id', ev.id, 'tipo', ev.tipo, 'empresa', ev.empresa,
                        'tracking', ev.tracking, 'fecha_programada', ev.fecha_programada,
                        'estado', ev.estado
                    )
                    FROM public.vl_envios ev WHERE ev.proceso_id = pr.id
                )
            )
            FROM public.vl_procesos pr
            WHERE pr.cliente_id = p_cliente_id AND pr.cerrado_en IS NULL
        ),
        'historial', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'proceso_id', pr.id, 'estado', pr.estado, 'motivo_cierre', pr.motivo_cierre,
                'creado_en', pr.creado_en, 'cerrado_en', pr.cerrado_en,
                'prendas', (SELECT count(*) FROM public.vl_items i WHERE i.proceso_id = pr.id),
                'total_comprado', (SELECT COALESCE(SUM(i.precio), 0) FROM public.vl_items i WHERE i.proceso_id = pr.id),
                'total_pagado', (SELECT COALESCE(SUM(pg.monto), 0) FROM public.vl_pagos pg WHERE pg.proceso_id = pr.id)
            ) ORDER BY pr.cerrado_en DESC)
            FROM public.vl_procesos pr
            WHERE pr.cliente_id = p_cliente_id AND pr.cerrado_en IS NOT NULL
        ), '[]'::jsonb),
        'contadores', jsonb_build_object(
            'reservas', (SELECT count(*)::int FROM public.vl_procesos pr WHERE pr.cliente_id = p_cliente_id),
            'concretadas', (SELECT count(*)::int FROM public.vl_procesos pr
                            WHERE pr.cliente_id = p_cliente_id
                              AND EXISTS (SELECT 1 FROM public.vl_pagos pg WHERE pg.proceso_id = pr.id)),
            'no_concretadas', (
                (SELECT count(*)::int FROM public.vl_procesos pr WHERE pr.cliente_id = p_cliente_id)
                - (SELECT count(*)::int FROM public.vl_procesos pr
                   WHERE pr.cliente_id = p_cliente_id
                     AND EXISTS (SELECT 1 FROM public.vl_pagos pg WHERE pg.proceso_id = pr.id))
            ),
            'comprado_total', (SELECT COALESCE(SUM(i.precio), 0) FROM public.vl_items i
                               JOIN public.vl_procesos pr ON pr.id = i.proceso_id
                               WHERE pr.cliente_id = p_cliente_id),
            'pagado_total', (SELECT COALESCE(SUM(pg.monto), 0) FROM public.vl_pagos pg
                             JOIN public.vl_procesos pr ON pr.id = pg.proceso_id
                             WHERE pr.cliente_id = p_cliente_id)
        )
    ) INTO v_res;

    RETURN v_res;
END;
$$;

REVOKE ALL ON FUNCTION public.vl_ficha_cliente(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_ficha_cliente(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

SELECT '[FIX] vl_ficha_cliente contadores OK' AS status;
