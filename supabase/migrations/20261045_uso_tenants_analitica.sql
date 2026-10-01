-- ============================================================
-- 20261045_uso_tenants_analitica.sql
-- Analítica de USO por tenant para el panel superadmin.
--
--  PASO 1 · tenant_eventos  — eventos de PRODUCTO: qué pantalla, botón y
--           flujo usa cada negocio (no depende de PostHog, que está apagado).
--  PASO 2 · registrar_evento() — RPC que escribe el evento (SECURITY DEFINER,
--           resuelve el tenant del usuario autenticado; nunca lanza error al
--           front: si falla devuelve {ok:false} y la UI sigue igual).
--  PASO 3 · audit_log — trigger genérico para las tablas de uso que faltaban
--           (servicios, clientes, archivos, bandeja, trello, ventas live).
--           Antes solo se auditaban citas/subscriptions/tenants.
--  PASO 4 · get_uso_tenants() — tabla comparativa por negocio (superadmin).
--  PASO 5 · get_tenant_uso(uuid) — detalle jsonb de un negocio.
--  PASO 6 · Bucket kanban-adjuntos: + image/heic y image/heif (fotos iPhone).
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: Tabla de eventos de producto
-- ============================================================
CREATE TABLE IF NOT EXISTS public.tenant_eventos (
    id bigserial PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    user_id uuid,
    user_email text,
    evento text NOT NULL,
    props jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_eventos_tenant
    ON public.tenant_eventos (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_eventos_evento
    ON public.tenant_eventos (evento, created_at DESC);

ALTER TABLE public.tenant_eventos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Super admin ve eventos de uso" ON public.tenant_eventos;
CREATE POLICY "Super admin ve eventos de uso" ON public.tenant_eventos
    FOR SELECT TO authenticated
    USING (public.is_super_admin());

-- Solo lectura para el superadmin; la escritura pasa SIEMPRE por el RPC.
REVOKE ALL ON public.tenant_eventos FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.tenant_eventos FROM authenticated;
GRANT SELECT ON public.tenant_eventos TO authenticated;

-- ============================================================
-- PASO 2: RPC registrar_evento (llamada desde el front)
-- ============================================================
CREATE OR REPLACE FUNCTION public.registrar_evento(
    p_evento text,
    p_props jsonb DEFAULT '{}'::jsonb,
    p_tenant_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
    v_uid uuid;
    v_email text;
    v_evento text;
    v_tenant uuid;
    v_props jsonb;
BEGIN
    v_uid := auth.uid();
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'sin sesión');
    END IF;

    v_evento := lower(btrim(coalesce(p_evento, '')));
    v_evento := regexp_replace(v_evento, '[^a-z0-9_]+', '_', 'g');
    v_evento := left(v_evento, 60);
    IF length(v_evento) < 3 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'evento inválido');
    END IF;

    -- El tenant que se registra tiene que ser de quien llama.
    IF p_tenant_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = v_uid AND ur.tenant_id = p_tenant_id
    ) THEN
        v_tenant := p_tenant_id;
    ELSE
        SELECT ur.tenant_id INTO v_tenant
        FROM public.user_roles ur
        JOIN public.tenants t ON t.id = ur.tenant_id
        WHERE ur.user_id = v_uid AND t.proyecto = 'reservas'
        LIMIT 1;
        IF v_tenant IS NULL THEN
            SELECT ur.tenant_id INTO v_tenant
            FROM public.user_roles ur WHERE ur.user_id = v_uid LIMIT 1;
        END IF;
    END IF;
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'sin tenant');
    END IF;

    v_props := CASE
        WHEN p_props IS NULL OR octet_length(p_props::text) > 2000 THEN '{}'::jsonb
        ELSE p_props
    END;

    BEGIN
        v_email := current_setting('request.jwt.claims', true)::jsonb ->> 'email';
    EXCEPTION WHEN OTHERS THEN
        v_email := NULL;
    END;

    INSERT INTO public.tenant_eventos (tenant_id, user_id, user_email, evento, props)
    VALUES (v_tenant, v_uid, v_email, v_evento, v_props);

    RETURN jsonb_build_object('ok', true);
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.registrar_evento(text, jsonb, uuid) TO authenticated;

-- ============================================================
-- PASO 3: Auditoría de las tablas de USO que faltaban
-- (payload compacto: nombre/cliente, sin el row completo → audit_log liviano)
-- ============================================================
CREATE OR REPLACE FUNCTION public.audit_uso_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
    v_uid uuid;
    v_email text;
    v_tid uuid;
    v_rec text;
    v_new jsonb;
    v_old jsonb;
    v_resumen jsonb;
BEGIN
    v_uid := auth.uid();
    BEGIN
        v_email := current_setting('request.jwt.claims', true)::jsonb ->> 'email';
    EXCEPTION WHEN OTHERS THEN
        v_email := NULL;
    END;

    IF TG_OP = 'DELETE' THEN
        v_old := to_jsonb(OLD);
        v_tid := nullif(v_old->>'tenant_id', '')::uuid;
        v_rec := coalesce(v_old->>'id', '');
        v_resumen := jsonb_strip_nulls(jsonb_build_object(
            'nombre', coalesce(v_old->>'nombre', v_old->>'titulo', v_old->>'asunto', v_old->>'tiktok_user'),
            'cliente_email', v_old->>'cliente_email'
        ));
    ELSE
        v_new := to_jsonb(NEW);
        v_tid := nullif(v_new->>'tenant_id', '')::uuid;
        v_rec := coalesce(v_new->>'id', '');

        IF TG_OP = 'UPDATE' THEN
            v_old := to_jsonb(OLD);
            IF v_old IS NOT DISTINCT FROM v_new THEN
                RETURN NEW;
            END IF;
        END IF;

        v_resumen := jsonb_strip_nulls(jsonb_build_object(
            'nombre', coalesce(v_new->>'nombre', v_new->>'titulo', v_new->>'asunto', v_new->>'tiktok_user'),
            'cliente_email', v_new->>'cliente_email'
        ));
    END IF;

    -- kanban_cards no tiene tenant_id: se resuelve por su lista/tablero.
    IF v_tid IS NULL AND TG_OP <> 'DELETE' AND (v_new ? 'list_id') THEN
        BEGIN
            SELECT b.tenant_id INTO v_tid
            FROM public.kanban_lists l
            JOIN public.kanban_boards b ON b.id = l.board_id
            WHERE l.id::text = (v_new->>'list_id');
        EXCEPTION WHEN OTHERS THEN
            v_tid := NULL;
        END;
    END IF;

    IF TG_OP = 'DELETE' THEN
        INSERT INTO public.audit_log (table_name, record_id, operation, old_data, user_id, user_email, tenant_id)
        VALUES (TG_TABLE_NAME, v_rec, 'DELETE', v_resumen, v_uid, v_email, v_tid);
        RETURN OLD;
    ELSIF TG_OP = 'INSERT' THEN
        INSERT INTO public.audit_log (table_name, record_id, operation, new_data, user_id, user_email, tenant_id)
        VALUES (TG_TABLE_NAME, v_rec, 'INSERT', v_resumen, v_uid, v_email, v_tid);
        RETURN NEW;
    ELSE
        INSERT INTO public.audit_log (table_name, record_id, operation, new_data, user_id, user_email, tenant_id)
        VALUES (TG_TABLE_NAME, v_rec, 'UPDATE', v_resumen, v_uid, v_email, v_tid);
        RETURN NEW;
    END IF;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_audit_uso ON public.servicios;
CREATE TRIGGER trg_audit_uso
    AFTER INSERT OR UPDATE OR DELETE ON public.servicios
    FOR EACH ROW EXECUTE FUNCTION public.audit_uso_trigger();

DROP TRIGGER IF EXISTS trg_audit_uso ON public.clientes_manuales;
CREATE TRIGGER trg_audit_uso
    AFTER INSERT OR UPDATE OR DELETE ON public.clientes_manuales
    FOR EACH ROW EXECUTE FUNCTION public.audit_uso_trigger();

DROP TRIGGER IF EXISTS trg_audit_uso ON public.clientes_archivos;
CREATE TRIGGER trg_audit_uso
    AFTER INSERT OR UPDATE OR DELETE ON public.clientes_archivos
    FOR EACH ROW EXECUTE FUNCTION public.audit_uso_trigger();

DROP TRIGGER IF EXISTS trg_audit_uso ON public.clientes_archivos_huerfanos;
CREATE TRIGGER trg_audit_uso
    AFTER INSERT OR UPDATE OR DELETE ON public.clientes_archivos_huerfanos
    FOR EACH ROW EXECUTE FUNCTION public.audit_uso_trigger();

DROP TRIGGER IF EXISTS trg_audit_uso ON public.kanban_boards;
CREATE TRIGGER trg_audit_uso
    AFTER INSERT OR UPDATE OR DELETE ON public.kanban_boards
    FOR EACH ROW EXECUTE FUNCTION public.audit_uso_trigger();

DROP TRIGGER IF EXISTS trg_audit_uso ON public.kanban_cards;
CREATE TRIGGER trg_audit_uso
    AFTER INSERT OR UPDATE OR DELETE ON public.kanban_cards
    FOR EACH ROW EXECUTE FUNCTION public.audit_uso_trigger();

DROP TRIGGER IF EXISTS trg_audit_uso ON public.vl_clientes;
CREATE TRIGGER trg_audit_uso
    AFTER INSERT OR UPDATE OR DELETE ON public.vl_clientes
    FOR EACH ROW EXECUTE FUNCTION public.audit_uso_trigger();

DROP TRIGGER IF EXISTS trg_audit_uso ON public.vl_lives;
CREATE TRIGGER trg_audit_uso
    AFTER INSERT OR UPDATE OR DELETE ON public.vl_lives
    FOR EACH ROW EXECUTE FUNCTION public.audit_uso_trigger();

DROP TRIGGER IF EXISTS trg_audit_uso ON public.vl_procesos;
CREATE TRIGGER trg_audit_uso
    AFTER INSERT OR UPDATE OR DELETE ON public.vl_procesos
    FOR EACH ROW EXECUTE FUNCTION public.audit_uso_trigger();

-- ============================================================
-- PASO 4: get_uso_tenants() — comparativa por negocio
-- ============================================================
DROP FUNCTION IF EXISTS public.get_uso_tenants();

CREATE OR REPLACE FUNCTION public.get_uso_tenants()
RETURNS TABLE (
    tenant_id uuid,
    nombre_negocio text,
    plan text,
    estado text,
    proyecto text,
    registrado timestamptz,
    ultimo_login timestamptz,
    ultima_actividad timestamptz,
    servicios bigint,
    servicios_activos bigint,
    citas bigint,
    citas_30d bigint,
    clientes bigint,
    archivos bigint,
    archivos_versiones bigint,
    huerfanos bigint,
    tableros bigint,
    tarjetas bigint,
    vl_lives bigint,
    vl_clientes bigint,
    eventos_total bigint,
    eventos_7d bigint,
    eventos_30d bigint,
    eventos_top jsonb,
    cambios_30d jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
    IF NOT public.is_super_admin() THEN
        RAISE EXCEPTION 'Acceso denegado: solo super admin';
    END IF;

    RETURN QUERY
    SELECT
        t.id,
        t.nombre_negocio::text,
        t.plan::text,
        t.estado::text,
        t.proyecto::text,
        t.fecha_registro::timestamptz,
        (SELECT MAX(u.last_sign_in_at) FROM auth.users u
         JOIN public.user_roles ur ON ur.user_id = u.id
         WHERE ur.tenant_id = t.id),
        GREATEST(
            (SELECT MAX(a.created_at) FROM public.audit_log a WHERE a.tenant_id = t.id),
            (SELECT MAX(e.created_at) FROM public.tenant_eventos e WHERE e.tenant_id = t.id)
        ),
        (SELECT COUNT(*) FROM public.servicios s WHERE s.tenant_id = t.id),
        (SELECT COUNT(*) FROM public.servicios s WHERE s.tenant_id = t.id AND s.activo IS TRUE),
        (SELECT COUNT(*) FROM public.citas c WHERE c.tenant_id = t.id),
        (SELECT COUNT(*) FROM public.citas c WHERE c.tenant_id = t.id AND c.created_at >= now() - interval '30 days'),
        (SELECT COUNT(*) FROM public.clientes_manuales cm WHERE cm.tenant_id = t.id),
        (SELECT COUNT(*) FROM public.clientes_archivos ca WHERE ca.tenant_id = t.id),
        (SELECT COUNT(*) FROM public.clientes_archivo_versiones v
         JOIN public.clientes_archivos ca2 ON ca2.id = v.archivo_id
         WHERE ca2.tenant_id = t.id),
        (SELECT COUNT(*) FROM public.clientes_archivos_huerfanos h
         WHERE h.tenant_id = t.id AND h.estado = 'pendiente'),
        (SELECT COUNT(*) FROM public.kanban_boards kb WHERE kb.tenant_id = t.id),
        (SELECT COUNT(*) FROM public.kanban_cards kc
         JOIN public.kanban_lists kl ON kl.id = kc.list_id
         JOIN public.kanban_boards kb2 ON kb2.id = kl.board_id
         WHERE kb2.tenant_id = t.id),
        (SELECT COUNT(*) FROM public.vl_lives l WHERE l.tenant_id = t.id),
        (SELECT COUNT(*) FROM public.vl_clientes vc WHERE vc.tenant_id = t.id),
        (SELECT COUNT(*) FROM public.tenant_eventos e WHERE e.tenant_id = t.id),
        (SELECT COUNT(*) FROM public.tenant_eventos e WHERE e.tenant_id = t.id AND e.created_at >= now() - interval '7 days'),
        (SELECT COUNT(*) FROM public.tenant_eventos e WHERE e.tenant_id = t.id AND e.created_at >= now() - interval '30 days'),
        COALESCE((
            SELECT jsonb_object_agg(x.evento, x.n)
            FROM (
                SELECT e.evento, COUNT(*) AS n
                FROM public.tenant_eventos e
                WHERE e.tenant_id = t.id
                GROUP BY e.evento
                ORDER BY COUNT(*) DESC, e.evento
                LIMIT 10
            ) x
        ), '{}'::jsonb),
        COALESCE((
            SELECT jsonb_object_agg(y.table_name, y.n)
            FROM (
                SELECT a.table_name, COUNT(*) AS n
                FROM public.audit_log a
                WHERE a.tenant_id = t.id AND a.created_at >= now() - interval '30 days'
                GROUP BY a.table_name
                ORDER BY COUNT(*) DESC
                LIMIT 10
            ) y
        ), '{}'::jsonb)
    FROM public.tenants t
    ORDER BY 8 DESC NULLS LAST, 9 DESC;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.get_uso_tenants() TO authenticated;

-- ============================================================
-- PASO 5: get_tenant_uso(uuid) — detalle de un negocio (jsonb)
-- ============================================================
DROP FUNCTION IF EXISTS public.get_tenant_uso(uuid);

CREATE OR REPLACE FUNCTION public.get_tenant_uso(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
    v_tenant record;
    v_res jsonb;
    v_eventos jsonb;
    v_serie jsonb;
BEGIN
    IF NOT public.is_super_admin() THEN
        RAISE EXCEPTION 'Acceso denegado: solo super admin';
    END IF;

    SELECT t.id, t.nombre_negocio, t.plan, t.estado, t.proyecto, t.fecha_registro
    INTO v_tenant
    FROM public.tenants t WHERE t.id = p_tenant_id;

    IF v_tenant.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'tenant no encontrado');
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'evento', x.evento, 'veces', x.n, 'ultima', x.ultima
    ) ORDER BY x.n DESC), '[]'::jsonb)
    INTO v_eventos
    FROM (
        SELECT e.evento, COUNT(*) AS n, MAX(e.created_at) AS ultima
        FROM public.tenant_eventos e
        WHERE e.tenant_id = p_tenant_id
        GROUP BY e.evento
        ORDER BY COUNT(*) DESC
        LIMIT 40
    ) x;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('dia', d.dia, 'n', d.n) ORDER BY d.dia), '[]'::jsonb)
    INTO v_serie
    FROM (
        SELECT to_char(g.dia, 'YYYY-MM-DD') AS dia,
               (SELECT COUNT(*) FROM public.tenant_eventos e
                WHERE e.tenant_id = p_tenant_id AND e.created_at::date = g.dia) AS n
        FROM generate_series(now()::date - interval '13 days', now()::date, interval '1 day') AS g(dia)
    ) d;

    v_res := jsonb_build_object(
        'ok', true,
        'tenant_id', v_tenant.id,
        'nombre_negocio', v_tenant.nombre_negocio,
        'plan', v_tenant.plan,
        'estado', v_tenant.estado,
        'proyecto', v_tenant.proyecto,
        'registrado', v_tenant.fecha_registro,
        'ultimo_login', (SELECT MAX(u.last_sign_in_at) FROM auth.users u
                         JOIN public.user_roles ur ON ur.user_id = u.id
                         WHERE ur.tenant_id = p_tenant_id),
        'servicios', (SELECT COUNT(*) FROM public.servicios s WHERE s.tenant_id = p_tenant_id),
        'citas', (SELECT COUNT(*) FROM public.citas c WHERE c.tenant_id = p_tenant_id),
        'citas_30d', (SELECT COUNT(*) FROM public.citas c WHERE c.tenant_id = p_tenant_id AND c.created_at >= now() - interval '30 days'),
        'clientes', (SELECT COUNT(*) FROM public.clientes_manuales cm WHERE cm.tenant_id = p_tenant_id),
        'archivos', (SELECT COUNT(*) FROM public.clientes_archivos ca WHERE ca.tenant_id = p_tenant_id),
        'huerfanos', (SELECT COUNT(*) FROM public.clientes_archivos_huerfanos h WHERE h.tenant_id = p_tenant_id AND h.estado = 'pendiente'),
        'tableros', (SELECT COUNT(*) FROM public.kanban_boards kb WHERE kb.tenant_id = p_tenant_id),
        'tarjetas', (SELECT COUNT(*) FROM public.kanban_cards kc
                     JOIN public.kanban_lists kl ON kl.id = kc.list_id
                     JOIN public.kanban_boards kb2 ON kb2.id = kl.board_id
                     WHERE kb2.tenant_id = p_tenant_id),
        'vl_lives', (SELECT COUNT(*) FROM public.vl_lives l WHERE l.tenant_id = p_tenant_id),
        'vl_clientes', (SELECT COUNT(*) FROM public.vl_clientes vc WHERE vc.tenant_id = p_tenant_id),
        'eventos_total', (SELECT COUNT(*) FROM public.tenant_eventos e WHERE e.tenant_id = p_tenant_id),
        'eventos', v_eventos,
        'serie_14d', v_serie,
        'cambios', COALESCE((
            SELECT jsonb_object_agg(z.table_name, z.n)
            FROM (
                SELECT a.table_name, COUNT(*) AS n
                FROM public.audit_log a
                WHERE a.tenant_id = p_tenant_id
                GROUP BY a.table_name
                ORDER BY COUNT(*) DESC
                LIMIT 15
            ) z
        ), '{}'::jsonb),
        'ultimos_eventos', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'evento', q.evento, 'props', q.props, 'en', q.created_at
            ) ORDER BY q.created_at DESC)
            FROM (
                SELECT e.evento, e.props, e.created_at
                FROM public.tenant_eventos e
                WHERE e.tenant_id = p_tenant_id
                ORDER BY e.created_at DESC
                LIMIT 25
            ) q
        ), '[]'::jsonb)
    );

    RETURN v_res;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.get_tenant_uso(uuid) TO authenticated;

-- ============================================================
-- PASO 6: Bucket kanban-adjuntos — fotos de iPhone (heic/heif)
-- ============================================================
UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
    'image/jpeg','image/png','image/gif','image/webp','image/svg+xml','image/heic','image/heif',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/rtf',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain','text/csv','application/zip'
]
WHERE id = 'kanban-adjuntos';

SELECT '[USO TENANTS] tenant_eventos + registrar_evento + audit_uso + get_uso_tenants + get_tenant_uso + MIME heic' AS status;
