-- ============================================
-- Migration: Fix trigger to use SECURITY DEFINER
-- Previene errores RLS en la creación automática
-- de suscripciones cuando un usuario crea su tenant.
-- ============================================

-- 1. Recrear la función con SECURITY DEFINER
--    SECURITY DEFINER ejecuta con permisos del creador (postgres/supabase_admin)
--    en lugar de los permisos RLS del usuario autenticado.
--    search_path explícito previene inyección de esquemas maliciosos.
CREATE OR REPLACE FUNCTION public.create_initial_subscription()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
BEGIN
    INSERT INTO public.subscriptions (tenant_id, plan, status, start_date)
    VALUES (NEW.id, COALESCE(NEW.plan, 'freemium'), 'active', now());
    RETURN NEW;
END;
$function$;

-- 2. Eliminar y recrear el trigger por si acaso (idempotente)
DROP TRIGGER IF EXISTS trg_create_subscription_on_tenant ON public.tenants;
CREATE TRIGGER trg_create_subscription_on_tenant
    AFTER INSERT ON public.tenants
    FOR EACH ROW
    EXECUTE FUNCTION public.create_initial_subscription();
