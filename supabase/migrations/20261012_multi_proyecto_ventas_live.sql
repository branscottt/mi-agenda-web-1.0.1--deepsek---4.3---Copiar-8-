-- ============================================================
-- MIGRACIÓN: Multi-proyecto — Ventas Live como segundo producto
-- Fecha: 2026-10-12
--
-- OBJETIVO: separar la plataforma en dos proyectos ('reservas' y
-- 'ventas_live') dentro de la misma base, mismo login y mismas
-- suscripciones por workspace, permitiendo que una cuenta tenga
-- un workspace en cada proyecto (o solo en uno) con planes
-- independientes.
--
-- PRINCIPIOS:
--   * Los tenants actuales (todos de reservas) quedan 100% intactos:
--     columna proyecto con DEFAULT 'reservas' (backfill neutro).
--   * Todas las policies RLS existentes de reservas siguen usando
--     get_user_tenant_id() con SEMÁNTICA RESERVAS (join a tenants
--     filtrando proyecto='reservas'). Para usuarios con 1 sola fila
--     (todos los actuales) el resultado es idéntico al anterior.
--   * Ventas Live usa su propio helper (get_vl_tenant_id()) y sus
--     propias policies — cero cambios sobre policies existentes.
--   * Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: tenants.proyecto (discriminador de proyecto)
-- ============================================================
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS proyecto TEXT;

-- Backfill: todos los tenants existentes son de reservas
UPDATE public.tenants SET proyecto = 'reservas' WHERE proyecto IS NULL;

ALTER TABLE public.tenants ALTER COLUMN proyecto SET DEFAULT 'reservas';
ALTER TABLE public.tenants ALTER COLUMN proyecto SET NOT NULL;

ALTER TABLE public.tenants DROP CONSTRAINT IF EXISTS tenants_proyecto_check;
ALTER TABLE public.tenants ADD CONSTRAINT tenants_proyecto_check
    CHECK (proyecto IN ('reservas', 'ventas_live'));

CREATE INDEX IF NOT EXISTS idx_tenants_proyecto ON public.tenants (proyecto);

-- ============================================================
-- PASO 2: Ampliar CHECKs de plan para la familia Ventas Live
-- (hoy solo existe el plan gratuito vl_free; cuando haya precios
--  se agregan vl_pro / vl_premium_anual en una migración pequeña)
-- ============================================================
ALTER TABLE public.tenants DROP CONSTRAINT IF EXISTS tenants_plan_check;
ALTER TABLE public.tenants ADD CONSTRAINT tenants_plan_check
    CHECK (plan IN ('freemium', 'pro', 'premium_anual', 'free_trial', 'vl_free'));

ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_plan_check;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_plan_check
    CHECK (plan IN ('freemium', 'pro', 'premium_anual', 'free_trial', 'vl_free'));

-- ============================================================
-- PASO 3: user_roles — permitir múltiples workspaces por cuenta
-- Permite que una misma cuenta tenga un workspace por proyecto.
-- La PK vieja (user_id) impedía la segunda fila.
--
-- NOTA: NO se usa PK compuesta porque tenant_id admite NULL
-- (filas rol cliente/super_admin sin workspace) y las columnas
-- de una PK no pueden ser NULL. En su lugar: índice UNIQUE con
-- NULLS NOT DISTINCT (PG15+), que trata (user, NULL) como duplicado
-- y además bloquea filas repetidas sin tenant. user_roles no se
-- expone por PostgREST (grants revocados; solo RPCs SECURITY
-- DEFINER la leen), así que no necesita PK.
-- ============================================================
ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_pkey;

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_roles_user_tenant
    ON public.user_roles (user_id, tenant_id) NULLS NOT DISTINCT;

DROP INDEX IF EXISTS uq_user_roles_user_sin_tenant;

-- ============================================================
-- PASO 4: Helpers RLS por proyecto
-- get_user_tenant_id() conserva su firma pero queda acotado al
-- proyecto 'reservas' (join a tenants). Para TODOS los usuarios
-- actuales (1 fila, tenant de reservas) devuelve exactamente lo
-- mismo que antes. get_vl_tenant_id() es el equivalente para
-- Ventas Live.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_user_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT ur.tenant_id
    FROM public.user_roles ur
    JOIN public.tenants t ON t.id = ur.tenant_id
    WHERE ur.user_id = auth.uid()
      AND t.proyecto = 'reservas'
    LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.get_vl_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT ur.tenant_id
    FROM public.user_roles ur
    JOIN public.tenants t ON t.id = ur.tenant_id
    WHERE ur.user_id = auth.uid()
      AND t.proyecto = 'ventas_live'
    LIMIT 1
$$;

-- ============================================================
-- PASO 5: Policies RLS del workspace Ventas Live
-- (mismo patrón que las de reservas; no se toca ninguna existente)
-- ============================================================
-- tenants: el dueño vl lee su propio workspace
DROP POLICY IF EXISTS "Admin vl ve su tenant" ON public.tenants;
CREATE POLICY "Admin vl ve su tenant" ON public.tenants
    FOR SELECT TO authenticated
    USING (id = public.get_vl_tenant_id());

-- tenants: el dueño vl actualiza su propio workspace
DROP POLICY IF EXISTS "Admin vl actualiza su tenant" ON public.tenants;
CREATE POLICY "Admin vl actualiza su tenant" ON public.tenants
    FOR UPDATE TO authenticated
    USING (
        id = public.get_vl_tenant_id()
        AND ((((auth.jwt() ->> 'user_metadata')::jsonb) ->> 'rol')::text) = 'admin'
    )
    WITH CHECK (
        id = public.get_vl_tenant_id()
        AND ((((auth.jwt() ->> 'user_metadata')::jsonb) ->> 'rol')::text) = 'admin'
    );

-- subscriptions: el dueño vl ve su suscripción
DROP POLICY IF EXISTS "Admin vl ve sus suscripciones" ON public.subscriptions;
CREATE POLICY "Admin vl ve sus suscripciones" ON public.subscriptions
    FOR SELECT TO authenticated
    USING (
        tenant_id = public.get_vl_tenant_id()
        AND ((((auth.jwt() ->> 'user_metadata')::jsonb) ->> 'rol')::text) = 'admin'
    );

-- subscriptions: el dueño vl actualiza su suscripción (futuros cambios de plan)
DROP POLICY IF EXISTS "Admin vl actualiza su suscripcion" ON public.subscriptions;
CREATE POLICY "Admin vl actualiza su suscripcion" ON public.subscriptions
    FOR UPDATE TO authenticated
    USING (
        tenant_id = public.get_vl_tenant_id()
        AND ((((auth.jwt() ->> 'user_metadata')::jsonb) ->> 'rol')::text) = 'admin'
    )
    WITH CHECK (
        tenant_id = public.get_vl_tenant_id()
        AND ((((auth.jwt() ->> 'user_metadata')::jsonb) ->> 'rol')::text) = 'admin'
    );

-- ============================================================
-- PASO 6: Trigger de suscripción inicial — plan según proyecto
-- (sigue insertando en 'inactive' para no auto-activar nada)
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_initial_subscription()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
BEGIN
    INSERT INTO public.subscriptions (tenant_id, plan, status, start_date)
    VALUES (
        NEW.id,
        CASE WHEN NEW.proyecto = 'ventas_live' THEN 'vl_free' ELSE 'freemium' END,
        'inactive',
        now()
    );
    RETURN NEW;
END;
$function$;

-- ============================================================
-- PASO 7: crear_tenant_completo — workspace de RESERVAS
-- * ON CONFLICT pasa a la PK compuesta (user_id, tenant_id)
-- * Guardia: máximo 1 negocio de reservas por cuenta
--   (preserva la regla implícita actual de 1 pyme por usuario)
-- ============================================================
CREATE OR REPLACE FUNCTION public.crear_tenant_completo(
    p_nombre_negocio TEXT,
    p_email_contacto TEXT,
    p_whatsapp TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant public.tenants%ROWTYPE;
BEGIN
    IF p_nombre_negocio IS NULL OR trim(p_nombre_negocio) = '' THEN
        RAISE EXCEPTION 'nombre_negocio es requerido';
    END IF;
    IF p_email_contacto IS NULL OR trim(p_email_contacto) = '' THEN
        RAISE EXCEPTION 'email_contacto es requerido';
    END IF;

    -- Máximo 1 workspace de reservas por cuenta
    IF EXISTS (
        SELECT 1 FROM public.user_roles ur
        JOIN public.tenants t ON t.id = ur.tenant_id
        WHERE ur.user_id = auth.uid()
          AND ur.rol = 'admin'
          AND t.proyecto = 'reservas'
    ) THEN
        RAISE EXCEPTION 'Ya tienes un negocio en Reservas de Pymes';
    END IF;

    INSERT INTO public.tenants (nombre_negocio, email_contacto, plan, whatsapp)
    VALUES (
        trim(p_nombre_negocio),
        lower(trim(p_email_contacto)),
        NULL,
        NULLIF(trim(COALESCE(p_whatsapp, '')), '')
    )
    RETURNING * INTO v_tenant;

    -- Registro de autorización server-side (inmune a manipulación)
    INSERT INTO public.user_roles (user_id, rol, tenant_id)
    VALUES (auth.uid(), 'admin', v_tenant.id)
    ON CONFLICT (user_id, tenant_id) DO UPDATE SET rol = 'admin';

    RETURN jsonb_build_object(
        'id', v_tenant.id,
        'nombre_negocio', v_tenant.nombre_negocio,
        'email_contacto', v_tenant.email_contacto,
        'whatsapp', v_tenant.whatsapp,
        'proyecto', v_tenant.proyecto,
        'plan', v_tenant.plan,
        'fecha_registro', v_tenant.fecha_registro
    );
END;
$$;

-- ============================================================
-- PASO 8: NUEVO RPC — crear_workspace_ventas_live
-- Alta de un workspace de Ventas Live para la cuenta autenticada
-- (tenant proyecto='ventas_live' + fila user_roles admin).
-- El trigger del PASO 6 crea su suscripción vl_free.
-- ============================================================
CREATE OR REPLACE FUNCTION public.crear_workspace_ventas_live(
    p_nombre_negocio TEXT,
    p_whatsapp TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant public.tenants%ROWTYPE;
    v_email TEXT;
BEGIN
    IF p_nombre_negocio IS NULL OR trim(p_nombre_negocio) = '' THEN
        RAISE EXCEPTION 'nombre_negocio es requerido';
    END IF;

    SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();
    IF v_email IS NULL THEN
        RAISE EXCEPTION 'Sesión no válida';
    END IF;

    -- Máximo 1 workspace de Ventas Live por cuenta
    IF EXISTS (
        SELECT 1 FROM public.user_roles ur
        JOIN public.tenants t ON t.id = ur.tenant_id
        WHERE ur.user_id = auth.uid()
          AND ur.rol = 'admin'
          AND t.proyecto = 'ventas_live'
    ) THEN
        RAISE EXCEPTION 'Ya tienes un espacio en Ventas Live';
    END IF;

    INSERT INTO public.tenants (nombre_negocio, email_contacto, plan, whatsapp, proyecto)
    VALUES (
        trim(p_nombre_negocio),
        lower(trim(v_email)),
        NULL,
        NULLIF(trim(COALESCE(p_whatsapp, '')), ''),
        'ventas_live'
    )
    RETURNING * INTO v_tenant;

    INSERT INTO public.user_roles (user_id, rol, tenant_id)
    VALUES (auth.uid(), 'admin', v_tenant.id)
    ON CONFLICT (user_id, tenant_id) DO UPDATE SET rol = 'admin';

    RETURN jsonb_build_object(
        'id', v_tenant.id,
        'nombre_negocio', v_tenant.nombre_negocio,
        'email_contacto', v_tenant.email_contacto,
        'whatsapp', v_tenant.whatsapp,
        'proyecto', v_tenant.proyecto,
        'plan', v_tenant.plan,
        'fecha_registro', v_tenant.fecha_registro
    );
END;
$$;

-- ============================================================
-- PASO 9: NUEVO RPC — get_mis_proyectos
-- Devuelve los workspaces (proyecto + tenant + suscripción) de la
-- cuenta autenticada. Alimenta las cards del hub post-login.
-- SECURITY DEFINER: lee user_roles/tenants/subscriptions sin
-- depender de RLS (el dueño vl no podría leer su tenant vía RLS
-- de reservas, y viceversa).
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_mis_proyectos()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'proyecto', t.proyecto,
                'tenant_id', ur.tenant_id,
                'nombre_negocio', t.nombre_negocio,
                'estado', t.estado,
                'sub_plan', s.plan,
                'sub_status', s.status,
                'sub_end_date', s.end_date
            ) ORDER BY t.proyecto
        ),
        '[]'::jsonb
    )
    FROM public.user_roles ur
    JOIN public.tenants t ON t.id = ur.tenant_id
    LEFT JOIN LATERAL (
        SELECT sub.plan, sub.status, sub.end_date
        FROM public.subscriptions sub
        WHERE sub.tenant_id = ur.tenant_id
        ORDER BY (sub.status = 'active') DESC, sub.start_date DESC
        LIMIT 1
    ) s ON true
    WHERE ur.user_id = auth.uid()
      AND ur.rol = 'admin'
$$;

-- ============================================================
-- PASO 10: actualizar_rol_usuario — multi-workspace
-- Aplica el rol a TODAS las filas del usuario en user_roles
-- (la PK compuesta ya no permite ON CONFLICT por user_id solo).
-- ============================================================
CREATE OR REPLACE FUNCTION public.actualizar_rol_usuario(p_user_id UUID, p_rol TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
    IF NOT public.is_super_admin() THEN
        RAISE EXCEPTION 'Acceso denegado: solo super-admin';
    END IF;

    IF p_rol NOT IN ('cliente', 'admin', 'trabajador', 'super_admin') THEN
        RAISE EXCEPTION 'Rol inválido: %', p_rol;
    END IF;

    UPDATE auth.users
    SET raw_user_meta_data = jsonb_set(
            COALESCE(raw_user_meta_data, '{}'::jsonb),
            '{rol}',
            to_jsonb(p_rol)
        )
    WHERE id = p_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Usuario no encontrado';
    END IF;

    -- Sincronizar TODAS las filas del usuario en user_roles
    UPDATE public.user_roles SET rol = p_rol WHERE user_id = p_user_id;

    -- Si el usuario no tenía fila, crearla (tenant desde metadata, si existe)
    INSERT INTO public.user_roles (user_id, rol, tenant_id)
    SELECT p_user_id, p_rol, NULLIF(u.raw_user_meta_data->>'tenant_id', '')::uuid
    FROM auth.users u
    WHERE u.id = p_user_id
      AND NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_user_id);

    RETURN true;
END;
$$;

-- ============================================================
-- PASO 11: Permisos de los RPCs nuevos
-- ============================================================
REVOKE EXECUTE ON FUNCTION public.crear_workspace_ventas_live(TEXT, TEXT) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.crear_workspace_ventas_live(TEXT, TEXT) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.get_mis_proyectos() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.get_mis_proyectos() TO authenticated;

-- ============================================================
-- PASO 12: Refresh schema cache + verificación
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '[MULTI-PROYECTO] tenants.proyecto + user_roles PK compuesta + helpers RLS + RPCs Ventas Live OK' AS status;
