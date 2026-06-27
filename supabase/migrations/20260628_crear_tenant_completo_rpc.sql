-- ============================================
-- Migration: RPC function crear_tenant_completo
-- Crea un tenant con SECURITY DEFINER para
-- bypassear el bloqueo ES256 del API Gateway.
-- ============================================

-- 1. Función RPC que crea tenant + (vía trigger) subscription
--    SECURITY DEFINER: ejecuta con permisos del creador (bypass RLS)
--    search_path explícito: previene inyección de esquemas maliciosos
--    Retorna JSONB para consumo directo del frontend
CREATE OR REPLACE FUNCTION public.crear_tenant_completo(
    p_nombre_negocio TEXT,
    p_email_contacto TEXT,
    p_whatsapp TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant public.tenants%ROWTYPE;
BEGIN
    -- Validar parámetros obligatorios
    IF p_nombre_negocio IS NULL OR trim(p_nombre_negocio) = '' THEN
        RAISE EXCEPTION 'nombre_negocio es requerido';
    END IF;
    IF p_email_contacto IS NULL OR trim(p_email_contacto) = '' THEN
        RAISE EXCEPTION 'email_contacto es requerido';
    END IF;

    -- Insertar tenant (el trigger trg_create_subscription_on_tenant
    -- se ejecutará automáticamente con SECURITY DEFINER también)
    INSERT INTO public.tenants (nombre_negocio, email_contacto, plan, whatsapp)
    VALUES (
        trim(p_nombre_negocio),
        lower(trim(p_email_contacto)),
        NULL,
        NULLIF(trim(COALESCE(p_whatsapp, '')), '')
    )
    RETURNING * INTO v_tenant;

    -- Retornar datos esenciales para el frontend
    RETURN jsonb_build_object(
        'id', v_tenant.id,
        'nombre_negocio', v_tenant.nombre_negocio,
        'email_contacto', v_tenant.email_contacto,
        'whatsapp', v_tenant.whatsapp,
        'plan', v_tenant.plan,
        'fecha_registro', v_tenant.fecha_registro
    );
END;
$$;

-- 2. Otorgar permiso de ejecución al rol anon (necesario para RPC)
GRANT EXECUTE ON FUNCTION public.crear_tenant_completo TO anon, authenticated;
