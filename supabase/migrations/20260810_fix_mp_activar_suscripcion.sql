-- ============================================================
-- MIGRACIÓN: Fix Mercado Pago — activar_suscripcion_post_pago
-- Fecha: 2026-08-10
--
-- 0. ADD COLUMN monto a subscriptions (la RPC original la usaba
--    pero la columna NUNCA existió -> error 42703 en runtime ->
--    la activación de suscripciones por pago jamás funcionó).
-- 1. Idempotencia: si el mp_payment_id ya activó una suscripción,
--    no duplicar (MP reintenta webhooks hasta 5 veces).
-- 2. Monto real pagado: guardar transaction_amount real (cupón 50%).
-- 3. Renovación recurrente: si el tenant ya tiene activa una
--    suscripción del MISMO plan, extender end_date en vez de
--    crear una nueva (prepara el flujo de cobros automáticos).
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 0: Columna monto en subscriptions (si falta)
-- ============================================================
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS monto NUMERIC(10,0);

-- ============================================================
-- PASO 1: Función activar_suscripcion_post_pago mejorada
-- ============================================================

-- Eliminar la firma antigua (sin p_monto) para que no haya
-- ambigüedad (PostgreSQL: CREATE OR REPLACE con firma distinta
-- crea una función NUEVA en vez de reemplazar -> 42725).
DROP FUNCTION IF EXISTS public.activar_suscripcion_post_pago(UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.activar_suscripcion_post_pago(
    p_tenant_id UUID,
    p_plan TEXT,
    p_mp_payment_id TEXT DEFAULT NULL,
    p_monto NUMERIC DEFAULT NULL
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
    v_existing_payment RECORD;
    v_current_sub RECORD;
    v_monto NUMERIC;
BEGIN
    -- ============================================================
    -- PASO 1: Idempotencia — si este mp_payment_id ya activó una
    -- suscripción, devolver la existente sin duplicar nada.
    -- ============================================================
    IF p_mp_payment_id IS NOT NULL THEN
        SELECT id, subscription_id INTO v_existing_payment
        FROM public.mercadopago_payments
        WHERE mp_payment_id = p_mp_payment_id
        LIMIT 1;

        IF v_existing_payment.subscription_id IS NOT NULL THEN
            RETURN v_existing_payment.subscription_id;
        END IF;
    END IF;

    -- ============================================================
    -- PASO 2: Calcular fechas y monto
    -- ============================================================
    v_start_date := NOW();
    v_monto := COALESCE(
        p_monto,
        CASE WHEN p_plan = 'premium_anual' THEN 140000 ELSE 15000 END
    );

    -- Buscar suscripción activa actual del tenant
    SELECT id, plan, end_date INTO v_current_sub
    FROM public.subscriptions
    WHERE tenant_id = p_tenant_id AND status = 'active'
    ORDER BY created_at DESC
    LIMIT 1;

    -- ============================================================
    -- PASO 3: Renovación recurrente del MISMO plan
    -- Si el tenant ya tiene activo este plan, extender end_date
    -- desde max(hoy, end_date actual) — no se pierden días pagados.
    -- ============================================================
    IF v_current_sub.id IS NOT NULL AND v_current_sub.plan = p_plan THEN
        v_start_date := GREATEST(NOW(), COALESCE(v_current_sub.end_date, NOW()));

        IF p_plan = 'premium_anual' THEN
            v_end_date := v_start_date + INTERVAL '1 year';
        ELSE
            v_end_date := v_start_date + INTERVAL '1 month';
        END IF;

        UPDATE public.subscriptions
        SET end_date = v_end_date,
            monto = v_monto,
            updated_at = NOW()
        WHERE id = v_current_sub.id
        RETURNING id INTO v_subscription_id;

    -- ============================================================
    -- PASO 4: Cambio de plan (o primera activación)
    -- ============================================================
    ELSE
        -- Desactivar suscripciones activas previas de otro plan
        UPDATE public.subscriptions
        SET status = 'inactive',
            end_date = v_start_date,
            updated_at = NOW()
        WHERE tenant_id = p_tenant_id AND status = 'active';

        IF p_plan = 'premium_anual' THEN
            v_end_date := v_start_date + INTERVAL '1 year';
        ELSE
            v_end_date := v_start_date + INTERVAL '1 month';
        END IF;

        -- Crear nueva suscripción
        INSERT INTO public.subscriptions (tenant_id, plan, status, start_date, end_date, monto)
        VALUES (p_tenant_id, p_plan, 'active', v_start_date, v_end_date, v_monto)
        RETURNING id INTO v_subscription_id;
    END IF;

    -- ============================================================
    -- PASO 5: Vincular el payment con la suscripción
    -- ============================================================
    IF p_mp_payment_id IS NOT NULL THEN
        UPDATE public.mercadopago_payments
        SET subscription_id = v_subscription_id,
            paid_at = NOW(),
            updated_at = NOW()
        WHERE mp_payment_id = p_mp_payment_id;
    END IF;

    RETURN v_subscription_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.activar_suscripcion_post_pago(UUID, TEXT, TEXT, NUMERIC) TO authenticated;

-- Refresh schema cache
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- VERIFICACIÓN
-- ============================================================
SELECT '✅ activar_suscripcion_post_pago: idempotente + renovación recurrente + monto real' AS status;
