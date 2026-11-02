-- ════════════════════════════════════════════════════════════════════════════
-- [VENTAS LIVE] (20261126) ENVÍOS COMO TABLERO (estilo Trello)
--
-- Pedido del dueño: la pestaña Envíos tiene que verse como el tablero de
-- reservas de clientes (ClientBoard): columnas + tarjetas arrastrables, con la
-- información del chat ya cargada (prendas, precios, contacto, fotos) y
-- editable a mano cuando el bot leyó algo mal.
--
--   1. vl_envios_pendientes v3: cada pedido trae
--        - columna calculada (blue / paket / presencial / sin_definir / otros / listo)
--        - items[]  (prenda, precio, abonado, estado)  -> "total por prenda"
--        - fotos[]  (últimas 6 imágenes que mandó el cliente, con su mensaje_id)
--        - etiquetas libres + nota interna + orden manual
--      y además incluye los pedidos ENTREGADOS de los últimos 7 días (antes el
--      pedido se cerraba y desaparecía: no se podía ver "lo que ya se entregó").
--      Se mantiene el campo `grupos` intacto para no romper una pestaña cacheada.
--   2. vl_entregas_tarjetas: orden dentro de la columna, etiquetas y nota
--      interna (lo único que NO viene del chat y por eso hay que persistir).
--   3. vl_tablero_mover: arrastrar una tarjeta = decisión REAL del pedido
--      (courier / presencial / dejar sin definir) con las mismas validaciones
--      que vl_corregir_entrega (respeta un envío ya en curso).
--   4. vl_tablero_orden / vl_tablero_tarjeta: guardar el tablero.
--   5. vl_item_editar: corregir descripción/precio de una prenda SIN pagos
--      (si ya hay plata registrada, se bloquea).
--   6. vl_wa_mensaje_media_borrar: borrar una foto del chat (doble confirmación
--      en la UI). Si el mensaje tenía texto, se conserva el texto.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Tabla de lo que se edita a mano ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vl_entregas_tarjetas (
    proceso_id uuid PRIMARY KEY REFERENCES public.vl_procesos(id) ON DELETE CASCADE,
    tenant_id  uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    orden      integer NOT NULL DEFAULT 0,
    etiquetas  jsonb NOT NULL DEFAULT '[]'::jsonb,
    nota       text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- La tabla solo se toca por RPC (SECURITY DEFINER): RLS cerrado y sin grants.
ALTER TABLE public.vl_entregas_tarjetas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.vl_entregas_tarjetas FROM anon, authenticated, public;

CREATE INDEX IF NOT EXISTS idx_vl_entregas_tarjetas_tenant
    ON public.vl_entregas_tarjetas (tenant_id, orden);

-- ── 2. vl_envios_pendientes v3 ──────────────────────────────────────────────
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

    RETURN (
        WITH base AS (
            SELECT
                pr.id AS proceso_id,
                pr.estado AS proceso_estado,
                pr.cerrado_en,
                pr.motivo_cierre,
                c.id AS cliente_id,
                c.tiktok_user, c.nombre_real, c.whatsapp, c.ciudad, c.comuna, c.direccion,
                COALESCE(c.correo, '')       AS correo,
                COALESCE(c.contacto, '')     AS contacto,
                COALESCE(c.datos_envio, '')  AS datos_envio,
                COALESCE(c.courier, '')      AS courier,
                COALESCE(c.entrega_preferida, '') AS entrega_preferida,
                (pt->'puntos'->'entrega'->>'valor')    AS entrega,
                (pt->'puntos'->'entrega'->>'sugerido') AS entrega_sugerida,
                (pt->'puntos'->'pago'->>'valor')       AS pago_punto,
                (pt->'puntos'->'fecha'->>'valor')      AS fecha_punto,
                COALESCE((pt->>'saldo')::numeric, 0)   AS saldo,
                COALESCE((pt->>'total')::numeric, 0)   AS total,
                COALESCE((pt->>'prendas')::int, 0)     AS prendas,
                ev.id AS envio_id, ev.empresa, ev.tracking, ev.notas,
                ev.estado AS envio_estado, ev.fecha_programada, ev.updated_at AS envio_updated_at,
                COALESCE(t.orden, 999999)  AS orden_tarjeta,
                COALESCE(t.etiquetas, '[]'::jsonb) AS etiquetas,
                COALESCE(t.nota, '')       AS nota_interna,
                -- Courier efectivo: lo que dijo el cliente (c.courier) manda;
                -- si ya se creó el envío, la empresa del envío completa el dato.
                CASE
                    WHEN lower(COALESCE(c.courier, '')) IN ('blue', 'blue_express', 'bluex', 'blue express') THEN 'blue'
                    WHEN lower(COALESCE(c.courier, '')) IN ('paket', 'packet', 'paquet') THEN 'paket'
                    WHEN lower(COALESCE(ev.empresa, '')) IN ('blue_express', 'blue') THEN 'blue'
                    WHEN lower(COALESCE(ev.empresa, '')) IN ('paket') THEN 'paket'
                    WHEN COALESCE(btrim(c.courier), '') <> '' OR COALESCE(btrim(ev.empresa), '') <> '' THEN 'otros'
                    ELSE ''
                END AS courier_ef,
                -- Prendas del pedido (para "total por prenda"): se excluye lo liberado.
                COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'id', i.id, 'descripcion', i.descripcion, 'precio', i.precio,
                        'abonado', i.abonado, 'estado', i.estado
                    ) ORDER BY i.creado_en)
                    FROM public.vl_items i
                    WHERE i.proceso_id = pr.id AND i.estado <> 'liberada'
                ), '[]'::jsonb) AS items,
                -- Fotos que mandó el cliente (bucket privado: el panel las firma).
                COALESCE((
                    SELECT jsonb_agg(f.foto ORDER BY f.creado_en DESC)
                    FROM (
                        SELECT jsonb_build_object(
                                   'mensaje_id', m.id,
                                   'media_path', m.media_path,
                                   'creado_en', m.creado_en
                               ) AS foto,
                               m.creado_en
                        FROM public.vl_wa_mensajes m
                        JOIN public.vl_wa_chats ch ON ch.id = m.chat_id
                        WHERE ch.cliente_id = c.id
                          AND ch.tenant_id = v_tenant
                          AND m.direction = 'in'
                          AND m.tipo = 'imagen'
                          AND m.media_path IS NOT NULL
                        ORDER BY m.creado_en DESC
                        LIMIT 6
                    ) f
                ), '[]'::jsonb) AS fotos
            FROM public.vl_procesos pr
            JOIN public.vl_clientes c ON c.id = pr.cliente_id
            CROSS JOIN LATERAL public.vl_proceso_puntos(pr.id) pt
            LEFT JOIN public.vl_envios ev
                   ON ev.proceso_id = pr.id AND ev.estado <> 'cancelado'
            LEFT JOIN public.vl_entregas_tarjetas t
                   ON t.proceso_id = pr.id AND t.tenant_id = pr.tenant_id
            WHERE pr.tenant_id = v_tenant
              -- Abiertos + SOLO los entregados de los últimos 7 días (columna
              -- LISTOS). Un pedido liberado/cancelado no es una entrega: no
              -- ensucia el tablero.
              AND (pr.cerrado_en IS NULL
                   OR (pr.cerrado_en > now() - interval '7 days'
                       AND pr.motivo_cierre = 'completado'))
        ),
        calc AS (
            SELECT b.*,
                CASE
                    WHEN b.cerrado_en IS NOT NULL
                         OR b.proceso_estado IN ('completado', 'entregado_por_cobrar')
                         OR b.envio_estado = 'entregado' THEN 'listo'
                    WHEN b.entrega = 'presencial' THEN 'presencial'
                    WHEN b.entrega = 'envio' AND b.courier_ef = 'blue' THEN 'blue'
                    WHEN b.entrega = 'envio' AND b.courier_ef = 'paket' THEN 'paket'
                    WHEN b.entrega = 'envio' AND b.courier_ef = 'otros' THEN 'otros'
                    ELSE 'sin_definir'
                END AS columna,
                CASE
                    WHEN b.proceso_estado = 'entregado_por_cobrar' AND b.saldo > 0 THEN 'por_cobrar'
                    WHEN b.cerrado_en IS NOT NULL THEN 'entregados'
                    WHEN b.envio_estado = 'entregado'
                         AND b.envio_updated_at > now() - interval '7 days' THEN 'entregados'
                    WHEN b.envio_estado = 'entregado' THEN 'entregados_viejos'
                    WHEN b.entrega IS NULL THEN 'sin_entrega'
                    WHEN b.saldo > 0 AND b.entrega = 'presencial'
                         AND b.fecha_programada IS NOT NULL THEN 'presenciales'
                    WHEN b.entrega = 'presencial' AND b.saldo > 0
                         AND b.fecha_programada IS NULL THEN 'sin_fecha'
                    WHEN b.saldo > 0 THEN 'esperando_pago'
                    WHEN b.proceso_estado IN ('envio_proceso', 'entrega_presencial') THEN 'listos'
                    WHEN b.envio_estado = 'en_proceso' THEN 'en_proceso'
                    WHEN b.courier = 'paket' THEN 'urgente_paket'
                    WHEN b.entrega = 'envio'
                         AND (b.envio_id IS NULL OR b.envio_estado = 'pendiente') THEN 'por_preparar'
                    WHEN b.fecha_programada IS NULL THEN 'sin_fecha'
                    WHEN b.fecha_programada <= CURRENT_DATE THEN 'hoy'
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
                    WHEN b.fecha_programada IS NULL THEN 8
                    WHEN b.fecha_programada <= CURRENT_DATE THEN 5
                    WHEN b.fecha_programada = CURRENT_DATE + 1 THEN 6
                    ELSE 7
                END AS prioridad
            FROM base b
        )
        SELECT jsonb_build_object(
            'ok', true,
            'revisar_chat', true,
            -- ── Compatibilidad: la pestaña vieja sigue leyendo `grupos` ──
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
                        'posible_soltar', (entrega = 'presencial'
                                           AND saldo > 0
                                           AND fecha_programada IS NULL),
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
                            'comuna', comuna, 'direccion', direccion,
                            'correo', correo, 'contacto', contacto,
                            'datos_envio', datos_envio
                        )
                    ) ORDER BY prioridad, (saldo > 0), fecha_programada NULLS LAST, tiktok_user) AS arr
                    FROM calc
                    GROUP BY grupo
                ) t
            ), '{}'::jsonb),
            -- ── Tablero: una tarjeta por pedido, con columna y orden ──
            'tarjetas', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'proceso_id', proceso_id,
                    'cliente_id', cliente_id,
                    'columna', columna,
                    'orden', orden_tarjeta,
                    'etiquetas', etiquetas,
                    'nota_interna', nota_interna,
                    'tipo', entrega,
                    'tipo_sugerido', entrega_sugerida,
                    'courier', courier_ef,
                    'courier_dicho', courier,
                    'empresa', empresa,
                    'tracking', tracking,
                    'fecha_programada', fecha_programada,
                    'envio_estado', envio_estado,
                    'envio_id', envio_id,
                    'proceso_estado', proceso_estado,
                    'cerrado', (cerrado_en IS NOT NULL),
                    'motivo_cierre', motivo_cierre,
                    'saldo', saldo,
                    'total', total,
                    'prendas', prendas,
                    'pagado', (saldo <= 0),
                    'notas', COALESCE(notas, ''),
                    'fecha_dicha', COALESCE(notas, '') <> '',
                    'posible_soltar', (entrega = 'presencial'
                                       AND saldo > 0
                                       AND fecha_programada IS NULL),
                    'siguiente_paso', siguiente_paso,
                    'accion', accion,
                    'prioridad', prioridad,
                    'items', items,
                    'fotos', fotos,
                    'cliente', jsonb_build_object(
                        'cliente_id', cliente_id,
                        'tiktok_user', tiktok_user, 'nombre_real', nombre_real,
                        'whatsapp', whatsapp, 'ciudad', ciudad,
                        'comuna', comuna, 'direccion', direccion,
                        'correo', correo, 'contacto', contacto,
                        'datos_envio', datos_envio,
                        'entrega_preferida', entrega_preferida
                    )
                ) ORDER BY
                    array_position(ARRAY['blue','paket','presencial','sin_definir','otros','listo']::text[], columna),
                    orden_tarjeta,
                    prioridad,
                    (saldo > 0),
                    fecha_programada NULLS LAST,
                    tiktok_user)
                FROM calc
            ), '[]'::jsonb)
        )
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_envios_pendientes() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_envios_pendientes() TO authenticated;

-- ── 3. Mover una tarjeta = decisión real del pedido ─────────────────────────
CREATE OR REPLACE FUNCTION public.vl_tablero_mover(p_proceso_id uuid, p_columna text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant  uuid;
    v_proc    public.vl_procesos%ROWTYPE;
    v_env     public.vl_envios%ROWTYPE;
    v_col     text;
    v_tipo    text;
    v_courier text;
    v_saldo   numeric;
    v_estado  text;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    v_col := lower(btrim(COALESCE(p_columna, '')));
    IF v_col NOT IN ('blue', 'paket', 'presencial', 'sin_definir') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Columna inválida');
    END IF;

    v_proc := public.vl_proceso_activo(p_proceso_id, v_tenant);
    IF v_proc.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Pedido no encontrado o ya cerrado');
    END IF;
    IF v_proc.estado IN ('completado', 'entregado_por_cobrar') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Ya está entregado: no se puede mover');
    END IF;

    SELECT * INTO v_env FROM public.vl_envios WHERE proceso_id = p_proceso_id;

    -- Un envío REAL en curso solo se anula/ cambia en el courier.
    IF v_env.id IS NOT NULL
       AND (v_env.estado = 'en_proceso' OR COALESCE(btrim(v_env.tracking), '') <> '') THEN
        RETURN jsonb_build_object('ok', false,
            'error', 'El envío ya está en curso ('
                     || COALESCE(NULLIF(v_env.empresa, ''), 'courier')
                     || '). Anúlalo en el courier antes de moverlo.');
    END IF;

    v_saldo := public.vl_saldo_proceso(p_proceso_id);

    IF v_col = 'sin_definir' THEN
        IF v_env.id IS NOT NULL AND v_env.estado NOT IN ('pendiente', 'programado') THEN
            RETURN jsonb_build_object('ok', false,
                'error', 'El envío ya está registrado: no se puede dejar sin definir');
        END IF;
        DELETE FROM public.vl_envios WHERE proceso_id = p_proceso_id;
        UPDATE public.vl_clientes
           SET entrega_preferida = NULL, courier = NULL, updated_at = now()
         WHERE id = v_proc.cliente_id;
        v_tipo := '';
    ELSIF v_col = 'presencial' THEN
        INSERT INTO public.vl_envios AS e (tenant_id, proceso_id, tipo, tipo_fijado_en)
        VALUES (v_tenant, p_proceso_id, 'presencial', now())
        ON CONFLICT (proceso_id) DO UPDATE
            SET tipo           = 'presencial',
                empresa        = NULL,
                tracking       = '',
                estado         = CASE WHEN e.estado = 'programado' THEN 'pendiente' ELSE e.estado END,
                tipo_fijado_en = now(),
                updated_at     = now();
        UPDATE public.vl_clientes
           SET entrega_preferida = 'presencial', courier = NULL, updated_at = now()
         WHERE id = v_proc.cliente_id;
        v_tipo := 'presencial';
    ELSE
        v_tipo    := 'envio';
        v_courier := v_col;  -- 'blue' | 'paket'
        INSERT INTO public.vl_envios AS e (tenant_id, proceso_id, tipo, tipo_fijado_en)
        VALUES (v_tenant, p_proceso_id, 'envio', now())
        ON CONFLICT (proceso_id) DO UPDATE
            SET tipo           = 'envio',
                -- Todavía no salió: la empresa se fija al crear el envío.
                empresa        = NULL,
                tracking       = '',
                tipo_fijado_en = now(),
                updated_at     = now();
        UPDATE public.vl_clientes
           SET entrega_preferida = 'envio', courier = v_courier, updated_at = now()
         WHERE id = v_proc.cliente_id;
    END IF;

    SELECT * INTO v_env FROM public.vl_envios WHERE proceso_id = p_proceso_id;

    -- Etapa del pedido: solo con el pedido saldado (misma regla que
    -- vl_corregir_entrega). Si debe plata, se mueve la tarjeta y nada más.
    v_estado := v_proc.estado;
    IF COALESCE(v_saldo, 0) <= 0
       AND v_proc.estado IN ('pagado', 'acumulando', 'listo_preparar',
                             'envio_programado', 'entrega_presencial') THEN
        IF v_tipo = 'presencial' THEN
            v_estado := 'entrega_presencial';
        ELSIF v_tipo = 'envio' AND v_env.estado = 'programado' AND v_env.fecha_programada IS NOT NULL THEN
            v_estado := 'envio_programado';
        ELSIF v_tipo = 'envio' THEN
            v_estado := 'listo_preparar';
        ELSIF v_proc.estado IN ('listo_preparar', 'envio_programado', 'entrega_presencial') THEN
            v_estado := 'pagado';
        END IF;
        IF v_estado <> v_proc.estado THEN
            UPDATE public.vl_procesos SET estado = v_estado WHERE id = p_proceso_id;
        END IF;
    END IF;

    RETURN jsonb_build_object('ok', true, 'proceso_id', p_proceso_id,
        'columna', v_col, 'tipo', v_tipo,
        'courier', CASE WHEN v_tipo = 'envio' THEN v_courier ELSE NULL END,
        'estado', v_estado);
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_tablero_mover(uuid, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_tablero_mover(uuid, text) TO authenticated;

-- ── 4. Guardar el orden de las tarjetas de una columna ──────────────────────
CREATE OR REPLACE FUNCTION public.vl_tablero_orden(p_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_id     uuid;
    v_i      integer := 0;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;
    IF COALESCE(array_length(p_ids, 1), 0) > 200 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Demasiadas tarjetas de una vez');
    END IF;

    FOREACH v_id IN ARRAY COALESCE(p_ids, ARRAY[]::uuid[]) LOOP
        v_i := v_i + 1;
        INSERT INTO public.vl_entregas_tarjetas AS t (proceso_id, tenant_id, orden)
        SELECT pr.id, v_tenant, v_i
        FROM public.vl_procesos pr
        WHERE pr.id = v_id AND pr.tenant_id = v_tenant
        ON CONFLICT (proceso_id) DO UPDATE
            SET orden = EXCLUDED.orden, updated_at = now();
    END LOOP;

    RETURN jsonb_build_object('ok', true, 'guardadas', v_i);
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_tablero_orden(uuid[]) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_tablero_orden(uuid[]) TO authenticated;

-- ── 5. Etiquetas libres + nota interna de una tarjeta ───────────────────────
CREATE OR REPLACE FUNCTION public.vl_tablero_tarjeta(
    p_proceso_id uuid,
    p_etiquetas jsonb DEFAULT '[]'::jsonb,
    p_nota text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_et     jsonb;
    v_item   jsonb;
    v_txt    text;
    v_n      integer := 0;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.vl_procesos pr
                   WHERE pr.id = p_proceso_id AND pr.tenant_id = v_tenant) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Pedido no encontrado');
    END IF;

    IF p_etiquetas IS NULL OR jsonb_typeof(p_etiquetas) <> 'array' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Etiquetas inválidas');
    END IF;

    v_et := '[]'::jsonb;
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_etiquetas) LOOP
        IF jsonb_typeof(v_item) <> 'string' THEN
            CONTINUE;
        END IF;
        v_txt := btrim(v_item #>> '{}');
        v_txt := regexp_replace(v_txt, '[<>]', '', 'g');
        v_txt := left(v_txt, 24);
        IF v_txt = '' THEN
            CONTINUE;
        END IF;
        v_n := v_n + 1;
        IF v_n > 8 THEN
            EXIT;
        END IF;
        IF NOT v_et @> jsonb_build_array(v_txt) THEN
            v_et := v_et || jsonb_build_array(v_txt);
        END IF;
    END LOOP;

    INSERT INTO public.vl_entregas_tarjetas AS t (proceso_id, tenant_id, etiquetas, nota)
    VALUES (p_proceso_id, v_tenant, v_et, left(COALESCE(p_nota, ''), 2000))
    ON CONFLICT (proceso_id) DO UPDATE
        SET etiquetas = EXCLUDED.etiquetas,
            nota      = EXCLUDED.nota,
            updated_at = now();

    RETURN jsonb_build_object('ok', true, 'etiquetas', v_et);
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_tablero_tarjeta(uuid, jsonb, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_tablero_tarjeta(uuid, jsonb, text) TO authenticated;

-- ── 6. Corregir una prenda (sin plata registrada) ───────────────────────────
CREATE OR REPLACE FUNCTION public.vl_item_editar(
    p_item_id uuid,
    p_descripcion text,
    p_precio numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_item   public.vl_items%ROWTYPE;
    v_desc   text;
    v_precio numeric;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    SELECT * INTO v_item FROM public.vl_items
     WHERE id = p_item_id AND tenant_id = v_tenant;
    IF v_item.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Prenda no encontrada');
    END IF;
    IF v_item.estado <> 'adjudicada' OR v_item.abonado > 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'La prenda ya tiene pagos: no se puede editar');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.vl_procesos pr
                   WHERE pr.id = v_item.proceso_id AND pr.cerrado_en IS NULL) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El pedido ya está cerrado');
    END IF;
    IF EXISTS (SELECT 1 FROM public.vl_pagos pg WHERE pg.proceso_id = v_item.proceso_id) THEN
        RETURN jsonb_build_object('ok', false, 'error',
            'El pedido ya tiene pagos registrados: corrige el precio en el LIVE');
    END IF;

    v_desc := left(btrim(COALESCE(p_descripcion, '')), 160);
    IF v_desc = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Escribe qué es la prenda');
    END IF;
    v_precio := COALESCE(p_precio, 0);
    IF v_precio <= 0 OR v_precio > 99999999 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Precio inválido');
    END IF;

    UPDATE public.vl_items
       SET descripcion = v_desc, precio = v_precio
     WHERE id = p_item_id;

    RETURN jsonb_build_object('ok', true, 'item_id', p_item_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_item_editar(uuid, text, numeric) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_item_editar(uuid, text, numeric) TO authenticated;

-- ── 7. Borrar una foto que mandó el cliente (desde el tablero) ──────────────
-- Devuelve media_path para que el panel borre el archivo del bucket. Si el
-- mensaje tenía texto (caption), se conserva el texto y solo se quita la foto.
CREATE OR REPLACE FUNCTION public.vl_wa_mensaje_media_borrar(p_mensaje_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_msg    public.vl_wa_mensajes%ROWTYPE;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    SELECT m.* INTO v_msg
    FROM public.vl_wa_mensajes m
    JOIN public.vl_wa_chats ch ON ch.id = m.chat_id
    WHERE m.id = p_mensaje_id
      AND m.tenant_id = v_tenant
      AND ch.tenant_id = v_tenant;

    IF v_msg.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Mensaje no encontrado');
    END IF;
    IF v_msg.direction <> 'in' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo se pueden borrar fotos que mandó el cliente');
    END IF;
    IF COALESCE(v_msg.media_path, '') = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Ese mensaje ya no tiene foto');
    END IF;

    IF btrim(COALESCE(v_msg.body, '')) = '' THEN
        DELETE FROM public.vl_wa_mensajes WHERE id = p_mensaje_id;
        RETURN jsonb_build_object('ok', true, 'media_path', v_msg.media_path, 'eliminado', true);
    END IF;

    UPDATE public.vl_wa_mensajes SET media_path = NULL WHERE id = p_mensaje_id;
    RETURN jsonb_build_object('ok', true, 'media_path', v_msg.media_path, 'eliminado', false);
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_wa_mensaje_media_borrar(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_mensaje_media_borrar(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] envíos como tablero (columnas, fotos, etiquetas, orden y edición con confirmación) OK' AS status;
