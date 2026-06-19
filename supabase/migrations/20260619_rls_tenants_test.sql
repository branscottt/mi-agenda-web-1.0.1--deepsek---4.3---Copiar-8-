-- ============================================
-- Migration: RLS policies para tenents + test mode
-- Permite operaciones CRUD autenticadas en tenents
-- ============================================

-- 1. RLS POLICIES para tenents
DROP POLICY IF EXISTS "Permitir lectura a usuarios autenticados" ON public.tenants;
DROP POLICY IF EXISTS "Permitir inserción a usuarios autenticados" ON public.tenants;
DROP POLICY IF EXISTS "Permitir actualización a usuarios autenticados" ON public.tenants;

CREATE POLICY "Permitir lectura a usuarios autenticados" 
  ON public.tenants FOR SELECT TO authenticated USING (true);

CREATE POLICY "Permitir inserción a usuarios autenticados" 
  ON public.tenants FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Permitir actualización a usuarios autenticados" 
  ON public.tenants FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- 2. Relajar índice único para pruebas (cambiar a no único)
--    En test mode permitimos números repetidos
DROP INDEX IF EXISTS idx_tenants_whatsapp;
CREATE INDEX IF NOT EXISTS idx_tenants_whatsapp_test 
  ON public.tenants (whatsapp) 
  WHERE whatsapp IS NOT NULL AND whatsapp <> '';
