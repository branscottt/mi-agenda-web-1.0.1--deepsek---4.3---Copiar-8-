-- Add social media URL columns to tenant_config
ALTER TABLE public.tenant_config
  ADD COLUMN IF NOT EXISTS instagram_url text,
  ADD COLUMN IF NOT EXISTS tiktok_url text;
