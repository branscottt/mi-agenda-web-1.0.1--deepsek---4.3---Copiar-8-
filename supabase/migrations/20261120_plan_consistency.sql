-- 20261120_plan_consistency.sql
-- ============================================================================
-- CONSISTENCIA PLAN ↔ SUSCRIPCIÓN ↔ MERCADO PAGO
--
-- Reglas que quedan garantizadas por la BASE (no por el frontend):
--   R1. Una sola suscripción ACTIVA por tenant (índice único parcial).
--   R2. tenants.plan SIEMPRE = plan de la suscripción activa; si no hay
--       ninguna activa = 'freemium'. Se mantiene con trigger en subscriptions
--       (cubre pago, cancelación, vencimiento por cron, cambio manual).
--   R3. Es IMPOSIBLE degradar una suscripción a un plan gratuito mientras
--       exista un preapproval ARMADO en MP (allow_activation=true y estado
--       pending/authorized/paused). Obliga a cancelar en MP primero.
--   R4. Es IMPOSIBLE borrar un tenant con un preapproval armado: no se pueden
--       volver a crear preapprovals huérfanos que MP siga cobrando.
--   R5. Función de diagnóstico planes_inconsistentes() para auditar.
--
-- Contexto (caso umbralis 2026-11): un tenant borrado dejó su preapproval
-- cobrando; el plan del tenant y la suscripción activa podían discrepar y el
-- webhook reactivaba planes de pago. Estas reglas cierran esas grietas.
-- ============================================================================

BEGIN;

-- R1 ------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_active_per_tenant
    ON public.subscriptions (tenant_id)
    WHERE status = 'active';

-- R2 ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_tenant_plan_from_subscription()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    v_tenant uuid;
    v_plan   text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_tenant := OLD.tenant_id;
    ELSE
        v_tenant := NEW.tenant_id;
    END IF;

    IF v_tenant IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    SELECT s.plan INTO v_plan
      FROM public.subscriptions s
     WHERE s.tenant_id = v_tenant
       AND s.status = 'active'
     ORDER BY s.start_date DESC NULLS LAST, s.created_at DESC
     LIMIT 1;

    -- Sin suscripción activa el plan vigente es el gratuito (sin acceso de pago).
    v_plan := COALESCE(v_plan, 'freemium');

    UPDATE public.tenants
       SET plan = v_plan
     WHERE id = v_tenant
       AND plan IS DISTINCT FROM v_plan;

    RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS trg_subscriptions_sync_tenant_plan ON public.subscriptions;
CREATE TRIGGER trg_subscriptions_sync_tenant_plan
AFTER INSERT OR UPDATE OR DELETE ON public.subscriptions
FOR EACH ROW EXECUTE FUNCTION public.sync_tenant_plan_from_subscription();

-- R3 ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_free_plan_with_active_preapproval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    v_es_gratuito boolean;
    v_cambia      boolean;
BEGIN
    v_es_gratuito := NEW.plan IN ('freemium', 'free_trial', 'vl_free');

    IF TG_OP = 'INSERT' THEN
        v_cambia := true;
    ELSE
        v_cambia := NEW.plan IS DISTINCT FROM OLD.plan;
    END IF;

    IF v_es_gratuito AND v_cambia THEN
        IF EXISTS (
            SELECT 1
              FROM public.mp_preapprovals p
             WHERE p.tenant_id = NEW.tenant_id
               AND p.allow_activation = true
               AND p.status IN ('pending', 'authorized', 'paused')
        ) THEN
            RAISE EXCEPTION
                'No se puede dejar el negocio en plan gratuito: tiene un cobro automático activo en Mercado Pago. Cancela la suscripción en Mercado Pago primero.'
                USING ERRCODE = 'P0002';
        END IF;
    END IF;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_subscriptions_no_free_with_preapproval ON public.subscriptions;
DROP TRIGGER IF EXISTS trg_subscriptions_no_free_with_preapproval_ins ON public.subscriptions;
DROP TRIGGER IF EXISTS trg_subscriptions_no_free_with_preapproval_upd ON public.subscriptions;
CREATE TRIGGER trg_subscriptions_no_free_with_preapproval_ins
BEFORE INSERT ON public.subscriptions
FOR EACH ROW EXECUTE FUNCTION public.prevent_free_plan_with_active_preapproval();

CREATE TRIGGER trg_subscriptions_no_free_with_preapproval_upd
BEFORE UPDATE OF plan ON public.subscriptions
FOR EACH ROW EXECUTE FUNCTION public.prevent_free_plan_with_active_preapproval();

-- R4 ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_tenant_delete_with_active_preapproval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM public.mp_preapprovals p
         WHERE p.tenant_id = OLD.id
           AND p.status IN ('pending', 'authorized', 'paused')
           AND (p.allow_activation = true OR p.status IN ('authorized', 'paused'))
    ) THEN
        RAISE EXCEPTION
            'No se puede eliminar el negocio: tiene un cobro automático activo en Mercado Pago. Cancélalo primero.'
            USING ERRCODE = 'P0003';
    END IF;

    RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS trg_tenants_no_delete_with_preapproval ON public.tenants;
CREATE TRIGGER trg_tenants_no_delete_with_preapproval
BEFORE DELETE ON public.tenants
FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_delete_with_active_preapproval();

-- R5: diagnóstico ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.planes_inconsistentes()
RETURNS TABLE (
    tenant_id    uuid,
    nombre       text,
    problema     text,
    tenant_plan  text,
    sub_plan     text,
    sub_status   text,
    detalle      text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $function$
    -- tenants.plan distinto del plan de su suscripción activa
    SELECT t.id, t.nombre_negocio,
           'plan_no_coincide'::text,
           t.plan::text, s.plan::text, s.status::text,
           'tenants.plan=' || COALESCE(t.plan, 'NULL') || ' vs sub=' || COALESCE(s.plan, 'NULL')
      FROM public.tenants t
      LEFT JOIN LATERAL (
           SELECT ss.plan, ss.status
             FROM public.subscriptions ss
            WHERE ss.tenant_id = t.id AND ss.status = 'active'
            ORDER BY ss.start_date DESC NULLS LAST LIMIT 1
      ) s ON true
     WHERE t.plan IS DISTINCT FROM COALESCE(s.plan, 'freemium')

    UNION ALL

    -- más de una suscripción activa (no puede pasar con el índice, pero se audita)
    SELECT t.id, t.nombre_negocio,
           'multiples_activas'::text,
           t.plan::text, NULL, NULL,
           count(*)::text || ' suscripciones activas'
      FROM public.tenants t
      JOIN public.subscriptions s ON s.tenant_id = t.id AND s.status = 'active'
     GROUP BY t.id, t.nombre_negocio, t.plan
    HAVING count(*) > 1

    UNION ALL

    -- preapproval ARMADO en un tenant sin suscripción de pago activa
    SELECT t.id, t.nombre_negocio,
           'preapproval_armado_sin_plan_pago'::text,
           t.plan::text, s.plan::text, s.status::text,
           'preapproval ' || p.mp_preapproval_id || ' estado ' || p.status
      FROM public.tenants t
      JOIN public.mp_preapprovals p
        ON p.tenant_id = t.id
       AND p.allow_activation = true
       AND p.status IN ('pending', 'authorized', 'paused')
      LEFT JOIN LATERAL (
           SELECT ss.plan, ss.status
             FROM public.subscriptions ss
            WHERE ss.tenant_id = t.id AND ss.status = 'active'
            ORDER BY ss.start_date DESC NULLS LAST LIMIT 1
      ) s ON true
     WHERE s.plan IS NULL OR s.plan NOT IN ('pro', 'premium_anual');
$function$;

REVOKE ALL ON FUNCTION public.planes_inconsistentes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.planes_inconsistentes() TO service_role;

REVOKE ALL ON FUNCTION public.sync_tenant_plan_from_subscription() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prevent_free_plan_with_active_preapproval() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prevent_tenant_delete_with_active_preapproval() FROM PUBLIC, anon, authenticated;

-- Backfill: dejar el estado actual coherente (suscripción activa manda).
UPDATE public.tenants t
   SET plan = COALESCE((
        SELECT s.plan
          FROM public.subscriptions s
         WHERE s.tenant_id = t.id AND s.status = 'active'
         ORDER BY s.start_date DESC NULLS LAST, s.created_at DESC
         LIMIT 1
   ), 'freemium')
 WHERE t.plan IS DISTINCT FROM COALESCE((
        SELECT s.plan
          FROM public.subscriptions s
         WHERE s.tenant_id = t.id AND s.status = 'active'
         ORDER BY s.start_date DESC NULLS LAST, s.created_at DESC
         LIMIT 1
   ), 'freemium');

COMMIT;
