-- ============================================================================
-- MIGRACIÓN 20261078: Ventas Live — suscripciones de NOTIFICACIÓN PUSH (Web Push)
-- Fecha: 2026-10-11
--
-- OBJETIVO: que al dueño le llegue una notificación al teléfono/PC aunque tenga
-- la web CERRADA, cuando el bot avisa "contesta tú" (o deja cualquier aviso).
-- Web Push es gratuito (usa el servicio de push del propio navegador; VAPID no
-- cuesta). Esta tabla guarda la suscripción de cada dispositivo.
--
--   * RLS habilitado, SIN policies y SIN grants → solo las RPC SECURITY DEFINER
--     (y service_role desde la Edge Function wa-push) la tocan.
--   * endpoint es único (un mismo dispositivo se re-registra sin duplicar).
-- Idempotente. No toca nada del proyecto 'reservas'.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.vl_push_subs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    user_id uuid,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    creado_en timestamptz NOT NULL DEFAULT now(),
    visto_en timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT vl_push_subs_endpoint_uk UNIQUE (endpoint)
);

ALTER TABLE public.vl_push_subs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.vl_push_subs FROM anon, authenticated, public;

CREATE INDEX IF NOT EXISTS idx_vl_push_subs_tenant ON public.vl_push_subs (tenant_id);

-- ── Guardar / actualizar la suscripción del dispositivo del admin ────────────
CREATE OR REPLACE FUNCTION public.vl_push_guardar(
    p_endpoint text,
    p_p256dh text,
    p_auth text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;
    IF btrim(COALESCE(p_endpoint, '')) = ''
       OR btrim(COALESCE(p_p256dh, '')) = ''
       OR btrim(COALESCE(p_auth, '')) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Suscripción incompleta');
    END IF;

    INSERT INTO public.vl_push_subs (tenant_id, user_id, endpoint, p256dh, auth)
    VALUES (v_tenant, auth.uid(), btrim(p_endpoint), btrim(p_p256dh), btrim(p_auth))
    ON CONFLICT (endpoint) DO UPDATE
        SET tenant_id = EXCLUDED.tenant_id,
            user_id = EXCLUDED.user_id,
            p256dh = EXCLUDED.p256dh,
            auth = EXCLUDED.auth,
            visto_en = now();

    RETURN jsonb_build_object('ok', true);
END;
$$;

-- ── Borrar la suscripción (al apagar los avisos) ─────────────────────────────
CREATE OR REPLACE FUNCTION public.vl_push_borrar(p_endpoint text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_n int;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    WITH del AS (
        DELETE FROM public.vl_push_subs
        WHERE tenant_id = v_tenant AND endpoint = btrim(COALESCE(p_endpoint, ''))
        RETURNING 1
    )
    SELECT count(*) INTO v_n FROM del;
    RETURN jsonb_build_object('ok', true, 'borrados', v_n);
END;
$$;

REVOKE ALL ON FUNCTION public.vl_push_guardar(text, text, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_push_guardar(text, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.vl_push_borrar(text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_push_borrar(text) TO authenticated;
