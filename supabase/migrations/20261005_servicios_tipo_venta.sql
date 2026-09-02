-- ============================================================
-- MIGRACIÓN: Servicios por promoción (paquete de N sesiones)
-- Fecha: 2026-10-05
--
-- PROBLEMA: los servicios solo soportan venta por sesión única
-- (un precio, una fecha, una hora → una cita). No existe forma
-- de ofrecer un paquete de N sesiones con precio promocional.
--
-- SOLUCIÓN:
--   servicios.tipo_venta        'sesion' (default) | 'promocion'
--   servicios.precio_individual precio de la sesión suelta
--   servicios.num_sesiones      N sesiones del paquete
--   servicios.precio_promocion  precio total del paquete
--
--   reservar_cita(+p_modalidad): si 'promocion' el precio por
--     cita = precio_promocion / num_sesiones (el servidor sigue
--     siendo la fuente del precio; la suma de las N citas = total
--     del paquete). Metadata de la notificación incluye modalidad.
--
--   reservar_citas_bulk: valida que la cantidad de items con
--     modalidad='promocion' de cada servicio sea exactamente
--     num_sesiones (integridad server-side) y propaga la modalidad.
--
-- Retrocompatible: servicios existentes quedan tipo_venta='sesion'
-- y el RPC con modalidad por defecto 'sesion' se comporta igual
-- que antes.
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: Columnas nuevas en servicios
-- ============================================================
ALTER TABLE public.servicios
    ADD COLUMN IF NOT EXISTS tipo_venta TEXT NOT NULL DEFAULT 'sesion',
    ADD COLUMN IF NOT EXISTS precio_individual NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS num_sesiones INT,
    ADD COLUMN IF NOT EXISTS precio_promocion NUMERIC(10,2);

-- ============================================================
-- PASO 2: reservar_cita con modalidad (sesion | promocion)
-- (copia exacta de la versión vigente 20260925 + p_modalidad)
-- ============================================================
-- Eliminar la sobrecarga previa de 6 parámetros: con dos firmas
-- PostgREST no puede elegir candidata (PGRST203) y toda reserva
-- falla. La firma nueva (7 parámetros) cubre el caso con el
-- default p_modalidad='sesion'.
DROP FUNCTION IF EXISTS public.reservar_cita(uuid, bigint, date, text, jsonb, uuid);

CREATE OR REPLACE FUNCTION public.reservar_cita(
    p_tenant_id UUID,
    p_servicio_id BIGINT,
    p_fecha DATE,
    p_hora TEXT,
    p_contacto JSONB,
    p_trabajador_id UUID DEFAULT NULL,
    p_modalidad TEXT DEFAULT 'sesion'
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
    v_trab public.trabajadores%ROWTYPE;
    v_week TEXT;
    v_dow TEXT;
    v_horario JSONB;
    v_dia JSONB;
    v_h INT;
    v_ini INT;
    v_fin INT;
    v_ci INT;
    v_cf INT;
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

    -- ============ Modalidad promoción: precio del servidor ============
    -- El precio por cita = total del paquete / N sesiones. El cliente
    -- NUNCA manda el precio; solo la modalidad. La suma de las N citas
    -- equivale exactamente al precio_promocion del servicio.
    IF p_modalidad = 'promocion' THEN
        IF COALESCE(v_servicio.tipo_venta, 'sesion') <> 'promocion' THEN
            RETURN jsonb_build_object('ok', false, 'error', 'El servicio no ofrece promoción');
        END IF;
        IF v_servicio.num_sesiones IS NULL OR v_servicio.num_sesiones < 2
           OR v_servicio.precio_promocion IS NULL OR v_servicio.precio_promocion <= 0 THEN
            RETURN jsonb_build_object('ok', false, 'error', 'La promoción del servicio está mal configurada');
        END IF;
        v_precio := round(v_servicio.precio_promocion / v_servicio.num_sesiones, 2);
    END IF;

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

    -- ============ Validar trabajador (si se seleccionó) ============
    IF p_trabajador_id IS NOT NULL THEN
        -- 1. Existencia, tenant y activo. FOR UPDATE serializa reservas
        --    concurrentes del mismo trabajador (evita doble reserva).
        SELECT * INTO v_trab
        FROM public.trabajadores
        WHERE id = p_trabajador_id AND tenant_id = p_tenant_id
        FOR UPDATE;

        IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'error', 'El trabajador seleccionado no existe o no pertenece al negocio');
        END IF;
        IF v_trab.activo IS NOT TRUE THEN
            RETURN jsonb_build_object('ok', false, 'error', 'El trabajador seleccionado no está disponible');
        END IF;

        -- 2. Horario laboral: excepción de la semana ISO si existe,
        --    si no la plantilla semanal. Día: extract(isodow) 1=Lun..7=Dom.
        v_week := to_char(p_fecha, 'IYYY"-W"IW');
        v_dow := extract(isodow FROM p_fecha)::text;
        v_horario := COALESCE(v_trab.horario_excepciones -> v_week, v_trab.horario_semanal);
        v_dia := v_horario -> v_dow;

        IF v_dia IS NULL OR COALESCE((v_dia ->> 'activo')::boolean, false) IS NOT TRUE THEN
            RETURN jsonb_build_object('ok', false, 'error', 'El trabajador no labora en la fecha seleccionada');
        END IF;

        -- Hora dentro de [inicio, fin)
        v_h := (split_part(v_hora, ':', 1))::int * 60 + (split_part(v_hora, ':', 2))::int;
        v_ini := COALESCE((split_part(COALESCE(v_dia ->> 'inicio', '00:00'), ':', 1))::int, 0) * 60
               + COALESCE((split_part(COALESCE(v_dia ->> 'inicio', '00:00'), ':', 2))::int, 0);
        v_fin := COALESCE((split_part(COALESCE(v_dia ->> 'fin', '23:59'), ':', 1))::int, 23) * 60
               + COALESCE((split_part(COALESCE(v_dia ->> 'fin', '23:59'), ':', 2))::int, 59);
        IF v_h < v_ini OR v_h >= v_fin THEN
            RETURN jsonb_build_object('ok', false, 'error', 'El trabajador no labora a la hora seleccionada');
        END IF;

        -- Fuera de colación (solo si ambas horas están definidas: > 00:00 y ci < cf)
        v_ci := COALESCE((split_part(COALESCE(v_dia ->> 'colacion_inicio', '00:00'), ':', 1))::int, 0) * 60
              + COALESCE((split_part(COALESCE(v_dia ->> 'colacion_inicio', '00:00'), ':', 2))::int, 0);
        v_cf := COALESCE((split_part(COALESCE(v_dia ->> 'colacion_fin', '00:00'), ':', 1))::int, 0) * 60
              + COALESCE((split_part(COALESCE(v_dia ->> 'colacion_fin', '00:00'), ':', 2))::int, 0);
        IF v_ci > 0 AND v_cf > 0 AND v_ci < v_cf AND v_h >= v_ci AND v_h < v_cf THEN
            RETURN jsonb_build_object('ok', false, 'error', 'El trabajador está en colación a la hora seleccionada');
        END IF;

        -- 3. Sin doble reserva: otra cita del mismo trabajador a la
        --    misma fecha y hora (mismo tenant implícito por trabajador)
        IF EXISTS (
            SELECT 1 FROM public.citas
            WHERE trabajador_id = p_trabajador_id
              AND fecha = p_fecha
              AND hora = v_hora
              AND tenant_id = p_tenant_id
        ) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'El trabajador ya tiene una reserva a esa hora');
        END IF;
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
    -- Id único: epoch ms + sufijo aleatorio (evita colisiones en bulk)
    v_cita_id := (extract(epoch from now()) * 1000)::bigint::text || '-' || substr(md5(random()::text), 1, 4);
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
        jsonb_build_object('servicio', v_servicio.nombre, 'fecha', p_fecha::text, 'hora', v_hora, 'precio', v_precio, 'trabajador', COALESCE(v_trab.nombre, ''))
        || CASE WHEN p_modalidad = 'promocion'
                THEN jsonb_build_object('modalidad', 'promocion', 'num_sesiones', v_servicio.num_sesiones, 'precio_promocion', v_servicio.precio_promocion)
                ELSE '{}'::jsonb END
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

-- La firma cambió (7 parámetros): re-grantear la nueva firma.
GRANT EXECUTE ON FUNCTION public.reservar_cita(UUID, BIGINT, DATE, TEXT, JSONB, UUID, TEXT) TO anon, authenticated, public;

-- ============================================================
-- PASO 3: reservar_citas_bulk con validación de promociones
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
    v_promo RECORD;
    v_n INT;
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

    -- ============ Validar promociones antes de procesar ============
    -- La cantidad de items con modalidad='promocion' de cada servicio
    -- debe ser EXACTAMENTE num_sesiones del servicio (todo o nada).
    FOR v_promo IN
        SELECT (item->>'servicio_id')::bigint AS servicio_id, COUNT(*) AS cnt
        FROM jsonb_array_elements(p_items) item
        WHERE COALESCE(item->>'modalidad', 'sesion') = 'promocion'
        GROUP BY (item->>'servicio_id')::bigint
    LOOP
        SELECT num_sesiones INTO v_n
        FROM public.servicios
        WHERE id = v_promo.servicio_id AND tenant_id = p_tenant_id;

        IF v_n IS NULL OR v_n < 2 OR v_n <> v_promo.cnt THEN
            RETURN jsonb_build_object(
                'ok', false,
                'error', 'La promoción requiere exactamente ' || COALESCE(v_n::text, '?') || ' sesiones (se enviaron ' || v_promo.cnt || ')'
            );
        END IF;
    END LOOP;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        v_res := public.reservar_cita(
            p_tenant_id,
            COALESCE((v_item->>'servicio_id')::bigint, 0),
            COALESCE((v_item->>'fecha')::date, '1900-01-01'::date),
            COALESCE(v_item->>'hora', ''),
            p_contacto,
            NULLIF(v_item->>'trabajador_id', '')::uuid,
            COALESCE(v_item->>'modalidad', 'sesion')
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
-- Refresh schema cache + verificación
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '✅ servicios.tipo_venta + RPCs con modalidad promoción (precio server-side, validación bulk)' AS status;
