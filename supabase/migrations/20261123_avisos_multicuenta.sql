-- ============================================================================
-- MIGRACIÓN 20261123: AVISOS MULTI-CUENTA en un mismo dispositivo
-- Fecha: 2026-11-02
--
-- CASO REAL: la persona tiene DOS cuentas con correos distintos
--   · srta.muffin@gmail.com     → umbralis (ventas_live) + Umbralis (reservas)
--   · brandoncatalanmura@gmail… → cortaviento (ventas_live) + bran coach (reservas)
-- y quiere recibir los avisos de ambas en el MISMO teléfono / PC.
--
-- La suscripción Web Push es del DISPOSITIVO (una por navegador), no de la
-- cuenta: el mismo `endpoint` puede quedar registrado en varios espacios. El
-- envío es por espacio, así que el dispositivo recibe los avisos de todos los
-- espacios donde esté registrado — y le llegan aunque no tenga ninguna sesión
-- abierta.
--
-- Esta migración amplía `avisos_estado` para que la interfaz sepa:
--   · dispositivos → cuántos equipos tienen avisos para ESTA cuenta (los dos
--     proyectos del mismo correo, uniendo avisos_subs y vl_push_subs)
--   · este         → si ESTE equipo (endpoint) está registrado en ESTA cuenta
--   · otros        → en cuántos OTROS espacios está registrado este equipo
--     (para no romper los avisos de la otra cuenta al apagar en una)
-- Idempotente.
-- ============================================================================

DROP FUNCTION IF EXISTS public.avisos_estado();

CREATE OR REPLACE FUNCTION public.avisos_estado(p_endpoint text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_email text;
    v_n int := 0;
    v_este boolean := false;
    v_otros int := 0;
    v_endpoint text := nullif(btrim(coalesce(p_endpoint, '')), '');
BEGIN
    v_tenant := public.get_user_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin espacio asociado a la cuenta');
    END IF;

    SELECT email_contacto INTO v_email FROM public.tenants WHERE id = v_tenant;

    -- Dispositivos que recibirán los avisos de esta cuenta: los de TODOS los
    -- espacios del mismo correo (reservas + Ventas Live), en las dos tablas.
    WITH familia AS (
        SELECT id FROM public.tenants
        WHERE id = v_tenant
           OR (v_email IS NOT NULL AND btrim(v_email) <> ''
               AND lower(btrim(email_contacto)) = lower(btrim(v_email)))
    ), eq AS (
        SELECT endpoint FROM public.avisos_subs WHERE tenant_id IN (SELECT id FROM familia)
        UNION
        SELECT endpoint FROM public.vl_push_subs WHERE tenant_id IN (SELECT id FROM familia)
    )
    SELECT count(*) INTO v_n FROM eq;

    IF v_endpoint IS NOT NULL THEN
        SELECT EXISTS (
            SELECT 1 FROM public.avisos_subs
            WHERE tenant_id = v_tenant AND endpoint = v_endpoint
            UNION ALL
            SELECT 1 FROM public.vl_push_subs
            WHERE tenant_id = v_tenant AND endpoint = v_endpoint
        ) INTO v_este;

        SELECT count(*) INTO v_otros FROM (
            SELECT tenant_id FROM public.avisos_subs WHERE endpoint = v_endpoint AND tenant_id <> v_tenant
            UNION
            SELECT tenant_id FROM public.vl_push_subs WHERE endpoint = v_endpoint AND tenant_id <> v_tenant
        ) t;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'dispositivos', v_n,
        'email', v_email,
        'este', v_este,
        'otros', v_otros
    );
END;
$$;

REVOKE ALL ON FUNCTION public.avisos_estado(text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.avisos_estado(text) TO authenticated;
