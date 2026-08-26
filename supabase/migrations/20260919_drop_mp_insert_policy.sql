-- ============================================================
-- MIGRACIÓN: Bloquear inserción de pagos ficticios en mercadopago_payments
-- Fecha: 2026-08-26 (timestamp posterior a 20260918 para evitar colisión)
--
-- La policy "Sistema inserta pagos" permitía a CUALQUIER usuario
-- authenticated insertar filas en mercadopago_payments de su propio tenant
-- (WITH CHECK tenant_id = get_user_tenant_id()), incluyendo mp_status='approved'
-- inventado -> datos ficticios en la vista de pagos del superadmin.
--
-- El ÚNICO actor legítimo que inserta pagos es el webhook de Mercado Pago
-- (service_role, que bypassa RLS). Ningún flujo del frontend inserta pagos.
--
-- Script lineal, idempotente, sin DO $$.
-- ============================================================

DROP POLICY IF EXISTS "Sistema inserta pagos" ON public.mercadopago_payments;

-- Refresh schema cache
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- VERIFICACIÓN: solo deben quedar SELECT (tenant/super) y UPDATE (super)
-- ============================================================
SELECT policyname, cmd FROM pg_policies WHERE tablename = 'mercadopago_payments' ORDER BY cmd;
