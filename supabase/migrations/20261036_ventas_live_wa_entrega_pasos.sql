-- ============================================================================
-- [VENTAS LIVE] Refinamientos del registro de entregas (sobre 20261035).
--
-- 1. vl_envios_pendientes: agrega los pasos que faltaban en la cadena para que
--    el negocio vaya "de la mano" por la web:
--      pago confirmado + entrega sin decidir -> 'decidir_envio' / 'decidir_presencial'
--      (el panel llama vl_decidir_entrega y recién ahí aparece "ENVÍO CREADO").
-- 2. vl_config_faltantes: whatsapp_negocio y wa_app_secret pasan a "recomendados"
--    (no son bloqueantes: el aviso por WhatsApp al negocio es opcional y el bot
--    funciona sin app secret). Evita la falsa alarma en un tenant ya en producción.
-- ============================================================================

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
            (pr.estado IN ('pagado', 'acumulando')) AS entrega_sin_decidir,
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
                WHEN f.tipo = 'presencial' AND f.entrega_sin_decidir
                    THEN 'Pago confirmado: marcar la entrega presencial en el pedido.'
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
                WHEN f.entrega_sin_decidir
                    THEN 'Pago confirmado: marcar el envio en el pedido y crear el envio'
                         || CASE WHEN f.courier = 'paket' THEN ' en Paket ANTES de las 23:59 del dia anterior'
                                 WHEN f.courier = 'blue' THEN ' en Blue Express' ELSE '' END
                WHEN f.courier = 'paket'
                    THEN 'Pedir en Paket ANTES de las 23:59 del dia anterior (solo Santiago, +$3.500)'
                WHEN f.courier = 'blue'
                    THEN 'Pedir en Blue Express (el envio se paga al recibir)'
                ELSE 'Elegir courier (blue o paket) y crear el envio'
            END AS siguiente_paso,
            CASE
                WHEN f.tipo = 'presencial' AND f.puede_marcar_entregado THEN 'entregado'
                WHEN f.tipo = 'presencial' AND f.entrega_sin_decidir THEN 'decidir_presencial'
                WHEN f.tipo = 'presencial' THEN 'abrir_chat'
                WHEN f.envio_estado = 'en_proceso' THEN 'entregado'
                WHEN NOT f.pago_confirmado THEN 'abrir_chat'
                WHEN f.puede_crear_envio THEN 'crear_envio'
                WHEN f.entrega_sin_decidir THEN 'decidir_envio'
                ELSE 'abrir_chat'
            END AS accion,
            CASE
                WHEN f.tipo = 'presencial' AND f.puede_marcar_entregado THEN 1
                WHEN f.tipo = 'envio' AND f.courier = 'paket' AND f.pago_confirmado
                     AND f.envio_estado <> 'en_proceso' THEN 1
                WHEN f.tipo = 'presencial' THEN 2
                WHEN f.entrega_sin_decidir THEN 2
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
        'revisar_chat', true,
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
    v_recom jsonb := '[]'::jsonb;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    SELECT * INTO v_cfg FROM public.vl_config WHERE tenant_id = v_tenant;

    -- Bloqueantes: sin esto el bot NO puede vender bien
    IF btrim(COALESCE(v_cfg.datos_pago, '')) = '' THEN
        v_faltan := v_faltan || jsonb_build_object('clave', 'datos_pago',
            'mensaje', 'Carga los datos para transferir: los recibe cada cliente que tenga que pagar.');
    END IF;

    IF btrim(COALESCE(v_cfg.wa_phone_id, '')) = ''
       OR btrim(COALESCE(v_cfg.wa_token, '')) = ''
       OR btrim(COALESCE(v_cfg.wa_verify_token, '')) = '' THEN
        v_faltan := v_faltan || jsonb_build_object('clave', 'whatsapp',
            'mensaje', 'Falta la conexion de WhatsApp (ID del numero, token y verify token): sin eso el bot no envia nada.');
    END IF;

    IF COALESCE(v_cfg.wa_estado, '') <> 'conectado' THEN
        v_faltan := v_faltan || jsonb_build_object('clave', 'wa_estado',
            'mensaje', 'El bot figura como desconectado: conectalo antes del LIVE o los clientes no reciben respuesta.');
    END IF;

    -- Recomendados: el bot funciona igual
    IF btrim(COALESCE(v_cfg.whatsapp_negocio, '')) = '' THEN
        v_recom := v_recom || jsonb_build_object('clave', 'whatsapp_negocio',
            'mensaje', 'Carga el WhatsApp del negocio para poder avisarte tambien por ahi (opcional).');
    END IF;

    IF btrim(COALESCE(v_cfg.wa_app_secret, '')) = '' THEN
        v_recom := v_recom || jsonb_build_object('clave', 'wa_app_secret',
            'mensaje', 'Sin el app secret del webhook no se valida la firma de Meta (recomendado para produccion).');
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'listo_para_produccion', jsonb_array_length(v_faltan) = 0,
        'faltantes', v_faltan,
        'recomendados', v_recom);
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_envios_pendientes() FROM anon, public;
REVOKE ALL ON FUNCTION public.vl_config_faltantes() FROM anon, public;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] Entregas: pasos decidir_envio/decidir_presencial + config OK' AS status;
