-- ============================================================
-- 20261009_cerrar_venta_realizada_permisos.sql
-- "Cerrar venta" (check ✓ en Citas Programadas / portal del
-- trabajador) SIN borrar la cita + permisos por trabajador.
--
-- Contexto: hoy finalizar_cita (20261003) archiva la venta y
-- BORRA la cita. Eso impide: marcar más tarde desde el
-- historial, deshacer un check, y ajustar el monto real
-- (si el precio no calza con lo cobrado). Además solo el
-- admin puede marcar, y el total legacy mezclaba citas sin
-- confirmar con ventas reales.
--
-- Solución (producto):
--   1. citas.resultado / resultado_en: la cita queda marcada
--      como 'completada' | 'no_asistio' y SIGUE en la tabla
--      (pendiente = resultado IS NULL). El histórico real de
--      dinero vive en `ventas` (resultado 'completada').
--   2. finalizar_cita(p_cita_id, p_resultado, p_precio):
--      archiva SIEMPRE la venta (fecha_venta=now()) con el
--      monto ajustable (p_precio, default = precio reservado)
--      y marca la cita SIN borrarla. Idempotente: rechaza si
--      la cita ya fue finalizada o ya tiene venta archivada.
--   3. deshacer_finalizar_cita(p_cita_id): borra la venta
--      archivada y devuelve la cita a pendiente (undo del
--      toast, corrección de un check equivocado).
--   4. Permiso nuevo por trabajador (mismo patrón que
--      etiquetas 20260929): tenants.permitir_finalizar_
--      trabajadores (master) + trabajadores_finalizar_
--      permitidas (lista blanca; vacía = todos).
--      El ADMIN siempre puede marcar. El trabajador solo con
--      permiso y SOLO sobre sus propias reservas, con el
--      precio reservado (sin ajuste: eso es del admin).
--   5. registrar_cliente_venta_directa: venta sin turno
--      (walk-in) que crea/actualiza el cliente en
--      clientes_manuales (upsert por email; si el cliente no
--      da email se genera uno estable desde el teléfono) y
--      archiva la venta 'completada' del día.
--   6. get_worker_portal_data: expone permiso_finalizar +
--      precio/resultado por cita, y SOLO citas pendientes
--      (resultado IS NULL) en hoy/próximas.
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: columnas en citas (pendiente = resultado IS NULL)
-- ============================================================
ALTER TABLE public.citas
    ADD COLUMN IF NOT EXISTS resultado text,
    ADD COLUMN IF NOT EXISTS resultado_en timestamptz;

-- ============================================================
-- PASO 2: permiso finalizar en tenants + lista blanca
-- ============================================================
ALTER TABLE public.tenants
    ADD COLUMN IF NOT EXISTS permitir_finalizar_trabajadores boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.trabajadores_finalizar_permitidas (
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    trabajador_id uuid PRIMARY KEY REFERENCES public.trabajadores(id) ON DELETE CASCADE
);

ALTER TABLE public.trabajadores_finalizar_permitidas ENABLE ROW LEVEL SECURITY;
-- Sin policies de usuario: solo los RPCs SECURITY DEFINER acceden.

-- ============================================================
-- PASO 3: finalizar_cita v2 — archiva + MARCA la cita, sin borrar
-- El admin confirma el resultado (asistió / no asistió). El
-- monto p_precio (opcional) permite cuadrar lo realmente
-- cobrado; default = precio reservado de la cita.
-- ============================================================
CREATE OR REPLACE FUNCTION public.finalizar_cita(
    p_cita_id text,
    p_resultado text,
    p_precio numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_actual uuid;
    v_cita public.citas%ROWTYPE;
    v_precio_final numeric;
    v_venta_id uuid;
BEGIN
    SELECT public.get_user_tenant_id() INTO v_tenant_actual;
    IF v_tenant_actual IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio');
    END IF;

    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador puede finalizar citas');
    END IF;

    IF p_resultado NOT IN ('completada', 'no_asistio') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Resultado inválido');
    END IF;

    SELECT * INTO v_cita
    FROM public.citas
    WHERE id = p_cita_id
      AND tenant_id = v_tenant_actual;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Cita no encontrada');
    END IF;

    IF v_cita.resultado IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'La cita ya fue finalizada');
    END IF;

    IF EXISTS (SELECT 1 FROM public.ventas WHERE cita_id = p_cita_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'La cita ya tiene una venta archivada');
    END IF;

    v_precio_final := COALESCE(p_precio, v_cita.precio);
    IF v_precio_final IS NULL OR v_precio_final < 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Monto inválido');
    END IF;

    -- Archiva la venta (fecha_venta = momento de la confirmación)
    -- con el monto final y el resultado indicado.
    INSERT INTO public.ventas (tenant_id, cita_id, servicio_id, precio, contacto, fecha, hora, fecha_venta, resultado)
    VALUES (v_cita.tenant_id, v_cita.id, v_cita.servicio_id, round(v_precio_final::numeric, 2), v_cita.contacto, v_cita.fecha, v_cita.hora, now(), p_resultado)
    RETURNING id INTO v_venta_id;

    -- Marca la cita como finalizada (pendiente = resultado IS NULL).
    -- NO se borra: así el historial, el deshacer y el re-marcado
    -- posterior siguen siendo posibles. La limpieza de citas con
    -- fecha pasada la purga después sin duplicar (guard del trigger).
    UPDATE public.citas
    SET resultado = p_resultado,
        resultado_en = now()
    WHERE id = p_cita_id;

    RETURN jsonb_build_object('ok', true, 'venta_id', v_venta_id, 'resultado', p_resultado, 'monto', v_precio_final);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.finalizar_cita(text, text, numeric) FROM public;
GRANT EXECUTE ON FUNCTION public.finalizar_cita(text, text, numeric) TO authenticated;

-- ============================================================
-- PASO 4: deshacer_finalizar_cita — undo del check
-- Borra la venta archivada (si existe) y vuelve la cita a
-- pendiente. Solo admin (acción inversa de una venta).
-- ============================================================
CREATE OR REPLACE FUNCTION public.deshacer_finalizar_cita(
    p_cita_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_actual uuid;
    v_ventas integer;
    v_citas integer;
BEGIN
    SELECT public.get_user_tenant_id() INTO v_tenant_actual;
    IF v_tenant_actual IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio');
    END IF;

    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador puede deshacer una finalización');
    END IF;

    DELETE FROM public.ventas
    WHERE cita_id = p_cita_id
      AND tenant_id = v_tenant_actual;
    GET DIAGNOSTICS v_ventas = ROW_COUNT;

    UPDATE public.citas
    SET resultado = NULL,
        resultado_en = NULL
    WHERE id = p_cita_id
      AND tenant_id = v_tenant_actual;
    GET DIAGNOSTICS v_citas = ROW_COUNT;

    IF v_citas = 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Cita no encontrada');
    END IF;

    RETURN jsonb_build_object('ok', true, 'ventas_eliminadas', v_ventas);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.deshacer_finalizar_cita(text) FROM public;
GRANT EXECUTE ON FUNCTION public.deshacer_finalizar_cita(text) TO authenticated;

-- ============================================================
-- PASO 5: worker_finalizar_cita — marca desde el portal del
-- trabajador SOLO con permiso del admin y SOLO sus reservas.
-- El trabajador no ajusta el monto (usa el precio reservado).
-- ============================================================
CREATE OR REPLACE FUNCTION public.worker_finalizar_cita(
    p_tenant_id uuid,
    p_worker_id uuid,
    p_cita_id text,
    p_resultado text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_worker public.trabajadores%ROWTYPE;
    v_permiso boolean;
    v_cita public.citas%ROWTYPE;
    v_venta_id uuid;
BEGIN
    SELECT * INTO v_worker
    FROM public.trabajadores
    WHERE id = p_worker_id
      AND tenant_id = p_tenant_id
      AND activo = true;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Trabajador no encontrado');
    END IF;

    IF p_resultado NOT IN ('completada', 'no_asistio') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Resultado inválido');
    END IF;

    -- Master ON y (lista blanca vacía = todos, o el trabajador está en ella)
    SELECT (t.permitir_finalizar_trabajadores
            AND (NOT EXISTS (SELECT 1 FROM public.trabajadores_finalizar_permitidas e WHERE e.tenant_id = p_tenant_id)
                 OR EXISTS (SELECT 1 FROM public.trabajadores_finalizar_permitidas e WHERE e.tenant_id = p_tenant_id AND e.trabajador_id = p_worker_id)))
    INTO v_permiso
    FROM public.tenants t
    WHERE t.id = p_tenant_id;

    IF NOT COALESCE(v_permiso, false) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'No tienes permiso para marcar citas como realizadas');
    END IF;

    SELECT * INTO v_cita
    FROM public.citas
    WHERE id = p_cita_id
      AND tenant_id = p_tenant_id
      AND trabajador_id = p_worker_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Reserva no encontrada para este trabajador');
    END IF;

    IF v_cita.resultado IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'La cita ya fue finalizada');
    END IF;

    IF EXISTS (SELECT 1 FROM public.ventas WHERE cita_id = p_cita_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'La cita ya tiene una venta archivada');
    END IF;

    INSERT INTO public.ventas (tenant_id, cita_id, servicio_id, precio, contacto, fecha, hora, fecha_venta, resultado)
    VALUES (v_cita.tenant_id, v_cita.id, v_cita.servicio_id, round(COALESCE(v_cita.precio, 0)::numeric, 2), v_cita.contacto, v_cita.fecha, v_cita.hora, now(), p_resultado)
    RETURNING id INTO v_venta_id;

    UPDATE public.citas
    SET resultado = p_resultado,
        resultado_en = now()
    WHERE id = p_cita_id;

    RETURN jsonb_build_object('ok', true, 'venta_id', v_venta_id, 'resultado', p_resultado, 'monto', v_cita.precio);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.worker_finalizar_cita(uuid, uuid, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.worker_finalizar_cita(uuid, uuid, text, text) TO anon, authenticated;

-- ============================================================
-- PASO 6: admin_get_permiso_finalizar / admin_set_permiso_finalizar
-- (mismo patrón que etiquetas: master + lista blanca)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_get_permiso_finalizar(
    p_tenant_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_actual uuid;
    v_permitir boolean;
    v_result jsonb;
BEGIN
    SELECT public.get_user_tenant_id() INTO v_tenant_actual;
    IF v_tenant_actual IS DISTINCT FROM p_tenant_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio');
    END IF;

    SELECT permitir_finalizar_trabajadores INTO v_permitir
    FROM public.tenants
    WHERE id = p_tenant_id;

    SELECT jsonb_build_object(
        'ok', true,
        'permitir', COALESCE(v_permitir, false),
        'trabajadores', COALESCE((
            SELECT jsonb_agg(e.trabajador_id)
            FROM public.trabajadores_finalizar_permitidas e
            WHERE e.tenant_id = p_tenant_id
        ), '[]'::jsonb),
        'trabajadores_lista', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('id', t.id, 'nombre', t.nombre) ORDER BY t.nombre)
            FROM public.trabajadores t
            WHERE t.tenant_id = p_tenant_id AND t.activo = true
        ), '[]'::jsonb)
    ) INTO v_result;

    RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_get_permiso_finalizar(uuid) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_permiso_finalizar(
    p_tenant_id uuid,
    p_permitir boolean,
    p_trabajadores uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_actual uuid;
    v_tid uuid;
BEGIN
    SELECT public.get_user_tenant_id() INTO v_tenant_actual;
    IF v_tenant_actual IS DISTINCT FROM p_tenant_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio');
    END IF;

    UPDATE public.tenants
    SET permitir_finalizar_trabajadores = COALESCE(p_permitir, false)
    WHERE id = p_tenant_id;

    IF p_permitir IS TRUE AND p_trabajadores IS NOT NULL THEN
        DELETE FROM public.trabajadores_finalizar_permitidas WHERE tenant_id = p_tenant_id;
        IF array_length(p_trabajadores, 1) IS NOT NULL THEN
            FOREACH v_tid IN ARRAY p_trabajadores
            LOOP
                IF EXISTS (SELECT 1 FROM public.trabajadores WHERE id = v_tid AND tenant_id = p_tenant_id) THEN
                    INSERT INTO public.trabajadores_finalizar_permitidas (tenant_id, trabajador_id)
                    VALUES (p_tenant_id, v_tid)
                    ON CONFLICT (trabajador_id) DO NOTHING;
                END IF;
            END LOOP;
        END IF;
    END IF;

    RETURN jsonb_build_object('ok', true, 'permitir', COALESCE(p_permitir, false));
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_set_permiso_finalizar(uuid, boolean, uuid[]) TO anon, authenticated;

-- ============================================================
-- PASO 7: registrar_cliente_venta_directa — venta sin turno
-- Crea/actualiza el cliente (clientes_manuales, upsert por
-- email del tenant; si no hay email se genera uno estable
-- desde el teléfono) y archiva la venta 'completada' de hoy.
-- ============================================================
CREATE OR REPLACE FUNCTION public.registrar_cliente_venta_directa(
    p_tenant_id uuid,
    p_nombre text,
    p_telefono text,
    p_email text DEFAULT '',
    p_servicio_id bigint DEFAULT NULL,
    p_monto numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_actual uuid;
    v_email text;
    v_telefono text;
    v_monto numeric;
    v_servicio_valido boolean;
    v_venta_id uuid;
    v_ya_existia boolean;
BEGIN
    SELECT public.get_user_tenant_id() INTO v_tenant_actual;
    IF v_tenant_actual IS DISTINCT FROM p_tenant_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio');
    END IF;

    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador puede registrar ventas');
    END IF;

    IF p_nombre IS NULL OR trim(p_nombre) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El nombre del cliente es requerido');
    END IF;

    v_telefono := COALESCE(btrim(p_telefono), '');
    IF v_telefono = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El teléfono del cliente es requerido');
    END IF;

    v_monto := COALESCE(p_monto, 0);
    IF v_monto <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El monto debe ser mayor a cero');
    END IF;

    -- Email: si el cliente no lo da, se genera uno estable desde el
    -- teléfono para que quede en Mis Clientes (dedup por email) y
    -- pueda acumular historial la próxima vez.
    v_email := lower(btrim(COALESCE(p_email, '')));
    IF v_email = '' OR v_email !~ '@' THEN
        v_email := 'walkin.' || regexp_replace(v_telefono, '\D', '', 'g') || '@sinemail.local';
        IF v_email = '@sinemail.local' THEN
            v_email := 'walkin.' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10) || '@sinemail.local';
        END IF;
    END IF;

    -- Servicio opcional: solo si pertenece al tenant.
    IF p_servicio_id IS NOT NULL THEN
        SELECT EXISTS (
            SELECT 1 FROM public.servicios
            WHERE id = p_servicio_id AND tenant_id = p_tenant_id
        ) INTO v_servicio_valido;
        IF NOT COALESCE(v_servicio_valido, false) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'Servicio no encontrado');
        END IF;
    END IF;

    -- Upsert del cliente manual (fuente de verdad de Mis Clientes).
    SELECT EXISTS (
        SELECT 1 FROM public.clientes_manuales
        WHERE tenant_id = p_tenant_id AND lower(btrim(email)) = v_email
    ) INTO v_ya_existia;

    INSERT INTO public.clientes_manuales (tenant_id, nombre, telefono, email)
    VALUES (p_tenant_id, trim(p_nombre), v_telefono, v_email)
    ON CONFLICT (tenant_id, lower(email))
    DO UPDATE SET nombre = EXCLUDED.nombre, telefono = EXCLUDED.telefono;

    -- Venta del día (walk-in: sin cita asociada).
    INSERT INTO public.ventas (tenant_id, cita_id, servicio_id, precio, contacto, fecha, hora, fecha_venta, resultado)
    VALUES (
        p_tenant_id,
        NULL,
        p_servicio_id,
        round(v_monto::numeric, 2),
        jsonb_build_object('nombre', trim(p_nombre), 'telefono', v_telefono, 'email', v_email),
        CURRENT_DATE,
        to_char(CURRENT_TIMESTAMP, 'HH24:MI'),
        now(),
        'completada'
    )
    RETURNING id INTO v_venta_id;

    RETURN jsonb_build_object('ok', true, 'venta_id', v_venta_id, 'email', v_email, 'monto', v_monto, 'cliente_nuevo', NOT v_ya_existia);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.registrar_cliente_venta_directa(uuid, text, text, text, bigint, numeric) FROM public;
GRANT EXECUTE ON FUNCTION public.registrar_cliente_venta_directa(uuid, text, text, text, bigint, numeric) TO authenticated;

-- ============================================================
-- PASO 8: get_worker_portal_data v2 — permiso_finalizar +
-- precio/resultado por cita + SOLO citas pendientes
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_worker_portal_data(p_tenant_id uuid, p_worker_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    v_worker public.trabajadores%ROWTYPE;
    v_hoy date := CURRENT_DATE;
    v_permiso_etiquetas boolean;
    v_permiso_finalizar boolean;
    v_result jsonb;
BEGIN
    SELECT * INTO v_worker
    FROM public.trabajadores
    WHERE id = p_worker_id
      AND tenant_id = p_tenant_id
      AND activo = true;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('error', 'not_found');
    END IF;

    -- Master ON y (lista blanca vacía = todos, o el trabajador está en ella)
    SELECT (t.permitir_etiquetas_trabajadores
            AND (NOT EXISTS (SELECT 1 FROM public.trabajadores_etiquetas_permitidas e WHERE e.tenant_id = p_tenant_id)
                 OR EXISTS (SELECT 1 FROM public.trabajadores_etiquetas_permitidas e WHERE e.tenant_id = p_tenant_id AND e.trabajador_id = p_worker_id))),
           (t.permitir_finalizar_trabajadores
            AND (NOT EXISTS (SELECT 1 FROM public.trabajadores_finalizar_permitidas e WHERE e.tenant_id = p_tenant_id)
                 OR EXISTS (SELECT 1 FROM public.trabajadores_finalizar_permitidas e WHERE e.tenant_id = p_tenant_id AND e.trabajador_id = p_worker_id)))
    INTO v_permiso_etiquetas, v_permiso_finalizar
    FROM public.tenants t
    WHERE t.id = p_tenant_id;

    SELECT jsonb_build_object(
        'worker', jsonb_build_object(
            'id', v_worker.id,
            'nombre', v_worker.nombre,
            'habilidades', v_worker.habilidades,
            'color', v_worker.color,
            'tipo_jornada', v_worker.tipo_jornada,
            'horario_semanal', v_worker.horario_semanal,
            'horario_excepciones', v_worker.horario_excepciones,
            'horario_max_semanal', v_worker.horario_max_semanal
        ),
        'permiso_etiquetas', COALESCE(v_permiso_etiquetas, false),
        'permiso_finalizar', COALESCE(v_permiso_finalizar, false),
        'citas_hoy', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'cita_id', c.id,
                'hora', c.hora,
                'servicio', s.nombre,
                'cliente', c.contacto->>'nombre',
                'contacto', c.contacto,
                'estado_pago', c.estado_pago,
                'precio', c.precio,
                'resultado', c.resultado
            ) ORDER BY c.hora)
            FROM public.citas c
            LEFT JOIN public.servicios s ON s.id = c.servicio_id
            WHERE c.trabajador_id = p_worker_id
              AND c.fecha = v_hoy
              AND c.resultado IS NULL
        ), '[]'::jsonb),
        'citas_proximas', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'cita_id', c.id,
                'fecha', c.fecha,
                'hora', c.hora,
                'servicio', s.nombre,
                'cliente', c.contacto->>'nombre',
                'contacto', c.contacto,
                'estado_pago', c.estado_pago,
                'precio', c.precio,
                'resultado', c.resultado
            ) ORDER BY c.fecha, c.hora)
            FROM public.citas c
            LEFT JOIN public.servicios s ON s.id = c.servicio_id
            WHERE c.trabajador_id = p_worker_id
              AND c.fecha >= v_hoy
              AND c.fecha <= v_hoy + 13
              AND c.resultado IS NULL
        ), '[]'::jsonb)
    ) INTO v_result;

    RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_worker_portal_data(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_worker_portal_data(uuid, uuid) TO anon, authenticated;

-- ============================================================
-- Refresh schema cache + verificación
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '✅ Cerrar venta sin borrar cita + precio ajustable + permiso trabajadores + venta sin turno' AS status;
