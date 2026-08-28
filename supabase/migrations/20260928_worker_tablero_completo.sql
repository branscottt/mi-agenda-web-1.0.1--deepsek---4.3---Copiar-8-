-- ============================================================
-- 20260928_worker_tablero_completo.sql
-- Portal del trabajador: MISMO tablero que "Mis Clientes".
-- Amplía worker_get_board (crea board si falta + devuelve
-- 'completado' de las tarjetas) y worker_guardar_tarjeta
-- (p_posicion + p_completado) y añade 9 RPCs worker-scoped:
--   renombrar/eliminar lista, eliminar tarjeta (limpia
--   estado_pago), reordenar tarjetas (drag & drop),
--   guardar/listar/eliminar estilo de listas,
--   renombrar/eliminar checklist, eliminar ítem de checklist.
-- Patrón canónico: SECURITY DEFINER + validación de acceso por
-- trabajador (worker_tiene_cliente / worker activo del tenant).
-- Sin bloques DO $$. Idempotente.
-- ============================================================

-- ============================================================
-- PASO 1: worker_get_board AMPLIADO
--  - Crea el board del cliente si no existe (tras validar acceso)
--    con cliente_nombre tomado de la reserva más reciente.
--  - Incluye 'completado' en cada tarjeta (el tablero admin lo usa
--    para el checkbox "hecha" y la clase .done).
-- ============================================================
CREATE OR REPLACE FUNCTION public.worker_get_board(
    p_tenant_id uuid,
    p_worker_id uuid,
    p_cliente_email text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_board public.kanban_boards%ROWTYPE;
    v_result jsonb;
    v_email text;
    v_nombre text;
BEGIN
    v_email := lower(trim(COALESCE(p_cliente_email, '')));
    IF v_email = '' THEN
        RETURN jsonb_build_object('error', 'sin_acceso');
    END IF;

    IF NOT public.worker_tiene_cliente(p_tenant_id, p_worker_id, v_email) THEN
        RETURN jsonb_build_object('error', 'sin_acceso');
    END IF;

    SELECT * INTO v_board
    FROM public.kanban_boards
    WHERE tenant_id = p_tenant_id
      AND lower(cliente_email) = v_email;

    IF NOT FOUND THEN
        -- Nombre del cliente desde su reserva más reciente con este trabajador
        SELECT COALESCE(c.contacto ->> 'nombre', '') INTO v_nombre
        FROM public.citas c
        WHERE c.tenant_id = p_tenant_id
          AND c.trabajador_id = p_worker_id
          AND lower(COALESCE(c.contacto ->> 'email', '')) = v_email
        ORDER BY c.fecha DESC, c.hora DESC
        LIMIT 1;

        INSERT INTO public.kanban_boards (tenant_id, cliente_email, cliente_nombre)
        VALUES (p_tenant_id, v_email, COALESCE(v_nombre, ''))
        RETURNING * INTO v_board;
    END IF;

    SELECT jsonb_build_object(
        'board', to_jsonb(v_board),
        'lists', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', l.id,
                'titulo', l.titulo,
                'posicion', l.posicion,
                'cards', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'id', c.id,
                        'titulo', c.titulo,
                        'descripcion', c.descripcion,
                        'posicion', c.posicion,
                        'completado', c.completado,
                        'etiquetas', c.etiquetas,
                        'cita_id', c.cita_id,
                        'checklists', COALESCE((
                            SELECT jsonb_agg(jsonb_build_object(
                                'id', ch.id,
                                'titulo', ch.titulo,
                                'items', COALESCE((
                                    SELECT jsonb_agg(jsonb_build_object(
                                        'id', it.id,
                                        'texto', it.texto,
                                        'completado', it.completado,
                                        'posicion', it.posicion
                                    ) ORDER BY it.posicion)
                                    FROM public.kanban_checklist_items it
                                    WHERE it.checklist_id = ch.id
                                ), '[]'::jsonb)
                            ) ORDER BY ch.posicion)
                            FROM public.kanban_checklists ch
                            WHERE ch.card_id = c.id
                        ), '[]'::jsonb),
                        'adjuntos', COALESCE((
                            SELECT jsonb_agg(jsonb_build_object(
                                'id', a.id,
                                'nombre', a.nombre,
                                'tipo_mime', a.tipo_mime,
                                'tamano', a.tamano,
                                'created_at', a.created_at
                            ) ORDER BY a.created_at DESC)
                            FROM public.kanban_attachments a
                            WHERE a.card_id = c.id
                        ), '[]'::jsonb)
                    ) ORDER BY c.posicion)
                    FROM public.kanban_cards c
                    WHERE c.list_id = l.id
                ), '[]'::jsonb)
            ) ORDER BY l.posicion)
            FROM public.kanban_lists l
            WHERE l.board_id = v_board.id
        ), '[]'::jsonb)
    ) INTO v_result;

    RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.worker_get_board(uuid, uuid, text) TO anon, authenticated;

-- ============================================================
-- PASO 2: worker_guardar_tarjeta AMPLIADO
--  Nuevos parámetros opcionales:
--   p_posicion   integer  — posición en la lista (drag & drop,
--                           mover a otra lista desde el modal)
--   p_completado boolean  — checkbox "hecha" de la tarjeta
-- Compatible con llamadas anteriores (DEFAULT NULL).
-- NOTA: se elimina la firma previa de 8 parámetros para evitar
-- la ambigüedad 42725 entre overloads (CREATE OR REPLACE solo
-- reemplaza firmas idénticas).
-- ============================================================
DROP FUNCTION IF EXISTS public.worker_guardar_tarjeta(uuid, uuid, uuid, uuid, text, text, jsonb, text);

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
    v_etiqueta_clave text;
BEGIN
    IF p_titulo IS NULL OR trim(p_titulo) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El título es requerido');
    END IF;

    IF p_card_id IS NULL THEN
        -- Crear: validar lista → board → acceso
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
        -- Editar: validar tarjeta → board → acceso
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

    -- Sincronizar estado de pago de la cita vinculada
    IF v_card_id IS NOT NULL AND NULLIF(p_cita_id, '') IS NOT NULL THEN
        v_etiqueta_clave := NULL;
        IF p_etiquetas IS NOT NULL AND jsonb_array_length(p_etiquetas) > 0 THEN
            v_etiqueta_clave := p_etiquetas -> 0 ->> 'clave';
        END IF;
        IF v_etiqueta_clave IN ('pagado', 'abonado', 'parcial', 'no_pagado') THEN
            UPDATE public.citas
            SET estado_pago = v_etiqueta_clave,
                estado_pago_actualizado_en = now()
            WHERE id = NULLIF(p_cita_id, '') AND tenant_id = p_tenant_id;
        ELSE
            UPDATE public.citas
            SET estado_pago = NULL,
                estado_pago_actualizado_en = NULL
            WHERE id = NULLIF(p_cita_id, '') AND tenant_id = p_tenant_id;
        END IF;
    END IF;

    RETURN jsonb_build_object('ok', true, 'card_id', v_card_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.worker_guardar_tarjeta(uuid, uuid, uuid, uuid, text, text, jsonb, text, integer, boolean) TO anon, authenticated;

-- ============================================================
-- PASO 3: worker_renombrar_lista
-- ============================================================
CREATE OR REPLACE FUNCTION public.worker_renombrar_lista(
    p_tenant_id uuid,
    p_worker_id uuid,
    p_lista_id uuid,
    p_titulo text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_cliente_email text;
    v_titulo text;
BEGIN
    IF p_titulo IS NULL OR trim(p_titulo) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El título es requerido');
    END IF;

    SELECT b.cliente_email INTO v_cliente_email
    FROM public.kanban_lists l
    JOIN public.kanban_boards b ON b.id = l.board_id
    WHERE l.id = p_lista_id AND b.tenant_id = p_tenant_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Lista no encontrada');
    END IF;
    IF NOT public.worker_tiene_cliente(p_tenant_id, p_worker_id, v_cliente_email) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este cliente');
    END IF;

    UPDATE public.kanban_lists
    SET titulo = trim(p_titulo)
    WHERE id = p_lista_id
    RETURNING titulo INTO v_titulo;

    RETURN jsonb_build_object('ok', true, 'list_id', p_lista_id, 'titulo', v_titulo);
END;
$$;

GRANT EXECUTE ON FUNCTION public.worker_renombrar_lista(uuid, uuid, uuid, text) TO anon, authenticated;

-- ============================================================
-- PASO 4: worker_eliminar_lista (cascade borra sus tarjetas)
-- ============================================================
CREATE OR REPLACE FUNCTION public.worker_eliminar_lista(
    p_tenant_id uuid,
    p_worker_id uuid,
    p_lista_id uuid
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
    FROM public.kanban_lists l
    JOIN public.kanban_boards b ON b.id = l.board_id
    WHERE l.id = p_lista_id AND b.tenant_id = p_tenant_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Lista no encontrada');
    END IF;
    IF NOT public.worker_tiene_cliente(p_tenant_id, p_worker_id, v_cliente_email) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este cliente');
    END IF;

    DELETE FROM public.kanban_lists WHERE id = p_lista_id;

    RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.worker_eliminar_lista(uuid, uuid, uuid) TO anon, authenticated;

-- ============================================================
-- PASO 5: worker_eliminar_tarjeta
--  Si la tarjeta tenía cita vinculada con etiqueta de pago,
--  limpia el estado de pago de la cita (igual que el admin).
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
    v_cita_id text;
    v_etiquetas jsonb;
BEGIN
    SELECT b.cliente_email, c.cita_id, c.etiquetas
    INTO v_cliente_email, v_cita_id, v_etiquetas
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

    IF v_cita_id IS NOT NULL
       AND v_etiquetas IS NOT NULL AND jsonb_array_length(v_etiquetas) > 0 THEN
        UPDATE public.citas
        SET estado_pago = NULL,
            estado_pago_actualizado_en = NULL
        WHERE id = v_cita_id AND tenant_id = p_tenant_id;
    END IF;

    DELETE FROM public.kanban_cards WHERE id = p_card_id;

    RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.worker_eliminar_tarjeta(uuid, uuid, uuid) TO anon, authenticated;

-- ============================================================
-- PASO 6: worker_reordenar_tarjetas (drag & drop)
--  p_updates: jsonb array [{id, list_id, posicion}, ...]
-- ============================================================
CREATE OR REPLACE FUNCTION public.worker_reordenar_tarjetas(
    p_tenant_id uuid,
    p_worker_id uuid,
    p_updates jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_item jsonb;
    v_card_id uuid;
    v_lista_id uuid;
    v_posicion integer;
    v_cliente_email text;
    v_actualizadas integer := 0;
BEGIN
    IF p_updates IS NULL OR jsonb_typeof(p_updates) <> 'array' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Actualizaciones inválidas');
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_updates)
    LOOP
        v_card_id := (v_item ->> 'id')::uuid;
        v_lista_id := (v_item ->> 'list_id')::uuid;
        v_posicion := COALESCE((v_item ->> 'posicion')::integer, 0);

        -- Validar pertenencia de la tarjeta Y de la lista destino
        SELECT b.cliente_email INTO v_cliente_email
        FROM public.kanban_cards c
        JOIN public.kanban_lists l ON l.id = c.list_id
        JOIN public.kanban_boards b ON b.id = l.board_id
        WHERE c.id = v_card_id AND b.tenant_id = p_tenant_id;

        IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'error', 'Tarjeta no encontrada');
        END IF;
        IF NOT public.worker_tiene_cliente(p_tenant_id, p_worker_id, v_cliente_email) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este cliente');
        END IF;

        IF NOT EXISTS (
            SELECT 1
            FROM public.kanban_lists l
            JOIN public.kanban_boards b ON b.id = l.board_id
            WHERE l.id = v_lista_id AND b.tenant_id = p_tenant_id
        ) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'Lista destino inválida');
        END IF;

        UPDATE public.kanban_cards
        SET list_id = v_lista_id,
            posicion = v_posicion
        WHERE id = v_card_id;

        v_actualizadas := v_actualizadas + 1;
    END LOOP;

    RETURN jsonb_build_object('ok', true, 'actualizadas', v_actualizadas);
END;
$$;

GRANT EXECUTE ON FUNCTION public.worker_reordenar_tarjetas(uuid, uuid, jsonb) TO anon, authenticated;

-- ============================================================
-- PASO 7: helper — ¿el trabajador pertenece al tenant y está activo?
-- (para operaciones de tenant sin cliente específico: estilos)
-- ============================================================
CREATE OR REPLACE FUNCTION public.worker_activo_del_tenant(
    p_tenant_id uuid,
    p_worker_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.trabajadores t
        WHERE t.id = p_worker_id
          AND t.tenant_id = p_tenant_id
          AND t.activo = true
    );
$$;

GRANT EXECUTE ON FUNCTION public.worker_activo_del_tenant(uuid, uuid) TO anon, authenticated;

-- ============================================================
-- PASO 8: worker_guardar_estilo (plantillas de listas del tenant)
-- ============================================================
CREATE OR REPLACE FUNCTION public.worker_guardar_estilo(
    p_tenant_id uuid,
    p_worker_id uuid,
    p_nombre text,
    p_listas jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_estilo_id uuid;
BEGIN
    IF NOT public.worker_activo_del_tenant(p_tenant_id, p_worker_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso');
    END IF;
    IF p_nombre IS NULL OR trim(p_nombre) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El nombre es requerido');
    END IF;

    INSERT INTO public.kanban_estilos (tenant_id, nombre, listas)
    VALUES (p_tenant_id, trim(p_nombre), COALESCE(p_listas, '[]'::jsonb))
    RETURNING id INTO v_estilo_id;

    RETURN jsonb_build_object('ok', true, 'estilo_id', v_estilo_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.worker_guardar_estilo(uuid, uuid, text, jsonb) TO anon, authenticated;

-- ============================================================
-- PASO 9: worker_listar_estilos
-- ============================================================
CREATE OR REPLACE FUNCTION public.worker_listar_estilos(
    p_tenant_id uuid,
    p_worker_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_result jsonb;
BEGIN
    IF NOT public.worker_activo_del_tenant(p_tenant_id, p_worker_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso');
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', e.id,
        'nombre', e.nombre,
        'listas', e.listas,
        'created_at', e.created_at
    ) ORDER BY e.created_at DESC), '[]'::jsonb)
    INTO v_result
    FROM public.kanban_estilos e
    WHERE e.tenant_id = p_tenant_id;

    RETURN jsonb_build_object('ok', true, 'estilos', v_result);
END;
$$;

GRANT EXECUTE ON FUNCTION public.worker_listar_estilos(uuid, uuid) TO anon, authenticated;

-- ============================================================
-- PASO 10: worker_eliminar_estilo
-- ============================================================
CREATE OR REPLACE FUNCTION public.worker_eliminar_estilo(
    p_tenant_id uuid,
    p_worker_id uuid,
    p_estilo_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT public.worker_activo_del_tenant(p_tenant_id, p_worker_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso');
    END IF;

    DELETE FROM public.kanban_estilos
    WHERE id = p_estilo_id AND tenant_id = p_tenant_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Estilo no encontrado');
    END IF;

    RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.worker_eliminar_estilo(uuid, uuid, uuid) TO anon, authenticated;

-- ============================================================
-- PASO 11: worker_renombrar_checklist
-- ============================================================
CREATE OR REPLACE FUNCTION public.worker_renombrar_checklist(
    p_tenant_id uuid,
    p_worker_id uuid,
    p_checklist_id uuid,
    p_titulo text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_cliente_email text;
    v_titulo text;
BEGIN
    IF p_titulo IS NULL OR trim(p_titulo) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El título es requerido');
    END IF;

    SELECT b.cliente_email INTO v_cliente_email
    FROM public.kanban_checklists ch
    JOIN public.kanban_cards c ON c.id = ch.card_id
    JOIN public.kanban_lists l ON l.id = c.list_id
    JOIN public.kanban_boards b ON b.id = l.board_id
    WHERE ch.id = p_checklist_id AND b.tenant_id = p_tenant_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Checklist no encontrado');
    END IF;
    IF NOT public.worker_tiene_cliente(p_tenant_id, p_worker_id, v_cliente_email) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este cliente');
    END IF;

    UPDATE public.kanban_checklists
    SET titulo = trim(p_titulo)
    WHERE id = p_checklist_id
    RETURNING titulo INTO v_titulo;

    RETURN jsonb_build_object('ok', true, 'checklist_id', p_checklist_id, 'titulo', v_titulo);
END;
$$;

GRANT EXECUTE ON FUNCTION public.worker_renombrar_checklist(uuid, uuid, uuid, text) TO anon, authenticated;

-- ============================================================
-- PASO 12: worker_eliminar_checklist (cascade borra sus ítems)
-- ============================================================
CREATE OR REPLACE FUNCTION public.worker_eliminar_checklist(
    p_tenant_id uuid,
    p_worker_id uuid,
    p_checklist_id uuid
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
    FROM public.kanban_checklists ch
    JOIN public.kanban_cards c ON c.id = ch.card_id
    JOIN public.kanban_lists l ON l.id = c.list_id
    JOIN public.kanban_boards b ON b.id = l.board_id
    WHERE ch.id = p_checklist_id AND b.tenant_id = p_tenant_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Checklist no encontrado');
    END IF;
    IF NOT public.worker_tiene_cliente(p_tenant_id, p_worker_id, v_cliente_email) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este cliente');
    END IF;

    DELETE FROM public.kanban_checklists WHERE id = p_checklist_id;

    RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.worker_eliminar_checklist(uuid, uuid, uuid) TO anon, authenticated;

-- ============================================================
-- PASO 13: worker_eliminar_item_checklist
-- ============================================================
CREATE OR REPLACE FUNCTION public.worker_eliminar_item_checklist(
    p_tenant_id uuid,
    p_worker_id uuid,
    p_item_id uuid
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
    FROM public.kanban_checklist_items it
    JOIN public.kanban_cards c ON c.id = it.card_id
    JOIN public.kanban_lists l ON l.id = c.list_id
    JOIN public.kanban_boards b ON b.id = l.board_id
    WHERE it.id = p_item_id AND b.tenant_id = p_tenant_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Item no encontrado');
    END IF;
    IF NOT public.worker_tiene_cliente(p_tenant_id, p_worker_id, v_cliente_email) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este cliente');
    END IF;

    DELETE FROM public.kanban_checklist_items WHERE id = p_item_id;

    RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.worker_eliminar_item_checklist(uuid, uuid, uuid) TO anon, authenticated;

-- ============================================================
-- Refresh schema cache + verificación
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '✅ Portal trabajador: tablero completo igual a Mis Clientes (11 RPCs)' AS status;
