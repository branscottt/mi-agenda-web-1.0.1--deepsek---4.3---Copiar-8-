-- ============================================================
-- MIGRACIÓN 014: Portal público del trabajador (RPC segura)
-- ------------------------------------------------------------
-- Problema: trabajador.html (link compartido sin login) consulta
-- trabajadores/citas con la key anon, pero el RLS de producción
-- bloquea la lectura anónima -> el portal no puede mostrar datos.
-- Solución: RPC SECURITY DEFINER que valida worker+tenant y
-- devuelve SOLO los datos de ese trabajador (horario + reservas
-- de hoy). No se abre RLS de citas a anon (protege datos de
-- clientes). Script lineal, sin DO $$, idempotente.
-- Ejecutar en Supabase SQL Editor (Dashboard > SQL Editor).
-- ============================================================

-- 1. RPC pública del portal del trabajador
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
        ), '[]'::jsonb)
    ) INTO v_result;

    RETURN v_result;
END;
$function$;

-- 2. Exponer SOLO la RPC a anon/authenticated (nada de PUBLIC)
REVOKE ALL ON FUNCTION public.get_worker_portal_data(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_worker_portal_data(uuid, uuid) TO anon, authenticated;

-- 3. Verificación (debe devolver 1 fila con la función)
SELECT proname, proowner::regrole
FROM pg_proc
WHERE proname = 'get_worker_portal_data';
