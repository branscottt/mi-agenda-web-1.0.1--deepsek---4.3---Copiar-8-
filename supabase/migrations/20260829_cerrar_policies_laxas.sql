-- ============================================================
-- MIGRACIÓN: Cerrar policies laxas (aplicación efectiva)
-- Fecha: 2026-08-29
--
-- La migración 20260826 quedó registrada en el cloud con una versión
-- SIN los DROPs de las policies laxas (aplicada por fuera del repo).
-- Verificación del inventario real (2026-08-29) confirma que siguen
-- vivas y anulan la Fase 1:
--   subscriptions: "Admin crea su suscripcion" (INSERT JWT manipulable),
--     "Admin crea suscripción para su tenant" (INSERT tenant-match),
--     "Admin actualiza suscripción de su tenant" (UPDATE tenant-match)
--     → un cliente del tenant puede crear/activar premium sin pagar.
--   tenants: "Admin actualiza su tenant" (UPDATE sin rol),
--     "Crear tenant" / "Usuarios autenticados pueden crear tenants"
--     (INSERT true).
--   mercadopago_payments: "Tenant actualiza sus pagos" (UPDATE tenant-match).
--
-- Este script re-aplica los DROPs con un nombre NUEVO para garantizar
-- su ejecución (idempotente: DROP IF EXISTS).
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
-- PASO 4: limpieza de funciones temporales de verificación
-- ============================================================
DROP FUNCTION IF EXISTS public.verif_inventario_final();

-- ============================================================
-- PASO 5: Refresh schema cache + verificación
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '✅ Policies laxas ELIMINADAS (aplicación efectiva 2026-08-29)' AS status;
