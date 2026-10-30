-- 20261110_ventas_live_corregir_entrega.sql
--
-- QUÉ HACE
--   Agrega vl_corregir_entrega(proceso, tipo): el NEGOCIO corrige a mano el
--   tipo de entrega (envío ⇄ presencial) cuando el bot/el repaso del chat se
--   equivocó. Es la contraparte de vl_decidir_entrega, que solo funciona con el
--   pedido recién pagado y en estado 'pagado'/'acumulando'.
--
-- POR QUÉ HACE FALTA
--   vl_decidir_entrega exige estado IN ('pagado','acumulando'). Si el bot ya
--   movió el pedido a 'listo_preparar', 'envio_programado' o
--   'entrega_presencial', la decisión queda bloqueada y desde el panel no había
--   forma de deshacer un tipo mal asignado.
--
-- REGLAS
--   · Sincroniza las TRES fuentes: vl_envios.tipo, vl_clientes.entrega_preferida
--     y la etapa del proceso (para que el panel, el bot y el diagrama digan lo
--     mismo).
--   · Marca vl_envios.tipo_fijado_en = now(): es una decisión del negocio, así
--     que vl_wa_repasar_entrega NO la pisa con mensajes viejos del cliente
--     (solo avisa si el cliente se contradice después).
--   · NO toca pedidos ya entregados (completado / entregado_por_cobrar).
--   · NO pasa a presencial si el envío ya está operativo (empresa, tracking o
--     estado en_proceso/entregado): ahí primero hay que anularlo en el courier.
--   · NO cambia la etapa si el pedido todavía debe plata (solo el tipo).
--   · Cierra el aviso 'entrega_cambio' abierto del chat (ya lo revisó alguien).
--
-- APLICAR: supabase db query --linked -f 20261110_ventas_live_corregir_entrega.sql

CREATE OR REPLACE FUNCTION public.vl_corregir_entrega(p_proceso_id uuid, p_tipo text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant  uuid;
    v_proc    public.vl_procesos%ROWTYPE;
    v_env     public.vl_envios%ROWTYPE;
    v_tipo    text;
    v_antes   text;
    v_estado  text;
    v_saldo   numeric;
    v_avisos  integer := 0;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    v_tipo := lower(btrim(COALESCE(p_tipo, '')));
    IF v_tipo NOT IN ('envio', 'presencial') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Tipo de entrega inválido');
    END IF;

    v_proc := public.vl_proceso_activo(p_proceso_id, v_tenant);
    IF v_proc.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Proceso no encontrado o ya cerrado');
    END IF;

    IF v_proc.estado IN ('completado', 'entregado_por_cobrar') THEN
        RETURN jsonb_build_object('ok', false,
            'error', 'Ya está entregado: el tipo de entrega no se puede cambiar');
    END IF;

    SELECT * INTO v_env FROM public.vl_envios WHERE proceso_id = p_proceso_id;
    v_antes := v_env.tipo;

    -- El envío ya salió: no se puede volver a presencial desde acá.
    IF v_tipo = 'presencial' AND v_env.id IS NOT NULL
       AND (COALESCE(btrim(v_env.empresa), '') <> ''
            OR COALESCE(btrim(v_env.tracking), '') <> ''
            OR v_env.estado IN ('en_proceso', 'entregado')) THEN
        RETURN jsonb_build_object('ok', false, 'error',
            'El envío ya está en curso (' || COALESCE(NULLIF(v_env.empresa, ''), 'courier')
            || '). Anúlalo en el courier antes de pasarlo a entrega presencial.');
    END IF;

    IF v_antes = v_tipo AND v_env.id IS NOT NULL THEN
        RETURN jsonb_build_object('ok', true, 'tipo', v_tipo, 'antes', v_antes,
            'estado', v_proc.estado, 'sin_cambios', true);
    END IF;

    INSERT INTO public.vl_envios AS e (tenant_id, proceso_id, tipo, tipo_fijado_en)
    VALUES (v_tenant, p_proceso_id, v_tipo, now())
    ON CONFLICT (proceso_id) DO UPDATE
        SET tipo           = v_tipo,
            tipo_fijado_en = now(),
            -- Si pasa a presencial, el courier deja de aplicar (arriba se validó
            -- que no había envío real en curso). La fecha que dijo el cliente se
            -- conserva: sigue sirviendo como día de entrega.
            empresa  = CASE WHEN v_tipo = 'presencial' THEN NULL ELSE e.empresa END,
            tracking = CASE WHEN v_tipo = 'presencial' THEN '' ELSE e.tracking END,
            estado   = CASE WHEN v_tipo = 'presencial' AND e.estado = 'programado'
                            THEN 'pendiente' ELSE e.estado END,
            updated_at = now();

    SELECT * INTO v_env FROM public.vl_envios WHERE proceso_id = p_proceso_id;

    -- Misma fuente que usa el bot y el repaso del chat.
    UPDATE public.vl_clientes
       SET entrega_preferida = v_tipo, updated_at = now()
     WHERE id = v_proc.cliente_id
       AND entrega_preferida IS DISTINCT FROM v_tipo;

    -- Etapa del pedido: solo con el pedido saldado (si debe, se cambia el tipo
    -- y nada más).
    v_saldo  := public.vl_saldo_proceso(p_proceso_id);
    v_estado := v_proc.estado;
    IF COALESCE(v_saldo, 0) <= 0
       AND v_proc.estado IN ('pagado', 'acumulando', 'listo_preparar',
                             'envio_programado', 'envio_proceso', 'entrega_presencial') THEN
        IF v_proc.estado = 'envio_proceso' THEN
            v_estado := 'envio_proceso';              -- nunca retroceder un envío en curso
        ELSIF v_tipo = 'presencial' THEN
            v_estado := 'entrega_presencial';
        ELSIF v_env.estado = 'programado' AND v_env.fecha_programada IS NOT NULL THEN
            v_estado := 'envio_programado';
        ELSIF v_proc.estado IN ('envio_programado', 'entrega_presencial') THEN
            v_estado := 'pagado';
        ELSE
            v_estado := v_proc.estado;                -- pagado / acumulando / listo_preparar
        END IF;
        IF v_estado <> v_proc.estado THEN
            UPDATE public.vl_procesos SET estado = v_estado WHERE id = p_proceso_id;
        END IF;
    END IF;

    -- El aviso "cambió la entrega" quedó atendido: se cierra (no se borra).
    UPDATE public.vl_wa_avisos a
       SET resuelto_en = now()
     WHERE a.tenant_id = v_tenant
       AND a.tipo = 'entrega_cambio'
       AND a.resuelto_en IS NULL
       AND a.chat_id IN (SELECT ch.id FROM public.vl_wa_chats ch
                          WHERE ch.tenant_id = v_tenant
                            AND ch.cliente_id = v_proc.cliente_id);
    GET DIAGNOSTICS v_avisos = ROW_COUNT;

    RETURN jsonb_build_object('ok', true, 'tipo', v_tipo, 'antes', COALESCE(v_antes, ''),
        'estado', v_estado, 'avisos_cerrados', v_avisos);
END;
$function$;

COMMENT ON FUNCTION public.vl_corregir_entrega(uuid, text) IS
    'Corrección manual del tipo de entrega (envio/presencial) desde el panel: sincroniza vl_envios.tipo, vl_clientes.entrega_preferida y la etapa del proceso, y respeta el envío ya en curso.';

REVOKE ALL ON FUNCTION public.vl_corregir_entrega(uuid, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_corregir_entrega(uuid, text) TO authenticated;
