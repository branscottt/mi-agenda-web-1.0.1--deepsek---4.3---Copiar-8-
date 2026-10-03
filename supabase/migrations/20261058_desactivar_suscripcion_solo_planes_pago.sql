-- ============================================================
-- MIGRACIÓN: desactivar_suscripcion solo desactiva planes de PAGO
-- Fecha: 2026-10-03
--
-- Motivo (caso real): el superadmin cambia un tenant a un plan gratuito
-- (freemium / free_trial / vl_free). La Edge Function cancelar-suscripcion
-- cancela el preapproval en Mercado Pago; Mercado Pago responde con un aviso
-- "preapproval cancelled" y el webhook llama a desactivar_suscripcion. Si esa
-- RPC desactiva TODAS las suscripciones activas (incluida la freemium recién
-- asignada), el negocio pierde el plan gratuito que el superadmin le otorgó —
-- dejándolo en el paywall aunque debería tener acceso "gratis para siempre".
--
-- Fix: desactivar_suscripcion solo aplica a planes con cobro recurrente
-- (pro, premium_anual). Los planes gratuitos (freemium, free_trial, vl_free)
-- NUNCA se desactivan por un evento de Mercado Pago. El botón "Cancelar
-- Suscripción" del inquilino sigue funcionando igual (su plan activo es de
-- pago).
--
-- Idempotente: CREATE OR REPLACE sobre la firma existente (UUID).
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
    WHERE tenant_id = p_tenant_id
      AND status = 'active'
      AND plan IN ('pro', 'premium_anual');

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION public.desactivar_suscripcion(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- VERIFICACIÓN
-- ============================================================
SELECT '✅ desactivar_suscripcion: solo desactiva planes de pago (pro/premium_anual)' AS status;
