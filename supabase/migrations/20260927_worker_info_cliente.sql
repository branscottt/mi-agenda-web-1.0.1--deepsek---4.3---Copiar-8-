-- ============================================================
-- MIGRACIÓN: Portal del trabajador — info del cliente tipo trello
-- Fecha: 2026-09-27
--
-- PROBLEMA: el trabajador que trabaja SOLO desde su enlace
-- compartido (trabajador.html, anónimo) no puede ver ni editar la
-- información de sus clientes: el tablero kanban por cliente es
-- admin-only (RLS "Admin gestiona...") y citas.contacto no se
-- expone. La info debe estar CONECTADA: lo que edita el trabajador
-- se refleja en Mis Clientes (deriva de citas.contacto) y en Citas
-- Programadas (citas.estado_pago / contacto).
--
-- SOLUCIÓN: RPCs SECURITY DEFINER worker-scoped. La autorización
-- se basa en: trabajador activo del tenant + ≥1 cita (hoy/futura)
-- suya con el email del cliente → el trabajador solo ve/edita
-- boards de SUS clientes (mismo modelo de confianza del enlace).
--
-- 1. get_worker_portal_data  → cada cita incluye contacto completo
-- 2. worker_tiene_cliente    → helper de acceso (cita asignada al
--                              trabajador con ese email)
-- 3. worker_editar_contacto_cliente → actualiza citas.contacto de
--                              TODAS las citas del tenant con ese
--                              email + kanban_boards (nombre/email)
-- 4. worker_get_board        → board+lists+cards+checklists+items
--                              +adjuntos (metadata) del cliente
-- 5. worker_guardar_tarjeta  → crear/editar tarjeta; sincroniza
--                              citas.estado_pago (igual que admin)
-- 6. worker_mover_tarjeta    → cambiar lista/posición
-- 7. worker_toggle_checklist_item → marcar item completado
-- 8. worker_add_checklist_item   → agregar item
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: get_worker_portal_data con contacto completo
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
                'cita_id', c.id,
                'hora', c.hora,
                'servicio', s.nombre,
                'cliente', c.contacto->>'nombre',
                'contacto', c.contacto
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
                'contacto', c.contacto
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
-- PASO 2: Helper de acceso worker → cliente (email)
-- ============================================================
CREATE OR REPLACE FUNCTION public.worker_tiene_cliente(p_tenant_id uuid, p_worker_id uuid, p_email text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.trabajadores t
        JOIN public.citas c ON c.trabajador_id = t.id
        WHERE t.id = p_worker_id
          AND t.tenant_id = p_tenant_id
          AND t.activo = true
          AND c.tenant_id = p_tenant_id
          AND c.fecha >= CURRENT_DATE
          AND lower(COALESCE(c.contacto->>'email', '')) = lower(trim(COALESCE(p_email, '')))
    );
$$;

GRANT EXECUTE ON FUNCTION public.worker_tiene_cliente(uuid, uuid, text) TO anon, authenticated;

-- ============================================================
-- PASO 3: worker_editar_contacto_cliente
-- Actualiza el contacto en TODAS las citas del tenant con ese
-- email (coherencia Mis Clientes + Citas Programadas) y el
-- kanban_boards del cliente si existe.
-- ============================================================
CREATE OR REPLACE FUNCTION public.worker_editar_contacto_cliente(
    p_tenant_id uuid,
    p_worker_id uuid,
    p_email_actual text,
    p_nombre text,
    p_telefono text,
    p_email_nuevo text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_email_actual text := lower(trim(COALESCE(p_email_actual, '')));
    v_email_nuevo text := lower(trim(COALESCE(p_email_nuevo, '')));
    v_nombre text := trim(COALESCE(p_nombre, ''));
    v_citas int;
BEGIN
    IF v_email_actual = '' OR v_email_nuevo = '' OR v_nombre = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Faltan nombre y email del cliente');
    END IF;

    IF NOT public.worker_tiene_cliente(p_tenant_id, p_worker_id, v_email_actual) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'No tienes reservas de este cliente');
    END IF;

    UPDATE public.citas
    SET contacto = jsonb_build_object(
            'nombre', v_nombre,
            'telefono', trim(COALESCE(p_telefono, '')),
            'email', v_email_nuevo,
            'userId', COALESCE(contacto->>'userId', '')
        )
    WHERE tenant_id = p_tenant_id
      AND lower(COALESCE(contacto->>'email', '')) = v_email_actual;
    GET DIAGNOSTICS v_citas = ROW_COUNT;

    -- Sincronizar board del cliente (sin chocar con UNIQUE tenant+email:
    -- si el email nuevo ya tiene board propio, el viejo queda como está)
    UPDATE public.kanban_boards
    SET cliente_nombre = v_nombre,
        cliente_email = v_email_nuevo
    WHERE tenant_id = p_tenant_id
      AND lower(cliente_email) = v_email_actual
      AND NOT EXISTS (
          SELECT 1 FROM public.kanban_boards b2
          WHERE b2.tenant_id = p_tenant_id
            AND lower(b2.cliente_email) = v_email_nuevo
            AND lower(b2.cliente_email) <> v_email_actual
      );

    RETURN jsonb_build_object('ok', true, 'citas_actualizadas', v_citas, 'email', v_email_nuevo);
END;
$$;

GRANT EXECUTE ON FUNCTION public.worker_editar_contacto_cliente(uuid, uuid, text, text, text, text) TO anon, authenticated;

-- ============================================================
-- PASO 4: worker_get_board
-- Devuelve board + lists + cards + checklists + items + adjuntos
-- (metadata) del cliente, SOLO si el worker tiene reservas suyas.
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
BEGIN
    IF NOT public.worker_tiene_cliente(p_tenant_id, p_worker_id, p_cliente_email) THEN
        RETURN jsonb_build_object('error', 'sin_acceso');
    END IF;

    SELECT * INTO v_board
    FROM public.kanban_boards
    WHERE tenant_id = p_tenant_id
      AND lower(cliente_email) = lower(trim(COALESCE(p_cliente_email, '')));

    IF NOT FOUND THEN
        RETURN jsonb_build_object('board', null, 'lists', '[]'::jsonb);
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
-- PASO 5: worker_guardar_tarjeta (crear o editar)
-- Sincroniza citas.estado_pago con la etiqueta de pago de la
-- tarjeta vinculada (misma lógica que el admin).
-- ============================================================
CREATE OR REPLACE FUNCTION public.worker_guardar_tarjeta(
    p_tenant_id uuid,
    p_worker_id uuid,
    p_card_id uuid,
    p_list_id uuid,
    p_titulo text,
    p_descripcion text,
    p_etiquetas jsonb,
    p_cita_id text
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

        INSERT INTO public.kanban_cards (list_id, titulo, descripcion, posicion, etiquetas, cita_id)
        VALUES (
            p_list_id,
            trim(p_titulo),
            COALESCE(p_descripcion, ''),
            0,
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
            cita_id = NULLIF(p_cita_id, '')
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

GRANT EXECUTE ON FUNCTION public.worker_guardar_tarjeta(uuid, uuid, uuid, uuid, text, text, jsonb, text) TO anon, authenticated;

-- ============================================================
-- PASO 6: worker_mover_tarjeta
-- ============================================================
CREATE OR REPLACE FUNCTION public.worker_mover_tarjeta(
    p_tenant_id uuid,
    p_worker_id uuid,
    p_card_id uuid,
    p_list_id uuid,
    p_posicion integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_board_id uuid;
    v_cliente_email text;
    v_lista_ok boolean;
BEGIN
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

    -- La lista destino debe pertenecer al MISMO board
    SELECT EXISTS (
        SELECT 1 FROM public.kanban_lists
        WHERE id = p_list_id AND board_id = v_board_id
    ) INTO v_lista_ok;
    IF NOT v_lista_ok THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Lista destino inválida');
    END IF;

    UPDATE public.kanban_cards
    SET list_id = p_list_id,
        posicion = COALESCE(p_posicion, 0)
    WHERE id = p_card_id;

    RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.worker_mover_tarjeta(uuid, uuid, uuid, uuid, integer) TO anon, authenticated;

-- ============================================================
-- PASO 7: worker_toggle_checklist_item
-- ============================================================
CREATE OR REPLACE FUNCTION public.worker_toggle_checklist_item(
    p_tenant_id uuid,
    p_worker_id uuid,
    p_item_id uuid,
    p_completado boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_board_id uuid;
    v_cliente_email text;
BEGIN
    SELECT b.id, b.cliente_email INTO v_board_id, v_cliente_email
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

    UPDATE public.kanban_checklist_items
    SET completado = COALESCE(p_completado, false)
    WHERE id = p_item_id;

    RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.worker_toggle_checklist_item(uuid, uuid, uuid, boolean) TO anon, authenticated;

-- ============================================================
-- PASO 8: worker_add_checklist_item
-- ============================================================
CREATE OR REPLACE FUNCTION public.worker_add_checklist_item(
    p_tenant_id uuid,
    p_worker_id uuid,
    p_card_id uuid,
    p_checklist_id uuid,
    p_texto text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_board_id uuid;
    v_cliente_email text;
    v_item_id uuid;
BEGIN
    IF p_texto IS NULL OR trim(p_texto) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El texto es requerido');
    END IF;

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

    INSERT INTO public.kanban_checklist_items (card_id, checklist_id, texto, posicion)
    VALUES (
        p_card_id,
        p_checklist_id,
        trim(p_texto),
        (SELECT COALESCE(MAX(posicion), 0) + 1 FROM public.kanban_checklist_items WHERE card_id = p_card_id)
    )
    RETURNING id INTO v_item_id;

    RETURN jsonb_build_object('ok', true, 'item_id', v_item_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.worker_add_checklist_item(uuid, uuid, uuid, uuid, text) TO anon, authenticated;

-- ============================================================
-- PASO 9: worker_add_list (crear lista en el board del cliente)
-- ============================================================
CREATE OR REPLACE FUNCTION public.worker_add_list(
    p_tenant_id uuid,
    p_worker_id uuid,
    p_cliente_email text,
    p_titulo text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_board_id uuid;
    v_list_id uuid;
BEGIN
    IF p_titulo IS NULL OR trim(p_titulo) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El título es requerido');
    END IF;
    IF NOT public.worker_tiene_cliente(p_tenant_id, p_worker_id, p_cliente_email) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este cliente');
    END IF;

    SELECT id INTO v_board_id
    FROM public.kanban_boards
    WHERE tenant_id = p_tenant_id
      AND lower(cliente_email) = lower(trim(COALESCE(p_cliente_email, '')));

    IF NOT FOUND THEN
        INSERT INTO public.kanban_boards (tenant_id, cliente_email, cliente_nombre)
        VALUES (p_tenant_id, lower(trim(p_cliente_email)), '')
        RETURNING id INTO v_board_id;
    END IF;

    INSERT INTO public.kanban_lists (board_id, titulo, posicion)
    VALUES (
        v_board_id,
        trim(p_titulo),
        (SELECT COALESCE(MAX(posicion), 0) + 1 FROM public.kanban_lists WHERE board_id = v_board_id)
    )
    RETURNING id INTO v_list_id;

    RETURN jsonb_build_object('ok', true, 'list_id', v_list_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.worker_add_list(uuid, uuid, text, text) TO anon, authenticated;

-- ============================================================
-- PASO 10: worker_add_checklist (crear checklist en una tarjeta)
-- ============================================================
CREATE OR REPLACE FUNCTION public.worker_add_checklist(
    p_tenant_id uuid,
    p_worker_id uuid,
    p_card_id uuid,
    p_titulo text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_board_id uuid;
    v_cliente_email text;
    v_checklist_id uuid;
BEGIN
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

    INSERT INTO public.kanban_checklists (card_id, titulo, posicion)
    VALUES (
        p_card_id,
        trim(COALESCE(p_titulo, 'Checklist')),
        (SELECT COALESCE(MAX(posicion), 0) + 1 FROM public.kanban_checklists WHERE card_id = p_card_id)
    )
    RETURNING id INTO v_checklist_id;

    RETURN jsonb_build_object('ok', true, 'checklist_id', v_checklist_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.worker_add_checklist(uuid, uuid, uuid, text) TO anon, authenticated;

-- ============================================================
-- Refresh schema cache + verificación
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '✅ Portal trabajador: contacto editable + tablero trello worker-scoped (10 RPCs)' AS status;
