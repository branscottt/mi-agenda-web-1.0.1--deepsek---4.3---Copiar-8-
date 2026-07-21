-- ============================================================
-- MIGRACIÓN: Audit trigger para citas
-- Fecha: 2026-07-21
--
-- Agrega auditoría a la tabla citas (INSERT, UPDATE, DELETE)
-- para tracking de quién agenda, modifica o elimina reservas.
-- Útil para: disputas de clientes, auditoría de superadmin,
-- y para tener trazabilidad de cambios en producción.
--
-- Nota: citas puede ser insertada por anon (clientes agendando
-- desde el portal). En ese caso auth.uid() es NULL, y se
-- registra como 'anon' en user_email.
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: Función trigger de auditoría para citas
-- ============================================================

CREATE OR REPLACE FUNCTION public.audit_citas_trigger()
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
    -- Obtener usuario desde JWT (puede ser NULL si es anon/visitante)
    v_user_id := auth.uid();
    BEGIN
        v_user_email := COALESCE(
            current_setting('request.jwt.claims', true)::jsonb ->> 'email',
            'anon'
        );
    EXCEPTION WHEN OTHERS THEN
        v_user_email := 'anon';
    END;

    IF TG_OP = 'INSERT' THEN
        v_tenant_id := NEW.tenant_id;
        INSERT INTO public.audit_log (table_name, record_id, operation, new_data, user_id, user_email, tenant_id)
        VALUES ('citas', NEW.id::text, 'INSERT', row_to_json(NEW)::jsonb, v_user_id, v_user_email, v_tenant_id);
        RETURN NEW;

    ELSIF TG_OP = 'UPDATE' THEN
        v_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id);
        INSERT INTO public.audit_log (table_name, record_id, operation, old_data, new_data, user_id, user_email, tenant_id)
        VALUES ('citas', NEW.id::text, 'UPDATE',
                row_to_json(OLD)::jsonb, row_to_json(NEW)::jsonb,
                v_user_id, v_user_email, v_tenant_id);
        RETURN NEW;

    ELSIF TG_OP = 'DELETE' THEN
        v_tenant_id := OLD.tenant_id;
        INSERT INTO public.audit_log (table_name, record_id, operation, old_data, user_id, user_email, tenant_id)
        VALUES ('citas', OLD.id::text, 'DELETE', row_to_json(OLD)::jsonb, v_user_id, v_user_email, v_tenant_id);
        RETURN OLD;
    END IF;

    RETURN NULL;
END;
$$;

-- ============================================================
-- PASO 2: Trigger en citas
-- ============================================================

DROP TRIGGER IF EXISTS trg_audit_citas ON public.citas;
CREATE TRIGGER trg_audit_citas
    AFTER INSERT OR UPDATE OR DELETE ON public.citas
    FOR EACH ROW EXECUTE FUNCTION public.audit_citas_trigger();

-- ============================================================
-- PASO 3: Refresh schema cache
-- ============================================================
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- VERIFICACIÓN
-- ============================================================
SELECT '✅ Migración audit_citas completada: trigger creado en citas' AS status;
