-- ============================================================
-- CORRECCIÓN: Período de cupón basado en fecha de suscripción Pro
-- Reemplaza get_current_coupon_period() y can_use_promo_coupon()
-- para que el ciclo de 2 meses cuente DESDE la suscripción,
-- no desde el calendario.
-- RENOMBRADA de 20260728_fix_coupon_period.sql a 20260812 para
-- eliminar la colisión de timestamp con 20260728_promo_video_coupons.sql
-- (quedó sin aplicar en remoto por la colisión).
-- AÑADIDO 2026-08-12: validación de tenant en get_current_coupon_period
-- (solo el propio tenant o super_admin) — anti data-leak multi-tenant.
-- ============================================================

-- Reemplazar función helper de período
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

    -- Validación de aislamiento multi-tenant: solo el propio tenant o super_admin
    -- puede consultar el período de cupón de un tenant.
    IF p_tenant_id IS DISTINCT FROM public.get_user_tenant_id()
       AND NOT public.is_super_admin() THEN
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

    -- Primer cupón: después de 2 meses (cycle-1)
    -- Luego cada 2 meses (cycle-2, cycle-3, ...)
    IF v_months_since < 2 THEN
        RETURN 'too-early';
    END IF;

    v_cycle := v_months_since / 2;
    RETURN 'cycle-' || v_cycle;
END;
$$;

-- Reemplazar función principal de verificación
CREATE OR REPLACE FUNCTION public.can_use_promo_coupon(p_tenant_id UUID)
RETURNS TABLE (
    can_use BOOLEAN,
    current_period TEXT,
    existing_id UUID,
    existing_status TEXT,
    existing_admin_comment TEXT,
    existing_video_url TEXT,
    existing_description TEXT,
    discount_available BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_period TEXT;
    v_existing RECORD;
BEGIN
    v_period := public.get_current_coupon_period(p_tenant_id);

    -- Si es demasiado pronto o no hay suscripción
    IF v_period IN ('no-tenant', 'no-subscription', 'too-early') THEN
        RETURN QUERY SELECT
            false, v_period,
            NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT,
            false;
        RETURN;
    END IF;

    -- Buscar si ya existe un cupón para este ciclo
    SELECT * INTO v_existing
    FROM public.promo_video_coupons
    WHERE tenant_id = p_tenant_id
      AND coupon_period = v_period
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_existing.id IS NULL THEN
        -- No hay cupón en este ciclo: puede crear uno nuevo
        RETURN QUERY SELECT
            true, v_period,
            NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT,
            false;
    ELSIF v_existing.status = 'approved' AND v_existing.discount_applied = false THEN
        -- Aprobado y no usado: descuento disponible
        RETURN QUERY SELECT
            false, v_period,
            v_existing.id, v_existing.status,
            v_existing.admin_comment, v_existing.video_url,
            v_existing.business_description,
            true;
    ELSE
        -- Ya existe en este ciclo (pendiente, rechazado, o usado)
        -- Si fue rechazado: puede re-enviar (can_use = true)
        -- Si está pendiente: esperando revisión
        -- Si ya usado: no puede
        RETURN QUERY SELECT
            (v_existing.status = 'rejected') AS can_use,
            v_period,
            v_existing.id, v_existing.status,
            v_existing.admin_comment, v_existing.video_url,
            v_existing.business_description,
            false;
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_current_coupon_period TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_use_promo_coupon TO authenticated;

NOTIFY pgrst, 'reload schema';

SELECT '✅ RPC corregidas: período basado en fecha de suscripción' AS status;
