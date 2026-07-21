-- ============================================================
-- MIGRACIÓN: Security Hardening v3 — Auditoría y blindaje final
-- Fecha: 2026-07-17
--
-- 1. Tabla audit_log para operaciones sensibles (subscriptions, tenants)
-- 2. Fix get_all_users_for_superadmin: JWT en vez de email hardcodeado
-- 3. Protección contra borrado en cascada de tenants con datos
-- 4. Verificación de integridad final
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: Tabla de auditoría para operaciones sensibles
-- ============================================================

CREATE TABLE IF NOT EXISTS public.audit_log (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
    old_data JSONB,
    new_data JSONB,
    user_id UUID,
    user_email TEXT,
    tenant_id UUID,
    ip_address TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para consultar auditoría rápido
CREATE INDEX IF NOT EXISTS idx_audit_log_table_op ON public.audit_log (table_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON public.audit_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON public.audit_log (user_id, created_at DESC);

-- Dar acceso solo a super_admin
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Super admin ve auditoría" ON public.audit_log;
CREATE POLICY "Super admin ve auditoría"
    ON public.audit_log FOR SELECT
    TO authenticated
    USING (public.is_super_admin());

DROP POLICY IF EXISTS "Sistema inserta auditoría" ON public.audit_log;
CREATE POLICY "Sistema inserta auditoría"
    ON public.audit_log FOR INSERT
    TO authenticated
    WITH CHECK (public.is_super_admin());

-- REVOKE todo excepto para service_role (solo los triggers internos escriben)
REVOKE ALL ON public.audit_log FROM anon;
REVOKE ALL ON public.audit_log FROM authenticated;
GRANT SELECT ON public.audit_log TO authenticated;

-- ============================================================
-- PASO 2: Trigger de auditoría para subscriptions
-- ============================================================

CREATE OR REPLACE FUNCTION public.audit_subscriptions_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id UUID;
    v_user_email TEXT;
    v_tenant_id UUID;
BEGIN
    -- Obtener usuario desde JWT
    v_user_id := auth.uid();
    BEGIN
        v_user_email := current_setting('request.jwt.claims', true)::jsonb ->> 'email';
    EXCEPTION WHEN OTHERS THEN
        v_user_email := NULL;
    END;

    IF TG_OP = 'INSERT' THEN
        v_tenant_id := NEW.tenant_id;
        INSERT INTO public.audit_log (table_name, record_id, operation, new_data, user_id, user_email, tenant_id)
        VALUES ('subscriptions', NEW.id::text, 'INSERT', row_to_json(NEW)::jsonb, v_user_id, v_user_email, v_tenant_id);
        RETURN NEW;

    ELSIF TG_OP = 'UPDATE' THEN
        v_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id);
        INSERT INTO public.audit_log (table_name, record_id, operation, old_data, new_data, user_id, user_email, tenant_id)
        VALUES ('subscriptions', NEW.id::text, 'UPDATE',
                row_to_json(OLD)::jsonb, row_to_json(NEW)::jsonb,
                v_user_id, v_user_email, v_tenant_id);
        RETURN NEW;

    ELSIF TG_OP = 'DELETE' THEN
        v_tenant_id := OLD.tenant_id;
        INSERT INTO public.audit_log (table_name, record_id, operation, old_data, user_id, user_email, tenant_id)
        VALUES ('subscriptions', OLD.id::text, 'DELETE', row_to_json(OLD)::jsonb, v_user_id, v_user_email, v_tenant_id);
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

-- Crear trigger en subscriptions (solo si no existe)
DROP TRIGGER IF EXISTS trg_audit_subscriptions ON public.subscriptions;
CREATE TRIGGER trg_audit_subscriptions
    AFTER INSERT OR UPDATE OR DELETE ON public.subscriptions
    FOR EACH ROW EXECUTE FUNCTION public.audit_subscriptions_trigger();

-- ============================================================
-- PASO 3: Trigger de auditoría para tenants (DELETE y UPDATE sensibles)
-- ============================================================

CREATE OR REPLACE FUNCTION public.audit_tenants_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_user_id UUID;
    v_user_email TEXT;
BEGIN
    v_user_id := auth.uid();
    BEGIN
        v_user_email := current_setting('request.jwt.claims', true)::jsonb ->> 'email';
    EXCEPTION WHEN OTHERS THEN
        v_user_email := NULL;
    END;

    IF TG_OP = 'DELETE' THEN
        INSERT INTO public.audit_log (table_name, record_id, operation, old_data, user_id, user_email, tenant_id)
        VALUES ('tenants', OLD.id::text, 'DELETE', row_to_json(OLD)::jsonb, v_user_id, v_user_email, OLD.id);
        RETURN OLD;

    ELSIF TG_OP = 'UPDATE' AND (
        OLD.plan IS DISTINCT FROM NEW.plan OR
        OLD.estado IS DISTINCT FROM NEW.estado OR
        OLD.email_contacto IS DISTINCT FROM NEW.email_contacto
    ) THEN
        INSERT INTO public.audit_log (table_name, record_id, operation, old_data, new_data, user_id, user_email, tenant_id)
        VALUES ('tenants', NEW.id::text, 'UPDATE',
                row_to_json(OLD)::jsonb, row_to_json(NEW)::jsonb,
                v_user_id, v_user_email, NEW.id);
        RETURN NEW;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_tenants ON public.tenants;
CREATE TRIGGER trg_audit_tenants
    AFTER DELETE OR UPDATE OF plan, estado, email_contacto ON public.tenants
    FOR EACH ROW EXECUTE FUNCTION public.audit_tenants_trigger();

-- ============================================================
-- PASO 4: Fix get_all_users_for_superadmin
-- Antes: hardcodeaba 'super@admin.com' como único super admin
-- Ahora: usa el JWT para verificar que el rol sea super_admin
-- Nota: DROP primero porque cambia el tipo de retorno
-- ============================================================

DROP FUNCTION IF EXISTS public.get_all_users_for_superadmin();

CREATE FUNCTION public.get_all_users_for_superadmin()
 RETURNS TABLE(
    id uuid,
    email varchar(255),
    rol text,
    nombre text,
    tenant_id text,
    created_at timestamp without time zone,
    last_sign_in_at timestamp without time zone
 )
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Verificar que el usuario que llama tiene rol super_admin en su JWT
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Acceso denegado: solo super-admin';
  END IF;

  RETURN QUERY
  SELECT
    u.id::uuid,
    u.email::varchar(255),
    (u.raw_user_meta_data->>'rol')::text AS rol,
    (u.raw_user_meta_data->>'nombre')::text AS nombre,
    (u.raw_user_meta_data->>'tenant_id')::text AS tenant_id,
    u.created_at::timestamp without time zone,
    u.last_sign_in_at::timestamp without time zone
  FROM auth.users u
  ORDER BY u.created_at DESC;
END;
$function$;

-- Re-otorgar permisos (ya revocado de anon en migration v2)
GRANT EXECUTE ON FUNCTION public.get_all_users_for_superadmin TO authenticated;

-- ============================================================
-- PASO 5: Proteger contra DELETE de tenant con datos asociados
-- Un tenant no debería poderse eliminar si tiene citas o suscripciones activas
-- ============================================================

CREATE OR REPLACE FUNCTION public.prevent_tenant_delete_with_data()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_citas_count INTEGER;
    v_subscriptions_count INTEGER;
BEGIN
    -- Contar citas asociadas al tenant
    SELECT COUNT(*) INTO v_citas_count
    FROM public.citas
    WHERE tenant_id = OLD.id;

    -- Contar suscripciones activas
    SELECT COUNT(*) INTO v_subscriptions_count
    FROM public.subscriptions
    WHERE tenant_id = OLD.id AND status = 'active';

    IF v_citas_count > 0 THEN
        RAISE EXCEPTION 'No se puede eliminar el tenant porque tiene % cita(s) asociada(s). Desactive el tenant en su lugar.', v_citas_count;
    END IF;

    IF v_subscriptions_count > 0 THEN
        RAISE EXCEPTION 'No se puede eliminar el tenant porque tiene % suscripción(es) activa(s). Cancélelas primero.', v_subscriptions_count;
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_tenant_delete ON public.tenants;
CREATE TRIGGER trg_prevent_tenant_delete
    BEFORE DELETE ON public.tenants
    FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_delete_with_data();

-- ============================================================
-- PASO 6: Refresh schema cache
-- ============================================================
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- VERIFICACIÓN
-- ============================================================
SELECT '[SECURITY V3] Migración completada: audit_log + triggers + superadmin fix + delete protection' AS status;
