-- ============================================================
-- MIGRACIÓN: Precio server-side — Fase 1 (solo SQL, sin frontend)
-- Fecha: 2026-08-23
--
-- PROBLEMA 1 (citas): el RLS permite INSERT/UPDATE directo a
-- public.citas con `precio` controlado por el cliente/anon
-- (policies "Cliente crea citas", "Cliente actualiza citas
-- futuras", "Anon puede insertar citas en su tenant" solo
-- validan userId/tenant, NUNCA el precio). Un atacante puede
-- reservar con precio 0 o reescribir el precio de su cita.
--
-- SOLUCIÓN 1: trigger BEFORE INSERT OR UPDATE que, para roles
-- NO-admin (cliente/anon/trabajador, leídos de user_roles — la
-- fuente de verdad server-side de 20260820), sobreescribe
-- SIEMPRE NEW.precio con el precio del servicio (server-side)
-- y valida que el servicio pertenezca al tenant de la cita.
-- El admin conserva su control total del precio (policy
-- "Admin ve/gestiona citas de su tenant" intacta).
--
-- PROBLEMA 2 (subscriptions): policies laxas de 20260620
-- ("Permitir inserción/actualización/lectura de suscripciones"
-- con WITH CHECK true) + grants a authenticated permiten a
-- CUALQUIER usuario autenticado crear/activar suscripciones
-- premium con monto 0 sin pagar, o editar monto/end_date.
-- El webhook de MP valida montos, pero el atacante no necesita
-- pasar por MP.
--
-- SOLUCIÓN 2:
--   INSERT: solo auto-registro de free_trial (plan gratis) del
--           propio tenant, monto NULL o 0. Planes de pago solo
--           los activa activar_suscripcion_post_pago (service_role).
--   UPDATE: solo cancelar (status -> inactive) o downgrade a
--           freemium, por el admin del propio tenant (user_roles).
--   SELECT: queda "Admin ve sus suscripciones" + "Super admin
--           todo en subscriptions" (is_super_admin()).
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: DROP de las policies laxas de subscriptions (20260620)
-- ============================================================
DROP POLICY IF EXISTS "Permitir inserción de suscripciones" ON public.subscriptions;
DROP POLICY IF EXISTS "Permitir actualización de suscripciones" ON public.subscriptions;
DROP POLICY IF EXISTS "Permitir lectura de suscripciones" ON public.subscriptions;

-- La policy UPDATE restrictiva de 20260509 usaba rol del JWT
-- metadata (manipulable). Se reemplaza por una que lee user_roles.
DROP POLICY IF EXISTS "Admin actualiza su suscripción" ON public.subscriptions;

-- ============================================================
-- PASO 2: Helper de autorización para policies (las policies RLS
-- NO corren con SECURITY DEFINER: no pueden leer user_roles
-- directamente porque esa tabla no tiene grants — verificado en
-- sandbox: "permission denied for table user_roles").
-- is_admin() lee user_roles con SECURITY DEFINER (fuente de
-- verdad server-side de 20260820), inmune a metadata manipulada.
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = auth.uid() AND rol IN ('admin', 'super_admin')
    )
$$;

REVOKE EXECUTE ON FUNCTION public.is_admin() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- ============================================================
-- PASO 3: INSERT — solo free_trial del propio tenant
-- (flujo legítimo: PlansView moderno monto=0, legacy sin monto)
-- ============================================================
DROP POLICY IF EXISTS "Suscripcion auto-registro: solo free trial" ON public.subscriptions;
CREATE POLICY "Suscripcion auto-registro: solo free trial" ON public.subscriptions
    FOR INSERT TO authenticated
    WITH CHECK (
        tenant_id = public.get_user_tenant_id()
        AND plan = 'free_trial'
        AND status = 'active'
        AND (monto IS NULL OR monto = 0)
    );

-- ============================================================
-- PASO 4: UPDATE — admin del propio tenant SOLO puede
-- cancelar (status -> inactive) o pasar a freemium.
-- Activar/renovar planes de pago queda exclusivo del webhook
-- (activar_suscripcion_post_pago, service_role). El superadmin
-- conserva su policy "Super admin todo en subscriptions".
-- ============================================================
DROP POLICY IF EXISTS "Admin gestiona su suscripcion (solo cancelar o freemium)" ON public.subscriptions;
CREATE POLICY "Admin gestiona su suscripcion (solo cancelar o freemium)" ON public.subscriptions
    FOR UPDATE TO authenticated
    USING (
        tenant_id = public.get_user_tenant_id()
        AND public.is_admin()
    )
    WITH CHECK (
        tenant_id = public.get_user_tenant_id()
        AND (
            status = 'inactive'
            OR (plan = 'freemium' AND status = 'active')
        )
    );

-- ============================================================
-- PASO 5: citas — trigger que fuerza el precio del servicio
-- para roles no-admin (defensa en profundidad: aunque un
-- request directo intente escribir precio, el servidor lo
-- sobreescribe). SECURITY DEFINER para leer user_roles/servicios.
-- ============================================================
CREATE OR REPLACE FUNCTION public.citas_fijar_precio_servidor()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_precio NUMERIC;
BEGIN
    -- Admin/super_admin (user_roles = fuente de verdad server-side)
    -- conservan el control total del precio (edición manual de citas).
    IF public.is_admin() THEN
        RETURN NEW;
    END IF;

    -- No-admin (cliente/anon/trabajador): el precio SIEMPRE sale
    -- del servicio, nunca del payload. Además se valida que el
    -- servicio pertenezca al tenant de la cita.
    SELECT precio INTO v_precio
    FROM public.servicios
    WHERE id = NEW.servicio_id AND tenant_id = NEW.tenant_id;

    IF v_precio IS NULL THEN
        RAISE EXCEPTION 'Servicio inválido para este negocio';
    END IF;

    NEW.precio := COALESCE(v_precio, 0);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_citas_fijar_precio ON public.citas;
CREATE TRIGGER trg_citas_fijar_precio
    BEFORE INSERT OR UPDATE ON public.citas
    FOR EACH ROW EXECUTE FUNCTION public.citas_fijar_precio_servidor();

-- ============================================================
-- PASO 5: Refresh schema cache + verificación
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '✅ Fase 1: precio de citas server-side (trigger) + subscriptions sin auto-premium (policies restrictivas)' AS status;
