-- ============================================================
-- MIGRACIÓN: Sistema Multi-Trabajador
-- Tablas: trabajadores, servicios_trabajadores
-- Columna: citas.trabajador_id
-- Script lineal, sin DO $$, secuencial, idempotente.
-- Ejecutar en Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================

-- 1. Tabla trabajadores
CREATE TABLE IF NOT EXISTS public.trabajadores (
    id UUID DEFAULT gen_random_uuid() NOT NULL,
    tenant_id UUID NOT NULL,
    nombre TEXT NOT NULL,
    email TEXT,
    telefono TEXT,
    habilidades TEXT DEFAULT '',
    color TEXT DEFAULT '#9d4edd',
    activo BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT trabajadores_pkey PRIMARY KEY (id),
    CONSTRAINT trabajadores_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE
);

ALTER TABLE public.trabajadores ENABLE ROW LEVEL SECURITY;

-- 2. Tabla servicios_trabajadores (N:N)
CREATE TABLE IF NOT EXISTS public.servicios_trabajadores (
    servicio_id BIGINT NOT NULL,
    trabajador_id UUID NOT NULL,
    CONSTRAINT servicios_trabajadores_pkey PRIMARY KEY (servicio_id, trabajador_id),
    CONSTRAINT st_servicio_id_fkey FOREIGN KEY (servicio_id) REFERENCES public.servicios(id) ON DELETE CASCADE,
    CONSTRAINT st_trabajador_id_fkey FOREIGN KEY (trabajador_id) REFERENCES public.trabajadores(id) ON DELETE CASCADE
);

ALTER TABLE public.servicios_trabajadores ENABLE ROW LEVEL SECURITY;

-- 3. Columna trabajador_id en citas (nullable)
ALTER TABLE public.citas ADD COLUMN IF NOT EXISTS trabajador_id UUID;
ALTER TABLE public.citas ADD CONSTRAINT citas_trabajador_id_fkey 
    FOREIGN KEY (trabajador_id) REFERENCES public.trabajadores(id);

-- 4. Índices
CREATE INDEX IF NOT EXISTS idx_trabajadores_tenant ON public.trabajadores(tenant_id);
CREATE INDEX IF NOT EXISTS idx_trabajadores_activo ON public.trabajadores(activo);
CREATE INDEX IF NOT EXISTS idx_st_servicio ON public.servicios_trabajadores(servicio_id);
CREATE INDEX IF NOT EXISTS idx_st_trabajador ON public.servicios_trabajadores(trabajador_id);
CREATE INDEX IF NOT EXISTS idx_citas_trabajador ON public.citas(trabajador_id);

-- =====================================================
-- POLÍTICAS RLS
-- =====================================================

-- Trabajadores: admin puede todo en su tenant
CREATE POLICY "Admin todo en trabajadores de su tenant" ON public.trabajadores
    FOR ALL TO authenticated
    USING (
        tenant_id = public.get_user_tenant_id()
        AND (auth.jwt() ->> 'user_metadata')::jsonb ->> 'rol' = 'admin'
    )
    WITH CHECK (
        tenant_id = public.get_user_tenant_id()
    );

-- Trabajadores: anon puede leer (para vista cliente y portal trabajador)
CREATE POLICY "Anon puede leer trabajadores activos" ON public.trabajadores
    FOR SELECT TO anon
    USING (activo = true);

-- Trabajadores: authenticated puede leer (admin y trabajador)
CREATE POLICY "Auth puede leer trabajadores" ON public.trabajadores
    FOR SELECT TO authenticated
    USING (true);

-- Servicios_Trabajadores: admin puede todo
CREATE POLICY "Admin todo en servicios_trabajadores" ON public.servicios_trabajadores
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.servicios s
            WHERE s.id = servicio_id
            AND s.tenant_id = public.get_user_tenant_id()
        )
        AND (auth.jwt() ->> 'user_metadata')::jsonb ->> 'rol' = 'admin'
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.servicios s
            WHERE s.id = servicio_id
            AND s.tenant_id = public.get_user_tenant_id()
        )
    );

-- Servicios_Trabajadores: anon puede leer
CREATE POLICY "Anon puede leer servicios_trabajadores" ON public.servicios_trabajadores
    FOR SELECT TO anon
    USING (true);

-- Servicios_Trabajadores: authenticated puede leer
CREATE POLICY "Auth puede leer servicios_trabajadores" ON public.servicios_trabajadores
    FOR SELECT TO authenticated
    USING (true);

-- 5. Recargar caché de PostgREST
NOTIFY pgrst, 'reload schema';
