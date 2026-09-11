-- ============================================================
-- MIGRACIÓN 20261025: Ventas Live — origen de cada mensaje saliente
-- Fecha: 2026-10-11
--
-- OBJETIVO: en la vista Chats distinguir si un mensaje saliente lo
-- respondió el BOT o una persona, para saber de un vistazo si ya se
-- contestó y quién habló.
--
--   * vl_wa_mensajes.origen ('bot' | 'humano'), default 'bot' (el
--     cerebro del bot inserta sin especificar → 'bot').
--   * vl_wa_registrar_saliente marca 'humano' (envío desde el panel).
--   * vl_wa_chat_hilo devuelve el origen de cada mensaje.
-- ============================================================

ALTER TABLE public.vl_wa_mensajes
    ADD COLUMN IF NOT EXISTS origen text NOT NULL DEFAULT 'bot'
        CHECK (origen IN ('bot', 'humano'));

-- Envío manual desde el panel (Edge Function wa-enviar): origen 'humano'.
CREATE OR REPLACE FUNCTION public.vl_wa_registrar_saliente(p_chat_id uuid, p_texto text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_chat public.vl_wa_chats%ROWTYPE;
    v_txt text;
    v_msg_id uuid;
    v_creado timestamptz;
BEGIN
    SELECT * INTO v_chat FROM public.vl_wa_chats WHERE id = p_chat_id;
    IF v_chat.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Conversación no encontrada');
    END IF;

    v_txt := btrim(COALESCE(p_texto, ''));
    IF v_txt = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Mensaje vacío');
    END IF;

    INSERT INTO public.vl_wa_mensajes (tenant_id, chat_id, direction, tipo, body, origen)
    VALUES (v_chat.tenant_id, v_chat.id, 'out', 'texto', left(v_txt, 1000), 'humano')
    RETURNING id, creado_en INTO v_msg_id, v_creado;

    UPDATE public.vl_wa_chats
    SET ultimo_mensaje = left(v_txt, 200),
        ultimo_en = now(),
        leido_en = now()
    WHERE id = v_chat.id;

    RETURN jsonb_build_object(
        'ok', true,
        'mensaje_id', v_msg_id,
        'creado_en', v_creado,
        'body', left(v_txt, 1000)
    );
END;
$$;

-- Hilo con el origen de cada mensaje.
CREATE OR REPLACE FUNCTION public.vl_wa_chat_hilo(p_chat_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
                'creado_en', m.creado_en
            ) ORDER BY m.creado_en)
            FROM public.vl_wa_mensajes m
            WHERE m.chat_id = v_chat.id
        ), '[]'::jsonb)
    );
END;
$$;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] Origen de mensajes (bot/humano) OK' AS status;
