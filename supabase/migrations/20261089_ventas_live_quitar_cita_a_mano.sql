-- ════════════════════════════════════════════════════════════════════════════
-- [VENTAS LIVE] (20261089) SE ELIMINA "ELEGIR CUÁL" (cita a mano)
--
-- Pedido del dueño, textual: "ese es el problema, no sé a qué se refiere el
-- cliente, así que borra eso". El botón "Elegir cuál" y la lista de candidatas no
-- le sirven: si el cliente citó un mensaje que WhatsApp no nos supo identificar, lo
-- que necesita es saber cuál era — y eso solo lo sabe el cliente, no una lista.
--
-- Lo que QUEDA (y es lo que importa):
--   * La cita EXACTA: cuando WhatsApp manda la referencia y el mensaje citado está
--     registrado, el panel muestra la foto/texto citado con su autor (como WhatsApp).
--   * Un aviso discreto cuando el mensaje citado es anterior al sistema, para que se
--     sepa que el cliente respondió A ALGO (y conviene preguntarle). Sin botones.
--
-- Se van: la columna cita_manual_de, las RPC vl_wa_cita_candidatas /
-- vl_wa_cita_vincular, y la resolución "a mano" dentro del hilo.
-- ════════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.vl_wa_cita_candidatas(uuid, int);
DROP FUNCTION IF EXISTS public.vl_wa_cita_vincular(uuid, uuid);

ALTER TABLE public.vl_wa_mensajes DROP COLUMN IF EXISTS cita_manual_de;

-- ── El hilo: la cita se resuelve SOLO con la referencia real de WhatsApp ────
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
                -- La cita REAL: el mensaje que WhatsApp dice que se citó.
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
                ) END,
                -- Citó algo y no está en el historial: se avisa (sin botones).
                'cita_sin_resolver', (m.context_wa_id IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM public.vl_wa_mensajes q2
                     WHERE q2.chat_id = m.chat_id
                       AND q2.wa_message_id = m.context_wa_id))
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

SELECT '[VENTAS LIVE] cita a mano eliminada (20261089) OK' AS status;
