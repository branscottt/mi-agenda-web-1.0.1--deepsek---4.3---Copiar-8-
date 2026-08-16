-- ============================================================
-- MIGRACIÓN: Cerrar policies laxas restantes (inventario REAL del cloud)
-- Fecha: 2026-08-26 (v2, basada en el inventario verificado del cloud)
--
-- Verificación previa (migración temporal, inventario real):
--   subscriptions: seguían vivas "Admin crea suscripción para su tenant"
--     (INSERT tenant-match), "Admin actualiza suscripción de su tenant"
--     (UPDATE tenant-match) de 20260715 y "Admin crea su suscripcion"
--     (INSERT JWT rol admin, manipulable) — ANULABAN la Fase 1: un
--     cliente del tenant podía crear/activar premium sin pagar.
--   tenants: seguía viva "Admin actualiza su tenant" (UPDATE tenant-match
--     SIN validar rol, 20260715) — un cliente podía editar el tenant
--     (plan, config, whatsapp); y "Crear tenant"/"Usuarios autenticados
--     pueden crear tenants" (INSERT true).
--   mercadopago_payments: "Tenant actualiza sus pagos" (UPDATE tenant-match)
--     — un cliente podía marcar pagos como aprobados.
--
-- Se conservan (verificadas correctas en el cloud): "Suscripcion
-- auto-registro: solo free trial" + "Admin gestiona su suscripcion..."
-- (Fase 1), "Admin puede actualizar su tenant" (is_admin), "Solo super
-- admin actualiza pagos" (is_super_admin), todas las de superadmin y
-- los SELECT tenant-scoped.
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: subscriptions — eliminar las policies que anulan la Fase 1
-- ============================================================
DROP POLICY IF EXISTS "Admin crea su suscripcion" ON public.subscriptions;
DROP POLICY IF EXISTS "Admin crea suscripción para su tenant" ON public.subscriptions;
DROP POLICY IF EXISTS "Admin actualiza suscripción de su tenant" ON public.subscriptions;

-- ============================================================
-- PASO 2: tenants — solo admin (user_roles) actualiza; crear solo vía RPC
-- ============================================================
DROP POLICY IF EXISTS "Admin actualiza su tenant" ON public.tenants;
DROP POLICY IF EXISTS "Crear tenant" ON public.tenants;
DROP POLICY IF EXISTS "Usuarios autenticados pueden crear tenants" ON public.tenants;

-- ============================================================
-- PASO 3: mercadopago_payments — UPDATE solo super_admin
-- ============================================================
DROP POLICY IF EXISTS "Tenant actualiza sus pagos" ON public.mercadopago_payments;
DROP POLICY IF EXISTS "Webhook actualiza pagos" ON public.mercadopago_payments;

-- ============================================================
-- PASO 4: asegurar las correctas (idempotente — ya existen en el cloud)
-- ============================================================
DROP POLICY IF EXISTS "Solo super admin actualiza pagos" ON public.mercadopago_payments;
CREATE POLICY "Solo super admin actualiza pagos" ON public.mercadopago_payments
    FOR UPDATE TO authenticated
    USING (public.is_super_admin())
    WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS "Admin puede actualizar su tenant" ON public.tenants;
CREATE POLICY "Admin puede actualizar su tenant" ON public.tenants
    FOR UPDATE TO authenticated
    USING (id = public.get_user_tenant_id() AND public.is_admin())
    WITH CHECK (id = public.get_user_tenant_id() AND public.is_admin());

-- ============================================================
-- PASO 5: limpieza de la función temporal de verificación
-- ============================================================
DROP FUNCTION IF EXISTS public.verif_inventario_policies();

-- ============================================================
-- PASO 6: Refresh schema cache + verificación
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '✅ Policies laxas cerradas: subscriptions solo free_trial/cancelar-freemium; tenants solo admin (user_roles); mercadopago solo superadmin' AS status;
