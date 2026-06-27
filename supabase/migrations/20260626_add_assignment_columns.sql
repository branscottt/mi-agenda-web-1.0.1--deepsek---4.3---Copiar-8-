-- ============================================================
-- MIGRACIÓN: Agregar columnas de asignación de módulos a servicios
-- Columnas: assignment_mode, weekday_modules, date_specific_modules, module_date_cupos
-- Script lineal, sin DO $$, secuencial, idempotente.
-- Ejecutar en Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================

-- 1. assignment_mode: TEXT, default 'all', NOT NULL
ALTER TABLE public.servicios ADD COLUMN IF NOT EXISTS assignment_mode TEXT;
UPDATE public.servicios SET assignment_mode = 'all' WHERE assignment_mode IS NULL;
ALTER TABLE public.servicios ALTER COLUMN assignment_mode SET DEFAULT 'all';
ALTER TABLE public.servicios ALTER COLUMN assignment_mode SET NOT NULL;

-- 2. weekday_modules: JSONB, default '{}', NOT NULL
ALTER TABLE public.servicios ADD COLUMN IF NOT EXISTS weekday_modules JSONB;
UPDATE public.servicios SET weekday_modules = '{}'::jsonb WHERE weekday_modules IS NULL;
ALTER TABLE public.servicios ALTER COLUMN weekday_modules SET DEFAULT '{}'::jsonb;
ALTER TABLE public.servicios ALTER COLUMN weekday_modules SET NOT NULL;

-- 3. date_specific_modules: JSONB, default '{}', NOT NULL
ALTER TABLE public.servicios ADD COLUMN IF NOT EXISTS date_specific_modules JSONB;
UPDATE public.servicios SET date_specific_modules = '{}'::jsonb WHERE date_specific_modules IS NULL;
ALTER TABLE public.servicios ALTER COLUMN date_specific_modules SET DEFAULT '{}'::jsonb;
ALTER TABLE public.servicios ALTER COLUMN date_specific_modules SET NOT NULL;

-- 4. module_date_cupos: JSONB, default '{}', NOT NULL
ALTER TABLE public.servicios ADD COLUMN IF NOT EXISTS module_date_cupos JSONB;
UPDATE public.servicios SET module_date_cupos = '{}'::jsonb WHERE module_date_cupos IS NULL;
ALTER TABLE public.servicios ALTER COLUMN module_date_cupos SET DEFAULT '{}'::jsonb;
ALTER TABLE public.servicios ALTER COLUMN module_date_cupos SET NOT NULL;

-- 5. Recargar caché de PostgREST (API REST de Supabase)
NOTIFY pgrst, 'reload schema';
