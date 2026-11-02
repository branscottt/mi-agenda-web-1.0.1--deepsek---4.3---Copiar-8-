-- 20261118_mp_preapproval_tracking.sql
-- ============================================================================
-- Registro DURABLE de suscripciones recurrentes (preapproval) de Mercado Pago.
--
-- PROBLEMA QUE RESUELVE (caso umbralis, verificado 2026-11):
--   La Edge Function cancelar-suscripcion buscaba el preapproval SOLO en
--   mercadopago_payments. Si el IPN de MP nunca llegó (o el INSERT falló),
--   no había fila → devolvía {ok:true, mp_cancelled:false} y el superadmin
--   creía que no existía cobro recurrente... mientras MP seguía cobrando
--   el plan Pro todos los meses.
--
--   Además el webhook re-activaba el plan de pago con cada cuota, pisando la
--   decisión del superadmin de dejar la cuenta en freemium.
--
-- DISEÑO:
--   - create-preapproval registra la suscripción AQUÍ en el momento en que
--     MP la crea (no depende del IPN).
--   - allow_activation=false = decisión comercial firme: esa suscripción ya
--     no puede activar/renovar ningún plan de pago. La última decisión manda.
--   - cancelar-suscripcion descubre preapprovals en esta tabla, en
--     mercadopago_payments (legacy) y en la API de MP (por email del pagador),
--     y los registra aquí como desactivados.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.mp_preapprovals (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    mp_preapproval_id   text NOT NULL,
    plan                text,
    monto               numeric,
    frequency           integer,
    frequency_type      text,
    payer_email         text,
    -- pending | authorized | paused | cancelled | finished (estado real en MP)
    status              text NOT NULL DEFAULT 'pending',
    -- false = el superadmin/inquilino canceló: NO puede volver a activar nada
    allow_activation    boolean NOT NULL DEFAULT true,
    cancel_source       text,          -- 'superadmin' | 'inquilino' | 'webhook'
    last_error          text,          -- último error al cancelar en MP (diagnóstico)
    cancelled_at        timestamptz,
    last_synced_at      timestamptz NOT NULL DEFAULT now(),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mp_preapprovals_mp_id_key UNIQUE (mp_preapproval_id),
    CONSTRAINT mp_preapprovals_status_check
        CHECK (status IN ('pending', 'authorized', 'paused', 'cancelled', 'finished'))
);

CREATE INDEX IF NOT EXISTS mp_preapprovals_tenant_idx
    ON public.mp_preapprovals (tenant_id, status);
CREATE INDEX IF NOT EXISTS mp_preapprovals_allow_idx
    ON public.mp_preapprovals (tenant_id, allow_activation);

COMMENT ON TABLE public.mp_preapprovals IS
    'Registro durable de suscripciones recurrentes de Mercado Pago. allow_activation=false significa que la decisión comercial (última) fue no cobrar más.';
COMMENT ON COLUMN public.mp_preapprovals.allow_activation IS
    'false => un cobro rezagado de esta suscripción NO debe activar/renovar planes de pago (la última decisión manda).';

-- Solo el backend (service_role) toca esta tabla. RLS sin políticas + REVOKE.
ALTER TABLE public.mp_preapprovals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mp_preapprovals FROM anon, authenticated;
GRANT ALL ON TABLE public.mp_preapprovals TO service_role;

COMMIT;
