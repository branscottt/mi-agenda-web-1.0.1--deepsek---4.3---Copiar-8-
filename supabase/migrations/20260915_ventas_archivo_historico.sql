-- ============================================================
-- MIGRACIÓN: Archivo histórico de ventas
-- Fecha: 2026-08-25
--
-- Problema: el Dashboard Financiero deriva las ventas de la tabla
-- `citas`, pero la limpieza automática (limpiarExpiradas) borra las
-- citas con fecha pasada cada 10 min → el histórico desaparece y el
-- total del mes "baja solo".
--
-- Solución: nueva tabla `ventas` (archivo). Un trigger BEFORE DELETE
-- en `citas` archiva la cita eliminada ANTES de que se borre, solo si
-- su fecha ya pasó (mismo criterio `fecha < hoy` que la limpieza).
-- Las cancelaciones de citas futuras NO se archivan como venta.
-- El front (VentasManager.getAll) lee citas vigentes + ventas.
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: Tabla de ventas archivadas
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ventas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid,
    cita_id text,
    servicio_id bigint,
    precio numeric(10,2),
    contacto jsonb,
    fecha date,
    hora text,
    fecha_venta timestamp without time zone,
    archivado_en timestamp without time zone DEFAULT now(),
    CONSTRAINT ventas_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_ventas_tenant ON public.ventas USING btree (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ventas_cita ON public.ventas USING btree (cita_id);

ALTER TABLE public.ventas ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- PASO 2: RLS (mismo aislamiento que citas)
-- ============================================================
DROP POLICY IF EXISTS "Admin ve ventas de su tenant" ON public.ventas;
CREATE POLICY "Admin ve ventas de su tenant"
  ON public.ventas FOR SELECT TO authenticated
  USING ((tenant_id = public.get_user_tenant_id()) AND public.is_admin());

DROP POLICY IF EXISTS "Anon lee ventas de su tenant" ON public.ventas;
CREATE POLICY "Anon lee ventas de su tenant"
  ON public.ventas FOR SELECT TO public
  USING ((tenant_id)::text = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS "Super admin todo en ventas" ON public.ventas;
CREATE POLICY "Super admin todo en ventas"
  ON public.ventas TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

-- ============================================================
-- PASO 3: Trigger que archiva la cita al borrarse
-- Solo se archivan citas con fecha ya pasada (criterio de la limpieza).
-- SECURITY DEFINER para poder insertar en `ventas` sin depender de
-- los permisos RLS del usuario que borra (admin o cliente).
-- ============================================================
CREATE OR REPLACE FUNCTION public.archivar_venta_al_borrar_cita()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
    IF OLD.fecha < CURRENT_DATE THEN
        INSERT INTO public.ventas (tenant_id, cita_id, servicio_id, precio, contacto, fecha, hora, fecha_venta)
        VALUES (OLD.tenant_id, OLD.id, OLD.servicio_id, OLD.precio, OLD.contacto, OLD.fecha, OLD.hora, OLD.created_at);
    END IF;
    RETURN OLD;
END;
$$;

ALTER FUNCTION public.archivar_venta_al_borrar_cita() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_archivar_venta ON public.citas;
CREATE TRIGGER trg_archivar_venta
    BEFORE DELETE ON public.citas
    FOR EACH ROW
    EXECUTE FUNCTION public.archivar_venta_al_borrar_cita();
