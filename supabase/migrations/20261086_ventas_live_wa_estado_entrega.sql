-- ════════════════════════════════════════════════════════════════════════════
-- [VENTAS LIVE] (20261086) TICKS DEL CHAT: enviado / entregado / leído / falló
--
-- WhatsApp avisa por webhook (campo `statuses`) qué pasó con cada mensaje que
-- NOSOTROS mandamos: `sent` (salió), `delivered` (llegó al teléfono del cliente),
-- `read` (lo abrió) y `failed` (no salió, con el motivo). Hasta ahora el webhook
-- ignoraba ese campo explícitamente ("statuses/eco: ignorar"), así que el panel
-- no podía mostrar los ✓✓ ni avisar de un envío fallido.
--
-- Ahora: se guarda el estado en el propio mensaje y el hilo lo devuelve para que
-- el panel pinte los ticks. El estado se cruza por wamid (migración 20261085).
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.vl_wa_mensajes
    ADD COLUMN IF NOT EXISTS estado_wa text,
    ADD COLUMN IF NOT EXISTS error_wa  text;

COMMENT ON COLUMN public.vl_wa_mensajes.estado_wa IS
    'Estado de entrega de un mensaje SALIENTE: enviado | entregado | leido | fallido.';
COMMENT ON COLUMN public.vl_wa_mensajes.error_wa IS
    'Motivo del fallo (solo si estado_wa = fallido). Lo manda Meta.';

-- ── El webhook avisa el estado y acá se pega al mensaje (por wamid) ─────────
CREATE OR REPLACE FUNCTION public.vl_wa_actualizar_estado(
    p_tenant_id     uuid,
    p_wa_message_id text,
    p_estado        text,
    p_error         text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_wamid  text := NULLIF(btrim(COALESCE(p_wa_message_id, '')), '');
    v_estado text := NULLIF(lower(btrim(COALESCE(p_estado, ''))), '');
    v_id     uuid;
BEGIN
    IF p_tenant_id IS NULL OR v_wamid IS NULL OR v_estado IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Datos insuficientes');
    END IF;
    IF v_estado NOT IN ('enviado', 'entregado', 'leido', 'fallido') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Estado no soportado');
    END IF;

    UPDATE public.vl_wa_mensajes m
       SET estado_wa = v_estado,
           error_wa = CASE WHEN v_estado = 'fallido'
                           THEN left(NULLIF(btrim(COALESCE(p_error, '')), ''), 500)
                           ELSE NULL END
     WHERE m.tenant_id = p_tenant_id
       AND m.wa_message_id = v_wamid
       AND m.direction = 'out'
    RETURNING m.id INTO v_id;

    RETURN jsonb_build_object('ok', v_id IS NOT NULL, 'mensaje_id', v_id, 'estado', v_estado);
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_wa_actualizar_estado(uuid, text, text, text)
    FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_actualizar_estado(uuid, text, text, text)
    TO service_role;

-- ── El hilo devuelve también el estado de entrega ───────────────────────────
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

SELECT '[VENTAS LIVE] ticks del chat (20261086) OK' AS status;
