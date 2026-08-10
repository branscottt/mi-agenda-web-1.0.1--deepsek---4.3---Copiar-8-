-- ============================================================
-- MIGRACIÓN: Security Fixes — Cierre de vectores críticos
-- Fecha: 2026-08-12
--
-- 1. REVOKE ALL sobre la vista usuarios_con_rol (anon, authenticated, public):
--    - La vista expone emails/roles/tenant_ids de TODOS los usuarios
--      a cualquier usuario autenticado (data leak PII multi-tenant, verificado
--      con SELECT 200 vía PostgREST).
--    - Además es actualizable: permitía UPDATE/DELETE sobre auth.users
--      (escalada a super_admin, borrado de usuarios) vía los grants default.
--    El superadmin pasa a usar RPCs SECURITY DEFINER con validación is_super_admin().
--
-- 2. REVOKE EXECUTE de RPCs SECURITY DEFINER sin validación:
--    - activar_suscripcion_post_pago: activa/renueva suscripciones de
--      CUALQUIER tenant sin verificar pago aprobado (gratis).
--    - desactivar_suscripcion: desactiva la suscripción de CUALQUIER tenant
--      (DoS a negocios pagantes).
--    Solo las usa el webhook de MP con service_role (bypass RLS) — el GRANT
--    a authenticated es innecesario y peligroso.
--
-- 3. Nuevas RPCs seguras para superadmin (reemplazan el acceso directo a la vista):
--    - actualizar_rol_usuario(user_id, rol): valida is_super_admin() + whitelist.
--    - eliminar_usuario(user_id): valida is_super_admin() + no auto-borrado.
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: Blindar la vista usuarios_con_rol
-- ============================================================

REVOKE ALL ON public.usuarios_con_rol FROM anon;
REVOKE ALL ON public.usuarios_con_rol FROM authenticated;
REVOKE ALL ON public.usuarios_con_rol FROM public;

-- ============================================================
-- PASO 2: Revocar EXECUTE de RPCs SECURITY DEFINER sin validación
-- (solo service_role vía webhook debe poder llamarlas)
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.activar_suscripcion_post_pago(UUID, TEXT, TEXT, NUMERIC) FROM authenticated;
-- Nota: la firma vieja (UUID, TEXT, TEXT) ya fue reemplazada por la de 4 params
-- en la migración 20260810 — no existe en remoto, no requiere REVOKE.
REVOKE EXECUTE ON FUNCTION public.desactivar_suscripcion(UUID) FROM authenticated;

-- ============================================================
-- PASO 3: RPC segura — actualizar rol de usuario (solo super_admin)
-- ============================================================

CREATE OR REPLACE FUNCTION public.actualizar_rol_usuario(p_user_id UUID, p_rol TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
    -- Solo super_admin (validado desde el JWT, no manipulable por el cliente)
    IF NOT public.is_super_admin() THEN
        RAISE EXCEPTION 'Acceso denegado: solo super-admin';
    END IF;

    -- Whitelist de roles válidos
    IF p_rol NOT IN ('cliente', 'admin', 'trabajador', 'super_admin') THEN
        RAISE EXCEPTION 'Rol inválido: %', p_rol;
    END IF;

    -- Actualizar raw_user_meta_data.rol en auth.users
    UPDATE auth.users
    SET raw_user_meta_data = jsonb_set(
            COALESCE(raw_user_meta_data, '{}'::jsonb),
            '{rol}',
            to_jsonb(p_rol)
        )
    WHERE id = p_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Usuario no encontrado';
    END IF;

    RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.actualizar_rol_usuario(UUID, TEXT) TO authenticated;

-- ============================================================
-- PASO 4: RPC segura — eliminar usuario (solo super_admin)
-- ============================================================

CREATE OR REPLACE FUNCTION public.eliminar_usuario(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
    -- Solo super_admin
    IF NOT public.is_super_admin() THEN
        RAISE EXCEPTION 'Acceso denegado: solo super-admin';
    END IF;

    -- Evitar que el super_admin se elimine a sí mismo (lockout)
    IF p_user_id = auth.uid() THEN
        RAISE EXCEPTION 'No puedes eliminar tu propio usuario';
    END IF;

    DELETE FROM auth.users WHERE id = p_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Usuario no encontrado';
    END IF;

    RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.eliminar_usuario(UUID) TO authenticated;

-- ============================================================
-- PASO 5: Refresh schema cache + verificación
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '✅ Security fixes aplicados: vista usuarios_con_rol blindada, RPCs de pago revocadas de authenticated, RPCs admin seguras creadas' AS status;
