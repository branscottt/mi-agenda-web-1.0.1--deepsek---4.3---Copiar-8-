-- ============================================================
-- MIGRACIÓN: Promoción Video — Cupón 50% descuento Pro mensual
-- Fecha: 2026-07-28
--
-- 1. Tabla promo_video_coupons para tracking de solicitudes
-- 2. RLS: tenant ve su cupón, superadmin ve todo
-- 3. Helper function para período bimestral
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: Tabla de cupones por video promocional
-- ============================================================
CREATE TABLE IF NOT EXISTS public.promo_video_coupons (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    video_url TEXT NOT NULL,
    business_description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    admin_comment TEXT,
    discount_applied BOOLEAN NOT NULL DEFAULT false,
    coupon_period TEXT NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_promo_coupons_tenant ON public.promo_video_coupons (tenant_id, coupon_period DESC);
CREATE INDEX IF NOT EXISTS idx_promo_coupons_status ON public.promo_video_coupons (status);

-- RLS
ALTER TABLE public.promo_video_coupons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant ve su cupon" ON public.promo_video_coupons;
CREATE POLICY "Tenant ve su cupon"
    ON public.promo_video_coupons FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.get_user_tenant_id()
        OR public.is_super_admin()
    );

DROP POLICY IF EXISTS "Tenant crea su cupon" ON public.promo_video_coupons;
CREATE POLICY "Tenant crea su cupon"
    ON public.promo_video_coupons FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.get_user_tenant_id()
    );

DROP POLICY IF EXISTS "Superadmin actualiza cupon" ON public.promo_video_coupons;
CREATE POLICY "Superadmin actualiza cupon"
    ON public.promo_video_coupons FOR UPDATE
    TO authenticated
    USING (public.is_super_admin())
    WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS "Superadmin elimina cupon" ON public.promo_video_coupons;
CREATE POLICY "Superadmin elimina cupon"
    ON public.promo_video_coupons FOR DELETE
    TO authenticated
    USING (public.is_super_admin());

REVOKE ALL ON public.promo_video_coupons FROM anon;

-- Triggers para updated_at
CREATE OR REPLACE FUNCTION public.update_promo_coupon_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_promo_coupon_updated_at ON public.promo_video_coupons;
CREATE TRIGGER trg_promo_coupon_updated_at
    BEFORE UPDATE ON public.promo_video_coupons
    FOR EACH ROW
    EXECUTE FUNCTION public.update_promo_coupon_updated_at();

-- ============================================================
-- PASO 2: Función helper — obtener período bimestral actual
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_current_coupon_period()
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT TO_CHAR(
        DATE_TRUNC('month', NOW()) - 
        (EXTRACT(MONTH FROM NOW())::int - 1) % 2 * INTERVAL '1 month',
        'YYYY-MM'
    );
$$;

-- ============================================================
-- PASO 3: Función helper — verificar si tenant puede usar cupón
-- ============================================================
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
    v_period := public.get_current_coupon_period();

    SELECT * INTO v_existing
    FROM public.promo_video_coupons
    WHERE tenant_id = p_tenant_id
      AND coupon_period = v_period
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_existing.id IS NULL THEN
        -- No hay cupón en este período: puede crear
        RETURN QUERY SELECT
            true AS can_use,
            v_period AS current_period,
            NULL::UUID AS existing_id,
            NULL::TEXT AS existing_status,
            NULL::TEXT AS existing_admin_comment,
            NULL::TEXT AS existing_video_url,
            NULL::TEXT AS existing_description,
            false AS discount_available;
    ELSIF v_existing.status = 'approved' AND v_existing.discount_applied = false THEN
        -- Aprobado y no usado: descuento disponible
        RETURN QUERY SELECT
            false AS can_use,
            v_period AS current_period,
            v_existing.id AS existing_id,
            v_existing.status AS existing_status,
            v_existing.admin_comment AS existing_admin_comment,
            v_existing.video_url AS existing_video_url,
            v_existing.business_description AS existing_description,
            true AS discount_available;
    ELSE
        -- Ya existe (rechazado, pendiente, o ya usado)
        RETURN QUERY SELECT
            (v_existing.status = 'rejected') AS can_use,
            v_period AS current_period,
            v_existing.id AS existing_id,
            v_existing.status AS existing_status,
            v_existing.admin_comment AS existing_admin_comment,
            v_existing.video_url AS existing_video_url,
            v_existing.business_description AS existing_description,
            false AS discount_available;
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.can_use_promo_coupon TO authenticated;

-- ============================================================
-- PASO 4: Notify schema cache
-- ============================================================
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- VERIFICACIÓN
-- ============================================================
SELECT '✅ Migración Promo Video completada: tabla promo_video_coupons + helpers' AS status;
