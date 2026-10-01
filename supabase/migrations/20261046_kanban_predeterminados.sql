-- ============================================================
-- 20261046_kanban_predeterminados.sql
-- "PREDETERMINADOS" del tablero (Mis Clientes → Información del cliente)
--
-- Qué resuelve: la información REPETITIVA que se le pide a TODOS los clientes
-- (anamnesis, tabla de ejercicios, datos importantes del alumno...). El negocio
-- arma esas listas UNA vez, las guarda como predeterminadas y la web las pone
-- sola en el tablero de cada cliente —nuevo o existente— en blanco, listas
-- para rellenar. Si no le sirven para alguien, las borra de ese cliente sin
-- afectar a los demás.
--
-- Una fila por negocio (UNIQUE tenant_id). `contenido` guarda la estructura:
--   { "listas": [ { "titulo": "...", "compartida": false,
--                   "tarjetas": [ { "titulo": "...", "descripcion": "",
--                                   "checklist": [ "pregunta 1", "..." ] } ] } ] }
-- `auto_aplicar` = se aplica sola cuando se crea el tablero de un cliente nuevo.
--
-- RLS: mismo patrón que kanban_estilos (tenant + is_admin()).
-- Script lineal, idempotente, sin DO $$.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.kanban_predeterminados (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    nombre text NOT NULL DEFAULT 'Predeterminados',
    contenido jsonb NOT NULL DEFAULT '{"listas": []}'::jsonb,
    auto_aplicar boolean NOT NULL DEFAULT true,
    aplicado_en timestamptz,
    aplicado_a integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_kanban_predeterminados_tenant
    ON public.kanban_predeterminados (tenant_id);

DROP TRIGGER IF EXISTS trigger_set_updated_at_kanban_predeterminados ON public.kanban_predeterminados;
CREATE TRIGGER trigger_set_updated_at_kanban_predeterminados
    BEFORE UPDATE ON public.kanban_predeterminados
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.kanban_predeterminados ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin gestiona los predeterminados de su tenant" ON public.kanban_predeterminados;
CREATE POLICY "Admin gestiona los predeterminados de su tenant" ON public.kanban_predeterminados
    FOR ALL TO authenticated
    USING (
        tenant_id = public.get_user_tenant_id()
        AND public.is_admin()
    )
    WITH CHECK (
        tenant_id = public.get_user_tenant_id()
        AND public.is_admin()
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.kanban_predeterminados TO authenticated;

SELECT '[KANBAN PREDETERMINADOS] tabla + RLS + trigger listos' AS status;
