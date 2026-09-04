-- ============================================================
-- 20260901_cupon_trimestral.sql
-- Modelo de negocio (2026-09): el cupón 50% se puede activar CADA 3 MESES
-- (período trimestral) si el superadmin aprueba el video promocional.
-- El descuento se aplica AUTOMÁTICAMENTE a UN cobro mensual de la
-- suscripción (refund parcial de $7.500 en el webhook); el mes siguiente
-- sigue cobrando $15.000 normal. Antes era bimestral (%2, migración
-- 20260812_fix_coupon_period.sql).
-- ============================================================
-- Cambios vs 20260812:
--   1. Primer cupón a los 3 meses (antes 2) y ciclo cada 3 meses (antes 2).
--   2. Se permite al backend (service_role, webhook de Mercado Pago)
--      consultar el período de cualquier tenant: sin esto, el webhook
--      recibiría 'no-tenant' (get_user_tenant_id()/is_super_admin() usan
--      auth.uid() que es NULL con service_role) y el descuento automático
--      nunca se aplicaría.
-- ============================================================
-- Nota: DROP previo porque CREATE OR REPLACE no puede quitar el DEFAULT
-- del parámetro existente (42P13).
DROP FUNCTION IF EXISTS public.get_current_coupon_period(uuid);

CREATE OR REPLACE FUNCTION public.get_current_coupon_period(p_tenant_id UUID DEFAULT NULL)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_start_date TIMESTAMPTZ;
    v_months_since INT;
    v_cycle INT;
BEGIN
    IF p_tenant_id IS NULL THEN
        RETURN 'no-tenant';
    END IF;
    -- Validación de aislamiento multi-tenant: solo el propio tenant,
    -- super_admin o el backend (service_role — webhook de MP) puede
    -- consultar el período de cupón de un tenant.
    IF p_tenant_id IS DISTINCT FROM public.get_user_tenant_id()
       AND NOT public.is_super_admin()
       AND COALESCE(current_setting('request.jwt.claim.role', true), '') <> 'service_role' THEN
        RETURN 'no-tenant';
    END IF;
    -- Obtener la suscripción Pro activa más antigua
    SELECT start_date INTO v_start_date
    FROM public.subscriptions
    WHERE tenant_id = p_tenant_id
      AND plan = 'pro'
      AND status = 'active'
    ORDER BY start_date ASC
    LIMIT 1;
    IF v_start_date IS NULL THEN
        RETURN 'no-subscription';
    END IF;
    -- Calcular meses transcurridos desde el inicio
    v_months_since := (EXTRACT(YEAR FROM age(NOW(), v_start_date)) * 12
                      + EXTRACT(MONTH FROM age(NOW(), v_start_date)))::int;
    -- Primer cupón: después de 3 meses (cycle-1)
    -- Luego cada 3 meses (cycle-2, cycle-3, ...)
    IF v_months_since < 3 THEN
        RETURN 'too-early';
    END IF;
    v_cycle := v_months_since / 3;
    RETURN 'cycle-' || v_cycle;
END;
$$;
