-- ============================================================
-- MIGRACIÓN: Security Hardening v2
-- Fecha: 2026-07-15
--
-- Corrige brechas de seguridad en la cadena CLI de Supabase:
--   1. RLS policies de tenants con tenant isolation (reemplaza USING true)
--   2. RLS policies de subscriptions con tenant isolation
--   3. REVOKE de permisos peligrosos de anon (DELETE/UPDATE en citas, servicios, etc.)
--   4. set_tenant_anon() — versión segura para anon que valida tenant
--   5. Revocar SECURITY DEFINER functions peligrosas de anon
--   6. CHECK constraints adicionales (notificaciones, servicios_trabajadores)
--   7. REVOKE SELECT anon en usuarios_con_rol (data leak multi-tenant)
--   8. Anon policies con tenant isolation en trabajadores y servicios_trabajadores
--   9. Verificación final de policies
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: Reemplazar RLS policies de TENANTS
-- La migración 20260619_rls_tenants_test.sql creó políticas
-- con USING (true), permitiendo a cualquier authenticated leer
-- y modificar cualquier tenant.
-- ============================================================

DROP POLICY IF EXISTS "Permitir lectura a usuarios autenticados" ON public.tenants;
DROP POLICY IF EXISTS "Permitir inserción a usuarios autenticados" ON public.tenants;
DROP POLICY IF EXISTS "Permitir actualización a usuarios autenticados" ON public.tenants;

-- Admin ve SOLO su propio tenant, super_admin ve todos
CREATE POLICY "Admin ve su propio tenant"
  ON public.tenants FOR SELECT TO authenticated
  USING (id = public.get_user_tenant_id() OR public.is_super_admin());

-- Admin actualiza SOLO su tenant, super_admin todos
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

-- Anon: solo puede leer el tenant cuyo id tiene en app.tenant_id
DROP POLICY IF EXISTS "Anon puede leer tenant" ON public.tenants;
CREATE POLICY "Anon puede leer tenant"
  ON public.tenants FOR SELECT TO public
  USING (id::text = current_setting('app.tenant_id', true));

-- ============================================================
-- PASO 2: Reemplazar RLS policies de SUBSCRIPTIONS
-- La migración 20260620_rls_subscriptions.sql creó políticas
-- con USING (true), permitiendo a cualquier authenticated ver
-- todas las suscripciones de todos los tenants.
-- ============================================================

DROP POLICY IF EXISTS "Permitir lectura de suscripciones" ON public.subscriptions;
DROP POLICY IF EXISTS "Permitir inserción de suscripciones" ON public.subscriptions;
DROP POLICY IF EXISTS "Permitir actualización de suscripciones" ON public.subscriptions;

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
-- PASO 3: REVOCAR permisos peligrosos de anon
-- La migración inicial (20260509221609) concedió DELETE/UPDATE
-- a anon en varias tablas. Aunque RLS bloquea, el permiso
-- GRANT-level debe ser mínimo.
-- ============================================================

-- Citas: anon solo SELECT e INSERT (para agendar)
REVOKE DELETE ON public.citas FROM anon;
REVOKE UPDATE ON public.citas FROM anon;
REVOKE TRUNCATE ON public.citas FROM anon;
REVOKE REFERENCES ON public.citas FROM anon;
REVOKE TRIGGER ON public.citas FROM anon;

-- Notificaciones: anon NO necesita acceso directo
REVOKE ALL ON public.notificaciones_admin FROM anon;

-- Servicios: anon solo SELECT (catálogo público)
REVOKE DELETE ON public.servicios FROM anon;
REVOKE INSERT ON public.servicios FROM anon;
REVOKE UPDATE ON public.servicios FROM anon;
REVOKE TRUNCATE ON public.servicios FROM anon;
REVOKE REFERENCES ON public.servicios FROM anon;
REVOKE TRIGGER ON public.servicios FROM anon;

-- Subscriptions: anon no necesita acceso directo
REVOKE ALL ON public.subscriptions FROM anon;

-- Tenant config: anon solo SELECT
REVOKE DELETE ON public.tenant_config FROM anon;
REVOKE INSERT ON public.tenant_config FROM anon;
REVOKE UPDATE ON public.tenant_config FROM anon;
REVOKE TRUNCATE ON public.tenant_config FROM anon;
REVOKE REFERENCES ON public.tenant_config FROM anon;
REVOKE TRIGGER ON public.tenant_config FROM anon;

-- Tenants: anon solo SELECT e INSERT
REVOKE DELETE ON public.tenants FROM anon;
REVOKE UPDATE ON public.tenants FROM anon;
REVOKE TRUNCATE ON public.tenants FROM anon;
REVOKE REFERENCES ON public.tenants FROM anon;
REVOKE TRIGGER ON public.tenants FROM anon;

-- Trabajadores: anon solo SELECT
REVOKE DELETE ON public.trabajadores FROM anon;
REVOKE INSERT ON public.trabajadores FROM anon;
REVOKE UPDATE ON public.trabajadores FROM anon;
REVOKE TRUNCATE ON public.trabajadores FROM anon;
REVOKE REFERENCES ON public.trabajadores FROM anon;
REVOKE TRIGGER ON public.trabajadores FROM anon;

-- Servicios_trabajadores: anon solo SELECT
REVOKE DELETE ON public.servicios_trabajadores FROM anon;
REVOKE INSERT ON public.servicios_trabajadores FROM anon;
REVOKE UPDATE ON public.servicios_trabajadores FROM anon;
REVOKE TRUNCATE ON public.servicios_trabajadores FROM anon;
REVOKE REFERENCES ON public.servicios_trabajadores FROM anon;
REVOKE TRIGGER ON public.servicios_trabajadores FROM anon;

-- usuarios_con_rol: anon solo SELECT
REVOKE DELETE ON public.usuarios_con_rol FROM anon;
REVOKE INSERT ON public.usuarios_con_rol FROM anon;
REVOKE UPDATE ON public.usuarios_con_rol FROM anon;
REVOKE TRUNCATE ON public.usuarios_con_rol FROM anon;
REVOKE REFERENCES ON public.usuarios_con_rol FROM anon;
REVOKE TRIGGER ON public.usuarios_con_rol FROM anon;

-- ============================================================
-- PASO 4: CHECK constraints adicionales
-- ============================================================

-- Notificaciones: tipo con valores válidos
ALTER TABLE public.notificaciones_admin DROP CONSTRAINT IF EXISTS notificaciones_tipo_check;
ALTER TABLE public.notificaciones_admin ADD CONSTRAINT notificaciones_tipo_check
    CHECK (tipo IN ('cancelacion', 'reprogramacion', 'nueva_reserva', 'recordatorio'));

-- Servicios: descripción máximo 2000 caracteres
ALTER TABLE public.servicios DROP CONSTRAINT IF EXISTS servicios_descripcion_length_check;
ALTER TABLE public.servicios ADD CONSTRAINT servicios_descripcion_length_check
    CHECK (descripcion IS NULL OR length(descripcion) <= 2000);

-- ============================================================
-- PASO 5: set_tenant con search_path fijo + función segura para anon
-- ============================================================

-- 5a. Fix set_tenant existente con search_path explícito
CREATE OR REPLACE FUNCTION public.set_tenant(tenant_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    PERFORM set_config('app.tenant_id', tenant_id, false);
END;
$function$;

-- 5b. Crear set_tenant_anon — valida que el tenant exista y esté activo
CREATE OR REPLACE FUNCTION public.set_tenant_anon(p_tenant_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    IF EXISTS (SELECT 1 FROM public.tenants WHERE id = p_tenant_id::uuid AND estado = 'activo') THEN
        PERFORM set_config('app.tenant_id', p_tenant_id, false);
        RETURN true;
    END IF;
    RETURN false;
EXCEPTION
    WHEN others THEN
        RETURN false;
END;
$function$;

-- 5c. Revocar set_tenant de anon (solo authenticated)
REVOKE EXECUTE ON FUNCTION public.set_tenant FROM anon, public;
GRANT EXECUTE ON FUNCTION public.set_tenant TO authenticated;

-- 5d. Otorgar set_tenant_anon a anon (versión segura con validación)
GRANT EXECUTE ON FUNCTION public.set_tenant_anon TO anon, public;

-- ============================================================
-- PASO 6: Revocar funciones SECURITY DEFINER peligrosas de anon
-- ============================================================
REVOKE EXECUTE ON FUNCTION public.create_initial_subscription FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.get_all_users_for_superadmin FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable FROM anon, public;
GRANT EXECUTE ON FUNCTION public.create_initial_subscription TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_all_users_for_superadmin TO authenticated;
GRANT EXECUTE ON FUNCTION public.rls_auto_enable TO authenticated;

-- ============================================================
-- PASO 7: Data leak fixes — usuarios_con_rol + tenant isolation
-- ============================================================

-- 7a. REVOKE SELECT de usuarios_con_rol para anon
-- Esta view expone emails, roles y tenant_ids de TODOS los usuarios
REVOKE SELECT ON public.usuarios_con_rol FROM anon;

-- 7b. Actualizar policy anon de trabajadores con tenant isolation
DROP POLICY IF EXISTS "Anon puede leer trabajadores activos" ON public.trabajadores;
DROP POLICY IF EXISTS "Anon puede leer trabajadores activos de su tenant" ON public.trabajadores;
CREATE POLICY "Anon puede leer trabajadores activos de su tenant" ON public.trabajadores
    FOR SELECT TO anon
    USING (activo = true AND tenant_id = current_setting('app.tenant_id', true)::uuid);

-- 7c. Actualizar policy anon de servicios_trabajadores con tenant isolation (subquery)
DROP POLICY IF EXISTS "Anon puede leer servicios_trabajadores" ON public.servicios_trabajadores;
DROP POLICY IF EXISTS "Anon lee servicios_trabajadores de su tenant" ON public.servicios_trabajadores;
CREATE POLICY "Anon lee servicios_trabajadores de su tenant" ON public.servicios_trabajadores
    FOR SELECT TO anon
    USING (servicio_id IN (
        SELECT id FROM public.servicios
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
    ));

-- ============================================================
-- PASO 8: Verificación — consultar policies activas
-- ============================================================
-- SELECT schemaname, tablename, policyname, roles, cmd, qual
-- FROM pg_policies
-- WHERE tablename IN ('tenants', 'subscriptions', 'citas', 'servicios', 'trabajadores')
-- ORDER BY tablename, policyname;

SELECT '[SECURITY] PASO 1-7 COMPLETADO' AS status;

-- ============================================================
-- PASO 9: Refresh schema cache para que PostgREST reconozca cambios
-- ============================================================
NOTIFY pgrst, 'reload schema';
