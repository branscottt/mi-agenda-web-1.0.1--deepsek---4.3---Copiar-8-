-- =====================================================
-- SCRIPT UNIFICADO: SUPER-ADMIN + POLÍTICAS MULTI-TENANT
-- =====================================================
-- Ejecutar en SQL Editor de Supabase (como administrador)
-- =====================================================

-- 1. Crear/actualizar usuario super-admin (super@demo.com / demo123)
DO $$
DECLARE
    super_email TEXT := 'super@demo.com';
    super_exists BOOLEAN;
    super_uid UUID;
BEGIN
    SELECT EXISTS (SELECT 1 FROM auth.users WHERE email = super_email) INTO super_exists;
    
    IF NOT super_exists THEN
        INSERT INTO auth.users (
            instance_id, id, aud, role, email, encrypted_password,
            email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
            created_at, updated_at, confirmation_token, email_change,
            email_change_token_new, recovery_token
        ) VALUES (
            '00000000-0000-0000-0000-000000000000',
            gen_random_uuid(),
            'authenticated',
            'authenticated',
            super_email,
            crypt('demo123', gen_salt('bf')),
            now(),
            '{"provider":"email","providers":["email"]}',
            jsonb_build_object('nombre', 'Super Administrador', 'rol', 'super_admin'),
            now(), now(), '', '', '', ''
        );
        RAISE NOTICE '✅ Super-admin creado: %', super_email;
    ELSE
        UPDATE auth.users
        SET raw_user_meta_data = jsonb_build_object('nombre', 'Super Administrador', 'rol', 'super_admin')
        WHERE email = super_email;
        RAISE NOTICE '✅ Super-admin actualizado: %', super_email;
    END IF;
END $$;

-- 2. Función is_super_admin
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
    SELECT COALESCE(
        (current_setting('request.jwt.claims', true)::jsonb -> 'user_metadata' ->> 'rol') = 'super_admin',
        false
    );
$$;

-- 3. Función para obtener tenant_id del usuario autenticado
CREATE OR REPLACE FUNCTION public.get_user_tenant_id()
RETURNS UUID
LANGUAGE sql STABLE
AS $$
    SELECT COALESCE(
        (current_setting('request.jwt.claims', true)::jsonb -> 'user_metadata' ->> 'tenant_id')::uuid,
        NULL
    );
$$;

-- 4. Eliminar todas las políticas existentes
DO $$
DECLARE
    pol RECORD;
BEGIN
    FOR pol IN 
        SELECT schemaname, tablename, policyname 
        FROM pg_policies 
        WHERE schemaname = 'public' 
          AND tablename IN ('tenants', 'servicios', 'citas', 'notificaciones_admin')
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pol.policyname, pol.tablename);
    END LOOP;
    RAISE NOTICE '✅ Políticas antiguas eliminadas';
END $$;

-- 5. Habilitar RLS
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE servicios ENABLE ROW LEVEL SECURITY;
ALTER TABLE citas ENABLE ROW LEVEL SECURITY;
ALTER TABLE notificaciones_admin ENABLE ROW LEVEL SECURITY;

-- =====================================================
-- 6. NUEVAS POLÍTICAS (con super_admin + tenant_id)
-- =====================================================

-- 6.1 TENANTS
CREATE POLICY "Super admin todo en tenants" ON tenants
    FOR ALL TO authenticated
    USING (public.is_super_admin())
    WITH CHECK (public.is_super_admin());

CREATE POLICY "Usuarios ven su propio tenant" ON tenants
    FOR SELECT TO authenticated
    USING (id = public.get_user_tenant_id());

CREATE POLICY "Admin puede actualizar su tenant" ON tenants
    FOR UPDATE TO authenticated
    USING (id = public.get_user_tenant_id() AND (auth.jwt() ->> 'user_metadata')::jsonb ->> 'rol' = 'admin')
    WITH CHECK (id = public.get_user_tenant_id());

-- 6.2 SERVICIOS
CREATE POLICY "Super admin todo en servicios" ON servicios
    FOR ALL TO authenticated
    USING (public.is_super_admin())
    WITH CHECK (public.is_super_admin());

CREATE POLICY "Todos ven servicios de su tenant" ON servicios
    FOR SELECT TO authenticated
    USING (tenant_id = public.get_user_tenant_id());

CREATE POLICY "Admin gestiona servicios de su tenant" ON servicios
    FOR ALL TO authenticated
    USING (tenant_id = public.get_user_tenant_id() AND (auth.jwt() ->> 'user_metadata')::jsonb ->> 'rol' = 'admin')
    WITH CHECK (tenant_id = public.get_user_tenant_id());

-- 6.3 CITAS
CREATE POLICY "Super admin todo en citas" ON citas
    FOR ALL TO authenticated
    USING (public.is_super_admin())
    WITH CHECK (public.is_super_admin());

CREATE POLICY "Admin ve/gestiona citas de su tenant" ON citas
    FOR ALL TO authenticated
    USING (
        tenant_id = public.get_user_tenant_id() 
        AND (auth.jwt() ->> 'user_metadata')::jsonb ->> 'rol' = 'admin'
    )
    WITH CHECK (
        tenant_id = public.get_user_tenant_id()
    );

CREATE POLICY "Cliente ve sus propias citas" ON citas
    FOR SELECT TO authenticated
    USING (
        (contacto->>'userId')::uuid = auth.uid()
        AND (auth.jwt() ->> 'user_metadata')::jsonb ->> 'rol' = 'cliente'
    );

CREATE POLICY "Cliente crea citas" ON citas
    FOR INSERT TO authenticated
    WITH CHECK (
        (contacto->>'userId')::uuid = auth.uid()
        AND (auth.jwt() ->> 'user_metadata')::jsonb ->> 'rol' = 'cliente'
    );

CREATE POLICY "Cliente actualiza citas futuras" ON citas
    FOR UPDATE TO authenticated
    USING (
        (contacto->>'userId')::uuid = auth.uid()
        AND fecha > now()
        AND (auth.jwt() ->> 'user_metadata')::jsonb ->> 'rol' = 'cliente'
    )
    WITH CHECK (
        (contacto->>'userId')::uuid = auth.uid()
        AND fecha > now()
        AND (auth.jwt() ->> 'user_metadata')::jsonb ->> 'rol' = 'cliente'
    );

CREATE POLICY "Cliente elimina citas futuras" ON citas
    FOR DELETE TO authenticated
    USING (
        (contacto->>'userId')::uuid = auth.uid()
        AND fecha > now()
        AND (auth.jwt() ->> 'user_metadata')::jsonb ->> 'rol' = 'cliente'
    );

-- 6.4 NOTIFICACIONES_ADMIN
CREATE POLICY "Super admin todo en notificaciones" ON notificaciones_admin
    FOR ALL TO authenticated
    USING (public.is_super_admin())
    WITH CHECK (public.is_super_admin());

CREATE POLICY "Admin ve notificaciones de su tenant" ON notificaciones_admin
    FOR SELECT TO authenticated
    USING (
        tenant_id = public.get_user_tenant_id()
        AND (auth.jwt() ->> 'user_metadata')::jsonb ->> 'rol' = 'admin'
    );

CREATE POLICY "Sistema crea notificaciones" ON notificaciones_admin
    FOR INSERT TO authenticated
    WITH CHECK (true);

-- 7. Verificación final (todo dentro de DO)
DO $$
DECLARE
    super_check BOOLEAN;
    tenant_id UUID := 'd7741079-3f87-4ce7-872c-8b1d4d90e8da'::UUID;
BEGIN
    SELECT public.is_super_admin() INTO super_check;
    RAISE NOTICE '🔍 Función is_super_admin() disponible: %', super_check;
    
    IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = tenant_id) THEN
        INSERT INTO tenants (id, nombre_negocio, email_contacto, plan, fecha_registro, estado)
        VALUES (tenant_id, 'Demo Business', 'demo@agendapro.com', 'freemium', now(), 'activo');
        RAISE NOTICE '🏢 Tenant demo creado con ID: %', tenant_id;
    ELSE
        RAISE NOTICE '🏢 Tenant demo ya existe';
    END IF;
END $$;

-- =====================================================
-- Crear vista para listar usuarios con su rol
-- =====================================================
CREATE OR REPLACE VIEW public.usuarios_con_rol AS
SELECT 
    id,
    email,
    raw_user_meta_data->>'nombre' as nombre,
    raw_user_meta_data->>'rol' as rol,
    raw_user_meta_data->>'tenant_id' as tenant_id,
    created_at,
    last_sign_in_at
FROM auth.users
WHERE raw_user_meta_data->>'rol' IS NOT NULL;

-- Crear tabla subscriptions
CREATE TABLE IF NOT EXISTS public.subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    plan TEXT NOT NULL CHECK (plan IN ('freemium', 'premium', 'enterprise')),
    status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'trial')),
    start_date TIMESTAMPTZ NOT NULL DEFAULT now(),
    end_date TIMESTAMPTZ,
    stripe_session_id TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Índices (corregido con IF NOT EXISTS)
CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant_id ON public.subscriptions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON public.subscriptions(status);

-- Trigger para actualizar updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Evita error si el trigger ya existe
DROP TRIGGER IF EXISTS update_subscriptions_updated_at ON public.subscriptions;
CREATE TRIGGER update_subscriptions_updated_at
    BEFORE UPDATE ON public.subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Políticas RLS
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- Eliminar políticas existentes para evitar duplicados
DROP POLICY IF EXISTS "Super admin todo en subscriptions" ON public.subscriptions;
DROP POLICY IF EXISTS "Admin ve sus suscripciones" ON public.subscriptions;

-- Super admin: todo
CREATE POLICY "Super admin todo en subscriptions" ON public.subscriptions
    FOR ALL TO authenticated
    USING (public.is_super_admin())
    WITH CHECK (public.is_super_admin());

-- Admin (tenant) solo lectura de sus propias suscripciones
CREATE POLICY "Admin ve sus suscripciones" ON public.subscriptions
    FOR SELECT TO authenticated
    USING (tenant_id = public.get_user_tenant_id() AND (auth.jwt() ->> 'user_metadata')::jsonb ->> 'rol' = 'admin');

-- Eliminar política si ya existe (para evitar error 42710)
DROP POLICY IF EXISTS "Admin actualiza su suscripción" ON public.subscriptions;

-- Política para que admin pueda actualizar su propia suscripción
CREATE POLICY "Admin actualiza su suscripción" ON public.subscriptions
    FOR UPDATE TO authenticated
    USING (
        tenant_id = public.get_user_tenant_id() 
        AND (auth.jwt() ->> 'user_metadata')::jsonb ->> 'rol' = 'admin'
    )
    WITH CHECK (
        tenant_id = public.get_user_tenant_id() 
        AND (auth.jwt() ->> 'user_metadata')::jsonb ->> 'rol' = 'admin'
    );
   -- =====================================================
-- FIX: Trigger para suscripción automática + suscripción del tenant demo existente
-- =====================================================

-- 1. Asegurar que la función existe (idempotente)
CREATE OR REPLACE FUNCTION public.create_initial_subscription()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.subscriptions (tenant_id, plan, status, start_date)
    VALUES (NEW.id, COALESCE(NEW.plan, 'freemium'), 'active', now());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Eliminar trigger si ya existe y volver a crearlo
DROP TRIGGER IF EXISTS trg_create_subscription_on_tenant ON public.tenants;
CREATE TRIGGER trg_create_subscription_on_tenant
    AFTER INSERT ON public.tenants
    FOR EACH ROW
    EXECUTE FUNCTION public.create_initial_subscription();

-- 3. Insertar suscripción para el tenant demo si aún no la tiene
INSERT INTO public.subscriptions (tenant_id, plan, status, start_date)
SELECT 'd7741079-3f87-4ce7-872c-8b1d4d90e8da', 'freemium', 'active', now()
WHERE NOT EXISTS (
    SELECT 1 FROM public.subscriptions 
    WHERE tenant_id = 'd7741079-3f87-4ce7-872c-8b1d4d90e8da'
);

-- 4. Verificar (opcional, muestra resultado)
SELECT * FROM public.subscriptions WHERE tenant_id = 'd7741079-3f87-4ce7-872c-8b1d4d90e8da';

-- =====================================================
-- MIGRACIÓN TAREA #5 (con modificación del constraint)
-- =====================================================
DO $$
BEGIN
    -- 1. Eliminar constraint antiguo
    ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_plan_check;
    
    -- 2. Crear nuevo constraint con los planes finales
    ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_plan_check
        CHECK (plan IN ('freemium', 'pro', 'premium_anual'));
    
    -- 3. Renombrar planes
    UPDATE public.subscriptions
    SET plan = CASE
        WHEN plan = 'premium' THEN 'pro'
        WHEN plan = 'enterprise' THEN 'premium_anual'
        ELSE plan
    END;
    
    -- 4. Recalcular end_date para 'pro' activas sin fecha fin
    UPDATE public.subscriptions
    SET end_date = start_date + INTERVAL '1 month'
    WHERE plan = 'pro' AND status = 'active' AND end_date IS NULL;
    
    -- 5. Recalcular end_date para 'premium_anual' activas sin fecha fin
    UPDATE public.subscriptions
    SET end_date = start_date + INTERVAL '1 year'
    WHERE plan = 'premium_anual' AND status = 'active' AND end_date IS NULL;
    
    -- 6. Asegurar que freemium tenga end_date NULL
    UPDATE public.subscriptions
    SET end_date = NULL
    WHERE plan = 'freemium';
    
    RAISE NOTICE '✅ Migración Tarea #5 completada';
END $$;

-- (Opcional) Verificar resultado
SELECT * FROM public.subscriptions WHERE tenant_id = 'd7741079-3f87-4ce7-872c-8b1d4d90e8da';

-- Crear tabla tenant_config
CREATE TABLE IF NOT EXISTS public.tenant_config (
    tenant_id UUID PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
    primary_color TEXT DEFAULT '#9d4edd',
    secondary_color TEXT DEFAULT '#ff6d00',
    logo_url TEXT,
    custom_css TEXT,
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_config_tenant_id ON public.tenant_config(tenant_id);

-- Trigger
CREATE OR REPLACE FUNCTION update_tenant_config_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tenant_config_updated_at ON public.tenant_config;
CREATE TRIGGER trg_tenant_config_updated_at
    BEFORE UPDATE ON public.tenant_config
    FOR EACH ROW
    EXECUTE FUNCTION update_tenant_config_updated_at();

-- RLS
ALTER TABLE public.tenant_config ENABLE ROW LEVEL SECURITY;

-- Eliminar políticas antiguas (esto evita el error 42710)
DROP POLICY IF EXISTS "Super admin todo en tenant_config" ON public.tenant_config;
DROP POLICY IF EXISTS "Admin gestiona su tenant_config" ON public.tenant_config;
DROP POLICY IF EXISTS "Lectura tenant_config por tenant" ON public.tenant_config;

-- Crear políticas nuevas
CREATE POLICY "Super admin todo en tenant_config" ON public.tenant_config
    FOR ALL TO authenticated
    USING (public.is_super_admin())
    WITH CHECK (public.is_super_admin());

CREATE POLICY "Admin gestiona su tenant_config" ON public.tenant_config
    FOR ALL TO authenticated
    USING (tenant_id = public.get_user_tenant_id() AND (auth.jwt() ->> 'user_metadata')::jsonb ->> 'rol' = 'admin')
    WITH CHECK (tenant_id = public.get_user_tenant_id());

CREATE POLICY "Lectura tenant_config por tenant" ON public.tenant_config
    FOR SELECT TO authenticated
    USING (tenant_id = public.get_user_tenant_id());

-- Insertar configuración por defecto
INSERT INTO public.tenant_config (tenant_id, primary_color, secondary_color)
SELECT id, '#9d4edd', '#ff6d00'
FROM public.tenants t
WHERE NOT EXISTS (SELECT 1 FROM public.tenant_config c WHERE c.tenant_id = t.id);
