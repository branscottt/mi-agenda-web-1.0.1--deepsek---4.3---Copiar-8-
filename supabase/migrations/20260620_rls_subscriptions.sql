-- ============================================
-- Migration: RLS policies para subscriptions
-- Permite CRUD autenticado en subscriptions
-- ============================================

DROP POLICY IF EXISTS "Permitir lectura de suscripciones" ON public.subscriptions;
DROP POLICY IF EXISTS "Permitir inserción de suscripciones" ON public.subscriptions;
DROP POLICY IF EXISTS "Permitir actualización de suscripciones" ON public.subscriptions;

CREATE POLICY "Permitir lectura de suscripciones" 
  ON public.subscriptions FOR SELECT TO authenticated USING (true);

CREATE POLICY "Permitir inserción de suscripciones" 
  ON public.subscriptions FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Permitir actualización de suscripciones" 
  ON public.subscriptions FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
