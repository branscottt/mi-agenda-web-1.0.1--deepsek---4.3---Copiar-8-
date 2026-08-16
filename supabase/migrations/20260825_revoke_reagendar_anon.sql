-- ============================================================
-- MIGRACIÓN: REVOKE de reagendar_cita a anon/public
-- Fecha: 2026-08-25
--
-- El RPC reagendar_cita se creó con GRANT EXECUTE TO authenticated,
-- pero en PostgreSQL el EXECUTE por defecto de PUBLIC no se revoca
-- automáticamente: cualquier rol (incluido anon) podía invocarla.
-- La función se protege sola (auth.uid() NULL -> rechaza), pero por
-- mínimo privilegio y consistencia con 20260815, el acceso queda
-- EXCLUSIVO de authenticated (reagendar siempre requiere sesión).
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.reagendar_cita(TEXT, UUID, DATE, TEXT) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.reagendar_cita(TEXT, UUID, DATE, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';

SELECT '✅ reagendar_cita: EXECUTE solo para authenticated (anon/public revocado)' AS status;
