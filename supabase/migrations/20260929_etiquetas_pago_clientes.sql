-- ============================================================
-- 20260929_etiquetas_pago_clientes.sql
-- Etiquetas de pago a nivel CLIENTE (no en tarjetas kanban).
-- 1. tenants.permitir_etiquetas_trabajadores (master switch).
-- 2. trabajadores_etiquetas_permitidas (lista blanca por
--    trabajador; vacía = todos los trabajadores).
--    Semántica: un trabajador puede poner etiquetas SI el master
--    está ON Y (lista blanca vacía O está en la lista).
-- 3. get_worker_portal_data: añade estado_pago por cita +
--    permiso_etiquetas del trabajador.
-- 4. worker_guardar_tarjeta / worker_eliminar_tarjeta: YA NO
--    sincronizan citas.estado_pago (las tarjetas no manejan
--    etiquetas; el estado se gestiona por cliente).
-- 5. RPCs nuevos:
--    admin_set_estado_pago_cliente       (admin siempre puede)
--    admin_get_permiso_etiquetas         (estado + trabajadores)
--    admin_set_permiso_etiquetas         (master + lista blanca)
--    worker_set_estado_pago_cliente      (solo con permiso)
-- Sin bloques DO $$. Idempotente.
-- ============================================================

-- ============================================================
-- PASO 1: columna master en tenants + tabla lista blanca
-- ============================================================
ALTER TABLE public.tenants
    ADD COLUMN IF NOT EXISTS permitir_etiquetas_trabajadores boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.trabajadores_etiquetas_permitidas (
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    trabajador_id uuid PRIMARY KEY REFERENCES public.trabajadores(id) ON DELETE CASCADE
);

ALTER TABLE public.trabajadores_etiquetas_permitidas ENABLE ROW LEVEL SECURITY;
-- Sin policies de usuario: solo los RPCs SECURITY DEFINER acceden.

-- ============================================================
-- PASO 2: get_worker_portal_data con estado_pago + permiso
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
    v_permiso boolean;
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
                 OR EXISTS (SELECT 1 FROM public.trabajadores_etiquetas_permitidas e WHERE e.tenant_id = p_tenant_id AND e.trabajador_id = p_worker_id)))
    INTO v_permiso
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
        'permiso_etiquetas', COALESCE(v_permiso, false),
        'citas_hoy', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'cita_id', c.id,
                'hora', c.hora,
                'servicio', s.nombre,
                'cliente', c.contacto->>'nombre',
                'contacto', c.contacto,
                'estado_pago', c.estado_pago
            ) ORDER BY c.hora)
            FROM public.citas c
            LEFT JOIN public.servicios s ON s.id = c.servicio_id
            WHERE c.trabajador_id = p_worker_id
              AND c.fecha = v_hoy
        ), '[]'::jsonb),
        'citas_proximas', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'cita_id', c.id,
                'fecha', c.fecha,
                'hora', c.hora,
                'servicio', s.nombre,
                'cliente', c.contacto->>'nombre',
                'contacto', c.contacto,
                'estado_pago', c.estado_pago
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

REVOKE ALL ON FUNCTION public.get_worker_portal_data(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_worker_portal_data(uuid, uuid) TO anon, authenticated;

-- ============================================================
-- PASO 3: worker_guardar_tarjeta SIN sync de estado_pago
-- (misma firma; se elimina el bloque que actualizaba citas)
-- ============================================================
CREATE OR REPLACE FUNCTION public.worker_guardar_tarjeta(
    p_tenant_id uuid,
    p_worker_id uuid,
    p_card_id uuid,
    p_list_id uuid,
    p_titulo text,
    p_descripcion text,
    p_etiquetas jsonb,
    p_cita_id text,
    p_posicion integer DEFAULT NULL,
    p_completado boolean DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_board_id uuid;
    v_cliente_email text;
    v_card_id uuid;
BEGIN
    IF p_titulo IS NULL OR trim(p_titulo) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El título es requerido');
    END IF;

    IF p_card_id IS NULL THEN
        SELECT b.id, b.cliente_email INTO v_board_id, v_cliente_email
        FROM public.kanban_lists l
        JOIN public.kanban_boards b ON b.id = l.board_id
        WHERE l.id = p_list_id AND b.tenant_id = p_tenant_id;
        IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'error', 'Lista no encontrada');
        END IF;
        IF NOT public.worker_tiene_cliente(p_tenant_id, p_worker_id, v_cliente_email) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este cliente');
        END IF;

        INSERT INTO public.kanban_cards (list_id, titulo, descripcion, posicion, completado, etiquetas, cita_id)
        VALUES (
            p_list_id,
            trim(p_titulo),
            COALESCE(p_descripcion, ''),
            COALESCE(p_posicion, 0),
            COALESCE(p_completado, false),
            COALESCE(p_etiquetas, '[]'::jsonb),
            NULLIF(p_cita_id, '')
        )
        RETURNING id INTO v_card_id;
    ELSE
        SELECT b.id, b.cliente_email INTO v_board_id, v_cliente_email
        FROM public.kanban_cards c
        JOIN public.kanban_lists l ON l.id = c.list_id
        JOIN public.kanban_boards b ON b.id = l.board_id
        WHERE c.id = p_card_id AND b.tenant_id = p_tenant_id;
        IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'error', 'Tarjeta no encontrada');
        END IF;
        IF NOT public.worker_tiene_cliente(p_tenant_id, p_worker_id, v_cliente_email) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este cliente');
        END IF;

        UPDATE public.kanban_cards
        SET titulo = trim(p_titulo),
            descripcion = COALESCE(p_descripcion, ''),
            etiquetas = COALESCE(p_etiquetas, '[]'::jsonb),
            cita_id = NULLIF(p_cita_id, ''),
            posicion = COALESCE(p_posicion, posicion),
            completado = COALESCE(p_completado, completado)
        WHERE id = p_card_id;
        v_card_id := p_card_id;
    END IF;

    RETURN jsonb_build_object('ok', true, 'card_id', v_card_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.worker_guardar_tarjeta(uuid, uuid, uuid, uuid, text, text, jsonb, text, integer, boolean) TO anon, authenticated;

-- ============================================================
-- PASO 4: worker_eliminar_tarjeta SIN limpieza de estado_pago
-- ============================================================
CREATE OR REPLACE FUNCTION public.worker_eliminar_tarjeta(
    p_tenant_id uuid,
    p_worker_id uuid,
    p_card_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_cliente_email text;
BEGIN
    SELECT b.cliente_email INTO v_cliente_email
    FROM public.kanban_cards c
    JOIN public.kanban_lists l ON l.id = c.list_id
    JOIN public.kanban_boards b ON b.id = l.board_id
    WHERE c.id = p_card_id AND b.tenant_id = p_tenant_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Tarjeta no encontrada');
    END IF;
    IF NOT public.worker_tiene_cliente(p_tenant_id, p_worker_id, v_cliente_email) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este cliente');
    END IF;

    DELETE FROM public.kanban_cards WHERE id = p_card_id;

    RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.worker_eliminar_tarjeta(uuid, uuid, uuid) TO anon, authenticated;

-- ============================================================
-- PASO 5: admin_set_estado_pago_cliente
-- El admin (JWT de user_roles) pone la etiqueta del cliente:
-- actualiza TODAS sus citas del tenant (estado del cliente).
-- p_estado '' o NULL = quitar etiqueta.
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_set_estado_pago_cliente(
    p_tenant_id uuid,
    p_cliente_email text,
    p_estado text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_actual uuid;
    v_email text;
    v_estado text;
    v_citas integer;
BEGIN
    SELECT public.get_user_tenant_id() INTO v_tenant_actual;
    IF v_tenant_actual IS DISTINCT FROM p_tenant_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio');
    END IF;

    v_email := lower(trim(COALESCE(p_cliente_email, '')));
    IF v_email = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Email del cliente requerido');
    END IF;

    v_estado := NULLIF(trim(COALESCE(p_estado, '')), '');
    IF v_estado IS NOT NULL AND v_estado NOT IN ('pagado', 'abonado', 'parcial', 'no_pagado') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Estado de pago inválido');
    END IF;

    UPDATE public.citas
    SET estado_pago = v_estado,
        estado_pago_actualizado_en = CASE WHEN v_estado IS NULL THEN NULL ELSE now() END
    WHERE tenant_id = p_tenant_id
      AND lower(COALESCE(contacto ->> 'email', '')) = v_email;

    GET DIAGNOSTICS v_citas = ROW_COUNT;

    RETURN jsonb_build_object('ok', true, 'citas_actualizadas', v_citas);
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_set_estado_pago_cliente(uuid, text, text) TO anon, authenticated;

-- ============================================================
-- PASO 6: admin_get_permiso_etiquetas
-- Devuelve el master switch, la lista blanca y los trabajadores
-- activos del tenant (para el selector del admin).
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_get_permiso_etiquetas(
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

    SELECT permitir_etiquetas_trabajadores INTO v_permitir
    FROM public.tenants
    WHERE id = p_tenant_id;

    SELECT jsonb_build_object(
        'ok', true,
        'permitir', COALESCE(v_permitir, false),
        'trabajadores', COALESCE((
            SELECT jsonb_agg(e.trabajador_id)
            FROM public.trabajadores_etiquetas_permitidas e
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

GRANT EXECUTE ON FUNCTION public.admin_get_permiso_etiquetas(uuid) TO anon, authenticated;

-- ============================================================
-- PASO 7: admin_set_permiso_etiquetas
-- p_permitir: master switch.
-- p_trabajadores: NULL = no tocar la lista blanca (al apagar);
--                 [] = todos los trabajadores (lista blanca vacía);
--                 [ids] = solo esos trabajadores.
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_set_permiso_etiquetas(
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
    SET permitir_etiquetas_trabajadores = COALESCE(p_permitir, false)
    WHERE id = p_tenant_id;

    IF p_permitir IS TRUE AND p_trabajadores IS NOT NULL THEN
        DELETE FROM public.trabajadores_etiquetas_permitidas WHERE tenant_id = p_tenant_id;
        IF array_length(p_trabajadores, 1) IS NOT NULL THEN
            FOREACH v_tid IN ARRAY p_trabajadores
            LOOP
                IF EXISTS (SELECT 1 FROM public.trabajadores WHERE id = v_tid AND tenant_id = p_tenant_id) THEN
                    INSERT INTO public.trabajadores_etiquetas_permitidas (tenant_id, trabajador_id)
                    VALUES (p_tenant_id, v_tid)
                    ON CONFLICT (trabajador_id) DO NOTHING;
                END IF;
            END LOOP;
        END IF;
    END IF;

    RETURN jsonb_build_object('ok', true, 'permitir', COALESCE(p_permitir, false));
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_set_permiso_etiquetas(uuid, boolean, uuid[]) TO anon, authenticated;

-- ============================================================
-- PASO 8: worker_set_estado_pago_cliente
-- El trabajador pone la etiqueta del cliente SOLO si el tenant
-- lo permite (master ON y lista blanca: vacía o incluye al
-- trabajador) y el cliente es suyo. Actualiza todas las citas
-- del cliente (mismo email) en el tenant.
-- ============================================================
CREATE OR REPLACE FUNCTION public.worker_set_estado_pago_cliente(
    p_tenant_id uuid,
    p_worker_id uuid,
    p_cliente_email text,
    p_estado text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_permiso boolean;
    v_email text;
    v_estado text;
    v_citas integer;
BEGIN
    SELECT (t.permitir_etiquetas_trabajadores
            AND (NOT EXISTS (SELECT 1 FROM public.trabajadores_etiquetas_permitidas e WHERE e.tenant_id = p_tenant_id)
                 OR EXISTS (SELECT 1 FROM public.trabajadores_etiquetas_permitidas e WHERE e.tenant_id = p_tenant_id AND e.trabajador_id = p_worker_id)))
    INTO v_permiso
    FROM public.tenants t
    WHERE t.id = p_tenant_id;

    IF NOT COALESCE(v_permiso, false) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'No tienes permiso para poner etiquetas de pago');
    END IF;

    v_email := lower(trim(COALESCE(p_cliente_email, '')));
    IF v_email = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Email del cliente requerido');
    END IF;
    IF NOT public.worker_tiene_cliente(p_tenant_id, p_worker_id, v_email) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'No tienes reservas de este cliente');
    END IF;

    v_estado := NULLIF(trim(COALESCE(p_estado, '')), '');
    IF v_estado IS NOT NULL AND v_estado NOT IN ('pagado', 'abonado', 'parcial', 'no_pagado') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Estado de pago inválido');
    END IF;

    UPDATE public.citas
    SET estado_pago = v_estado,
        estado_pago_actualizado_en = CASE WHEN v_estado IS NULL THEN NULL ELSE now() END
    WHERE tenant_id = p_tenant_id
      AND lower(COALESCE(contacto ->> 'email', '')) = v_email;

    GET DIAGNOSTICS v_citas = ROW_COUNT;

    RETURN jsonb_build_object('ok', true, 'citas_actualizadas', v_citas);
END;
$$;

GRANT EXECUTE ON FUNCTION public.worker_set_estado_pago_cliente(uuid, uuid, text, text) TO anon, authenticated;

-- ============================================================
-- Refresh schema cache + verificación
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '✅ Etiquetas de pago por cliente + permiso trabajadores (master + lista blanca)' AS status;
