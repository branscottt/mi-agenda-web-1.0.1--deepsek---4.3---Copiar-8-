-- Migration: Add whatsapp column to tenants table
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS whatsapp TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_whatsapp 
  ON public.tenants (whatsapp) 
  WHERE whatsapp IS NOT NULL AND whatsapp <> '';
