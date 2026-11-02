-- 20261119_mp_preapproval_registrar.sql
-- ============================================================================
-- Registro atómico de una suscripción recurrente de MP.
--
-- POR QUÉ UNA RPC Y NO UN UPSERT PostgREST:
--   Un upsert con on_conflict=mp_preapproval_id actualiza TODAS las columnas
--   enviadas, incluido tenant_id. En umbralis existen DOS tenants con el
--   mismo email de contacto; cancelar desde el tenant equivocado reasignaba
--   la suscripción al otro tenant.
--
-- REGLAS:
--   - el tenant_id se fija en el INSERT y NUNCA se pisa.
--   - allow_activation solo puede pasar de true→false, jamás al revés
--    (la decisión comercial más reciente de no cobrar es definitiva).
--   - COALESCE en los datos descriptivos para no borrarlos con null.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.mp_preapproval_registrar(
    p_tenant_id        uuid,
    p_preapproval_id   text,
    p_plan             text DEFAULT NULL,
    p_monto            numeric DEFAULT NULL,
    p_frequency        integer DEFAULT NULL,
    p_frequency_type   text DEFAULT NULL,
    p_payer_email      text DEFAULT NULL,
    p_status           text DEFAULT 'pending',
    p_allow_activation boolean DEFAULT true,
    p_cancel_source    text DEFAULT NULL,
    p_cancelled_at     timestamptz DEFAULT NULL,
    p_last_error       text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    v_id uuid;
BEGIN
    INSERT INTO public.mp_preapprovals (
        tenant_id, mp_preapproval_id, plan, monto, frequency, frequency_type,
        payer_email, status, allow_activation, cancel_source, cancelled_at,
        last_error, last_synced_at, updated_at
    ) VALUES (
        p_tenant_id, p_preapproval_id, p_plan, p_monto, p_frequency, p_frequency_type,
        p_payer_email, COALESCE(p_status, 'pending'), COALESCE(p_allow_activation, true),
        p_cancel_source, p_cancelled_at, p_last_error, NOW(), NOW()
    )
    ON CONFLICT (mp_preapproval_id) DO UPDATE SET
        plan             = COALESCE(EXCLUDED.plan, public.mp_preapprovals.plan),
        monto            = COALESCE(EXCLUDED.monto, public.mp_preapprovals.monto),
        frequency        = COALESCE(EXCLUDED.frequency, public.mp_preapprovals.frequency),
        frequency_type   = COALESCE(EXCLUDED.frequency_type, public.mp_preapprovals.frequency_type),
        payer_email      = COALESCE(EXCLUDED.payer_email, public.mp_preapprovals.payer_email),
        status           = COALESCE(EXCLUDED.status, public.mp_preapprovals.status),
        -- true→false permitido; false→true NUNCA
        allow_activation = public.mp_preapprovals.allow_activation AND EXCLUDED.allow_activation,
        cancel_source    = COALESCE(EXCLUDED.cancel_source, public.mp_preapprovals.cancel_source),
        cancelled_at     = COALESCE(EXCLUDED.cancelled_at, public.mp_preapprovals.cancelled_at),
        last_error       = EXCLUDED.last_error,
        last_synced_at   = NOW(),
        updated_at       = NOW()
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.mp_preapproval_registrar(uuid, text, text, numeric, integer, text, text, text, boolean, text, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mp_preapproval_registrar(uuid, text, text, numeric, integer, text, text, text, boolean, text, timestamptz, text) TO service_role;

COMMIT;
