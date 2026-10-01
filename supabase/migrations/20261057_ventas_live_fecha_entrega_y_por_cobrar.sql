-- ============================================================================
-- [VENTAS LIVE] Fecha real de entrega + orden por prioridad + ENTREGADO POR
-- COBRAR + el pedido responde "datos/monto" dentro del paso de elección de
-- entrega. (ciclo 20261057)
--
-- 1. FIX detectado re-escenificando el chat real de @anubisss: al mover al
--    cliente al paso "envío o presencial", sus "me mandas los datos" caían en
--    ese paso y el bot quedaba MUDO otra vez. Ahora ese paso responde los datos,
--    el monto o el "ya pagué" SIEMPRE y repite la pregunta de entrega.
-- 2. vl_wa_fecha_programada(): la fecha que menciona el cliente ("mañana",
--    "el sábado", "12/05", "3 de mayo") se guarda como FECHA del calendario en
--    vl_envios.fecha_programada (antes solo quedaba el texto en notas), así el
--    panel puede ORDENAR por lo que hay que entregar primero.
-- 3. vl_marcar_entregado(proceso, pagado boolean): se puede entregar SIN pago
--    confirmado -> el pedido queda 'entregado_por_cobrar' (ABIERTO, con la deuda
--    registrada y cobrable) y el saldo negativo se suma al grupo "falta cobrar".
--    Al cobrar el saldo, el pedido se cierra solo (completado).
-- 4. vl_envios_pendientes: grupo nuevo "entregado_por_cobrar" (es una TAREA) y
--    orden por prioridad: primero lo que está PAGADO y listo para entregar,
--    después lo que debe plata; los entregados viejos (>7 días) ya no se listan.
-- ============================================================================

-- ── Estado nuevo del pedido ─────────────────────────────────────────────────
ALTER TABLE public.vl_procesos DROP CONSTRAINT IF EXISTS vl_procesos_estado_check;
ALTER TABLE public.vl_procesos ADD CONSTRAINT vl_procesos_estado_check
    CHECK (estado IN ('esperando_whatsapp', 'identificando_cliente', 'esperando_pago',
                      'pago_parcial', 'pagara_presencial', 'pagado', 'acumulando',
                      'listo_preparar', 'envio_programado', 'envio_proceso',
                      'entrega_presencial', 'entregado_por_cobrar',
                      'completado', 'no_pago_liberado'));


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
    v_espera_comp boolean := false;
    v_prenda_cargada boolean := false;
    v_user_nuevo text;
    v_cand_txt text;
    v_preg_entrega text := '';
    v_respuesta_pedida boolean := false;
    v_ir_a_entrega boolean := false;
    v_dir_prev text := '';
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

    -- ── Intervención humana: el bot NO responde, pero SÍ lee ──
    -- Aunque atienda una persona, el mensaje se analiza y se rellena el
    -- proceso del cliente (región/courier/datos de envío/entrega/fecha).
    -- Así el diagrama y el chat quedan al día en modo manual igual que con bot.
    IF v_chat.modo = 'humano' THEN
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
            v_reply := 'holis, me das tu nombre de usuario en el live porfis?';
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

                IF v_saldo > 0 AND v_low ~ 'datos|cuenta|rut|transferir|transferencia|banco|deposito|depósito' THEN
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
                        v_preg_entrega := chr(10) || 'me dices si lo quieres con envio o entrega presencial?';
                    END IF;
                    v_reply := 'gracias serian '
                        || public.vl_wa_fmt_monto(v_saldo)
                        || ' su total'
                        || CASE WHEN v_bloque <> ''
                                THEN ', le dejo mis datitos' || chr(10) || chr(10) || v_bloque
                                ELSE '' END
                        || v_preg_entrega
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
                      AND v_low ~ 'cuanto|cuánto|total|saldo|valor|precio|debo' THEN
                    -- Pidió el valor: se lo dice Y pregunta entrega/envío para este
                    -- pedido (antes quedaba sin saber cómo se lo va a mandar).
                    v_reply := 'serian ' || public.vl_wa_fmt_monto(v_saldo)
                        || chr(10) || chr(10)
                        || 'me dices si lo quieres con envio o entrega presencial?';
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
                    ELSE
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
                        UPDATE public.vl_wa_chats SET usuario_candidato = NULL
                        WHERE id = v_chat.id;
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

                -- Segundo intento con los mensajes anteriores, SOLO si este mensaje
                -- no traía nada usable (un tramo suelto: "soy", "mi usuario es",
                -- "aquí"). Así no se mezclan mensajes viejos de otro tema (eso
                -- proponía usuarios que no tenían nada que ver).
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
                    -- Se guarda además el @ que el cliente escribió (candidato):
                    -- si confirma, con eso se corrige su ficha (MEJORA F).
                    UPDATE public.vl_wa_chats
                    SET cliente_sugerido = (v_res->>'cliente_id')::uuid,
                        usuario_candidato = v_res->>'candidato'
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

                v_reply := 'okis, ahi coordinamos la entrega, este es su monto '
                    || public.vl_wa_fmt_monto(v_saldo)
                    || ' puede transferir ahora o pagar cuando nos veamos...'
                    || CASE WHEN v_fecha_dicha = ''
                            THEN chr(10) || chr(10) || 'que dia y a que hora te queda bien para la entrega?'
                            ELSE '' END;
                v_nuevo_estado := 'esperando_forma_pago';

            ELSIF v_low LIKE '%env%' THEN
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
                -- MEJORA: además de los datos, se le pregunta CUÁNDO lo quiere (o si
                -- prefiere seguir juntando prendas), que era lo que faltaba.
                v_reply := 'okis, lo quieres pronto o prefieres seguir juntando prenditas? me dejas tus datitos, nombre, direccion, comuna, contacto, correo, los envios pueden ser por blue o paket...';
                v_nuevo_estado := 'esperando_datos_envio';
                END IF;

            ELSIF v_low ~ 'datos|cuenta|rut|cuanto|cuánto|total|saldo|valor|precio|debo|transfer|deposit|pagar'
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

                v_bloque := public.vl_wa_bloque_pago_para(p_tenant_id, v_chat.id, true);
                v_respuesta_pedida := true;
                v_reply := 'gracias serian '
                    || public.vl_wa_fmt_monto(v_saldo)
                    || ' su total'
                    || CASE WHEN v_bloque <> ''
                            THEN ', le dejo mis datitos' || chr(10) || chr(10) || v_bloque
                            ELSE '' END
                    || chr(10) || chr(10)
                    || 'me dices si lo quieres con envio o entrega presencial?';
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

                IF v_solo_courier THEN
                    v_courier := CASE WHEN v_low LIKE '%blue%' THEN 'blue' ELSE 'paket' END;
                    UPDATE public.vl_clientes SET courier = v_courier WHERE id = v_cli.id;
                    PERFORM public.vl_wa_registrar_entrega(p_tenant_id, v_cli.id, 'envio', '',
                        public.vl_wa_fecha_programada(v_txt));

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

                        v_bloque := public.vl_wa_bloque_pago_para(p_tenant_id, v_chat.id, true);
                        v_respuesta_pedida := true;
                        v_reply := 'gracias serian '
                            || public.vl_wa_fmt_monto(v_saldo)
                            || ' su total'
                            || CASE WHEN v_bloque <> ''
                                    THEN ', le dejo mis datitos' || chr(10) || chr(10) || v_bloque
                                    ELSE '' END
                            || chr(10) || chr(10)
                            || 'me manda el comprobante cuando pueda porfis';

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
                    -- Dijo sólo cuándo: se le confirma la coordinación.
                    v_reply := 'okis, nos vemos ' || left(v_fecha_dicha, 40) || ' 💜';
                ELSE
                    v_reply := 'okis no hay problema nos vemos...';
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
                    -- Los datos se mandan SIEMPRE que los pida (bug real: antes
                    -- quedaba mudo por la memoria del chat).
                    v_bloque := public.vl_wa_bloque_pago_para(p_tenant_id, v_chat.id, true);
                    v_respuesta_pedida := true;
                    IF v_proc.id IS NOT NULL
                       AND NOT EXISTS (SELECT 1 FROM public.vl_envios e
                                       WHERE e.proceso_id = v_proc.id) THEN
                        v_preg_entrega := chr(10) || 'me dices si lo quieres con envio o entrega presencial?';
                        v_ir_a_entrega := true;
                    END IF;
                    v_reply := 'gracias serian '
                        || public.vl_wa_fmt_monto(v_saldo)
                        || ' su total'
                        || CASE WHEN v_bloque <> ''
                                THEN ', le dejo mis datitos' || chr(10) || chr(10) || v_bloque
                                ELSE '' END
                        || v_preg_entrega
                        || chr(10) || chr(10)
                        || 'me manda el comprobante cuando pueda porfis';
                ELSIF v_saldo > 0 THEN
                    v_reply := 'serian ' || public.vl_wa_fmt_monto(v_saldo)
                        || chr(10) || chr(10)
                        || 'me dices si lo quieres con envio o entrega presencial?';
                    v_respuesta_pedida := true;
                    v_ir_a_entrega := true;
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

-- ── Fecha REAL de entrega a partir de lo que escribió el cliente ─────────────
-- Devuelve NULL si no se puede interpretar (entonces queda el texto en `notas`).
CREATE OR REPLACE FUNCTION public.vl_wa_fecha_programada(p_texto text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
DECLARE
    v_t text;
    v_txt text;
    v_mch text[];
    v_dd int; v_mm int; v_yy int;
    v_f date;
    v_dow int;
BEGIN
    v_txt := translate(lower(btrim(COALESCE(p_texto, ''))), 'áéíóúüñ', 'aeioun');
    IF v_txt = '' THEN
        RETURN NULL;
    END IF;
    v_t := ' ' || v_txt || ' ';

    IF v_t ~ '\shoy\s' THEN
        RETURN CURRENT_DATE;
    END IF;
    IF v_txt ~ 'pasado ?manana' THEN
        RETURN CURRENT_DATE + 2;
    END IF;
    IF v_t ~ '\smanana\s' THEN
        RETURN CURRENT_DATE + 1;
    END IF;

    -- Día de la semana: el PRÓXIMO (si ya pasó esta semana, el de la otra).
    v_dow := CASE
        WHEN v_t ~ '\slunes\s'     THEN 1
        WHEN v_t ~ '\smartes\s'    THEN 2
        WHEN v_t ~ '\smiercoles\s' THEN 3
        WHEN v_t ~ '\sjueves\s'    THEN 4
        WHEN v_t ~ '\sviernes\s'   THEN 5
        WHEN v_t ~ '\ssabado\s'    THEN 6
        WHEN v_t ~ '\sdomingo\s'   THEN 7
        ELSE NULL
    END;
    IF v_dow IS NOT NULL THEN
        RETURN CURRENT_DATE
             + ((v_dow - EXTRACT(ISODOW FROM CURRENT_DATE)::int + 7) % 7);
    END IF;

    -- dd/mm, dd-mm y dd/mm/aaaa
    v_mch := regexp_match(v_txt, '(\d{1,2})\s*[/-]\s*(\d{1,2})(?:\s*[/-]\s*(\d{2,4}))?');
    IF v_mch IS NOT NULL THEN
        v_dd := v_mch[1]::int; v_mm := v_mch[2]::int;
        v_yy := COALESCE(NULLIF(v_mch[3], '')::int, EXTRACT(YEAR FROM CURRENT_DATE)::int);
        IF v_yy < 100 THEN v_yy := 2000 + v_yy; END IF;
        IF v_dd BETWEEN 1 AND 31 AND v_mm BETWEEN 1 AND 12 THEN
            BEGIN
                v_f := make_date(v_yy, v_mm, v_dd);
            EXCEPTION WHEN others THEN
                v_f := NULL;
            END;
            IF v_f IS NOT NULL AND v_f < CURRENT_DATE AND NULLIF(v_mch[3], '') IS NULL THEN
                v_f := make_date(v_yy + 1, v_mm, v_dd);
            END IF;
            RETURN v_f;
        END IF;
    END IF;

    -- "12 de mayo"
    v_mch := regexp_match(v_txt,
        '(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)');
    IF v_mch IS NOT NULL THEN
        v_dd := v_mch[1]::int;
        v_mm := CASE v_mch[2]
                    WHEN 'enero' THEN 1 WHEN 'febrero' THEN 2 WHEN 'marzo' THEN 3
                    WHEN 'abril' THEN 4 WHEN 'mayo' THEN 5 WHEN 'junio' THEN 6
                    WHEN 'julio' THEN 7 WHEN 'agosto' THEN 8
                    WHEN 'septiembre' THEN 9 WHEN 'setiembre' THEN 9
                    WHEN 'octubre' THEN 10 WHEN 'noviembre' THEN 11 ELSE 12 END;
        v_yy := EXTRACT(YEAR FROM CURRENT_DATE)::int;
        IF v_dd BETWEEN 1 AND 31 THEN
            BEGIN
                v_f := make_date(v_yy, v_mm, v_dd);
            EXCEPTION WHEN others THEN
                v_f := NULL;
            END;
            IF v_f IS NOT NULL AND v_f < CURRENT_DATE THEN
                v_f := make_date(v_yy + 1, v_mm, v_dd);
            END IF;
            RETURN v_f;
        END IF;
    END IF;

    RETURN NULL;
END;
$function$;

-- ── registrar_entrega: guarda ADEMÁS la fecha del calendario ────────────────
DROP FUNCTION IF EXISTS public.vl_wa_registrar_entrega(uuid, uuid, text, text);

CREATE OR REPLACE FUNCTION public.vl_wa_registrar_entrega(
    p_tenant_id uuid,
    p_cliente_id uuid,
    p_tipo text,
    p_notas text,
    p_fecha date DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_proc uuid;
    v_tipo text;
    v_notas text;
BEGIN
    IF p_cliente_id IS NULL THEN
        RETURN;
    END IF;

    SELECT id INTO v_proc
    FROM public.vl_procesos
    WHERE cliente_id = p_cliente_id AND cerrado_en IS NULL
    ORDER BY creado_en DESC
    LIMIT 1;

    IF v_proc IS NULL THEN
        RETURN;   -- sin pedido abierto no hay entrega que registrar
    END IF;

    v_tipo  := CASE WHEN btrim(COALESCE(p_tipo, '')) = 'presencial' THEN 'presencial' ELSE 'envio' END;
    v_notas := left(btrim(COALESCE(p_notas, '')), 200);

    INSERT INTO public.vl_envios (tenant_id, proceso_id, tipo, notas, fecha_programada)
    VALUES (p_tenant_id, v_proc, v_tipo, v_notas, p_fecha)
    ON CONFLICT (proceso_id) DO UPDATE
        SET notas = CASE
                        WHEN COALESCE(public.vl_envios.notas, '') = '' THEN v_notas
                        ELSE public.vl_envios.notas
                    END,
            -- La fecha del cliente se guarda solo si el negocio no puso una.
            fecha_programada = COALESCE(public.vl_envios.fecha_programada, p_fecha),
            updated_at = now();
END;
$function$;

-- ── Marcar entregado: con o sin pago confirmado ─────────────────────────────
-- Pedido del dueño: poder cerrar la entrega sin esperar el comprobante, dejando
-- la deuda REGISTRADA ("que quede pendiente en caso de"). Con p_pagado = false el
-- pedido NO se cierra: queda en 'entregado_por_cobrar' y el saldo sigue contando.
DROP FUNCTION IF EXISTS public.vl_marcar_entregado(uuid);

CREATE OR REPLACE FUNCTION public.vl_marcar_entregado(p_proceso_id uuid, p_pagado boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_proc public.vl_procesos%ROWTYPE;
    v_saldo numeric;
    v_items int;
    v_estado text;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    v_proc := public.vl_proceso_activo(p_proceso_id, v_tenant);
    IF v_proc.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Proceso no encontrado o ya cerrado');
    END IF;

    IF v_proc.estado NOT IN ('envio_proceso', 'entrega_presencial', 'entregado_por_cobrar') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El proceso no está en una etapa de entrega');
    END IF;

    v_saldo := public.vl_saldo_proceso(p_proceso_id);

    IF COALESCE(p_pagado, true) AND v_saldo > 0 THEN
        RETURN jsonb_build_object('ok', false,
            'error', 'Quedan $' || v_saldo || ' por cobrar. Si ya entregaste, marcala como "entregado y por cobrar".',
            'saldo', v_saldo);
    END IF;

    IF v_proc.estado = 'entregado_por_cobrar' AND v_saldo > 0 THEN
        RETURN jsonb_build_object('ok', false,
            'error', 'Ya está entregado y por cobrar ($' || v_saldo || '). Cobrá el saldo para cerrarlo.',
            'saldo', v_saldo);
    END IF;

    -- Las prendas PAGADAS quedan entregadas; las impagas siguen adjudicadas para
    -- que la deuda no desaparezca del panel.
    UPDATE public.vl_items
    SET estado = 'entregada'
    WHERE proceso_id = p_proceso_id AND estado = 'pagada';

    UPDATE public.vl_envios
    SET estado = 'entregado', updated_at = now()
    WHERE proceso_id = p_proceso_id;

    IF COALESCE(p_pagado, true) THEN
        UPDATE public.vl_items
        SET estado = 'entregada'
        WHERE proceso_id = p_proceso_id AND estado IN ('adjudicada', 'pagada');

        UPDATE public.vl_procesos
        SET estado = 'completado', cerrado_en = now(), motivo_cierre = 'completado'
        WHERE id = p_proceso_id;
        v_estado := 'completado';
    ELSE
        UPDATE public.vl_procesos
        SET estado = 'entregado_por_cobrar'
        WHERE id = p_proceso_id;
        v_estado := 'entregado_por_cobrar';
    END IF;

    SELECT count(*) INTO v_items
    FROM public.vl_items
    WHERE proceso_id = p_proceso_id AND estado = 'entregada';

    RETURN jsonb_build_object(
        'ok', true,
        'estado', v_estado,
        'por_cobrar', NOT COALESCE(p_pagado, true),
        'saldo', public.vl_saldo_proceso(p_proceso_id),
        'prendas_entregadas', v_items
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.vl_confirmar_pago(p_proceso_id uuid, p_monto numeric, p_metodo text DEFAULT 'transferencia'::text, p_nota text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_proc public.vl_procesos%ROWTYPE;
    v_saldo numeric;
    v_restante numeric;
    v_nuevo_estado text;
    v_pago_id uuid;
    v_metodo text;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    v_proc := public.vl_proceso_activo(p_proceso_id, v_tenant);
    IF v_proc.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Proceso no encontrado o ya cerrado');
    END IF;

    v_metodo := btrim(COALESCE(p_metodo, ''));
    IF v_metodo = '' THEN
        v_metodo := 'transferencia';
    END IF;
    IF v_metodo NOT IN ('transferencia', 'efectivo', 'otro') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Método de pago inválido');
    END IF;

    v_saldo := public.vl_saldo_proceso(p_proceso_id);
    IF v_saldo <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'No hay saldo pendiente en este proceso');
    END IF;
    IF p_monto IS NULL OR p_monto <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Monto inválido');
    END IF;
    IF p_monto > v_saldo THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El monto supera el saldo pendiente ($' || v_saldo || ')');
    END IF;

    INSERT INTO public.vl_pagos (tenant_id, proceso_id, monto, metodo, nota, confirmado_por)
    VALUES (v_tenant, p_proceso_id, p_monto, v_metodo, btrim(COALESCE(p_nota, '')), auth.uid())
    RETURNING id INTO v_pago_id;

    -- El trigger trg_vl_imputar_pago ya abonó las prendas (FIFO)
    v_restante := public.vl_saldo_proceso(p_proceso_id);

    IF v_restante > 0 THEN
        v_nuevo_estado := 'pago_parcial';
    ELSIF v_proc.estado = 'acumulando' THEN
        -- El cliente sigue acumulando: no pierde su decisión
        v_nuevo_estado := 'acumulando';
    ELSIF v_proc.estado = 'pagara_presencial' THEN
        -- Pagó: ahora hay que preparar la entrega presencial
        INSERT INTO public.vl_envios (tenant_id, proceso_id, tipo)
        VALUES (v_tenant, p_proceso_id, 'presencial')
        ON CONFLICT (proceso_id) DO NOTHING;
        v_nuevo_estado := 'entrega_presencial';
    ELSIF v_proc.estado = 'entregado_por_cobrar' THEN
        -- Ya se entregó sin pago: con este pago queda saldado y el pedido CIERRA
        -- (la deuda deja de contar). Ojo: va DESPUÉS del pago parcial.
        UPDATE public.vl_procesos
        SET estado = 'completado', cerrado_en = now(), motivo_cierre = 'completado'
        WHERE id = p_proceso_id;

        RETURN jsonb_build_object(
            'ok', true,
            'pago_id', v_pago_id,
            'monto', p_monto,
            'metodo', v_metodo,
            'saldo_restante', 0,
            'estado', 'completado',
            'cerrado', true
        );
    ELSE
        v_nuevo_estado := 'pagado';
    END IF;

    UPDATE public.vl_procesos SET estado = v_nuevo_estado WHERE id = p_proceso_id;

    RETURN jsonb_build_object(
        'ok', true,
        'pago_id', v_pago_id,
        'monto', p_monto,
        'metodo', v_metodo,
        'saldo_restante', v_restante,
        'estado', v_nuevo_estado
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.vl_envios_pendientes()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    -- A diferencia de la versión anterior, esta lista sale del PROCESO (todos los
    -- pedidos abiertos), no de la fila de vl_envios: así Envíos y Procesos muestran
    -- LA MISMA información y un pedido sin entrega decidida también aparece.
    RETURN (
        WITH base AS (
            SELECT
                pr.id AS proceso_id,
                pr.estado AS proceso_estado,
                c.id AS cliente_id,
                c.tiktok_user, c.nombre_real, c.whatsapp, c.ciudad, c.comuna, c.direccion,
                COALESCE(c.courier, '') AS courier,
                (pt->'puntos'->'entrega'->>'valor')    AS entrega,
                (pt->'puntos'->'entrega'->>'sugerido') AS entrega_sugerida,
                (pt->'puntos'->'pago'->>'valor')       AS pago_punto,
                (pt->'puntos'->'fecha'->>'valor')      AS fecha_punto,
                COALESCE((pt->>'saldo')::numeric, 0)   AS saldo,
                COALESCE((pt->>'total')::numeric, 0)   AS total,
                COALESCE((pt->>'prendas')::int, 0)     AS prendas,
                ev.id AS envio_id, ev.empresa, ev.tracking, ev.notas,
                ev.estado AS envio_estado, ev.fecha_programada, ev.updated_at AS envio_updated_at
            FROM public.vl_procesos pr
            JOIN public.vl_clientes c ON c.id = pr.cliente_id
            CROSS JOIN LATERAL public.vl_proceso_puntos(pr.id) pt
            LEFT JOIN public.vl_envios ev
                   ON ev.proceso_id = pr.id AND ev.estado <> 'cancelado'
            WHERE pr.tenant_id = v_tenant
              AND pr.cerrado_en IS NULL
        ),
        calc AS (
            SELECT b.*,
                CASE
                    -- Entregado pero todavía debe plata: es una TAREA (cobrar), no
                    -- un registro histórico.
                    WHEN b.proceso_estado = 'entregado_por_cobrar' AND b.saldo > 0 THEN 'por_cobrar'
                    WHEN b.envio_estado = 'entregado'
                         AND b.envio_updated_at > now() - interval '7 days' THEN 'entregados'
                    WHEN b.envio_estado = 'entregado' THEN 'entregados_viejos'
                    WHEN b.entrega IS NULL THEN 'sin_entrega'
                    WHEN b.saldo > 0 AND b.entrega = 'presencial' THEN 'presenciales'
                    WHEN b.saldo > 0 THEN 'esperando_pago'
                    WHEN b.proceso_estado IN ('envio_proceso', 'entrega_presencial') THEN 'listos'
                    WHEN b.envio_estado = 'en_proceso' THEN 'en_proceso'
                    WHEN b.entrega = 'presencial' THEN 'presenciales'
                    WHEN b.courier = 'paket' THEN 'urgente_paket'
                    -- El envío todavía NO se creó en el courier (sin fila o en
                    -- 'pendiente'): el botón "ENVÍO CREADO" tiene que estar ahí.
                    WHEN b.entrega = 'envio'
                         AND (b.envio_id IS NULL OR b.envio_estado = 'pendiente') THEN 'por_preparar'
                    WHEN b.fecha_programada IS NULL OR b.fecha_programada <= CURRENT_DATE THEN 'hoy'
                    WHEN b.fecha_programada = CURRENT_DATE + 1 THEN 'manana'
                    ELSE 'proximos'
                END AS grupo,
                CASE
                    WHEN b.proceso_estado = 'entregado_por_cobrar' AND b.saldo > 0
                        THEN 'Entregado: falta cobrar ' || public.vl_wa_fmt_monto(b.saldo)
                             || ' de ' || public.vl_wa_fmt_monto(b.total)
                             || '. Al cobrar el saldo el pedido se cierra solo.'
                    WHEN b.envio_estado = 'entregado' THEN 'Entrega registrada ✔'
                    WHEN b.entrega IS NULL AND b.saldo > 0
                        THEN 'Falta decidir entrega. Cobrar ' || public.vl_wa_fmt_monto(b.saldo)
                             || ' o darle plazo y liberar la prenda.'
                    WHEN b.entrega IS NULL
                        THEN 'Falta decidir entrega: marcar envío o entrega presencial.'
                    WHEN b.saldo > 0 AND b.entrega = 'presencial'
                        THEN 'Entrega presencial con ' || public.vl_wa_fmt_monto(b.saldo)
                             || ' por cobrar. Puede pagar al verse.'
                    WHEN b.saldo > 0
                        THEN 'Falta cobrar ' || public.vl_wa_fmt_monto(b.saldo)
                             || ' (total ' || public.vl_wa_fmt_monto(b.total) || ').'
                    WHEN b.proceso_estado IN ('envio_proceso', 'entrega_presencial')
                        THEN 'Listo para cerrar: marcar entregado.'
                    WHEN b.entrega = 'presencial'
                        THEN 'Coordinar la entrega presencial'
                             || CASE WHEN COALESCE(b.notas, '') <> ''
                                     THEN ' (dijo: ' || b.notas || ')' ELSE ' (sin fecha todavía)' END
                    WHEN b.envio_estado = 'en_proceso'
                        THEN 'En camino: marcar entregado cuando llegue.'
                    WHEN b.courier = 'paket'
                        THEN 'Pedir en Paket ANTES de las 23:59 del día anterior (solo Santiago, +$3.500)'
                    WHEN b.courier = 'blue'
                        THEN 'Pedir en Blue Express (el envío se paga al recibir)'
                    WHEN b.envio_id IS NULL
                        THEN 'Elegir courier (blue o paket) y crear el envío'
                    ELSE 'Envío creado: avisar al cliente y marcar entregado cuando llegue'
                END AS siguiente_paso,
                CASE
                    WHEN b.proceso_estado = 'entregado_por_cobrar' AND b.saldo > 0 THEN 'pagar'
                    WHEN b.envio_estado = 'entregado' THEN 'abrir_chat'
                    WHEN b.proceso_estado IN ('envio_proceso', 'entrega_presencial') AND b.saldo <= 0
                        THEN 'entregado'
                    WHEN b.saldo > 0 THEN 'pagar'
                    WHEN b.entrega IS NULL THEN 'decidir_entrega'
                    WHEN b.entrega = 'envio'
                         AND (b.envio_id IS NULL OR b.envio_estado = 'pendiente') THEN 'crear_envio'
                    ELSE 'abrir_chat'
                END AS accion,
                CASE
                    WHEN b.proceso_estado = 'entregado_por_cobrar' AND b.saldo > 0 THEN 1
                    WHEN b.proceso_estado IN ('envio_proceso', 'entrega_presencial') AND b.saldo <= 0 THEN 1
                    WHEN b.envio_estado = 'en_proceso' THEN 1
                    WHEN b.envio_estado = 'entregado' THEN 9
                    WHEN b.saldo > 0 THEN 4
                    WHEN b.entrega IS NULL THEN 3
                    WHEN b.courier = 'paket' THEN 2
                    WHEN b.entrega = 'envio'
                         AND (b.envio_id IS NULL OR b.envio_estado = 'pendiente') THEN 2
                    WHEN b.fecha_programada IS NULL OR b.fecha_programada <= CURRENT_DATE THEN 5
                    WHEN b.fecha_programada = CURRENT_DATE + 1 THEN 6
                    ELSE 7
                END AS prioridad
            FROM base b
        )
        SELECT jsonb_build_object(
            'ok', true,
            'revisar_chat', true,
            'grupos', COALESCE((
                SELECT jsonb_object_agg(grupo, arr)
                FROM (
                    SELECT grupo, jsonb_agg(jsonb_build_object(
                        'envio_id', envio_id,
                        'proceso_id', proceso_id,
                        'cliente_id', cliente_id,
                        'tipo', entrega,
                        'tipo_sugerido', entrega_sugerida,
                        'empresa', empresa,
                        'tracking', tracking,
                        'fecha_programada', fecha_programada,
                        'envio_estado', envio_estado,
                        'proceso_estado', proceso_estado,
                        'pago_confirmado', (saldo <= 0),
                        'courier', courier,
                        'notas', COALESCE(notas, ''),
                        'fecha_dicha', COALESCE(notas, '') <> '',
                        'saldo', saldo,
                        'total', total,
                        'prendas', prendas,
                        'siguiente_paso', siguiente_paso,
                        'accion', accion,
                        'prioridad', prioridad,
                        'cliente', jsonb_build_object(
                            'cliente_id', cliente_id,
                            'tiktok_user', tiktok_user, 'nombre_real', nombre_real,
                            'whatsapp', whatsapp, 'ciudad', ciudad,
                            'comuna', comuna, 'direccion', direccion
                        )
                    ) ORDER BY prioridad,
                        -- Lo PAGADO primero (ya se puede entregar); lo que debe plata
                        -- queda después dentro de su grupo, salvo en "falta cobrar".
                        (saldo > 0),
                        fecha_programada NULLS LAST,
                        tiktok_user) AS arr
                    FROM calc
                    GROUP BY grupo
                ) t
            ), '{}'::jsonb)
        )
    );
END;
$function$;


-- ── Permisos ────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.vl_wa_fecha_programada(text) FROM anon, authenticated, public;
REVOKE ALL ON FUNCTION public.vl_wa_registrar_entrega(uuid, uuid, text, text, date) FROM anon, authenticated, public;
REVOKE ALL ON FUNCTION public.vl_envios_pendientes() FROM anon, public;
REVOKE ALL ON FUNCTION public.vl_marcar_entregado(uuid, boolean) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_marcar_entregado(uuid, boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] fecha real de entrega + entregado por cobrar + orden OK' AS status;
