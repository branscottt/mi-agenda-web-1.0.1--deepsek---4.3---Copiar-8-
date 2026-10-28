-- 20261108_ventas_live_vendido_y_prendas_sin_contacto.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Pedido del dueño (2026-10-28):
--   (1) "en LIVE, abajo de Registrar venta dice las prendas que se vendieron…
--        quiero que dejes las prendas que YA SE PAGARON para ver directamente
--        cuánto ya vendimos en este LIVE".
--       → vl_live_vendido(): lo ya VENDIDO del LIVE abierto = prendas pagadas
--         (estado 'pagada' o 'entregada'), con su lista y su total. Las que
--         están 'adjudicada' (compradas sin pagar) se informan aparte como
--         "sin pagar", nunca se suman al vendido.
--   (2) "si alguien compró pero nunca habla por la prenda, al otro día dar
--        aviso para poder liberar la prenda".
--       → vl_prendas_sin_contacto(): prendas adjudicadas de días anteriores
--         (creado_en < hoy) sin NINGÚN mensaje entrante del cliente desde que
--         se la adjudicamos. Devuelve días sin contacto y el chat (si tiene)
--         para poder escribirle o liberar la prenda.
--
-- Solo lectura (no escribe datos). SECURITY DEFINER con los mismos guardas que
-- el resto del dominio VL (get_vl_tenant_id + is_admin).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1) Lo vendido en el LIVE abierto (solo pagadas) ──────────────────────────
CREATE OR REPLACE FUNCTION public.vl_live_vendido()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant  uuid;
    v_live_id uuid;
    v_etiqueta text;
    v_res     jsonb;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    SELECT id, etiqueta INTO v_live_id, v_etiqueta
    FROM public.vl_lives
    WHERE tenant_id = v_tenant AND cerrado_en IS NULL
    ORDER BY abierto_en DESC
    LIMIT 1;

    IF v_live_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', true, 'live', NULL,
            'n_pagadas', 0, 'total_pagado', 0,
            'n_sin_pagar', 0, 'total_sin_pagar', 0,
            'pagadas', '[]'::jsonb
        );
    END IF;

    SELECT jsonb_build_object(
        'ok', true,
        'live', jsonb_build_object('id', v_live_id, 'etiqueta', v_etiqueta),
        -- Lo YA VENDIDO = solo prendas con pago confirmado.
        'n_pagadas',       COALESCE(count(*) FILTER (WHERE i.estado IN ('pagada', 'entregada')), 0),
        'total_pagado',    COALESCE(sum(i.precio) FILTER (WHERE i.estado IN ('pagada', 'entregada')), 0),
        -- Lo comprado sin pagar: informativo, NO se suma al vendido.
        'n_sin_pagar',     COALESCE(count(*) FILTER (WHERE i.estado = 'adjudicada'), 0),
        'total_sin_pagar', COALESCE(sum(i.precio) FILTER (WHERE i.estado = 'adjudicada'), 0),
        'pagadas', COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'id', i.id,
                    'precio', i.precio,
                    'estado', i.estado,
                    'creado_en', i.creado_en,
                    'proceso_id', i.proceso_id,
                    'cliente_id', c.id,
                    'tiktok_user', c.tiktok_user,
                    'nombre_real', c.nombre_real
                ) ORDER BY i.creado_en DESC
            ) FILTER (WHERE i.estado IN ('pagada', 'entregada')),
            '[]'::jsonb
        )
    ) INTO v_res
    FROM public.vl_items i
    LEFT JOIN public.vl_procesos p ON p.id = i.proceso_id
    LEFT JOIN public.vl_clientes c ON c.id = p.cliente_id
    WHERE i.live_id = v_live_id
      AND i.estado <> 'liberada';

    RETURN v_res;
END;
$$;

-- ── 2) Prendas adjudicadas que nunca hablaron por ellas (al otro día) ────────
-- Regla exacta:
--   · prenda en estado 'adjudicada' (comprada, sin pago confirmado),
--   · adjudicada ANTES de hoy (>= 1 día),
--   · y el cliente NO escribió nunca por WhatsApp desde que se la adjudicamos
--     (incluye el caso típico: compró en el LIVE y jamás escribió → sin chat).
CREATE OR REPLACE FUNCTION public.vl_prendas_sin_contacto()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_res    jsonb;
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
        'total', COALESCE(count(*), 0),
        'total_monto', COALESCE(sum(x.precio), 0),
        'items', COALESCE(jsonb_agg(jsonb_build_object(
            'item_id', x.item_id,
            'precio', x.precio,
            'creado_en', x.creado_en,
            'dias', x.dias,
            'proceso_id', x.proceso_id,
            'cliente_id', x.cliente_id,
            'tiktok_user', x.tiktok_user,
            'nombre_real', x.nombre_real,
            'whatsapp', x.whatsapp,
            'live_etiqueta', x.live_etiqueta,
            'chat_id', x.chat_id,
            'ya_escribio', x.ya_escribio
        ) ORDER BY x.creado_en ASC), '[]'::jsonb)
    ) INTO v_res
    FROM (
        SELECT i.id           AS item_id,
               i.precio       AS precio,
               i.creado_en    AS creado_en,
               (CURRENT_DATE - i.creado_en::date) AS dias,
               i.proceso_id   AS proceso_id,
               c.id           AS cliente_id,
               c.tiktok_user  AS tiktok_user,
               c.nombre_real  AS nombre_real,
               c.whatsapp     AS whatsapp,
               l.etiqueta     AS live_etiqueta,
               (SELECT ch.id FROM public.vl_wa_chats ch
                 WHERE ch.cliente_id = c.id AND ch.tenant_id = v_tenant
                 ORDER BY ch.ultimo_en DESC NULLS LAST LIMIT 1) AS chat_id,
               EXISTS (SELECT 1 FROM public.vl_wa_chats ch
                        JOIN public.vl_wa_mensajes m ON m.chat_id = ch.id
                        WHERE ch.cliente_id = c.id AND ch.tenant_id = v_tenant
                          AND m.direction = 'in'
                          AND m.creado_en >= i.creado_en) AS ya_escribio
        FROM public.vl_items i
        JOIN public.vl_procesos p ON p.id = i.proceso_id
        JOIN public.vl_clientes c ON c.id = p.cliente_id
        LEFT JOIN public.vl_lives l ON l.id = i.live_id
        WHERE i.tenant_id = v_tenant
          AND i.estado = 'adjudicada'
          AND i.creado_en::date < CURRENT_DATE
          AND NOT EXISTS (
              SELECT 1 FROM public.vl_wa_chats ch
              JOIN public.vl_wa_mensajes m ON m.chat_id = ch.id
              WHERE ch.cliente_id = c.id AND ch.tenant_id = v_tenant
                AND m.direction = 'in'
                AND m.creado_en >= i.creado_en
          )
    ) x;

    RETURN v_res;
END;
$$;

REVOKE ALL ON FUNCTION public.vl_live_vendido() FROM anon, public;
REVOKE ALL ON FUNCTION public.vl_prendas_sin_contacto() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_live_vendido() TO authenticated;
GRANT EXECUTE ON FUNCTION public.vl_prendas_sin_contacto() TO authenticated;
