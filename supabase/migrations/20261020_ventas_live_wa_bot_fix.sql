-- ============================================================
-- MIGRACIÓN: Ventas Live — Fase 2 WhatsApp (fix copy del bot)
-- Fecha: 2026-10-20
--
-- OBJETIVO: el mensaje "Tienes N prenda(s) guardadas y sin saldo
-- pendiente" contaba solo las prendas 'adjudicada'; un cliente en
-- ACUMULANDO con prendas ya pagadas veía "0 prendas guardadas".
-- Fix: el contador de guardadas suma 'adjudicada' + 'pagada'; el
-- saldo pendiente sigue derivándose solo de 'adjudicada'.
-- CREATE OR REPLACE conserva los permisos (service_role) previos.
-- ============================================================

CREATE OR REPLACE FUNCTION public.vl_wa_conversacion_avanzar(
    p_tenant_id uuid,
    p_wa_id text,
    p_texto text,
    p_tipo text DEFAULT 'texto'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_wa text;
    v_tipo text;
    v_txt text;
    v_low text;
    v_chat public.vl_wa_chats%ROWTYPE;
    v_cli public.vl_clientes%ROWTYPE;
    v_proc public.vl_procesos%ROWTYPE;
    v_user text;
    v_saldo numeric := 0;
    v_n_items int := 0;
    v_j int := 0;
    v_lineas text := '';
    v_items record;
    v_reply text := '';
    v_nuevo_estado text;
    v_datos_pago text := '';
    v_entrega_label text := '';
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
    v_wa := '+' || v_wa;  -- E.164 (Meta entrega solo dígitos, ej 56912345678)

    v_tipo := lower(btrim(COALESCE(p_tipo, 'texto')));
    IF v_tipo NOT IN ('texto', 'imagen', 'audio', 'video', 'documento') THEN
        v_tipo := 'texto';
    END IF;
    v_txt := btrim(COALESCE(p_texto, ''));
    v_low := lower(v_txt);

    -- ── Chat: asegurar fila + lock (serializa mensajes simultáneos) ──
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

    -- ── Medios (imagen/audio/...) ──
    -- No avanzan el flujo: acuse fijo (el comprobante lo revisa el admin).
    IF v_tipo <> 'texto' THEN
        v_reply := '¡Recibido! 📎 Si es tu comprobante de pago, el equipo lo está revisando 💜';
    END IF;

    -- ── Máquina de estados ──
    IF v_tipo = 'texto' AND v_reply = '' THEN

        -- PASO 1-2: saludo + pedir usuario TikTok
        IF v_chat.estado = 'nuevo' THEN
            v_reply := 'Holaa 😊 Para encontrar tus prendas reservadas, envíame tu nombre de usuario de TikTok tal como aparece (ej: @maria123).';
            v_nuevo_estado := 'esperando_tiktok';

        -- PASO 3: identificar cliente por @usuario
        ELSIF v_chat.estado = 'esperando_tiktok' THEN
            v_user := public.vl_normalizar_tiktok(v_txt);
            IF v_user = '' THEN
                v_reply := 'No entendí tu usuario 😅 Escríbelo tal como aparece en TikTok (ej: @maria123).';
            ELSE
                SELECT * INTO v_cli
                FROM public.vl_clientes
                WHERE tenant_id = p_tenant_id AND tiktok_user = v_user;
                IF v_cli.id IS NULL THEN
                    v_reply := 'No encontramos reservas para @' || v_user
                        || ' 😕 Revisa que sea el mismo usuario que usaste en el LIVE y vuelve a escribirlo.';
                ELSE
                    -- Asocia el número de WhatsApp al cliente (spec: se guarda solo)
                    UPDATE public.vl_clientes
                    SET whatsapp = v_wa
                    WHERE id = v_cli.id;

                    UPDATE public.vl_wa_chats
                    SET cliente_id = v_cli.id
                    WHERE id = v_chat.id;
                    v_chat.cliente_id := v_cli.id;

                    -- Proceso activo del cliente
                    SELECT * INTO v_proc
                    FROM public.vl_procesos
                    WHERE cliente_id = v_cli.id AND cerrado_en IS NULL
                    LIMIT 1;

                    IF v_proc.id IS NULL THEN
                        v_reply := '¡Hola @' || v_user
                            || '! Por ahora no tienes prendas reservadas 😊 Te esperamos en el próximo LIVE 💜';
                        v_nuevo_estado := 'listo';
                    ELSE
                        SELECT COALESCE(SUM(precio - abonado) FILTER (WHERE estado = 'adjudicada'), 0),
                               count(*) FILTER (WHERE estado IN ('adjudicada', 'pagada'))
                        INTO v_saldo, v_n_items
                        FROM public.vl_items
                        WHERE proceso_id = v_proc.id;

                        -- Proceso NO está en fase de identificación (ya pagó,
                        -- está acumulando, pago parcial, etc.): no reabrir flujo
                        IF v_proc.estado NOT IN ('esperando_whatsapp', 'identificando_cliente') THEN
                            IF v_saldo <= 0 THEN
                                v_reply := '¡Hola @' || v_user || '! Tienes ' || v_n_items
                                    || ' prenda(s) guardadas y sin saldo pendiente 💜 Te avisamos cuando estén listas.';
                            ELSIF v_proc.estado = 'pago_parcial' THEN
                                v_reply := '¡Hola @' || v_user || '! Te falta pagar '
                                    || public.vl_wa_fmt_monto(v_saldo)
                                    || ' por tus prendas. Cuando completes el pago, envíanos tu comprobante por aquí 💜';
                            ELSIF v_proc.estado = 'pagara_presencial' THEN
                                v_reply := '¡Hola @' || v_user || '! Tienes '
                                    || public.vl_wa_fmt_monto(v_saldo)
                                    || ' pendientes, que pagarás al recibir tus prendas 🤝 Te esperamos 💜';
                            ELSE
                                v_reply := '¡Hola @' || v_user
                                    || '! Estamos coordinando tu pedido, en breve te escribimos 💜';
                            END IF;
                            v_nuevo_estado := 'listo';
                        ELSIF v_saldo <= 0 THEN
                            v_reply := '¡Hola @' || v_user || '! Tienes ' || v_n_items
                                || ' prenda(s) guardadas y sin saldo pendiente 💜 Te avisamos cuando estén listas.';
                            v_nuevo_estado := 'listo';
                        ELSE
                            -- Cliente pendiente: entra en identificación (🔵)
                            IF v_proc.estado = 'esperando_whatsapp' THEN
                                UPDATE public.vl_procesos
                                SET estado = 'identificando_cliente'
                                WHERE id = v_proc.id;
                            END IF;

                            FOR v_items IN
                                SELECT descripcion, (precio - abonado) AS pendiente
                                FROM public.vl_items
                                WHERE proceso_id = v_proc.id AND estado = 'adjudicada'
                                ORDER BY creado_en
                            LOOP
                                v_j := v_j + 1;
                                v_lineas := v_lineas || v_j || ') '
                                    || CASE WHEN btrim(v_items.descripcion) = ''
                                            THEN 'Prenda'
                                            ELSE v_items.descripcion END
                                    || ' — ' || public.vl_wa_fmt_monto(v_items.pendiente)
                                    || chr(10);
                            END LOOP;

                            v_reply := '¡Hola @' || v_user || '! Encontramos tus prendas 🛍️' || chr(10)
                                || chr(10) || v_lineas || chr(10)
                                || 'Total a pagar: ' || public.vl_wa_fmt_monto(v_saldo)
                                || chr(10) || chr(10)
                                || '¿Cómo las quieres recibir? Responde: ENVÍO o ENTREGA PRESENCIAL.';
                            v_nuevo_estado := 'esperando_tipo_entrega';
                        END IF;
                    END IF;
                END IF;
            END IF;

        -- PASO 4: tipo de entrega
        ELSIF v_chat.estado = 'esperando_tipo_entrega' THEN
            SELECT * INTO v_cli FROM public.vl_clientes WHERE id = v_chat.cliente_id;
            IF v_cli.id IS NULL THEN
                v_reply := '¡Hola! Perdimos tu identificador 😅 Escríbenos de nuevo tu usuario de TikTok (ej: @maria123).';
                v_nuevo_estado := 'esperando_tiktok';
            ELSIF position('pres' in v_low) > 0 THEN
                UPDATE public.vl_clientes SET entrega_preferida = 'presencial'
                WHERE id = v_cli.id;
                v_entrega_label := 'entrega presencial 🤝';
                v_nuevo_estado := 'listo';
            ELSIF v_low LIKE '%env%' THEN
                UPDATE public.vl_clientes SET entrega_preferida = 'envio'
                WHERE id = v_cli.id;
                v_nuevo_estado := 'esperando_ciudad';
                v_reply := '¡Perfecto, envío! 📦 ¿A qué ciudad enviamos tus prendas?';
            ELSE
                v_reply := 'No entendí tu respuesta 🙏 Responde: ENVÍO o ENTREGA PRESENCIAL.';
            END IF;

            -- Entrega presencial: salta a PASO 6 (total + datos de pago)
            IF v_entrega_label <> '' THEN
                SELECT * INTO v_proc
                FROM public.vl_procesos
                WHERE cliente_id = v_cli.id AND cerrado_en IS NULL
                LIMIT 1;
                SELECT COALESCE(SUM(precio - abonado), 0), count(*)
                INTO v_saldo, v_n_items
                FROM public.vl_items
                WHERE proceso_id = v_proc.id AND estado = 'adjudicada';
                SELECT COALESCE(datos_pago, '') INTO v_datos_pago
                FROM public.vl_config WHERE tenant_id = p_tenant_id;

                IF v_proc.estado IN ('esperando_whatsapp', 'identificando_cliente') THEN
                    UPDATE public.vl_procesos SET estado = 'esperando_pago'
                    WHERE id = v_proc.id;
                END IF;

                v_reply := '¡Todo listo, @' || v_cli.tiktok_user || '! 🎉' || chr(10)
                    || '• Prendas: ' || v_n_items || chr(10)
                    || '• Total a pagar: ' || public.vl_wa_fmt_monto(v_saldo) || chr(10)
                    || '• Entrega: ' || v_entrega_label || chr(10) || chr(10)
                    || '💰 Datos para pagar:' || chr(10) || v_datos_pago || chr(10) || chr(10)
                    || 'Cuando hagas la transferencia, envíanos tu comprobante por aquí y lo confirmamos 💜';
                IF btrim(v_datos_pago) = '' THEN
                    v_reply := v_reply || chr(10) || chr(10)
                        || '📌 (El negocio aún no configura sus datos de pago; puedes pedirlos por este chat.)';
                END IF;
            END IF;

        -- PASO 5a: ciudad
        ELSIF v_chat.estado = 'esperando_ciudad' THEN
            SELECT * INTO v_cli FROM public.vl_clientes WHERE id = v_chat.cliente_id;
            IF v_cli.id IS NULL OR v_txt = '' OR v_txt = '-' THEN
                v_reply := '¿A qué ciudad enviamos tus prendas? 📦';
            ELSE
                UPDATE public.vl_clientes SET ciudad = left(v_txt, 120)
                WHERE id = v_cli.id;
                v_nuevo_estado := 'esperando_comuna';
                v_reply := '¡Anotado! ¿Y a qué comuna?';
            END IF;

        -- PASO 5b: comuna
        ELSIF v_chat.estado = 'esperando_comuna' THEN
            SELECT * INTO v_cli FROM public.vl_clientes WHERE id = v_chat.cliente_id;
            IF v_cli.id IS NULL OR v_txt = '' OR v_txt = '-' THEN
                v_reply := '¿A qué comuna enviamos tus prendas? 📦';
            ELSE
                UPDATE public.vl_clientes SET comuna = left(v_txt, 120)
                WHERE id = v_cli.id;
                v_nuevo_estado := 'esperando_direccion';
                v_reply := 'Perfecto 💜 ¿Cuál es la dirección? (calle, número, depto)';
            END IF;

        -- PASO 5c: dirección → PASO 6-7 (total + pago + esperando_pago)
        ELSIF v_chat.estado = 'esperando_direccion' THEN
            SELECT * INTO v_cli FROM public.vl_clientes WHERE id = v_chat.cliente_id;
            IF v_cli.id IS NULL OR v_txt = '' OR v_txt = '-' THEN
                v_reply := '¿Cuál es la dirección de entrega? (calle, número, depto) 📍';
            ELSE
                UPDATE public.vl_clientes SET direccion = left(v_txt, 200)
                WHERE id = v_cli.id;

                SELECT * INTO v_proc
                FROM public.vl_procesos
                WHERE cliente_id = v_cli.id AND cerrado_en IS NULL
                LIMIT 1;
                SELECT COALESCE(SUM(precio - abonado), 0), count(*)
                INTO v_saldo, v_n_items
                FROM public.vl_items
                WHERE proceso_id = v_proc.id AND estado = 'adjudicada';
                SELECT COALESCE(datos_pago, '') INTO v_datos_pago
                FROM public.vl_config WHERE tenant_id = p_tenant_id;

                IF v_proc.estado IN ('esperando_whatsapp', 'identificando_cliente') THEN
                    UPDATE public.vl_procesos SET estado = 'esperando_pago'
                    WHERE id = v_proc.id;
                END IF;

                v_reply := '¡Todo listo, @' || v_cli.tiktok_user || '! 🎉' || chr(10)
                    || '• Prendas: ' || v_n_items || chr(10)
                    || '• Total a pagar: ' || public.vl_wa_fmt_monto(v_saldo) || chr(10)
                    || '• Envío a: ' || v_cli.ciudad || ', ' || v_cli.comuna
                    || ' — ' || v_cli.direccion || chr(10) || chr(10)
                    || '💰 Datos para pagar:' || chr(10) || v_datos_pago || chr(10) || chr(10)
                    || 'Cuando hagas la transferencia, envíanos tu comprobante por aquí y lo confirmamos 💜';
                IF btrim(v_datos_pago) = '' THEN
                    v_reply := v_reply || chr(10) || chr(10)
                        || '📌 (El negocio aún no configura sus datos de pago; puedes pedirlos por este chat.)';
                END IF;
                v_nuevo_estado := 'listo';
            END IF;

        -- Conversación terminada: acuses amables (sin reabrir flujo)
        ELSIF v_chat.estado = 'listo' THEN
            IF v_low ~ 'pag|transfer|comprob|abon|listo|realiz' THEN
                v_reply := '¡Gracias! 💜 Estamos revisando tu comprobante y te confirmamos por este chat.';
            ELSE
                v_reply := '¡Hola! 😊 ¿En qué más te ayudamos? Si ya pagaste, envíanos tu comprobante por aquí.';
            END IF;
        END IF;
    END IF;

    -- ── Persistir y responder ──
    UPDATE public.vl_wa_chats
    SET estado = v_nuevo_estado,
        ultimo_mensaje = left(v_txt, 200),
        ultimo_en = now()
    WHERE id = v_chat.id;

    IF v_reply <> '' THEN
        INSERT INTO public.vl_wa_mensajes (tenant_id, chat_id, direction, tipo, body)
        VALUES (p_tenant_id, v_chat.id, 'out', 'texto', left(v_reply, 1000))
        RETURNING id INTO v_msg_id;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'enviar', v_reply <> '',
        'mensaje', v_reply,
        'chat_estado', v_nuevo_estado,
        'cliente_id', COALESCE(v_chat.cliente_id, v_cli.id),
        'cliente_tiktok', COALESCE(v_cli.tiktok_user, ''),
        'proceso_estado', COALESCE(v_proc.estado, '')
    );
END;
$$;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] Fase 2 WhatsApp — fix copy del bot OK' AS status;
