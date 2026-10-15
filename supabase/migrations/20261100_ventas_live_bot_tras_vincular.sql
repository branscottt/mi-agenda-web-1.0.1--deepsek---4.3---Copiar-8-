-- ════════════════════════════════════════════════════════════════════════════
-- [VENTAS LIVE] (20261100) EL BOT SIGUE LA VENTA CUANDO EL USUARIO SE ASIGNA A MANO
--
-- PROBLEMA (caso real 2026-10-15 20:37, chat @bran / +569****4047):
--   El cliente escribió, el bot no lo reconoció y quedó el aviso "no se encontró
--   ningún usuario". El dueño entró a "¿Quién es?" y asignó la ficha A MANO
--   (@bran). La vinculación quedó bien (se guardó su número en la ficha), PERO
--   EL BOT NO DIJO NADA: el cliente nunca supo su total ni recibió los datos de
--   pago, aunque tenía una prenda ADJUDICADA pendiente de pago.
--
--   Causa: `vl_wa_vincular_chat` (20261074) solo ESCRIBE la vinculación y cierra
--   los avisos de identificación. El bot es un flujo de mensajes: su mensaje de
--   "ya te reconocí, serían $X, acá van mis datitos" lo arma
--   `vl_wa_procesar_cliente_identificado` cuando el CLIENTE escribe su @ y el bot
--   lo encuentra. Si la identificación la hace una PERSONA desde el panel, ese
--   paso nunca corre y la venta se queda muda en el momento más importante
--   (el cliente sabe sus datos y paga).
--
-- SOLUCIÓN (pedido del dueño: "aunque sea manual, si reconocemos datos, el bot
--   siga con el procedimiento de venta"):
--   1. `vl_wa_bot_tras_vincular(chat_id)`: RPC nueva que reusa EXACTAMENTE la
--      misma función del bot (`vl_wa_procesar_cliente_identificado`) y devuelve
--      el mensaje que el bot mandaría. El panel lo envía por `wa-enviar`.
--      · Silencio (enviar=false) si: el dueño tomó el control (modo humano),
--        no hay pedido abierto, no queda nada por pagar, o el pedido ya está
--        avanzado más allá de la identificación. Nunca inventa: o manda el
--        total + datitos, o calla.
--   2. `vl_wa_registrar_saliente` acepta `p_origen`: el mensaje que sigue la
--      venta queda registrado como 'bot' (no como 'humano'). Si quedara como
--      'humano', el bot cedería el turno 15 min y — si el cliente respondía
--      "quiero envío" — el bot volvía a quedarse mudo.
--      OJO: al agregar un parámetro con DEFAULT hay que BORRAR la firma vieja
--      (lección de la 20261094: PostgREST no elige entre dos candidatas con
--      defaults → PGRST203 y TODA llamada falla).
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. El bot continúa la venta tras una vinculación a mano ─────────────────
CREATE OR REPLACE FUNCTION public.vl_wa_bot_tras_vincular(p_chat_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_chat   public.vl_wa_chats%ROWTYPE;
    v_proc   public.vl_procesos%ROWTYPE;
    v_saldo  numeric := 0;
    v_res    jsonb;
    v_msg    text := '';
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
    IF v_chat.cliente_id IS NULL THEN
        RETURN jsonb_build_object('ok', true, 'enviar', false, 'motivo', 'sin_cliente');
    END IF;

    -- Atiende una persona (bot en pausa): el bot NO se encima.
    IF COALESCE(v_chat.modo, 'bot') = 'humano' THEN
        RETURN jsonb_build_object('ok', true, 'enviar', false, 'motivo', 'modo_humano');
    END IF;

    SELECT * INTO v_proc
      FROM public.vl_procesos
     WHERE cliente_id = v_chat.cliente_id AND cerrado_en IS NULL
     ORDER BY creado_en DESC
     LIMIT 1;
    IF v_proc.id IS NULL THEN
        RETURN jsonb_build_object('ok', true, 'enviar', false, 'motivo', 'sin_pedido');
    END IF;

    -- Solo tiene sentido "seguir la venta" si queda algo por pagar.
    SELECT COALESCE(SUM(precio - abonado) FILTER (WHERE estado = 'adjudicada'), 0)
      INTO v_saldo
      FROM public.vl_items
     WHERE proceso_id = v_proc.id;
    IF v_saldo <= 0 THEN
        RETURN jsonb_build_object('ok', true, 'enviar', false, 'motivo', 'nada_pendiente');
    END IF;

    -- Estados que la identificación sabe resolver (total + datitos, o la frase
    -- puntual de pago parcial / pagará al verse).
    IF v_proc.estado NOT IN ('esperando_whatsapp', 'identificando_cliente',
                             'pago_parcial', 'pagara_presencial') THEN
        RETURN jsonb_build_object('ok', true, 'enviar', false, 'motivo', 'pedido_avanzado');
    END IF;

    -- La MISMA función que usa el bot cuando reconoce al cliente solo:
    -- "holis serian $X me avisa si va a querer envio o entrega presencial…
    --  aca le dejo mis datitos" + los datos de transferencia.
    v_res := public.vl_wa_procesar_cliente_identificado(
                 v_tenant, v_chat.id, v_chat.cliente_id, v_chat.wa_id);
    v_msg := COALESCE(v_res->>'mensaje', '');

    RETURN jsonb_build_object(
        'ok', true,
        'enviar', btrim(v_msg) <> '',
        'mensaje', v_msg,
        'estado_chat', COALESCE(v_res->>'estado', ''),
        'motivo', CASE WHEN btrim(v_msg) = '' THEN 'sin_mensaje' ELSE 'ok' END
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_wa_bot_tras_vincular(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_bot_tras_vincular(uuid) TO authenticated;

-- ── 2. Saliente de TEXTO: el origen se puede declarar ('humano' | 'bot') ────
-- Se borra la firma vieja ANTES de crear la nueva (evita el overload ambiguo
-- que rompió todos los envíos en la 20261093/20261094).
DROP FUNCTION IF EXISTS public.vl_wa_registrar_saliente(uuid, text, text, text);

CREATE OR REPLACE FUNCTION public.vl_wa_registrar_saliente(
    p_chat_id uuid,
    p_texto text,
    p_wamid text DEFAULT NULL,
    p_contexto_wa_id text DEFAULT NULL,
    p_origen text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_chat public.vl_wa_chats%ROWTYPE;
    v_txt text;
    v_msg_id uuid;
    v_creado timestamptz;
    v_wamid text := NULLIF(btrim(COALESCE(p_wamid, '')), '');
    v_ctx   text := NULLIF(btrim(COALESCE(p_contexto_wa_id, '')), '');
    -- Por defecto 'humano' (es el envío desde el panel). El bot puede declarar
    -- 'bot' cuando el mensaje lo escribió él (seguir la venta tras vincular).
    v_origen text := CASE WHEN lower(btrim(COALESCE(p_origen, ''))) = 'bot'
                          THEN 'bot' ELSE 'humano' END;
BEGIN
    SELECT * INTO v_chat FROM public.vl_wa_chats WHERE id = p_chat_id;
    IF v_chat.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Conversación no encontrada');
    END IF;
    v_txt := btrim(COALESCE(p_texto, ''));
    IF v_txt = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Mensaje vacío');
    END IF;
    INSERT INTO public.vl_wa_mensajes
        (tenant_id, chat_id, direction, tipo, body, origen, wa_message_id, context_wa_id, estado_wa)
    VALUES
        (v_chat.tenant_id, v_chat.id, 'out', 'texto', left(v_txt, 1000), v_origen,
         v_wamid, v_ctx, CASE WHEN v_wamid IS NULL THEN NULL ELSE 'enviado' END)
    RETURNING id, creado_en INTO v_msg_id, v_creado;
    UPDATE public.vl_wa_chats
    SET ultimo_mensaje = left(v_txt, 200),
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
        'body', left(v_txt, 1000),
        'origen', v_origen,
        'wa_message_id', v_wamid
    );
END;
$function$;

-- Solo service_role: la llama la Edge Function wa-enviar con service_role (que ya
-- autorizó al usuario). NO se le da a `authenticated`: la función no valida el
-- dueño del chat (confía en el llamador), así que un usuario logueado podría
-- escribir en la conversación de otro negocio si la pudiera llamar directo.
REVOKE ALL ON FUNCTION public.vl_wa_registrar_saliente(uuid, text, text, text, text) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_registrar_saliente(uuid, text, text, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] el bot sigue la venta al asignar el usuario a mano (20261100) OK' AS status;
