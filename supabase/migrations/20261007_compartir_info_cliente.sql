-- ============================================================
-- MIGRACIÓN: Compartir listas del tablero del cliente con el
-- cliente (vista pública por token + envío por WhatsApp)
-- Fecha: 2026-10-07
--
-- PROBLEMA: el admin guarda información por cliente en su
-- tablero interno (kanban_*: listas tipo "Rutina", "Anamnesis",
-- tarjetas, checklists) pero NO hay forma de enviarle al cliente
-- una selección de esa información. Todo es 100% interno.
--
-- SOLUCIÓN:
--   1. kanban_lists.compartida  bool -> la lista elegida pasa a
--      ser visible en la vista pública del cliente.
--   2. kanban_boards.token_compartido text UNIQUE -> enlace por
--      cliente (se crea al compartir la 1ª lista). Mismo modelo
--      de seguridad que trabajador.html?id=XXX: quien tiene el
--      enlace ve SOLO las listas compartidas de ESE cliente.
--   3. RPC get_cliente_info_compartida(p_token) SECURITY DEFINER
--      (patrón get_worker_portal_data / get_directorio_pymes):
--      el anon NUNCA toca tablas; solo recibe el JSON whitelist.
--      Devuelve tenant + cliente + listas compartida=true con
--      tarjetas (título/descripción/completado) y checklists.
--      Adjuntos NO se comparten en esta fase (bucket privado).
--   4. RPC admin_asegurar_token_compartido(p_board_id): crea el
--      token si falta (authenticated + is_admin, verificación
--      interna, patrón admin_* existentes).
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: Columnas e índices
-- ============================================================
ALTER TABLE public.kanban_boards
    ADD COLUMN IF NOT EXISTS token_compartido text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_kanban_boards_token_compartido
    ON public.kanban_boards (token_compartido)
    WHERE token_compartido IS NOT NULL;

ALTER TABLE public.kanban_lists
    ADD COLUMN IF NOT EXISTS compartida boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_kanban_lists_board_compartida
    ON public.kanban_lists (board_id)
    WHERE compartida = true;

-- ============================================================
-- PASO 2: RPC lectura pública (anon) — whitelist por token
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_cliente_info_compartida(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    v_board_id uuid;
    v_tenant_id uuid;
    v_email text;
    v_nombre_cliente text;
    v_nombre_negocio text;
    v_result jsonb;
BEGIN
    IF p_token IS NULL OR length(trim(p_token)) < 10 THEN
        RETURN jsonb_build_object('error', 'not_found');
    END IF;

    SELECT b.id, b.tenant_id, b.cliente_email, b.cliente_nombre, t.nombre_negocio
      INTO v_board_id, v_tenant_id, v_email, v_nombre_cliente, v_nombre_negocio
      FROM public.kanban_boards b
      LEFT JOIN public.tenants t ON t.id = b.tenant_id
     WHERE b.token_compartido = trim(p_token);

    IF v_board_id IS NULL THEN
        RETURN jsonb_build_object('error', 'not_found');
    END IF;

    SELECT jsonb_build_object(
        'tenant_id', v_tenant_id,
        'tenant_nombre', v_nombre_negocio,
        'cliente_email', v_email,
        'cliente_nombre', v_nombre_cliente,
        'listas', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', l.id,
                'titulo', l.titulo,
                'cards', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'id', c.id,
                        'titulo', c.titulo,
                        'descripcion', c.descripcion,
                        'completado', COALESCE(c.completado, false),
                        'checklists', COALESCE((
                            SELECT jsonb_agg(jsonb_build_object(
                                'id', cl.id,
                                'titulo', cl.titulo,
                                'items', COALESCE((
                                    SELECT jsonb_agg(jsonb_build_object(
                                        'id', i.id,
                                        'texto', i.texto,
                                        'completado', COALESCE(i.completado, false)
                                    ) ORDER BY i.posicion)
                                    FROM public.kanban_checklist_items i
                                    WHERE i.checklist_id = cl.id
                                ), '[]'::jsonb)
                            ) ORDER BY cl.posicion)
                            FROM public.kanban_checklists cl
                            WHERE cl.card_id = c.id
                        ), '[]'::jsonb)
                    ) ORDER BY c.posicion)
                    FROM public.kanban_cards c
                    WHERE c.list_id = l.id
                ), '[]'::jsonb)
            ) ORDER BY l.posicion)
            FROM public.kanban_lists l
            WHERE l.board_id = v_board_id
              AND l.compartida = true
        ), '[]'::jsonb)
    ) INTO v_result;

    RETURN v_result;
END;
$function$;

-- Exponer SOLO la RPC a anon/authenticated (nada de PUBLIC)
REVOKE ALL ON FUNCTION public.get_cliente_info_compartida(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_cliente_info_compartida(text) TO anon, authenticated;

-- ============================================================
-- PASO 3: RPC admin — asegura token del board (crea si falta)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_asegurar_token_compartido(p_board_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    v_token text;
BEGIN
    -- Solo admin del tenant dueño del board
    IF public.get_user_tenant_id() IS NULL OR NOT public.is_admin() THEN
        RAISE EXCEPTION 'sin_permiso';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.kanban_boards
        WHERE id = p_board_id
          AND tenant_id = public.get_user_tenant_id()
    ) THEN
        RAISE EXCEPTION 'board_no_encontrado';
    END IF;

    SELECT token_compartido INTO v_token
      FROM public.kanban_boards
     WHERE id = p_board_id;

    IF v_token IS NULL THEN
        UPDATE public.kanban_boards
           SET token_compartido = gen_random_uuid()::text
         WHERE id = p_board_id
        RETURNING token_compartido INTO v_token;
    END IF;

    RETURN v_token;
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_asegurar_token_compartido(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_asegurar_token_compartido(uuid) TO authenticated;

-- Refresh schema cache + verificación
NOTIFY pgrst, 'reload schema';

SELECT '✅ compartir info con cliente: columnas + get_cliente_info_compartida(anon) + admin_asegurar_token_compartido(auth)' AS status;
