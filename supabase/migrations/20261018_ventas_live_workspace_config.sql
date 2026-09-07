-- ============================================================
-- MIGRACIÓN: Ventas Live — config del workspace (nombre y WhatsApp)
-- Fecha: 2026-10-18
--
-- OBJETIVO: permitir al dueño del espacio de Ventas Live ver y
-- cambiar SU nombre y SU número de WhatsApp a cargo, de forma
-- totalmente independiente del proyecto Reservas.
--
--   * vl_workspace_info()      → lee tenants(nombre_negocio, whatsapp)
--     del workspace vl + vl_config (datos_pago, dias_reserva).
--   * vl_actualizar_workspace()→ actualiza SOLO el tenant del
--     proyecto ventas_live del usuario (get_vl_tenant_id) y
--     sincroniza vl_config.whatsapp_negocio. Nunca toca tenants de
--     reservas (cada proyecto guarda su número en su propia fila).
--
-- Autorización: SECURITY DEFINER + get_vl_tenant_id() + is_admin().
-- Sin DO $$. Idempotente.
-- ============================================================

CREATE OR REPLACE FUNCTION public.vl_workspace_info()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_res jsonb;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    SELECT jsonb_build_object(
        'ok', true,
        'nombre_negocio', nombre_negocio,
        'whatsapp', COALESCE(whatsapp, '')
    )
    INTO v_res
    FROM public.tenants
    WHERE id = v_tenant;

    RETURN v_res;
END;
$$;

CREATE OR REPLACE FUNCTION public.vl_actualizar_workspace(
    p_nombre_negocio text DEFAULT NULL,
    p_whatsapp text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_nombre text;
    v_whatsapp text;
    v_whatsapp_raw text;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    -- Nombre ('' o NULL = no tocar)
    v_nombre := NULLIF(btrim(COALESCE(p_nombre_negocio, '')), '');
    IF v_nombre IS NOT NULL AND length(v_nombre) < 2 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El nombre debe tener al menos 2 caracteres');
    END IF;

    -- WhatsApp ('' o NULL = no tocar). Acepta +56 9..., 569..., etc.
    v_whatsapp_raw := btrim(COALESCE(p_whatsapp, ''));
    IF v_whatsapp_raw <> '' THEN
        IF length(regexp_replace(v_whatsapp_raw, '\D', '', 'g')) < 8 THEN
            RETURN jsonb_build_object('ok', false, 'error', 'WhatsApp inválido (mínimo 8 dígitos)');
        END IF;
        v_whatsapp := v_whatsapp_raw;
    END IF;

    UPDATE public.tenants
    SET nombre_negocio = COALESCE(v_nombre, nombre_negocio),
        whatsapp = COALESCE(v_whatsapp, whatsapp)
    WHERE id = v_tenant;

    -- Sincroniza el número "a cargo" en la config del espacio vl
    IF v_whatsapp IS NOT NULL THEN
        INSERT INTO public.vl_config (tenant_id, whatsapp_negocio)
        VALUES (v_tenant, v_whatsapp)
        ON CONFLICT (tenant_id) DO UPDATE
            SET whatsapp_negocio = EXCLUDED.whatsapp_negocio, updated_at = now();
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'nombre_negocio', COALESCE(v_nombre, (SELECT nombre_negocio FROM public.tenants WHERE id = v_tenant)),
        'whatsapp', COALESCE(v_whatsapp, (SELECT whatsapp FROM public.tenants WHERE id = v_tenant))
    );
END;
$$;

REVOKE ALL ON FUNCTION public.vl_workspace_info() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_workspace_info() TO authenticated;

REVOKE ALL ON FUNCTION public.vl_actualizar_workspace(text, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_actualizar_workspace(text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] RPCs de config del workspace OK' AS status;
