-- ============================================================
-- MIGRACIÓN 20261047: Ventas Live — Diagrama de procesos + alertas
-- Fecha: 2026-10-12
--
-- OBJETIVO (pedido del dueño, verbatim resumido):
--   1. Un DIAGRAMA con TODOS los procesos activos de una: por cliente, sus
--      "puntos" (región / entrega / courier / pago / fecha) visibles y
--      presionables para corregirlos a mano. Los valores se auto-rellenan
--      (de lo que ya sabe el sistema y del chat) y se pueden cambiar.
--   2. Alerta "posible soltar prenda": cliente que debe plata y no escribe
--      hace 3+ días. Se ve en el diagrama Y en el mismo chat.
--   3. Ocultar chats que no son de venta (no aparecen en la web).
--   4. Botón "Bloquear y borrar": bloquea al usuario y borra sus datos
--      personales. Acción destructiva: la decide el negocio a mano.
--
-- Piezas:
--   1. vl_clientes.region ('santiago'|'region'|NULL) + vl_wa_chats.oculto.
--   2. vl_procesos_diagrama()        -> todos los procesos + puntos.
--   3. vl_proceso_punto_set(...)     -> cambiar un punto a mano.
--   4. vl_wa_chat_ocultar(...)       -> ocultar / mostrar un chat.
--   5. vl_wa_chats_listar() v3       -> oculto + alerta soltar_prenda.
--   6. vl_cliente_bloquear_borrar()  -> bloquear + borrar datos personales.
--
-- Idempotente (ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE + DROP/ADD CHECK).
-- ============================================================

-- ── 1. Columnas nuevas ──────────────────────────────────────
ALTER TABLE public.vl_clientes
    ADD COLUMN IF NOT EXISTS region text;

ALTER TABLE public.vl_clientes
    DROP CONSTRAINT IF EXISTS vl_clientes_region_check;
ALTER TABLE public.vl_clientes
    ADD CONSTRAINT vl_clientes_region_check
    CHECK (region IS NULL OR region IN ('santiago', 'region'));

ALTER TABLE public.vl_wa_chats
    ADD COLUMN IF NOT EXISTS oculto boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_vl_wa_chats_tenant_cliente
    ON public.vl_wa_chats (tenant_id, cliente_id);

-- ── 2. Diagrama: todos los procesos activos con sus puntos ──
-- Cada punto trae {valor, opciones, manual}. La UI los pinta como chips:
-- se ve el valor actual (auto-rellenado) y al presionar se cambia.
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
            pr.estado,
            c.id AS cliente_id,
            c.tiktok_user,
            c.nombre_real,
            c.whatsapp,
            c.categoria,
            c.region AS region_guardada,
            c.courier AS courier_guardado,
            c.entrega_preferida,
            c.datos_envio,
            c.comuna,
            c.ciudad,
            public.vl_saldo_proceso(pr.id) AS saldo,
            COALESCE((
                SELECT sum(i.precio) FROM public.vl_items i
                WHERE i.proceso_id = pr.id AND i.estado IN ('adjudicada', 'pagada')
            ), 0) AS total,
            (SELECT count(*) FROM public.vl_items i
             WHERE i.proceso_id = pr.id AND i.estado IN ('adjudicada', 'pagada')) AS prendas,
            (SELECT ev.tipo FROM public.vl_envios ev WHERE ev.proceso_id = pr.id) AS envio_tipo,
            (SELECT ev.empresa FROM public.vl_envios ev WHERE ev.proceso_id = pr.id) AS envio_empresa,
            (SELECT ev.fecha_programada FROM public.vl_envios ev WHERE ev.proceso_id = pr.id) AS envio_fecha,
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
                'estado', x.estado,
                'saldo', x.saldo,
                'total', x.total,
                'prendas', x.prendas,
                'dias_sin_contacto', x.dias_sin_contacto,
                'alerta', CASE
                    WHEN x.saldo > 0 AND x.dias_sin_contacto >= 3 THEN jsonb_build_object(
                        'tipo', 'soltar_prenda',
                        'dias', x.dias_sin_contacto,
                        'detalle', 'Sin contacto hace ' || x.dias_sin_contacto
                                   || ' día(s) y debe ' || public.vl_wa_fmt_monto(x.saldo)
                    )
                    ELSE NULL
                END,
                'cliente', jsonb_build_object(
                    'cliente_id', x.cliente_id,
                    'tiktok_user', x.tiktok_user,
                    'nombre_real', x.nombre_real,
                    'whatsapp', x.whatsapp,
                    'categoria', x.categoria
                ),
                'puntos', jsonb_build_object(
                    'region', jsonb_build_object(
                        'valor', COALESCE(
                            x.region_guardada,
                            CASE WHEN btrim(COALESCE(x.datos_envio, '') || COALESCE(x.comuna, '') || COALESCE(x.ciudad, '')) <> ''
                                 THEN CASE WHEN public.vl_wa_es_santiago(
                                          COALESCE(x.datos_envio, '') || ' ' || COALESCE(x.comuna, '') || ' ' || COALESCE(x.ciudad, ''))
                                      THEN 'santiago' ELSE 'region' END
                                 ELSE NULL END
                        ),
                        'opciones', jsonb_build_array(
                            jsonb_build_object('v', 'santiago', 'l', 'Santiago (RM)'),
                            jsonb_build_object('v', 'region',   'l', 'Región')
                        )
                    ),
                    'entrega', jsonb_build_object(
                        'valor', COALESCE(x.envio_tipo, x.entrega_preferida),
                        'opciones', jsonb_build_array(
                            jsonb_build_object('v', 'envio',      'l', 'Envío'),
                            jsonb_build_object('v', 'presencial', 'l', 'Presencial')
                        )
                    ),
                    'courier', jsonb_build_object(
                        'valor', x.courier_guardado,
                        'opciones', jsonb_build_array(
                            jsonb_build_object('v', 'blue',  'l', 'Blue Express'),
                            jsonb_build_object('v', 'paket', 'l', 'Paket')
                        )
                    ),
                    'pago', jsonb_build_object(
                        'valor', CASE
                            WHEN x.total <= 0   THEN 'sin_pedido'
                            WHEN x.saldo <= 0   THEN 'pagado'
                            WHEN x.saldo < x.total THEN 'parcial'
                            ELSE 'sin_pagar'
                        END,
                        'opciones', jsonb_build_array(
                            jsonb_build_object('v', 'pagado',    'l', 'Pagado'),
                            jsonb_build_object('v', 'parcial',   'l', 'Pago parcial'),
                            jsonb_build_object('v', 'sin_pagar', 'l', 'Sin pagar')
                        )
                    ),
                    'fecha', jsonb_build_object(
                        'valor', CASE WHEN x.envio_fecha IS NULL THEN NULL
                                      ELSE to_char(x.envio_fecha, 'YYYY-MM-DD') END,
                        'opciones', '[]'::jsonb,
                        'manual', true
                    )
                ),
                'envio', CASE WHEN x.envio_tipo IS NULL THEN NULL ELSE jsonb_build_object(
                    'tipo', x.envio_tipo, 'empresa', x.envio_empresa,
                    'fecha_programada', x.envio_fecha
                ) END
            ) ORDER BY
                (x.saldo > 0 AND x.dias_sin_contacto >= 3) DESC,
                x.dias_sin_contacto DESC,
                x.saldo DESC,
                x.tiktok_user ASC)
            FROM calc x
        ), '[]'::jsonb)
    ) INTO v_res;

    RETURN v_res;
END;
$function$;

-- ── 3. Cambiar un punto a mano ──────────────────────────────
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
        RETURN jsonb_build_object('ok', true, 'punto', 'region', 'valor', v_valor);

    ELSIF v_punto = 'courier' THEN
        IF v_valor NOT IN ('blue', 'paket', '') THEN
            RETURN jsonb_build_object('ok', false, 'error', 'Courier inválido');
        END IF;
        UPDATE public.vl_clientes
        SET courier = NULLIF(v_valor, ''), updated_at = now()
        WHERE id = v_cliente.id;
        RETURN jsonb_build_object('ok', true, 'punto', 'courier', 'valor', v_valor);

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

-- ── 4. Ocultar / mostrar un chat ────────────────────────────
CREATE OR REPLACE FUNCTION public.vl_wa_chat_ocultar(
    p_chat_id uuid,
    p_oculto boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_id uuid;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    UPDATE public.vl_wa_chats
    SET oculto = COALESCE(p_oculto, true), updated_at = now()
    WHERE id = p_chat_id AND tenant_id = v_tenant
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Conversación no encontrada');
    END IF;
    RETURN jsonb_build_object('ok', true, 'oculto', COALESCE(p_oculto, true));
END;
$function$;

-- ── 5. Lista de conversaciones v3 ───────────────────────────
-- Cambios vs la v2 (20261029): devuelve 'oculto' y, si el cliente debe plata
-- y no escribe hace 3+ días, deja el aviso derivado 'soltar_prenda' (aunque
-- no haya fila en vl_wa_avisos). El front filtra los ocultos.
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
                    SELECT public.vl_saldo_proceso(pr.id) AS saldo,
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

-- ── 6. Bloquear + borrar datos personales (DESTRUCTIVO) ─────
-- Bloquea al usuario, borra sus datos personales y lo deja en atención
-- humana (el bot deja de responderle). Conserva el @ y el historial de
-- montos (la plata no se borra); el negocio decide cuándo apretarlo.
CREATE OR REPLACE FUNCTION public.vl_cliente_bloquear_borrar(p_cliente_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_cli public.vl_clientes%ROWTYPE;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    SELECT * INTO v_cli
    FROM public.vl_clientes
    WHERE id = p_cliente_id AND tenant_id = v_tenant;
    IF v_cli.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Cliente no encontrado');
    END IF;

    UPDATE public.vl_clientes
    SET categoria   = 'bloqueado',
        nombre_real = '',
        whatsapp    = '',
        correo      = '',
        contacto    = '',
        datos_envio = '',
        ciudad      = '',
        comuna      = '',
        direccion   = '',
        region      = NULL,
        courier     = NULL,
        notas       = '',
        updated_at  = now()
    WHERE id = v_cli.id;

    UPDATE public.vl_wa_chats
    SET modo = 'humano', oculto = true, updated_at = now()
    WHERE tenant_id = v_tenant AND cliente_id = v_cli.id;

    UPDATE public.vl_wa_avisos
    SET resuelto_en = now()
    WHERE tenant_id = v_tenant
      AND resuelto_en IS NULL
      AND chat_id IN (
          SELECT id FROM public.vl_wa_chats
          WHERE tenant_id = v_tenant AND cliente_id = v_cli.id
      );

    RETURN jsonb_build_object(
        'ok', true,
        'cliente_id', v_cli.id,
        'tiktok_user', v_cli.tiktok_user
    );
END;
$function$;

-- ── 7. Permisos ─────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.vl_procesos_diagrama() FROM anon, public;
REVOKE ALL ON FUNCTION public.vl_proceso_punto_set(uuid, text, text, date) FROM anon, public;
REVOKE ALL ON FUNCTION public.vl_wa_chat_ocultar(uuid, boolean) FROM anon, public;
REVOKE ALL ON FUNCTION public.vl_cliente_bloquear_borrar(uuid) FROM anon, public;

GRANT EXECUTE ON FUNCTION public.vl_procesos_diagrama() TO authenticated;
GRANT EXECUTE ON FUNCTION public.vl_proceso_punto_set(uuid, text, text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.vl_wa_chat_ocultar(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.vl_cliente_bloquear_borrar(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] Diagrama de procesos + alertas + bloquear/borrar OK' AS status;
