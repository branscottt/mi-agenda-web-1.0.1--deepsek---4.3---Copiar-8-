-- ============================================================
-- MIGRACIÓN: reservar_cita valida el trabajador seleccionado
-- Fecha: 2026-09-25
--
-- PROBLEMA: el RPC aceptaba p_trabajador_id y lo insertaba en
-- citas SIN validar nada: un trabajador podía quedar con dos
-- citas a la misma hora, o con citas fuera de su horario laboral.
--
-- SOLUCIÓN: cuando p_trabajador_id viene definido, reservar_cita:
--   1. Valida que el trabajador exista, esté activo y pertenezca
--      al tenant. El SELECT ... FOR UPDATE sobre la fila del
--      trabajador serializa reservas concurrentes del mismo
--      trabajador (evita la doble reserva por carrera).
--   2. Valida que labore esa fecha (excepción de semana ISO si
--      existe, si no la plantilla semanal; día 1=Lun..7=Dom con
--      extract(isodow)) y a esa hora (dentro de [inicio, fin) y
--      fuera de la colación).
--   3. Rechaza si ya existe otra cita del mismo trabajador a la
--      misma fecha+hora.
-- reservar_citas_bulk hereda la validación (delega en
-- reservar_cita y corre dentro de una sola transacción).
--
-- ADEMÁS: RPCs públicos SECURITY DEFINER para que el catálogo del
-- cliente NO dependa del GUC de sesión app.tenant_id. Bug verificado
-- (2026-08-25, migración 20260916): con el pooler transaccional de
-- Supabase, set_tenant_anon fija el GUC en UNA conexión y el SELECT
-- siguiente puede caer en OTRO backend sin el GUC → el selector de
-- trabajadores aparecería VACÍO de forma intermitente (mismo síntoma
-- que el catálogo de servicios antes de 20260916/17).
--   get_trabajadores_servicio_publico: trabajadores activos de un
--     servicio (solo columnas públicas: id, nombre, color, horarios;
--     NUNCA email/telefono).
--   get_horas_ocupadas_trabajador_publico: horas ocupadas futuras de
--     un trabajador (solo fecha+hora, sin datos del cliente).
-- Ambos validan tenant activo server-side y NO tocan las policies RLS
-- existentes (citas sigue GUC-based por decisión documentada).
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: reservar_cita con validación de trabajador
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
-- PASO 2: RPC público de trabajadores por servicio (sin GUC)
-- ============================================================
-- Devuelve SOLO columnas públicas (id, nombre, color, horarios).
-- Valida server-side: tenant activo + servicio pertenece al tenant.
CREATE OR REPLACE FUNCTION public.get_trabajadores_servicio_publico(
    p_servicio_id BIGINT,
    p_tenant_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_resultado JSONB;
BEGIN
    IF p_servicio_id IS NULL OR p_tenant_id IS NULL THEN
        RETURN '[]'::jsonb;
    END IF;

    -- Tenant activo
    IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = p_tenant_id AND estado = 'activo') THEN
        RETURN '[]'::jsonb;
    END IF;

    -- El servicio debe pertenecer al tenant
    IF NOT EXISTS (SELECT 1 FROM public.servicios WHERE id = p_servicio_id AND tenant_id = p_tenant_id) THEN
        RETURN '[]'::jsonb;
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', t.id,
        'nombre', t.nombre,
        'color', t.color,
        'horario_semanal', t.horario_semanal,
        'horario_excepciones', t.horario_excepciones
    ) ORDER BY t.nombre), '[]'::jsonb)
    INTO v_resultado
    FROM public.servicios_trabajadores st
    JOIN public.trabajadores t ON t.id = st.trabajador_id
    WHERE st.servicio_id = p_servicio_id
      AND t.activo = true;

    RETURN v_resultado;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_trabajadores_servicio_publico(BIGINT, UUID) TO anon, authenticated, public;

-- ============================================================
-- PASO 3: RPC público de horas ocupadas de un trabajador (sin GUC)
-- ============================================================
-- Devuelve SOLO pares fecha+hora de citas futuras (sin datos del
-- cliente). Valida server-side: trabajador existe y su tenant activo.
CREATE OR REPLACE FUNCTION public.get_horas_ocupadas_trabajador_publico(
    p_trabajador_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_resultado JSONB;
BEGIN
    IF p_trabajador_id IS NULL THEN
        RETURN '[]'::jsonb;
    END IF;

    -- El trabajador debe existir y su tenant debe estar activo
    IF NOT EXISTS (
        SELECT 1
        FROM public.trabajadores t
        JOIN public.tenants tn ON tn.id = t.tenant_id
        WHERE t.id = p_trabajador_id AND tn.estado = 'activo'
    ) THEN
        RETURN '[]'::jsonb;
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'fecha', c.fecha,
        'hora', c.hora
    )), '[]'::jsonb)
    INTO v_resultado
    FROM public.citas c
    WHERE c.trabajador_id = p_trabajador_id
      AND c.fecha >= CURRENT_DATE;

    RETURN v_resultado;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_horas_ocupadas_trabajador_publico(UUID) TO anon, authenticated, public;

-- ============================================================
-- Refresh schema cache + verificación
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '✅ reservar_cita valida trabajador (tenant, activo, horario, doble reserva) + RPCs públicos sin GUC' AS status;
