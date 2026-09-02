-- ============================================================
-- MIGRACIÓN: Fix precio de citas de promoción (trigger fijar precio)
-- Fecha: 2026-10-06
--
-- PROBLEMA: reservar_cita calcula el precio por cita de un paquete
-- promocional (precio_promocion / num_sesiones) pero el trigger
-- trg_citas_fijar_precio (BEFORE INSERT) sobreescribía el precio
-- para no-admins con servicios.precio (precio de la sesión suelta).
-- Resultado: paquete de 4×$40.000 (Corte pelo) → 4 citas de $12.000
-- ($48.000) en vez de 4×$10.000 ($40.000). El total registrado no
-- coincidía con lo que paga el cliente.
--
-- SOLUCIÓN:
--   citas.modalidad  'sesion' | 'promocion' (nullable; NULL = flujos
--     previos/admin manuales → comportamiento actual).
--   citas_fijar_precio_servidor(): si la cita es de modalidad
--     'promocion' y el servicio es promoción bien configurada, el
--     precio se calcula del paquete (servidor, nunca del payload);
--     si no, comportamiento actual (servicios.precio). Admin sigue
--     conservando el control manual del precio.
--   reservar_cita: escribe la modalidad en la cita.
--
-- Retrocompatible: citas existentes modalidad NULL; inserts directos
-- de admin/reagendar/worker no cambian de comportamiento.
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: columna modalidad en citas
-- ============================================================
ALTER TABLE public.citas
    ADD COLUMN IF NOT EXISTS modalidad TEXT;

-- ============================================================
-- PASO 2: trigger de precio consciente de la modalidad
-- ============================================================
CREATE OR REPLACE FUNCTION public.citas_fijar_precio_servidor()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 AS $function$
DECLARE
    v_precio NUMERIC;
    v_servicio public.servicios%ROWTYPE;
BEGIN
    -- Admin/super_admin (user_roles = fuente de verdad server-side)
    -- conservan el control total del precio (edición manual de citas).
    IF public.is_admin() THEN
        RETURN NEW;
    END IF;

    -- No-admin (cliente/anon/trabajador): el precio SIEMPRE sale
    -- del servicio, nunca del payload. Además se valida que el
    -- servicio pertenezca al tenant de la cita.
    SELECT * INTO v_servicio
    FROM public.servicios
    WHERE id = NEW.servicio_id AND tenant_id = NEW.tenant_id;

    IF v_servicio.id IS NULL THEN
        RAISE EXCEPTION 'Servicio inválido para este negocio';
    END IF;

    -- Cita de paquete promocional: el precio por cita es el split del
    -- paquete (precio_promocion / num_sesiones). La suma de las N citas
    -- equivale exactamente al total que paga el cliente.
    IF NEW.modalidad = 'promocion'
       AND COALESCE(v_servicio.tipo_venta, 'sesion') = 'promocion'
       AND v_servicio.num_sesiones IS NOT NULL AND v_servicio.num_sesiones >= 2
       AND v_servicio.precio_promocion IS NOT NULL AND v_servicio.precio_promocion > 0 THEN
        v_precio := round(v_servicio.precio_promocion / v_servicio.num_sesiones, 2);
    ELSE
        v_precio := v_servicio.precio;
    END IF;

    NEW.precio := COALESCE(v_precio, 0);
    RETURN NEW;
END;
$function$;

-- ============================================================
-- PASO 3: reservar_cita escribe la modalidad en la cita
-- (copia de la versión 20261005 + columna modalidad en el INSERT)
-- ============================================================
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

        v_week := to_char(p_fecha, 'IYYY"-W"IW');
        v_dow := extract(isodow FROM p_fecha)::text;
        v_horario := COALESCE(v_trab.horario_excepciones -> v_week, v_trab.horario_semanal);
        v_dia := v_horario -> v_dow;

        IF v_dia IS NULL OR COALESCE((v_dia ->> 'activo')::boolean, false) IS NOT TRUE THEN
            RETURN jsonb_build_object('ok', false, 'error', 'El trabajador no labora en la fecha seleccionada');
        END IF;

        v_h := (split_part(v_hora, ':', 1))::int * 60 + (split_part(v_hora, ':', 2))::int;
        v_ini := COALESCE((split_part(COALESCE(v_dia ->> 'inicio', '00:00'), ':', 1))::int, 0) * 60
               + COALESCE((split_part(COALESCE(v_dia ->> 'inicio', '00:00'), ':', 2))::int, 0);
        v_fin := COALESCE((split_part(COALESCE(v_dia ->> 'fin', '23:59'), ':', 1))::int, 23) * 60
               + COALESCE((split_part(COALESCE(v_dia ->> 'fin', '23:59'), ':', 2))::int, 59);
        IF v_h < v_ini OR v_h >= v_fin THEN
            RETURN jsonb_build_object('ok', false, 'error', 'El trabajador no labora a la hora seleccionada');
        END IF;

        v_ci := COALESCE((split_part(COALESCE(v_dia ->> 'colacion_inicio', '00:00'), ':', 1))::int, 0) * 60
              + COALESCE((split_part(COALESCE(v_dia ->> 'colacion_inicio', '00:00'), ':', 2))::int, 0);
        v_cf := COALESCE((split_part(COALESCE(v_dia ->> 'colacion_fin', '00:00'), ':', 1))::int, 0) * 60
              + COALESCE((split_part(COALESCE(v_dia ->> 'colacion_fin', '00:00'), ':', 2))::int, 0);
        IF v_ci > 0 AND v_cf > 0 AND v_ci < v_cf AND v_h >= v_ci AND v_h < v_cf THEN
            RETURN jsonb_build_object('ok', false, 'error', 'El trabajador está en colación a la hora seleccionada');
        END IF;

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
    v_cita_id := (extract(epoch from now()) * 1000)::bigint::text || '-' || substr(md5(random()::text), 1, 4);
    INSERT INTO public.citas (id, tenant_id, servicio_id, fecha, hora, precio, contacto, notificaciones, trabajador_id, modalidad)
    VALUES (
        v_cita_id, p_tenant_id, p_servicio_id, p_fecha, v_hora, v_precio,
        p_contacto,
        '{"emailEnviado": false, "whatsappEnviado": false}'::jsonb,
        p_trabajador_id,
        p_modalidad
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

GRANT EXECUTE ON FUNCTION public.reservar_cita(UUID, BIGINT, DATE, TEXT, JSONB, UUID, TEXT) TO anon, authenticated, public;

-- ============================================================
-- Refresh schema cache + verificación
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '✅ citas.modalidad + trigger fijar_precio respeta promoción (split del paquete)' AS status;
