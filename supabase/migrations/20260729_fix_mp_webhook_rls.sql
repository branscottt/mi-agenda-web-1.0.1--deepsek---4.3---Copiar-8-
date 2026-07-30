-- ============================================================
-- MIGRACIÓN: Fix RLS policy para mercadopago_payments UPDATE
-- Fecha: 2026-07-29
--
-- La policy anterior permitía a CUALQUIER usuario autenticado
-- actualizar CUALQUIER pago (USING true WITH CHECK true).
-- Esto es un riesgo: un atacante autenticado podría modificar
-- el estado de pagos que no le pertenecen.
--
-- Solución: restringir UPDATE solo al mismo tenant o super_admin.
-- El webhook de MP usa service_role key (bypass RLS), no necesita
-- una policy permisiva.
-- ============================================================

-- Reemplazar la policy UPDATE permisiva por una restrictiva
DROP POLICY IF EXISTS "Webhook actualiza pagos" ON public.mercadopago_payments;

CREATE POLICY "Tenant actualiza sus pagos"
    ON public.mercadopago_payments FOR UPDATE
    TO authenticated
    USING (
        tenant_id = public.get_user_tenant_id()
        OR public.is_super_admin()
    )
    WITH CHECK (
        tenant_id = public.get_user_tenant_id()
        OR public.is_super_admin()
    );

-- Refresh schema cache
NOTIFY pgrst, 'reload schema';

SELECT '✅ RLS mercadopago_payments UPDATE fijado: solo tenant o super_admin' AS status;
