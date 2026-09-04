-- ============================================================
-- MIGRACIÓN: RPC pública de reseñas por pyme (get_resenas_pyme)
-- Fecha: 2026-10-08
--
-- PROBLEMA: la página pública del negocio (/p/:slug → cliente.html)
-- y el directorio público necesitan leer las reseñas APROBADAS de
-- UNA pyme concreta. get_directorio_pymes() devuelve el listado
-- completo con resumen agregado (máx 5 por pyme) y es costoso para
-- una vista individual; además expone el tenant_id de todas.
--
-- SOLUCIÓN: RPC SECURITY DEFINER de lectura whitelist (anon):
--   get_resenas_pyme(p_tenant_id) -> reseñas aprobadas de la pyme,
--   solo si la pyme sigue participando en el directorio público
--   (directorio_activo = true), consistente con el resto del módulo.
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_resenas_pyme(p_tenant_id uuid)
RETURNS TABLE(
    nombre_cliente text,
    puntuacion integer,
    comentario text,
    creado_en timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $function$
BEGIN
    RETURN QUERY
    SELECT r.nombre_cliente, r.puntuacion, r.comentario, r.creado_en
    FROM public.pyme_resenas r
    WHERE r.tenant_id = p_tenant_id
      AND r.estado = 'aprobado'
      AND EXISTS (
          SELECT 1 FROM public.tenant_config tc
          WHERE tc.tenant_id = r.tenant_id
            AND tc.directorio_activo = true
      )
    ORDER BY r.creado_en DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_resenas_pyme(uuid) TO anon, public;
