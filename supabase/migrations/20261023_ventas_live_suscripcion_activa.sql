-- 20261023_ventas_live_suscripcion_activa.sql
-- Fix: los espacios de Ventas Live nacían con la suscripción en 'inactive'.
--
-- Causa: el trigger create_initial_subscription() inserta SIEMPRE status='inactive'
-- (sirve como marcador de "sin plan elegido"). En Reservas de Pymes el usuario pasa
-- por planes.html y ahí queda una suscripción activa. Ventas Live NO tiene paso de
-- planes (es gratis, vl_free), así que el marcador 'inactive' nunca se reemplazaba.
--
-- Efecto: el cron horario expire-subscriptions-hourly → expirar_suscripciones_vencidas()
-- suspendía el tenant (estado='inactivo') dentro de la primera hora desde su creación
-- (no tiene ninguna suscripción activa vigente). El hub mostraba entonces
-- "Suspendido por administración" y ocultaba el botón Entrar.
--
-- Fix: Ventas Live es gratis y sin vencimiento → su suscripción nace 'active'
-- (end_date NULL = vigente para siempre). Reservas sigue igual que antes.

CREATE OR REPLACE FUNCTION public.create_initial_subscription()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    INSERT INTO public.subscriptions (tenant_id, plan, status, start_date)
    VALUES (
        NEW.id,
        CASE WHEN NEW.proyecto = 'ventas_live' THEN 'vl_free' ELSE 'freemium' END,
        CASE WHEN NEW.proyecto = 'ventas_live' THEN 'active' ELSE 'inactive' END,
        now()
    );
    RETURN NEW;
END;
$function$;

-- Backfill: suscripciones de Ventas Live ya creadas que quedaron 'inactive'.
UPDATE public.subscriptions
SET status = 'active'
WHERE plan = 'vl_free'
  AND status <> 'active';

-- Backfill: tenants de Ventas Live que el cron ya había suspendido.
UPDATE public.tenants
SET estado = 'activo'
WHERE proyecto = 'ventas_live'
  AND estado = 'inactivo';
