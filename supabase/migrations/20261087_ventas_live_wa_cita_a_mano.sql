-- ════════════════════════════════════════════════════════════════════════════
-- [VENTAS LIVE] (20261087) CITA SIN RESOLVER: elegir a mano a qué responde
--
-- CASO REAL (14-10 13:18, chat de 56996134047): el cliente escribió "Quiero esa"
-- respondiendo (citando) una FOTO que el negocio le había mandado ANTES de la
-- migración 20261085, o sea SIN wamid guardado. El webhook SÍ capturó la cita
-- (context_wa_id), pero no hay fila con ese wamid → el panel solo podía decir
-- "responde a un mensaje anterior" y el dueño no sabía QUÉ imagen era.
--
-- Esto pasa con todo mensaje anterior al 14-10 y seguirá pasando un tiempo: no
-- se puede recuperar el wamid de lo ya enviado. Lo que SÍ se puede: mostrarle al
-- dueño las últimas fotos/mensajes de ESA conversación para que elija cuál era,
-- y guardar la elección (cita_manual_de) — mismo patrón que el "¿Quién es?".
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.vl_wa_mensajes
    ADD COLUMN IF NOT EXISTS cita_manual_de uuid
        REFERENCES public.vl_wa_mensajes(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.vl_wa_mensajes.cita_manual_de IS
    'A qué mensaje responde ESTE, elegido A MANO por el dueño (cuando la cita de WhatsApp no se pudo resolver por wamid).';

-- ── Candidatas: los mensajes de la misma conversación anteriores a la cita ──
CREATE OR REPLACE FUNCTION public.vl_wa_cita_candidatas(
    p_mensaje_id uuid,
    p_limite     int DEFAULT 8)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_base   public.vl_wa_mensajes%ROWTYPE;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    SELECT * INTO v_base
      FROM public.vl_wa_mensajes
     WHERE id = p_mensaje_id AND tenant_id = v_tenant;
    IF v_base.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Mensaje no encontrado');
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'mensaje_id', v_base.id,
        'candidatas', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', x.id,
                'direction', x.direction,
                'origen', x.origen,
                'tipo', x.tipo,
                'body', x.body,
                'media_path', x.media_path,
                'creado_en', x.creado_en,
                -- La más probable: la primera FOTO anterior a la respuesta (es lo
                -- que el cliente suele estar citando con un "quiero esa").
                'probable', (x.tipo IN ('imagen', 'sticker')
                             AND x.creado_en = (SELECT max(y.creado_en)
                                                  FROM public.vl_wa_mensajes y
                                                 WHERE y.chat_id = v_base.chat_id
                                                   AND y.tipo IN ('imagen', 'sticker')
                                                   AND y.creado_en < v_base.creado_en))
            ) ORDER BY x.creado_en DESC, x.id DESC)
            FROM (
                SELECT m.id, m.direction, m.origen, m.tipo, m.body, m.media_path, m.creado_en
                  FROM public.vl_wa_mensajes m
                 WHERE m.chat_id = v_base.chat_id
                   AND m.id <> v_base.id
                   -- ESTRICTO: la respuesta del bot se inserta en la MISMA
                   -- transacción y comparte `creado_en` con el entrante; con <=
                   -- aparecía como candidata (falso positivo).
                   AND m.creado_en < v_base.creado_en
                 ORDER BY m.creado_en DESC, m.id DESC
                 LIMIT GREATEST(1, LEAST(COALESCE(p_limite, 8), 20))
            ) x
        ), '[]'::jsonb)
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_wa_cita_candidatas(uuid, int) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_cita_candidatas(uuid, int) TO authenticated;

-- ── Guardar la elección ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.vl_wa_cita_vincular(
    p_mensaje_id uuid,
    p_citado_id  uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_msg    public.vl_wa_mensajes%ROWTYPE;
    v_cit    public.vl_wa_mensajes%ROWTYPE;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;
    IF p_mensaje_id IS NULL OR p_citado_id IS NULL OR p_mensaje_id = p_citado_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Datos inválidos');
    END IF;

    SELECT * INTO v_msg FROM public.vl_wa_mensajes
     WHERE id = p_mensaje_id AND tenant_id = v_tenant;
    SELECT * INTO v_cit FROM public.vl_wa_mensajes
     WHERE id = p_citado_id AND tenant_id = v_tenant;

    IF v_msg.id IS NULL OR v_cit.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Mensaje no encontrado');
    END IF;
    -- Solo tiene sentido citar un mensaje de LA MISMA conversación anterior.
    IF v_cit.chat_id <> v_msg.chat_id OR v_cit.creado_en > v_msg.creado_en THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Ese mensaje no es de esta conversación (o es posterior)');
    END IF;

    UPDATE public.vl_wa_mensajes
       SET cita_manual_de = p_citado_id
     WHERE id = p_mensaje_id;

    RETURN jsonb_build_object('ok', true, 'mensaje_id', p_mensaje_id, 'citado_id', p_citado_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_wa_cita_vincular(uuid, uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_cita_vincular(uuid, uuid) TO authenticated;

-- ── El hilo resuelve la cita por wamid O por la elección a mano ─────────────
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
                'estado_wa', m.estado_wa,
                'error_wa', m.error_wa,
                -- La cita: por wamid (normal) o la elegida a mano por el dueño.
                'cita', CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object(
                    'id', c.id,
                    'direction', c.direction,
                    'origen', c.origen,
                    'tipo', c.tipo,
                    'body', c.body,
                    'media_path', c.media_path,
                    'manual', c.manual
                ) END,
                -- Citó algo que WhatsApp nos dijo pero no tenemos: se puede elegir a mano.
                'cita_sin_resolver', (m.context_wa_id IS NOT NULL AND c.id IS NULL)
            ) ORDER BY m.creado_en, m.id)
            FROM public.vl_wa_mensajes m
            LEFT JOIN LATERAL (
                SELECT q.id, q.direction, q.origen, q.tipo, q.body, q.media_path,
                       (q.id = m.cita_manual_de) AS manual
                  FROM public.vl_wa_mensajes q
                 WHERE q.chat_id = m.chat_id
                   AND ((m.context_wa_id IS NOT NULL AND q.wa_message_id = m.context_wa_id)
                     OR (m.cita_manual_de IS NOT NULL AND q.id = m.cita_manual_de))
                 ORDER BY (q.id = m.cita_manual_de) DESC, q.creado_en DESC
                 LIMIT 1
            ) c ON TRUE
            WHERE m.chat_id = v_chat.id
        ), '[]'::jsonb)
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_wa_chat_hilo(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_chat_hilo(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] cita sin resolver / elegir a mano (20261087) OK' AS status;
