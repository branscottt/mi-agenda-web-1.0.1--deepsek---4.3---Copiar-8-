-- ════════════════════════════════════════════════════════════════════════════
-- [VENTAS LIVE] (20261085) CITAS DEL CHAT: "responder a" (reply de WhatsApp)
--
-- PROBLEMA REAL (chat de jolumaaf, 14-10):
--   El cliente respondió CITANDO una foto y escribió "Siii este es el que quiero".
--   En el panel no se veía QUÉ imagen había citado, y el bot liquidó igual el
--   total del pedido. WhatsApp manda esa referencia en `message.context.id`
--   (el wamid del mensaje citado) y el webhook la DESCARTABA: no existía dónde
--   guardarla ni cómo resolverla (tampoco guardábamos el wamid de lo que
--   mandamos nosotros, así que no había contra qué cruzar).
--
-- QUÉ HACE ESTA MIGRACIÓN
--   1. Guarda los identificadores de WhatsApp en cada mensaje:
--        wa_message_id  → el wamid de ESE mensaje (entrante o saliente)
--        context_wa_id  → el wamid del mensaje que SE ESTÁ CITANDO (si citó uno)
--   2. vl_wa_guardar_meta_wa(...): el webhook / la Edge wa-enviar avisan el
--      wamid (y la cita) DESPUÉS de que el mensaje quedó registrado, y esta
--      función lo pega en la fila correcta.
--   3. vl_wa_registrar_entrante_crudo(...): los mensajes que el cerebro NO
--      entiende (reacción 👍, ubicación, contacto, respuesta de botón…) se
--      guardan para que se VEAN en el panel, sin correr el bot y sin disparar
--      avisos. Antes caían en `default: 'texto'` y entraban al cerebro como
--      mensaje VACÍO (ensuciaban el estado y los avisos).
--   4. vl_wa_chat_hilo(...) devuelve, por mensaje, la CITA ya RESUELTA
--      (autor, tipo, texto, media_path) para que el panel muestre
--      "Respondiendo a: …" igual que WhatsApp.
--
-- El envío real NO cambia: esto es solo trazabilidad + vista.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Identificadores de WhatsApp en el mensaje ────────────────────────────
ALTER TABLE public.vl_wa_mensajes
    ADD COLUMN IF NOT EXISTS wa_message_id text,
    ADD COLUMN IF NOT EXISTS context_wa_id text;

COMMENT ON COLUMN public.vl_wa_mensajes.wa_message_id IS
    'wamid de Meta (id único del mensaje en WhatsApp). Permite resolver citas.';
COMMENT ON COLUMN public.vl_wa_mensajes.context_wa_id IS
    'wamid del mensaje CITADO por este (message.context.id del webhook).';

-- Para resolver "citó X" contra el mensaje citado.
CREATE INDEX IF NOT EXISTS idx_vl_wa_mensajes_wamid
    ON public.vl_wa_mensajes (tenant_id, wa_message_id)
    WHERE wa_message_id IS NOT NULL;

-- ── 2. Pegar el wamid / la cita al mensaje ya registrado ────────────────────
-- Se llama SIEMPRE después de que el mensaje quedó insertado:
--   * entrante → después del cerebro (que es quien inserta el 'in')
--   * saliente → después de enviar por Graph API
-- Identifica la fila por el archivo (media_path) o por el texto exacto que se
-- registró, dentro de la misma conversación y de los últimos 15 minutos: así
-- dos mensajes simultáneos del mismo cliente no se pisan.
CREATE OR REPLACE FUNCTION public.vl_wa_guardar_meta_wa(
    p_tenant_id    uuid,
    p_direction    text,
    p_wa_message_id text,
    p_chat_id      uuid DEFAULT NULL,
    p_wa_id        text DEFAULT NULL,
    p_context_wa_id text DEFAULT NULL,
    p_tipo         text DEFAULT NULL,
    p_texto        text DEFAULT NULL,
    p_media_path   text DEFAULT NULL)
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
           context_wa_id = COALESCE(v_ctx, m.context_wa_id)
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

REVOKE ALL ON FUNCTION public.vl_wa_guardar_meta_wa(uuid, text, text, uuid, text, text, text, text, text)
    FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_guardar_meta_wa(uuid, text, text, uuid, text, text, text, text, text)
    TO service_role;

-- ── 3. Mensajes que el cerebro NO entiende: guardar y NO despertar al bot ───
-- Reacción, ubicación, contacto, respuesta de botón, pedido de catálogo, aviso
-- del sistema. Se ven en el panel (burbuja con su tipo) pero no corren la
-- máquina de estados ni generan avisos al negocio.
CREATE OR REPLACE FUNCTION public.vl_wa_registrar_entrante_crudo(
    p_tenant_id     uuid,
    p_wa_id         text,
    p_tipo          text,
    p_texto         text DEFAULT NULL,
    p_wa_message_id text DEFAULT NULL,
    p_context_wa_id text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_wa     text;
    v_chat   public.vl_wa_chats%ROWTYPE;
    v_tipo   text;
    v_txt    text;
    v_msg_id uuid;
BEGIN
    IF p_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Tenant inválido');
    END IF;

    v_wa := regexp_replace(COALESCE(p_wa_id, ''), '\D', '', 'g');
    IF v_wa = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'wa_id inválido');
    END IF;
    v_wa := '+' || v_wa;

    v_tipo := NULLIF(lower(btrim(COALESCE(p_tipo, ''))), '');
    IF v_tipo IS NULL THEN
        v_tipo := 'otro';
    END IF;
    v_txt := left(btrim(COALESCE(p_texto, '')), 1000);

    INSERT INTO public.vl_wa_chats (tenant_id, wa_id)
    VALUES (p_tenant_id, v_wa)
    ON CONFLICT (tenant_id, wa_id) DO NOTHING;

    SELECT * INTO v_chat
      FROM public.vl_wa_chats
     WHERE tenant_id = p_tenant_id AND wa_id = v_wa
     FOR UPDATE;

    INSERT INTO public.vl_wa_mensajes
        (tenant_id, chat_id, direction, tipo, body, media_path, wa_message_id, context_wa_id)
    VALUES
        -- body es NOT NULL con default '': se guarda '' (nunca NULL), igual que
        -- hace el cerebro con left(v_txt, 1000).
        (p_tenant_id, v_chat.id, 'in', v_tipo, left(v_txt, 1000), NULL,
         NULLIF(btrim(COALESCE(p_wa_message_id, '')), ''),
         NULLIF(btrim(COALESCE(p_context_wa_id, '')), ''))
    RETURNING id INTO v_msg_id;

    UPDATE public.vl_wa_chats
       SET ultimo_mensaje = CASE WHEN v_txt <> '' THEN left(v_txt, 200)
                                 ELSE '[' || v_tipo || ']' END,
           ultimo_en = now()
     WHERE id = v_chat.id;

    RETURN jsonb_build_object('ok', true, 'mensaje_id', v_msg_id, 'chat_id', v_chat.id);
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_wa_registrar_entrante_crudo(uuid, text, text, text, text, text)
    FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_registrar_entrante_crudo(uuid, text, text, text, text, text)
    TO service_role;

-- ── 3-bis. BUG que salió al probar: mandar una FOTO SIN COMENTARIO rompía ────
-- vl_wa_registrar_saliente_media insertaba body = NULLIF(left(v_txt,1000),''),
-- pero `body` es NOT NULL con default ''. Resultado: la foto SÍ se enviaba por
-- WhatsApp y DESPUÉS fallaba el registro → el panel decía "Se envió, pero no se
-- pudo guardar" y la burbuja no quedaba en el historial. Se alinea con el
-- cerebro (left(v_txt,1000) = '' cuando no hay comentario).
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
    IF v_tipo NOT IN ('imagen', 'video', 'documento') THEN
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
        ELSE '📎 Archivo'
    END;

    INSERT INTO public.vl_wa_mensajes
        (tenant_id, chat_id, direction, tipo, body, origen, media_path)
    VALUES
        (v_chat.tenant_id, v_chat.id, 'out', v_tipo,
         left(v_txt, 1000), 'humano', v_path)   -- '' si no hay comentario (no NULL)
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

-- ── 4. El hilo devuelve la CITA ya resuelta ─────────────────────────────────
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

SELECT '[VENTAS LIVE] citas del chat / wamid (20261085) OK' AS status;
