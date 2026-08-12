-- ============================================================
-- MIGRACIÓN: Authorization server-side — user_roles
-- Fecha: 2026-08-20
--
-- PROBLEMA: toda la autorización (rol + tenant_id) se lee del
-- JWT user_metadata, que el propio usuario puede reescribir con
-- auth.updateUser(). Eso permite:
--   - auto-asignarse 'admin' + tenant_id ajeno (el UUID sale del
--     link público cliente.html?tenant=...) → control total del
--     negocio víctima (citas, servicios, suscripciones, config).
--   - auto-asignarse 'super_admin' → control total del sistema
--     (dump de usuarios, cambio de roles, borrado de cuentas).
--
-- SOLUCIÓN: tabla user_roles como fuente de verdad NO manipulable
-- (sin grants para anon/authenticated/public). Las funciones
-- is_super_admin() y get_user_tenant_id() — usadas por TODAS las
-- policies RLS — pasan a leer de esa tabla. Cero cambios en las
-- policies existentes.
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: Tabla user_roles + blindaje de acceso
-- ============================================================
CREATE TABLE IF NOT EXISTS public.user_roles (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    rol TEXT NOT NULL CHECK (rol IN ('cliente', 'admin', 'trabajador', 'super_admin')),
    tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Nadie la lee/escribe directo: solo funciones SECURITY DEFINER
REVOKE ALL ON public.user_roles FROM anon;
REVOKE ALL ON public.user_roles FROM authenticated;
REVOKE ALL ON public.user_roles FROM public;

-- ============================================================
-- PASO 2: Poblar desde auth.users existentes (sin romper logins)
-- Los admins/superadmins actuales conservan su acceso el día 1.
-- LEFT JOIN contra tenants: si el tenant_id de la metadata apunta
-- a un tenant inexistente (borrado), se asigna NULL (rol intacto)
-- en vez de violar la FK y abortar toda la migración.
-- ============================================================
INSERT INTO public.user_roles (user_id, rol, tenant_id)
SELECT
    u.id,
    COALESCE(NULLIF(u.raw_user_meta_data->>'rol', ''), 'cliente'),
    t.id
FROM auth.users u
LEFT JOIN public.tenants t
    ON t.id::text = u.raw_user_meta_data->>'tenant_id'
ON CONFLICT (user_id) DO NOTHING;

-- ============================================================
-- PASO 3: Redefinir funciones de autorización → user_roles
-- (SECURITY DEFINER + search_path fijo; auth.uid() sigue
--  viniendo del JWT del request, no es manipulable)
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = auth.uid() AND rol = 'super_admin'
    )
$$;

CREATE OR REPLACE FUNCTION public.get_user_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT tenant_id FROM public.user_roles WHERE user_id = auth.uid()
$$;

-- ============================================================
-- PASO 4: crear_tenant_completo — registrar el rol server-side
-- del nuevo admin (hasta ahora solo se escribía en metadata,
-- que es manipulable).
-- ============================================================
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
    IF p_nombre_negocio IS NULL OR trim(p_nombre_negocio) = '' THEN
        RAISE EXCEPTION 'nombre_negocio es requerido';
    END IF;
    IF p_email_contacto IS NULL OR trim(p_email_contacto) = '' THEN
        RAISE EXCEPTION 'email_contacto es requerido';
    END IF;

    INSERT INTO public.tenants (nombre_negocio, email_contacto, plan, whatsapp)
    VALUES (
        trim(p_nombre_negocio),
        lower(trim(p_email_contacto)),
        NULL,
        NULLIF(trim(COALESCE(p_whatsapp, '')), '')
    )
    RETURNING * INTO v_tenant;

    -- Registro de autorización server-side (inmune a manipulación)
    INSERT INTO public.user_roles (user_id, rol, tenant_id)
    VALUES (auth.uid(), 'admin', v_tenant.id)
    ON CONFLICT (user_id) DO UPDATE SET rol = 'admin', tenant_id = v_tenant.id;

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

-- Solo authenticated (el flujo de alta siempre está autenticado)
REVOKE EXECUTE ON FUNCTION public.crear_tenant_completo(TEXT, TEXT, TEXT) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.crear_tenant_completo(TEXT, TEXT, TEXT) TO authenticated;

-- ============================================================
-- PASO 5: actualizar_rol_usuario — sincronizar user_roles
-- ============================================================
CREATE OR REPLACE FUNCTION public.actualizar_rol_usuario(p_user_id UUID, p_rol TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
    IF NOT public.is_super_admin() THEN
        RAISE EXCEPTION 'Acceso denegado: solo super-admin';
    END IF;

    IF p_rol NOT IN ('cliente', 'admin', 'trabajador', 'super_admin') THEN
        RAISE EXCEPTION 'Rol inválido: %', p_rol;
    END IF;

    UPDATE auth.users
    SET raw_user_meta_data = jsonb_set(
            COALESCE(raw_user_meta_data, '{}'::jsonb),
            '{rol}',
            to_jsonb(p_rol)
        )
    WHERE id = p_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Usuario no encontrado';
    END IF;

    -- Sincronizar fuente de autorización server-side
    INSERT INTO public.user_roles (user_id, rol, tenant_id)
    VALUES (p_user_id, p_rol, (SELECT tenant_id FROM public.user_roles WHERE user_id = p_user_id))
    ON CONFLICT (user_id) DO UPDATE SET rol = EXCLUDED.rol;

    RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.actualizar_rol_usuario(UUID, TEXT) TO authenticated;

-- ============================================================
-- PASO 6: RPC whatsapp_en_uso — consulta de disponibilidad sin
-- exponer datos de otros negocios (reemplaza el SELECT directo
-- por número que usaba el flujo de vinculación legacy).
-- ============================================================
CREATE OR REPLACE FUNCTION public.whatsapp_en_uso(p_whatsapp TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
    IF p_whatsapp IS NULL OR trim(p_whatsapp) = '' THEN
        RETURN false;
    END IF;
    RETURN EXISTS (
        SELECT 1 FROM public.tenants
        WHERE whatsapp = trim(p_whatsapp)
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.whatsapp_en_uso(TEXT) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.whatsapp_en_uso(TEXT) TO authenticated;

-- ============================================================
-- PASO 7: Notificaciones — INSERT validado
-- Antes: WITH CHECK (true) → cualquier authenticated podía
-- inyectar notificaciones con el tenant_id de cualquier negocio
-- (spam/phishing al admin).
-- Ahora: solo si es admin del tenant O existe la cita referida.
-- ============================================================
DROP POLICY IF EXISTS "Sistema crea notificaciones" ON public.notificaciones_admin;
CREATE POLICY "Notificaciones validas" ON public.notificaciones_admin
    FOR INSERT TO authenticated
    WITH CHECK (
        tenant_id = public.get_user_tenant_id()
        OR EXISTS (
            SELECT 1 FROM public.citas c
            WHERE c.id = cita_id AND c.tenant_id = tenant_id
        )
    );

-- Fix de funcionalidad latente: no existía policy UPDATE para admin
-- (marcarComoLeido / badge de notificaciones fallaba silenciosamente).
DROP POLICY IF EXISTS "Admin actualiza notificaciones de su tenant" ON public.notificaciones_admin;
CREATE POLICY "Admin actualiza notificaciones de su tenant" ON public.notificaciones_admin
    FOR UPDATE TO authenticated
    USING (
        tenant_id = public.get_user_tenant_id()
        AND ((((auth.jwt() ->> 'user_metadata')::jsonb) ->> 'rol')::text) = 'admin'
    )
    WITH CHECK (
        tenant_id = public.get_user_tenant_id()
        AND ((((auth.jwt() ->> 'user_metadata')::jsonb) ->> 'rol')::text) = 'admin'
    );

-- ============================================================
-- PASO 8: Storage — tenant isolation vía user_roles (no metadata)
-- ============================================================
DROP POLICY IF EXISTS "Subida con tenant isolation" ON storage.objects;
CREATE POLICY "Subida con tenant isolation" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'service-images'
        AND (storage.foldername(name))[1] = public.get_user_tenant_id()::text
    );

DROP POLICY IF EXISTS "Actualización con tenant isolation" ON storage.objects;
CREATE POLICY "Actualización con tenant isolation" ON storage.objects
    FOR UPDATE TO authenticated
    USING (
        bucket_id = 'service-images'
        AND (storage.foldername(name))[1] = public.get_user_tenant_id()::text
    )
    WITH CHECK (
        bucket_id = 'service-images'
        AND (storage.foldername(name))[1] = public.get_user_tenant_id()::text
    );

DROP POLICY IF EXISTS "Eliminación con tenant isolation" ON storage.objects;
CREATE POLICY "Eliminación con tenant isolation" ON storage.objects
    FOR DELETE TO authenticated
    USING (
        bucket_id = 'service-images'
        AND (storage.foldername(name))[1] = public.get_user_tenant_id()::text
    );

-- ============================================================
-- PASO 9: Refresh schema cache + verificación
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '[AUTHZ] user_roles creada; autorización redirigida a tabla server-side' AS status;
