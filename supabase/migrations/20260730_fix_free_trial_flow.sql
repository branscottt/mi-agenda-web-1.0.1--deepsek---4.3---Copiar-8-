-- ==========================================================
-- Migration: Fix free trial flow for new tenants
-- 1. Recreate create_initial_subscription() trigger to use
--    'freemium'/'inactive' instead of 'free_trial'/'active'.
--    This lets new users consciously choose free trial on
--    the plans page instead of having it auto-activated.
-- 2. Add INSERT RLS policy for admin users on subscriptions
--    (was missing — blocks crearSuscripcion from frontend)
-- ==========================================================

-- 1. Recrear función del trigger con SECURITY DEFINER
--    Inserta suscripción 'freemium' en estado 'inactive' para
--    que getActiveSubscriptionByTenantId NO la encuentre y
--    el usuario vea todos los planes como seleccionables.
CREATE OR REPLACE FUNCTION public.create_initial_subscription()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
BEGIN
    INSERT INTO public.subscriptions (tenant_id, plan, status, start_date)
    VALUES (NEW.id, 'freemium', 'inactive', now());
    RETURN NEW;
END;
$function$;

-- 2. Agregar política INSERT para que admin pueda crear su suscripción
--    (era el único CRUD faltante — SELECT y UPDATE ya tienen políticas)
CREATE POLICY "Admin crea su suscripcion" ON public.subscriptions
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.get_user_tenant_id()
        AND (((auth.jwt() -> 'user_metadata' ->> 'rol')::text) = 'admin')
    );
