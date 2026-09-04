-- ============================================================
-- 20260901_seo_slugs.sql
-- SEO del directorio: URLs amigables por negocio (/p/:slug).
-- 1. Columna slug en tenants (única por negocio, generada del nombre).
-- 2. RPC pública get_tenant_by_slug: resuelve /p/slug → tenant (anon).
-- 3. RPC pública get_slugs_by_ids: slugs de varios tenants (directorio).
-- Seguridad: RPCs SECURITY DEFINER con SELECT EXPLÍCITO de campos
-- públicos (id, nombre_negocio, slug) — NUNCA email ni datos internos.
-- ============================================================

-- 1. Columna slug
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS slug TEXT;

-- 2. Generar slugs para los existentes (normaliza nombre → kebab-case,
--    con sufijo numérico si hay duplicados)
UPDATE public.tenants t
SET slug = s.nuevo_slug
FROM (
    SELECT id,
           base_slug || CASE WHEN rn > 1 THEN '-' || rn ELSE '' END AS nuevo_slug
    FROM (
        SELECT id,
               lower(regexp_replace(regexp_replace(nombre_negocio, '[^a-zA-Z0-9 ]', '', 'g'), ' +', '-', 'g')) AS base_slug,
               row_number() OVER (
                   PARTITION BY lower(regexp_replace(regexp_replace(nombre_negocio, '[^a-zA-Z0-9 ]', '', 'g'), ' +', '-', 'g'))
                   ORDER BY fecha_registro ASC
               ) AS rn
        FROM public.tenants
        WHERE slug IS NULL OR slug = ''
    ) x
) s
WHERE t.id = s.id;

-- 3. Trigger: generar slug automáticamente para nuevos tenants
CREATE OR REPLACE FUNCTION public.generar_slug_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.slug IS NULL OR NEW.slug = '' THEN
        NEW.slug := lower(regexp_replace(regexp_replace(NEW.nombre_negocio, '[^a-zA-Z0-9 ]', '', 'g'), ' +', '-', 'g'));
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenant_slug ON public.tenants;
CREATE TRIGGER trg_tenant_slug
    BEFORE INSERT ON public.tenants
    FOR EACH ROW
    EXECUTE FUNCTION public.generar_slug_tenant();

-- 4. RPC: resolver slug → tenant (pública, campos públicos)
DROP FUNCTION IF EXISTS public.get_tenant_by_slug(TEXT);
CREATE OR REPLACE FUNCTION public.get_tenant_by_slug(p_slug TEXT)
RETURNS TABLE (id UUID, nombre_negocio TEXT, slug TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT id, nombre_negocio, slug
    FROM public.tenants
    WHERE slug = lower(p_slug)
    LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_tenant_by_slug(TEXT) TO anon, authenticated;

-- 5. RPC: slugs de varios tenants (para el directorio, pública)
DROP FUNCTION IF EXISTS public.get_slugs_by_ids(UUID[]);
CREATE OR REPLACE FUNCTION public.get_slugs_by_ids(p_ids UUID[])
RETURNS TABLE (tenant_id UUID, slug TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT id, slug
    FROM public.tenants
    WHERE id = ANY(p_ids)
      AND slug IS NOT NULL
      AND slug <> '';
$$;

GRANT EXECUTE ON FUNCTION public.get_slugs_by_ids(UUID[]) TO anon, authenticated;
