-- ════════════════════════════════════════════════════════════════════════════
-- [VENTAS LIVE] (20261090) PARIDAD CON WHATSAPP — lo que faltaba para ENTENDER
--
-- Pedido del dueño: "pon todo lo que tiene WhatsApp, veré si puedo resolver
-- para saber qué prenda quería". Lo que aparece en un chat de WhatsApp y acá no
-- estaba:
--
--   1. REACCIONES (😍👍😂…): el cliente reacciona a UN mensaje concreto. Meta
--      manda el emoji + el id del mensaje reaccionado (reaction.message_id). Hasta
--      ahora se guardaba una burbuja suelta con el emoji: no se sabía A CUÁL se
--      refería ni se veía como en WhatsApp. Ahora se guarda pegado a ESE mensaje
--      (en context_wa_id) y se ve como emoji sobre la burbuja. Reaccionar sin
--      emoji = QUITAR la reacción (igual que WhatsApp).
--      OJO: en WhatsApp las reacciones van en su propio campo, NO en `context`
--      (que es para "responder citando"). Son dos cosas distintas y por eso van
--      a RPCs distintas.
--   2. REENVIADO / REENVIADO MUCHAS VECES: Meta lo dice en
--      context.forwarded / context.frequently_forwarded. Se guarda en la columna
--      nueva `reenviado` (0 = no, 1 = reenviado, 2 = reenviado muchas veces).
--      Importa para el negocio: una foto reenviada suele venir de OTRA clienta.
--   3. MARCAR COMO LEÍDO (los ✓✓ azules al cliente cuando abres el chat): se
--      guarda el wamid del último entrante para poder mandarle el "leído" a Meta.
--      Sin esto el cliente veía su mensaje siempre en gris.
--   4. AUDIO saliente desde el panel (además de foto/video): se habilita el tipo
--      en vl_wa_registrar_saliente_media (antes solo imagen/video/documento).
--
-- Lo que NO se puede (verificado en la API de Meta, para no vender humo):
--   · EDITAR y BORRAR mensajes: Cloud API no avisa de ediciones ni borrados —
--     no existe webhook para eso. No es implementable, no es que falte hacerlo.
--   · "escribiendo…": Cloud API no expone el estado de escritura de nadie.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Marca de "reenviado" en cada mensaje ─────────────────────────────────
ALTER TABLE public.vl_wa_mensajes
    ADD COLUMN IF NOT EXISTS reenviado smallint NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.vl_wa_mensajes.reenviado IS
    'Reenviado por el cliente: 0 = no, 1 = reenviado, 2 = reenviado muchas veces (context.forwarded / frequently_forwarded de Meta).';

-- Índice para pegar la reacción / resolver la cita por wamid dentro del chat.
CREATE INDEX IF NOT EXISTS vl_wa_mensajes_chat_wamid_idx
    ON public.vl_wa_mensajes (chat_id, wa_message_id);

-- ── 2. vl_wa_guardar_meta_wa: ahora también guarda el "reenviado" ───────────
-- Se reemplaza la versión de 9 argumentos (si quedaran las dos, PostgREST podría
-- resolver la vieja y el reenviado se perdería en silencio).
DROP FUNCTION IF EXISTS public.vl_wa_guardar_meta_wa(uuid, text, text, uuid, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.vl_wa_guardar_meta_wa(
    p_tenant_id    uuid,
    p_direction    text,
    p_wa_message_id text,
    p_chat_id      uuid DEFAULT NULL,
    p_wa_id        text DEFAULT NULL,
    p_context_wa_id text DEFAULT NULL,
    p_tipo         text DEFAULT NULL,
    p_texto        text DEFAULT NULL,
    p_media_path   text DEFAULT NULL,
    p_reenviado    smallint DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_dir    text := CASE WHEN lower(btrim(COALESCE(p_direction, ''))) = 'out' THEN 'out' ELSE 'in' END;
    v_chat   uuid := p_chat_id;
    v_wa     text;
    v_wamid  text := NULLIF(btrim(COALESCE(p_wa_message_id, '')), '');
    v_ctx    text := NULLIF(btrim(COALESCE(p_context_wa_id, '')), '');
    v_txt    text := NULLIF(left(btrim(COALESCE(p_texto, '')), 1000), '');
    v_path   text := NULLIF(btrim(COALESCE(p_media_path, '')), '');
    v_reen   smallint := LEAST(GREATEST(COALESCE(p_reenviado, 0), 0), 2);
    v_id     uuid;
BEGIN
    IF p_tenant_id IS NULL OR (v_wamid IS NULL AND v_ctx IS NULL) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Datos insuficientes');
    END IF;

    -- El chat se resuelve por id (salientes del panel) o por número (entrantes).
    IF v_chat IS NULL THEN
        v_wa := regexp_replace(COALESCE(p_wa_id, ''), '\D', '', 'g');
        IF v_wa <> '' THEN
            v_wa := '+' || v_wa;   -- vl_wa_chats.wa_id guarda el '+' adelante
        END IF;
        SELECT c.id INTO v_chat
          FROM public.vl_wa_chats c
         WHERE c.tenant_id = p_tenant_id AND c.wa_id = v_wa
         ORDER BY c.ultimo_en DESC NULLS LAST
         LIMIT 1;
    END IF;

    IF v_chat IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Conversación no encontrada');
    END IF;

    UPDATE public.vl_wa_mensajes m
       SET wa_message_id = COALESCE(v_wamid, m.wa_message_id),
           context_wa_id = COALESCE(v_ctx, m.context_wa_id),
           reenviado     = CASE WHEN v_reen > m.reenviado THEN v_reen ELSE m.reenviado END
     WHERE m.id = (
        SELECT x.id
          FROM public.vl_wa_mensajes x
         WHERE x.chat_id = v_chat
           AND x.direction = v_dir
           AND x.creado_en > now() - interval '15 minutes'
           AND (
                (v_path IS NOT NULL AND x.media_path = v_path)
             OR (v_path IS NULL AND v_txt IS NOT NULL AND x.body = v_txt)
             OR (v_path IS NULL AND v_txt IS NULL AND p_tipo IS NULL)
           )
         ORDER BY x.creado_en DESC, x.id DESC
         LIMIT 1
     )
    RETURNING m.id INTO v_id;

    RETURN jsonb_build_object('ok', v_id IS NOT NULL, 'mensaje_id', v_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_wa_guardar_meta_wa(uuid, text, text, uuid, text, text, text, text, text, smallint)
    FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_guardar_meta_wa(uuid, text, text, uuid, text, text, text, text, text, smallint)
    TO service_role;

-- ── 4. REACCIÓN saliente: el dueño reacciona desde el panel ─────────────────
-- La usa la Edge Function wa-enviar (service_role) cuando el dueño aprieta un
-- emoji sobre una burbuja: dirección 'out' y origen 'humano'. No se expone al
-- navegador a propósito — el panel la pide por wa-enviar, que es quien valida
-- al usuario y quien habla con Meta: así la reacción SOLO queda en el historial
-- cuando WhatsApp la aceptó de verdad.
CREATE OR REPLACE FUNCTION public.vl_wa_reaccion(
    p_tenant_id      uuid,
    p_wa_id          text,
    p_target_wamid   text,
    p_emoji          text,
    p_evento_wamid   text DEFAULT NULL,
    p_direction      text DEFAULT 'in')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_wa     text;
    v_chat   public.vl_wa_chats%ROWTYPE;
    v_target text := NULLIF(btrim(COALESCE(p_target_wamid, '')), '');
    v_emoji  text := btrim(COALESCE(p_emoji, ''));
    v_dir    text := CASE WHEN lower(btrim(COALESCE(p_direction, ''))) = 'out' THEN 'out' ELSE 'in' END;
    v_origen text := CASE WHEN lower(btrim(COALESCE(p_direction, ''))) = 'out' THEN 'humano' ELSE 'bot' END;
    v_msg_id uuid;
BEGIN
    IF p_tenant_id IS NULL OR v_target IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Datos insuficientes');
    END IF;

    v_wa := regexp_replace(COALESCE(p_wa_id, ''), '\D', '', 'g');
    IF v_wa = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'wa_id inválido');
    END IF;
    v_wa := '+' || v_wa;

    SELECT * INTO v_chat
      FROM public.vl_wa_chats
     WHERE tenant_id = p_tenant_id AND wa_id = v_wa
     ORDER BY ultimo_en DESC NULLS LAST
     LIMIT 1;

    IF v_chat.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Conversación no encontrada');
    END IF;

    -- Sacar la reacción previa (de la misma dirección) sobre ese mensaje.
    DELETE FROM public.vl_wa_mensajes m
     WHERE m.chat_id = v_chat.id
       AND m.tipo = 'reaccion'
       AND m.direction = v_dir
       AND m.context_wa_id = v_target;

    IF v_emoji = '' THEN
        -- Emoji vacío = el cliente (o el dueño) QUITÓ su reacción.
        RETURN jsonb_build_object('ok', true, 'quitada', true, 'chat_id', v_chat.id);
    END IF;

    INSERT INTO public.vl_wa_mensajes
        (tenant_id, chat_id, direction, tipo, body, origen, wa_message_id, context_wa_id)
    VALUES
        (p_tenant_id, v_chat.id, v_dir, 'reaccion', left(v_emoji, 16), v_origen,
         NULLIF(btrim(COALESCE(p_evento_wamid, '')), ''), v_target)
    RETURNING id INTO v_msg_id;

    -- El resumen del chat lo muestra como en WhatsApp ("😍 Reaccionó a tu mensaje").
    UPDATE public.vl_wa_chats
       SET ultimo_mensaje = CASE WHEN v_dir = 'out' THEN v_emoji || ' Reaccionaste a su mensaje'
                                 ELSE v_emoji || ' Reaccionó a tu mensaje' END,
           ultimo_en = now()
     WHERE id = v_chat.id;

    RETURN jsonb_build_object('ok', true, 'mensaje_id', v_msg_id, 'chat_id', v_chat.id,
                              'target_wa_id', v_target, 'emoji', v_emoji);
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_wa_reaccion(uuid, text, text, text, text, text)
    FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_reaccion(uuid, text, text, text, text, text) TO service_role;

-- Por si una versión previa alcanzó a crear la reacción saliente expuesta al
-- navegador: se retira (la reacción del dueño pasa por wa-enviar).
DROP FUNCTION IF EXISTS public.vl_wa_reaccion_saliente(uuid, text, text);

-- ── 5. Último entrante con wamid (para mandarle el "leído" a Meta) ──────────
-- Meta solo acepta marcar como leído un mensaje QUE NOS LLEGÓ, y por su wamid.
CREATE OR REPLACE FUNCTION public.vl_wa_ultimo_entrante(p_chat_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_wamid text;
BEGIN
    SELECT m.wa_message_id INTO v_wamid
      FROM public.vl_wa_mensajes m
     WHERE m.chat_id = p_chat_id
       AND m.direction = 'in'
       AND m.wa_message_id IS NOT NULL
       AND m.tipo <> 'reaccion'
     ORDER BY m.creado_en DESC, m.id DESC
     LIMIT 1;

    RETURN jsonb_build_object('ok', v_wamid IS NOT NULL, 'wamid', v_wamid);
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_wa_ultimo_entrante(uuid) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_ultimo_entrante(uuid) TO service_role;

-- ── 6. AUDIO saliente desde el panel (antes solo imagen/video/documento) ────
CREATE OR REPLACE FUNCTION public.vl_wa_registrar_saliente_media(
    p_chat_id uuid,
    p_texto text,
    p_tipo text,
    p_media_path text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_chat     public.vl_wa_chats%ROWTYPE;
    v_txt      text;
    v_tipo     text;
    v_path     text;
    v_resumen  text;
    v_msg_id   uuid;
    v_creado   timestamptz;
BEGIN
    SELECT * INTO v_chat FROM public.vl_wa_chats WHERE id = p_chat_id;
    IF v_chat.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Conversación no encontrada');
    END IF;

    v_tipo := lower(btrim(COALESCE(p_tipo, '')));
    IF v_tipo NOT IN ('imagen', 'video', 'documento', 'audio') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Tipo de archivo no soportado');
    END IF;

    -- El archivo tiene que estar en la carpeta del negocio de ESTA conversación.
    v_path := btrim(COALESCE(p_media_path, ''));
    IF v_path = ''
       OR left(v_path, length(v_chat.tenant_id::text) + 1) <> v_chat.tenant_id::text || '/' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El archivo no es de este negocio');
    END IF;

    v_txt := btrim(COALESCE(p_texto, ''));
    v_resumen := CASE
        WHEN v_txt <> '' THEN v_txt
        WHEN v_tipo = 'imagen' THEN '📷 Foto'
        WHEN v_tipo = 'video' THEN '🎬 Video'
        WHEN v_tipo = 'audio' THEN '🎤 Audio'
        ELSE '📎 Archivo'
    END;

    INSERT INTO public.vl_wa_mensajes
        (tenant_id, chat_id, direction, tipo, body, origen, media_path)
    VALUES
        (v_chat.tenant_id, v_chat.id, 'out', v_tipo,
         left(v_txt, 1000), 'humano', v_path)
    RETURNING id, creado_en INTO v_msg_id, v_creado;

    UPDATE public.vl_wa_chats
       SET ultimo_mensaje = left(v_resumen, 200),
           ultimo_en = now(),
           leido_en = now()
     WHERE id = v_chat.id;

    -- El humano ya respondió: los avisos abiertos de este chat quedan cerrados
    UPDATE public.vl_wa_avisos
       SET resuelto_en = now()
     WHERE chat_id = v_chat.id AND resuelto_en IS NULL;

    RETURN jsonb_build_object(
        'ok', true,
        'mensaje_id', v_msg_id,
        'creado_en', v_creado,
        'body', v_resumen,
        'media_path', v_path
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_wa_registrar_saliente_media(uuid, text, text, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_registrar_saliente_media(uuid, text, text, text) TO authenticated;

-- ── 7. El hilo ahora también devuelve el "reenviado" ────────────────────────
CREATE OR REPLACE FUNCTION public.vl_wa_chat_hilo(p_chat_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_chat public.vl_wa_chats%ROWTYPE;
    v_cli public.vl_clientes%ROWTYPE;
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
        SELECT * INTO v_cli FROM public.vl_clientes WHERE id = v_chat.cliente_id;
    END IF;

    UPDATE public.vl_wa_chats SET leido_en = now() WHERE id = v_chat.id;

    RETURN jsonb_build_object(
        'ok', true,
        'chat', jsonb_build_object(
            'id', v_chat.id,
            'wa_id', v_chat.wa_id,
            'estado', v_chat.estado,
            'modo', v_chat.modo,
            'cliente_id', v_chat.cliente_id,
            'tiktok_user', COALESCE(v_cli.tiktok_user, ''),
            'nombre_real', COALESCE(v_cli.nombre_real, ''),
            'categoria', COALESCE(v_cli.categoria, 'nuevo')
        ),
        'mensajes', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', m.id,
                'direction', m.direction,
                'origen', m.origen,
                'tipo', m.tipo,
                'body', m.body,
                'media_path', m.media_path,
                'creado_en', m.creado_en,
                'wa_message_id', m.wa_message_id,
                'context_wa_id', m.context_wa_id,
                'reenviado', COALESCE(m.reenviado, 0),
                -- La cita resuelta: a qué mensaje responde ÉSTE.
                'cita', CASE WHEN m.context_wa_id IS NULL THEN NULL ELSE (
                    SELECT jsonb_build_object(
                        'id', q.id,
                        'direction', q.direction,
                        'origen', q.origen,
                        'tipo', q.tipo,
                        'body', q.body,
                        'media_path', q.media_path
                    )
                    FROM public.vl_wa_mensajes q
                    WHERE q.chat_id = m.chat_id
                      AND q.wa_message_id = m.context_wa_id
                    ORDER BY q.creado_en DESC
                    LIMIT 1
                ) END
            ) ORDER BY m.creado_en, m.id)
            FROM public.vl_wa_mensajes m
            WHERE m.chat_id = v_chat.id
        ), '[]'::jsonb)
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_wa_chat_hilo(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_chat_hilo(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] paridad WhatsApp: reacciones + reenviado + leído + audio (20261090) OK' AS status;
