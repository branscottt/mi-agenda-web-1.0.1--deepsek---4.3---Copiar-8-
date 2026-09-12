-- 20261039_ventas_live_wa_cliente_habitual.sql
-- Ventas Live · WhatsApp · CLIENTES HABITUALES
--
-- Pedido del dueño (2026-09-11):
--   * "no va a preguntar de nuevo el usuario como robot" — si el número de
--     WhatsApp ya es de un cliente del negocio, se le responde como habitual
--     (y si escribe de OTRO número sí se le pide el usuario, para guardarlo bien).
--   * "ellos te mandan directamente fotos de las prendas… tú solo informa que
--     prenda se agregó a tal usuario" — el negocio carga la prenda en la web
--     ANTES de que llegue el pantallazo, así que el pantallazo es el RESPALDO
--     VISUAL de la prenda, no un comprobante de pago.
--   * "después que se le agrega una prenda y manda pantallazo preguntar si quiere
--     seguir viendo cositas" — se pregunta UNA vez (no en cada pantallazo).
--   * "si dice quiero pagar: ¿quieres datos de pago o espero el comprobante
--     bonit@? y avisa a la web que se espera comprobante".
--   * "gracias te lo guardamos" SIN monto: el total se dice al final.
--
-- Piezas:
--   1. vl_wa_cliente_por_wa(): reconoce al cliente por su número de WhatsApp.
--   2. vl_wa_chats.saludo_habitual_en / prendas_respondido_en: memoria de lo ya
--      dicho (para no repetir el saludo ni la confirmación del pantallazo).
--   3. Estado nuevo 'habitual' en el CHECK de vl_wa_chats.estado.
--   4. Cerebro vl_wa_conversacion_avanzar con el flujo del habitual.
--   5. Avisos nuevos: 'prenda' y 'esperando_comprobante' (etiquetas en
--      src/ventas-live/ui/chatComun.js → AVISO_INFO).
--
-- El guion vive en la BASE: con `supabase db push --linked` queda LIVE al
-- instante (no hace falta deploy de Vercel para el bot).

-- ── 1. Reconocer al cliente por su número de WhatsApp ──────────────────────
-- vl_clientes.whatsapp se llena cuando el bot identifica al cliente por su
-- usuario de TikTok (vl_wa_procesar_cliente_identificado). Desde acá ese dato
-- sirve para NO volver a pedirle el usuario.
CREATE OR REPLACE FUNCTION public.vl_wa_cliente_por_wa(p_tenant_id uuid, p_wa_id text)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT c.id
    FROM public.vl_clientes c
    WHERE c.tenant_id = p_tenant_id
      AND btrim(COALESCE(c.whatsapp, '')) <> ''
      AND btrim(c.whatsapp) = btrim(COALESCE(p_wa_id, ''))
    ORDER BY c.updated_at DESC
    LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.vl_wa_cliente_por_wa(uuid, text) FROM anon, authenticated, public;

-- ── 2. Memoria de lo ya dicho al cliente habitual ───────────────────────────
ALTER TABLE public.vl_wa_chats
    ADD COLUMN IF NOT EXISTS saludo_habitual_en   timestamptz,
    ADD COLUMN IF NOT EXISTS prendas_respondido_en timestamptz;

COMMENT ON COLUMN public.vl_wa_chats.saludo_habitual_en IS
    'Última vez que el bot saludó a este cliente habitual ("holis bonit@"). Evita repetir el saludo en la misma sesión.';
COMMENT ON COLUMN public.vl_wa_chats.prendas_respondido_en IS
    'Última vez que el bot confirmó el pantallazo de una prenda ("gracias te lo guardamos"). Evita repetirlo en cada pantallazo.';

-- ── 3. Estado nuevo 'habitual' ──────────────────────────────────────────────
-- PITFALL conocido: si no se rehace el CHECK en la MISMA migración, el flujo
-- nuevo muere con "violates check constraint vl_wa_chats_estado_check".
ALTER TABLE public.vl_wa_chats DROP CONSTRAINT IF EXISTS vl_wa_chats_estado_check;
ALTER TABLE public.vl_wa_chats ADD CONSTRAINT vl_wa_chats_estado_check
    CHECK (estado = ANY (ARRAY[
        'nuevo'::text,
        'esperando_tiktok'::text,
        'esperando_confirmar_usuario'::text,
        'esperando_tipo_entrega'::text,
        'esperando_datos_envio'::text,
        'esperando_forma_pago'::text,
        'habitual'::text,
        'listo'::text
    ]));

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

    -- Momento del último mensaje de TEXTO del cliente (se lee ANTES de insertar
    -- el que acaba de llegar). Se compara con la fecha de la última prenda
    -- cargada: sirve para saber si el negocio le cargó una prenda nueva, que es
    -- lo que distingue el pantallazo de la prenda del comprobante de pago.
    -- Se miran solo los TEXTOS a propósito: dos pantallazos seguidos no tienen
    -- texto en el medio y tienen que seguir contando como prenda.
    SELECT max(m.creado_en) INTO v_ult_in
    FROM public.vl_wa_mensajes m
    WHERE m.chat_id = v_chat.id AND m.direction = 'in' AND m.tipo = 'texto';

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

    -- ── Medios (imagen/audio/...): dos casos MUY distintos ──
    -- (a) pantallazo de la PRENDA que el negocio acaba de cargar en la web: el
    --     bot lo confirma UNA vez por sesión (no repite el texto en cada
    --     pantallazo) y avisa al negocio con el rótulo correcto.
    -- (b) cualquier otra cosa (comprobante de pago, audio, archivo): silencio y
    --     aviso "comprobante", como antes.
    IF v_tipo <> 'texto' THEN
        v_es_prenda := false;

        IF v_chat.cliente_id IS NOT NULL THEN
            SELECT * INTO v_cli FROM public.vl_clientes WHERE id = v_chat.cliente_id;

            SELECT max(i.creado_en) INTO v_item_nuevo
            FROM public.vl_items i
            JOIN public.vl_procesos pr ON pr.id = i.proceso_id
            WHERE pr.cliente_id = v_chat.cliente_id AND pr.cerrado_en IS NULL;

            SELECT * INTO v_proc
            FROM public.vl_procesos
            WHERE cliente_id = v_chat.cliente_id AND cerrado_en IS NULL
            LIMIT 1;

            -- Es el pantallazo de la prenda si: hay una prenda cargada DESPUÉS
            -- de su último texto, todavía no se le mandaron los datos de pago,
            -- no hay un aviso abierto de "esperando comprobante" y el mensaje no
            -- dice que sea un comprobante.
            v_es_prenda := v_item_nuevo IS NOT NULL
                AND v_item_nuevo > COALESCE(v_ult_in, v_item_nuevo - interval '1 day')
                AND NOT (v_proc.estado IN ('esperando_pago', 'pago_parcial')
                         AND v_chat.datos_pago_enviado_en IS NOT NULL)
                AND NOT EXISTS (
                    SELECT 1 FROM public.vl_wa_avisos a
                    WHERE a.chat_id = v_chat.id
                      AND a.tipo = 'esperando_comprobante'
                      AND a.resuelto_en IS NULL
                )
                AND v_low !~ 'comprob|pagu[eé]|transfer|deposit|abon|boleta|factura';
        END IF;

        IF v_es_prenda THEN
            v_avisar := true;
            v_aviso_tipo := 'prenda';
            v_aviso_unico := true;
            v_aviso_detalle := 'El cliente mandó la foto de la prenda que le cargaste (@'
                || COALESCE(v_cli.tiktok_user, '') || '). Revisa que el monto sea el correcto.';

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
            v_avisar := true;
            v_aviso_tipo := 'comprobante';
            v_aviso_detalle := 'El cliente envió ' || v_tipo
                || '. Revisa si es el comprobante de pago.';
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
                    -- No hay nada parecido: se le pide el usuario de nuevo en vez del
                    -- mensaje formal con el eco (antes salía "@soy@camidellive 😕").
                    v_reply := 'no encontre ese usuario 😕 me lo escribes igual al del live porfis?';
                    v_nuevo_estado := 'esperando_tiktok';
                    v_avisar := true;
                    v_aviso_tipo := 'usuario_no_encontrado';
                    v_aviso_unico := true;
                    v_aviso_detalle := 'No se encontró ningún usuario parecido a "'
                        || left(v_txt, 60) || '". Revisar a mano.';
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

            ELSIF char_length(v_txt) < 5 THEN
                v_avisar := true;
                v_aviso_tipo := 'no_entendido';
                v_aviso_unico := true;
                v_aviso_detalle := 'Mensaje muy corto esperando los datos de envío: "'
                    || left(v_txt, 200) || '"';

            ELSE
                UPDATE public.vl_clientes
                SET datos_envio = left(v_txt, 1000)
                WHERE id = v_cli.id;

                v_correo := substring(v_txt
                    from '[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}');

                v_contacto := substring(
                    regexp_replace(v_txt,
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
                    v_fuera_rm := NOT public.vl_wa_es_santiago(v_txt);
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
                        || left(v_txt, 300);
                ELSIF v_cli.courier = 'paket' AND v_fuera_rm THEN
                    v_avisar := true;
                    v_aviso_tipo := 'paket_region';
                    v_aviso_unico := true;
                    v_aviso_detalle := 'Eligió Paket pero la dirección no parece de Santiago (paket solo cubre la RM). '
                        || 'No se le sumó el envío: elegir Blue o coordinar a mano. Datos: ' || left(v_txt, 200);
                ELSIF v_cli.courier = 'paket' THEN
                    v_avisar := true;
                    v_aviso_tipo := 'entrega_paket';
                    v_aviso_unico := true;
                    v_aviso_detalle := 'Eligió envío por Paket ($3.500, solo Santiago): hay que pedirlo '
                        || 'antes de las 23:59 del día anterior. Dirección: ' || left(v_txt, 200);
                ELSE
                    v_avisar := true;
                    v_aviso_tipo := 'entrega_blue';
                    v_aviso_unico := true;
                    v_aviso_detalle := 'Eligió envío por Blue Express (el envío se paga al recibir): '
                        || 'crear el pedido en Blue. Dirección: ' || left(v_txt, 200);
                END IF;

                v_nuevo_estado := 'listo';
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
            IF v_chat.cliente_id IS NOT NULL
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
REVOKE ALL ON FUNCTION public.vl_wa_conversacion_avanzar(uuid, text, text, text)
    FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_conversacion_avanzar(uuid, text, text, text)
    TO service_role;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] Cliente habitual (reconocimiento por WhatsApp, pantallazo de prenda, seguiras viendo cositas) OK' AS status;
