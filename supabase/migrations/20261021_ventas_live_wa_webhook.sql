-- ============================================================
-- MIGRACIÓN: Ventas Live — Fase 3 WhatsApp (tubería webhook)
-- Fecha: 2026-10-21
--
-- OBJETIVO: habilitar la conexión real con Meta Cloud API.
-- El cerebro del bot (vl_wa_conversacion_avanzar, 20261019-20)
-- ya existe y solo lo llama service_role. Esta migración agrega:
--
--   * vl_config.wa_app_secret → secreto de la app de Meta
--     (valida X-Hub-Signature-256 de los POST del webhook).
--   * vl_guardar_config_wa(...) → RPC admin para guardar los
--     datos de conexión SIN exponerlos al frontend (SECURITY
--     DEFINER; el wizard de la UI lo llama con la sesión del
--     admin; el token NUNCA viaja por el chat ni se devuelve).
--   * vl_wa_conexion_info() → lectura enmascarada para la UI:
--     muestra phone_id / verify_token / estado, pero NUNCA el
--     wa_token ni el app_secret.
--
-- Convenciones: sin DO $$, idempotente, RLS ON sin policies,
-- REVOKE ALL + GRANT específico, dinero numeric(10,2).
-- ============================================================

-- ============================================================
-- PASO 1: columna wa_app_secret en vl_config
-- ============================================================
ALTER TABLE public.vl_config
    ADD COLUMN IF NOT EXISTS wa_app_secret text NOT NULL DEFAULT '';

-- ============================================================
-- PASO 2: RPC guardar conexión WhatsApp (solo admin)
-- wa_estado = 'conectado' cuando hay phone_id + token;
-- los campos vacíos NO pisan los existentes (upsert parcial).
-- ============================================================
CREATE OR REPLACE FUNCTION public.vl_guardar_config_wa(
    p_phone_id text DEFAULT NULL,
    p_token text DEFAULT NULL,
    p_verify_token text DEFAULT NULL,
    p_app_secret text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_phone text;
    v_token text;
    v_verify text;
    v_secret text;
    v_estado text;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    v_phone  := btrim(COALESCE(p_phone_id, ''));
    v_token  := btrim(COALESCE(p_token, ''));
    v_verify := btrim(COALESCE(p_verify_token, ''));
    v_secret := btrim(COALESCE(p_app_secret, ''));

    v_estado := CASE
        WHEN v_phone <> '' AND v_token <> '' THEN 'conectado'
        ELSE 'desconectado'
    END;

    INSERT INTO public.vl_config (tenant_id, wa_phone_id, wa_token, wa_verify_token, wa_app_secret, wa_estado)
    VALUES (v_tenant, v_phone, v_token, v_verify, v_secret, v_estado)
    ON CONFLICT (tenant_id) DO UPDATE SET
        wa_phone_id     = CASE WHEN v_phone  <> '' THEN v_phone  ELSE vl_config.wa_phone_id END,
        wa_token        = CASE WHEN v_token  <> '' THEN v_token  ELSE vl_config.wa_token END,
        wa_verify_token = CASE WHEN v_verify <> '' THEN v_verify ELSE vl_config.wa_verify_token END,
        wa_app_secret   = CASE WHEN v_secret <> '' THEN v_secret ELSE vl_config.wa_app_secret END,
        wa_estado       = CASE
                              WHEN btrim(COALESCE(v_phone, vl_config.wa_phone_id)) <> ''
                               AND btrim(COALESCE(v_token, vl_config.wa_token)) <> ''
                              THEN 'conectado'
                              ELSE 'desconectado'
                          END,
        updated_at = now();

    RETURN jsonb_build_object('ok', true, 'wa_estado', v_estado);
END;
$$;

-- ============================================================
-- PASO 3: RPC estado de conexión (lectura enmascarada)
-- Devuelve datos para la UI del wizard. NUNCA wa_token ni
-- wa_app_secret: solo flags de presencia.
-- ============================================================
CREATE OR REPLACE FUNCTION public.vl_wa_conexion_info()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_cfg public.vl_config%ROWTYPE;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    SELECT * INTO v_cfg FROM public.vl_config WHERE tenant_id = v_tenant;

    RETURN jsonb_build_object(
        'ok', true,
        'wa_phone_id', COALESCE(v_cfg.wa_phone_id, ''),
        'wa_verify_token', COALESCE(v_cfg.wa_verify_token, ''),
        'wa_estado', COALESCE(v_cfg.wa_estado, 'desconectado'),
        'tiene_token', btrim(COALESCE(v_cfg.wa_token, '')) <> '',
        'tiene_app_secret', btrim(COALESCE(v_cfg.wa_app_secret, '')) <> ''
    );
END;
$$;

-- ============================================================
-- PASO 4: Permisos (solo authenticated; nunca anon)
-- ============================================================
REVOKE ALL ON FUNCTION public.vl_guardar_config_wa(text, text, text, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_guardar_config_wa(text, text, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.vl_wa_conexion_info() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_conexion_info() TO authenticated;

-- ============================================================
-- PASO 5: Refresh schema cache + verificación
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] Fase 3 — tubería WhatsApp: config de conexión OK' AS status;
