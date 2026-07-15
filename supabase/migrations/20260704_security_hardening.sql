-- ============================================================
-- MIGRACIÓN: Security Hardening
-- 1. Revocar permisos peligrosos de anon
-- 2. CHECK constraints de validación de datos
-- 3. Hardening de políticas de storage (tenant isolation)
-- Script lineal SECUENCIAL, sin DO $$, idempotente.
-- Ejecutar en Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================

-- ============================================================
-- PASO 1: Revocar permisos peligrosos de anon/public
-- anon solo debe tener SELECT (lectura pública) e INSERT cuando
-- RLS lo permita explícitamente. NUNCA DELETE ni UPDATE.
-- ============================================================

-- Citas: anon solo SELECT (público puede ver) e INSERT (para agendar desde portal)
REVOKE DELETE ON public.citas FROM anon;
REVOKE UPDATE ON public.citas FROM anon;
REVOKE TRUNCATE ON public.citas FROM anon;
REVOKE REFERENCES ON public.citas FROM anon;
REVOKE TRIGGER ON public.citas FROM anon;

-- Notificaciones: anon NO necesita acceso
REVOKE ALL ON public.notificaciones_admin FROM anon;

-- Servicios: anon solo SELECT (catálogo público)
REVOKE DELETE ON public.servicios FROM anon;
REVOKE INSERT ON public.servicios FROM anon;
REVOKE UPDATE ON public.servicios FROM anon;
REVOKE TRUNCATE ON public.servicios FROM anon;
REVOKE REFERENCES ON public.servicios FROM anon;
REVOKE TRIGGER ON public.servicios FROM anon;

-- Subscriptions: anon NO necesita acceso directo
REVOKE ALL ON public.subscriptions FROM anon;

-- Tenant config: anon solo SELECT (config visual pública)
REVOKE DELETE ON public.tenant_config FROM anon;
REVOKE INSERT ON public.tenant_config FROM anon;
REVOKE UPDATE ON public.tenant_config FROM anon;
REVOKE TRUNCATE ON public.tenant_config FROM anon;
REVOKE REFERENCES ON public.tenant_config FROM anon;
REVOKE TRIGGER ON public.tenant_config FROM anon;

-- Tenants: anon solo SELECT e INSERT (registro de nuevo negocio)
REVOKE DELETE ON public.tenants FROM anon;
REVOKE UPDATE ON public.tenants FROM anon;
REVOKE TRUNCATE ON public.tenants FROM anon;
REVOKE REFERENCES ON public.tenants FROM anon;
REVOKE TRIGGER ON public.tenants FROM anon;

-- Trabajadores: anon solo SELECT (para portal trabajador y vista cliente)
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

-- 2a. Servicios: precio debe ser >= 0, nombre con largo mínimo
ALTER TABLE public.servicios DROP CONSTRAINT IF EXISTS servicios_precio_check;
ALTER TABLE public.servicios ADD CONSTRAINT servicios_precio_check
    CHECK (precio IS NULL OR precio >= 0);

ALTER TABLE public.servicios DROP CONSTRAINT IF EXISTS servicios_nombre_length_check;
ALTER TABLE public.servicios ADD CONSTRAINT servicios_nombre_length_check
    CHECK (length(nombre) >= 2);

-- 2b. Citas: precio >= 0, hora con formato válido HH:MM
ALTER TABLE public.citas DROP CONSTRAINT IF EXISTS citas_precio_check;
ALTER TABLE public.citas ADD CONSTRAINT citas_precio_check
    CHECK (precio IS NULL OR precio >= 0);

ALTER TABLE public.citas DROP CONSTRAINT IF EXISTS citas_hora_format_check;
ALTER TABLE public.citas ADD CONSTRAINT citas_hora_format_check
    CHECK (hora ~ '^([01]\d|2[0-3]):[0-5]\d$');

-- 2c. Trabajadores: nombre con largo mínimo, tipo_jornada con valores válidos
ALTER TABLE public.trabajadores DROP CONSTRAINT IF EXISTS trabajadores_nombre_length_check;
ALTER TABLE public.trabajadores ADD CONSTRAINT trabajadores_nombre_length_check
    CHECK (length(nombre) >= 2);

ALTER TABLE public.trabajadores DROP CONSTRAINT IF EXISTS trabajadores_tipo_jornada_check;
ALTER TABLE public.trabajadores ADD CONSTRAINT trabajadores_tipo_jornada_check
    CHECK (tipo_jornada IN ('full_time', 'part_time', '30hrs', 'custom'));

-- 2d. Tenants: email_contacto con formato válido, nombre_negocio con largo mínimo
ALTER TABLE public.tenants DROP CONSTRAINT IF EXISTS tenants_email_check;
ALTER TABLE public.tenants ADD CONSTRAINT tenants_email_check
    CHECK (email_contacto ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$');

ALTER TABLE public.tenants DROP CONSTRAINT IF EXISTS tenants_nombre_length_check;
ALTER TABLE public.tenants ADD CONSTRAINT tenants_nombre_length_check
    CHECK (length(nombre_negocio) >= 2);

ALTER TABLE public.tenants DROP CONSTRAINT IF EXISTS tenants_plan_check;
ALTER TABLE public.tenants ADD CONSTRAINT tenants_plan_check
    CHECK (plan IN ('freemium', 'pro', 'premium_anual', 'free_trial'));

-- 2e. Subscriptions: actualizar constraint existente para incluir free_trial (ya hecho en migration previa)
-- Solo aseguramos que exista
ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_plan_check;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_plan_check
    CHECK (plan IN ('freemium', 'pro', 'premium_anual', 'free_trial'));

-- ============================================================
-- PASO 3: Hardening de Storage - Bucket service-images
-- ============================================================

-- 3a. Actualizar bucket con restricciones explícitas (idempotente)
UPDATE storage.buckets
SET
    file_size_limit = 5242880,      -- 5MB (reducido de 10MB)
    allowed_mime_types = '{image/jpeg,image/png,image/webp}',
    public = true
WHERE id = 'service-images';

-- 3b. Reemplazar políticas de storage con tenant isolation
DROP POLICY IF EXISTS "Usuarios autenticados pueden subir imágenes de servicio" ON storage.objects;
DROP POLICY IF EXISTS "Usuarios autenticados pueden actualizar imágenes de servicio" ON storage.objects;
DROP POLICY IF EXISTS "Usuarios autenticados pueden eliminar imágenes de servicio" ON storage.objects;

-- Política de INSERT con tenant isolation: solo puede subir archivos en su propia carpeta
CREATE POLICY "Subida con tenant isolation" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'service-images'
        AND (storage.foldername(name))[1] = (SELECT (raw_user_meta_data ->> 'tenant_id') FROM auth.users WHERE id = auth.uid())
    );

-- Política de UPDATE con tenant isolation
CREATE POLICY "Actualización con tenant isolation" ON storage.objects
    FOR UPDATE TO authenticated
    USING (
        bucket_id = 'service-images'
        AND (storage.foldername(name))[1] = (SELECT (raw_user_meta_data ->> 'tenant_id') FROM auth.users WHERE id = auth.uid())
    )
    WITH CHECK (
        bucket_id = 'service-images'
        AND (storage.foldername(name))[1] = (SELECT (raw_user_meta_data ->> 'tenant_id') FROM auth.users WHERE id = auth.uid())
    );

-- Política de DELETE con tenant isolation
CREATE POLICY "Eliminación con tenant isolation" ON storage.objects
    FOR DELETE TO authenticated
    USING (
        bucket_id = 'service-images'
        AND (storage.foldername(name))[1] = (SELECT (raw_user_meta_data ->> 'tenant_id') FROM auth.users WHERE id = auth.uid())
    );

-- SELECT público se mantiene (las imágenes se muestran en cards públicas)
-- Policy existente: "Cualquiera puede leer imágenes de servicio"

-- ============================================================
-- PASO 4: Refresh schema cache
-- ============================================================
NOTIFY pgrst, 'reload schema';
