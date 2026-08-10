-- ============================================================
-- MIGRACIÓN: Mercado Pago — Suscripciones recurrentes (preapproval)
-- Fecha: 2026-08-11
--
-- 1. Columna mp_preapproval_id en mercadopago_payments (tracking
--    de la suscripción recurrente de MP que generó el cobro).
-- 2. RPC desactivar_suscripcion: desactiva las suscripciones
--    activas de un tenant (usada por el webhook cuando MP
--    cancela/pausa un preapproval).
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: Columna mp_preapproval_id
-- ============================================================
ALTER TABLE public.mercadopago_payments ADD COLUMN IF NOT EXISTS mp_preapproval_id TEXT;

-- ============================================================
-- PASO 2: RPC desactivar_suscripcion
-- ============================================================
CREATE OR REPLACE FUNCTION public.desactivar_suscripcion(p_tenant_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_count INT;
BEGIN
    UPDATE public.subscriptions
    SET status = 'inactive',
        end_date = NOW(),
        updated_at = NOW()
    WHERE tenant_id = p_tenant_id AND status = 'active';

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION public.desactivar_suscripcion TO authenticated;

-- Refresh schema cache
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- VERIFICACIÓN
-- ============================================================
SELECT '✅ Recurrencia MP lista: mp_preapproval_id + desactivar_suscripcion' AS status;
