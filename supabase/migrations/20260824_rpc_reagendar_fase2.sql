-- ============================================================
-- MIGRACIÓN: RPC reagendar_cita — reagendar server-side — Fase 2
-- Fecha: 2026-08-24
--
-- PROBLEMA: confirmarCambioFecha (src/_legacy/script.js 11414-11566)
-- reagenda manipulando CUPOS client-side (moduloOriginal.cupos+1 /
-- moduloEncontrado.cupos-1, líneas 11486-11498) y re-guardando la
-- cita con CitasManager.upsert (línea 11518):
--   - El cliente NO puede descontar/devolver cupos (RLS revoca
--     UPDATE de servicios) -> el cupo del horario original nunca
--     se devuelve y el nuevo no se descuenta: sobreventa.
--   - El UPDATE directo a citas no valida cupos server-side.
--   - El precio lo corrige el trigger de Fase 1, pero el flujo
--     sigue sin ser atómico (cita OK, cupos inconsistentes).
--
-- SOLUCIÓN: RPC SECURITY DEFINER reagendar_cita que ejecuta TODO
-- en el servidor, en una sola transacción atómica:
--   - Autoriza: dueño de la cita (contacto->>'userId' = auth.uid())
--     o admin del tenant (user_roles vía is_admin()).
--   - Valida fecha/hora/formato, servicio activo del tenant y que
--     el nuevo horario exista con cupos > 0.
--   - SELECT ... FOR UPDATE sobre servicios serializa reagendados
--     simultáneos del mismo servicio (mismo patrón que reservar_cita).
--   - Devuelve +1 cupo al horario original y descuenta -1 al nuevo,
--     en una sola UPDATE de disponibilidad (atómico).
--   - Actualiza la cita con el MISMO id, sin tocar precio (el
--     trigger citas_fijar_precio_servidor de Fase 1 lo fija para
--     no-admins; el admin conserva el suyo).
--
-- El frontend (confirmarCambioFecha) se migra después a este RPC,
-- reemplazando la manipulación client-side (cambio aparte, aprobado
-- por el usuario, sin tocar dist/ en esta migración).
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: RPC reagendar_cita
-- ============================================================
CREATE OR REPLACE FUNCTION public.reagendar_cita(
    p_cita_id TEXT,
    p_tenant_id UUID,
    p_nueva_fecha DATE,
    p_nueva_hora TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_cita public.citas%ROWTYPE;
    v_servicio public.servicios%ROWTYPE;
    v_modulos JSONB;
    v_hora TEXT;
    v_idx INT := -1;
    v_i INT;
    v_cupos INT;
    v_uid UUID;
    v_es_admin BOOLEAN;
    v_fecha_original DATE;
    v_hora_original TEXT;
BEGIN
    -- ============ Parámetros ============
    IF p_cita_id IS NULL OR p_tenant_id IS NULL OR p_nueva_fecha IS NULL OR p_nueva_hora IS NULL OR p_nueva_hora = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Faltan parámetros requeridos');
    END IF;

    -- Normalizar hora "9:00" -> "09:00" (mismo criterio que reservar_cita)
    v_hora := trim(p_nueva_hora);
    IF v_hora ~ '^(\d{1,2}):(\d{2})$' THEN
        v_hora := lpad(split_part(v_hora, ':', 1), 2, '0') || ':' || split_part(v_hora, ':', 2);
    END IF;
    IF v_hora !~ '^([01]\d|2[0-3]):[0-5]\d$' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Formato de hora inválido');
    END IF;

    -- ============ Autorización ============
    v_uid := auth.uid();
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Debes iniciar sesión para reagendar');
    END IF;
    v_es_admin := public.is_admin();

    -- Cargar la cita (FOR UPDATE serializa cambios concurrentes sobre ella)
    SELECT * INTO v_cita
    FROM public.citas
    WHERE id = p_cita_id AND tenant_id = p_tenant_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Cita no encontrada');
    END IF;

    -- Dueño de la cita o admin del tenant
    IF NOT (v_es_admin OR COALESCE(NULLIF(v_cita.contacto->>'userId', ''), '')::uuid = v_uid) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'No tienes permiso para reagendar esta cita');
    END IF;

    -- El cliente solo puede reagendar citas futuras (equivalente server-side
    -- de la policy "Cliente actualiza citas futuras"); el admin sí puede
    -- corregir citas pasadas.
    IF NOT v_es_admin AND v_cita.fecha < CURRENT_DATE THEN
        RETURN jsonb_build_object('ok', false, 'error', 'No puedes reagendar una cita ya pasada');
    END IF;

    -- Debe cambiar fecha u hora
    IF v_cita.fecha = p_nueva_fecha AND v_cita.hora = v_hora THEN
        RETURN jsonb_build_object('ok', false, 'error', 'La nueva fecha/hora debe ser diferente a la actual');
    END IF;

    -- Fecha: hoy o futura; si es hoy, hora futura (mismo criterio que reservar_cita)
    IF p_nueva_fecha < CURRENT_DATE THEN
        RETURN jsonb_build_object('ok', false, 'error', 'No se puede reagendar a una fecha pasada');
    END IF;
    IF p_nueva_fecha = CURRENT_DATE AND v_hora <= to_char(now(), 'HH24:MI') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'La hora seleccionada ya pasó');
    END IF;

    -- ============ Servicio + bloqueo de fila (serializa reagendados simultáneos) ============
    SELECT * INTO v_servicio
    FROM public.servicios
    WHERE id = v_cita.servicio_id AND tenant_id = p_tenant_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Servicio no encontrado');
    END IF;
    IF v_servicio.activo IS NOT TRUE THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El servicio no está disponible');
    END IF;

    -- ============ Buscar módulo del NUEVO horario ============
    v_modulos := COALESCE(v_servicio.disponibilidad -> p_nueva_fecha::text, '[]'::jsonb);
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

    -- ============ 1) Devolver cupo al horario ORIGINAL (si tiene módulo) ============
    v_fecha_original := v_cita.fecha;
    v_hora_original := v_cita.hora;

    IF v_fecha_original IS NOT NULL AND v_hora_original IS NOT NULL
       AND NOT (v_fecha_original = p_nueva_fecha AND v_hora_original = v_hora) THEN
        v_modulos := COALESCE(v_servicio.disponibilidad -> v_fecha_original::text, '[]'::jsonb);
        FOR v_i IN 0 .. jsonb_array_length(v_modulos) - 1 LOOP
            IF COALESCE(v_modulos -> v_i ->> 'hora', v_modulos -> v_i ->> 'startTime') = v_hora_original THEN
                v_cupos := COALESCE((v_modulos -> v_i ->> 'cupos')::int, 0);
                v_servicio.disponibilidad := jsonb_set(
                    v_servicio.disponibilidad,
                    ARRAY[v_fecha_original::text, v_i::text, 'cupos'],
                    to_jsonb(v_cupos + 1)
                );
                EXIT;
            END IF;
        END LOOP;
    END IF;

    -- ============ 2) Descontar cupo del NUEVO horario (sobre el JSONB ya actualizado) ============
    v_cupos := COALESCE((v_servicio.disponibilidad -> p_nueva_fecha::text -> v_idx ->> 'cupos')::int, 0);
    v_servicio.disponibilidad := jsonb_set(
        v_servicio.disponibilidad,
        ARRAY[p_nueva_fecha::text, v_idx::text, 'cupos'],
        to_jsonb(GREATEST(0, v_cupos - 1))
    );

    UPDATE public.servicios
    SET disponibilidad = v_servicio.disponibilidad
    WHERE id = v_servicio.id;

    -- ============ 3) Actualizar la cita (mismo id; precio lo gobierna el trigger de Fase 1) ============
    UPDATE public.citas
    SET fecha = p_nueva_fecha,
        hora = v_hora,
        notificaciones = '{"emailEnviado": false, "whatsappEnviado": false}'::jsonb
    WHERE id = p_cita_id;

    RETURN jsonb_build_object(
        'ok', true,
        'cita_id', p_cita_id,
        'fecha', p_nueva_fecha::text,
        'hora', v_hora
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.reagendar_cita(TEXT, UUID, DATE, TEXT) TO authenticated;

-- ============================================================
-- PASO 2: Refresh schema cache + verificación
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '✅ Fase 2: RPC reagendar_cita creado (cupos server-side, atómico)' AS status;
