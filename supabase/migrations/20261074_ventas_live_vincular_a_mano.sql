-- ════════════════════════════════════════════════════════════════════════════
-- [VENTAS LIVE] (20261074) "¿Es alguno de estos?" apretable DENTRO del chat
--
-- Pedido del dueño: si el bot no encuentra al usuario (no entiende lo que
-- escribió), poder APRETAR en el chat los posibles usuarios — considerando sobre
-- todo los que COMPRARON pero quedaron SIN VINCULAR (típico: la prenda se cargó
-- desde el LIVE con el nombre del live y el número de WhatsApp nunca se ligó).
--
--   * vl_wa_candidatos_chat(chat_id): candidatos para ESE chat (solo si todavía
--     no está vinculado): el sugerido, los parecidos que calculó el bot y los
--     COMPRADORES sin número de WhatsApp guardado, con prendas y saldo.
--   * vl_wa_vincular_chat(chat_id, cliente_id): vincula a mano (el dueño aprieta),
--     guarda el número del chat en la ficha si no tenía (para que la próxima vez
--     el bot lo reconozca solo) y cierra los avisos de identificación.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Candidatos para vincular este chat ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.vl_wa_candidatos_chat(p_chat_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_chat public.vl_wa_chats%ROWTYPE;
    v_cands jsonb := '[]'::jsonb;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    SELECT * INTO v_chat
    FROM public.vl_wa_chats
    WHERE id = p_chat_id AND tenant_id = v_tenant;

    IF v_chat.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Conversación no encontrada');
    END IF;
    IF v_chat.cliente_id IS NOT NULL THEN
        RETURN jsonb_build_object('ok', true, 'vinculado', true, 'candidatos', '[]'::jsonb);
    END IF;

    WITH base AS (
        -- (1) el sugerido por el matcher (lo más probable)
        SELECT v_chat.cliente_sugerido AS cliente_id, 1 AS rank, 0 AS ord, 'te lo sugirió el bot' AS motivo
        WHERE v_chat.cliente_sugerido IS NOT NULL

        UNION ALL

        -- (2) los parecidos que ya calculó el matcher (lista del chat)
        SELECT (c->>'cliente_id')::uuid, 2, ord::int, 'se parece a lo que escribió'
          FROM jsonb_array_elements(COALESCE(v_chat.usuario_candidatos, '[]'::jsonb))
               WITH ORDINALITY AS t(c, ord)

        UNION ALL

        -- (3) COMPRADORES SIN VINCULAR: tienen prendas adjudicadas en un pedido
        --     abierto y su ficha NO tiene WhatsApp guardado (nadie los vinculó).
        SELECT cl.id, 3, 0, 'compró y no está vinculado'
          FROM public.vl_clientes cl
         WHERE cl.tenant_id = v_tenant
           AND COALESCE(btrim(cl.whatsapp), '') = ''
           AND EXISTS (
               SELECT 1 FROM public.vl_items i
                 JOIN public.vl_procesos p ON p.id = i.proceso_id
                WHERE p.cliente_id = cl.id AND p.cerrado_en IS NULL
                  AND i.estado = 'adjudicada')
    ),
    uno AS (
        SELECT DISTINCT ON (b.cliente_id) b.cliente_id, b.rank, b.motivo
          FROM base b
         WHERE b.cliente_id IS NOT NULL
         ORDER BY b.cliente_id, b.rank, b.ord
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'cliente_id', cl.id,
               'tiktok_user', COALESCE(cl.tiktok_user, ''),
               'nombre_real', COALESCE(cl.nombre_real, ''),
               'motivo', u.motivo,
               'prendas', COALESCE(agg.prendas, 0),
               'saldo', COALESCE(agg.saldo, 0),
               'ultima', agg.ultima
           ) ORDER BY u.rank, agg.ultima DESC NULLS LAST), '[]'::jsonb)
      INTO v_cands
      FROM uno u
      JOIN public.vl_clientes cl ON cl.id = u.cliente_id AND cl.tenant_id = v_tenant
      LEFT JOIN LATERAL (
          SELECT count(*)::int AS prendas,
                 COALESCE(SUM(i.precio - i.abonado), 0) AS saldo,
                 max(i.creado_en) AS ultima
            FROM public.vl_items i
            JOIN public.vl_procesos p ON p.id = i.proceso_id
           WHERE p.cliente_id = cl.id AND p.cerrado_en IS NULL
      ) agg ON true;

    RETURN jsonb_build_object('ok', true, 'vinculado', false, 'candidatos', v_cands);
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_wa_candidatos_chat(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_candidatos_chat(uuid) TO authenticated;

-- ── 2. Vincular el chat a un cliente (lo aprieta el dueño) ──────────────────
CREATE OR REPLACE FUNCTION public.vl_wa_vincular_chat(p_chat_id uuid, p_cliente_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_chat public.vl_wa_chats%ROWTYPE;
    v_cli public.vl_clientes%ROWTYPE;
    v_wa_previo text;
    v_guardo_wa boolean := false;
    v_chat_de_otro uuid;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    SELECT * INTO v_chat FROM public.vl_wa_chats
     WHERE id = p_chat_id AND tenant_id = v_tenant;
    IF v_chat.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Conversación no encontrada');
    END IF;

    SELECT * INTO v_cli FROM public.vl_clientes
     WHERE id = p_cliente_id AND tenant_id = v_tenant;
    IF v_cli.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Cliente no encontrado');
    END IF;

    -- ¿ese cliente ya tiene OTRO chat con otro número? (se avisa, no se bloquea)
    SELECT ch.id INTO v_chat_de_otro
      FROM public.vl_wa_chats ch
     WHERE ch.tenant_id = v_tenant AND ch.cliente_id = v_cli.id
       AND ch.id <> v_chat.id AND COALESCE(ch.oculto, false) = false
     LIMIT 1;

    -- Guardar el número de ESTE chat en la ficha si no tenía ninguno: así el bot
    -- lo reconoce solo la próxima vez (es lo que faltaba en la venta del 02/10).
    v_wa_previo := btrim(COALESCE(v_cli.whatsapp, ''));
    IF v_wa_previo = '' THEN
        UPDATE public.vl_clientes
           SET whatsapp = v_chat.wa_id, updated_at = now()
         WHERE id = v_cli.id;
        v_guardo_wa := true;
    END IF;

    UPDATE public.vl_wa_chats
       SET cliente_id = v_cli.id,
           cliente_sugerido = NULL,
           usuario_candidato = NULL,
           usuario_candidatos = NULL,
           usuario_intentos = 0,
           estado = CASE WHEN estado IN ('nuevo', 'esperando_tiktok', 'esperando_confirmar_usuario')
                         THEN 'habitual' ELSE estado END
     WHERE id = v_chat.id;

    -- Cerrar los avisos de identificación que quedaron abiertos
    UPDATE public.vl_wa_avisos
       SET resuelto_en = now()
     WHERE chat_id = v_chat.id AND resuelto_en IS NULL
       AND tipo IN ('usuario_no_encontrado', 'usuario_no_confirmado', 'sin_cliente',
                    'usuario_sugerido', 'vinculado_usuario', 'otro_numero');

    INSERT INTO public.vl_wa_avisos (tenant_id, chat_id, tipo, detalle)
    VALUES (v_tenant, v_chat.id, 'vinculado_usuario',
            'Vinculaste el chat a mano con @' || COALESCE(v_cli.tiktok_user, '')
            || CASE WHEN v_guardo_wa THEN '. El número del chat quedó guardado en su ficha.' ELSE '.' END);

    RETURN jsonb_build_object(
        'ok', true,
        'cliente_id', v_cli.id,
        'tiktok_user', COALESCE(v_cli.tiktok_user, ''),
        'guardó_whatsapp', v_guardo_wa,
        'whatsapp_previo', v_wa_previo,
        'otro_chat_abierto', v_chat_de_otro IS NOT NULL
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_wa_vincular_chat(uuid, uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_vincular_chat(uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] candidatos apretables en el chat + vincular a mano (20261074) OK' AS status;
