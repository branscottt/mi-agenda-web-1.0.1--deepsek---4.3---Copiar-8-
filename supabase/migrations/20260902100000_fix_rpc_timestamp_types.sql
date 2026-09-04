-- 20260902_fix_rpc_timestamp_types.sql
-- Fix error 42804 "structure of query does not match function result type"
-- en get_tenant_activity() y get_tenant_resumen(p_tenant_id):
-- citas.created_at y tenants.fecha_registro son `timestamp without time zone`,
-- pero las funciones declaraban RETURNS TABLE(... timestamptz ...) → Postgres
-- rechazaba el RETURN QUERY al ejecutarse. Se castea a timestamptz el resultado.

CREATE OR REPLACE FUNCTION public.get_tenant_activity()
RETURNS TABLE(tenant_id uuid, citas_7d bigint, ultima_cita timestamp with time zone, ultimo_login timestamp with time zone)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
         WHERE c.tenant_id = t.id)::timestamptz,
        (SELECT MAX(u.last_sign_in_at) FROM auth.users u
         JOIN public.user_roles ur ON ur.user_id = u.id
         WHERE ur.tenant_id = t.id)
    FROM public.tenants t;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_tenant_resumen(p_tenant_id uuid)
RETURNS TABLE(servicios_count bigint, citas_count bigint, citas_7d bigint, ultima_cita timestamp with time zone, ultimo_login timestamp with time zone, notif_count bigint, notif_leidas bigint, ultima_actividad timestamp with time zone, registrado timestamp with time zone)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
        (SELECT MAX(c.created_at) FROM public.citas c WHERE c.tenant_id = p_tenant_id)::timestamptz,
        (SELECT MAX(u.last_sign_in_at) FROM auth.users u
         JOIN public.user_roles ur ON ur.user_id = u.id
         WHERE ur.tenant_id = p_tenant_id),
        (SELECT COUNT(*) FROM public.notificaciones_admin n WHERE n.tenant_id = p_tenant_id)::bigint,
        (SELECT COUNT(*) FROM public.notificaciones_admin n
         WHERE n.tenant_id = p_tenant_id AND n.leido = true)::bigint,
        (SELECT MAX(a.created_at) FROM public.audit_log a WHERE a.tenant_id = p_tenant_id),
        (SELECT t.fecha_registro FROM public.tenants t WHERE t.id = p_tenant_id)::timestamptz;
END;
$function$;
