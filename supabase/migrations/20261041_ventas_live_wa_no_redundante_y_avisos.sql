-- 20261041_ventas_live_wa_no_redundante_y_avisos.sql
-- Ventas Live · WhatsApp · CONVERSACIÓN REAL (chat de "Anubis" que mandó el dueño)
--
-- Lo que pidió el dueño, textual:
--   * "la gente habla por tramos… dice hola y después soy anubis y la idea es que el
--     bot no le diga 'danos el nombre de usuario' ya te dijo anubis, entonces debería
--     buscar más que nada… no ser redundante ni tedioso"
--   * "danos un aviso cuando ocurran cosas que no sabes responder, para no simplemente
--     dejar sin responder… y dime que no entendiste para responder"
--   * "avísanos siempre que no sepas qué responder o si mandó captura y no sabes si es
--     una prenda o comprobante… la idea es poder solucionar como lo hizo Roxana:
--     escuchando, respondiendo sin redundancia y comprendiendo… no quedarse solo con
--     una frase que manden porque escriben a tramos a veces"
--
-- Cambios (todos sobre el cerebro + el matcher; sin cambios de esquema):
--   1. MATCHER: segundo intento con los últimos 3 mensajes del cliente juntos, y
--      también compara contra `vl_clientes.nombre_real` (siempre como "parecido" →
--      pide confirmación). "Buscar más" antes de volver a preguntar.
--   2. DATOS DE ENVÍO: se ACUMULAN (antes cada mensaje corto pisaba el anterior y se
--      perdía todo: "Mis datos" borraba "Juan Pérez"). El courier suelto ("por blue
--      por favor") ya no gasta el mensaje de los datos.
--   3. NO REDUNDANCIA: si el bot iba a mandar EXACTAMENTE el mismo texto que ya mandó,
--      se calla y avisa al negocio en su lugar.
--   4. AVISO SIEMPRE QUE NO SEPA QUÉ RESPONDER: en los pasos con pregunta pendiente,
--      o cuando el mensaje es una pregunta / un problema (no puedo pagar, me esperas,
--      perdí el celu, etc.), queda el aviso "No se entendió" con lo que escribió el
--      cliente. En los silencios intencionales (un "gracias", charla durante el live)
--      NO se avisa, para no llenar el panel de ruido.
--   5. PEDIR LOS DATOS O EL MONTO: se responde SIEMPRE (en cualquier estado), no solo
--      en el flujo de cliente habitual.
--   6. FOTO DUDOSA: cuando llega una imagen de un cliente sin identificar, o un
--      audio/video/documento (no se sabe si es prenda o comprobante) → aviso
--      `foto_dudosa` ("Foto para revisar") en vez de decir que es un comprobante.

-- ── 1. Matcher: también por nombre real (nunca identifica directo) ─────────
CREATE OR REPLACE FUNCTION public.vl_wa_resolver_usuario(p_tenant_id uuid, p_texto text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_cands text[];
    v_cand text;
    v_crudo text;
    v_umbral constant numeric := 0.60;
    v_id uuid;
    v_user text;
    v_score numeric;
BEGIN
    v_crudo := regexp_replace(lower(btrim(COALESCE(p_texto, ''))), '[^a-z0-9]', '', 'g');

    IF char_length(v_crudo) < 2 THEN
        RETURN jsonb_build_object('tipo', 'ninguno');
    END IF;

    v_cands := public.vl_wa_candidatos_usuario(p_texto);

    IF v_cands IS NULL THEN
        RETURN jsonb_build_object('tipo', 'ninguno');
    END IF;

    -- Los candidatos vienen en orden de prioridad: crudo, todo junto, token x token.
    -- Se acepta el PRIMER candidato que tenga un cliente por encima del umbral.
    FOREACH v_cand IN ARRAY v_cands LOOP
        CONTINUE WHEN char_length(v_cand) < 3;

        v_id := NULL;
        v_user := NULL;
        v_score := NULL;

        SELECT c.id, c.tiktok_user, c.sc INTO v_id, v_user, v_score
        FROM (
            SELECT cl.id,
                   cl.tiktok_user,
                   char_length(public.vl_wa_base_usuario(cl.tiktok_user)) AS lc,
                   greatest(
                       CASE WHEN public.vl_wa_base_usuario(cl.tiktok_user) = v_cand
                            THEN 1.000 ELSE 0 END,
                       CASE WHEN public.vl_wa_base_usuario(cl.tiktok_user) <> ''
                             AND public.vl_wa_clave_usuario(cl.tiktok_user)
                                 = public.vl_wa_clave_usuario(v_cand)
                            THEN 0.920 ELSE 0 END,
                       CASE WHEN public.vl_wa_base_usuario(cl.tiktok_user) <> ''
                             AND (public.vl_wa_base_usuario(cl.tiktok_user) LIKE v_cand || '%'
                                  OR v_cand LIKE public.vl_wa_base_usuario(cl.tiktok_user) || '%')
                             AND least(char_length(public.vl_wa_base_usuario(cl.tiktok_user)),
                                       char_length(v_cand))::numeric
                                 / greatest(char_length(public.vl_wa_base_usuario(cl.tiktok_user)),
                                            char_length(v_cand)) >= 0.6
                            THEN 0.800 ELSE 0 END,
                       CASE WHEN public.vl_wa_base_usuario(cl.tiktok_user) <> ''
                            THEN similarity(public.vl_wa_base_usuario(cl.tiktok_user), v_cand)::numeric * 0.95
                            ELSE 0 END,
                       CASE WHEN public.vl_wa_base_usuario(cl.tiktok_user) <> ''
                            THEN 1 - public.vl_wa_distancia_edicion(
                                         public.vl_wa_base_usuario(cl.tiktok_user), v_cand)::numeric
                                     / greatest(char_length(public.vl_wa_base_usuario(cl.tiktok_user)),
                                                char_length(v_cand))
                            ELSE 0 END,
                       -- Nombre real del cliente: "buscar más" cuando la persona
                       -- escribe su nombre en vez del @usuario. Va multiplicado por
                       -- 0.99 a propósito: NUNCA identifica directo (siempre pide
                       -- confirmación con "eres @x?").
                       CASE WHEN btrim(COALESCE(cl.nombre_real, '')) <> ''
                             AND public.vl_wa_base_usuario(cl.nombre_real) <> ''
                            THEN 0.99 * greatest(
                                     CASE WHEN public.vl_wa_base_usuario(cl.nombre_real) = v_cand
                                          THEN 1.000 ELSE 0 END,
                                     CASE WHEN public.vl_wa_base_usuario(cl.nombre_real) LIKE v_cand || '%'
                                           AND least(char_length(public.vl_wa_base_usuario(cl.nombre_real)),
                                                     char_length(v_cand))::numeric
                                               / greatest(char_length(public.vl_wa_base_usuario(cl.nombre_real)),
                                                          char_length(v_cand)) >= 0.6
                                          THEN 0.800 ELSE 0 END,
                                     similarity(public.vl_wa_base_usuario(cl.nombre_real), v_cand)::numeric,
                                     1 - public.vl_wa_distancia_edicion(
                                             public.vl_wa_base_usuario(cl.nombre_real), v_cand)::numeric
                                         / greatest(char_length(public.vl_wa_base_usuario(cl.nombre_real)),
                                                    char_length(v_cand))
                                 )
                            ELSE 0 END
                   ) AS sc
            FROM public.vl_clientes cl
            WHERE cl.tenant_id = p_tenant_id
        ) c
        WHERE c.sc >= v_umbral
        ORDER BY c.sc DESC, c.lc ASC
        LIMIT 1;

        IF v_id IS NOT NULL THEN
            -- Identifica directo SOLO si escribio el handle tal cual (crudo == candidato).
            RETURN jsonb_build_object(
                'tipo', CASE WHEN v_cand = v_crudo AND v_score >= 1.000 THEN 'exacto' ELSE 'parecido' END,
                'cliente_id', v_id,
                'tiktok_user', v_user,
                'clave', v_crudo,
                'candidato', v_cand,
                'score', round(v_score, 3));
        END IF;
    END LOOP;

    RETURN jsonb_build_object('tipo', 'ninguno', 'clave', v_crudo);
END;
$function$;
CREATE OR REPLACE FUNCTION public.vl_wa_conversacion_avanzar(p_tenant_id uuid, p_wa_id text, p_texto text, p_tipo text DEFAULT 'texto'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_wa text;
    v_tipo text;
    v_txt text;
    v_low text;
    v_low_limpio text;
    v_bloque text := '';
    v_reenviar boolean := false;
    v_fuera_rm boolean := false;
    v_fecha_dicha text := '';
    v_chat public.vl_wa_chats%ROWTYPE;
    v_cli public.vl_clientes%ROWTYPE;
    v_proc public.vl_procesos%ROWTYPE;
    v_saldo numeric := 0;
    v_extra numeric := 0;
    v_reply text := '';
    v_nuevo_estado text;
    v_datos_pago text := '';
    v_avisar boolean := false;
    v_aviso_tipo text := '';
    v_aviso_detalle text := '';
    v_aviso_unico boolean := false;
    v_correo text := '';
    v_contacto text := '';
    v_courier text := '';
    v_res jsonb;
    v_intentar boolean := false;
    v_msg_id uuid;
    v_id_wa uuid;
    v_ult_in timestamptz;
    v_item_nuevo timestamptz;
    v_es_prenda boolean := false;
    v_es_saludo boolean := false;
    v_reconocido boolean := false;
    v_ult_texto text;
    v_textos_prev text;
    v_buscar text;
    v_datos_prev text;
    v_solo_courier boolean := false;
    v_completo boolean := false;
    v_n_msgs int := 0;
    v_datos_pedidos boolean := false;
    v_ult_out text;
    v_ult_out_ts timestamptz;
    v_espera_comp boolean := false;
    v_prenda_cargada boolean := false;
BEGIN
    -- ── Validaciones de entrada ──
    IF p_tenant_id IS NULL
       OR NOT EXISTS (
           SELECT 1 FROM public.tenants t
           WHERE t.id = p_tenant_id AND t.proyecto = 'ventas_live'
       ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Tenant no válido');
    END IF;

    v_wa := regexp_replace(COALESCE(p_wa_id, ''), '\D', '', 'g');
    IF v_wa = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'wa_id inválido');
    END IF;
    v_wa := '+' || v_wa;

    v_tipo := lower(btrim(COALESCE(p_tipo, 'texto')));
    IF v_tipo NOT IN ('texto', 'imagen', 'audio', 'video', 'documento') THEN
        v_tipo := 'texto';
    END IF;
    v_txt := btrim(COALESCE(p_texto, ''));
    v_low := lower(v_txt);

    -- Texto "solo palabras" (sin emojis ni signos, sin acentos, en minusculas) para
    -- reconocer un saludo PURO. Un mensaje con mas palabras NO reinicia el chat.
    v_low_limpio := btrim(regexp_replace(translate(v_low, 'áéíóúüñ', 'aeioun'), '[^a-z ]', '', 'g'));

    -- ── Chat: asegurar fila + lock ──
    INSERT INTO public.vl_wa_chats (tenant_id, wa_id)
    VALUES (p_tenant_id, v_wa)
    ON CONFLICT (tenant_id, wa_id) DO NOTHING;

    SELECT * INTO v_chat
    FROM public.vl_wa_chats
    WHERE tenant_id = p_tenant_id AND wa_id = v_wa
    FOR UPDATE;

    v_nuevo_estado := v_chat.estado;

    -- Último mensaje de TEXTO del cliente y último mensaje del bot, ANTES de
    -- insertar el que acaba de llegar. Sirven para distinguir el pantallazo de la
    -- PRENDA (el negocio cargó la prenda / no se está pagando nada todavía) del
    -- COMPROBANTE DE PAGO (el bot está esperando el comprobante).
    SELECT m.body, m.creado_en INTO v_ult_texto, v_ult_in
    FROM public.vl_wa_mensajes m
    WHERE m.chat_id = v_chat.id AND m.direction = 'in' AND m.tipo = 'texto'
    ORDER BY m.creado_en DESC, m.id DESC
    LIMIT 1;

    -- Los últimos 3 textos del cliente, en orden ("la gente escribe por tramos":
    -- "hola" y después "soy anubis"). Se usan SOLO como segundo intento cuando el
    -- mensaje actual no alcanza para reconocer al cliente.
    SELECT string_agg(x.body, ' ' ORDER BY x.creado_en, x.ord) INTO v_textos_prev
    FROM (
        SELECT m.body, m.creado_en, m.id::text AS ord
        FROM public.vl_wa_mensajes m
        WHERE m.chat_id = v_chat.id AND m.direction = 'in' AND m.tipo = 'texto'
        ORDER BY m.creado_en DESC, m.id DESC
        LIMIT 3
    ) x;

    SELECT m.body, m.creado_en INTO v_ult_out, v_ult_out_ts
    FROM public.vl_wa_mensajes m
    WHERE m.chat_id = v_chat.id AND m.direction = 'out'
    ORDER BY m.creado_en DESC, m.id DESC
    LIMIT 1;

    -- Log del mensaje entrante (siempre)
    INSERT INTO public.vl_wa_mensajes (tenant_id, chat_id, direction, tipo, body)
    VALUES (p_tenant_id, v_chat.id, 'in', v_tipo, left(v_txt, 1000));

    -- ── Intervención humana: el bot NO responde ──
    IF v_chat.modo = 'humano' THEN
        UPDATE public.vl_wa_chats
        SET ultimo_mensaje = left(v_txt, 200),
            ultimo_en = now()
        WHERE id = v_chat.id;

        RETURN jsonb_build_object(
            'ok', true, 'enviar', false, 'mensaje', '',
            'chat_estado', v_chat.estado, 'cliente_id', v_chat.cliente_id,
            'cliente_tiktok', '', 'proceso_estado', '', 'modo', 'humano',
            'avisar_negocio', false, 'aviso_tipo', ''
        );
    END IF;

    -- ── Reconocimiento por WhatsApp: si este número ya es de un cliente del
    -- negocio (se identificó alguna vez con su usuario de TikTok), NO se le
    -- vuelve a pedir el usuario: se le responde como cliente habitual.
    v_id_wa := public.vl_wa_cliente_por_wa(p_tenant_id, v_wa);
    IF v_id_wa IS NOT NULL THEN
        v_reconocido := true;
        IF v_chat.cliente_id IS NULL THEN
            UPDATE public.vl_wa_chats
               SET cliente_id = v_id_wa, cliente_sugerido = NULL
             WHERE id = v_chat.id;
            v_chat.cliente_id := v_id_wa;
        END IF;
    END IF;

    -- ── Medios (imagen/audio/...): ¿es la PRENDA o el COMPROBANTE de pago? ──
    -- El bot NO ve la imagen: decide con datos reales del chat, sin adivinar.
    --   (a) PRENDA: el negocio ya le cargó la prenda (o está por cargarla) y el
    --       pantallazo es su respaldo visual → se confirma UNA vez por sesión.
    --   (b) COMPROBANTE: el bot está esperando el comprobante del pago → silencio
    --       y aviso al negocio, como siempre.
    -- OJO: NO se usa `datos_pago_enviado_en` como señal de pago: un cliente
    -- habitual recibió los datos hace días y eso convertía TODOS sus pantallazos
    -- en "comprobante" (bug real detectado en producción el 2026-09-12).
    IF v_tipo <> 'texto' THEN
        -- ¿El bot está esperando el comprobante del pago?
        v_espera_comp := (v_ult_out IS NOT NULL AND lower(v_ult_out) LIKE '%comprobante%')
            OR EXISTS (
                SELECT 1 FROM public.vl_wa_avisos a
                WHERE a.chat_id = v_chat.id
                  AND a.tipo = 'esperando_comprobante'
                  AND a.resuelto_en IS NULL
            );

        v_es_prenda := false;
        v_prenda_cargada := false;

        IF v_tipo = 'imagen'
           AND v_chat.cliente_id IS NOT NULL
           AND v_low !~ 'comprob|pagu[eé]|transfer|deposit|abon|boleta|factura' THEN

            SELECT * INTO v_cli FROM public.vl_clientes WHERE id = v_chat.cliente_id;

            SELECT max(i.creado_en) INTO v_item_nuevo
            FROM public.vl_items i
            JOIN public.vl_procesos pr ON pr.id = i.proceso_id
            WHERE pr.cliente_id = v_chat.cliente_id AND pr.cerrado_en IS NULL;

            -- ¿La última prenda de su pedido es POSTERIOR a todo lo hablado?
            -- Entonces el negocio la acaba de cargar y esta foto es esa prenda.
            v_prenda_cargada := v_item_nuevo IS NOT NULL
                AND v_item_nuevo > GREATEST(COALESCE(v_ult_in, to_timestamp(0)),
                                            COALESCE(v_ult_out_ts, to_timestamp(0)));

            -- Es la prenda si el negocio la acaba de cargar, o si no hay ninguna
            -- conversación de pago en curso (una foto suelta en el live es la prenda).
            v_es_prenda := v_prenda_cargada OR NOT v_espera_comp;
        END IF;

        IF v_es_prenda THEN
            v_avisar := true;
            v_aviso_tipo := 'prenda';
            v_aviso_unico := true;

            v_aviso_detalle := CASE WHEN v_prenda_cargada
                THEN 'El cliente mandó la foto de la prenda que le cargaste (@'
                     || COALESCE(v_cli.tiktok_user, '')
                     || '). Revisa que el monto sea el correcto.'
                ELSE 'El cliente (@' || COALESCE(v_cli.tiktok_user, '')
                     || ') mandó un pantallazo de prenda: cárgala en su pedido con el monto y confírmale.'
            END;

            -- La confirmación al cliente sale UNA vez por sesión: si manda seis
            -- pantallazos seguidos no se le repite el mismo texto seis veces.
            IF v_chat.prendas_respondido_en IS NULL
               OR v_chat.prendas_respondido_en < now() - interval '6 hours' THEN
                v_reply := 'gracias te lo guardamos' || chr(10) || chr(10)
                    || '¿seguirás viendo cositas?';
                UPDATE public.vl_wa_chats
                   SET prendas_respondido_en = now()
                 WHERE id = v_chat.id;
            END IF;

            v_nuevo_estado := 'habitual';
        ELSE
            -- No supe si era una prenda o un comprobante (o llegó audio/video/
            -- documento, o la foto llegó ANTES de identificarse): se avisa para
            -- que lo mire una persona. Antes esto se rotulaba "comprobante" y
            -- mandaba al negocio a revisar algo que no era.
            v_avisar := true;
            IF v_tipo = 'imagen' AND v_chat.cliente_id IS NOT NULL THEN
                v_aviso_tipo := 'comprobante';
                v_aviso_detalle := 'El cliente envió ' || v_tipo
                    || '. Revisa si es el comprobante de pago.';
            ELSE
                v_aviso_tipo := 'foto_dudosa';
                v_aviso_detalle := 'Llegó ' || v_tipo
                    || CASE WHEN v_chat.cliente_id IS NULL
                            THEN ' y todavía no sabemos de qué cliente es (no se identificó).'
                            ELSE ' y no sé si es una prenda o un comprobante de pago.' END
                    || ' Mensaje: "' || left(v_txt, 120) || '".';
            END IF;
        END IF;
    END IF;

    -- ── Máquina de estados (solo texto) ──
    IF v_tipo = 'texto' THEN

        -- PASO 0: reinicio de la conversación
        -- Solo si el mensaje es corto, para no confundirlo con datos de envío
        -- ni con un usuario. Dos casos distintos:
        --   * "reiniciar"/"menu": reinicio EXPLÍCITO, siempre vuelve al inicio
        --     (sirve para probar el flujo desde cero).
        --   * un saludo: si el número ya es de un cliente del negocio, NO se le
        --     borra la identidad — se le responde como cliente habitual.
        IF char_length(v_txt) <= 25
           AND v_low_limpio ~ '^(reiniciar|reinicio|reset|menu|empezar|inicio|start|partamos|volver|limpiar|consulta|nueva|nuevo)$'
        THEN
            UPDATE public.vl_wa_chats
            SET estado = 'nuevo', cliente_id = NULL, cliente_sugerido = NULL
            WHERE id = v_chat.id;
            v_chat.estado := 'nuevo';
            v_chat.cliente_id := NULL;

        ELSIF char_length(v_txt) <= 25
           AND v_low_limpio ~ '^(hola|holaa+|holi+s?|holas|buen(as|os)|hey|hi|hello)$'
        THEN
            v_es_saludo := true;

            IF v_reconocido AND v_chat.estado IN ('nuevo', 'listo') THEN
                -- Cliente del negocio sin ningún paso pendiente: pasa al flujo
                -- de habitual y NO pierde su identidad.
                UPDATE public.vl_wa_chats
                SET estado = 'habitual', cliente_sugerido = NULL
                WHERE id = v_chat.id;
                v_chat.estado := 'habitual';
                v_nuevo_estado := 'habitual';

            ELSIF v_reconocido THEN
                -- Cliente del negocio a mitad de un paso (eligiendo envío,
                -- mandando datos…): el saludo NO le borra el estado ni la
                -- identidad; se ignora y sigue el paso donde estaba.

            ELSE
                UPDATE public.vl_wa_chats
                SET estado = 'nuevo', cliente_id = NULL, cliente_sugerido = NULL
                WHERE id = v_chat.id;
                v_chat.estado := 'nuevo';
                v_chat.cliente_id := NULL;
            END IF;
        END IF;

        -- PASO 1: chat nuevo
        -- Si el número ya es de un cliente del negocio (cliente habitual), NO se
        -- le pide el usuario: pasa directo al flujo de habitual.
        IF v_chat.estado = 'nuevo' AND v_reconocido THEN
            v_chat.estado := 'habitual';
        END IF;

        IF v_chat.estado = 'nuevo' THEN
            v_reply := 'holis, me das tu nombre de usuario en el live porfis?';
            v_nuevo_estado := 'esperando_tiktok';

        -- PASO 1b: cliente habitual reconocido por su WhatsApp
        ELSIF v_chat.estado = 'habitual' THEN
            v_nuevo_estado := 'habitual';

            -- Saludo de cliente conocido: solo si saludó y no se le saludó ya en
            -- esta sesión (si manda 6 pantallazos seguidos no se le repite).
            IF v_es_saludo
               AND (v_chat.saludo_habitual_en IS NULL
                    OR v_chat.saludo_habitual_en < now() - interval '6 hours') THEN
                v_reply := 'holis bonit@';
                UPDATE public.vl_wa_chats
                   SET saludo_habitual_en = now()
                 WHERE id = v_chat.id;
            END IF;

            SELECT * INTO v_cli FROM public.vl_clientes WHERE id = v_chat.cliente_id;

            IF v_cli.id IS NULL THEN
                v_nuevo_estado := 'listo';
                v_avisar := true;
                v_aviso_tipo := 'sin_cliente';
                v_aviso_detalle := 'La conversación perdió el vínculo con el cliente en el flujo habitual. Revisar a mano.';

            ELSE
                SELECT * INTO v_proc
                FROM public.vl_procesos
                WHERE cliente_id = v_cli.id AND cerrado_en IS NULL
                LIMIT 1;
                SELECT COALESCE(SUM(precio - abonado), 0) INTO v_saldo
                FROM public.vl_items
                WHERE proceso_id = v_proc.id AND estado = 'adjudicada';

                IF v_saldo > 0 AND v_low ~ 'datos|cuenta|rut' THEN
                    -- Pidió los datos para transferir: se los manda (una vez).
                    v_bloque := public.vl_wa_bloque_pago_para(p_tenant_id, v_chat.id, false);
                    v_reply := 'gracias serian '
                        || public.vl_wa_fmt_monto(v_saldo)
                        || ' su total'
                        || CASE WHEN v_bloque <> ''
                                THEN ', le dejo mis datitos' || chr(10) || chr(10) || v_bloque
                                ELSE '' END
                        || chr(10) || chr(10)
                        || 'me manda el comprobante cuando pueda porfis';

                ELSIF v_saldo > 0
                      AND v_low ~ 'quiero pagar|voy a pagar|como pago|cómo pago|puedo pagar|te pago|quiero abonar' THEN
                    -- Dijo que quiere pagar: se le pregunta cómo y queda el aviso
                    -- en la web de que se espera el comprobante.
                    v_reply := '¿quieres datos de pago o espero el comprobante bonit@?';
                    v_avisar := true;
                    v_aviso_tipo := 'esperando_comprobante';
                    v_aviso_unico := true;
                    v_aviso_detalle := 'El cliente quiere pagar ('
                        || public.vl_wa_fmt_monto(v_saldo)
                        || ' pendiente). Espera el comprobante o mándale los datos si te los pide.';

                ELSIF v_saldo > 0
                      AND v_low ~ 'cuanto|cuánto|total|saldo' THEN
                    v_reply := 'serian ' || public.vl_wa_fmt_monto(v_saldo);
                END IF;
            END IF;

        -- PASO 2: identificar cliente (usuario TikTok exacto o parecido)
        ELSIF v_chat.estado IN ('esperando_tiktok', 'esperando_confirmar_usuario') THEN

            v_intentar := false;

            IF v_chat.estado = 'esperando_tiktok' THEN
                v_intentar := true;
            ELSE
                -- Esperando la confirmación de un usuario parecido
                IF v_low ~ '^(si|s|sii+|sip|sipi|claro|yes|yep|eso|esa|ese|correcto|exacto|aja|ajá|ok|okey|dale|obvio|soy|esa es|esa misma)'
                THEN
                    SELECT * INTO v_cli
                    FROM public.vl_clientes
                    WHERE id = v_chat.cliente_sugerido AND tenant_id = p_tenant_id;

                    IF v_cli.id IS NULL THEN
                        v_intentar := true;   -- el sugerido ya no existe
                    END IF;
                ELSIF v_low ~ '^(no|nop|nope|nel|nunca|otro|otra|ningun|ninguna|no se|nose)'
                THEN
                    -- Dijo que NO: se suelta el candidato y se le pide el usuario de
                    -- nuevo. Antes el bot quedaba mudo para siempre en este paso.
                    UPDATE public.vl_wa_chats
                    SET cliente_sugerido = NULL
                    WHERE id = v_chat.id;

                    v_avisar := true;
                    v_aviso_tipo := 'usuario_no_confirmado';
                    v_aviso_unico := true;
                    v_aviso_detalle := 'El cliente dijo que NO es el usuario que le propusimos: "'
                        || left(v_txt, 60) || '". Revisar a mano.';
                    v_reply := 'okis, me lo escribes de nuevo porfis?';
                    v_nuevo_estado := 'esperando_tiktok';
                ELSE
                    -- Escribió otro usuario: se reintenta con ese texto
                    v_intentar := true;
                END IF;
            END IF;

            IF v_intentar THEN
                v_res := public.vl_wa_resolver_usuario(p_tenant_id, v_txt);

                -- Segundo intento con los mensajes anteriores juntos: la gente
                -- escribe por tramos ("hola" y después "soy anubis") y no hay que
                -- volver a pedirle el usuario si ya lo dijo.
                IF v_res->>'tipo' = 'ninguno' AND btrim(COALESCE(v_textos_prev, '')) <> '' THEN
                    v_buscar := btrim(v_textos_prev || ' ' || v_txt);
                    v_res := public.vl_wa_resolver_usuario(p_tenant_id, v_buscar);
                END IF;

                IF v_res->>'tipo' = 'exacto' THEN
                    SELECT * INTO v_cli
                    FROM public.vl_clientes
                    WHERE id = (v_res->>'cliente_id')::uuid;

                ELSIF v_res->>'tipo' = 'parecido' THEN
                    UPDATE public.vl_wa_chats
                    SET cliente_sugerido = (v_res->>'cliente_id')::uuid
                    WHERE id = v_chat.id;

                    v_reply := 'eres @' || (v_res->>'tiktok_user') || '?';
                    v_nuevo_estado := 'esperando_confirmar_usuario';

                ELSE
                    -- Nada parecido. Dos casos distintos:
                    --  a) el mensaje NO traía nada usable ("soy", "mi usuario es",
                    --     "aquí"): está escribiendo por tramos → NO se le repite la
                    --     pregunta (el dueño: "no ser redundante ni tedioso"), se
                    --     espera y se avisa por si se quedó pegado.
                    --  b) sí intentó un usuario y no existe → se le pide de nuevo
                    --     (antes este caso salía con el eco "@soy@camidellive 😕").
                    IF array_length(public.vl_wa_candidatos_usuario(v_txt), 1) <= 1 THEN
                        v_avisar := true;
                        v_aviso_tipo := 'no_entendido';
                        v_aviso_unico := true;
                        v_aviso_detalle := 'El cliente escribió algo incompleto esperando su usuario ("'
                            || left(v_txt, 80) || '"). No le repetí la pregunta para no ser redundante.';
                        v_nuevo_estado := 'esperando_tiktok';
                    ELSE
                        v_reply := 'no encontre ese usuario 😕 me lo escribes igual al del live porfis?';
                        v_nuevo_estado := 'esperando_tiktok';
                        v_avisar := true;
                        v_aviso_tipo := 'usuario_no_encontrado';
                        v_aviso_unico := true;
                        v_aviso_detalle := 'No se encontró ningún usuario parecido a "'
                            || left(v_txt, 60) || '". Revisar a mano.';
                    END IF;
                END IF;
            END IF;

            -- Cliente identificado (exacto o confirmado): mismo flujo para ambos
            IF v_cli.id IS NOT NULL THEN
                v_res := public.vl_wa_procesar_cliente_identificado(
                             p_tenant_id, v_chat.id, v_cli.id, v_wa);
                v_reply := COALESCE(v_res->>'mensaje', '');
                v_nuevo_estado := COALESCE(v_res->>'estado', 'listo');

                IF COALESCE(v_res->>'aviso_tipo', '') <> '' THEN
                    v_avisar := true;
                    v_aviso_tipo := v_res->>'aviso_tipo';
                    v_aviso_detalle := v_res->>'aviso_detalle';
                END IF;
            END IF;

        -- PASO 3: tipo de entrega
        ELSIF v_chat.estado = 'esperando_tipo_entrega' THEN
            SELECT * INTO v_cli FROM public.vl_clientes WHERE id = v_chat.cliente_id;

            IF v_cli.id IS NULL THEN
                v_nuevo_estado := 'listo';
                v_avisar := true;
                v_aviso_tipo := 'sin_cliente';
                v_aviso_detalle := 'La conversación perdió el vínculo con el cliente en el paso "envío o presencial". Revisar a mano.';

            ELSIF position('pres' in v_low) > 0 THEN
                UPDATE public.vl_clientes SET entrega_preferida = 'presencial'
                WHERE id = v_cli.id;

                SELECT * INTO v_proc
                FROM public.vl_procesos
                WHERE cliente_id = v_cli.id AND cerrado_en IS NULL
                LIMIT 1;
                SELECT COALESCE(SUM(precio - abonado), 0) INTO v_saldo
                FROM public.vl_items
                WHERE proceso_id = v_proc.id AND estado = 'adjudicada';

                IF v_proc.estado IN ('esperando_whatsapp', 'identificando_cliente') THEN
                    UPDATE public.vl_procesos SET estado = 'esperando_pago'
                    WHERE id = v_proc.id;
                END IF;

                -- Queda registrado en el bloque de entregas del panel (y la fecha
                -- que haya mencionado el cliente, tal cual la escribió).
                v_fecha_dicha := public.vl_wa_fecha_mencion(v_txt);
                PERFORM public.vl_wa_registrar_entrega(p_tenant_id, v_cli.id, 'presencial', v_fecha_dicha);

                v_avisar := true;
                v_aviso_tipo := 'entrega_presencial';
                v_aviso_unico := true;
                v_aviso_detalle := 'Eligió entrega presencial. '
                    || CASE WHEN v_fecha_dicha <> ''
                            THEN 'Dijo: "' || v_fecha_dicha || '".'
                            ELSE 'Todavía no dijo fecha.' END
                    || ' Coordinar con @' || COALESCE(v_cli.tiktok_user, '') || '.';

                v_reply := 'okis, ahi coordinamos la entrega, este es su monto '
                    || public.vl_wa_fmt_monto(v_saldo)
                    || ' puede transferir ahora o pagar cuando nos veamos...';
                v_nuevo_estado := 'esperando_forma_pago';

            ELSIF v_low LIKE '%env%' THEN
                UPDATE public.vl_clientes SET entrega_preferida = 'envio'
                WHERE id = v_cli.id;

                -- Registro temprano: el envío aparece en el bloque de entregas
                -- como "esperando confirmación de pago" (sin acciones aún).
                PERFORM public.vl_wa_registrar_entrega(
                    p_tenant_id, v_cli.id, 'envio', public.vl_wa_fecha_mencion(v_txt));

                v_reply := 'okis me dejas tus datitos, nombre, direccion, comuna, contacto, correo, los envios pueden ser por blue o paket...';
                v_nuevo_estado := 'esperando_datos_envio';

            ELSE
                v_avisar := true;
                v_aviso_tipo := 'no_entendido';
                v_aviso_unico := true;
                v_aviso_detalle := 'No se entendió si quiere envío o entrega presencial: "'
                    || left(v_txt, 200) || '"';
                v_nuevo_estado := v_chat.estado;
            END IF;

        -- PASO 4: datos de envío (un solo mensaje, texto libre)
        ELSIF v_chat.estado = 'esperando_datos_envio' THEN
            SELECT * INTO v_cli FROM public.vl_clientes WHERE id = v_chat.cliente_id;

            IF v_cli.id IS NULL THEN
                v_nuevo_estado := 'listo';
                v_avisar := true;
                v_aviso_tipo := 'sin_cliente';
                v_aviso_detalle := 'La conversación perdió el vínculo con el cliente en el paso de datos de envío. Revisar a mano.';

            ELSE
                -- ¿Escribió SOLO el courier ("por blue por favor")? Se guarda el
                -- courier y NO se gasta el mensaje de los datos de envío.
                v_solo_courier := char_length(v_txt) <= 25
                    AND v_txt !~ '[0-9]' AND v_txt !~ '@'
                    AND (v_low LIKE '%blue%' OR v_low ~ 'paket|packet|paquet');

                IF v_solo_courier THEN
                    v_courier := CASE WHEN v_low LIKE '%blue%' THEN 'blue' ELSE 'paket' END;
                    UPDATE public.vl_clientes SET courier = v_courier WHERE id = v_cli.id;
                    PERFORM public.vl_wa_registrar_entrega(p_tenant_id, v_cli.id, 'envio', '');

                ELSE
                    -- Los datos se ACUMULAN. "La gente escribe por tramos": antes
                    -- cada mensaje corto PISABA el anterior y se perdía todo.
                    UPDATE public.vl_clientes
                    SET datos_envio = left(btrim(
                            COALESCE(NULLIF(btrim(COALESCE(datos_envio, '')), ''), '') || ' ' || v_txt
                        ), 1000)
                    WHERE id = v_cli.id;

                    SELECT COALESCE(datos_envio, '') INTO v_datos_prev
                    FROM public.vl_clientes WHERE id = v_cli.id;

                    -- Lectura tolerante sobre TODO lo acumulado, no solo el mensaje nuevo.
                    v_correo := substring(v_datos_prev
                        from '[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}');

                    v_contacto := substring(
                        regexp_replace(v_datos_prev,
                            '[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}', ' ', 'g')
                        from '\+?\d[\d\s\-\.\(\)]{6,}\d');

                    IF v_low LIKE '%blue%' THEN
                        v_courier := 'blue';
                    ELSIF v_low ~ 'paket|packet|paquet' THEN
                        v_courier := 'paket';
                    END IF;

                    UPDATE public.vl_clientes
                    SET correo   = COALESCE(NULLIF(v_correo, ''),   correo),
                        contacto = COALESCE(NULLIF(v_contacto, ''), contacto),
                        courier  = COALESCE(NULLIF(v_courier, ''),  courier)
                    WHERE id = v_cli.id;

                    SELECT * INTO v_cli FROM public.vl_clientes WHERE id = v_cli.id;

                    -- ¿Ya hay datos usables? Correo o teléfono, o un texto largo que
                    -- casi seguro trae nombre/dirección/comuna.
                    v_completo := v_correo <> '' OR v_contacto <> ''
                        OR char_length(btrim(v_datos_prev)) >= 25;
                END IF;

                IF v_completo THEN
                -- La elección de courier también queda en el bloque de entregas,
                -- con la fecha si el cliente la mencionó en el mismo mensaje.
                v_fecha_dicha := public.vl_wa_fecha_mencion(v_txt);
                PERFORM public.vl_wa_registrar_entrega(p_tenant_id, v_cli.id, 'envio', v_fecha_dicha);

                SELECT * INTO v_proc
                FROM public.vl_procesos
                WHERE cliente_id = v_cli.id AND cerrado_en IS NULL
                LIMIT 1;
                SELECT COALESCE(SUM(precio - abonado), 0) INTO v_saldo
                FROM public.vl_items
                WHERE proceso_id = v_proc.id AND estado = 'adjudicada';

                IF v_cli.courier = 'paket' THEN
                    -- Paket es solo Región Metropolitana: si la dirección es de
                    -- otra región NO se suma el envío y se avisa al negocio.
                    v_fuera_rm := NOT public.vl_wa_es_santiago(v_datos_prev);
                    IF v_fuera_rm THEN
                        v_extra := 0;
                    ELSE
                        v_extra := 3500;
                    END IF;
                END IF;

                SELECT COALESCE(datos_pago, '') INTO v_datos_pago
                FROM public.vl_config WHERE tenant_id = p_tenant_id;

                IF v_proc.estado IN ('esperando_whatsapp', 'identificando_cliente') THEN
                    UPDATE public.vl_procesos SET estado = 'esperando_pago'
                    WHERE id = v_proc.id;
                END IF;

                v_reenviar := v_low ~ 'datos|cuenta|rut';
                v_bloque := public.vl_wa_bloque_pago_para(p_tenant_id, v_chat.id, v_reenviar);

                v_reply := 'gracias serian '
                    || public.vl_wa_fmt_monto(v_saldo + v_extra)
                    || ' su total'
                    || CASE WHEN v_bloque <> ''
                            THEN ', le dejo mis datitos' || chr(10) || chr(10) || v_bloque
                            ELSE '' END
                    || chr(10) || chr(10)
                    || 'me manda el comprobante cuando pueda porfis';

                IF v_cli.courier IS NULL OR v_cli.courier = '' THEN
                    v_avisar := true;
                    v_aviso_tipo := 'sin_courier';
                    v_aviso_unico := true;
                    v_aviso_detalle := 'El cliente no indicó courier (blue/paket). Elegirlo a mano. Datos: '
                        || left(v_datos_prev, 300);
                ELSIF v_cli.courier = 'paket' AND v_fuera_rm THEN
                    v_avisar := true;
                    v_aviso_tipo := 'paket_region';
                    v_aviso_unico := true;
                    v_aviso_detalle := 'Eligió Paket pero la dirección no parece de Santiago (paket solo cubre la RM). '
                        || 'No se le sumó el envío: elegir Blue o coordinar a mano. Datos: ' || left(v_datos_prev, 200);
                ELSIF v_cli.courier = 'paket' THEN
                    v_avisar := true;
                    v_aviso_tipo := 'entrega_paket';
                    v_aviso_unico := true;
                    v_aviso_detalle := 'Eligió envío por Paket ($3.500, solo Santiago): hay que pedirlo '
                        || 'antes de las 23:59 del día anterior. Dirección: ' || left(v_datos_prev, 200);
                ELSE
                    v_avisar := true;
                    v_aviso_tipo := 'entrega_blue';
                    v_aviso_unico := true;
                    v_aviso_detalle := 'Eligió envío por Blue Express (el envío se paga al recibir): '
                        || 'crear el pedido en Blue. Dirección: ' || left(v_datos_prev, 200);
                END IF;

                v_nuevo_estado := 'listo';

                ELSIF NOT v_solo_courier THEN
                    -- Todavía no hay datos usables: se espera SIN repetir preguntas.
                    -- Si ya van 2 mensajes así, se avisa al negocio para que actúe.
                    SELECT count(*) INTO v_n_msgs
                    FROM public.vl_wa_mensajes m
                    WHERE m.chat_id = v_chat.id AND m.direction = 'in' AND m.tipo = 'texto'
                      AND m.creado_en > COALESCE((
                            SELECT max(o.creado_en) FROM public.vl_wa_mensajes o
                            WHERE o.chat_id = v_chat.id AND o.direction = 'out'
                              AND o.body LIKE '%datitos%'), to_timestamp(0));

                    IF v_n_msgs >= 2 THEN
                        v_avisar := true;
                        v_aviso_tipo := 'no_entendido';
                        v_aviso_unico := true;
                        v_aviso_detalle := 'Todavía no tengo sus datos de envío (nombre, dirección, comuna, contacto, correo). Lo último del cliente: "'
                            || left(v_txt, 200) || '".';
                    END IF;
                END IF;
            END IF;

        -- PASO 5: presencial -> transfiere ahora o paga al verse
        ELSIF v_chat.estado = 'esperando_forma_pago' THEN
            -- Si menciona una fecha ("el sábado", "mañana"...) queda guardada tal
            -- cual en el registro de entrega y se actualiza el aviso abierto.
            v_fecha_dicha := public.vl_wa_fecha_mencion(v_txt);
            IF v_fecha_dicha <> '' THEN
                PERFORM public.vl_wa_registrar_entrega(
                    p_tenant_id, v_chat.cliente_id, 'presencial', v_fecha_dicha);

                UPDATE public.vl_wa_avisos
                   SET detalle = detalle || ' Ahora dijo: "' || v_fecha_dicha || '".'
                 WHERE chat_id = v_chat.id
                   AND tipo = 'entrega_presencial'
                   AND resuelto_en IS NULL;
            END IF;

            IF v_low ~ 'transfer|deposit|abonar|te mando|te transfiero|ahora|cuenta|datos|de una|dale' THEN
                SELECT * INTO v_proc
                FROM public.vl_procesos
                WHERE cliente_id = v_chat.cliente_id AND cerrado_en IS NULL
                LIMIT 1;
                SELECT COALESCE(SUM(precio - abonado), 0) INTO v_saldo
                FROM public.vl_items
                WHERE proceso_id = v_proc.id AND estado = 'adjudicada';

                v_reenviar := v_low ~ 'datos|cuenta|rut';
                v_bloque := public.vl_wa_bloque_pago_para(p_tenant_id, v_chat.id, v_reenviar);

                v_reply := 'gracias serian '
                    || public.vl_wa_fmt_monto(v_saldo)
                    || ' su total'
                    || CASE WHEN v_bloque <> ''
                            THEN ', le dejo mis datitos' || chr(10) || chr(10) || v_bloque
                            ELSE '' END
                    || chr(10) || chr(10)
                    || 'me manda el comprobante cuando pueda porfis';
            ELSE
                v_reply := 'okis no hay problema nos vemos...';
            END IF;
            v_nuevo_estado := 'listo';

        -- PASO 6: conversación terminada -> se escucha si aclara algo después
        -- (courier, fecha) y se avisa al negocio si dice que pagó.
        ELSIF v_chat.estado = 'listo' THEN
            IF v_chat.cliente_id IS NOT NULL AND v_low ~ 'blue|paket|packet|paquet' THEN
                UPDATE public.vl_clientes
                   SET courier = CASE WHEN v_low LIKE '%blue%' THEN 'blue' ELSE 'paket' END
                 WHERE id = v_chat.cliente_id;

                PERFORM public.vl_wa_registrar_entrega(
                    p_tenant_id, v_chat.cliente_id,
                    CASE WHEN EXISTS (
                        SELECT 1 FROM public.vl_envios e
                        JOIN public.vl_procesos pp ON pp.id = e.proceso_id
                        WHERE pp.cliente_id = v_chat.cliente_id AND e.tipo = 'presencial'
                    ) THEN 'presencial' ELSE 'envio' END, '');

                v_avisar := true;
                v_aviso_tipo := CASE WHEN v_low LIKE '%blue%' THEN 'entrega_blue' ELSE 'entrega_paket' END;
                v_aviso_unico := true;
                v_aviso_detalle := 'Aclaró el courier después ('
                    || CASE WHEN v_low LIKE '%blue%' THEN 'Blue' ELSE 'Paket' END
                    || '). Actualizar el envío en el registro de entregas. Mensaje: "'
                    || left(v_txt, 150) || '"';
            END IF;

            v_fecha_dicha := public.vl_wa_fecha_mencion(v_txt);
            IF v_fecha_dicha <> '' AND v_chat.cliente_id IS NOT NULL THEN
                PERFORM public.vl_wa_registrar_entrega(
                    p_tenant_id, v_chat.cliente_id, 'presencial', v_fecha_dicha);

                UPDATE public.vl_wa_avisos
                   SET detalle = detalle || ' Ahora dijo: "' || v_fecha_dicha || '".'
                 WHERE chat_id = v_chat.id
                   AND tipo IN ('entrega_presencial', 'pago')
                   AND resuelto_en IS NULL;
            END IF;

            -- "quiero pagar" (intención) NO es lo mismo que "ya pagué" (aviso de
            -- pago hecho): la intención se pregunta cómo quiere pagar.
            -- Y si pide los datos o pregunta el monto, se responde SIEMPRE (en
            -- cualquier estado), sin dejarlo esperando.
            IF v_chat.cliente_id IS NOT NULL
               AND v_low ~ 'datos|cuenta|rut|cuanto|cuánto|total|saldo' THEN
                SELECT * INTO v_proc
                FROM public.vl_procesos
                WHERE cliente_id = v_chat.cliente_id AND cerrado_en IS NULL
                LIMIT 1;
                SELECT COALESCE(SUM(precio - abonado), 0) INTO v_saldo
                FROM public.vl_items
                WHERE proceso_id = v_proc.id AND estado = 'adjudicada';

                IF v_saldo > 0 AND v_low ~ 'datos|cuenta|rut' THEN
                    v_bloque := public.vl_wa_bloque_pago_para(p_tenant_id, v_chat.id, false);
                    v_reply := 'gracias serian '
                        || public.vl_wa_fmt_monto(v_saldo)
                        || ' su total'
                        || CASE WHEN v_bloque <> ''
                                THEN ', le dejo mis datitos' || chr(10) || chr(10) || v_bloque
                                ELSE '' END
                        || chr(10) || chr(10)
                        || 'me manda el comprobante cuando pueda porfis';
                ELSIF v_saldo > 0 THEN
                    v_reply := 'serian ' || public.vl_wa_fmt_monto(v_saldo);
                END IF;

            ELSIF v_chat.cliente_id IS NOT NULL
               AND v_low ~ 'quiero pagar|voy a pagar|como pago|cómo pago|puedo pagar|te pago|quiero abonar'
               AND EXISTS (
                   SELECT 1 FROM public.vl_items i
                   JOIN public.vl_procesos pp ON pp.id = i.proceso_id
                   WHERE pp.cliente_id = v_chat.cliente_id
                     AND pp.cerrado_en IS NULL
                     AND i.estado = 'adjudicada'
                     AND i.precio - i.abonado > 0
               ) THEN
                v_reply := '¿quieres datos de pago o espero el comprobante bonit@?';
                v_avisar := true;
                v_aviso_tipo := 'esperando_comprobante';
                v_aviso_unico := true;
                v_aviso_detalle := 'El cliente quiere pagar. Espera el comprobante o mándale los datos si te los pide.';

            ELSIF v_low ~ 'pag|transfer|comprob|abon|deposit' THEN
                v_avisar := true;
                v_aviso_tipo := 'pago';
                v_aviso_unico := true;
                v_aviso_detalle := 'El cliente dice que pagó. Revisa y confirma el pago para proseguir. Mensaje: "'
                    || left(v_txt, 200) || '"';
            END IF;

            -- Lo único que responde en estado listo es el "quiero pagar" de
            -- arriba (el resto queda mudo, atendido por el humano).
            v_nuevo_estado := 'listo';
        END IF;
    END IF;

    -- ── ¿El cliente responde sobre un pedido que no está cargado? ──
    -- (el bot le pidió la foto porque no tenía pedido en la web)
    IF v_chat.pide_foto_en IS NOT NULL
       AND v_chat.pide_foto_en > now() - interval '30 days' THEN
        v_avisar := true;
        v_aviso_tipo := 'sin_pedido';
        v_aviso_unico := true;
        v_aviso_detalle := 'El cliente respondió ('
            || CASE WHEN v_tipo = 'texto' THEN left(v_txt, 140) ELSE v_tipo END
            || ') sobre un pedido que no está cargado en la web. Revísalo y escríbele tú.';
        UPDATE public.vl_wa_chats SET pide_foto_en = NULL WHERE id = v_chat.id;
    END IF;

    -- ── NO repetir la misma respuesta dos veces seguidas ──
    -- Pedido explícito del dueño: "sin ser redundante ni tedioso". Si el bot iba a
    -- mandar exactamente lo mismo que ya mandó, se calla y avisa al negocio.
    IF v_reply <> '' AND v_ult_out IS NOT NULL AND v_reply = v_ult_out THEN
        v_reply := '';
        IF NOT v_avisar THEN
            v_avisar := true;
            v_aviso_tipo := 'no_entendido';
            v_aviso_unico := true;
            v_aviso_detalle := 'No le repetí la misma respuesta porque ya se la había mandado. Lo último del cliente: "'
                || left(v_txt, 150) || '". Revísalo y respóndele tú.';
        END IF;
    END IF;

    -- ── ¿No supe qué responder? Aviso al negocio (nunca dejarlo pasar) ──
    -- El dueño: "danos un aviso cuando ocurran cosas que no sabes responder". Se
    -- avisa en los pasos con una pregunta pendiente o cuando el mensaje es una
    -- pregunta / un problema. En los silencios intencionales (un "gracias", charla
    -- mientras sigue el live) NO se avisa, para no llenar el panel de ruido.
    IF v_tipo = 'texto' AND v_reply = '' AND NOT v_avisar THEN
        IF v_nuevo_estado NOT IN ('listo', 'habitual')
           OR v_txt LIKE '%?%' OR v_txt LIKE '%¿%'
           OR v_low ~ 'no puedo|no puede|no me deja|no e podido|no he podido|problema|ayuda|cuando|cuándo|donde|dónde|cuanto|cuánto|esperar|esperame|espérame|espera|plazo|semana|bloque|error|equivoc|perdi|perdí|no tengo|se me|olvide|olvidé|devoluc|reclamo'
        THEN
            v_avisar := true;
            v_aviso_tipo := 'no_entendido';
            v_aviso_unico := true;
            v_aviso_detalle := 'No supe qué responderle y preferí no inventar. Lo que escribió: "'
                || left(v_txt, 200) || '". Revísalo y respóndele tú.';
        END IF;
    END IF;

    -- ── Persistir, avisar y responder ──
    UPDATE public.vl_wa_chats
    SET estado = v_nuevo_estado,
        ultimo_mensaje = left(v_txt, 200),
        ultimo_en = now()
    WHERE id = v_chat.id;

    IF v_avisar THEN
        -- Los avisos repetitivos no se duplican mientras el anterior siga abierto
        IF v_aviso_unico AND EXISTS (
            SELECT 1 FROM public.vl_wa_avisos a
            WHERE a.chat_id = v_chat.id
              AND a.tipo = v_aviso_tipo
              AND a.resuelto_en IS NULL
        ) THEN
            v_avisar := false;
        ELSE
            INSERT INTO public.vl_wa_avisos (tenant_id, chat_id, tipo, detalle)
            VALUES (p_tenant_id, v_chat.id, v_aviso_tipo, COALESCE(v_aviso_detalle, ''));
        END IF;
    END IF;

    IF v_reply <> '' THEN
        INSERT INTO public.vl_wa_mensajes (tenant_id, chat_id, direction, tipo, body)
        VALUES (p_tenant_id, v_chat.id, 'out', 'texto', left(v_reply, 1000))
        RETURNING id INTO v_msg_id;
    END IF;

    -- tiktok del cliente identificado (para el log de la Edge Function)
    IF v_cli.id IS NOT NULL THEN
        SELECT * INTO v_cli FROM public.vl_clientes WHERE id = v_cli.id;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'enviar', v_reply <> '',
        'mensaje', v_reply,
        'chat_estado', v_nuevo_estado,
        'cliente_id', v_chat.cliente_id,
        'cliente_tiktok', COALESCE(v_cli.tiktok_user, ''),
        'proceso_estado', COALESCE(v_proc.estado, ''),
        'avisar_negocio', v_avisar,
        'aviso_tipo', v_aviso_tipo
    );
END;
$function$;

-- ── Permisos ────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.vl_wa_resolver_usuario(uuid, text) FROM anon, authenticated, public;
REVOKE ALL ON FUNCTION public.vl_wa_conversacion_avanzar(uuid, text, text, text)
    FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_conversacion_avanzar(uuid, text, text, text)
    TO service_role;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] Conversación por tramos + sin redundancia + aviso cuando no sabe qué responder OK' AS status;
