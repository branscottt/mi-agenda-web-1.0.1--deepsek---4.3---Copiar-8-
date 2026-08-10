-- ============================================================
-- MIGRACIÓN: Fix REVOKE de RPCs de pago — EXECUTE por defecto a PUBLIC
-- Fecha: 2026-08-12 (aplicada como 20260815)
--
-- En PostgreSQL las funciones se crean con EXECUTE otorgado a PUBLIC.
-- El REVOKE ... FROM authenticated de la migración 20260813 NO bastó:
-- el rol authenticated hereda el EXECUTE de PUBLIC, por lo que
-- activar_suscripcion_post_pago / desactivar_suscripcion seguían
-- invocables (verificado con has_function_privilege).
--
-- Fix: REVOKE explícito de anon, public y authenticated.
-- service_role conserva su EXECUTE (el webhook de MP lo necesita).
-- ============================================================

-- ============================================================
-- PASO 1: Quitar EXECUTE a todos los roles no privilegiados
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.activar_suscripcion_post_pago(UUID, TEXT, TEXT, NUMERIC) FROM anon, public, authenticated;
REVOKE EXECUTE ON FUNCTION public.desactivar_suscripcion(UUID) FROM anon, public, authenticated;

-- Cupones: anon no debe consultar períodos de cupón de ningún tenant
REVOKE EXECUTE ON FUNCTION public.can_use_promo_coupon(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_current_coupon_period(UUID) FROM anon;

-- ============================================================
-- PASO 2: Verificación — si algún rol no privilegiado conserva
-- EXECUTE, la migración falla (no se registra como aplicada).
-- ============================================================

DO $$
BEGIN
    IF has_function_privilege('authenticated',
        'public.activar_suscripcion_post_pago(uuid,text,text,numeric)', 'EXECUTE') THEN
        RAISE EXCEPTION 'FIX_FALLIDO: activar_suscripcion_post_pago sigue con EXECUTE para authenticated';
    END IF;
    IF has_function_privilege('authenticated',
        'public.desactivar_suscripcion(uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'FIX_FALLIDO: desactivar_suscripcion sigue con EXECUTE para authenticated';
    END IF;
    IF has_function_privilege('anon',
        'public.activar_suscripcion_post_pago(uuid,text,text,numeric)', 'EXECUTE') THEN
        RAISE EXCEPTION 'FIX_FALLIDO: activar_suscripcion_post_pago sigue con EXECUTE para anon';
    END IF;
END $$;

-- ============================================================
-- PASO 3: Refresh schema cache + verificación
-- ============================================================
ALTER TABLE public.mercadopago_payments ALTER COLUMN monto SET DEFAULT NULL;
NOTIFY pgrst, 'reload schema';

SELECT '✅ RPCs de pago blindadas: EXECUTE solo para service_role (webhook)' AS status;
