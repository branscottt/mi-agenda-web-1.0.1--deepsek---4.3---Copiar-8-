-- ============================================================================
-- [VENTAS LIVE] Presencial SIN fecha -> grupo SIN FECHA + marca "posible soltar
-- prenda" cuando no está pagada (silenciosa: el bot NO le escribe). (20261062)
--
-- Pedido del dueño: "si es presencial pero no han dicho fecha… si está pagado no
-- importa, pero si no lo ha pagado, dejar en sin fecha y con un aviso de posible
-- prenda para soltar pero no decir nada, así nosotros tomamos la decisión".
--
--   * La entrega PRESENCIAL SIN fecha ahora va al grupo 'sin_fecha' (antes caía
--     en 'presenciales'). La presencial CON fecha y sin pagar sigue en
--     'presenciales' (tarea de cobro).
--   * Cada fila lleva 'posible_soltar' = true cuando es presencial, sin fecha y
--     con saldo: en Envíos se pinta "⚠️ posible soltar prenda" y queda el botón
--     "Liberar prenda" para que el negocio decida.
-- ============================================================================

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
                    WHEN b.saldo > 0 AND b.entrega = 'presencial'
                         AND b.fecha_programada IS NOT NULL THEN 'presenciales'
                    -- Presencial sin fecha y SIN pagar -> SIN FECHA con la marca
                    -- 'posible soltar' (decide el negocio; el bot no escribe nada).
                    -- Va ANTES de la regla genérica de saldo para no caer en
                    -- 'esperando_pago'.
                    WHEN b.entrega = 'presencial' AND b.saldo > 0
                         AND b.fecha_programada IS NULL THEN 'sin_fecha'
                    WHEN b.saldo > 0 THEN 'esperando_pago'
                    WHEN b.proceso_estado IN ('envio_proceso', 'entrega_presencial') THEN 'listos'
                    WHEN b.envio_estado = 'en_proceso' THEN 'en_proceso'
                    WHEN b.courier = 'paket' THEN 'urgente_paket'
                    -- El envío todavía NO se creó en el courier (sin fila o en
                    -- 'pendiente'): el botón "ENVÍO CREADO" tiene que estar ahí.
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
                        -- Presencial sin fecha Y sin pagar: posible prenda a soltar
                        -- (silencioso: es un aviso para el negocio, no al cliente).
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

-- ── Permisos + recarga de esquema ───────────────────────────────────────────
REVOKE ALL ON FUNCTION public.vl_envios_pendientes() FROM anon, public;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] Presencial sin fecha -> SIN FECHA + posible soltar prenda OK' AS status;
