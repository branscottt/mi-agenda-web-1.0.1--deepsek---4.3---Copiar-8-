-- ============================================================
-- SECURITY HARDENING — migración completa
-- Ejecutar en Supabase SQL Editor (Dashboard > SQL Editor)
-- Script lineal SECUENCIAL, sin DO $$, idempotente.
-- ============================================================

-- ============================================================
-- PASO 1: Revocar permisos peligrosos de anon/public
-- anon solo debe tener SELECT (lectura pública) e INSERT donde
-- RLS lo permita explícitamente. NUNCA DELETE ni UPDATE.
-- ============================================================

-- Citas: anon solo SELECT e INSERT
REVOKE DELETE ON public.citas FROM anon;
REVOKE UPDATE ON public.citas FROM anon;
REVOKE TRUNCATE ON public.citas FROM anon;
REVOKE REFERENCES ON public.citas FROM anon;
REVOKE TRIGGER ON public.citas FROM anon;

-- Notificaciones: anon NO necesita acceso
REVOKE ALL ON public.notificaciones_admin FROM anon;

-- Servicios: anon solo SELECT
REVOKE DELETE ON public.servicios FROM anon;
REVOKE INSERT ON public.servicios FROM anon;
REVOKE UPDATE ON public.servicios FROM anon;
REVOKE TRUNCATE ON public.servicios FROM anon;
REVOKE REFERENCES ON public.servicios FROM anon;
REVOKE TRIGGER ON public.servicios FROM anon;

-- Subscriptions: anon NO necesita acceso directo
REVOKE ALL ON public.subscriptions FROM anon;

-- Tenant config: anon solo SELECT
REVOKE DELETE ON public.tenant_config FROM anon;
REVOKE INSERT ON public.tenant_config FROM anon;
REVOKE UPDATE ON public.tenant_config FROM anon;
REVOKE TRUNCATE ON public.tenant_config FROM anon;
REVOKE REFERENCES ON public.tenant_config FROM anon;
REVOKE TRIGGER ON public.tenant_config FROM anon;

-- Tenants: anon solo SELECT e INSERT
REVOKE DELETE ON public.tenants FROM anon;
REVOKE UPDATE ON public.tenants FROM anon;
REVOKE TRUNCATE ON public.tenants FROM anon;
REVOKE REFERENCES ON public.tenants FROM anon;
REVOKE TRIGGER ON public.tenants FROM anon;

-- Trabajadores: anon solo SELECT
REVOKE DELETE ON public.trabajadores FROM anon;
REVOKE INSERT ON public.trabajadores FROM anon;
REVOKE UPDATE ON public.trabajadores FROM anon;
REVOKE TRUNCATE ON public.trabajadores FROM anon;
REVOKE REFERENCES ON public.trabajadores FROM anon;
REVOKE TRIGGER ON public.trabajadores FROM anon;

-- Servicios_Trabajadores: anon solo SELECT
REVOKE DELETE ON public.servicios_trabajadores FROM anon;
REVOKE INSERT ON public.servicios_trabajadores FROM anon;
REVOKE UPDATE ON public.servicios_trabajadores FROM anon;
REVOKE TRUNCATE ON public.servicios_trabajadores FROM anon;
REVOKE REFERENCES ON public.servicios_trabajadores FROM anon;
REVOKE TRIGGER ON public.servicios_trabajadores FROM anon;

-- ============================================================
-- PASO 2: CHECK constraints de validación de datos
-- ============================================================

-- 2a. Servicios: precio >= 0, nombre >= 2 chars
ALTER TABLE public.servicios DROP CONSTRAINT IF EXISTS servicios_precio_check;
ALTER TABLE public.servicios ADD CONSTRAINT servicios_precio_check
    CHECK (precio IS NULL OR precio >= 0);

ALTER TABLE public.servicios DROP CONSTRAINT IF EXISTS servicios_nombre_length_check;
ALTER TABLE public.servicios ADD CONSTRAINT servicios_nombre_length_check
    CHECK (length(nombre) >= 2);

-- 2b. Citas: precio >= 0, hora formato HH:MM
ALTER TABLE public.citas DROP CONSTRAINT IF EXISTS citas_precio_check;
ALTER TABLE public.citas ADD CONSTRAINT citas_precio_check
    CHECK (precio IS NULL OR precio >= 0);

ALTER TABLE public.citas DROP CONSTRAINT IF EXISTS citas_hora_format_check;
ALTER TABLE public.citas ADD CONSTRAINT citas_hora_format_check
    CHECK (hora ~ '^([01]\d|2[0-3]):[0-5]\d$');

-- 2c. Trabajadores: nombre >= 2 chars, tipo_jornada valores válidos
ALTER TABLE public.trabajadores DROP CONSTRAINT IF EXISTS trabajadores_nombre_length_check;
ALTER TABLE public.trabajadores ADD CONSTRAINT trabajadores_nombre_length_check
    CHECK (length(nombre) >= 2);

ALTER TABLE public.trabajadores DROP CONSTRAINT IF EXISTS trabajadores_tipo_jornada_check;
ALTER TABLE public.trabajadores ADD CONSTRAINT trabajadores_tipo_jornada_check
    CHECK (tipo_jornada IN ('full_time', 'part_time', '30hrs', 'custom'));

-- 2d. Tenants: email con formato válido, nombre negocio >= 2 chars
ALTER TABLE public.tenants DROP CONSTRAINT IF EXISTS tenants_email_check;
ALTER TABLE public.tenants ADD CONSTRAINT tenants_email_check
    CHECK (email_contacto ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$');

ALTER TABLE public.tenants DROP CONSTRAINT IF EXISTS tenants_nombre_length_check;
ALTER TABLE public.tenants ADD CONSTRAINT tenants_nombre_length_check
    CHECK (length(nombre_negocio) >= 2);

ALTER TABLE public.tenants DROP CONSTRAINT IF EXISTS tenants_plan_check;
ALTER TABLE public.tenants ADD CONSTRAINT tenants_plan_check
    CHECK (plan IN ('freemium', 'pro', 'premium_anual', 'free_trial'));

-- 2e. Subscriptions: plan con valores válidos
ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_plan_check;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_plan_check
    CHECK (plan IN ('freemium', 'pro', 'premium_anual', 'free_trial'));

-- ============================================================
-- PASO 3: Hardening de Storage - Bucket service-images
-- ============================================================

-- 3a. Actualizar bucket con restricciones explícitas
UPDATE storage.buckets
SET
    file_size_limit = 5242880,      -- 5MB
    allowed_mime_types = '{image/jpeg,image/png,image/webp}',
    public = true
WHERE id = 'service-images';

-- 3b. Reemplazar políticas de storage con tenant isolation
DROP POLICY IF EXISTS "Usuarios autenticados pueden subir imágenes de servicio" ON storage.objects;
DROP POLICY IF EXISTS "Usuarios autenticados pueden actualizar imágenes de servicio" ON storage.objects;
DROP POLICY IF EXISTS "Usuarios autenticados pueden eliminar imágenes de servicio" ON storage.objects;

-- INSERT: solo puede subir archivos en su propia carpeta de tenant
CREATE POLICY "Subida con tenant isolation" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'service-images'
        AND (storage.foldername(name))[1] = (
            SELECT (raw_user_meta_data ->> 'tenant_id') FROM auth.users WHERE id = auth.uid()
        )
    );

-- UPDATE: solo puede actualizar archivos de su tenant
CREATE POLICY "Actualización con tenant isolation" ON storage.objects
    FOR UPDATE TO authenticated
    USING (
        bucket_id = 'service-images'
        AND (storage.foldername(name))[1] = (
            SELECT (raw_user_meta_data ->> 'tenant_id') FROM auth.users WHERE id = auth.uid()
        )
    )
    WITH CHECK (
        bucket_id = 'service-images'
        AND (storage.foldername(name))[1] = (
            SELECT (raw_user_meta_data ->> 'tenant_id') FROM auth.users WHERE id = auth.uid()
        )
    );

-- DELETE: solo puede eliminar archivos de su tenant
CREATE POLICY "Eliminación con tenant isolation" ON storage.objects
    FOR DELETE TO authenticated
    USING (
        bucket_id = 'service-images'
        AND (storage.foldername(name))[1] = (
            SELECT (raw_user_meta_data ->> 'tenant_id') FROM auth.users WHERE id = auth.uid()
        )
    );

-- ============================================================
-- PASO 4: Fix usuarios_con_rol — solo SELECT para anon
-- ============================================================
REVOKE DELETE ON public.usuarios_con_rol FROM anon;
REVOKE INSERT ON public.usuarios_con_rol FROM anon;
REVOKE UPDATE ON public.usuarios_con_rol FROM anon;
REVOKE TRUNCATE ON public.usuarios_con_rol FROM anon;
REVOKE REFERENCES ON public.usuarios_con_rol FROM anon;
REVOKE TRIGGER ON public.usuarios_con_rol FROM anon;

-- ============================================================
-- PASO 5: Fix set_tenant() — agregar search_path explícito
-- Antes era NULL (usa default $user, public) → vulnerable
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_tenant(tenant_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    PERFORM set_config('app.tenant_id', tenant_id, false);
END;
$function$;

-- ============================================================
-- PASO 6: Corregir vulnerabilidad CRÍTICA — set_tenant accesible por anon
-- anon podía llamar set_tenant() y establecer app.tenant_id a cualquier UUID
-- permitiendo acceder a datos de otros tenants
-- ============================================================

-- 6a. Crear versión SEGURA para anon que valida que el tenant exista y esté activo
CREATE OR REPLACE FUNCTION public.set_tenant_anon(p_tenant_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    -- Validar que el tenant existe y está activo
    IF EXISTS (SELECT 1 FROM public.tenants WHERE id = p_tenant_id::uuid AND estado = 'activo') THEN
        PERFORM set_config('app.tenant_id', p_tenant_id, false);
        RETURN true;
    END IF;
    RETURN false;
EXCEPTION
    WHEN others THEN
        RETURN false;
END;
$function$;

-- 6b. Revocar set_tenant de anon (solo authenticated)
REVOKE EXECUTE ON FUNCTION public.set_tenant FROM anon, public;
GRANT EXECUTE ON FUNCTION public.set_tenant TO authenticated;

-- 6c. Otorgar set_tenant_anon a anon (la versión segura)
GRANT EXECUTE ON FUNCTION public.set_tenant_anon TO anon, public;

-- 6d. Revocar funciones SECURITY DEFINER peligrosas de anon
REVOKE EXECUTE ON FUNCTION public.create_initial_subscription FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.get_all_users_for_superadmin FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable FROM anon, public;
GRANT EXECUTE ON FUNCTION public.create_initial_subscription TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_all_users_for_superadmin TO authenticated;
GRANT EXECUTE ON FUNCTION public.rls_auto_enable TO authenticated;

-- ============================================================
-- PASO 7: Refresh schema cache
-- ============================================================
NOTIFY pgrst, 'reload schema';
