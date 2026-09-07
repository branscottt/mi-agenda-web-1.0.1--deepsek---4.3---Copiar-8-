-- ============================================================
-- MIGRACIÓN: Ventas Live — RPCs de lectura (panel, dashboard,
-- ficha de cliente, búsqueda, envíos, finanzas) + gastos
-- Fecha: 2026-10-14
--
-- OBJETIVO: habilitar las pantallas del panel con UNA llamada por
-- vista (patrón get_worker_portal_data / get_mis_proyectos):
-- respuestas JSONB agregadas, siempre derivadas (el saldo nunca se
-- almacena). Complementa la migración 20261013 (dominio).
--
-- Incluye además vl_agregar_gasto / vl_eliminar_gasto (Finanzas v1).
--
-- Autorización: SECURITY DEFINER + get_vl_tenant_id() + is_admin().
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: Gastos (escritura mínima de Finanzas)
-- ============================================================
CREATE OR REPLACE FUNCTION public.vl_agregar_gasto(
    p_tipo text,
    p_concepto text,
    p_monto numeric,
    p_fecha date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_gasto_id uuid;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    IF p_tipo NOT IN ('inversion', 'gasto') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Tipo inválido (inversion | gasto)');
    END IF;
    IF p_concepto IS NULL OR btrim(p_concepto) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El concepto es requerido');
    END IF;
    IF p_monto IS NULL OR p_monto <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Monto inválido');
    END IF;

    INSERT INTO public.vl_gastos (tenant_id, tipo, concepto, monto, fecha)
    VALUES (v_tenant, p_tipo, btrim(p_concepto), p_monto, COALESCE(p_fecha, CURRENT_DATE))
    RETURNING id INTO v_gasto_id;

    RETURN jsonb_build_object('ok', true, 'gasto_id', v_gasto_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.vl_eliminar_gasto(p_gasto_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_borrado int;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    DELETE FROM public.vl_gastos WHERE id = p_gasto_id AND tenant_id = v_tenant;
    GET DIAGNOSTICS v_borrado = ROW_COUNT;

    IF v_borrado = 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Gasto no encontrado');
    END IF;

    RETURN jsonb_build_object('ok', true);
END;
$$;

-- ============================================================
-- PASO 2: vl_buscar_clientes — búsqueda para el MODO LIVE
-- (autocomplete) y la vista Clientes. p_q '' = todos.
-- ============================================================
CREATE OR REPLACE FUNCTION public.vl_buscar_clientes(p_q text DEFAULT '', p_limit int DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_limit int;
    v_pat_t text;
    v_pat_n text;
    v_res jsonb;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    v_limit := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
    -- patrón TikTok: normalizado (sin @); patrón nombre/whatsapp: crudo
    v_pat_t := '%' || public.vl_normalizar_tiktok(COALESCE(p_q, '')) || '%';
    v_pat_n := '%' || lower(btrim(COALESCE(p_q, ''))) || '%';

    SELECT jsonb_build_object(
        'ok', true,
        'clientes', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'cliente_id', c.id,
                'tiktok_user', c.tiktok_user,
                'nombre_real', c.nombre_real,
                'whatsapp', c.whatsapp,
                'ciudad', c.ciudad,
                'categoria', c.categoria,
                'proceso_activo', (SELECT jsonb_build_object(
                                        'proceso_id', pr.id,
                                        'estado', pr.estado,
                                        'saldo', public.vl_saldo_proceso(pr.id),
                                        'prendas', (SELECT count(*) FROM public.vl_items i
                                                   WHERE i.proceso_id = pr.id AND i.estado IN ('adjudicada', 'pagada'))
                                    )
                                    FROM public.vl_procesos pr
                                    WHERE pr.cliente_id = c.id AND pr.cerrado_en IS NULL
                                    LIMIT 1)
            ) ORDER BY c.updated_at DESC)
            FROM public.vl_clientes c
            WHERE c.tenant_id = v_tenant
              AND (btrim(COALESCE(p_q, '')) = ''
                   OR c.tiktok_user LIKE v_pat_t
                   OR lower(c.nombre_real) LIKE v_pat_n
                   OR c.whatsapp LIKE v_pat_n)
            LIMIT v_limit
        ), '[]'::jsonb)
    ) INTO v_res;

    RETURN v_res;
END;
$$;

-- ============================================================
-- PASO 3: vl_ficha_cliente — ficha completa (spec §20):
-- perfil + proceso activo (items, pagos, envío) + historial de
-- procesos + contadores de comportamiento y dinero.
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
        'contadores', (
            SELECT jsonb_build_object(
                'reservas', count(*)::int,
                'concretadas', count(*) FILTER (
                    WHERE EXISTS (SELECT 1 FROM public.vl_pagos pg WHERE pg.proceso_id = pr.id)
                )::int,
                'no_concretadas', (count(*) - count(*) FILTER (
                    WHERE EXISTS (SELECT 1 FROM public.vl_pagos pg WHERE pg.proceso_id = pr.id)
                ))::int,
                'comprado_total', COALESCE((SELECT SUM(i.precio) FROM public.vl_items i WHERE i.proceso_id = pr.id), 0),
                'pagado_total', COALESCE((SELECT SUM(pg.monto) FROM public.vl_pagos pg WHERE pg.proceso_id = pr.id), 0)
            )
            FROM public.vl_procesos pr WHERE pr.cliente_id = p_cliente_id
        )
    ) INTO v_res;

    RETURN v_res;
END;
$$;

-- ============================================================
-- PASO 4: vl_panel_procesos — procesos ACTIVOS con grupo derivado
-- de acción (spec §18) + conteos por grupo. Reglas derivadas:
--   * 'pagado' o 'acumulando' con saldo > 0 → grupo esperando_pago
--   * 'pagado' con saldo 0 → grupo pagado_sin_decision
--   * 'identificando_cliente' → grupo esperando_whatsapp
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
                'dias_estado', GREATEST(0, (now() - updated_at)::int / 86400),
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

-- ============================================================
-- PASO 5: vl_envios_pendientes — lista de tareas (spec §21-23)
-- agrupada: hoy / mañana / próximos / presenciales / en_proceso,
-- con los datos listos para copiar.
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
                ) ORDER BY fecha_programada ASC NULLS FIRST, tiktok_user ASC)
                FROM fila
                GROUP BY grupo
            ) g
        ), '{}'::jsonb)
    ) INTO v_res;

    RETURN v_res;
END;
$$;

-- ============================================================
-- PASO 6: vl_dashboard — "¿cómo va la tienda?" (spec §19)
-- ============================================================
CREATE OR REPLACE FUNCTION public.vl_dashboard()
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

    SELECT jsonb_build_object(
        'ok', true,
        'ventas', jsonb_build_object(
            'hoy', COALESCE((SELECT SUM(i.precio) FROM public.vl_items i
                             WHERE i.tenant_id = v_tenant AND i.creado_en::date = CURRENT_DATE), 0),
            'mes', COALESCE((SELECT SUM(i.precio) FROM public.vl_items i
                             WHERE i.tenant_id = v_tenant AND i.creado_en >= date_trunc('month', now())), 0),
            'total', COALESCE((SELECT SUM(i.precio) FROM public.vl_items i WHERE i.tenant_id = v_tenant), 0)
        ),
        'live_actual', (
            SELECT jsonb_build_object(
                'live_id', l.id, 'etiqueta', l.etiqueta,
                'ventas', COALESCE((SELECT SUM(i.precio) FROM public.vl_items i WHERE i.live_id = l.id), 0),
                'prendas', (SELECT count(*) FROM public.vl_items i WHERE i.live_id = l.id)
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
$$;

-- ============================================================
-- PASO 7: vl_finanzas_resumen — spec §24. Diferencia explícita:
--   ganancia_estimada = recibido − inversión − gastos (no hay costo
--   unitario por prenda) ; flujo_caja = recibido − gastos.
-- ============================================================
CREATE OR REPLACE FUNCTION public.vl_finanzas_resumen()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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

    SELECT COALESCE(SUM(precio), 0) INTO v_ventas_total FROM public.vl_items WHERE tenant_id = v_tenant;
    SELECT COALESCE(SUM(precio), 0) INTO v_ventas_mes FROM public.vl_items
    WHERE tenant_id = v_tenant AND creado_en >= date_trunc('month', now());

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
$$;

-- ============================================================
-- PASO 8: Permisos (solo authenticated)
-- ============================================================
REVOKE ALL ON FUNCTION public.vl_agregar_gasto(text, text, numeric, date) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_agregar_gasto(text, text, numeric, date) TO authenticated;

REVOKE ALL ON FUNCTION public.vl_eliminar_gasto(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_eliminar_gasto(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.vl_buscar_clientes(text, int) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_buscar_clientes(text, int) TO authenticated;

REVOKE ALL ON FUNCTION public.vl_ficha_cliente(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_ficha_cliente(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.vl_panel_procesos() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_panel_procesos() TO authenticated;

REVOKE ALL ON FUNCTION public.vl_envios_pendientes() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_envios_pendientes() TO authenticated;

REVOKE ALL ON FUNCTION public.vl_dashboard() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_dashboard() TO authenticated;

REVOKE ALL ON FUNCTION public.vl_finanzas_resumen() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_finanzas_resumen() TO authenticated;

-- ============================================================
-- PASO 9: Refresh schema cache + verificación
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE LECTURA] panel + dashboard + ficha + envíos + finanzas OK' AS status;
