-- ==========================================================
-- Migration: Auto-expire subscriptions when end_date passes
-- 1. Agrega 'free_trial' al CHECK constraint de plan
-- 2. Función que expira suscripciones vencidas automáticamente
-- 3. Cron job que la ejecuta cada hora
-- ==========================================================

-- 1. Agregar 'free_trial' al constraint (si no está ya)
ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_plan_check;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_plan_check
    CHECK (plan IN ('freemium', 'pro', 'premium_anual', 'free_trial'));

-- 2. Función que expira suscripciones cuyo end_date ya pasó
CREATE OR REPLACE FUNCTION public.expirar_suscripciones_vencidas()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_count integer;
BEGIN
    UPDATE public.subscriptions
    SET status = 'inactive'
    WHERE status = 'active'
      AND end_date IS NOT NULL
      AND end_date < NOW();
    
    GET DIAGNOSTICS v_count = ROW_COUNT;
    
    IF v_count > 0 THEN
        RAISE NOTICE '✅ % suscripción(es) vencida(s) marcada(s) como inactive', v_count;
    END IF;
    
    RETURN v_count;
END;
$$;

-- 3. Agendar cron job cada hora (minuto 0)
-- Usa pg_cron (ya habilitado)
SELECT cron.schedule(
    'expire-subscriptions-hourly',
    '0 * * * *',
    'SELECT public.expirar_suscripciones_vencidas();'
);
