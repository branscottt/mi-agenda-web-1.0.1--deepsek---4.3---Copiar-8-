-- ============================================================
-- MIGRACIÓN: Agregar columna duracion a tabla servicios
-- Script lineal, secuencial, sin bloques DO $$.
-- Ejecutar en Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================

-- PASO 1: Agregar columna permitiendo NULL (seguro, no revienta si ya existe)
ALTER TABLE public.servicios 
ADD COLUMN IF NOT EXISTS duracion INTEGER;

-- PASO 2: Poblar registros existentes que quedaron con NULL
UPDATE public.servicios 
SET duracion = 60 
WHERE duracion IS NULL;

-- PASO 3: Forzar restricciones estructurales
ALTER TABLE public.servicios ALTER COLUMN duracion SET DEFAULT 60;
ALTER TABLE public.servicios ALTER COLUMN duracion SET NOT NULL;

-- PASO 4: Recargar caché de PostgREST (API REST de Supabase)
NOTIFY pgrst, 'reload schema';
