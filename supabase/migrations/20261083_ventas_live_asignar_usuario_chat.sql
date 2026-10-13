-- ════════════════════════════════════════════════════════════════════════════
-- [VENTAS LIVE] (20261083) ASIGNAR EL USUARIO DEL CHAT A MANO (aunque no haya
--                       comprado ni el bot lo haya encontrado)
--
-- Pedido del dueño (caso real 13/10: la persona escribió "Jorge Luis Matute",
-- el bot ofreció @la_diabla888 y @atakalina — NO a jolumaaf, que era él — y el
-- chat quedó sin vincular). Necesita poder ABRIR el chat, VER la lista de
-- usuarios que compraron y APRETAR el correcto; y también buscar a mano a
-- cualquiera de los usuarios existentes cuando la persona escribió sin comprar.
--
--   * vl_wa_usuarios_para_chat(chat_id, texto): lista para asignar a mano.
--       - Sin texto: (1) el sugerido por el bot, (2) los parecidos, (3) los que
--         COMPRARON y quedaron SIN vincular (prendas adjudicadas en un proceso
--         abierto y ficha sin número), (4) el resto de los que ya compraron
--         (para reconocer a simple vista). Con prendas, saldo y fecha.
--       - Con texto: busca por @ / nombre / número en TODO el negocio (coincidencia
--         directa + el buscador con puntaje que ya usa el bot), compre o no.
--   * La asignación usa la RPC que ya existe: vl_wa_vincular_chat(chat_id, cliente)
--     (guarda el número del chat en la ficha → el bot lo reconoce solo después).
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.vl_wa_usuarios_para_chat(p_chat_id uuid, p_texto text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant   uuid;
    v_chat     public.vl_wa_chats%ROWTYPE;
    v_texto    text := btrim(COALESCE(p_texto, ''));
    v_like     text;
    v_dig      text;
    v_actual   jsonb := NULL;
    v_usuarios jsonb := '[]'::jsonb;
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

    -- Ficha con la que está HOY (para poder corregir si quedó mal asignada).
    IF v_chat.cliente_id IS NOT NULL THEN
        SELECT jsonb_build_object(
                   'cliente_id', cl.id,
                   'tiktok_user', COALESCE(cl.tiktok_user, ''),
                   'nombre_real', COALESCE(cl.nombre_real, ''),
                   'whatsapp', COALESCE(cl.whatsapp, ''))
          INTO v_actual
          FROM public.vl_clientes cl
         WHERE cl.id = v_chat.cliente_id AND cl.tenant_id = v_tenant;
    END IF;

    IF v_texto <> '' THEN
        -- ── BUSCAR A MANO: lo que el dueño escribió, contra TODO el negocio ──
        v_like := '%' || lower(regexp_replace(v_texto, '([%_\\])', '\\\1', 'g')) || '%';
        v_dig  := regexp_replace(v_texto, '[^0-9]', '', 'g');

        WITH base AS (
            -- (1) coincidencia directa con lo escrito (@, nombre o número)
            SELECT cl.id AS cliente_id, 1 AS rank, 0::numeric AS sc,
                   'coincide con lo que buscaste' AS motivo
              FROM public.vl_clientes cl
             WHERE cl.tenant_id = v_tenant
               AND ( lower(COALESCE(cl.tiktok_user, '')) LIKE v_like
                  OR lower(COALESCE(cl.nombre_real, '')) LIKE v_like
                  OR ( v_dig <> ''
                       AND regexp_replace(COALESCE(cl.whatsapp, ''), '[^0-9]', '', 'g') LIKE '%' || v_dig || '%' ) )

            UNION ALL

            -- (2) los parecidos con puntaje (el mismo buscador del bot, que
            --     también mira a los que NO compraron)
            SELECT (e->>'cliente_id')::uuid, 2,
                   COALESCE((e->>'score')::numeric, 0),
                   'se parece a lo que buscaste'
              FROM jsonb_array_elements(
                       public.vl_wa_buscar_candidatos(
                           v_tenant, public.vl_wa_candidatos_usuario(v_texto), false, 0.35, 20)
                   ) e
        ),
        uno AS (
            SELECT DISTINCT ON (b.cliente_id) b.cliente_id, b.rank, b.sc, b.motivo
              FROM base b
             WHERE b.cliente_id IS NOT NULL
             ORDER BY b.cliente_id, b.rank, b.sc DESC
        )
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                   'cliente_id', cl.id,
                   'tiktok_user', COALESCE(cl.tiktok_user, ''),
                   'nombre_real', COALESCE(cl.nombre_real, ''),
                   'motivo', u.motivo,
                   'prendas', COALESCE(agg.prendas, 0),
                   'saldo', COALESCE(agg.saldo, 0),
                   'saldo_abierto', COALESCE(agg.saldo_abierto, 0),
                   'compro', COALESCE(agg.prendas, 0) > 0,
                   'tiene_numero', COALESCE(btrim(cl.whatsapp), '') <> '',
                   'ultima', agg.ultima
               ) ORDER BY u.rank, u.sc DESC, agg.ultima DESC NULLS LAST), '[]'::jsonb)
          INTO v_usuarios
          FROM uno u
          JOIN public.vl_clientes cl ON cl.id = u.cliente_id AND cl.tenant_id = v_tenant
          LEFT JOIN LATERAL (
              SELECT count(*) FILTER (WHERE i.estado = 'adjudicada')::int AS prendas,
                     COALESCE(SUM(i.precio - i.abonado) FILTER (WHERE i.estado = 'adjudicada'), 0) AS saldo,
                     COALESCE(SUM(i.precio - i.abonado) FILTER (
                         WHERE i.estado = 'adjudicada' AND p.cerrado_en IS NULL), 0) AS saldo_abierto,
                     max(i.creado_en) AS ultima
                FROM public.vl_items i
                JOIN public.vl_procesos p ON p.id = i.proceso_id
               WHERE p.cliente_id = cl.id
          ) agg ON true;
    ELSE
        -- ── LISTA POR DEFECTO: los que compraron, primero los sin vincular ──
        WITH base AS (
            -- (1) el que sugirió el bot
            SELECT v_chat.cliente_sugerido AS cliente_id, 1 AS rank, 0 AS ord,
                   'te lo sugirió el bot' AS motivo
             WHERE v_chat.cliente_sugerido IS NOT NULL

            UNION ALL

            -- (2) los parecidos que calculó el bot
            SELECT (c->>'cliente_id')::uuid, 2, ord::int, 'se parece a lo que escribió'
              FROM jsonb_array_elements(COALESCE(v_chat.usuario_candidatos, '[]'::jsonb))
                   WITH ORDINALITY AS t(c, ord)

            UNION ALL

            -- (3) COMPRÓ Y NO ESTÁ VINCULADO (el caso del live: la prenda se
            --     cargó con el nombre del live y el número nunca se ligó)
            SELECT cl.id, 3, 0, 'compró y no está vinculado'
              FROM public.vl_clientes cl
             WHERE cl.tenant_id = v_tenant
               AND COALESCE(btrim(cl.whatsapp), '') = ''
               AND EXISTS (
                   SELECT 1 FROM public.vl_items i
                     JOIN public.vl_procesos p ON p.id = i.proceso_id
                    WHERE p.cliente_id = cl.id AND p.cerrado_en IS NULL
                      AND i.estado = 'adjudicada')

            UNION ALL

            -- (4) los demás que ya compraron (para reconocerlos a simple vista)
            SELECT cl2.id, 4, 0, 'ya compró antes'
              FROM public.vl_clientes cl2
             WHERE cl2.tenant_id = v_tenant
               AND EXISTS (
                   SELECT 1 FROM public.vl_items i2
                     JOIN public.vl_procesos p2 ON p2.id = i2.proceso_id
                    WHERE p2.cliente_id = cl2.id AND i2.estado = 'adjudicada')
        ),
        uno AS (
            SELECT DISTINCT ON (b.cliente_id) b.cliente_id, b.rank, b.motivo
              FROM base b
             WHERE b.cliente_id IS NOT NULL
             ORDER BY b.cliente_id, b.rank, b.ord
        ),
        lim AS (
            SELECT u.cliente_id, u.rank, u.motivo, ult.ultima
              FROM uno u
              LEFT JOIN LATERAL (
                  SELECT max(i.creado_en) AS ultima
                    FROM public.vl_items i
                    JOIN public.vl_procesos p ON p.id = i.proceso_id
                   WHERE p.cliente_id = u.cliente_id
              ) ult ON true
             ORDER BY u.rank, ult.ultima DESC NULLS LAST
             LIMIT 30
        )
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                   'cliente_id', cl.id,
                   'tiktok_user', COALESCE(cl.tiktok_user, ''),
                   'nombre_real', COALESCE(cl.nombre_real, ''),
                   'motivo', u.motivo,
                   'prendas', COALESCE(agg.prendas, 0),
                   'saldo', COALESCE(agg.saldo, 0),
                   'saldo_abierto', COALESCE(agg.saldo_abierto, 0),
                   'compro', COALESCE(agg.prendas, 0) > 0,
                   'tiene_numero', COALESCE(btrim(cl.whatsapp), '') <> '',
                   'ultima', agg.ultima
               ) ORDER BY u.rank, agg.ultima DESC NULLS LAST), '[]'::jsonb)
          INTO v_usuarios
          FROM lim u
          JOIN public.vl_clientes cl ON cl.id = u.cliente_id AND cl.tenant_id = v_tenant
          LEFT JOIN LATERAL (
              SELECT count(*) FILTER (WHERE i.estado = 'adjudicada')::int AS prendas,
                     COALESCE(SUM(i.precio - i.abonado) FILTER (WHERE i.estado = 'adjudicada'), 0) AS saldo,
                     COALESCE(SUM(i.precio - i.abonado) FILTER (
                         WHERE i.estado = 'adjudicada' AND p.cerrado_en IS NULL), 0) AS saldo_abierto,
                     max(i.creado_en) AS ultima
                FROM public.vl_items i
                JOIN public.vl_procesos p ON p.id = i.proceso_id
               WHERE p.cliente_id = cl.id
          ) agg ON true;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'vinculado', v_chat.cliente_id IS NOT NULL,
        'cliente_actual', v_actual,
        'q', v_texto,
        'usuarios', v_usuarios
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_wa_usuarios_para_chat(uuid, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_usuarios_para_chat(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] asignar usuario del chat a mano (20261083) OK' AS status;
