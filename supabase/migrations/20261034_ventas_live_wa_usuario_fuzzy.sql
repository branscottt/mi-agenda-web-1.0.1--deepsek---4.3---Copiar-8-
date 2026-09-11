-- ============================================================================
-- [VENTAS LIVE] Matcher de usuarios v2 para el bot de WhatsApp.
--
-- Problema real medido (los textos de la gente no son precisos):
--   · 'soy juan'    -> base 'soyjuan' != 'juan'   (muletillas)      -> hoy "ninguno"
--   · 'cami' x @cvmi-> similarity 0.25 < 0.5      (typo interior)   -> hoy "ninguno"
--   · 'hola soy juan' (13 chars) disparaba el reinicio por saludo y TIRABA el dato.
--
-- Qué cambia:
--   1. vl_wa_distancia_edicion(a,b): distancia de edicion (Levenshtein) en plpgsql,
--      sin depender de la extension fuzzystrmatch ni del esquema extensions.
--   2. vl_wa_candidatos_usuario(txt): saca muletillas/politeness y devuelve los
--      candidatos a comparar, en orden de prioridad:
--        [texto crudo] [tokens unidos] [cada token]      (ej: soy juan -> soyjuan, juan)
--   3. vl_wa_resolver_usuario v2: puntua cada cliente contra cada candidato con
--      exacto 1.00 / colapsado 0.92 / prefijo 0.80 (ratio de largos >= 0.6) /
--      trigrama x0.95 / 1 - lev/max. Se queda con el primer candidato que
--      alcanza el umbral 0.60 y ahi recien pasa al siguiente.
--      tipo='exacto' SOLO si el cliente escribio el handle tal cual (sin
--      muletillas ni tolerancia): eso identifica directo. Todo lo inferido va
--      como 'parecido' -> el bot pregunta "eres @x?" antes de tocar sus prendas.
--   4. Cerebro: el reinicio por saludo ahora exige que el mensaje sea SOLO el
--      saludo ('hola soy juan' ya no lo dispara); la rama "no" de la
--      confirmacion y la rama "no encontrado" pasan a RE-PREGUNTAR el usuario
--      (antes "no" dejaba el bot mudo y "no encontrado" mandaba el mensaje
--      formal con el eco @soy@camidellive).
--
-- Textos nuevos (revision 1 a 1, aprobados por el dueño):
--   no confirmado : 'okis, me lo escribes de nuevo porfis?'
--   no encontrado : 'no encontre ese usuario 😕 me lo escribes igual al del live porfis?'
-- ============================================================================

-- ── 1. Distancia de edicion (Levenshtein) en plpgsql ────────────────────────
CREATE OR REPLACE FUNCTION public.vl_wa_distancia_edicion(p_a text, p_b text)
RETURNS int
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
DECLARE
    v_a text := left(COALESCE(p_a, ''), 80);
    v_b text := left(COALESCE(p_b, ''), 80);
    v_la int;
    v_lb int;
    v_i int;
    v_j int;
    v_prev int[];
    v_cur int[];
    v_costo int;
BEGIN
    v_la := char_length(v_a);
    v_lb := char_length(v_b);
    IF v_la = 0 THEN RETURN v_lb; END IF;
    IF v_lb = 0 THEN RETURN v_la; END IF;

    v_prev := ARRAY(SELECT g FROM generate_series(0, v_lb) AS g);

    FOR v_i IN 1..v_la LOOP
        v_cur := ARRAY[v_i];
        FOR v_j IN 1..v_lb LOOP
            v_costo := CASE WHEN substr(v_a, v_i, 1) = substr(v_b, v_j, 1) THEN 0 ELSE 1 END;
            v_cur := v_cur || least(
                v_cur[v_j] + 1,        -- borrado
                v_prev[v_j + 1] + 1,   -- insercion
                v_prev[v_j] + v_costo  -- sustitucion
            );
        END LOOP;
        v_prev := v_cur;
    END LOOP;

    RETURN v_prev[v_lb + 1];
END;
$function$;

-- ── 2. Candidatos a comparar (saca muletillas de una respuesta humana) ──────
CREATE OR REPLACE FUNCTION public.vl_wa_candidatos_usuario(p_texto text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
    WITH st(w) AS (VALUES
        ('hola'),('holi'),('holis'),('holas'),('holaa'),('buenas'),('buenos'),('hey'),('hi'),('hello'),
        ('soy'),('es'),('eres'),('seria'),('sera'),('son'),('mi'),('mis'),('el'),('la'),('los'),('las'),
        ('un'),('una'),('del'),('de'),('usuario'),('usuaria'),('user'),('cuenta'),('perfil'),
        ('tiktok'),('tik'),('tok'),('live'),('en'),('nombre'),('apellido'),('apellidos'),
        ('me'),('llamo'),('llaman'),('creo'),('que'),('quizas'),('quiza'),('tal'),('vez'),
        ('aqui'),('aca'),('este'),('esta'),('esto'),('con'),('por'),('para'),('favor'),
        ('porfa'),('porfis'),('porfavor'),('gracias'),('ok'),('okey'),('dale'),('si'),('se'),
        ('siii'),('no'),('nose'),('a'),('al'),('y'),('o'),('tengo'),('era'),('puso'),('escribi'),
        ('escribio'),('como'),('cual'),('donde'),('ahora'),('sale'),('salio')
    ),
    base AS (
        SELECT regexp_replace(lower(COALESCE(p_texto, '')), '[^a-z0-9]', '', 'g')      AS crudo,
               regexp_replace(lower(COALESCE(p_texto, '')), '[^a-z0-9]+', ' ', 'g')    AS norm
    ),
    tk AS (
        SELECT b.crudo, q.tok, q.ord
        FROM base b
        LEFT JOIN LATERAL (
            SELECT tok, ord
            FROM unnest(string_to_array(btrim(b.norm), ' ')) WITH ORDINALITY AS u(tok, ord)
            WHERE char_length(tok) >= 3
              AND NOT EXISTS (SELECT 1 FROM st WHERE st.w = u.tok)
        ) q ON true
    ),
    armado AS (
        SELECT crudo,
               COALESCE(string_agg(tok, '' ORDER BY ord), '') AS unido,
               COALESCE(array_agg(tok ORDER BY ord) FILTER (WHERE tok IS NOT NULL), '{}') AS lista
        FROM tk
        GROUP BY crudo
    )
    SELECT array_remove(ARRAY[crudo, unido] || lista, '')
    FROM armado;
$function$;

-- ── 3. Resolver v2 ─────────────────────────────────────────────────────────
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

-- ── (los permisos y el NOTIFY van al final del archivo) ─────────────────────

-- ── 4. Cerebro del bot: reinicio por saludo ANCLADO + re-pregunta de usuario ─
-- (cuerpo completo reemplazado; el resto del flujo queda igual que en 20261029)
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

                v_reply := 'okis, ahi coordinamos la entrega, le dejo su '
                    || public.vl_wa_fmt_monto(v_saldo)
                    || ' puede transferir ahora o pagar cuando nos veamos...';
                v_nuevo_estado := 'esperando_forma_pago';

            ELSIF v_low LIKE '%env%' THEN
                UPDATE public.vl_clientes SET entrega_preferida = 'envio'
                WHERE id = v_cli.id;

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

-- ── 5. Permisos (mismo patron que 20261027/20261029) ────────────────────────
REVOKE ALL ON FUNCTION public.vl_wa_distancia_edicion(text, text)
    FROM anon, authenticated, public;
REVOKE ALL ON FUNCTION public.vl_wa_candidatos_usuario(text)
    FROM anon, authenticated, public;
REVOKE ALL ON FUNCTION public.vl_wa_resolver_usuario(uuid, text)
    FROM anon, authenticated, public;
REVOKE ALL ON FUNCTION public.vl_wa_conversacion_avanzar(uuid, text, text, text)
    FROM anon, authenticated, public;
-- El webhook (Edge Function) llama al cerebro con service_role: mantener el grant.
GRANT EXECUTE ON FUNCTION public.vl_wa_conversacion_avanzar(uuid, text, text, text)
    TO service_role;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] Matcher de usuarios v2 + re-pregunta de usuario OK' AS status;
