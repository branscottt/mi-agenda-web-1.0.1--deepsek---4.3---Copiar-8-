-- ============================================================
-- MIGRACIÓN 20261027: Ventas Live — Textos del bot v2 + avisos al negocio
-- Fecha: 2026-10-11
--
-- OBJETIVO: dejar el bot hablando lo mínimo (guion revisado 1 a 1 con el
-- dueño del negocio) y avisar SIEMPRE al negocio cuando hace falta una
-- persona. Todo lo que no requiere acción se calla.
--
-- Piezas:
--   1. vl_clientes: correo, contacto, courier, datos_envio (datos de envío).
--   2. Tabla vl_wa_avisos + RPCs (avisar al negocio en la web).
--   3. Cerebro v2: guion nuevo, un solo paso de datos de envío, courier
--      blue/paket ($3.500 paket se suma al total) y avisos.
--   4. vl_wa_chats_listar expone 'tiene_aviso'.
--
-- CAMBIOS DE GUION (respecto de 20261024):
--   [1] nuevo texto del saludo.
--   [2] ELIMINADO (no se regaña: todo texto vale como usuario).
--   [4] nuevo texto (pide la fotito de la prenda).
--   [5] ELIMINADO (silencia cuando ya no debe nada).
--   [6] nuevo texto (pago parcial).
--   [7] nuevo texto (pagará presencial).
--   [8] ELIMINADO.
--   [9] nuevo texto (solo total + datitos; sin lista de prendas).
--   [10] ELIMINADO -> AVISO al negocio.
--   [11] nuevo texto (pide TODOS los datos de envío de una vez).
--   [12] ELIMINADO.
--   [13]-[17] REEMPLAZADOS por un único estado esperando_datos_envio.
--   [18] nuevo texto (presencial: transferir ahora o pagar al verse).
--   [19] nuevo texto (envío: total + datitos + comprobante).
--   [21] ELIMINADO -> AVISO al negocio.
--   [22] ELIMINADO.
--   [23] ELIMINADO -> AVISO al negocio (probable comprobante).
-- ============================================================

-- ── 1. Campos nuevos en la ficha del cliente ────────────────
ALTER TABLE public.vl_clientes
    ADD COLUMN IF NOT EXISTS correo      text;
ALTER TABLE public.vl_clientes
    ADD COLUMN IF NOT EXISTS contacto    text;
ALTER TABLE public.vl_clientes
    ADD COLUMN IF NOT EXISTS courier     text;   -- 'blue' | 'paket' | NULL
ALTER TABLE public.vl_clientes
    ADD COLUMN IF NOT EXISTS datos_envio text;   -- texto crudo que envió el cliente

-- ── 2. Avisos al negocio ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vl_wa_avisos (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    chat_id     uuid REFERENCES public.vl_wa_chats(id) ON DELETE CASCADE,
    tipo        text NOT NULL,          -- comprobante | pago | sin_cliente | sin_courier | no_entendido
    detalle     text NOT NULL DEFAULT '',
    resuelto_en timestamptz,
    creado_en   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vl_wa_avisos_tenant
    ON public.vl_wa_avisos (tenant_id, creado_en DESC);

ALTER TABLE public.vl_wa_avisos ENABLE ROW LEVEL SECURITY;

-- ── 3. Cerebro v2 ───────────────────────────────────────────
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
    v_extra numeric := 0;          -- recargo de envío (paket)
    v_reply text := '';
    v_nuevo_estado text;
    v_datos_pago text := '';
    v_avisar boolean := false;
    v_aviso_tipo text := '';
    v_aviso_detalle text := '';
    v_correo text := '';
    v_contacto text := '';
    v_courier text := '';
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
    v_wa := '+' || v_wa;  -- E.164 (Meta entrega solo dígitos)

    v_tipo := lower(btrim(COALESCE(p_tipo, 'texto')));
    IF v_tipo NOT IN ('texto', 'imagen', 'audio', 'video', 'documento') THEN
        v_tipo := 'texto';
    END IF;
    v_txt := btrim(COALESCE(p_texto, ''));
    v_low := lower(v_txt);

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
            'ok', true,
            'enviar', false,
            'mensaje', '',
            'chat_estado', v_chat.estado,
            'cliente_id', v_chat.cliente_id,
            'cliente_tiktok', '',
            'proceso_estado', '',
            'modo', 'humano',
            'avisar_negocio', false
        );
    END IF;

    -- ── Medios (imagen/audio/...) ──
    -- Sin acuse al cliente: solo AVISO al negocio (probable comprobante).
    IF v_tipo <> 'texto' THEN
        v_avisar := true;
        v_aviso_tipo := 'comprobante';
        v_aviso_detalle := 'El cliente envió ' || v_tipo
            || '. Revisa si es el comprobante de pago.';
    END IF;

    -- ── Máquina de estados (solo texto) ──
    IF v_tipo = 'texto' THEN

        -- PASO 1: saludo + pedir usuario TikTok
        IF v_chat.estado = 'nuevo' THEN
            v_reply := 'holis, me das tu nombre de usuario en el live porfis?';
            v_nuevo_estado := 'esperando_tiktok';

        -- PASO 2: identificar cliente por @usuario
        ELSIF v_chat.estado = 'esperando_tiktok' THEN
            v_user := public.vl_normalizar_tiktok(v_txt);

            IF v_user = '' THEN
                -- [2] ELIMINADO: no se regaña, se espera a que escriba algo.
                v_nuevo_estado := 'esperando_tiktok';
            ELSE
                SELECT * INTO v_cli
                FROM public.vl_clientes
                WHERE tenant_id = p_tenant_id AND tiktok_user = v_user;

                IF v_cli.id IS NULL THEN
                    v_reply := 'No encontramos reservas para @' || v_user
                        || ' 😕 Revisa que sea el mismo usuario que usaste en el LIVE y vuelve a escribirlo.';
                    v_nuevo_estado := 'esperando_tiktok';
                ELSE
                    -- Asocia el número de WhatsApp al cliente (se guarda solo)
                    UPDATE public.vl_clientes
                    SET whatsapp = v_wa
                    WHERE id = v_cli.id;

                    UPDATE public.vl_wa_chats
                    SET cliente_id = v_cli.id
                    WHERE id = v_chat.id;
                    v_chat.cliente_id := v_cli.id;

                    SELECT * INTO v_proc
                    FROM public.vl_procesos
                    WHERE cliente_id = v_cli.id AND cerrado_en IS NULL
                    LIMIT 1;

                    IF v_proc.id IS NULL THEN
                        -- [4] nuevo: no tiene prendas -> pedir la fotito
                        v_reply := 'holis, tienes la fotito de lo que era?';
                        v_nuevo_estado := 'listo';
                    ELSE
                        SELECT COALESCE(SUM(precio - abonado) FILTER (WHERE estado = 'adjudicada'), 0),
                               count(*) FILTER (WHERE estado IN ('adjudicada', 'pagada'))
                        INTO v_saldo, v_n_items
                        FROM public.vl_items
                        WHERE proceso_id = v_proc.id;

                        IF v_proc.estado NOT IN ('esperando_whatsapp', 'identificando_cliente') THEN
                            IF v_saldo > 0 AND v_proc.estado = 'pago_parcial' THEN
                                -- [6] nuevo
                                v_reply := 'yapis, solo quedaria pendiente esta prenda de '
                                    || public.vl_wa_fmt_monto(v_saldo)
                                    || ' me mandas el pantallazo del comprobante porfis';
                            ELSIF v_proc.estado = 'pagara_presencial' THEN
                                -- [7] nuevo
                                v_reply := 'okis si lo quiere presencial puede pagar al momento de la entrega ahi quedaron guardadas sus cositas, mañana le hablo para coordinar la entrega 💜';
                            ELSE
                                -- [5] y [8] ELIMINADOS: silencio
                                v_reply := '';
                            END IF;
                            v_nuevo_estado := 'listo';

                        ELSIF v_saldo <= 0 THEN
                            -- [5] ELIMINADO: ya no debe nada -> silencio
                            v_reply := '';
                            v_nuevo_estado := 'listo';

                        ELSE
                            -- Cliente pendiente: entra en identificación (🔵)
                            IF v_proc.estado = 'esperando_whatsapp' THEN
                                UPDATE public.vl_procesos
                                SET estado = 'identificando_cliente'
                                WHERE id = v_proc.id;
                            END IF;

                            SELECT COALESCE(datos_pago, '') INTO v_datos_pago
                            FROM public.vl_config WHERE tenant_id = p_tenant_id;

                            -- [9] nuevo: solo el total + los datitos (sin lista)
                            v_reply := 'holis serian '
                                || public.vl_wa_fmt_monto(v_saldo)
                                || ' me avisa si va a querer envio o entrega presencial... ahora le dejo mis datitos para el deposito'
                                || chr(10) || chr(10)
                                || public.vl_wa_bloque_pago(v_datos_pago);

                            v_nuevo_estado := 'esperando_tipo_entrega';
                        END IF;
                    END IF;
                END IF;
            END IF;

        -- PASO 3: tipo de entrega
        ELSIF v_chat.estado = 'esperando_tipo_entrega' THEN
            SELECT * INTO v_cli FROM public.vl_clientes WHERE id = v_chat.cliente_id;

            IF v_cli.id IS NULL THEN
                -- [10] ELIMINADO -> AVISO al negocio
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

                -- [18] nuevo: transferir ahora o pagar cuando se vean
                v_reply := 'okis, ahi coordinamos la entrega, le dejo su '
                    || public.vl_wa_fmt_monto(v_saldo)
                    || ' puede transferir ahora o pagar cuando nos veamos...';
                v_nuevo_estado := 'esperando_forma_pago';

            ELSIF v_low LIKE '%env%' THEN
                UPDATE public.vl_clientes SET entrega_preferida = 'envio'
                WHERE id = v_cli.id;

                -- [11] nuevo: TODOS los datos de una vez + courier
                v_reply := 'okis me dejas tus datitos, nombre, direccion, comuna, contacto, correo, los envios pueden ser por blue o paket...';
                v_nuevo_estado := 'esperando_datos_envio';

            ELSE
                -- [12] ELIMINADO: silencio + aviso (el negocio lee el chat)
                v_avisar := true;
                v_aviso_tipo := 'no_entendido';
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
                -- Muy corto para ser datos de envío: no se responde.
                v_avisar := true;
                v_aviso_tipo := 'no_entendido';
                v_aviso_detalle := 'Mensaje muy corto esperando los datos de envío: "'
                    || left(v_txt, 200) || '"';

            ELSE
                -- 1) Guardar el texto crudo (lo lee el negocio en la app)
                UPDATE public.vl_clientes
                SET datos_envio = left(v_txt, 1000)
                WHERE id = v_cli.id;

                -- 2) Correo (detección por @)
                v_correo := substring(v_txt
                    from '[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}');

                -- 3) Teléfono (secuencia larga de dígitos, fuera del correo)
                v_contacto := substring(
                    regexp_replace(v_txt,
                        '[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}', ' ', 'g')
                    from '\+?\d[\d\s\-\.\(\)]{6,}\d');

                -- 4) Courier elegido por el cliente
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

                -- 5) Total: prendas + $3.500 de paket (blue se paga al recibir)
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

                -- [19] nuevo
                v_reply := 'gracias serian '
                    || public.vl_wa_fmt_monto(v_saldo + v_extra)
                    || ' su total, le dejo mis datitos'
                    || chr(10) || chr(10)
                    || public.vl_wa_bloque_pago(v_datos_pago)
                    || chr(10) || chr(10)
                    || 'me manda el comprobante cuando pueda porfis';

                -- Sin courier mencionado: lo elige el negocio (aviso)
                IF v_cli.courier IS NULL OR v_cli.courier = '' THEN
                    v_avisar := true;
                    v_aviso_tipo := 'sin_courier';
                    v_aviso_detalle := 'El cliente no indicó courier (blue/paket). Elegirlo a mano. Datos: '
                        || left(v_txt, 300);
                END IF;

                v_nuevo_estado := 'listo';
            END IF;

        -- PASO 5: presencial -> transfiere ahora o paga al verse
        ELSIF v_chat.estado = 'esperando_forma_pago' THEN
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

        -- PASO 6: conversación terminada -> silencio (habla el humano)
        ELSIF v_chat.estado = 'listo' THEN
            -- [21] ELIMINADO -> AVISO al negocio
            IF v_low ~ 'pag|transfer|comprob|abon|deposit' THEN
                v_avisar := true;
                v_aviso_tipo := 'pago';
                v_aviso_detalle := 'El cliente dice que pagó. Revisa y confirma el pago para proseguir. Mensaje: "'
                    || left(v_txt, 200) || '"';
            END IF;
            -- [22] ELIMINADO: cualquier otro mensaje queda solo en el chat
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
        INSERT INTO public.vl_wa_avisos (tenant_id, chat_id, tipo, detalle)
        VALUES (p_tenant_id, v_chat.id, v_aviso_tipo, COALESCE(v_aviso_detalle, ''));
    END IF;

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
        'proceso_estado', COALESCE(v_proc.estado, ''),
        'avisar_negocio', v_avisar,
        'aviso_tipo', v_aviso_tipo
    );
END;
$$;

-- ── 4. Helper: bloque de datos de pago ──────────────────────
-- Devuelve el bloque listo para pegar en el mensaje. Si el negocio todavía
-- no cargó sus datos, devuelve un texto neutro (nunca un bloque vacío).
CREATE OR REPLACE FUNCTION public.vl_wa_bloque_pago(p_datos text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
    SELECT CASE
        WHEN btrim(COALESCE(p_datos, '')) = ''
            THEN '📌 Los datos para transferir te los mando en un momento por aquí 💜'
        ELSE '💰 Datos para pagar:' || chr(10) || p_datos
    END;
$$;

-- ── 5. RPCs de avisos (panel) ───────────────────────────────
CREATE OR REPLACE FUNCTION public.vl_wa_avisos_listar()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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

    RETURN jsonb_build_object(
        'ok', true,
        'avisos', COALESCE((
            SELECT jsonb_agg(fila ORDER BY (fila->>'creado_en') DESC)
            FROM (
                SELECT jsonb_build_object(
                    'id', a.id,
                    'chat_id', a.chat_id,
                    'tipo', a.tipo,
                    'detalle', a.detalle,
                    'creado_en', a.creado_en,
                    'wa_id', COALESCE(c.wa_id, ''),
                    'tiktok_user', COALESCE(cl.tiktok_user, '')
                ) AS fila
                FROM public.vl_wa_avisos a
                LEFT JOIN public.vl_wa_chats c ON c.id = a.chat_id
                LEFT JOIN public.vl_clientes cl ON cl.id = c.cliente_id
                WHERE a.tenant_id = v_tenant AND a.resuelto_en IS NULL
            ) sub
        ), '[]'::jsonb)
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.vl_wa_aviso_resolver(p_aviso_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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

    UPDATE public.vl_wa_avisos
    SET resuelto_en = now()
    WHERE id = p_aviso_id AND tenant_id = v_tenant;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Aviso no encontrado');
    END IF;

    RETURN jsonb_build_object('ok', true);
END;
$$;

-- ── 6. Lista de conversaciones: agregar 'tiene_aviso' ───────
CREATE OR REPLACE FUNCTION public.vl_wa_chats_listar()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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

    RETURN jsonb_build_object(
        'ok', true,
        'chats', COALESCE((
            SELECT jsonb_agg(fila ORDER BY (fila->>'ultimo_en') DESC)
            FROM (
                SELECT jsonb_build_object(
                    'id', c.id,
                    'wa_id', c.wa_id,
                    'estado', c.estado,
                    'modo', c.modo,
                    'ultimo_mensaje', c.ultimo_mensaje,
                    'ultimo_en', c.ultimo_en,
                    'cliente_id', c.cliente_id,
                    'tiktok_user', COALESCE(cl.tiktok_user, ''),
                    'nombre_real', COALESCE(cl.nombre_real, ''),
                    'categoria', COALESCE(cl.categoria, 'nuevo'),
                    'tiene_aviso', EXISTS (
                        SELECT 1 FROM public.vl_wa_avisos a
                        WHERE a.chat_id = c.id AND a.resuelto_en IS NULL
                    ),
                    'sin_leer', (
                        SELECT count(*) FROM public.vl_wa_mensajes m
                        WHERE m.chat_id = c.id
                          AND m.direction = 'in'
                          AND m.creado_en > c.leido_en
                    )
                ) AS fila
                FROM public.vl_wa_chats c
                LEFT JOIN public.vl_clientes cl ON cl.id = c.cliente_id
                WHERE c.tenant_id = v_tenant
            ) sub
        ), '[]'::jsonb)
    );
END;
$$;

-- ── 7. Permisos ─────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.vl_wa_avisos_listar() FROM anon, public;
REVOKE ALL ON FUNCTION public.vl_wa_aviso_resolver(uuid) FROM anon, public;
REVOKE ALL ON FUNCTION public.vl_wa_bloque_pago(text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_avisos_listar() TO authenticated;
GRANT EXECUTE ON FUNCTION public.vl_wa_aviso_resolver(uuid) TO authenticated;

REVOKE ALL ON public.vl_wa_avisos FROM anon, authenticated;
GRANT ALL ON public.vl_wa_avisos TO service_role;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] Textos del bot v2 + avisos al negocio OK' AS status;
