-- ============================================================
-- MIGRACIÓN: Estilos de listas por tenant (plantillas reutilizables)
-- Fecha: 2026-09-24
--
-- PROBLEMA: cada tablero de cliente hay que armarlo desde cero.
-- Las pymes que cargan la misma información para muchos clientes
-- necesitan guardar la estructura de listas (plantilla) una vez
-- y reutilizarla en otros clientes con un clic.
--
-- SOLUCIÓN: tabla kanban_estilos — plantillas del tenant con
-- nombre + estructura de listas (con sus tarjetas de ejemplo
-- {titulo, descripcion}) en jsonb. RLS con el mismo patrón del
-- resto de tablas kanban (authenticated + get_user_tenant_id +
-- is_admin).
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.kanban_estilos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    nombre text NOT NULL,
    listas jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kanban_estilos_tenant ON public.kanban_estilos(tenant_id, created_at DESC);

ALTER TABLE public.kanban_estilos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin gestiona estilos de su tenant" ON public.kanban_estilos;
CREATE POLICY "Admin gestiona estilos de su tenant" ON public.kanban_estilos
    FOR ALL TO authenticated
    USING (
        tenant_id = public.get_user_tenant_id()
        AND public.is_admin()
    )
    WITH CHECK (
        tenant_id = public.get_user_tenant_id()
        AND public.is_admin()
    );

-- updated_at automático (función existente set_updated_at)
DROP TRIGGER IF EXISTS trigger_set_updated_at_kanban_estilos ON public.kanban_estilos;
CREATE TRIGGER trigger_set_updated_at_kanban_estilos
    BEFORE UPDATE ON public.kanban_estilos
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

NOTIFY pgrst, 'reload schema';

SELECT '✅ kanban_estilos creada (plantillas de listas por tenant)' AS status;
