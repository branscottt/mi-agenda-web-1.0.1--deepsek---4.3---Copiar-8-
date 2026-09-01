-- ============================================================
-- 20260901_tenant_activity.sql
-- Actividad real de cada tenant para el panel superadmin:
-- citas de los últimos 7 días, última cita y último acceso (login).
-- Solo super_admin puede ejecutarla.
-- ============================================================

DROP FUNCTION IF EXISTS public.get_tenant_activity();

CREATE OR REPLACE FUNCTION public.get_tenant_activity()
RETURNS TABLE (
    tenant_id UUID,
    citas_7d BIGINT,
    ultima_cita TIMESTAMPTZ,
    ultimo_login TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
    IF NOT public.is_super_admin() THEN
        RAISE EXCEPTION 'Acceso denegado: solo super admin';
    END IF;

    RETURN QUERY
    SELECT
        t.id,
        (SELECT COUNT(*) FROM public.citas c
         WHERE c.tenant_id = t.id
           AND c.created_at >= NOW() - INTERVAL '7 days')::bigint,
        (SELECT MAX(c.created_at) FROM public.citas c
         WHERE c.tenant_id = t.id),
        (SELECT MAX(u.last_sign_in_at) FROM auth.users u
         JOIN public.user_roles ur ON ur.user_id = u.id
         WHERE ur.tenant_id = t.id)
    FROM public.tenants t;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_tenant_activity() TO authenticated;
