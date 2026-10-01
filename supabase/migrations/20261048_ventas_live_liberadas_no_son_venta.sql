-- ============================================================
-- MIGRACIÓN 20261048: Ventas Live — lo liberado NO es venta + bloqueo real
-- Fecha: 2026-10-12
--
-- PEDIDO DEL DUEÑO (verbatim):
--   1. "al liberar prenda no se vendió, entonces no se considere en las
--      ganancias".
--   2. "al bloquear se borre todo el usuario y quede la prenda como liberada;
--      el usuario y los montos no se consideren como ventas".
--
-- PROBLEMA REAL ENCONTRADO (evidencia):
--   vl_finanzas_resumen() y vl_dashboard() sumaban SUM(precio) de vl_items
--   SIN filtrar estado -> las prendas 'liberada' seguían contando como venta
--   (20261014_ventas_live_lectura.sql:564-565, :459-470).
--
-- Piezas:
--   1. vl_procesos.cliente_id pasa a NULLABLE + ON DELETE SET NULL
--      (para poder borrar de verdad al cliente sin perder el histórico).
--   2. vl_finanzas_resumen() v2 -> ventas solo de items NO liberados.
--   3. vl_dashboard() v2        -> ventas y prendas del LIVE sin liberadas.
--   4. vl_cliente_bloquear_borrar() v2 -> libera prendas, cierra los procesos
--      como 'no_pago_liberado', borra la conversación y BORRA al cliente.
--
-- Idempotente. Sin DO $$.
-- ============================================================

-- ── 1. Poder borrar al cliente sin perder el histórico de procesos ──
ALTER TABLE public.vl_procesos ALTER COLUMN cliente_id DROP NOT NULL;

ALTER TABLE public.vl_procesos DROP CONSTRAINT IF EXISTS vl_procesos_cliente_id_fkey;
ALTER TABLE public.vl_procesos
    ADD CONSTRAINT vl_procesos_cliente_id_fkey
    FOREIGN KEY (cliente_id) REFERENCES public.vl_clientes(id) ON DELETE SET NULL;

-- ── 2. Finanzas: lo liberado no es venta ────────────────────
CREATE OR REPLACE FUNCTION public.vl_finanzas_resumen()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_ventas_total numeric;
    v_ventas_mes numeric;
    v_recibido_total numeric;
    v_recibido_mes numeric;
    v_pendiente numeric;
    v_inversion_total numeric;
    v_inversion_mes numeric;
    v_gastos_total numeric;
    v_gastos_mes numeric;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    -- VENTAS = prendas que sí se vendieron. Las liberadas quedan fuera:
    -- nunca se concretaron, así que no son ingreso.
    SELECT COALESCE(SUM(precio), 0) INTO v_ventas_total
    FROM public.vl_items
    WHERE tenant_id = v_tenant AND estado <> 'liberada';

    SELECT COALESCE(SUM(precio), 0) INTO v_ventas_mes
    FROM public.vl_items
    WHERE tenant_id = v_tenant AND estado <> 'liberada'
      AND creado_en >= date_trunc('month', now());

    SELECT COALESCE(SUM(monto), 0) INTO v_recibido_total FROM public.vl_pagos WHERE tenant_id = v_tenant;
    SELECT COALESCE(SUM(monto), 0) INTO v_recibido_mes FROM public.vl_pagos
    WHERE tenant_id = v_tenant AND confirmado_en >= date_trunc('month', now());

    SELECT COALESCE(SUM(public.vl_saldo_proceso(pr.id)), 0) INTO v_pendiente
    FROM public.vl_procesos pr
    WHERE pr.tenant_id = v_tenant AND pr.cerrado_en IS NULL;

    SELECT COALESCE(SUM(monto), 0), COALESCE(SUM(monto) FILTER (WHERE fecha >= date_trunc('month', CURRENT_DATE)::date), 0)
    INTO v_inversion_total, v_inversion_mes
    FROM public.vl_gastos WHERE tenant_id = v_tenant AND tipo = 'inversion';

    SELECT COALESCE(SUM(monto), 0), COALESCE(SUM(monto) FILTER (WHERE fecha >= date_trunc('month', CURRENT_DATE)::date), 0)
    INTO v_gastos_total, v_gastos_mes
    FROM public.vl_gastos WHERE tenant_id = v_tenant AND tipo = 'gasto';

    RETURN jsonb_build_object(
        'ok', true,
        'ingresos', jsonb_build_object(
            'ventas_total', v_ventas_total,
            'ventas_mes', v_ventas_mes,
            'recibido_total', v_recibido_total,
            'recibido_mes', v_recibido_mes,
            'pendiente', v_pendiente
        ),
        'inversiones', jsonb_build_object('total', v_inversion_total, 'mes', v_inversion_mes),
        'gastos', jsonb_build_object('total', v_gastos_total, 'mes', v_gastos_mes),
        'resultado', jsonb_build_object(
            'ganancia_estimada', v_recibido_total - v_inversion_total - v_gastos_total,
            'flujo_caja', v_recibido_total - v_gastos_total
        ),
        'ultimos_gastos', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'gasto_id', g.id, 'tipo', g.tipo, 'concepto', g.concepto,
                'monto', g.monto, 'fecha', g.fecha
            ) ORDER BY g.fecha DESC, g.creado_en DESC)
            FROM public.vl_gastos g WHERE g.tenant_id = v_tenant
            LIMIT 50
        ), '[]'::jsonb)
    );
END;
$function$;

-- ── 3. Dashboard: lo liberado no es venta ───────────────────
CREATE OR REPLACE FUNCTION public.vl_dashboard()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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

    SELECT jsonb_build_object(
        'ok', true,
        'ventas', jsonb_build_object(
            'hoy', COALESCE((SELECT SUM(i.precio) FROM public.vl_items i
                             WHERE i.tenant_id = v_tenant AND i.estado <> 'liberada'
                               AND i.creado_en::date = CURRENT_DATE), 0),
            'mes', COALESCE((SELECT SUM(i.precio) FROM public.vl_items i
                             WHERE i.tenant_id = v_tenant AND i.estado <> 'liberada'
                               AND i.creado_en >= date_trunc('month', now())), 0),
            'total', COALESCE((SELECT SUM(i.precio) FROM public.vl_items i
                               WHERE i.tenant_id = v_tenant AND i.estado <> 'liberada'), 0)
        ),
        'live_actual', (
            SELECT jsonb_build_object(
                'live_id', l.id, 'etiqueta', l.etiqueta,
                'ventas', COALESCE((SELECT SUM(i.precio) FROM public.vl_items i
                                    WHERE i.live_id = l.id AND i.estado <> 'liberada'), 0),
                'prendas', (SELECT count(*) FROM public.vl_items i
                            WHERE i.live_id = l.id AND i.estado <> 'liberada')
            )
            FROM public.vl_lives l
            WHERE l.tenant_id = v_tenant AND l.cerrado_en IS NULL
            ORDER BY l.abierto_en DESC
            LIMIT 1
        ),
        'pagos', jsonb_build_object(
            'hoy', COALESCE((SELECT SUM(pg.monto) FROM public.vl_pagos pg
                             WHERE pg.tenant_id = v_tenant AND pg.confirmado_en::date = CURRENT_DATE), 0),
            'mes', COALESCE((SELECT SUM(pg.monto) FROM public.vl_pagos pg
                             WHERE pg.tenant_id = v_tenant AND pg.confirmado_en >= date_trunc('month', now())), 0),
            'total', COALESCE((SELECT SUM(pg.monto) FROM public.vl_pagos pg WHERE pg.tenant_id = v_tenant), 0)
        ),
        'pendiente_total', (
            SELECT COALESCE(SUM(public.vl_saldo_proceso(pr.id)), 0)
            FROM public.vl_procesos pr
            WHERE pr.tenant_id = v_tenant AND pr.cerrado_en IS NULL
        ),
        'clientes', (
            SELECT jsonb_build_object(
                'total', count(*)::int,
                'nuevos', count(*) FILTER (WHERE categoria = 'nuevo')::int,
                'confiables', count(*) FILTER (WHERE categoria = 'confiable')::int,
                'problematicos', count(*) FILTER (WHERE categoria = 'problematico')::int,
                'bloqueados', count(*) FILTER (WHERE categoria = 'bloqueado')::int
            )
            FROM public.vl_clientes WHERE tenant_id = v_tenant
        ),
        'procesos', (
            WITH base AS (
                SELECT pr.estado, public.vl_saldo_proceso(pr.id) AS saldo
                FROM public.vl_procesos pr
                WHERE pr.tenant_id = v_tenant AND pr.cerrado_en IS NULL
            )
            SELECT jsonb_build_object(
                'esperando_whatsapp', (SELECT count(*) FROM base WHERE estado IN ('esperando_whatsapp', 'identificando_cliente'))::int,
                'esperando_pago', (SELECT count(*) FROM base WHERE estado IN ('esperando_pago', 'pago_parcial', 'pagara_presencial')
                                    OR (estado IN ('pagado', 'acumulando') AND saldo > 0))::int,
                'pago_parcial', (SELECT count(*) FROM base WHERE estado = 'pago_parcial')::int,
                'pagara_presencial', (SELECT count(*) FROM base WHERE estado = 'pagara_presencial')::int,
                'pagado_sin_decision', (SELECT count(*) FROM base WHERE estado = 'pagado' AND saldo = 0)::int,
                'acumulando', (SELECT count(*) FROM base WHERE estado = 'acumulando' AND saldo = 0)::int,
                'listo_preparar', (SELECT count(*) FROM base WHERE estado = 'listo_preparar')::int,
                'envio_programado', (SELECT count(*) FROM base WHERE estado = 'envio_programado')::int,
                'envio_proceso', (SELECT count(*) FROM base WHERE estado = 'envio_proceso')::int,
                'entrega_presencial', (SELECT count(*) FROM base WHERE estado = 'entrega_presencial')::int
            )
        ),
        'envios', jsonb_build_object(
            'hoy', (SELECT count(*) FROM public.vl_envios ev
                    WHERE ev.tenant_id = v_tenant AND ev.estado IN ('pendiente', 'programado', 'en_proceso')
                      AND ((ev.estado = 'programado' AND ev.fecha_programada <= CURRENT_DATE)
                           OR (ev.estado = 'pendiente' AND ev.tipo = 'envio' AND ev.fecha_programada IS NULL)))::int,
            'manana', (SELECT count(*) FROM public.vl_envios ev
                       WHERE ev.tenant_id = v_tenant AND ev.estado = 'programado'
                         AND ev.fecha_programada = CURRENT_DATE + 1)::int
        )
    ) INTO v_res;

    RETURN v_res;
END;
$function$;

-- ── 4. Bloquear y borrar: borra al usuario de verdad ────────
-- Secuencia:
--   a) sus prendas de procesos ABIERTOS pasan a 'liberada' (no se vendieron);
--   b) esos procesos se cierran como 'no_pago_liberado' (motivo 'liberado');
--   c) se borra su conversación (mensajes y avisos caen en cascada);
--   d) se borra la ficha del cliente (los procesos quedan sin dueño).
-- El dinero YA recibido sigue contando como recibido (es caja real), pero
-- esos montos dejan de contarse como VENTA.
CREATE OR REPLACE FUNCTION public.vl_cliente_bloquear_borrar(p_cliente_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_cli public.vl_clientes%ROWTYPE;
    v_user text;
    v_procesos int := 0;
    v_liberadas int := 0;
    v_chats int := 0;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    SELECT * INTO v_cli
    FROM public.vl_clientes
    WHERE id = p_cliente_id AND tenant_id = v_tenant;
    IF v_cli.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Cliente no encontrado');
    END IF;

    v_user := v_cli.tiktok_user;

    -- a) Prendas de procesos abiertos: liberadas (no se vendieron)
    UPDATE public.vl_items i
    SET estado = 'liberada'
    WHERE i.tenant_id = v_tenant
      AND i.estado <> 'liberada'
      AND i.proceso_id IN (
          SELECT pr.id FROM public.vl_procesos pr
          WHERE pr.tenant_id = v_tenant
            AND pr.cliente_id = v_cli.id
            AND pr.cerrado_en IS NULL
      );
    GET DIAGNOSTICS v_liberadas = ROW_COUNT;

    -- b) Procesos abiertos: cerrados como "no pagó / liberado"
    UPDATE public.vl_procesos
    SET estado = 'no_pago_liberado',
        motivo_cierre = 'liberado',
        cerrado_en = now(),
        updated_at = now()
    WHERE tenant_id = v_tenant
      AND cliente_id = v_cli.id
      AND cerrado_en IS NULL;
    GET DIAGNOSTICS v_procesos = ROW_COUNT;

    -- c) Conversación completa (vl_wa_mensajes y vl_wa_avisos caen en cascada)
    DELETE FROM public.vl_wa_chats
    WHERE tenant_id = v_tenant AND cliente_id = v_cli.id;
    GET DIAGNOSTICS v_chats = ROW_COUNT;

    -- d) Ficha del cliente (los procesos quedan con cliente_id NULL)
    DELETE FROM public.vl_clientes WHERE id = v_cli.id;

    RETURN jsonb_build_object(
        'ok', true,
        'tiktok_user', v_user,
        'procesos_cerrados', v_procesos,
        'prendas_liberadas', v_liberadas,
        'chats_borrados', v_chats
    );
END;
$function$;

-- ── 5. Permisos ─────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.vl_finanzas_resumen() FROM anon, public;
REVOKE ALL ON FUNCTION public.vl_dashboard() FROM anon, public;
REVOKE ALL ON FUNCTION public.vl_cliente_bloquear_borrar(uuid) FROM anon, public;

GRANT EXECUTE ON FUNCTION public.vl_finanzas_resumen() TO authenticated;
GRANT EXECUTE ON FUNCTION public.vl_dashboard() TO authenticated;
GRANT EXECUTE ON FUNCTION public.vl_cliente_bloquear_borrar(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] lo liberado no cuenta como venta + bloqueo real OK' AS status;
