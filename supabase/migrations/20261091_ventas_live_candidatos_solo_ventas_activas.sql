-- ════════════════════════════════════════════════════════════════════════════
-- [VENTAS LIVE] (20261091) "¿QUIÉN ES?" — SOLO VENTAS ACTIVAS SIN USUARIO
--
-- Pedido del dueño: *"al reconocer el usuario manualmente debería dejar de
-- permitir elegir a un usuario ya reconocido o eliminado. Ejemplo: jolumaaf ya
-- fue reconocido, entonces no debería salir para los demás para elegir; y
-- también hay una eliminada y también sale. Solo deberían salir las que tienen
-- ventas activas y aún no se les reconoce usuario. Si se reconoce usuario de esa
-- venta ya no debería aparecer a otra persona. Podría provocar problemas a
-- futuro si hay muchas ventas a la vez."*
--
-- DIAGNÓSTICO (datos reales, tenant b595cde4): la lista salía de 4 fuentes y
-- SOLO una miraba el estado real de la venta:
--   (1) el sugerido por el bot        → sin filtros
--   (2) los parecidos del bot         → sin filtros  ← jolumaaf salía por acá
--   (3) "compró y no está vinculado"  → exigía whatsapp = '' (bien) pero
--       contaba cualquier prenda adjudicada, AUNQUE el proceso estuviera cerrado
--   (4) "ya compró antes"             → SIN NINGÚN FILTRO: mostraba fichas ya
--       reconocidas (jolumaaf: número guardado + chat vinculado) y fichas
--       eliminadas/bloqueadas (categoria = 'bloqueado'), y ventas ya cerradas.
-- Eso es lo que el dueño veía: gente ya reconocida y gente borrada, ofrecidas
-- para asignar a CUALQUIER chat nuevo.
--
-- ARREGLO: un solo universo de candidatos para la lista por defecto —
--   · la ficha NO está eliminada (categoria <> 'bloqueado'),
--   · NO tiene usuario reconocido (sin número en la ficha y sin ninguna
--     conversación visible vinculada: si ya se reconoció, no se ofrece a otra),
--   · tiene VENTA ACTIVA (prenda adjudicada / pagada / entregada — NO liberada,
--     que es una venta anulada — dentro de un proceso ABIERTO).
-- Las sugerencias del bot pasan por el MISMO filtro (una ficha ya reconocida no
-- se ofrece nunca). El BUSCADOR a mano sigue encontrando a cualquiera (es
-- deliberado), pero marca `ya_reconocido` para que el panel avise antes de
-- pisar una asignación, y ordena a los disponibles primero.
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
        -- Acá NO se esconde a nadie (es una búsqueda deliberada, sirve para
        -- corregir una asignación equivocada), pero se MARCA `ya_reconocido` y
        -- los disponibles van primero.
        v_like := '%' || lower(regexp_replace(v_texto, '([%_\\])', '\\\1', 'g')) || '%';
        v_dig  := regexp_replace(v_texto, '[^0-9]', '', 'g');

        WITH base AS (
            -- (1) coincidencia directa con lo escrito (@, nombre o número)
            SELECT cl.id AS cliente_id, 1 AS rank, 0::numeric AS sc,
                   'coincide con lo que buscaste' AS motivo
              FROM public.vl_clientes cl
             WHERE cl.tenant_id = v_tenant
               AND cl.categoria <> 'bloqueado'
               AND ( lower(COALESCE(cl.tiktok_user, '')) LIKE v_like
                  OR lower(COALESCE(cl.nombre_real, '')) LIKE v_like
                  OR ( v_dig <> ''
                       AND regexp_replace(COALESCE(cl.whatsapp, ''), '[^0-9]', '', 'g') LIKE '%' || v_dig || '%' ) )

            UNION ALL

            -- (2) los parecidos con puntaje (el mismo buscador del bot)
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
              JOIN public.vl_clientes c2 ON c2.id = b.cliente_id AND c2.categoria <> 'bloqueado'
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
                   'ya_reconocido', rec.ya,
                   'venta_activa', COALESCE(agg.activas, 0) > 0,
                   'bloqueado', cl.categoria = 'bloqueado',
                   'ultima', agg.ultima
               ) ORDER BY rec.ya, u.rank, u.sc DESC, agg.ultima DESC NULLS LAST), '[]'::jsonb)
          INTO v_usuarios
          FROM uno u
          JOIN public.vl_clientes cl ON cl.id = u.cliente_id AND cl.tenant_id = v_tenant
          LEFT JOIN LATERAL (
              SELECT count(*) FILTER (WHERE i.estado = 'adjudicada')::int AS prendas,
                     count(*) FILTER (WHERE i.estado IN ('adjudicada', 'pagada', 'entregada')
                                        AND p.cerrado_en IS NULL)::int AS activas,
                     COALESCE(SUM(i.precio - i.abonado) FILTER (WHERE i.estado = 'adjudicada'), 0) AS saldo,
                     COALESCE(SUM(i.precio - i.abonado) FILTER (
                         WHERE i.estado = 'adjudicada' AND p.cerrado_en IS NULL), 0) AS saldo_abierto,
                     max(i.creado_en) AS ultima
                FROM public.vl_items i
                JOIN public.vl_procesos p ON p.id = i.proceso_id
               WHERE p.cliente_id = cl.id
          ) agg ON true
          LEFT JOIN LATERAL (
              SELECT ( COALESCE(btrim(cl.whatsapp), '') <> ''
                    OR EXISTS (SELECT 1 FROM public.vl_wa_chats c
                                WHERE c.tenant_id = v_tenant AND c.cliente_id = cl.id
                                  AND COALESCE(c.oculto, false) = false) ) AS ya
          ) rec ON true;
    ELSE
        -- ── LISTA POR DEFECTO: SOLO ventas ACTIVAS sin usuario reconocido ────
        WITH candidata AS (
            -- El universo: ficha viva, SIN usuario reconocido y con venta activa.
            SELECT cl.id AS cliente_id
              FROM public.vl_clientes cl
             WHERE cl.tenant_id = v_tenant
               -- (1) nada de fichas eliminadas/bloqueadas
               AND cl.categoria <> 'bloqueado'
               -- (2) sin usuario reconocido: ni número en la ficha ni otra
               --     conversación visible ya vinculada a ella (y tampoco ESTA:
               --     si ya está asignada acá, no hay nada que elegir)
               AND COALESCE(btrim(cl.whatsapp), '') = ''
               AND NOT EXISTS (
                   SELECT 1 FROM public.vl_wa_chats c
                    WHERE c.tenant_id = v_tenant AND c.cliente_id = cl.id
                      AND COALESCE(c.oculto, false) = false)
               -- (3) VENTA ACTIVA: prenda adjudicada/pagada/entregada (las
               --     "liberadas" son ventas anuladas) en un proceso ABIERTO
               AND EXISTS (
                   SELECT 1 FROM public.vl_items i
                     JOIN public.vl_procesos p ON p.id = i.proceso_id
                    WHERE p.cliente_id = cl.id
                      AND p.cerrado_en IS NULL
                      AND i.estado IN ('adjudicada', 'pagada', 'entregada'))
        ),
        base AS (
            -- (1) el que sugirió el bot — solo si es una venta activa sin dueño
            SELECT v_chat.cliente_sugerido AS cliente_id, 1 AS rank, 0 AS ord,
                   'te lo sugirió el bot' AS motivo
             WHERE v_chat.cliente_sugerido IS NOT NULL
               AND EXISTS (SELECT 1 FROM candidata k WHERE k.cliente_id = v_chat.cliente_sugerido)

            UNION ALL

            -- (2) los parecidos que calculó el bot — mismo filtro
            SELECT (c->>'cliente_id')::uuid, 2, ord::int, 'se parece a lo que escribió'
              FROM jsonb_array_elements(COALESCE(v_chat.usuario_candidatos, '[]'::jsonb))
                   WITH ORDINALITY AS t(c, ord)
             WHERE (c->>'cliente_id') IS NOT NULL
               AND EXISTS (SELECT 1 FROM candidata k
                            WHERE k.cliente_id = (c->>'cliente_id')::uuid)

            UNION ALL

            -- (3) VENTA ACTIVA SIN VINCULAR (el caso del live: la prenda se cargó
            --     con el nombre del live y el número nunca se ligó)
            SELECT k.cliente_id, 3, 0, 'venta sin vincular'
              FROM candidata k
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
                   'tiene_numero', false,
                   'ya_reconocido', false,
                   'venta_activa', true,
                   'bloqueado', false,
                   'ultima', agg.ultima
               ) ORDER BY u.rank, agg.ultima DESC NULLS LAST), '[]'::jsonb)
          INTO v_usuarios
          FROM lim u
          JOIN public.vl_clientes cl ON cl.id = u.cliente_id AND cl.tenant_id = v_tenant
          LEFT JOIN LATERAL (
              SELECT count(*) FILTER (WHERE i.estado = 'adjudicada')::int AS prendas,
                     count(*) FILTER (WHERE i.estado IN ('adjudicada', 'pagada', 'entregada')
                                        AND p.cerrado_en IS NULL)::int AS activas,
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

-- ¿Está este usuario ya reconocido en OTRA conversación? La usa el panel para
-- avisar antes de pisar una asignación (buscador a mano).
CREATE OR REPLACE FUNCTION public.vl_wa_cliente_ya_reconocido(p_cliente_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_cli    public.vl_clientes%ROWTYPE;
    v_chat   uuid;
    v_wa     text;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL OR NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin permiso');
    END IF;

    SELECT * INTO v_cli FROM public.vl_clientes
     WHERE id = p_cliente_id AND tenant_id = v_tenant;
    IF v_cli.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Cliente no encontrado');
    END IF;

    SELECT c.id, c.wa_id INTO v_chat, v_wa
      FROM public.vl_wa_chats c
     WHERE c.tenant_id = v_tenant AND c.cliente_id = v_cli.id
       AND COALESCE(c.oculto, false) = false
     ORDER BY c.ultimo_en DESC NULLS LAST
     LIMIT 1;

    RETURN jsonb_build_object(
        'ok', true,
        'ya', (v_chat IS NOT NULL OR COALESCE(btrim(v_cli.whatsapp), '') <> ''),
        'chat_id', v_chat,
        'wa_id', COALESCE(v_wa, ''),
        'tiene_numero', COALESCE(btrim(v_cli.whatsapp), '') <> ''
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_wa_cliente_ya_reconocido(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_cliente_ya_reconocido(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] ¿Quién es? solo ventas activas sin usuario reconocido (20261091) OK' AS status;
