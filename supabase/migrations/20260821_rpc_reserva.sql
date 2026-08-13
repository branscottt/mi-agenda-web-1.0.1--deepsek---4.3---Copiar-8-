-- ============================================================
-- MIGRACIÓN: RPC de reserva transaccional (cupos server-side)
-- Fecha: 2026-08-21
--
-- PROBLEMA: el descuento de cupos se hacía client-side con un
-- UPDATE directo a servicios desde el navegador del cliente,
-- que el RLS revoca (anon sin UPDATE; cliente sin policy).
-- Resultado: la cita se creaba pero el cupo NO se descontaba
-- (sobreventa) y dos reservas simultáneas del último cupo no
-- se serializaban.
--
-- SOLUCIÓN: RPCs SECURITY DEFINER que ejecutan TODA la lógica
-- en el servidor, en una sola operación atómica:
--   reservar_cita       → valida + descuenta cupo + crea cita
--                         + crea notificación (todo o nada)
--   reservar_citas_bulk → lo mismo para el carrito (varias
--                         citas a la vez, todo o nada)
-- El precio lo toma del servicio (no del cliente). SELECT FOR
-- UPDATE serializa reservas simultáneas del mismo servicio.
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: RPC reservar_cita
-- ============================================================
CREATE OR REPLACE FUNCTION public.reservar_cita(
    p_tenant_id UUID,
    p_servicio_id BIGINT,
    p_fecha DATE,
    p_hora TEXT,
    p_contacto JSONB,
    p_trabajador_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_servicio public.servicios%ROWTYPE;
    v_modulos JSONB;
    v_hora TEXT;
    v_idx INT := -1;
    v_i INT;
    v_cupos INT;
    v_precio NUMERIC;
    v_cita_id TEXT;
    v_notif_id TEXT;
BEGIN
    -- ============ Validaciones ============
    IF p_tenant_id IS NULL OR p_servicio_id IS NULL OR p_fecha IS NULL OR p_hora IS NULL OR p_hora = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Faltan parámetros requeridos');
    END IF;
    IF p_contacto IS NULL OR COALESCE(p_contacto->>'nombre', '') = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El nombre del cliente es requerido');
    END IF;

    -- Normalizar hora "9:00" -> "09:00"
    v_hora := trim(p_hora);
    IF v_hora ~ '^(\d{1,2}):(\d{2})$' THEN
        v_hora := lpad(split_part(v_hora, ':', 1), 2, '0') || ':' || split_part(v_hora, ':', 2);
    END IF;
    IF v_hora !~ '^([01]\d|2[0-3]):[0-5]\d$' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Formato de hora inválido');
    END IF;

    -- Tenant activo
    IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = p_tenant_id AND estado = 'activo') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El negocio no está disponible');
    END IF;

    -- Fecha: hoy o futura; si es hoy, hora futura
    IF p_fecha < CURRENT_DATE THEN
        RETURN jsonb_build_object('ok', false, 'error', 'No se puede reservar en una fecha pasada');
    END IF;
    IF p_fecha = CURRENT_DATE AND v_hora <= to_char(now(), 'HH24:MI') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'La hora seleccionada ya pasó');
    END IF;

    -- ============ Servicio + bloqueo de fila (serializa reservas simultáneas) ============
    SELECT * INTO v_servicio
    FROM public.servicios
    WHERE id = p_servicio_id AND tenant_id = p_tenant_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Servicio no encontrado');
    END IF;
    IF v_servicio.activo IS NOT TRUE THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El servicio no está disponible');
    END IF;

    v_precio := COALESCE(v_servicio.precio, 0);

    -- ============ Buscar módulo por hora ============
    v_modulos := COALESCE(v_servicio.disponibilidad -> p_fecha::text, '[]'::jsonb);
    FOR v_i IN 0 .. jsonb_array_length(v_modulos) - 1 LOOP
        IF COALESCE(v_modulos -> v_i ->> 'hora', v_modulos -> v_i ->> 'startTime') = v_hora THEN
            v_idx := v_i;
            EXIT;
        END IF;
    END LOOP;

    IF v_idx = -1 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Horario no disponible para la fecha seleccionada');
    END IF;

    v_cupos := COALESCE((v_modulos -> v_idx ->> 'cupos')::int, 0);
    IF v_cupos <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El horario seleccionado está agotado');
    END IF;

    -- ============ Descontar cupo ============
    UPDATE public.servicios
    SET disponibilidad = jsonb_set(
            disponibilidad,
            ARRAY[p_fecha::text, v_idx::text, 'cupos'],
            to_jsonb(v_cupos - 1)
        )
    WHERE id = p_servicio_id;

    -- ============ Crear cita (precio del servidor, no del cliente) ============
    v_cita_id := (extract(epoch from now()) * 1000)::bigint::text;
    INSERT INTO public.citas (id, tenant_id, servicio_id, fecha, hora, precio, contacto, notificaciones, trabajador_id)
    VALUES (
        v_cita_id, p_tenant_id, p_servicio_id, p_fecha, v_hora, v_precio,
        p_contacto,
        '{"emailEnviado": false, "whatsappEnviado": false}'::jsonb,
        p_trabajador_id
    );

    -- ============ Notificación al admin ============
    v_notif_id := 'notif-' || v_cita_id;
    INSERT INTO public.notificaciones_admin (id, tenant_id, tipo, cita_id, fecha_original, hora_original, fecha_nueva, hora_nueva, cliente, leido, creado_en, metadata)
    VALUES (
        v_notif_id, p_tenant_id, 'nueva_reserva', v_cita_id,
        NULL, NULL, NULL, NULL,
        p_contacto, false, now(),
        jsonb_build_object('servicio', v_servicio.nombre, 'fecha', p_fecha::text, 'hora', v_hora, 'precio', v_precio)
    );

    RETURN jsonb_build_object(
        'ok', true,
        'cita_id', v_cita_id,
        'precio', v_precio,
        'fecha', p_fecha::text,
        'hora', v_hora
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.reservar_cita(UUID, BIGINT, DATE, TEXT, JSONB, UUID) TO anon, authenticated, public;

-- ============================================================
-- PASO 2: RPC reservar_citas_bulk (carrito, todo o nada)
-- ============================================================
CREATE OR REPLACE FUNCTION public.reservar_citas_bulk(
    p_tenant_id UUID,
    p_items JSONB,
    p_contacto JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_item JSONB;
    v_res JSONB;
    v_citas JSONB := '[]'::jsonb;
BEGIN
    IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Carrito vacío');
    END IF;
    IF p_contacto IS NULL OR COALESCE(p_contacto->>'nombre', '') = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El nombre del cliente es requerido');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = p_tenant_id AND estado = 'activo') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El negocio no está disponible');
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        v_res := public.reservar_cita(
            p_tenant_id,
            COALESCE((v_item->>'servicio_id')::bigint, 0),
            COALESCE((v_item->>'fecha')::date, '1900-01-01'::date),
            COALESCE(v_item->>'hora', ''),
            p_contacto,
            NULLIF(v_item->>'trabajador_id', '')::uuid
        );
        IF (v_res->>'ok')::boolean IS NOT TRUE THEN
            -- Fuerza rollback de TODO el carrito (items ya procesados incluidos)
            RAISE EXCEPTION 'RESERVA_BULK_FALLO: %', COALESCE(v_res->>'error', 'error desconocido');
        END IF;
        v_citas := v_citas || jsonb_build_object(
            'cita_id', v_res->>'cita_id',
            'servicio_id', v_item->>'servicio_id',
            'fecha', v_item->>'fecha',
            'hora', v_item->>'hora'
        );
    END LOOP;

    RETURN jsonb_build_object('ok', true, 'citas', v_citas);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.reservar_citas_bulk(UUID, JSONB, JSONB) TO anon, authenticated, public;

-- ============================================================
-- PASO 3: Refresh schema cache + verificación
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '[RESERVA] RPCs reservar_cita y reservar_citas_bulk creados (cupos server-side)' AS status;
