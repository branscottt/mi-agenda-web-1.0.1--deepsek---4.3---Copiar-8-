-- ============================================================================
-- [VENTAS LIVE] Bot v4 — memoria de la conversación, reglas de entrega y avisos.
--
-- Puntos pedidos por el dueño (2026-09):
--  2. "si ya mandaste los datos de pago, no hace falta mandarlos de nuevo salvo
--     que el cliente los pida"  -> vl_wa_chats.datos_pago_enviado_en.
--  4/5. "muchos clientes nos hablan a los días después: entender a qué se
--     refieren y actualizar la información" -> en estado `listo` se escucha
--     courier y fecha, se actualiza el registro de entrega y el aviso abierto.
--  6. "paket es solo para Santiago: si son región no deberían elegir paket, que
--     se avise" -> vl_wa_es_santiago + aviso `paket_region` (sin sumar el envío).
--  7. "en caso que responda y mande la foto, que nos avise y lo revisamos en la
--     web" -> vl_wa_chats.pide_foto_en + aviso `sin_pedido` cuando responde.
-- ============================================================================

-- ── Memoria por conversación ────────────────────────────────────────────────
ALTER TABLE public.vl_wa_chats ADD COLUMN IF NOT EXISTS datos_pago_enviado_en timestamptz;
ALTER TABLE public.vl_wa_chats ADD COLUMN IF NOT EXISTS pide_foto_en timestamptz;

-- ── ¿La dirección es de Santiago (RM)? ─────────────────────────────────────
-- Devuelve false SOLO si aparecen señales claras de otra región; sin datos
-- suficientes asume Santiago para no alterar el cobro del envío.
CREATE OR REPLACE FUNCTION public.vl_wa_es_santiago(p_texto text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
    WITH t AS (
        SELECT translate(lower(COALESCE(p_texto, '')), 'áéíóúüñ', 'aeioun') AS s
    )
    SELECT CASE
        WHEN s ~ 'metropolitana|\mrm\M|\msantiago\M' THEN true
        WHEN s ~ '(cerrillos|cerro navia|conchali|el bosque|estacion central|huechuraba|independencia|la cisterna|la florida|la granja|la pintana|la reina|las condes|lo barnechea|lo espejo|lo prado|macul|maipu|nunoa|pedro aguirre cerda|penalolen|providencia|pudahuel|quilicura|quinta normal|recoleta|renca|san joaquin|san miguel|san ramon|vitacura|puente alto|san bernardo|buin|calera de tango|colina|curacavi|el monte|isla de maipo|lampa|maria pinto|melipilla|padre hurtado|paine|penaflor|pirque|san jose de maipo|talagante|tiltil|alhue)' THEN true
        WHEN s ~ '(arica|iquique|tarapaca|alto hospicio|antofagasta|calama|tocopilla|atacama|copiapo|vallenar|coquimbo|la serena|ovalle|illapel|los vilos|valparaiso|vina del mar|quilpue|villa alemana|san antonio|quillota|los andes|san felipe|la ligua|rancagua|rengo|machali|san fernando|santa cruz|talca|curico|linares|constitucion|cauquenes|chillan|nuble|san carlos|concepcion|talcahuano|los angeles|chiguayante|coronel|lota|penco|tomé|tome|temuco|villarrica|padre las casas|angol|valdivia|la union|osorno|puerto montt|puerto varas|castro|ancud|chiloe|coyhaique|puerto aysen|punta arenas|puerto natales|region)' THEN false
        ELSE true
    END
    FROM t;
$function$;

-- ── Bloque de datos de pago con memoria por conversación ───────────────────
-- Devuelve el bloque la primera vez (y siempre que el cliente lo pida de nuevo);
-- después devuelve '' para no repetirlo. Sin datos configurados devuelve el
-- texto neutro de siempre (red de seguridad).
CREATE OR REPLACE FUNCTION public.vl_wa_bloque_pago_para(
    p_tenant_id uuid,
    p_chat_id uuid,
    p_reenviar boolean DEFAULT false
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_datos text := '';
    v_ya timestamptz;
BEGIN
    SELECT COALESCE(datos_pago, '') INTO v_datos
    FROM public.vl_config WHERE tenant_id = p_tenant_id;

    IF btrim(v_datos) = '' THEN
        RETURN public.vl_wa_bloque_pago(v_datos);
    END IF;

    IF p_chat_id IS NOT NULL THEN
        SELECT datos_pago_enviado_en INTO v_ya
        FROM public.vl_wa_chats WHERE id = p_chat_id;

        IF v_ya IS NOT NULL AND NOT COALESCE(p_reenviar, false) THEN
            RETURN '';
        END IF;

        UPDATE public.vl_wa_chats SET datos_pago_enviado_en = now() WHERE id = p_chat_id;
    END IF;

    RETURN public.vl_wa_bloque_pago(v_datos);
END;
$function$;

-- ── Cliente identificado (v3): marca que se le pidió la foto ───────────────
CREATE OR REPLACE FUNCTION public.vl_wa_procesar_cliente_identificado(p_tenant_id uuid, p_chat_id uuid, p_cliente_id uuid, p_wa text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_proc public.vl_procesos%ROWTYPE;
    v_saldo numeric := 0;
    v_n_items int := 0;
    v_datos_pago text := '';
    v_bloque text := '';
    v_mensaje text := '';
    v_estado text := 'listo';
    v_aviso text := '';
    v_detalle text := '';
BEGIN
    -- Se guarda el WhatsApp del cliente solo
    UPDATE public.vl_clientes SET whatsapp = p_wa WHERE id = p_cliente_id;

    UPDATE public.vl_wa_chats
    SET cliente_id = p_cliente_id,
        cliente_sugerido = NULL
    WHERE id = p_chat_id;

    SELECT * INTO v_proc
    FROM public.vl_procesos
    WHERE cliente_id = p_cliente_id AND cerrado_en IS NULL
    LIMIT 1;

    IF v_proc.id IS NULL THEN
        -- Existe pero no tiene prendas: se marca el chat para que la próxima
        -- respuesta (foto o texto) genere un aviso al negocio.
        UPDATE public.vl_wa_chats SET pide_foto_en = now() WHERE id = p_chat_id;

        RETURN jsonb_build_object(
            'mensaje', 'holis, tienes la fotito de lo que era?',
            'estado', 'listo', 'aviso_tipo', '', 'aviso_detalle', '');
    END IF;

    SELECT COALESCE(SUM(precio - abonado) FILTER (WHERE estado = 'adjudicada'), 0),
           count(*) FILTER (WHERE estado IN ('adjudicada', 'pagada'))
    INTO v_saldo, v_n_items
    FROM public.vl_items
    WHERE proceso_id = v_proc.id;

    IF v_proc.estado NOT IN ('esperando_whatsapp', 'identificando_cliente') THEN
        -- Pedido ya avanzado: casos puntuales
        IF v_saldo > 0 AND v_proc.estado = 'pago_parcial' THEN
            v_mensaje := 'yapis, solo quedaria pendiente esto, '
                || public.vl_wa_fmt_monto(v_saldo)
                || ' me mandas el pantallazo del comprobante porfis';
        ELSIF v_proc.estado = 'pagara_presencial' THEN
            v_mensaje := 'okis si lo quiere presencial puede pagar al momento de la entrega ahi quedaron guardadas sus cositas, mañana le hablo para coordinar la entrega 💜';
        ELSE
            v_mensaje := '';
        END IF;
        RETURN jsonb_build_object('mensaje', v_mensaje, 'estado', 'listo',
                                  'aviso_tipo', '', 'aviso_detalle', '');
    END IF;

    IF v_saldo <= 0 THEN
        -- Ya no debe nada: silencio
        RETURN jsonb_build_object('mensaje', '', 'estado', 'listo',
                                  'aviso_tipo', '', 'aviso_detalle', '');
    END IF;

    -- Cliente pendiente: entra en identificación (🔵)
    IF v_proc.estado = 'esperando_whatsapp' THEN
        UPDATE public.vl_procesos SET estado = 'identificando_cliente'
        WHERE id = v_proc.id;
    END IF;

    -- Los datos de pago se manda la PRIMERA vez en la conversación (si el
    -- cliente ya los tiene, no se repiten).
    v_bloque := public.vl_wa_bloque_pago_para(p_tenant_id, p_chat_id, false);

    v_mensaje := 'holis serian '
        || public.vl_wa_fmt_monto(v_saldo)
        || ' me avisa si va a querer envio o entrega presencial...'
        || CASE WHEN v_bloque <> ''
                THEN ' ahora le dejo mis datitos para el deposito' || chr(10) || chr(10) || v_bloque
                ELSE '' END;

    RETURN jsonb_build_object('mensaje', v_mensaje, 'estado', 'esperando_tipo_entrega',
                              'aviso_tipo', '', 'aviso_detalle', '');
END;
$function$;

-- ── Cerebro v4 (memoria de la conversación, paket/región, avisos tardíos) ────
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

    -- ── Medios (imagen/audio/...): sin acuse, aviso al negocio ──
    IF v_tipo <> 'texto' THEN
        v_avisar := true;
        v_aviso_tipo := 'comprobante';
        v_aviso_detalle := 'El cliente envió ' || v_tipo
            || '. Revisa si es el comprobante de pago.';
    END IF;

    -- ── Máquina de estados (solo texto) ──
    IF v_tipo = 'texto' THEN

        -- PASO 0: reinicio de la conversación
        -- Un saludo (o "reiniciar"/"menu") vuelve al inicio. Solo si el mensaje
        -- es corto, para no confundirlo con datos de envío ni con un usuario.
        IF char_length(v_txt) <= 25
           AND v_low_limpio ~ '^(hola|holaa+|holi+s?|holas|buen(as|os)|hey|hi|hello|reiniciar|reinicio|reset|menu|empezar|inicio|start|partamos|volver|limpiar|consulta|nueva|nuevo)$'
        THEN
            UPDATE public.vl_wa_chats
            SET estado = 'nuevo', cliente_id = NULL, cliente_sugerido = NULL
            WHERE id = v_chat.id;
            v_chat.estado := 'nuevo';
            v_chat.cliente_id := NULL;
        END IF;

        -- PASO 1: saludo + pedir usuario TikTok
        IF v_chat.estado = 'nuevo' THEN
            v_reply := 'holis, me das tu nombre de usuario en el live porfis?';
            v_nuevo_estado := 'esperando_tiktok';

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

            IF v_low ~ 'pag|transfer|comprob|abon|deposit' THEN
                v_avisar := true;
                v_aviso_tipo := 'pago';
                v_aviso_unico := true;
                v_aviso_detalle := 'El cliente dice que pagó. Revisa y confirma el pago para proseguir. Mensaje: "'
                    || left(v_txt, 200) || '"';
            END IF;
            v_reply := '';
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


-- ── Permisos ───────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.vl_wa_es_santiago(text) FROM anon, authenticated, public;
REVOKE ALL ON FUNCTION public.vl_wa_bloque_pago_para(uuid, uuid, boolean) FROM anon, authenticated, public;
REVOKE ALL ON FUNCTION public.vl_wa_procesar_cliente_identificado(uuid, uuid, uuid, text)
    FROM anon, authenticated, public;
REVOKE ALL ON FUNCTION public.vl_wa_conversacion_avanzar(uuid, text, text, text)
    FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_conversacion_avanzar(uuid, text, text, text)
    TO service_role;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] Bot v4 (memoria de datos de pago, paket/region, avisos tardios) OK' AS status;
