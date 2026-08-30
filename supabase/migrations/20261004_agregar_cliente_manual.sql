-- ============================================================
-- 20261004_agregar_cliente_manual.sql
-- Alta manual de clientes desde "Mis Clientes" (admin).
--
-- Contexto: los clientes de "Mis Clientes" son datos DERIVADOS
-- de `citas` (por contacto.email, deduplicados en ClientListView)
-- + `ventas` archivadas. No existía forma de guardar un cliente
-- que nunca reservó por la web (pacientes previos al lanzamiento).
--
-- SOLUCIÓN: tabla `clientes_manuales` (fuente de verdad para los
-- datos de contacto de clientes importados por el admin) + RPC
-- admin_agregar_cliente (SECURITY DEFINER, upsert por email del
-- tenant). ClientListView fusiona manuales + derivados de citas
-- por email; los manuales SIEMPRE se muestran hasta que el admin
-- los borre (exentos del filtro de 3 meses sin reservar, que solo
-- aplica a clientes derivados de citas).
--
-- Política de retención (producto, se mantiene):
--   Un cliente solo se elimina cuando:
--     a) el admin presiona "Eliminar cliente" (admin_eliminar_cliente,
--        ampliado aquí para borrar también clientes_manuales), o
--     b) pasan 3 meses sin una nueva reserva (filtro de vista;
--        solo aplica a clientes derivados de citas/ventas).
--
-- Autorización: mismas funciones server-side ya existentes
-- (get_user_tenant_id() + is_admin()) y mismo patrón que
-- admin_eliminar_cliente (20261002) y admin_set_estado_pago_cliente
-- (20260929). Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: Tabla clientes_manuales + RLS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.clientes_manuales (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    nombre text NOT NULL,
    telefono text NOT NULL DEFAULT '',
    email text NOT NULL,
    direccion text NOT NULL DEFAULT '',
    creado_en timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.clientes_manuales ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS clientes_manuales_pkey ON public.clientes_manuales USING btree (id);
ALTER TABLE public.clientes_manuales ADD CONSTRAINT clientes_manuales_pkey PRIMARY KEY USING INDEX clientes_manuales_pkey;

-- Un email por tenant (dedup idéntico al de ClientListView).
CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_manuales_tenant_email
    ON public.clientes_manuales USING btree (tenant_id, lower(email));

CREATE INDEX IF NOT EXISTS idx_clientes_manuales_tenant ON public.clientes_manuales USING btree (tenant_id);

-- ============================================================
-- PASO 2: Policy RLS — solo el admin del tenant (mismo patrón
-- que "Admin ve/gestiona citas de su tenant" de 20260901:
-- get_user_tenant_id + is_admin, nunca user_metadata del JWT)
-- ============================================================
DROP POLICY IF EXISTS "Admin ve/gestiona clientes manuales de su tenant" ON public.clientes_manuales;
CREATE POLICY "Admin ve/gestiona clientes manuales de su tenant" ON public.clientes_manuales
    FOR ALL TO authenticated
    USING (
        tenant_id = public.get_user_tenant_id()
        AND public.is_admin()
    )
    WITH CHECK (
        tenant_id = public.get_user_tenant_id()
        AND public.is_admin()
    );

-- ============================================================
-- PASO 3: RPC admin_agregar_cliente (upsert por email del tenant)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_agregar_cliente(
    p_tenant_id uuid,
    p_nombre text,
    p_telefono text,
    p_email text,
    p_direccion text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_actual uuid;
    v_email text;
    v_id uuid;
    v_ya_existia boolean;
BEGIN
    SELECT public.get_user_tenant_id() INTO v_tenant_actual;
    IF v_tenant_actual IS DISTINCT FROM p_tenant_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio');
    END IF;

    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador puede agregar clientes');
    END IF;

    IF p_nombre IS NULL OR trim(p_nombre) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El nombre del cliente es requerido');
    END IF;

    v_email := lower(btrim(p_email));
    IF v_email = '' OR v_email !~ '@' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Email de cliente inválido');
    END IF;

    -- Upsert por email del tenant: si ya existe (cliente importado o
    -- derivado de citas), actualiza sus datos de contacto y devuelve el id.
    SELECT id INTO v_id
    FROM public.clientes_manuales
    WHERE tenant_id = p_tenant_id AND lower(btrim(email)) = v_email;

    IF v_id IS NULL THEN
        INSERT INTO public.clientes_manuales (tenant_id, nombre, telefono, email, direccion)
        VALUES (p_tenant_id, trim(p_nombre), COALESCE(btrim(p_telefono), ''), v_email, COALESCE(btrim(p_direccion), ''))
        RETURNING id INTO v_id;
        v_ya_existia := false;
    ELSE
        UPDATE public.clientes_manuales
        SET nombre = trim(p_nombre),
            telefono = COALESCE(btrim(p_telefono), ''),
            direccion = COALESCE(btrim(p_direccion), '')
        WHERE id = v_id;
        v_ya_existia := true;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_id,
        'email', v_email,
        'ya_existia', v_ya_existia
    );
END;
$$;

-- Solo el admin autenticado puede ejecutarlo (nunca anon).
REVOKE EXECUTE ON FUNCTION public.admin_agregar_cliente(uuid, text, text, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_agregar_cliente(uuid, text, text, text, text) TO authenticated;

-- ============================================================
-- PASO 4: Ampliar admin_eliminar_cliente (20261002) para borrar
-- también el registro manual — "no se borra salvo que el admin
-- los borre" queda literal para los clientes importados.
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
    v_manuales integer;
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

    -- 4) Registro manual (alta desde Mis Clientes).
    DELETE FROM public.clientes_manuales
    WHERE tenant_id = p_tenant_id
      AND lower(btrim(email)) = v_email;
    GET DIAGNOSTICS v_manuales = ROW_COUNT;

    RETURN jsonb_build_object(
        'ok', true,
        'citas_eliminadas', v_citas,
        'ventas_eliminadas', v_ventas,
        'tableros_eliminados', v_boards,
        'clientes_manuales_eliminados', v_manuales
    );
END;
$$;

-- Solo el admin autenticado puede ejecutarlo (nunca anon).
REVOKE EXECUTE ON FUNCTION public.admin_eliminar_cliente(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_eliminar_cliente(uuid, text) TO authenticated;

-- ============================================================
-- Refresh schema cache + verificación
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '✅ clientes_manuales + RLS admin + admin_agregar_cliente (upsert) + admin_eliminar_cliente ampliado' AS status;
