-- ============================================================
-- MIGRACIÓN: Feedback / Soporte de tenants
-- Fecha: 2026-09-18
--
-- 1. Tabla tenant_feedback: opiniones, problemas y mejoras que
--    los tenants envían desde el panel admin (widget inferior).
-- 2. RLS: tenant ve/crea sus propios comentarios; superadmin
--    lee, actualiza y elimina todos.
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: Tabla de feedback
-- ============================================================
CREATE TABLE IF NOT EXISTS public.tenant_feedback (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    categoria TEXT NOT NULL DEFAULT 'sugerencia' CHECK (categoria IN ('problema', 'sugerencia', 'mejora', 'otro')),
    mensaje TEXT NOT NULL CHECK (char_length(mensaje) <= 2000),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índice para listado por tenant y por fecha (superadmin lee todos)
CREATE INDEX IF NOT EXISTS idx_tenant_feedback_tenant ON public.tenant_feedback (tenant_id, creado_en DESC);

-- RLS
ALTER TABLE public.tenant_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant ve sus comentarios" ON public.tenant_feedback;
CREATE POLICY "Tenant ve sus comentarios"
    ON public.tenant_feedback FOR SELECT
    TO authenticated
    USING (
        tenant_id = public.get_user_tenant_id()
        OR public.is_super_admin()
    );

DROP POLICY IF EXISTS "Tenant crea sus comentarios" ON public.tenant_feedback;
CREATE POLICY "Tenant crea sus comentarios"
    ON public.tenant_feedback FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.get_user_tenant_id()
    );

DROP POLICY IF EXISTS "Superadmin actualiza comentarios" ON public.tenant_feedback;
CREATE POLICY "Superadmin actualiza comentarios"
    ON public.tenant_feedback FOR UPDATE
    TO authenticated
    USING (public.is_super_admin())
    WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS "Superadmin elimina comentarios" ON public.tenant_feedback;
CREATE POLICY "Superadmin elimina comentarios"
    ON public.tenant_feedback FOR DELETE
    TO authenticated
    USING (public.is_super_admin());

REVOKE ALL ON public.tenant_feedback FROM anon;

-- ============================================================
-- PASO 2: Notify schema cache
-- ============================================================
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- VERIFICACIÓN
-- ============================================================
SELECT '✅ Migración Feedback completada: tabla tenant_feedback + RLS' AS status;
