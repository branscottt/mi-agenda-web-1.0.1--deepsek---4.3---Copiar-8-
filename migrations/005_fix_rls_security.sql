-- ============================================================
-- Migration: Fix RLS policies de seguridad
-- Correcciones:
--   1. Subscriptions: policies restrictivas por tenant_id
--   2. Tenants: policies restrictivas por tenant_id
--   3. get_all_users_for_superadmin: usar is_super_admin() en vez de email
--   4. crear_tenant_completo: revocar acceso anon
-- Script lineal SECUENCIAL, sin DO $$, idempotente.
-- Ejecutar en Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================

-- ============================================================
-- PASO 1: Subscriptions — Reemplazar policies
-- ============================================================
DROP POLICY IF EXISTS "Permitir inserción de suscripciones" ON public.subscriptions;
DROP POLICY IF EXISTS "Permitir actualización de suscripciones" ON public.subscriptions;
DROP POLICY IF EXISTS "Permitir lectura de suscripciones" ON public.subscriptions;
DROP POLICY IF EXISTS "Admin ve sus suscripciones" ON public.subscriptions;
DROP POLICY IF EXISTS "Admin actualiza su suscripción" ON public.subscriptions;

-- Admin ve solo suscripciones de su tenant (o super_admin todas)
CREATE POLICY "Admin ve suscripciones de su tenant"
  ON public.subscriptions FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id() OR public.is_super_admin());

-- Admin crea suscripción solo para su tenant (o super_admin)
CREATE POLICY "Admin crea suscripción para su tenant"
  ON public.subscriptions FOR INSERT TO authenticated
  WITH CHECK (tenant_id = public.get_user_tenant_id() OR public.is_super_admin());

-- Admin actualiza solo su tenant, super_admin todo
CREATE POLICY "Admin actualiza suscripción de su tenant"
  ON public.subscriptions FOR UPDATE TO authenticated
  USING (tenant_id = public.get_user_tenant_id() OR public.is_super_admin())
  WITH CHECK (tenant_id = public.get_user_tenant_id() OR public.is_super_admin());

-- Super admin puede borrar suscripciones
CREATE POLICY "Super admin borra suscripciones"
  ON public.subscriptions FOR DELETE TO authenticated
  USING (public.is_super_admin());

-- ============================================================
-- PASO 2: Tenants — Reemplazar policies
-- ============================================================
DROP POLICY IF EXISTS "Permitir lectura a usuarios autenticados" ON public.tenants;
DROP POLICY IF EXISTS "Permitir actualización a usuarios autenticados" ON public.tenants;
DROP POLICY IF EXISTS "Permitir inserción a usuarios autenticados" ON public.tenants;

-- Admin ve solo su propio tenant, super_admin ve todos
CREATE POLICY "Admin ve su propio tenant"
  ON public.tenants FOR SELECT TO authenticated
  USING (id = public.get_user_tenant_id() OR public.is_super_admin());

-- Admin actualiza solo su tenant, super_admin todos
CREATE POLICY "Admin actualiza su tenant"
  ON public.tenants FOR UPDATE TO authenticated
  USING (id = public.get_user_tenant_id() OR public.is_super_admin())
  WITH CHECK (id = public.get_user_tenant_id() OR public.is_super_admin());

-- Inserción permitida para cualquier authenticated (registro nuevo negocio)
CREATE POLICY "Crear tenant"
  ON public.tenants FOR INSERT TO authenticated
  WITH CHECK (true);

-- Solo super_admin puede borrar tenants
CREATE POLICY "Super admin borra tenants"
  ON public.tenants FOR DELETE TO authenticated
  USING (public.is_super_admin());

-- ============================================================
-- PASO 3: Fix get_all_users_for_superadmin — usar is_super_admin()
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_all_users_for_superadmin()
 RETURNS TABLE(id uuid, email text, rol text, nombre text, tenant_id text, created_at timestamptz)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT u.id, u.email::text,
         u.raw_user_meta_data->>'rol' AS rol,
         u.raw_user_meta_data->>'nombre' AS nombre,
         u.raw_user_meta_data->>'tenant_id' AS tenant_id,
         u.created_at
  FROM auth.users u
  ORDER BY u.created_at DESC;
END;
$$;

-- ============================================================
-- PASO 4: Revocar acceso anon a crear_tenant_completo
-- Solo usuarios authenticated pueden ejecutarla
-- NOTA: Se revoca PUBLIC primero porque anon hereda de PUBLIC
-- ============================================================
REVOKE EXECUTE ON FUNCTION public.crear_tenant_completo FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.crear_tenant_completo FROM anon;
GRANT EXECUTE ON FUNCTION public.crear_tenant_completo TO authenticated;

-- ============================================================
-- VERIFICACIÓN: Consultar policies activas
-- ============================================================
-- SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
-- FROM pg_policies
-- WHERE tablename IN ('subscriptions', 'tenants')
-- ORDER BY tablename, policyname;
