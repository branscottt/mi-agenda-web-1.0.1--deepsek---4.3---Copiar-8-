-- ============================================================================
-- [VENTAS LIVE] Registro de entregas del bot: la elección del cliente
-- (presencial / blue / paket) queda registrada y ordenada para el negocio.
--
-- Evidencia del hueco (medida):
--   · vl_envios_pendientes() lee SOLO vl_envios -> si el bot no crea la fila,
--     la elección del cliente no aparece en el bloque de entregas.
--   · vl_envios la crea únicamente vl_decidir_entrega (panel, proceso pagado).
--   · El bot solo escribía vl_clientes.entrega_preferida / courier.
--   · vl_envios ya tiene `notas`: ahí va LO QUE ESCRIBIÓ EL CLIENTE (tal cual).
--
-- Qué entra:
--   1. vl_wa_fecha_mencion(txt)  -> fragmento de fecha dicho por el cliente.
--   2. vl_wa_registrar_entrega() -> asegura la fila en vl_envios (no pisa lo que
--      ya decidió el negocio) y guarda la fecha mencionada en notas.
--   3. Cerebro: registra la elección + avisos con la regla operativa
--      (presencial / blue / paket con su plazo).
--   4. vl_envios_pendientes v2 -> agrega courier, notas, pago confirmado,
--      "siguiente paso" ya redactado, prioridad y grupos nuevos
--      (urgente_paket / esperando_pago) para que el negocio tenga la lista
--      ordenada sin leer chats.
--   5. vl_config_faltantes() -> avisa qué configuración falta ANTES de usar el
--      bot en producción (sin exponer valores).
-- ============================================================================

-- ── 1. Fecha mencionada por el cliente (texto crudo, tal cual lo escribió) ──
CREATE OR REPLACE FUNCTION public.vl_wa_fecha_mencion(p_texto text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
    SELECT COALESCE(
        btrim(substring(lower(COALESCE(p_texto, '')) from
            '(pasado\s+ma[nñ]ana|ma[nñ]ana|hoy|esta\s+(semana|tarde|noche)|el\s+finde|el\s+fin\s+de\s+semana'
            || '|finde|la\s+pr[oó]xima\s+semana'
            || '|el\s+pr[oó]xim[oa]\s+(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)'
            || '|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo'
            || '|\d{1,2}\s*[/-]\s*\d{1,2}(\s*[/-]\s*\d{2,4})?'
            || '|\d{1,2}\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)'
            || '|a\s+las\s+\d{1,2}(:\d{2})?)')),
        '');
$function$;

-- ── 2. Registrar la elección de entrega en vl_envios ────────────────────────
-- Crea la fila (o completa notas si estaba vacía). NUNCA pisa lo que el negocio
-- ya decidió: tipo/empresa/tracking/fecha/estado quedan como estaban.
CREATE OR REPLACE FUNCTION public.vl_wa_registrar_entrega(
    p_tenant_id uuid,
    p_cliente_id uuid,
    p_tipo text,
    p_notas text
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

    INSERT INTO public.vl_envios (tenant_id, proceso_id, tipo, notas)
    VALUES (p_tenant_id, v_proc, v_tipo, v_notas)
    ON CONFLICT (proceso_id) DO UPDATE
        SET notas = CASE
                        WHEN COALESCE(public.vl_envios.notas, '') = '' THEN v_notas
                        ELSE public.vl_envios.notas
                    END,
            updated_at = now();
END;
$function$;

-- ── Cerebro: registra la elección de entrega + avisos con la regla ──────────
-- (cuerpo completo; el resto del flujo igual que en 20261034)
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

                v_reply := 'okis, ahi coordinamos la entrega, le dejo su '
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
                    v_extra := 3500;
                END IF;

                SELECT COALESCE(datos_pago, '') INTO v_datos_pago
                FROM public.vl_config WHERE tenant_id = p_tenant_id;

                IF v_proc.estado IN ('esperando_whatsapp', 'identificando_cliente') THEN
                    UPDATE public.vl_procesos SET estado = 'esperando_pago'
                    WHERE id = v_proc.id;
                END IF;

                v_reply := 'gracias serian '
                    || public.vl_wa_fmt_monto(v_saldo + v_extra)
                    || ' su total, le dejo mis datitos'
                    || chr(10) || chr(10)
                    || public.vl_wa_bloque_pago(v_datos_pago)
                    || chr(10) || chr(10)
                    || 'me manda el comprobante cuando pueda porfis';

                IF v_cli.courier IS NULL OR v_cli.courier = '' THEN
                    v_avisar := true;
                    v_aviso_tipo := 'sin_courier';
                    v_aviso_unico := true;
                    v_aviso_detalle := 'El cliente no indicó courier (blue/paket). Elegirlo a mano. Datos: '
                        || left(v_txt, 300);
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
            -- cual en el registro de entrega para que el negocio la vea.
            v_fecha_dicha := public.vl_wa_fecha_mencion(v_txt);
            IF v_fecha_dicha <> '' THEN
                PERFORM public.vl_wa_registrar_entrega(
                    p_tenant_id, v_chat.cliente_id, 'presencial', v_fecha_dicha);
            END IF;

            IF v_low ~ 'transfer|deposit|abonar|te mando|te transfiero|ahora|cuenta|datos|de una|dale' THEN
                SELECT COALESCE(datos_pago, '') INTO v_datos_pago
                FROM public.vl_config WHERE tenant_id = p_tenant_id;

                SELECT * INTO v_proc
                FROM public.vl_procesos
                WHERE cliente_id = v_chat.cliente_id AND cerrado_en IS NULL
                LIMIT 1;
                SELECT COALESCE(SUM(precio - abonado), 0) INTO v_saldo
                FROM public.vl_items
                WHERE proceso_id = v_proc.id AND estado = 'adjudicada';

                v_reply := 'gracias serian '
                    || public.vl_wa_fmt_monto(v_saldo)
                    || ' su total, le dejo mis datitos'
                    || chr(10) || chr(10)
                    || public.vl_wa_bloque_pago(v_datos_pago)
                    || chr(10) || chr(10)
                    || 'me manda el comprobante cuando pueda porfis';
            ELSE
                v_reply := 'okis no hay problema nos vemos...';
            END IF;
            v_nuevo_estado := 'listo';

        -- PASO 6: conversación terminada -> silencio, aviso si dice que pagó
        ELSIF v_chat.estado = 'listo' THEN
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


-- ── 3. Bloque de entregas v2: ahora la elección del cliente llega acá sola, con
--      el "siguiente paso" ya redactado y la lista ordenada por prioridad ────
CREATE OR REPLACE FUNCTION public.vl_envios_pendientes()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_res jsonb;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    WITH fila AS (
        SELECT
            ev.id AS envio_id,
            ev.tipo,
            ev.empresa,
            ev.tracking,
            ev.fecha_programada,
            ev.estado AS envio_estado,
            COALESCE(ev.notas, '') AS notas,
            pr.id AS proceso_id,
            pr.estado AS proceso_estado,
            COALESCE(c.courier, '') AS courier,
            CASE WHEN pr.estado IN ('esperando_whatsapp', 'identificando_cliente',
                                    'esperando_pago', 'pago_parcial', 'pagara_presencial')
                 THEN false ELSE true END AS pago_confirmado,
            (pr.estado IN ('listo_preparar', 'envio_programado', 'envio_proceso')) AS puede_crear_envio,
            (pr.estado IN ('envio_proceso', 'entrega_presencial')) AS puede_marcar_entregado,
            c.tiktok_user, c.nombre_real, c.whatsapp, c.ciudad, c.comuna, c.direccion
        FROM public.vl_envios ev
        JOIN public.vl_procesos pr ON pr.id = ev.proceso_id
        JOIN public.vl_clientes c ON c.id = pr.cliente_id
        WHERE ev.tenant_id = v_tenant
          AND ev.estado IN ('pendiente', 'programado', 'en_proceso')
          AND pr.cerrado_en IS NULL
    ),
    calc AS (
        SELECT f.*,
            CASE
                WHEN f.tipo = 'presencial' THEN 'presenciales'
                WHEN f.envio_estado = 'en_proceso' THEN 'en_proceso'
                WHEN NOT f.pago_confirmado THEN 'esperando_pago'
                WHEN f.courier = 'paket' THEN 'urgente_paket'
                WHEN f.fecha_programada IS NULL OR f.fecha_programada <= CURRENT_DATE THEN 'hoy'
                WHEN f.fecha_programada = CURRENT_DATE + 1 THEN 'manana'
                WHEN f.fecha_programada > CURRENT_DATE + 1 THEN 'proximos'
                ELSE 'hoy'
            END AS grupo,
            CASE
                WHEN f.tipo = 'presencial' AND f.puede_marcar_entregado
                    THEN 'Listo para cerrar: marcar entregado.'
                WHEN f.tipo = 'presencial'
                    THEN 'Coordinar la entrega presencial'
                         || CASE WHEN f.notas <> '' THEN ' (dijo: ' || f.notas || ')' ELSE ' (sin fecha todavia)' END
                         || CASE WHEN NOT f.pago_confirmado THEN '. El pago todavia no esta registrado: puede ser al verse.' ELSE '.' END
                WHEN f.envio_estado = 'en_proceso'
                    THEN 'En camino: marcar entregado cuando llegue.'
                WHEN NOT f.pago_confirmado
                    THEN 'Esperar que se confirme el pago para crear el envio'
                         || CASE WHEN f.courier = 'paket' THEN ' en Paket (antes de las 23:59 del dia anterior)'
                                 WHEN f.courier = 'blue' THEN ' en Blue Express'
                                 ELSE ' (courier sin definir)' END
                WHEN f.courier = 'paket'
                    THEN 'Pedir en Paket ANTES de las 23:59 del dia anterior (solo Santiago, +$3.500)'
                WHEN f.courier = 'blue'
                    THEN 'Pedir en Blue Express (el envio se paga al recibir)'
                ELSE 'Elegir courier (blue o paket) y crear el envio'
            END AS siguiente_paso,
            CASE
                WHEN f.tipo = 'presencial' AND f.puede_marcar_entregado THEN 'entregado'
                WHEN f.tipo = 'presencial' THEN 'abrir_chat'
                WHEN f.envio_estado = 'en_proceso' THEN 'entregado'
                WHEN NOT f.pago_confirmado THEN 'abrir_chat'
                WHEN f.puede_crear_envio THEN 'crear_envio'
                ELSE 'abrir_chat'
            END AS accion,
            CASE
                WHEN f.tipo = 'presencial' AND f.puede_marcar_entregado THEN 1
                WHEN f.tipo = 'envio' AND f.courier = 'paket' AND f.pago_confirmado
                     AND f.envio_estado <> 'en_proceso' THEN 1
                WHEN f.tipo = 'presencial' THEN 2
                WHEN f.envio_estado = 'en_proceso' THEN 3
                WHEN NOT f.pago_confirmado THEN 7
                WHEN f.fecha_programada IS NULL OR f.fecha_programada <= CURRENT_DATE THEN 4
                WHEN f.fecha_programada = CURRENT_DATE + 1 THEN 5
                ELSE 6
            END AS prioridad
        FROM fila f
    )
    SELECT jsonb_build_object(
        'ok', true,
        'revisar_chat', true,   -- el negocio confirma en el chat antes de actuar
        'grupos', COALESCE((
            SELECT jsonb_object_agg(grupo, arr)
            FROM (
                SELECT grupo, jsonb_agg(jsonb_build_object(
                    'envio_id', envio_id,
                    'proceso_id', proceso_id,
                    'tipo', tipo,
                    'empresa', empresa,
                    'tracking', tracking,
                    'fecha_programada', fecha_programada,
                    'envio_estado', envio_estado,
                    'proceso_estado', proceso_estado,
                    'pago_confirmado', pago_confirmado,
                    'courier', courier,
                    'notas', notas,
                    'fecha_dicha', notas <> '',
                    'siguiente_paso', siguiente_paso,
                    'accion', accion,
                    'prioridad', prioridad,
                    'cliente', jsonb_build_object(
                        'tiktok_user', tiktok_user, 'nombre_real', nombre_real,
                        'whatsapp', whatsapp, 'ciudad', ciudad,
                        'comuna', comuna, 'direccion', direccion
                    )
                ) ORDER BY prioridad, fecha_programada ASC NULLS FIRST, tiktok_user ASC) AS arr
                FROM calc
                GROUP BY grupo
            ) g
        ), '{}'::jsonb)
    ) INTO v_res;

    RETURN v_res;
END;
$function$;

-- ── 4. Aviso de configuración faltante (sin exponer ningún valor) ───────────
CREATE OR REPLACE FUNCTION public.vl_config_faltantes()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_cfg public.vl_config%ROWTYPE;
    v_faltan jsonb := '[]'::jsonb;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    SELECT * INTO v_cfg FROM public.vl_config WHERE tenant_id = v_tenant;

    IF btrim(COALESCE(v_cfg.datos_pago, '')) = '' THEN
        v_faltan := v_faltan || jsonb_build_object('clave', 'datos_pago',
            'mensaje', 'Carga los datos para transferir: los va a recibir cada cliente que tenga que pagar.');
    END IF;

    IF btrim(COALESCE(v_cfg.wa_phone_id, '')) = ''
       OR btrim(COALESCE(v_cfg.wa_token, '')) = ''
       OR btrim(COALESCE(v_cfg.wa_verify_token, '')) = '' THEN
        v_faltan := v_faltan || jsonb_build_object('clave', 'whatsapp',
            'mensaje', 'Falta la conexión de WhatsApp (ID del número, token y verify token): sin eso el bot no envía nada.');
    END IF;

    IF btrim(COALESCE(v_cfg.whatsapp_negocio, '')) = '' THEN
        v_faltan := v_faltan || jsonb_build_object('clave', 'whatsapp_negocio',
            'mensaje', 'Carga el WhatsApp del negocio: es a donde te llegarían los avisos si se activan por WhatsApp.');
    END IF;

    IF COALESCE(v_cfg.wa_estado, '') <> 'conectado' THEN
        v_faltan := v_faltan || jsonb_build_object('clave', 'wa_estado',
            'mensaje', 'El bot figura como desconectado: conéctalo antes del LIVE o los clientes no reciben respuesta.');
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'listo_para_produccion', jsonb_array_length(v_faltan) = 0,
        'faltantes', v_faltan);
END;
$function$;

-- ── 5. Permisos ────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.vl_wa_fecha_mencion(text) FROM anon, authenticated, public;
REVOKE ALL ON FUNCTION public.vl_wa_registrar_entrega(uuid, uuid, text, text) FROM anon, authenticated, public;
REVOKE ALL ON FUNCTION public.vl_envios_pendientes() FROM anon, public;
REVOKE ALL ON FUNCTION public.vl_config_faltantes() FROM anon, public;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] Registro de entregas del bot + config faltante OK' AS status;
