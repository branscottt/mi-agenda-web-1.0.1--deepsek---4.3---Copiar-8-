-- ============================================================
-- Fix definitivo: catálogo anónimo (policy servicios vía SECURITY DEFINER)
-- Fecha: 2026-08-25
-- ============================================================
-- La migración 20260916 intentó validar el tenant activo con un subquery
-- EXISTS sobre `tenants` DENTRO de la policy. Falló en producción: la tabla
-- tenants NO tiene policy de lectura para el rol anon -> el subquery ve 0
-- filas (RLS silencioso) -> el catálogo seguía vacío.
--
-- Solución canónica: función SECURITY DEFINER (se ejecuta con privilegios
-- del owner, sin pasar por el RLS de tenants) usada como predicado de la
-- policy. Devuelve SOLO un booleano: no filtra datos, no expone tenants.

CREATE OR REPLACE FUNCTION public.is_tenant_activo(p_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.tenants t
        WHERE t.id = p_tenant_id AND t.estado = 'activo'
    );
$$;

GRANT EXECUTE ON FUNCTION public.is_tenant_activo(uuid) TO anon, authenticated, public;

DROP POLICY IF EXISTS "Anon puede leer servicios de su tenant" ON public.servicios;

CREATE POLICY "Anon puede leer servicios de su tenant"
ON public.servicios
FOR SELECT
TO public
USING (public.is_tenant_activo(tenant_id));

SELECT 'FIX2: policy servicios via SECURITY DEFINER is_tenant_activo' AS status;
