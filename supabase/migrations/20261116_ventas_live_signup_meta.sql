-- 20261116_ventas_live_signup_meta.sql
--
-- QUÉ HACE
--   Deja la base para el alta automática de WhatsApp por "Conectar con Facebook"
--   (Embedded Signup de Meta): el negocio pone su número y autoriza; el sistema
--   recibe el phone_number_id y el token sin que nadie los escriba a mano.
--
--   1) vl_config guarda el WABA y el business id que devuelve Meta, y cuándo se
--      conectó (wa_signup_en).
--   2) vl_wa_signup_guardar(...): guarda lo que trajo la Edge Function wa-signup.
--      Autoriza con get_vl_tenant_id() + is_admin(), igual que el guardado manual
--      (vl_guardar_config_wa): el navegador NUNCA elige el tenant.
--      Si no había verify_token, genera uno aleatorio.
--   3) vl_wa_signup_info(): lo que el panel puede saber (sin token).
--
-- POR QUÉ
--   Hoy conectar un número obliga a pegar phone_number_id, token, verify token y
--   app secret (imposible para un negocio que solo tiene WhatsApp). Con
--   Embedded Signup esos valores llegan solos desde Meta.
--
-- APLICAR
--   supabase db query --linked -f supabase/migrations/20261116_ventas_live_signup_meta.sql
--   supabase migration repair --status applied 20261116 --linked

ALTER TABLE public.vl_config
    ADD COLUMN IF NOT EXISTS wa_waba_id     text,
    ADD COLUMN IF NOT EXISTS wa_business_id text,
    ADD COLUMN IF NOT EXISTS wa_signup_en   timestamptz;

CREATE OR REPLACE FUNCTION public.vl_wa_signup_guardar(
    p_phone_id text,
    p_token text,
    p_waba_id text,
    p_business_id text DEFAULT NULL,
    p_verify_token text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_phone  text;
    v_token  text;
    v_waba   text;
    v_biz    text;
    v_verify text;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    v_phone := btrim(COALESCE(p_phone_id, ''));
    v_token := btrim(COALESCE(p_token, ''));
    v_waba  := NULLIF(btrim(COALESCE(p_waba_id, '')), '');
    v_biz   := NULLIF(btrim(COALESCE(p_business_id, '')), '');

    IF v_phone = '' OR v_token = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Meta no devolvió el número o el token');
    END IF;

    v_verify := btrim(COALESCE(p_verify_token, ''));
    IF v_verify = '' THEN
        SELECT btrim(COALESCE(wa_verify_token, '')) INTO v_verify
          FROM public.vl_config WHERE tenant_id = v_tenant;
    END IF;
    IF COALESCE(v_verify, '') = '' THEN
        v_verify := encode(gen_random_bytes(12), 'hex');
    END IF;

    INSERT INTO public.vl_config
        (tenant_id, wa_phone_id, wa_token, wa_verify_token, wa_estado,
         wa_waba_id, wa_business_id, wa_signup_en)
    VALUES
        (v_tenant, v_phone, v_token, v_verify, 'conectado',
         v_waba, v_biz, now())
    ON CONFLICT (tenant_id) DO UPDATE SET
        wa_phone_id     = EXCLUDED.wa_phone_id,
        wa_token        = EXCLUDED.wa_token,
        wa_verify_token = EXCLUDED.wa_verify_token,
        wa_estado       = 'conectado',
        wa_waba_id      = COALESCE(EXCLUDED.wa_waba_id, public.vl_config.wa_waba_id),
        wa_business_id  = COALESCE(EXCLUDED.wa_business_id, public.vl_config.wa_business_id),
        wa_signup_en    = now(),
        updated_at      = now();

    RETURN jsonb_build_object(
        'ok', true,
        'tenant_id', v_tenant,
        'phone_id', v_phone,
        'verify_token', v_verify);
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_wa_signup_guardar(text, text, text, text, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_signup_guardar(text, text, text, text, text) TO authenticated, service_role;

-- Lo que el panel puede mostrar de la conexión (nunca el token).
CREATE OR REPLACE FUNCTION public.vl_wa_signup_info()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
    SELECT jsonb_build_object(
        'conectado', COALESCE(c.wa_estado, '') = 'conectado',
        'phone_id', COALESCE(c.wa_phone_id, ''),
        'waba_id', COALESCE(c.wa_waba_id, ''),
        'signup_en', c.wa_signup_en,
        'tiene_token', btrim(COALESCE(c.wa_token, '')) <> '')
      FROM (SELECT public.get_vl_tenant_id() AS tenant_id) t
      LEFT JOIN public.vl_config c ON c.tenant_id = t.tenant_id;
$function$;

REVOKE ALL ON FUNCTION public.vl_wa_signup_info() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_signup_info() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
