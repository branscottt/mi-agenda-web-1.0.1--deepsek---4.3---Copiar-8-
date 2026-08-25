-- ============================================================
-- Fix: catálogo anónimo intermitente (RLS dependía del GUC de sesión)
-- Fecha: 2026-08-25
-- ============================================================
-- Problema verificado (2026-08-25, local + prod):
--   La policy anónima de `servicios` filtraba por
--     (tenant_id)::text = current_setting('app.tenant_id', true)
--   El GUC lo fija set_tenant_anon con set_config(..., false) (ámbito de
--   sesión). Con el pooler transaccional de Supabase, la conexión del
--   SELECT siguiente puede caer en OTRO backend sin el GUC -> el catálogo
--   del cliente externo aparece VACÍO de forma intermitente.
--   Evidencia: mismo RPC set_tenant_anon=true -> 1er SELECT = 1 fila,
--   2do SELECT = 0 filas.
--
-- Fix: la policy anónima de servicios NO depende del GUC. Cualquier
-- visitante puede leer el catálogo de tenants ACTIVOS (datos públicos por
-- diseño: el enlace compartido ?tenant=XXX ya expone el tenant_id).
-- El RPC reservar_cita sigue validando server-side tenant activo +
-- pertenencia del servicio + cupos con FOR UPDATE.
-- Las citas (datos sensibles de clientes) NO se tocan: su policy anónima
-- sigue GUC-based (requiere decisión explícita del dueño para cambiarla).

DROP POLICY IF EXISTS "Anon puede leer servicios de su tenant" ON public.servicios;

CREATE POLICY "Anon puede leer servicios de su tenant"
ON public.servicios
FOR SELECT
TO public
USING (
    EXISTS (
        SELECT 1 FROM public.tenants t
        WHERE t.id = public.servicios.tenant_id
          AND t.estado = 'activo'
    )
);

SELECT 'FIX: policy anon de servicios sin dependencia del GUC' AS status;
