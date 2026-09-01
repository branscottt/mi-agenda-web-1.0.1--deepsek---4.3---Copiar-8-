-- ============================================================
-- 20260901_tenant_resumen.sql
-- Resumen de USO real de un tenant para el panel superadmin:
-- servicios creados, citas (totales y 7 días), notificaciones
-- (totales y leídas), último acceso, última actividad (audit_log)
-- y fecha de registro. Solo super_admin.
-- ============================================================

DROP FUNCTION IF EXISTS public.get_tenant_resumen(UUID);

CREATE OR REPLACE FUNCTION public.get_tenant_resumen(p_tenant_id UUID)
RETURNS TABLE (
    servicios_count BIGINT,
    citas_count BIGINT,
    citas_7d BIGINT,
    ultima_cita TIMESTAMPTZ,
    ultimo_login TIMESTAMPTZ,
    notif_count BIGINT,
    notif_leidas BIGINT,
    ultima_actividad TIMESTAMPTZ,
    registrado TIMESTAMPTZ
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
        (SELECT COUNT(*) FROM public.servicios s WHERE s.tenant_id = p_tenant_id)::bigint,
        (SELECT COUNT(*) FROM public.citas c WHERE c.tenant_id = p_tenant_id)::bigint,
        (SELECT COUNT(*) FROM public.citas c
         WHERE c.tenant_id = p_tenant_id
           AND c.created_at >= NOW() - INTERVAL '7 days')::bigint,
        (SELECT MAX(c.created_at) FROM public.citas c WHERE c.tenant_id = p_tenant_id),
        (SELECT MAX(u.last_sign_in_at) FROM auth.users u
         JOIN public.user_roles ur ON ur.user_id = u.id
         WHERE ur.tenant_id = p_tenant_id),
        (SELECT COUNT(*) FROM public.notificaciones_admin n WHERE n.tenant_id = p_tenant_id)::bigint,
        (SELECT COUNT(*) FROM public.notificaciones_admin n
         WHERE n.tenant_id = p_tenant_id AND n.leido = true)::bigint,
        (SELECT MAX(a.created_at) FROM public.audit_log a WHERE a.tenant_id = p_tenant_id),
        (SELECT t.fecha_registro FROM public.tenants t WHERE t.id = p_tenant_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_tenant_resumen(UUID) TO authenticated;
