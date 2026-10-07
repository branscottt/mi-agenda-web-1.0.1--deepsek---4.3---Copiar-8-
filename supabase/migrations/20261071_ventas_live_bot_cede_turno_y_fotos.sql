-- ============================================================================
-- [VENTAS LIVE] El bot CEDE EL TURNO al dueño + entiende las fotos
--                (prenda vs comprobante de pago) — ciclo 20261071
--
-- Pedido del dueño (2026-10-07, umbralis), tras ver el chat real:
--   4) "lo ideal sería que el bot entienda el contexto y sepa responder… pero
--      claro, quizá si yo hablo y no me ha respondido la persona, el bot calle".
--      -> Si el ÚLTIMO mensaje saliente del chat lo escribió una PERSONA (origen
--         'humano') hace menos de 15 minutos, el bot NO contesta: deja el turno
--         al dueño. Sigue LEYENDO y rellenando el proceso (igual que modo
--         humano). Si el dueño dejó de escribir (más de 15 min), el bot retoma
--         solo — entiende que la persona se fue.
--   5) "lo ideal sería que el bot entienda si la foto es un comprobante de pago
--      o una foto de una prenda":
--      * FOTO DE PRENDA  -> el bot responde el TOTAL que lleva el cliente
--        DESPUÉS DE CADA foto (antes solo lo decía si la leyenda preguntaba el
--        monto, y si no decía "gracias te lo guardamos / ¿seguirás viendo
--        cositas?" — que era el bug que vio el dueño mandando fotos en vez de
--        "hola"). Si aún no hay prendas cargadas, avisa que ya lo guarda.
--      * FOTO DE COMPROBANTE -> NO responde como prenda: deja el aviso
--        "Comprobante" en el panel para que una persona revise si el pago está
--        en la cuenta y apriete "Confirmar pago" (el botón ya está en el chat),
--        y le contesta al cliente un "ya lo reviso y te confirmo al tiro"
--        (antes quedaba en silencio y el cliente no sabía si se había recibido).
--        Si el pedido estaba en una etapa previa, se mueve a `esperando_pago`
--        para que "Confirmar pago" quede a mano en el chat.
--   6) En el flujo de ENVÍO ya no se pregunta "¿o prefieres seguir juntando
--      prenditas?" cuando el cliente ACABA de elegir envío (confundía: parecía
--      que el bot no lo había escuchado).
--
-- Cuerpo copiado TAL CUAL del archivo vivo 20261070 (pg_get_functiondef). Sin drift.
-- ============================================================================

-- ── 1. Cerebro──────────────────────────────────────────────────────────────
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
    v_cli_datos boolean := false;
    v_bloque text := '';
    v_reenviar boolean := false;
    v_fuera_rm boolean := false;
    v_fecha_dicha text := '';
    v_fecha_prog date;
    v_total_ok boolean := true;
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
    v_leido jsonb := '{}'::jsonb;
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
    v_reset boolean := false;
    v_ult_out text;
    v_ult_out_ts timestamptz;
    v_ult_out_origen text;
    v_dueno_turno boolean := false;
    v_espera_comp boolean := false;
    v_prenda_cargada boolean := false;
    v_user_nuevo text;
    v_cand_txt text;
    v_preg_entrega text := '';
    v_respuesta_pedida boolean := false;
    v_ir_a_entrega boolean := false;
    v_dir_prev text := '';
    v_horario text := '';
    v_preg_monto boolean := false;
    v_matches jsonb;
    v_pick jsonb;
    v_n int;
    v_num int;
    v_lista_txt text;
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

    -- ¿El cliente AVISA que ÉL manda SUS datos (nombre/dirección para el envío)?
    -- Eso NO es pedir los datos de pago del negocio. Bug real 2026-10-07:
    -- "ahora te voy a mandar los datos para me envies por paket" -> el bot le
    -- respondió con los datos BANCARIOS. Si el mensaje es "me mandas/pásame los
    -- datos", SÍ los está pidiendo -> no se activa.
    v_cli_datos := (v_low ~ '(mis datos|datos de envio|datos de envío|datos para (el envio|el envío|(que )?me (envies|envíes)|la entrega)|estos son (mis|los) datos|aca van (mis|los) datos|aqui van (mis|los) datos|te (voy a )?(mando|mandaré|mandare|envio|enviaré|enviare|paso|pasare|pasaré|dejo|dejaré) (mis |los |tus )?(datos|la direccion|la dirección|el nombre|mi direccion|mi dirección|direccion|dirección))')
                   AND NOT (v_low ~ 'me (manda|mandas|pasa|pasas|envia|envías|deja|dejas)|mandame|mándame|pasame|pásame|dame|necesito|quiero (los|tus) datos');

    -- ── Chat: asegurar fila + lock ──
    INSERT INTO public.vl_wa_chats (tenant_id, wa_id)
    VALUES (p_tenant_id, v_wa)
    ON CONFLICT (tenant_id, wa_id) DO NOTHING;

    SELECT * INTO v_chat
    FROM public.vl_wa_chats
    WHERE tenant_id = p_tenant_id AND wa_id = v_wa
    FOR UPDATE;

    v_nuevo_estado := v_chat.estado;

    -- ¿Ya le dijimos el monto hace poquito? Entonces no se lo repetimos si no lo
    -- pide (charla fluida, sin sonar a bot repitiendo datos ya dados).
    v_total_ok := v_chat.monto_dicho_en IS NULL
                  OR v_chat.monto_dicho_en < now() - interval '30 minutes';

    -- Horario de entrega configurado por el negocio (con respaldo si no hay fila
    -- de vl_config). Se usa al elegir ENTREGA PRESENCIAL.
    SELECT COALESCE(NULLIF(btrim(COALESCE(horario_entrega, '')), ''), '')
      INTO v_horario
      FROM public.vl_config WHERE tenant_id = p_tenant_id;
    IF COALESCE(btrim(v_horario), '') = '' THEN
        v_horario := 'te puedo coordinar la entrega de lunes a sábado; si algún día no puedo, te aviso yo';
    END IF;

    -- ¿Con este mensaje el cliente está pidiendo CUÁNTO PAGA? (sirve para el
    -- pantallazo de prenda con leyenda "cuánto es el total?").
    v_preg_monto := v_low ~ 'cuanto|cuánto|total|que debo|qué debo|valor|precio|saldo|cuanto sale|cuánto sale|cuanto es';

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

    SELECT m.body, m.creado_en, m.origen INTO v_ult_out, v_ult_out_ts, v_ult_out_origen
    FROM public.vl_wa_mensajes m
    WHERE m.chat_id = v_chat.id AND m.direction = 'out'
    ORDER BY m.creado_en DESC, m.id DESC
    LIMIT 1;

    -- ── ¿El TURNO es del dueño? (ciclo 20261071) ──
    -- Si el último mensaje saliente lo escribió una PERSONA desde el panel
    -- (origen 'humano') y fue hace menos de 15 minutos, el bot CEDE EL TURNO: no
    -- contesta, pero sigue leyendo y rellenando el proceso (igual que el modo
    -- humano). Cuando la persona deja de escribir (más de 15 min), el bot retoma
    -- solo. Antes el panel devolvía el control al bot apenas enviabas, así que el
    -- bot se encimaba sobre la persona: en el chat real de umbralis el dueño
    -- escribió "ahora te mando los datos…" y el bot le contestó al cliente con
    -- los datos BANCARIOS encima del mensaje de la dueña.
    v_dueno_turno := COALESCE(v_ult_out_origen, '') = 'humano'
                     AND v_ult_out_ts IS NOT NULL
                     AND v_ult_out_ts > now() - interval '15 minutes';

    -- Log del mensaje entrante (siempre)
    INSERT INTO public.vl_wa_mensajes (tenant_id, chat_id, direction, tipo, body)
    VALUES (p_tenant_id, v_chat.id, 'in', v_tipo, left(v_txt, 1000));

    -- ── Intervención humana: el bot NO responde, pero SÍ lee ──
    -- Aunque atienda una persona, el mensaje se analiza y se rellena el
    -- proceso del cliente (región/courier/datos de envío/entrega/fecha).
    -- Así el diagrama y el chat quedan al día en modo manual igual que con bot.
    -- ciclo 20261071: también entra acá cuando el TURNO es del DUEÑO (escribió una
    -- persona hace <15 min), aunque el modo esté en 'bot': el bot no se encima.
    IF v_chat.modo = 'humano' OR v_dueno_turno THEN
        UPDATE public.vl_wa_chats
        SET ultimo_mensaje = left(v_txt, 200),
            ultimo_en = now()
        WHERE id = v_chat.id;

        -- MEJORA: si el chat todavía no está vinculado, se intenta reconocer al
        -- cliente por su número de WhatsApp (no se adivina el @). Así el modo
        -- manual rellena el proceso desde el primer mensaje de un cliente
        -- conocido, aunque en ESTE chat nadie haya escrito el @.
        IF v_chat.cliente_id IS NULL THEN
            v_id_wa := public.vl_wa_cliente_por_wa(p_tenant_id, v_wa);
            IF v_id_wa IS NOT NULL THEN
                UPDATE public.vl_wa_chats
                   SET cliente_id = v_id_wa, cliente_sugerido = NULL
                 WHERE id = v_chat.id;
                v_chat.cliente_id := v_id_wa;
            END IF;

            -- MEJORA (A): tampoco hay número guardado. Si el cliente escribió su
            -- @ en el mensaje, se usa ESO. En manual no se le puede preguntar,
            -- así que solo se vincula cuando el @ es EXACTO (0 riesgo de atarlo a
            -- la persona equivocada); con un parecido se deja aviso y nada más.
            IF v_chat.cliente_id IS NULL THEN
                v_res := public.vl_wa_resolver_usuario(p_tenant_id, v_txt);

                IF v_res->>'tipo' = 'exacto' THEN
                    UPDATE public.vl_wa_chats
                       SET cliente_id = (v_res->>'cliente_id')::uuid,
                           cliente_sugerido = NULL
                     WHERE id = v_chat.id;
                    v_chat.cliente_id := (v_res->>'cliente_id')::uuid;

                    INSERT INTO public.vl_wa_avisos (tenant_id, chat_id, tipo, detalle)
                    VALUES (p_tenant_id, v_chat.id, 'vinculado_usuario',
                            'El cliente escribió su @ en el mensaje: el chat quedó vinculado a @'
                            || (v_res->>'tiktok_user') || '. Revisa que sea él.');

                ELSIF v_res->>'tipo' = 'parecido' THEN
                    UPDATE public.vl_wa_chats
                       SET cliente_sugerido = (v_res->>'cliente_id')::uuid
                     WHERE id = v_chat.id;

                    INSERT INTO public.vl_wa_avisos (tenant_id, chat_id, tipo, detalle)
                    VALUES (p_tenant_id, v_chat.id, 'usuario_sugerido',
                            'Se parece a @' || (v_res->>'tiktok_user')
                            || ': revisa el chat y, si es él, atiende con esa ficha.');
                END IF;
            END IF;
        END IF;

        IF v_chat.cliente_id IS NOT NULL THEN
            v_leido := public.vl_wa_leer_proceso_de_texto(
                p_tenant_id, v_chat.cliente_id, v_txt, v_tipo);

            -- Aviso solo si no hay uno abierto del mismo tipo (no se apilan)
            IF COALESCE(v_leido->>'aviso_tipo', '') <> ''
               AND NOT EXISTS (
                   SELECT 1 FROM public.vl_wa_avisos a
                   WHERE a.chat_id = v_chat.id
                     AND a.resuelto_en IS NULL
                     AND a.tipo = v_leido->>'aviso_tipo'
               ) THEN
                INSERT INTO public.vl_wa_avisos (tenant_id, chat_id, tipo, detalle)
                VALUES (p_tenant_id, v_chat.id,
                        v_leido->>'aviso_tipo',
                        COALESCE(v_leido->>'aviso_detalle', ''));
            END IF;
        END IF;

        -- ── FOTO mientras atiende una persona (ciclo 20261071) ──
        -- El bot cede el turno, pero una FOTO de comprobante SIEMPRE deja el aviso:
        -- es plata y hay que revisarla, aunque esté escribiendo el dueño. Se usa la
        -- MISMA señal que en el flujo automático (el bot pidió el comprobante hace
        -- poco) para no marcar como comprobante una foto de prenda.
        IF v_tipo = 'imagen' AND v_chat.cliente_id IS NOT NULL
           AND ((v_ult_out IS NOT NULL AND lower(v_ult_out) LIKE '%comprobante%')
                OR EXISTS (SELECT 1 FROM public.vl_wa_mensajes m
                            WHERE m.chat_id = v_chat.id AND m.direction = 'out'
                              AND m.creado_en > now() - interval '30 minutes'
                              AND lower(m.body) LIKE '%comprobante%'))
           AND NOT EXISTS (SELECT 1 FROM public.vl_wa_avisos a
                            WHERE a.chat_id = v_chat.id AND a.tipo = 'comprobante'
                              AND a.resuelto_en IS NULL)
        THEN
            INSERT INTO public.vl_wa_avisos (tenant_id, chat_id, tipo, detalle)
            VALUES (p_tenant_id, v_chat.id, 'comprobante',
                    'El cliente envió una foto mientras atendías tú. Puede ser el comprobante de pago: revisa tu cuenta y, si está, aprieta "Confirmar pago" en el chat.');
        END IF;

        RETURN jsonb_build_object(
            'ok', true, 'enviar', false, 'mensaje', '',
            'chat_estado', v_chat.estado, 'cliente_id', v_chat.cliente_id,
            'cliente_tiktok', '', 'proceso_estado', '', 'modo', 'humano',
            'avisar_negocio', false, 'aviso_tipo', '',
            'leido', v_leido
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
        -- ciclo 20261071: además del ÚLTIMO mensaje del bot, se mira si pidió el
        -- comprobante en los últimos 30 minutos. Antes bastaba con que el bot
        -- hubiera escrito OTRA cosa después ("serian $X … envio o presencial?")
        -- para que el comprobante se leyera como FOTO DE PRENDA. La ventana es
        -- CORTA a propósito: nunca se usa "mandó los datos de pago alguna vez"
        -- (ese fue el bug de 2026-09-12 que volvía comprobante todo pantallazo).
        v_espera_comp := (v_ult_out IS NOT NULL AND lower(v_ult_out) LIKE '%comprobante%')
            OR EXISTS (
                SELECT 1 FROM public.vl_wa_avisos a
                WHERE a.chat_id = v_chat.id
                  AND a.tipo = 'esperando_comprobante'
                  AND a.resuelto_en IS NULL
            )
            OR EXISTS (
                SELECT 1 FROM public.vl_wa_mensajes m
                WHERE m.chat_id = v_chat.id AND m.direction = 'out'
                  AND m.creado_en > now() - interval '30 minutes'
                  AND lower(m.body) LIKE '%comprobante%'
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

            v_nuevo_estado := 'habitual';

            -- VALOR / TOTAL (ciclo 20261071): el bot responde el TOTAL que lleva el
            -- cliente DESPUÉS DE CADA foto de prenda. Antes solo lo decía si la
            -- leyenda preguntaba el monto ("cuánto es el total?") y si no mandaba
            -- "gracias te lo guardamos / ¿seguirás viendo cositas?" — que es lo que
            -- vio el dueño cuando probó mandando fotos en vez de "hola".
            -- El total = prendas ADJUDICADAS del pedido abierto (lo que lleva).
            SELECT * INTO v_proc
            FROM public.vl_procesos
            WHERE cliente_id = v_chat.cliente_id AND cerrado_en IS NULL
            ORDER BY creado_en DESC
            LIMIT 1;
            SELECT COALESCE(SUM(precio - abonado), 0) INTO v_saldo
            FROM public.vl_items
            WHERE proceso_id = v_proc.id AND estado = 'adjudicada';

            -- Anti-duplicado corto: WhatsApp a veces entrega la MISMA imagen dos
            -- veces (y el cliente puede mandar 6 pantallazos seguidos). Si ya le
            -- contestamos hace menos de 45 segundos, no se le repite.
            IF v_chat.prendas_respondido_en IS NULL
               OR v_chat.prendas_respondido_en < now() - interval '45 seconds' THEN
                v_respuesta_pedida := true;   -- respuesta pedida: no la dedupe el bot

                IF v_saldo > 0 THEN
                    v_reply := public.vl_wa_variar(ARRAY['gracias bonit@ 💜 llevas ','ya bonit@, llevas ','oki bonit@, llevas '])
                        || public.vl_wa_fmt_monto(v_saldo) || ' en total'
                        || CASE WHEN v_proc.id IS NOT NULL
                                 AND NOT EXISTS (SELECT 1 FROM public.vl_envios e
                                                 WHERE e.proceso_id = v_proc.id)
                                THEN chr(10) || chr(10)
                                     || public.vl_wa_variar(ARRAY['me dices si lo quieres con envio o entrega presencial?','lo quieres con envio o prefieres entrega presencial?','envio o entrega presencial, como lo prefieras?'])
                                ELSE '' END;
                    IF v_proc.id IS NOT NULL
                       AND NOT EXISTS (SELECT 1 FROM public.vl_envios e
                                       WHERE e.proceso_id = v_proc.id) THEN
                        v_nuevo_estado := 'esperando_tipo_entrega';
                        IF v_proc.estado IN ('esperando_whatsapp', 'identificando_cliente') THEN
                            UPDATE public.vl_procesos SET estado = 'esperando_pago'
                            WHERE id = v_proc.id;
                        END IF;
                    END IF;
                ELSE
                    -- Todavía no hay prendas cargadas en la web: se confirma la foto
                    -- y se avisa que el total va en camino (el negocio la carga).
                    v_reply := public.vl_wa_variar(ARRAY['gracias bonit@ 💜','ya bonit@, quedó anotado 💜','oki bonit@ 💜'])
                        || chr(10) || chr(10)
                        || 'ya te confirmo el total en un ratito 💜';
                END IF;

                UPDATE public.vl_wa_chats
                   SET prendas_respondido_en = now()
                 WHERE id = v_chat.id;
            END IF;
        ELSE
            -- Llegó un medio que no es la prenda ni el comprobante. Dos casos:
            --   (a) ANTES de identificarse (cliente_id NULL): el bot pide el usuario
            --       del live para guardar el contacto/pedido como corresponde
            --       (antes quedaba mudo y solo dejaba el aviso "Foto para revisar").
            --   (b) ya identificado pero no sé si es prenda o comprobante: se avisa
            --       para que lo mire una persona.
            v_avisar := true;
            IF v_chat.cliente_id IS NULL THEN
                -- El bot lo resuelve: NO exige que contestes tú.
                v_avisar := false;
                v_reply := 'holis, me confirmas tu usuario del live para guardarte la prenda? porfis';
                v_nuevo_estado := 'esperando_tiktok';
            ELSIF v_tipo = 'imagen' THEN
                -- FOTO DE COMPROBANTE DE PAGO (ciclo 20261071): el bot NO ve la
                -- imagen, así que NO inventa: deja el aviso para que una persona
                -- revise si la plata está en la cuenta y apriete "Confirmar pago"
                -- (el botón ya vive en el chat), y le contesta al cliente algo
                -- neutro para que no quede colgado sin saber si se recibió.
                v_aviso_tipo := 'comprobante';
                v_aviso_unico := true;
                v_aviso_detalle := 'El cliente envió una FOTO de comprobante. Revisa si el pago está en tu cuenta y, si está, aprieta "Confirmar pago" acá en el chat (el bot no confirma solo).';
                v_reply := public.vl_wa_variar(ARRAY[
                    'ya bonit@ 💜 dejame revisarlo y te confirmo al tiro',
                    'oki bonit@ 💜 lo reviso y te confirmo al ratito']);
                v_respuesta_pedida := true;

                -- Que "Confirmar pago" quede a mano: si el pedido todavía está en
                -- una etapa previa, se mueve a esperando_pago (un comprobante
                -- significa que se está pagando).
                IF v_chat.cliente_id IS NOT NULL THEN
                    UPDATE public.vl_procesos SET estado = 'esperando_pago'
                     WHERE cliente_id = v_chat.cliente_id AND cerrado_en IS NULL
                       AND estado IN ('esperando_whatsapp', 'identificando_cliente');
                END IF;
            ELSE
                v_aviso_tipo := 'foto_dudosa';
                v_aviso_detalle := 'Llegó ' || v_tipo
                    || ' y no sé si es una prenda o un comprobante de pago. Mensaje: "'
                    || left(v_txt, 120) || '".';
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
            v_reset := true;
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
        -- (Con un reinicio EXPLÍCITO no: el cliente pidió empezar de cero.)
        IF v_chat.estado = 'nuevo' AND v_reconocido AND NOT v_reset THEN
            v_chat.estado := 'habitual';
        END IF;

        IF v_chat.estado = 'nuevo' THEN
            v_reply := public.vl_wa_variar(ARRAY['holis, me das tu nombre de usuario en el live porfis?','holis! me pasas tu usuario del live porfis?','hola, me confirmas tu nombre de usuario en el live?']);
            v_nuevo_estado := 'esperando_tiktok';

        -- PASO 1b: cliente habitual reconocido por su WhatsApp
        ELSIF v_chat.estado = 'habitual' THEN
            v_nuevo_estado := 'habitual';

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

                -- MEJORA (F): si el cliente escribió su @ acá (con arroba) y es una
                -- versión más completa del guardado, se corrige la ficha (se anotó
                -- "anubis" y él escribe "@anubisss").
                IF position('@' in v_txt) > 0 THEN
                    v_cand_txt := (regexp_match(v_txt, '@([A-Za-z0-9._]{3,40})'))[1];
                    IF v_cand_txt IS NOT NULL THEN
                        v_user_nuevo := public.vl_wa_corregir_usuario(
                                            p_tenant_id, v_cli.id, v_cand_txt);
                        IF v_user_nuevo IS NOT NULL THEN
                            v_cli.tiktok_user := v_user_nuevo;
                            v_avisar := true;
                            v_aviso_tipo := 'usuario_corregido';
                            v_aviso_unico := true;
                            v_aviso_detalle := 'El cliente escribió su @ real: la ficha quedó como @'
                                || v_user_nuevo || '. Revisa que sea la persona correcta.';
                        END IF;
                    END IF;
                END IF;

                -- MEJORA (4): saludo que ABRE la conversación. Si debe plata, además
                -- de saludar se le ofrece de inmediato qué quiere saber.
                IF v_es_saludo
                   AND (v_chat.saludo_habitual_en IS NULL
                        OR v_chat.saludo_habitual_en < now() - interval '6 hours') THEN
                    v_reply := 'holis bonit@';
                    IF v_saldo > 0 THEN
                        v_reply := v_reply || ' 💜 quieres que te recuerde el valor de tus prendas o te paso los datos para transferir?';
                    END IF;
                    UPDATE public.vl_wa_chats
                       SET saludo_habitual_en = now()
                     WHERE id = v_chat.id;
                END IF;

                IF v_saldo > 0 AND (v_low ~ 'datos|cuenta|rut|transferir|transferencia|banco|deposito|depósito' AND NOT v_cli_datos) THEN
                    -- Pidió los datos para transferir: se los manda SIEMPRE, las
                    -- veces que los pida (el bot tiene la información: pedido del
                    -- dueño). Antes el 3er argumento estaba en `false` y el cliente
                    -- quedaba sin datos + mudo (bug real de producción).
                    v_bloque := public.vl_wa_bloque_pago_para(p_tenant_id, v_chat.id, true);
                    v_respuesta_pedida := true;
                    -- Cliente que vuelve: si ESTE pedido todavía no tiene entrega
                    -- decidida, se lo pregunta en el mismo mensaje.
                    IF v_proc.id IS NOT NULL
                       AND NOT EXISTS (SELECT 1 FROM public.vl_envios e
                                       WHERE e.proceso_id = v_proc.id) THEN
                        v_preg_entrega := chr(10) || public.vl_wa_variar(ARRAY['me dices si lo quieres con envio o entrega presencial?','lo quieres con envio o prefieres entrega presencial?','envio o entrega presencial, como lo prefieras?']);
                    END IF;
                    v_reply := public.vl_wa_variar(ARRAY['claro bonit@, aqui los tienes 👇','dale, aqui te los dejo 👇','ahi van los datos 👇'])
                        || chr(10) || chr(10) || 'serian ' || public.vl_wa_fmt_monto(v_saldo) || ' su total'
                        || CASE WHEN v_bloque <> ''
                                THEN chr(10) || chr(10) || v_bloque
                                ELSE '' END
                        || v_preg_entrega
                        || chr(10) || chr(10)
                        || public.vl_wa_variar(ARRAY['me manda el comprobante cuando pueda porfis','me dejas el comprobante porfis cuando puedas','manda el comprobante cuando puedas 💜','quedo atenta al comprobante porfis']);

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
                      AND v_low ~ 'cuanto|cuánto|total|saldo|valor|precio|debo' THEN
                    -- Pidió el valor: se lo dice Y pregunta entrega/envío para este
                    -- pedido (antes quedaba sin saber cómo se lo va a mandar).
                    v_reply := 'serian ' || public.vl_wa_fmt_monto(v_saldo)
                        || chr(10) || chr(10)
                        || public.vl_wa_variar(ARRAY['me dices si lo quieres con envio o entrega presencial?','lo quieres con envio o prefieres entrega presencial?','envio o entrega presencial, como lo prefieras?']);
                    v_respuesta_pedida := true;
                    IF v_proc.id IS NOT NULL
                       AND NOT EXISTS (SELECT 1 FROM public.vl_envios e
                                       WHERE e.proceso_id = v_proc.id) THEN
                        v_nuevo_estado := 'esperando_tipo_entrega';
                        IF v_proc.estado IN ('esperando_whatsapp', 'identificando_cliente') THEN
                            UPDATE public.vl_procesos SET estado = 'esperando_pago'
                            WHERE id = v_proc.id;
                        END IF;
                    END IF;

                -- MEJORA (5): escribió algo que el bot no sabe responder (una excusa,
                -- un tema suelto) y hay un pedido en curso: el bot NO inventa nada,
                -- queda el aviso para que conteste una persona ("Contesta tú").
                ELSIF v_proc.id IS NOT NULL
                      AND NOT v_es_saludo
                      AND v_low !~ '^(ok|okey|okay|dale|gracias|graci|muchas|muchisimas|jaja|jeje|si|sii+|sip|no|nop|ya|listo|hola|holi|holis|holas|buenas|buenos|hey|hi|perfecto|genial|buenisimo|buenísimo|excelente|cuidate|chao|adios|nos vemos|buen dia|buenas noches|buenas tardes)'
                THEN
                    v_avisar := true;
                    v_aviso_tipo := 'no_entendido';
                    v_aviso_unico := true;
                    v_aviso_detalle := 'El cliente escribió algo que el bot no sabe responder ("'
                        || left(v_txt, 80) || '"). Contesta tú.';
                END IF;
            END IF;

        -- PASO 2: identificar cliente (usuario TikTok exacto o parecido)
        -- PASO 2: identificar cliente (usuario TikTok). Busca SOLO entre los
        -- clientes que ya compraron algo (o son antiguos con alguna compra).
        -- Nunca deja afuera a alguien que escribió parecido: le muestra los
        -- parecidos numerados y él confirma cuál es (número, "si soy" o su @).
        ELSIF v_chat.estado IN ('esperando_tiktok', 'esperando_confirmar_usuario') THEN

            v_intentar := false;

            IF v_chat.estado = 'esperando_tiktok' THEN
                v_intentar := true;
            ELSE
                -- Esperando que elija entre los candidatos que le mostramos.
                -- (a) eligió por NÚMERO ("1", "2", "soy el 2", "opción 3")
                v_num := NULL;
                IF char_length(v_txt) <= 25 THEN
                    v_num := NULLIF((regexp_match(v_low, '(^|[^a-z0-9])([1-9])([^0-9]|$)'))[2], '')::int;
                END IF;

                IF v_num IS NOT NULL AND v_chat.usuario_candidatos IS NOT NULL
                   AND jsonb_array_length(v_chat.usuario_candidatos) >= v_num THEN
                    v_pick := v_chat.usuario_candidatos -> (v_num - 1);
                    SELECT * INTO v_cli
                    FROM public.vl_clientes
                    WHERE id = (v_pick->>'cliente_id')::uuid AND tenant_id = p_tenant_id;
                    IF v_cli.id IS NULL THEN v_intentar := true; END IF;

                ELSIF v_low ~ '^(si|s|sii+|sip|sipi|claro|yes|yep|eso|esa|ese|ese mismo|esa misma|correcto|exacto|aja|ajá|ok|okey|dale|obvio|soy|soy ese|soy esa|si soy|si soy el|si ese|si esa)'
                THEN
                    -- Dijo que SÍ: vale el sugerido; si hay lista, el primero.
                    SELECT * INTO v_cli
                    FROM public.vl_clientes
                    WHERE id = COALESCE(v_chat.cliente_sugerido,
                                        CASE WHEN v_chat.usuario_candidatos IS NOT NULL
                                              AND jsonb_array_length(v_chat.usuario_candidatos) >= 1
                                             THEN ((v_chat.usuario_candidatos -> 0) ->> 'cliente_id')::uuid
                                             ELSE NULL END)
                      AND tenant_id = p_tenant_id;

                    IF v_cli.id IS NULL THEN
                        v_intentar := true;   -- el sugerido ya no existe
                    ELSIF v_chat.usuario_candidato IS NOT NULL THEN
                        -- MEJORA (F): confirmó. Si en su mensaje trajo su @ real y es
                        -- una versión más completa del que teníamos (se anotó
                        -- "anubis" y él es "anubisss"), se corrige la ficha.
                        v_user_nuevo := public.vl_wa_corregir_usuario(
                                            p_tenant_id, v_cli.id, v_chat.usuario_candidato);
                        IF v_user_nuevo IS NOT NULL THEN
                            v_cli.tiktok_user := v_user_nuevo;
                            v_avisar := true;
                            v_aviso_tipo := 'usuario_corregido';
                            v_aviso_unico := true;
                            v_aviso_detalle := 'El cliente confirmó y escribió su @ real: la ficha quedó como @'
                                || v_user_nuevo || '. Revisa que sea la persona correcta.';
                        END IF;
                    END IF;

                ELSIF v_low ~ '^(no|nop|nope|nel|nunca|otro|otra|ningun|ninguna|no se|nose|nada|ninguno de esos|ninguna de esas)'
                THEN
                    -- Dijo que NO: se suelta la lista y se le pide el usuario de nuevo.
                    UPDATE public.vl_wa_chats
                    SET cliente_sugerido = NULL, usuario_candidato = NULL, usuario_candidatos = NULL
                    WHERE id = v_chat.id;

                    v_avisar := true;
                    v_aviso_tipo := 'usuario_no_confirmado';
                    v_aviso_unico := true;
                    v_aviso_detalle := 'El cliente dijo que NO es ninguno de los usuarios que le propusimos: "'
                        || left(v_txt, 60) || '". Revisar a mano.';

                    -- NADA MÁS: si ya le mostramos opciones varias veces y sigue sin
                    -- ser ninguno de los que existen, se corta (no ahuyentar con un
                    -- bucle). Responde una persona; aviso "Contesta tú".
                    IF v_chat.usuario_intentos >= 3 THEN
                        UPDATE public.vl_wa_chats SET estado = 'listo' WHERE id = v_chat.id;
                        v_nuevo_estado := 'listo';
                        v_reply := public.vl_wa_variar(ARRAY[
                            'okis, lo reviso y te confirmo al ratito 💜',
                            'ya bonit@, dejame confirmarte eso al ratito 💜']);
                        v_aviso_tipo := 'no_entendido';
                        v_aviso_detalle := 'El cliente no se identificó entre los usuarios/cliente que existen tras varios intentos ("'
                            || left(v_txt, 60) || '"). Contesta tú.';
                    ELSE
                        v_reply := 'okis, me lo escribes de nuevo porfis?';
                        v_nuevo_estado := 'esperando_tiktok';
                    END IF;
                ELSE
                    -- Escribió otro usuario (o su @ real): se reintenta con ese texto.
                    v_intentar := true;
                END IF;
            END IF;

            IF v_intentar THEN
                -- Contador de intentos (guard anti-bucle).
                UPDATE public.vl_wa_chats
                SET usuario_intentos = usuario_intentos + 1
                WHERE id = v_chat.id;

                v_res := public.vl_wa_resolver_usuario(p_tenant_id, v_txt);

                -- Segundo intento con los mensajes anteriores, SOLO si este mensaje
                -- no traía nada usable (un tramo suelto: "soy", "mi usuario es",
                -- "aquí"). Así no se mezclan mensajes viejos de otro tema.
                IF v_res->>'tipo' = 'ninguno'
                   AND array_length(public.vl_wa_candidatos_usuario(v_txt), 1) <= 1
                   AND btrim(COALESCE(v_textos_prev, '')) <> '' THEN
                    v_buscar := btrim(v_textos_prev || ' ' || v_txt);
                    v_res := public.vl_wa_resolver_usuario(p_tenant_id, v_buscar);
                END IF;

                IF v_res->>'tipo' = 'exacto' THEN
                    SELECT * INTO v_cli
                    FROM public.vl_clientes
                    WHERE id = (v_res->>'cliente_id')::uuid;

                ELSIF v_res->>'tipo' = 'parecido' THEN
                    -- Lista de parecidos. Un solo candidato -> "eres @x?". Varios ->
                    -- se los muestra numerados y el cliente elige.
                    v_matches := COALESCE(v_res->'matches', '[]'::jsonb);
                    v_n := COALESCE(jsonb_array_length(v_matches), 0);

                    UPDATE public.vl_wa_chats
                    SET usuario_candidato = v_res->>'candidato',
                        usuario_candidatos = CASE WHEN v_n > 1 THEN v_matches ELSE NULL END,
                        cliente_sugerido = CASE WHEN v_n = 1
                                                THEN ((v_matches -> 0) ->> 'cliente_id')::uuid
                                                ELSE NULL END
                    WHERE id = v_chat.id;

                    IF v_n <= 1 THEN
                        v_reply := 'eres @' || (v_res->>'tiktok_user') || '?';
                    ELSE
                        v_lista_txt := '';
                        FOR v_num IN 0 .. v_n - 1 LOOP
                            v_lista_txt := v_lista_txt || chr(10) || (v_num + 1) || ') @'
                                || (v_matches -> v_num ->> 'tiktok_user')
                                || CASE WHEN btrim(COALESCE(v_matches -> v_num ->> 'nombre_real', '')) <> ''
                                        THEN ' (' || (v_matches -> v_num ->> 'nombre_real') || ')' ELSE '' END;
                        END LOOP;
                        v_reply := '¿eres alguno de estos?' || chr(10) || v_lista_txt || chr(10) || chr(10)
                            || 'respóndeme con el número o tu usuario del live porfis';
                    END IF;
                    v_nuevo_estado := 'esperando_confirmar_usuario';

                ELSE
                    -- Nada parecido entre los que ya compraron. En vez de "escríbelo
                    -- tal cual", se le muestran los últimos clientes con compra para
                    -- que diga cuál es. Si de verdad es una compra nueva, no estará y
                    -- recién ahí se le pide el usuario de nuevo.
                    -- Solo se queda callado si de verdad escribió un tramo suelto
                    -- ("soy", "mi usuario es", "aqui"). Cualquier otra cosa que no
                    -- calce se le muestra la lista de los que SÍ existen.
                    IF array_length(public.vl_wa_candidatos_usuario(v_txt), 1) <= 1
                       AND btrim(v_low_limpio) ~ '^(soy|mi|mis|el|la|los|las|un|una|usuario|usuaria|user|cuenta|perfil|tiktok|tik|tok|nombre|me|llamo|llaman|aqui|aca|este|esta|esto|es|eres|seria|sera|en|con|por|para|de|del|al)(\s|$)'
                    THEN
                        v_avisar := true;
                        v_aviso_tipo := 'no_entendido';
                        v_aviso_unico := true;
                        v_aviso_detalle := 'El cliente escribió algo incompleto esperando su usuario ("'
                            || left(v_txt, 80) || '"). No le repetí la pregunta para no ser redundante.';
                        v_nuevo_estado := 'esperando_tiktok';
                    ELSE
                        v_matches := public.vl_wa_clientes_para_elegir(p_tenant_id, 5);
                        v_n := COALESCE(jsonb_array_length(v_matches), 0);
                        IF v_n >= 1 THEN
                            UPDATE public.vl_wa_chats
                            SET usuario_candidatos = v_matches, cliente_sugerido = NULL,
                                usuario_candidato = v_res->>'candidato'
                            WHERE id = v_chat.id;

                            v_lista_txt := '';
                            FOR v_num IN 0 .. v_n - 1 LOOP
                                v_lista_txt := v_lista_txt || chr(10) || (v_num + 1) || ') @'
                                    || (v_matches -> v_num ->> 'tiktok_user');
                            END LOOP;
                            v_reply := 'no te encontré con ese usuario 😕 ¿eres alguno de estos?'
                                || chr(10) || v_lista_txt || chr(10) || chr(10)
                                || 'respóndeme con el número o tu usuario del live porfis';
                            v_nuevo_estado := 'esperando_confirmar_usuario';

                            v_avisar := true;
                            v_aviso_tipo := 'usuario_no_encontrado';
                            v_aviso_unico := true;
                            v_aviso_detalle := 'No se encontró ningún usuario parecido a "'
                                || left(v_txt, 60) || '". Se le mostraron los últimos clientes con compra para que elija. Revisar a mano.';
                        ELSE
                            v_reply := public.vl_wa_variar(ARRAY[
                                'no veo compras a tu nombre todavía 😕 me repites tu usuario del live porfis?',
                                'no tengo ninguna compra con ese usuario 😕 me lo escribes de nuevo porfis?']);
                            v_nuevo_estado := 'esperando_tiktok';

                            v_avisar := true;
                            v_aviso_tipo := 'usuario_no_encontrado';
                            v_aviso_unico := true;
                            v_aviso_detalle := 'No se encontró ningún parecido a "'
                                || left(v_txt, 60) || '" y no hay ningún cliente/cliente que haya comprado. Revisar a mano.';
                        END IF;
                    END IF;
                END IF;
            END IF;

            -- Cliente identificado (exacto o confirmado): mismo flujo para ambos
            IF v_cli.id IS NOT NULL THEN
                UPDATE public.vl_wa_chats
                SET usuario_candidatos = NULL, usuario_intentos = 0
                WHERE id = v_chat.id;

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

            ELSIF v_low ~ 'pres|entrega|retiro|retirar|persona|local|buscar|paso a|pasar a|voy por|en mano|vernos|nos vemos|junta|acerc|tienda'
                  AND v_low !~ 'env|despacho|domicilio|a (mi|la) casa|courier|blue|paket|packet|paquet|starken|chilexpress'
            THEN
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
                PERFORM public.vl_wa_registrar_entrega(p_tenant_id, v_cli.id, 'presencial', v_fecha_dicha,
                    public.vl_wa_fecha_programada(v_txt));

                -- MEJORA: si el pedido YA está pagado y sin saldo, el dato que dio el
                -- cliente mueve el proceso solo a la etapa de entrega: el botón
                -- "Marcar entregado" queda disponible de inmediato (antes había que
                -- repetir "Decidir entrega" a mano en el panel).
                IF v_proc.id IS NOT NULL
                   AND v_proc.estado IN ('pagado', 'acumulando')
                   AND COALESCE(v_saldo, 0) <= 0 THEN
                    UPDATE public.vl_procesos SET estado = 'entrega_presencial'
                    WHERE id = v_proc.id;
                END IF;

                v_avisar := true;
                v_aviso_tipo := 'entrega_presencial';
                v_aviso_unico := true;
                v_aviso_detalle := 'Eligió entrega presencial. '
                    || CASE WHEN v_fecha_dicha <> ''
                            THEN 'Dijo: "' || v_fecha_dicha || '".'
                            ELSE 'Todavía no dijo fecha.' END
                    || ' Coordinar con @' || COALESCE(v_cli.tiktok_user, '') || '.';

                -- PAGO: por defecto TRANSFERENCIA (dato del dueño: "ideal que todo se
                -- transfiera"). Solo se ofrece pagar en persona si el cliente lo pide
                -- explícito (efectivo / al recibir / contra entrega / "pago cuando
                -- nos veamos" / en mano / "te pago al vernos").
                v_bloque := public.vl_wa_bloque_pago_para(p_tenant_id, v_chat.id, false);
                v_respuesta_pedida := true;
                v_reply := 'okis bonit@ 💜 ' || v_horario
                    || CASE WHEN v_total_ok
                            THEN chr(10) || chr(10) || 'serian ' || public.vl_wa_fmt_monto(v_saldo) || ' su total'
                            ELSE '' END
                    || CASE WHEN v_bloque <> ''
                            THEN (CASE WHEN v_total_ok THEN ', ' ELSE chr(10) || chr(10) END)
                                 || 'le dejo mis datitos' || chr(10) || chr(10) || v_bloque
                            ELSE '' END
                    || chr(10) || chr(10)
                    || CASE WHEN v_low ~ 'efectivo|en persona|al recibir|contra ?entrega|cuando nos veamos|cuando te vea|en mano|al momento|te pago cuando|pago cuando|pagar cuando|pago al|pagar al|luego te pago|despu[eé]s te pago'
                            THEN 'puede transferir ahora o pagar cuando nos veamos...'
                            ELSE public.vl_wa_variar(ARRAY['me manda el comprobante cuando pueda porfis','me dejas el comprobante porfis cuando puedas','manda el comprobante cuando puedas 💜','quedo atenta al comprobante porfis']) END
                    || CASE WHEN v_fecha_dicha = ''
                            THEN chr(10) || chr(10) || 'que dia y a que hora te queda bien para la entrega?'
                            ELSE '' END;
                v_nuevo_estado := 'esperando_forma_pago';

            ELSIF v_low ~ 'env|despacho|domicilio|a (mi|la) casa|courier|blue|paket|packet|paquet|starken|chilexpress' THEN
                UPDATE public.vl_clientes SET entrega_preferida = 'envio'
                WHERE id = v_cli.id;

                SELECT * INTO v_proc
                FROM public.vl_procesos
                WHERE cliente_id = v_cli.id AND cerrado_en IS NULL
                LIMIT 1;
                SELECT COALESCE(SUM(precio - abonado), 0) INTO v_saldo
                FROM public.vl_items
                WHERE proceso_id = v_proc.id AND estado = 'adjudicada';

                -- MEJORA: mismo criterio que el presencial: si ya está pagado y sin
                -- saldo, el proceso pasa a "listo para preparar" y el botón
                -- "Marcar ENVÍO CREADO" aparece sin repetir la decisión.
                IF v_proc.id IS NOT NULL
                   AND v_proc.estado IN ('pagado', 'acumulando')
                   AND COALESCE(v_saldo, 0) <= 0 THEN
                    UPDATE public.vl_procesos SET estado = 'listo_preparar'
                    WHERE id = v_proc.id;
                END IF;

                -- Registro temprano: el envío aparece en el bloque de entregas
                -- como "esperando confirmación de pago" (sin acciones aún).
                PERFORM public.vl_wa_registrar_entrega(
                    p_tenant_id, v_cli.id, 'envio', public.vl_wa_fecha_mencion(v_txt),
                    public.vl_wa_fecha_programada(v_txt));

                -- CLIENTE QUE VUELVE: si ya tiene dirección guardada de una compra
                -- anterior se le PROPONE reusarla (no se le vuelve a pedir todo como
                -- si fuera nuevo). Si es la primera vez, se le piden los datos.
                v_dir_prev := btrim(COALESCE(v_cli.datos_envio, '') || ' '
                    || COALESCE(v_cli.direccion, '') || ' '
                    || COALESCE(v_cli.comuna, '') || ' ' || COALESCE(v_cli.ciudad, ''));
                IF char_length(v_dir_prev) >= 12 THEN
                    v_reply := 'okis, te lo mando a la misma direccion de siempre? ('
                        || left(v_dir_prev, 200)
                        || ') me lo confirmas y de paso si el envio es por blue o paket porfis...';
                    v_nuevo_estado := 'esperando_confirmar_direccion';

                ELSE
                -- ciclo 20261071: ya NO se pregunta "¿o prefieres seguir juntando
                -- prenditas?" cuando el cliente ACABA de elegir envío (parecía que
                -- el bot no lo había escuchado). Se piden los datos y el courier.
                v_reply := 'okis, te lo mando 💜 me dejas tus datitos: nombre, direccion, comuna, contacto y correo, y me dices si el envio es por blue o paket porfis';
                v_nuevo_estado := 'esperando_datos_envio';
                END IF;

            ELSIF (v_low ~ 'datos|cuenta|rut|cuanto|cuánto|total|saldo|valor|precio|debo|transfer|deposit|pagar' AND NOT v_cli_datos)
               OR v_low ~ 'ya (te )?(pague|pagué|transferi|transferí)' THEN
                -- Está en el paso de elegir entrega y en vez de eso pide los datos,
                -- el monto o dice que ya pagó: se le responde SIEMPRE (antes quedaba
                -- mudo: se reprodujo con el chat real de @anubisss) y se le repite la
                -- pregunta de envío o presencial.
                SELECT * INTO v_proc
                FROM public.vl_procesos
                WHERE cliente_id = v_chat.cliente_id AND cerrado_en IS NULL
                LIMIT 1;

                SELECT COALESCE(SUM(precio - abonado), 0) INTO v_saldo
                FROM public.vl_items
                WHERE proceso_id = v_proc.id AND estado = 'adjudicada';

                IF v_low ~ 'ya (te )?(pague|pagué|transferi|transferí)|transfer|deposit|abon' THEN
                    v_avisar := true;
                    v_aviso_tipo := 'pago';
                    v_aviso_unico := true;
                    v_aviso_detalle := 'El cliente dice que pagó. Revisa y confirma el pago para proseguir. Mensaje: "'
                        || left(v_txt, 200) || '"';
                END IF;

                -- DIRECTO: no se repite todo. Si PIDE LOS DATOS se los deja (aunque
                -- ya los tenga: los volvió a pedir). Si dice que ya pagó, se le pide
                -- el comprobante. Si solo pregunta el MONTO, se contesta el monto.
                v_respuesta_pedida := true;
                IF (v_low ~ 'datos|cuenta|rut|banco|transferir|transferencia|deposit|depósito' AND NOT v_cli_datos) THEN
                    v_bloque := public.vl_wa_bloque_pago_para(p_tenant_id, v_chat.id, true);
                    v_reply := public.vl_wa_variar(ARRAY['claro bonit@, aqui los tienes 👇','dale, aqui te los dejo 👇','ahi van los datos 👇'])
                        || CASE WHEN v_saldo > 0
                                THEN chr(10) || chr(10) || 'serian ' || public.vl_wa_fmt_monto(v_saldo) || ' su total'
                                ELSE '' END
                        || CASE WHEN v_bloque <> ''
                                THEN chr(10) || chr(10) || v_bloque
                                ELSE '' END
                        || chr(10) || chr(10) || public.vl_wa_variar(ARRAY['me manda el comprobante cuando pueda porfis','me dejas el comprobante porfis cuando puedas','manda el comprobante cuando puedas 💜','quedo atenta al comprobante porfis']);
                ELSIF v_low ~ 'ya (te )?(pague|pagué|transferi|transferí)|abon' THEN
                    v_reply := public.vl_wa_variar(ARRAY['genial bonit@ 💜 me manda el comprobante cuando pueda porfis','perfecto bonit@ 💜 quedo atenta al comprobante','buenisimo 💜 mandame el comprobante cuando puedas']);
                ELSIF v_low ~ 'quiero pagar|voy a pagar|puedo pagar|como pago|c[oó]mo pago|te pago|quiero abonar' THEN
                    v_reply := '¿quieres que te deje los datos o me mandas el comprobante bonit@?';
                    v_avisar := true;
                    v_aviso_tipo := 'esperando_comprobante';
                    v_aviso_unico := true;
                    v_aviso_detalle := 'El cliente quiere pagar. Espera el comprobante o mándale los datos si te los pide.';
                ELSE
                    v_reply := 'serian ' || public.vl_wa_fmt_monto(v_saldo);
                END IF;

                -- La pregunta de envío o presencial solo si todavía NO eligió.
                IF v_proc.id IS NULL
                   OR NOT EXISTS (SELECT 1 FROM public.vl_envios e WHERE e.proceso_id = v_proc.id) THEN
                    v_reply := v_reply || chr(10) || chr(10)
                        || public.vl_wa_variar(ARRAY['me dices si lo quieres con envio o entrega presencial?','lo quieres con envio o prefieres entrega presencial?','envio o entrega presencial, como lo prefieras?']);
                END IF;
                v_nuevo_estado := 'esperando_tipo_entrega';

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

            -- Si avisa que pagó MIENTRAS deja los datos, no se lo traga como si
            -- fuera una dirección: avisa al negocio y le pide el comprobante.
            IF v_cli.id IS NOT NULL
               AND v_low ~ 'ya (te )?(pague|pagué|transferi|transferí|deposit)|te mande el comprobante|ahi te mando el comprobante|te paso el comprobante' THEN
                v_avisar := true;
                v_aviso_tipo := 'pago';
                v_aviso_unico := true;
                v_aviso_detalle := 'El cliente dice que pagó (mientras se le pedían los datos de envío). Revisa y confirma. Mensaje: "'
                    || left(v_txt, 160) || '".';
            END IF;

            -- MEJORA: si dice que quiere seguir juntando prendas, queda el aviso para
            -- que el negocio lo pase a "acumulando" (Procesos → Decidir entrega →
            -- acumular). Antes esa intención se perdía.
            IF v_cli.id IS NOT NULL
               AND v_low ~ 'acumul|juntar|juntando|guardar|guardame|m[aá]s prendas|sigo comprando|otra prenda|otras prendas' THEN
                v_avisar := true;
                v_aviso_tipo := 'cliente_acumula';
                v_aviso_unico := true;
                v_aviso_detalle := 'El cliente quiere seguir juntando prendas (no cerrar el pedido todavía). Mensaje: "'
                    || left(v_txt, 120) || '".';
            END IF;

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

                IF v_cli_datos AND v_txt !~ '@' AND v_txt !~ '[0-9]{4,}' THEN
                    -- AVISA que manda sus datos (todavía no los mandó): se le pide SU
                    -- data; NUNCA se le responde con los datos de pago del negocio.
                    v_reply := public.vl_wa_variar(ARRAY[
                        'okis bonit@ 💜 mandame TUS datos (nombre, direccion, comuna, contacto, correo) y te lo envio por blue o paket',
                        'dale bonit@ 💜 con tus datos (nombre, direccion, comuna, contacto, correo) hago el envio por blue o paket']);

                ELSIF v_solo_courier THEN
                    v_courier := CASE WHEN v_low LIKE '%blue%' THEN 'blue' ELSE 'paket' END;
                    UPDATE public.vl_clientes SET courier = v_courier WHERE id = v_cli.id;
                    PERFORM public.vl_wa_registrar_entrega(p_tenant_id, v_cli.id, 'envio', '',
                        public.vl_wa_fecha_programada(v_txt));

                ELSIF v_low ~ 'acumul|juntar|juntando|sigo comprando|m[aá]s adelante|a fin de mes|fin de mes|otro d[ií]a|despu[eé]s|despues|todav[ií]a no|a[uú]n no|te aviso|lo pienso|m[aá]s tarde'
                      AND v_txt !~ '@' AND v_txt !~ '[0-9]{4,}' THEN
                    -- Pospone / quiere seguir juntando prendas: NO es una dirección.
                    -- Antes ese texto se guardaba como datos_envio (bug real 2026-10-07:
                    -- "Seguir juntando prendas te puedo pagar a fin de mes?").
                    v_reply := public.vl_wa_variar(ARRAY[
                        'okis bonit@ 💜 cuando quieras cerramos y coordinamos la entrega',
                        'ya bonit@, me avisas cuando quieras que te lo envie 💜']);

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

                    -- ¿Ya hay datos DE VERDAD (no charla)? Correo, teléfono, o un
                    -- texto con número y varias palabras (una dirección), o con el
                    -- courier y varias palabras. Antes bastaba con 25 caracteres y
                    -- la charla ("Mis datos, déjeme hacerle su pago") cerraba el paso
                    -- sin datos y después se perdía la dirección de verdad.
                    v_completo := v_correo <> ''
                        OR v_contacto <> ''
                        OR (btrim(v_datos_prev) ~ '[0-9]'
                            AND array_length(regexp_split_to_array(btrim(v_datos_prev), '\s+'), 1) >= 3)
                        OR ((v_low LIKE '%blue%' OR v_low ~ 'paket|packet|paquet')
                            AND array_length(regexp_split_to_array(btrim(v_datos_prev), '\s+'), 1) >= 3);
                END IF;

                IF v_completo THEN
                -- La elección de courier también queda en el bloque de entregas,
                -- con la fecha si el cliente la mencionó en el mismo mensaje.
                v_fecha_dicha := public.vl_wa_fecha_mencion(v_txt);
                PERFORM public.vl_wa_registrar_entrega(p_tenant_id, v_cli.id, 'envio', v_fecha_dicha,
                    public.vl_wa_fecha_programada(v_txt));

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

                v_reenviar := (v_low ~ 'datos|cuenta|rut' AND NOT v_cli_datos);
                v_bloque := public.vl_wa_bloque_pago_para(p_tenant_id, v_chat.id, v_reenviar);

                v_reply := CASE WHEN v_total_ok
                        THEN 'gracias serian ' || public.vl_wa_fmt_monto(v_saldo + v_extra) || ' su total'
                        ELSE 'gracias bonit@' END
                    || CASE WHEN v_bloque <> ''
                            THEN (CASE WHEN v_total_ok THEN ', ' ELSE chr(10) || chr(10) END)
                                 || 'le dejo mis datitos' || chr(10) || chr(10) || v_bloque
                            ELSE '' END
                    || chr(10) || chr(10)
                    || public.vl_wa_variar(ARRAY['me manda el comprobante cuando pueda porfis','me dejas el comprobante porfis cuando puedas','manda el comprobante cuando puedas 💜','quedo atenta al comprobante porfis']);

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

        -- PASO 4b: el cliente que vuelve confirma la dirección de siempre
        -- (envío con datos ya guardados). No se le vuelve a pedir todo.
        ELSIF v_chat.estado = 'esperando_confirmar_direccion' THEN
            SELECT * INTO v_cli FROM public.vl_clientes WHERE id = v_chat.cliente_id;

            IF v_cli.id IS NULL THEN
                v_nuevo_estado := 'listo';
                v_avisar := true;
                v_aviso_tipo := 'sin_cliente';
                v_aviso_detalle := 'La conversación perdió el vínculo con el cliente en la confirmación de dirección. Revisar a mano.';

            ELSE
                -- El courier puede venir en el mismo mensaje ("si, por blue").
                v_courier := '';
                IF v_low LIKE '%blue%' THEN
                    v_courier := 'blue';
                ELSIF v_low ~ 'paket|packet|paquet' THEN
                    v_courier := 'paket';
                END IF;

                IF v_low ~ '^(no|nop|nope|nel|otra|otro|nueva|nuevo|distinta|distinto|cambiar|cambia|diferente|esa no|no es)' THEN
                    -- Quiere otra dirección: se le piden los datos de nuevo.
                    v_reply := 'okis, me dejas los datitos porfis: nombre, direccion, comuna, contacto, correo, y si el envio es por blue o paket...';
                    v_nuevo_estado := 'esperando_datos_envio';

                ELSIF v_low ~ '^(si|sip|sipis|sii+|claro|ok|okey|okay|dale|yes|esa|misma|mismo|confirmo|confirmado|correcto|exacto|perfecto|de una|asi es|así es)'
                      OR v_courier <> ''
                      OR char_length(btrim(v_txt)) <= 20 THEN
                    -- Confirma la dirección de siempre (o solo dijo el courier).
                    IF v_courier <> '' THEN
                        UPDATE public.vl_clientes SET courier = v_courier WHERE id = v_cli.id;
                    END IF;

                    v_fecha_dicha := public.vl_wa_fecha_mencion(v_txt);
                    PERFORM public.vl_wa_registrar_entrega(
                        p_tenant_id, v_cli.id, 'envio', COALESCE(v_fecha_dicha, ''),
                        public.vl_wa_fecha_programada(v_txt));

                    SELECT * INTO v_cli FROM public.vl_clientes WHERE id = v_cli.id;

                    SELECT * INTO v_proc
                    FROM public.vl_procesos
                    WHERE cliente_id = v_cli.id AND cerrado_en IS NULL
                    LIMIT 1;
                    SELECT COALESCE(SUM(precio - abonado), 0) INTO v_saldo
                    FROM public.vl_items
                    WHERE proceso_id = v_proc.id AND estado = 'adjudicada';

                    IF COALESCE(v_cli.courier, '') = '' THEN
                        v_reply := 'okis, y el envio por blue o paket?';
                        v_nuevo_estado := 'esperando_confirmar_direccion';

                    ELSE
                        IF v_proc.id IS NOT NULL
                           AND v_proc.estado IN ('esperando_whatsapp', 'identificando_cliente') THEN
                            UPDATE public.vl_procesos SET estado = 'esperando_pago'
                            WHERE id = v_proc.id;
                        END IF;

                        -- El bloque de datos solo si no se lo mandamos antes en esta
                        -- conversación (antes se re-pegaba siempre).
                        v_bloque := public.vl_wa_bloque_pago_para(p_tenant_id, v_chat.id, false);
                        v_respuesta_pedida := true;
                        v_reply := 'genial bonit@, queda a la misma direccion 💜'
                            || CASE WHEN v_saldo > 0 AND v_total_ok
                                    THEN chr(10) || chr(10) || 'serian ' || public.vl_wa_fmt_monto(v_saldo) || ' su total'
                                    ELSE '' END
                            || CASE WHEN v_bloque <> ''
                                    THEN (CASE WHEN v_saldo > 0 AND v_total_ok THEN ', ' ELSE chr(10) || chr(10) END) || v_bloque
                                    ELSE '' END
                            || chr(10) || chr(10)
                            || public.vl_wa_variar(ARRAY['me manda el comprobante cuando pueda porfis','me dejas el comprobante porfis cuando puedas','manda el comprobante cuando puedas 💜','quedo atenta al comprobante porfis']);

                        v_avisar := true;
                        v_aviso_tipo := CASE WHEN v_cli.courier = 'paket'
                                             THEN 'entrega_paket' ELSE 'entrega_blue' END;
                        v_aviso_unico := true;
                        v_aviso_detalle := 'Cliente que vuelve: eligió envío por '
                            || CASE WHEN v_cli.courier = 'paket' THEN 'Paket' ELSE 'Blue Express' END
                            || ' a la MISMA dirección de siempre. '
                            || CASE WHEN v_cli.courier = 'paket'
                                    THEN 'Pedirlo antes de las 23:59 del día anterior.'
                                    ELSE 'Crear el pedido en Blue (el envío se paga al recibir).' END;
                        v_nuevo_estado := 'listo';
                    END IF;

                ELSE
                    -- No se entendió la confirmación: no se inventa nada.
                    v_avisar := true;
                    v_aviso_tipo := 'no_entendido';
                    v_aviso_unico := true;
                    v_aviso_detalle := 'Cliente que vuelve: no se entendió si confirma la dirección de siempre. Escribió: "'
                        || left(v_txt, 150) || '".';
                    v_nuevo_estado := 'esperando_confirmar_direccion';
                END IF;
            END IF;

        -- PASO 5: presencial -> transfiere ahora o paga al verse
        ELSIF v_chat.estado = 'esperando_forma_pago' THEN
            -- Si menciona una fecha ("el sábado", "mañana"...) queda guardada tal
            -- cual en el registro de entrega y se actualiza el aviso abierto.
            v_fecha_dicha := public.vl_wa_fecha_mencion(v_txt);
            IF v_fecha_dicha <> '' THEN
                PERFORM public.vl_wa_registrar_entrega(
                    p_tenant_id, v_chat.cliente_id, 'presencial', v_fecha_dicha,
                    public.vl_wa_fecha_programada(v_txt));

                UPDATE public.vl_wa_avisos
                   SET detalle = detalle || ' Ahora dijo: "' || v_fecha_dicha || '".'
                 WHERE chat_id = v_chat.id
                   AND tipo = 'entrega_presencial'
                   AND resuelto_en IS NULL;

                -- AVISO DE COORDINACIÓN (nuevo): el cliente propuso un día para
                -- verse. El bot NO confirma la fecha ("nos vemos mañana"): deja el
                -- aviso para que el negocio conteste y se pongan de acuerdo.
                IF NOT EXISTS (
                    SELECT 1 FROM public.vl_wa_avisos a
                    WHERE a.chat_id = v_chat.id
                      AND a.tipo = 'fecha_coordinacion'
                      AND a.resuelto_en IS NULL
                ) THEN
                    INSERT INTO public.vl_wa_avisos (tenant_id, chat_id, tipo, detalle)
                    VALUES (p_tenant_id, v_chat.id, 'fecha_coordinacion',
                        'El cliente propone "' || left(v_fecha_dicha, 80)
                        || '" para la entrega presencial. Confírmale tú si te queda bien (o propón otra fecha u hora).');
                END IF;
            END IF;

            -- PAGA AL VERSE (automático): "te pago / te transfiero cuando nos veamos"
            -- marca el pedido como `pagara_presencial` y responde DIRECTO mirando si
            -- YA hay fecha (antes repetía total + datos + comprobante).
            IF v_low ~ 'cuando nos veamos|cuando te vea|cuando nos juntemos|al vernos|en la entrega|cuando me lo entregues|cuando lo reciba|al momento de la entrega|nos vemos y te pago|pago al recibir|pago al entregar|pago en la entrega|pagar en la entrega|pago contra ?entrega|contra ?entrega|cuando me lo lleves|al juntarnos' THEN
                SELECT * INTO v_proc
                FROM public.vl_procesos
                WHERE cliente_id = v_chat.cliente_id AND cerrado_en IS NULL
                LIMIT 1;

                IF v_proc.id IS NOT NULL
                   AND v_proc.estado IN ('esperando_whatsapp', 'identificando_cliente',
                                         'esperando_pago', 'pago_parcial', 'pagara_presencial') THEN
                    UPDATE public.vl_procesos SET estado = 'pagara_presencial'
                    WHERE id = v_proc.id;
                END IF;

                IF COALESCE(v_fecha_dicha, '') = '' AND v_proc.id IS NOT NULL THEN
                    SELECT e.fecha_programada INTO v_fecha_prog
                    FROM public.vl_envios e
                    WHERE e.proceso_id = v_proc.id
                    ORDER BY e.creado_en DESC
                    LIMIT 1;
                END IF;

                IF COALESCE(v_fecha_dicha, '') <> '' THEN
                    v_reply := 'nos vemos ' || left(v_fecha_dicha, 40)
                        || ' 💜 ahi te llevo las cositas';
                ELSIF v_fecha_prog IS NOT NULL THEN
                    v_reply := 'nos vemos el ' || to_char(v_fecha_prog, 'DD/MM')
                        || ' 💜 ahi te llevo las cositas';
                ELSE
                    v_reply := 'si no hay problema bonit@ 💜 me avisas para vernos y entregarte las cositas';
                END IF;

                v_avisar := true;
                v_aviso_tipo := 'pago_presencial';
                v_aviso_unico := true;
                v_aviso_detalle := 'Dice que paga al verse (presencial). Confírmale día y hora y revisa el pago al entregar.';

            ELSIF v_low ~ 'transfer|deposit|abonar|te mando|te transfiero|ahora|cuenta|datos|de una|dale' THEN
                SELECT * INTO v_proc
                FROM public.vl_procesos
                WHERE cliente_id = v_chat.cliente_id AND cerrado_en IS NULL
                LIMIT 1;
                SELECT COALESCE(SUM(precio - abonado), 0) INTO v_saldo
                FROM public.vl_items
                WHERE proceso_id = v_proc.id AND estado = 'adjudicada';

                v_reenviar := (v_low ~ 'datos|cuenta|rut' AND NOT v_cli_datos);
                v_bloque := public.vl_wa_bloque_pago_para(p_tenant_id, v_chat.id, v_reenviar);

                v_reply := 'gracias serian '
                    || public.vl_wa_fmt_monto(v_saldo)
                    || ' su total'
                    || CASE WHEN v_bloque <> ''
                            THEN ', le dejo mis datitos' || chr(10) || chr(10) || v_bloque
                            ELSE '' END
                    || chr(10) || chr(10)
                    || public.vl_wa_variar(ARRAY['me manda el comprobante cuando pueda porfis','me dejas el comprobante porfis cuando puedas','manda el comprobante cuando puedas 💜','quedo atenta al comprobante porfis']);
            ELSE
                -- MEJORA: si el cliente dice que NO puede pagar (billetera, sin plata,
                -- más adelante), el bot NO se despide con "nos vemos...": deja el aviso
                -- para que el negocio decida (dar plazo, liberar la prenda, escribirle)
                -- y contesta algo neutro.
                IF v_low ~ 'no puedo|no pued|no tengo|sin plata|sin lucas|me quede sin|me qued[eé] sin|no me alcanza|no me da|no alcanzo|m[aá]s adelante|en unos d[ií]as|otro d[ií]a|la pr[oó]xima semana|despu[eé]s te|no ahora|a[uú]n no|todav[ií]a no|se me perdi[oó]|se me olvid|billetera|no quiero|no voy a poder|no alcanc' THEN
                    v_avisar := true;
                    v_aviso_tipo := 'no_puede_pagar';
                    v_aviso_unico := true;
                    v_aviso_detalle := 'El cliente dice que NO puede pagar ahora. Decide: darle plazo, liberar la prenda o escribirle. Mensaje: "'
                        || left(v_txt, 160) || '".';
                    v_reply := 'ya, sin problema bonit@, quedo atenta y me avisas cuando puedas 💜';
                ELSIF v_fecha_dicha <> '' THEN
                    -- MEJORA (A): el cliente YA dijo el día -> se lo confirmamos
                    -- directo y quedamos (antes decía "te confirmo al ratito").
                    v_reply := public.vl_wa_variar(ARRAY[
                        'nos vemos ' || left(v_fecha_dicha, 40) || ' 💜 ahi te llevo las cositas',
                        'perfecto, nos vemos ' || left(v_fecha_dicha, 40) || ' 💜 te llevo las cositas',
                        'dale, nos vemos ' || left(v_fecha_dicha, 40) || ' 💜 ahi nos vemos']);
                ELSE
                    v_reply := 'okis no hay problema, dime que dia y a que hora te queda bien y coordinamos 💜';
                END IF;
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
                    ) THEN 'presencial' ELSE 'envio' END, '',
                    public.vl_wa_fecha_programada(v_txt));

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
                    p_tenant_id, v_chat.cliente_id, 'presencial', v_fecha_dicha,
                    public.vl_wa_fecha_programada(v_txt));

                UPDATE public.vl_wa_avisos
                   SET detalle = detalle || ' Ahora dijo: "' || v_fecha_dicha || '".'
                 WHERE chat_id = v_chat.id
                   AND tipo IN ('entrega_presencial', 'pago')
                   AND resuelto_en IS NULL;

                -- Aviso de coordinación si el cliente propone un día y no había
                -- ninguno abierto (el chat ya estaba en 'listo').
                IF NOT EXISTS (
                    SELECT 1 FROM public.vl_wa_avisos a
                    WHERE a.chat_id = v_chat.id
                      AND a.tipo = 'fecha_coordinacion'
                      AND a.resuelto_en IS NULL
                ) THEN
                    INSERT INTO public.vl_wa_avisos (tenant_id, chat_id, tipo, detalle)
                    VALUES (p_tenant_id, v_chat.id, 'fecha_coordinacion',
                        'El cliente propone "' || left(v_fecha_dicha, 80)
                        || '" para la entrega. Confírmale tú si te queda bien (o propón otra fecha u hora).');
                END IF;

                -- MEJORA (A): con la fecha dicha, se la confirmamos (antes mudo).
                -- No se repite si el mensaje anterior del bot YA decía esa fecha.
                IF v_reply = '' AND (v_ult_out IS NULL OR v_ult_out NOT ILIKE '%' || v_fecha_dicha || '%') THEN
                    v_reply := public.vl_wa_variar(ARRAY[
                        'nos vemos ' || left(v_fecha_dicha, 40) || ' 💜 ahi te llevo las cositas',
                        'perfecto, nos vemos ' || left(v_fecha_dicha, 40) || ' 💜 te llevo las cositas']);
                END IF;
            END IF;

            -- "quiero pagar" (intención) NO es lo mismo que "ya pagué" (aviso de
            -- pago hecho): la intención se pregunta cómo quiere pagar.
            -- Y si pide los datos o pregunta el monto, se responde SIEMPRE (en
            -- cualquier estado), sin dejarlo esperando.
            IF v_chat.cliente_id IS NOT NULL AND v_cli_datos THEN
                v_reply := public.vl_wa_variar(ARRAY[
                    'okis bonit@ 💜 mandame TUS datos (nombre, direccion, comuna, contacto, correo) y te lo envio por blue o paket',
                    'dale bonit@ 💜 con tus datos (nombre, direccion, comuna, contacto, correo) hago el envio por blue o paket']);
                IF NOT EXISTS (
                    SELECT 1 FROM public.vl_envios e
                    JOIN public.vl_procesos pp ON pp.id = e.proceso_id
                    WHERE pp.cliente_id = v_chat.cliente_id AND e.tipo = 'presencial') THEN
                    v_nuevo_estado := 'esperando_datos_envio';
                END IF;

            ELSIF v_chat.cliente_id IS NOT NULL
               AND v_low ~ 'datos|cuenta|rut|cuanto|cuánto|total|saldo' THEN
                SELECT * INTO v_proc
                FROM public.vl_procesos
                WHERE cliente_id = v_chat.cliente_id AND cerrado_en IS NULL
                LIMIT 1;
                SELECT COALESCE(SUM(precio - abonado), 0) INTO v_saldo
                FROM public.vl_items
                WHERE proceso_id = v_proc.id AND estado = 'adjudicada';

                IF v_saldo > 0 AND (v_low ~ 'datos|cuenta|rut' AND NOT v_cli_datos) THEN
                    -- Los datos se mandan SIEMPRE que los pida (bug real: antes
                    -- quedaba mudo por la memoria del chat).
                    v_bloque := public.vl_wa_bloque_pago_para(p_tenant_id, v_chat.id, true);
                    v_respuesta_pedida := true;
                    IF v_proc.id IS NOT NULL
                       AND NOT EXISTS (SELECT 1 FROM public.vl_envios e
                                       WHERE e.proceso_id = v_proc.id) THEN
                        v_preg_entrega := chr(10) || public.vl_wa_variar(ARRAY['me dices si lo quieres con envio o entrega presencial?','lo quieres con envio o prefieres entrega presencial?','envio o entrega presencial, como lo prefieras?']);
                        v_ir_a_entrega := true;
                    END IF;
                    v_reply := public.vl_wa_variar(ARRAY['claro bonit@, aqui los tienes 👇','dale, aqui te los dejo 👇','ahi van los datos 👇'])
                        || chr(10) || chr(10) || 'serian ' || public.vl_wa_fmt_monto(v_saldo) || ' su total'
                        || CASE WHEN v_bloque <> ''
                                THEN chr(10) || chr(10) || v_bloque
                                ELSE '' END
                        || v_preg_entrega
                        || chr(10) || chr(10)
                        || public.vl_wa_variar(ARRAY['me manda el comprobante cuando pueda porfis','me dejas el comprobante porfis cuando puedas','manda el comprobante cuando puedas 💜','quedo atenta al comprobante porfis']);
                ELSIF v_saldo > 0 THEN
                    v_reply := 'serian ' || public.vl_wa_fmt_monto(v_saldo);
                    v_respuesta_pedida := true;
                    -- La pregunta de envío/presencial solo si el pedido todavía NO
                    -- tiene entrega decidida (si ya eligió, no se le repite).
                    IF v_proc.id IS NULL
                       OR NOT EXISTS (SELECT 1 FROM public.vl_envios e
                                      WHERE e.proceso_id = v_proc.id) THEN
                        v_reply := v_reply || chr(10) || chr(10)
                            || public.vl_wa_variar(ARRAY['me dices si lo quieres con envio o entrega presencial?','lo quieres con envio o prefieres entrega presencial?','envio o entrega presencial, como lo prefieras?']);
                        v_ir_a_entrega := true;
                    END IF;
                END IF;

            ELSIF v_chat.cliente_id IS NOT NULL
               AND v_low ~ 'no puedo|no pued|no tengo|sin plata|sin lucas|no me alcanza|no me da|m[aá]s adelante|en unos d[ií]as|otro d[ií]a|la pr[oó]xima semana|pago despu[eé]s|pagar despu[eé]s|despu[eé]s te pago|despues te pago|no ahora|a[uú]n no|todav[ií]a no|me paso algo|me pas[oó] algo|tuve un problema|emergencia|se me present' THEN
                v_avisar := true;
                v_aviso_tipo := 'no_puede_pagar';
                v_aviso_unico := true;
                v_aviso_detalle := 'El cliente dice que no puede pagar ahora (o le pasó algo). Contesta tú: darle plazo, liberar la prenda o escribirle. Mensaje: "'
                    || left(v_txt, 160) || '".';
                v_reply := 'ya bonit@, sin problema 💜 me avisas cuando puedas';

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

            ELSIF v_low ~ 'pag|transfer|comprob|abon|deposit'
                  AND v_low !~ 'no puedo|no pude|no e podido|no he podido|no me deja|aun no|aún no|todavia no|todavía no|no logro|bloque|no alcanc' THEN
                v_avisar := true;
                v_aviso_tipo := 'pago';
                v_aviso_unico := true;
                v_aviso_detalle := 'El cliente dice que pagó. Revisa y confirma el pago para proseguir. Mensaje: "'
                    || left(v_txt, 200) || '"';
            END IF;

            -- Lo único que responde en estado listo es el "quiero pagar" de
            -- arriba (el resto queda mudo, atendido por el humano).
            v_nuevo_estado := 'listo';
            IF v_ir_a_entrega THEN
                v_nuevo_estado := 'esperando_tipo_entrega';
            END IF;
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
    IF v_reply <> '' AND v_ult_out IS NOT NULL AND v_reply = v_ult_out
       AND NOT v_respuesta_pedida THEN
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
    IF v_tipo = 'texto' AND v_reply = '' AND NOT v_avisar AND NOT v_solo_courier THEN
        IF v_nuevo_estado NOT IN ('listo', 'habitual')
           OR v_txt LIKE '%?%' OR v_txt LIKE '%¿%'
           OR v_low ~ 'no puedo|no puede|no me deja|no e podido|no he podido|problema|ayuda|cuando|cuándo|donde|dónde|cuanto|cuánto|esperar|esperame|espérame|espera|plazo|semana|bloque|error|equivoc|perdi|perdí|no tengo|se me|olvide|olvidé|devoluc|reclamo'
           -- MEJORA: CON UN PEDIDO ABIERTO (típico: la entrega en curso) el panel avisa
           -- igual aunque el chat esté en `listo`: antes quedaba mudo y la fila solo
           -- decía "el cliente habló último" y nadie se enteraba. Se exceptúan los
           -- acuses triviales para no llenar el panel de ruido.
           OR (v_chat.cliente_id IS NOT NULL
               AND EXISTS (SELECT 1 FROM public.vl_procesos pp
                           WHERE pp.cliente_id = v_chat.cliente_id AND pp.cerrado_en IS NULL)
               AND v_low !~ '^(ok|okey|okay|dale|gracias|graci|muchas|muchisimas|jaja|jeje|si|sii+|sip|no|nop|ya|listo|hola|holi|holis|holas|buenas|buenos|hey|hi|hello|perfecto|genial|buenisimo|buenísimo|excelente|cuidate|chao|adios|nos vemos|buen dia|buenas noches|buenas tardes|de nada|amor|bonita|linda|buena)')
        THEN
            v_avisar := true;
            v_aviso_tipo := 'no_entendido';
            v_aviso_unico := true;
            v_aviso_detalle := CASE
                WHEN EXISTS (SELECT 1 FROM public.vl_procesos pp
                             WHERE pp.cliente_id = v_chat.cliente_id AND pp.cerrado_en IS NULL)
                     THEN 'Tiene un pedido en curso y escribió algo que el bot no sabe responder (suele ser la entrega). Contesta tú: "'
                ELSE 'No supe qué responderle y preferí no inventar. Lo que escribió: "'
            END || left(v_txt, 200) || '".';

            -- MEJORA (C): con un pedido en curso NO se queda mudo: contesta algo
            -- neutro mientras el negocio revisa (antes solo quedaba el aviso).
            IF v_chat.cliente_id IS NOT NULL
               AND EXISTS (SELECT 1 FROM public.vl_procesos pp
                           WHERE pp.cliente_id = v_chat.cliente_id AND pp.cerrado_en IS NULL) THEN
                -- Se elige una variante DISTINTA a la última respuesta del bot.
                SELECT public.vl_wa_variar(array_agg(x)) INTO v_reply
                  FROM unnest(ARRAY[
                        'ya bonit@, dejame confirmarte eso al ratito 💜',
                        'okis, lo reviso y te confirmo al ratito 💜',
                        'dejame ver eso y te digo al tiro 💜']) x
                 WHERE x <> COALESCE(v_ult_out, '');
                IF v_reply IS NULL THEN
                    v_reply := 'okis bonit@, dejame revisarlo y te aviso 💜';
                END IF;
            END IF;
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
        -- Memoria del monto: si esta respuesta lo dijo, queda anotado para no
        -- repetírselo en los próximos mensajes.
        IF v_reply LIKE '%serian %' THEN
            UPDATE public.vl_wa_chats SET monto_dicho_en = now() WHERE id = v_chat.id;
        END IF;
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


-- ── 2. Permisos ─────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.vl_wa_conversacion_avanzar(uuid, text, text, text) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_conversacion_avanzar(uuid, text, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] el bot cede el turno al dueño (15 min) + fotos: prenda=total, comprobante=aviso (20261071) OK' AS status;
