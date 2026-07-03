-- ==========================================================
-- Migration: Fix create_initial_subscription trigger
-- Cambia de freemium a free_trial con 14 días de end_date
-- ==========================================================

CREATE OR REPLACE FUNCTION public.create_initial_subscription()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
BEGIN
    INSERT INTO public.subscriptions (tenant_id, plan, status, start_date, end_date)
    VALUES (NEW.id, COALESCE(NEW.plan, 'free_trial'), 'active', now(), now() + interval '14 days');
    RETURN NEW;
END;
$function$;
