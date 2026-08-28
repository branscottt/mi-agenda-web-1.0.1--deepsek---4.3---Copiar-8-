-- ============================================================
-- MIGRACIÓN: get_worker_portal_data devuelve reservas próximas
-- Fecha: 2026-09-26
--
-- PROBLEMA: el portal compartido del trabajador (trabajador.html)
-- solo mostraba las reservas de HOY. Cuando un cliente reserva
-- con un trabajador para una fecha futura, esa reserva no
-- aparecía en su horario compartido.
--
-- SOLUCIÓN: la RPC ahora devuelve además `citas_proximas`:
-- citas del trabajador desde hoy hasta hoy+13 (14 días), con
-- fecha, hora, servicio y cliente, ordenadas por fecha+hora.
-- Se mantiene `citas_hoy` (compatibilidad con el render actual).
--
-- Script lineal, secuencial, idempotente, sin DO $$.
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
    v_result jsonb;
BEGIN
    -- Validar que el trabajador exista, pertenezca al tenant y esté activo
    SELECT * INTO v_worker
    FROM public.trabajadores
    WHERE id = p_worker_id
      AND tenant_id = p_tenant_id
      AND activo = true;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('error', 'not_found');
    END IF;

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
        'citas_hoy', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'hora', c.hora,
                'servicio', s.nombre,
                'cliente', c.contacto->>'nombre'
            ) ORDER BY c.hora)
            FROM public.citas c
            LEFT JOIN public.servicios s ON s.id = c.servicio_id
            WHERE c.trabajador_id = p_worker_id
              AND c.fecha = v_hoy
        ), '[]'::jsonb),
        'citas_proximas', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'fecha', c.fecha,
                'hora', c.hora,
                'servicio', s.nombre,
                'cliente', c.contacto->>'nombre'
            ) ORDER BY c.fecha, c.hora)
            FROM public.citas c
            LEFT JOIN public.servicios s ON s.id = c.servicio_id
            WHERE c.trabajador_id = p_worker_id
              AND c.fecha >= v_hoy
              AND c.fecha <= v_hoy + 13
        ), '[]'::jsonb)
    ) INTO v_result;

    RETURN v_result;
END;
$function$;

-- Exponer SOLO la RPC a anon/authenticated (nada de PUBLIC)
REVOKE ALL ON FUNCTION public.get_worker_portal_data(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_worker_portal_data(uuid, uuid) TO anon, authenticated;

-- Refresh schema cache + verificación
NOTIFY pgrst, 'reload schema';

SELECT '✅ get_worker_portal_data devuelve citas_proximas (hoy + 13 días)' AS status;
