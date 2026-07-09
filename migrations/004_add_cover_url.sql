-- Migration: Agregar columna cover_url a tenant_config
-- Ejecutar en el SQL Editor de Supabase

ALTER TABLE public.tenant_config ADD COLUMN IF NOT EXISTS cover_url TEXT;

NOTIFY pgrst, 'reload schema';
