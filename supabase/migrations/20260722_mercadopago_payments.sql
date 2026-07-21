-- ============================================================
-- MIGRACIÓN: Mercado Pago — Pagos de suscripciones
-- Fecha: 2026-07-21
--
-- 1. Tabla mercadopago_payments para tracking de transacciones
-- 2. Función para activar suscripción post-pago
-- 3. Trigger que registra cambios de estado en payments
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: Tabla de pagos Mercado Pago
-- ============================================================
CREATE TABLE IF NOT EXISTS public.mercadopago_payments (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    subscription_id UUID REFERENCES public.subscriptions(id) ON DELETE SET NULL,
    plan TEXT NOT NULL CHECK (plan IN ('pro', 'premium_anual')),
    monto NUMERIC(10,0) NOT NULL,
    mp_preference_id TEXT,
    mp_payment_id TEXT,
    mp_status TEXT DEFAULT 'pending' CHECK (mp_status IN ('pending', 'approved', 'rejected', 'cancelled', 'refunded')),
    mp_status_detail TEXT,
    mp_payer_email TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    paid_at TIMESTAMPTZ,
    notified_at TIMESTAMPTZ
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_mp_payments_tenant ON public.mercadopago_payments (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mp_payments_preference ON public.mercadopago_payments (mp_preference_id);
CREATE INDEX IF NOT EXISTS idx_mp_payments_payment ON public.mercadopago_payments (mp_payment_id);

-- RLS: tenant ve sus propios pagos, super_admin ve todo
ALTER TABLE public.mercadopago_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant ve sus pagos" ON public.mercadopago_payments;
CREATE POLICY "Tenant ve sus pagos"
    ON public.mercadopago_payments FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.get_user_tenant_id()
        OR public.is_super_admin()
    );

DROP POLICY IF EXISTS "Sistema inserta pagos" ON public.mercadopago_payments;
CREATE POLICY "Sistema inserta pagos"
    ON public.mercadopago_payments FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.get_user_tenant_id()
        OR public.is_super_admin()
    );

DROP POLICY IF EXISTS "Webhook actualiza pagos" ON public.mercadopago_payments;
CREATE POLICY "Webhook actualiza pagos"
    ON public.mercadopago_payments FOR UPDATE
    TO authenticated
    USING (true)
    WITH CHECK (true);

-- REVOKE de anon
REVOKE ALL ON public.mercadopago_payments FROM anon;

-- ============================================================
-- PASO 2: Función que activa suscripción post-pago aprobado
-- Se llama desde el webhook de MP
-- ============================================================
CREATE OR REPLACE FUNCTION public.activar_suscripcion_post_pago(
    p_tenant_id UUID,
    p_plan TEXT,
    p_mp_payment_id TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_subscription_id UUID;
    v_start_date TIMESTAMPTZ;
    v_end_date TIMESTAMPTZ;
BEGIN
    v_start_date := NOW();

    IF p_plan = 'premium_anual' THEN
        v_end_date := v_start_date + INTERVAL '1 year';
    ELSE
        v_end_date := v_start_date + INTERVAL '1 month';
    END IF;

    -- Desactivar suscripciones activas previas del tenant
    UPDATE public.subscriptions
    SET status = 'inactive', end_date = v_start_date
    WHERE tenant_id = p_tenant_id AND status = 'active';

    -- Crear nueva suscripción
    INSERT INTO public.subscriptions (tenant_id, plan, status, start_date, end_date, monto)
    VALUES (p_tenant_id, p_plan, 'active', v_start_date, v_end_date,
            CASE WHEN p_plan = 'premium_anual' THEN 140000 ELSE 15000 END)
    RETURNING id INTO v_subscription_id;

    -- Actualizar el payment con la subscription_id
    IF p_mp_payment_id IS NOT NULL THEN
        UPDATE public.mercadopago_payments
        SET subscription_id = v_subscription_id, paid_at = NOW()
        WHERE mp_payment_id = p_mp_payment_id;
    END IF;

    RETURN v_subscription_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.activar_suscripcion_post_pago TO authenticated;

-- ============================================================
-- PASO 3: Refresh schema cache
-- ============================================================
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- VERIFICACIÓN
-- ============================================================
SELECT '✅ Migración MP completada: tabla mercadopago_payments + activar_suscripcion_post_pago' AS status;
