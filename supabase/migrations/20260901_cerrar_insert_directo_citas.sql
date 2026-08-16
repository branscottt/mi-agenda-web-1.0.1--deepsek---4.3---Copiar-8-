-- ============================================================
-- MIGRACIÓN: Cerrar INSERT directo a public.citas (sobreventa)
-- Fecha: 2026-09-01
--
-- PROBLEMA: las policies "Anon puede insertar citas en su tenant"
-- (solo CHECK tenant_id = current_setting('app.tenant_id')) y
-- "Cliente crea citas" (solo CHECK userId = auth.uid() + rol JWT)
-- permiten crear citas vía POST /rest/v1/citas SIN validar cupos
-- ni descontar el cupo del servicio (sobreventa). El trigger de
-- precio (20260823) corrige el precio, pero nadie valida cupos.
-- Además "Cliente actualiza citas futuras" permite mover la cita
-- a un horario agotado vía UPDATE directo (sobreventa por UPDATE).
-- Y la policy del admin usa user_metadata del JWT (manipulable en
-- signUp) en vez de user_roles (fuente de verdad server-side).
--
-- SOLUCIÓN (Opción A): todo INSERT/UPDATE de citas pasa por RPCs
-- SECURITY DEFINER (reservar_cita / reservar_citas_bulk /
-- reagendar_cita) que validan cupos con FOR UPDATE y descuentan.
--   - DROP de las policies INSERT de anon y cliente.
--   - DROP de la policy UPDATE del cliente (sin callers en el
--     frontend; el reagendar ya va por RPC).
--   - REVOKE INSERT (defensa en profundidad; los RPCs corren como
--     definer, no necesitan grant).
--   - Policy del admin endurecida: user_roles (is_admin) en vez de
--     JWT metadata.
--   - Se MANTIENEN: DELETE del cliente (cancelar reserva, exige
--     userId = auth.uid()), SELECT anon (catálogo lee horas
--     ocupadas), SELECT cliente (Mis Reservas), ALL superadmin,
--     y el UPDATE/DELETE del admin vía su policy ALL.
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: DROP de policies INSERT laxas (anon + cliente)
-- ============================================================
DROP POLICY IF EXISTS "Anon puede insertar citas en su tenant" ON public.citas;
DROP POLICY IF EXISTS "Cliente crea citas" ON public.citas;

-- ============================================================
-- PASO 2: DROP de la policy UPDATE del cliente (sobreventa
-- por UPDATE directo; el reagendar legítimo va por RPC)
-- ============================================================
DROP POLICY IF EXISTS "Cliente actualiza citas futuras" ON public.citas;

-- ============================================================
-- PASO 3: REVOKE INSERT a anon/authenticated — defensa en
-- profundidad. Los RPCs reservar_cita/reservar_citas_bulk/
-- reagendar_cita son SECURITY DEFINER (corren como owner) y
-- siguen insertando sin necesidad de grant. El webhook usa
-- service_role. El trigger de precio es SECURITY DEFINER.
-- ============================================================
REVOKE INSERT ON public.citas FROM anon, authenticated;

-- ============================================================
-- PASO 4: Policy del admin — user_roles (is_admin) en vez de
-- user_metadata del JWT (manipulable). Mismo patrón validado en
-- tenants (20260826) y subscriptions (20260823). El admin real
-- está en user_roles (backfill 20260820). ALL conserva su
-- INSERT/UPDATE/DELETE/SELECT del tenant.
-- ============================================================
DROP POLICY IF EXISTS "Admin ve/gestiona citas de su tenant" ON public.citas;
CREATE POLICY "Admin ve/gestiona citas de su tenant" ON public.citas
    FOR ALL TO authenticated
    USING (
        tenant_id = public.get_user_tenant_id()
        AND public.is_admin()
    )
    WITH CHECK (
        tenant_id = public.get_user_tenant_id()
        AND public.is_admin()
    );

-- ============================================================
-- PASO 5: Refresh schema cache + verificación
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '✅ INSERT directo a citas cerrado (anon+cliente); admin por user_roles; RPCs intactos; DELETE cliente/SELECT anon conservados' AS status;
