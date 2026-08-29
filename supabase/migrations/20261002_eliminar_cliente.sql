-- ============================================================
-- 20261002_eliminar_cliente.sql
-- Eliminar un cliente de "Mis Clientes" de forma explícita.
--
-- Contexto: los clientes de "Mis Clientes" son datos DERIVADOS
-- de `citas` (por contacto.email, deduplicados en ClientListView).
-- La limpieza automática borra las citas pasadas cada 10 min y el
-- trigger trg_archivar_venta las conserva en `ventas` (20260915).
--
-- Política de retención (producto):
--   Un cliente solo se elimina cuando:
--     a) el admin presiona "Eliminar cliente" (este RPC), o
--     b) pasan 3 meses sin una nueva reserva (filtro de vista
--        en ClientListView; los datos quedan en `ventas`).
--
-- Este RPC borra TODO el rastro del cliente del tenant:
--   - citas (presentes y futuras; el trigger archiva las pasadas)
--   - ventas archivadas del mismo email
--   - kanban_boards (las FK cascaden a listas/tarjetas/
--     checklists/adjuntos)
--
-- Autorización: SECURITY DEFINER + get_user_tenant_id() +
-- is_admin() (mismo patrón que admin_set_estado_pago_cliente
-- de 20260929). Sin cambios de policies RLS.
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: RPC admin_eliminar_cliente
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_eliminar_cliente(
    p_tenant_id uuid,
    p_cliente_email text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_actual uuid;
    v_email text;
    v_citas integer;
    v_ventas integer;
    v_boards integer;
BEGIN
    SELECT public.get_user_tenant_id() INTO v_tenant_actual;
    IF v_tenant_actual IS DISTINCT FROM p_tenant_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio');
    END IF;

    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador puede eliminar clientes');
    END IF;

    v_email := lower(btrim(p_cliente_email));
    IF v_email = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Email de cliente inválido');
    END IF;

    -- 1) Citas del cliente (el trigger trg_archivar_venta archiva
    --    las de fecha pasada ANTES de borrarlas).
    DELETE FROM public.citas
    WHERE tenant_id = p_tenant_id
      AND lower(btrim(contacto->>'email')) = v_email;
    GET DIAGNOSTICS v_citas = ROW_COUNT;

    -- 2) Ventas archivadas del mismo cliente.
    DELETE FROM public.ventas
    WHERE tenant_id = p_tenant_id
      AND lower(btrim(contacto->>'email')) = v_email;
    GET DIAGNOSTICS v_ventas = ROW_COUNT;

    -- 3) Tablero kanban del cliente (las FK con ON DELETE CASCADE
    --    eliminan listas, tarjetas, checklists y adjuntos).
    DELETE FROM public.kanban_boards
    WHERE tenant_id = p_tenant_id
      AND lower(btrim(cliente_email)) = v_email;
    GET DIAGNOSTICS v_boards = ROW_COUNT;

    RETURN jsonb_build_object(
        'ok', true,
        'citas_eliminadas', v_citas,
        'ventas_eliminadas', v_ventas,
        'tableros_eliminados', v_boards
    );
END;
$$;

-- Solo el admin autenticado puede ejecutarlo (nunca anon).
REVOKE EXECUTE ON FUNCTION public.admin_eliminar_cliente(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_eliminar_cliente(uuid, text) TO authenticated;
