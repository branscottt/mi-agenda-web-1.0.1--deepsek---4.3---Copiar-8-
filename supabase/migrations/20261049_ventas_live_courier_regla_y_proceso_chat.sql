-- ============================================================
-- MIGRACIÓN 20261049: Ventas Live — regla de courier + proceso en el chat
-- Fecha: 2026-10-12
--
-- PEDIDO DEL DUEÑO:
--   1. "si es de región es Blue, si es de Santiago es Paket" (que el sistema
--      lo tenga en consideración).
--   2. Que en el CHAT se vean las etiquetas del proceso: qué se hizo y qué
--      quedó definido (región, entrega, courier, pago, fecha), para no tener
--      que abrir el diagrama.
--
-- Piezas:
--   1. vl_proceso_puntos(p_proceso_id)  -> UNA sola fuente de verdad de los
--      "puntos" de un proceso (la usan el diagrama Y el chat).
--   2. vl_procesos_diagrama()           -> se reescribe usando el helper
--      (misma salida byte a byte: verificado con md5 antes/después).
--   3. vl_proceso_punto_set()           -> regla: Región => Blue (paket no
--      cubre regiones, se corrige); Santiago => Paket solo si aún no eligió.
--   4. vl_wa_chats_listar()             -> agrega 'proceso' por chat.
--
-- Idempotente. Sin DO $$.
-- ============================================================

-- ── 1. Puntos de un proceso (fuente única) ──────────────────
-- INTERNA: no se le da permiso a authenticated (no valida tenant por sí sola).
CREATE OR REPLACE FUNCTION public.vl_proceso_puntos(p_proceso_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_res jsonb;
BEGIN
    IF p_proceso_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT jsonb_build_object(
        'estado', pr.estado,
        'cliente_id', c.id,
        'saldo', public.vl_saldo_proceso(pr.id),
        'total', COALESCE((
            SELECT sum(i.precio) FROM public.vl_items i
            WHERE i.proceso_id = pr.id AND i.estado IN ('adjudicada', 'pagada')
        ), 0),
        'prendas', (
            SELECT count(*) FROM public.vl_items i
            WHERE i.proceso_id = pr.id AND i.estado IN ('adjudicada', 'pagada')
        ),
        'puntos', jsonb_build_object(
            'region', jsonb_build_object(
                'valor', COALESCE(
                    c.region,
                    CASE WHEN btrim(COALESCE(c.datos_envio, '') || COALESCE(c.comuna, '') || COALESCE(c.ciudad, '')) <> ''
                         THEN CASE WHEN public.vl_wa_es_santiago(
                                  COALESCE(c.datos_envio, '') || ' ' || COALESCE(c.comuna, '') || ' ' || COALESCE(c.ciudad, ''))
                              THEN 'santiago' ELSE 'region' END
                         ELSE NULL END
                ),
                'opciones', jsonb_build_array(
                    jsonb_build_object('v', 'santiago', 'l', 'Santiago (RM)'),
                    jsonb_build_object('v', 'region',   'l', 'Región')
                )
            ),
            'entrega', jsonb_build_object(
                'valor', COALESCE(ev.tipo, c.entrega_preferida),
                'opciones', jsonb_build_array(
                    jsonb_build_object('v', 'envio',      'l', 'Envío'),
                    jsonb_build_object('v', 'presencial', 'l', 'Presencial')
                )
            ),
            'courier', jsonb_build_object(
                'valor', c.courier,
                'opciones', jsonb_build_array(
                    jsonb_build_object('v', 'blue',  'l', 'Blue Express'),
                    jsonb_build_object('v', 'paket', 'l', 'Paket')
                )
            ),
            'pago', jsonb_build_object(
                'valor', CASE
                    WHEN COALESCE((
                        SELECT sum(i.precio) FROM public.vl_items i
                        WHERE i.proceso_id = pr.id AND i.estado IN ('adjudicada', 'pagada')
                    ), 0) <= 0 THEN 'sin_pedido'
                    WHEN public.vl_saldo_proceso(pr.id) <= 0 THEN 'pagado'
                    WHEN public.vl_saldo_proceso(pr.id) < COALESCE((
                        SELECT sum(i.precio) FROM public.vl_items i
                        WHERE i.proceso_id = pr.id AND i.estado IN ('adjudicada', 'pagada')
                    ), 0) THEN 'parcial'
                    ELSE 'sin_pagar'
                END,
                'opciones', jsonb_build_array(
                    jsonb_build_object('v', 'pagado',    'l', 'Pagado'),
                    jsonb_build_object('v', 'parcial',   'l', 'Pago parcial'),
                    jsonb_build_object('v', 'sin_pagar', 'l', 'Sin pagar')
                )
            ),
            'fecha', jsonb_build_object(
                'valor', CASE WHEN ev.fecha_programada IS NULL THEN NULL
                              ELSE to_char(ev.fecha_programada, 'YYYY-MM-DD') END,
                'opciones', '[]'::jsonb,
                'manual', true
            )
        ),
        'envio', CASE WHEN ev.tipo IS NULL THEN NULL ELSE jsonb_build_object(
            'tipo', ev.tipo, 'empresa', ev.empresa, 'fecha_programada', ev.fecha_programada
        ) END
    ) INTO v_res
    FROM public.vl_procesos pr
    JOIN public.vl_clientes c ON c.id = pr.cliente_id
    LEFT JOIN public.vl_envios ev ON ev.proceso_id = pr.id
    WHERE pr.id = p_proceso_id;

    RETURN v_res;
END;
$function$;

-- ── 2. Diagrama: misma salida, ahora con el helper ──────────
CREATE OR REPLACE FUNCTION public.vl_procesos_diagrama()
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

    WITH base AS (
        SELECT
            pr.id AS proceso_id,
            public.vl_proceso_puntos(pr.id) AS info,
            GREATEST(
                pr.creado_en,
                COALESCE((
                    SELECT max(m.creado_en)
                    FROM public.vl_wa_mensajes m
                    JOIN public.vl_wa_chats ch ON ch.id = m.chat_id
                    WHERE ch.cliente_id = c.id AND m.direction = 'in'
                ), pr.creado_en)
            ) AS ultimo_contacto
        FROM public.vl_procesos pr
        JOIN public.vl_clientes c ON c.id = pr.cliente_id
        WHERE pr.tenant_id = v_tenant AND pr.cerrado_en IS NULL
    ),
    calc AS (
        SELECT b.*, (CURRENT_DATE - b.ultimo_contacto::date) AS dias_sin_contacto
        FROM base b
    )
    SELECT jsonb_build_object(
        'ok', true,
        'total', (SELECT count(*) FROM calc),
        'procesos', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'proceso_id', x.proceso_id,
                'estado', x.info->>'estado',
                'saldo', (x.info->>'saldo')::numeric,
                'total', (x.info->>'total')::numeric,
                'prendas', (x.info->>'prendas')::int,
                'dias_sin_contacto', x.dias_sin_contacto,
                'alerta', CASE
                    WHEN (x.info->>'saldo')::numeric > 0 AND x.dias_sin_contacto >= 3 THEN jsonb_build_object(
                        'tipo', 'soltar_prenda',
                        'dias', x.dias_sin_contacto,
                        'detalle', 'Sin contacto hace ' || x.dias_sin_contacto
                                   || ' día(s) y debe ' || public.vl_wa_fmt_monto((x.info->>'saldo')::numeric)
                    )
                    ELSE NULL
                END,
                'cliente', jsonb_build_object(
                    'cliente_id', (x.info->>'cliente_id')::uuid,
                    'tiktok_user', cl.tiktok_user,
                    'nombre_real', cl.nombre_real,
                    'whatsapp', cl.whatsapp,
                    'categoria', cl.categoria
                ),
                'puntos', x.info->'puntos',
                'envio', x.info->'envio'
            ) ORDER BY
                ((x.info->>'saldo')::numeric > 0 AND x.dias_sin_contacto >= 3) DESC,
                x.dias_sin_contacto DESC,
                (x.info->>'saldo')::numeric DESC,
                cl.tiktok_user ASC)
            FROM calc x
            JOIN public.vl_clientes cl ON cl.id = (x.info->>'cliente_id')::uuid
        ), '[]'::jsonb)
    ) INTO v_res;

    RETURN v_res;
END;
$function$;

-- ── 3. Regla de courier al fijar la región ──────────────────
-- Región => Blue Express (paket solo cubre la RM: se corrige).
-- Santiago => Paket SOLO si todavía no eligió (si el cliente pidió Blue, se
-- respeta). Si elige Paket estando en región, se permite pero se avisa.
CREATE OR REPLACE FUNCTION public.vl_proceso_punto_set(
    p_proceso_id uuid,
    p_punto text,
    p_valor text,
    p_fecha date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_proc public.vl_procesos%ROWTYPE;
    v_cliente public.vl_clientes%ROWTYPE;
    v_punto text;
    v_valor text;
    v_courier_auto text := '';
    v_aviso text := '';
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    SELECT * INTO v_proc
    FROM public.vl_procesos
    WHERE id = p_proceso_id AND tenant_id = v_tenant;
    IF v_proc.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Proceso no encontrado');
    END IF;
    IF v_proc.cerrado_en IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El proceso ya está cerrado');
    END IF;

    SELECT * INTO v_cliente FROM public.vl_clientes WHERE id = v_proc.cliente_id;

    v_punto := lower(btrim(COALESCE(p_punto, '')));
    v_valor := lower(btrim(COALESCE(p_valor, '')));

    IF v_punto = 'region' THEN
        IF v_valor NOT IN ('santiago', 'region', '') THEN
            RETURN jsonb_build_object('ok', false, 'error', 'Región inválida');
        END IF;
        UPDATE public.vl_clientes
        SET region = NULLIF(v_valor, ''), updated_at = now()
        WHERE id = v_cliente.id;

        IF v_valor = 'region' THEN
            v_courier_auto := 'blue';           -- paket no llega fuera de la RM
        ELSIF v_valor = 'santiago' AND COALESCE(v_cliente.courier, '') = '' THEN
            v_courier_auto := 'paket';
        END IF;

        IF v_courier_auto <> '' THEN
            UPDATE public.vl_clientes
            SET courier = v_courier_auto, updated_at = now()
            WHERE id = v_cliente.id;
        END IF;

        RETURN jsonb_build_object('ok', true, 'punto', 'region', 'valor', v_valor,
                                  'courier_auto', v_courier_auto);

    ELSIF v_punto = 'courier' THEN
        IF v_valor NOT IN ('blue', 'paket', '') THEN
            RETURN jsonb_build_object('ok', false, 'error', 'Courier inválido');
        END IF;
        IF v_valor = 'paket' AND COALESCE(v_cliente.region, '') = 'region' THEN
            v_aviso := 'Ojo: Paket solo cubre Santiago (RM) y este cliente es de región.';
        END IF;
        UPDATE public.vl_clientes
        SET courier = NULLIF(v_valor, ''), updated_at = now()
        WHERE id = v_cliente.id;
        RETURN jsonb_build_object('ok', true, 'punto', 'courier', 'valor', v_valor, 'aviso', v_aviso);

    ELSIF v_punto = 'entrega' THEN
        IF v_valor NOT IN ('envio', 'presencial') THEN
            RETURN jsonb_build_object('ok', false, 'error', 'Tipo de entrega inválido');
        END IF;
        INSERT INTO public.vl_envios (tenant_id, proceso_id, tipo)
        VALUES (v_tenant, v_proc.id, v_valor)
        ON CONFLICT (proceso_id) DO UPDATE
            SET tipo = EXCLUDED.tipo, updated_at = now();
        UPDATE public.vl_clientes
        SET entrega_preferida = v_valor, updated_at = now()
        WHERE id = v_cliente.id;
        RETURN jsonb_build_object('ok', true, 'punto', 'entrega', 'valor', v_valor);

    ELSIF v_punto = 'fecha' THEN
        IF p_fecha IS NULL THEN
            RETURN jsonb_build_object('ok', false, 'error', 'Falta la fecha');
        END IF;
        INSERT INTO public.vl_envios (tenant_id, proceso_id, tipo, fecha_programada, estado)
        VALUES (v_tenant, v_proc.id, 'envio', p_fecha, 'programado')
        ON CONFLICT (proceso_id) DO UPDATE
            SET fecha_programada = EXCLUDED.fecha_programada, updated_at = now();
        IF v_proc.estado IN ('listo_preparar', 'pagado', 'acumulando') THEN
            UPDATE public.vl_procesos
            SET estado = 'envio_programado', updated_at = now()
            WHERE id = v_proc.id;
        END IF;
        RETURN jsonb_build_object('ok', true, 'punto', 'fecha', 'valor', to_char(p_fecha, 'YYYY-MM-DD'));

    ELSE
        RETURN jsonb_build_object('ok', false, 'error', 'Punto desconocido');
    END IF;
END;
$function$;

-- ── 4. Lista de conversaciones v4: el proceso va en el chat ──
-- Agrega 'proceso' (los puntos del pedido abierto del cliente, con el mismo
-- helper del diagrama) para pintar las etiquetas dentro del chat.
CREATE OR REPLACE FUNCTION public.vl_wa_chats_listar()
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
                    'oculto', c.oculto,
                    'ultimo_mensaje', c.ultimo_mensaje,
                    'ultimo_en', c.ultimo_en,
                    'cliente_id', c.cliente_id,
                    'tiktok_user', COALESCE(cl.tiktok_user, ''),
                    'nombre_real', COALESCE(cl.nombre_real, ''),
                    'categoria', COALESCE(cl.categoria, 'nuevo'),
                    'tiene_aviso', (av.tipo IS NOT NULL)
                                   OR (COALESCE(prl.saldo, 0) > 0 AND COALESCE(prl.dias, 0) >= 3),
                    'aviso_tipo', COALESCE(
                        av.tipo,
                        CASE WHEN COALESCE(prl.saldo, 0) > 0 AND COALESCE(prl.dias, 0) >= 3
                             THEN 'soltar_prenda' ELSE '' END,
                        ''
                    ),
                    'aviso_detalle', COALESCE(
                        av.detalle,
                        CASE WHEN COALESCE(prl.saldo, 0) > 0 AND COALESCE(prl.dias, 0) >= 3
                             THEN 'Sin contacto hace ' || prl.dias || ' día(s) y debe '
                                  || public.vl_wa_fmt_monto(prl.saldo)
                             ELSE '' END,
                        ''
                    ),
                    'proceso', public.vl_proceso_puntos(prl.proceso_id),
                    'sin_leer', (
                        SELECT count(*) FROM public.vl_wa_mensajes m
                        WHERE m.chat_id = c.id
                          AND m.direction = 'in'
                          AND m.creado_en > c.leido_en
                    )
                ) AS fila
                FROM public.vl_wa_chats c
                LEFT JOIN public.vl_clientes cl ON cl.id = c.cliente_id
                LEFT JOIN LATERAL (
                    SELECT a.tipo, a.detalle
                    FROM public.vl_wa_avisos a
                    WHERE a.chat_id = c.id AND a.resuelto_en IS NULL
                    ORDER BY a.creado_en DESC
                    LIMIT 1
                ) av ON true
                LEFT JOIN LATERAL (
                    SELECT pr.id AS proceso_id,
                           public.vl_saldo_proceso(pr.id) AS saldo,
                           GREATEST(0, CURRENT_DATE - COALESCE((
                               SELECT max(m2.creado_en) FROM public.vl_wa_mensajes m2
                               WHERE m2.chat_id = c.id AND m2.direction = 'in'
                           ), c.creado_en)::date) AS dias
                    FROM public.vl_procesos pr
                    WHERE pr.cliente_id = c.cliente_id AND pr.cerrado_en IS NULL
                    ORDER BY pr.creado_en DESC
                    LIMIT 1
                ) prl ON true
                WHERE c.tenant_id = v_tenant
            ) sub
        ), '[]'::jsonb)
    );
END;
$function$;

-- ── 5. Permisos ─────────────────────────────────────────────
-- El helper es INTERNO: no valida tenant, así que nadie lo ejecuta directo.
REVOKE ALL ON FUNCTION public.vl_proceso_puntos(uuid) FROM anon, authenticated, public;

REVOKE ALL ON FUNCTION public.vl_procesos_diagrama() FROM anon, public;
REVOKE ALL ON FUNCTION public.vl_proceso_punto_set(uuid, text, text, date) FROM anon, public;
REVOKE ALL ON FUNCTION public.vl_wa_chats_listar() FROM anon, public;

GRANT EXECUTE ON FUNCTION public.vl_procesos_diagrama() TO authenticated;
GRANT EXECUTE ON FUNCTION public.vl_proceso_punto_set(uuid, text, text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.vl_wa_chats_listar() TO authenticated;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] regla courier + proceso en el chat OK' AS status;
