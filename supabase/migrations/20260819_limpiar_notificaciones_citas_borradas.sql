-- ============================================================
-- MIGRACIÓN: Limpiar notificaciones de reservas cuyas citas ya no existen
-- Fecha: 2026-08-19
--
-- Problema: al eliminar un servicio en admin, sus citas se borran
-- (requisito de la FK citas_servicio_id_fkey) pero las filas de
-- notificaciones_admin que referenciaban esas citas (tipo nueva_reserva,
-- cambio-admin, ...) quedan huérfanas y siguen apareciendo al admin
-- (en móvil no se ven por caché, en PC sí).
--
-- Solución (dos capas):
--   1) Limpieza única de huérfanas existentes (cita_id que ya no existe
--      en citas).
--   2) Trigger AFTER DELETE ON citas que borra las notificaciones de la
--      cita eliminada. SECURITY DEFINER (mismo patrón que audit_citas_trigger)
--      porque no existe policy DELETE para admin en notificaciones_admin
--      (solo super admin) — un delete desde el cliente fallaría por RLS.
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: Limpieza única de notificaciones huérfanas
-- ============================================================
DELETE FROM public.notificaciones_admin
WHERE cita_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM public.citas c WHERE c.id = notificaciones_admin.cita_id
  );

-- ============================================================
-- PASO 2: Función trigger que limpia notificaciones al borrar una cita
-- ============================================================
CREATE OR REPLACE FUNCTION public.limpiar_notificaciones_cita_borrada()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
    DELETE FROM public.notificaciones_admin
    WHERE cita_id = OLD.id;
    RETURN OLD;
END;
$$;

-- ============================================================
-- PASO 3: Trigger en citas
-- ============================================================
DROP TRIGGER IF EXISTS trg_limpiar_notificaciones_cita ON public.citas;
CREATE TRIGGER trg_limpiar_notificaciones_cita
    AFTER DELETE ON public.citas
    FOR EACH ROW EXECUTE FUNCTION public.limpiar_notificaciones_cita_borrada();

-- ============================================================
-- PASO 4: Refresh schema cache (PostgREST)
-- ============================================================
NOTIFY pgrst, 'reload schema';
