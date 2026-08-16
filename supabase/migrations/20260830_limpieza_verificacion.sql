-- ============================================================
-- MIGRACIÓN: Limpieza de funciones temporales de verificación
-- ============================================================
DROP FUNCTION IF EXISTS public.verif_inventario_final2();
DROP FUNCTION IF EXISTS public.verif_inventario_final();
DROP FUNCTION IF EXISTS public.verif_inventario_policies();
DROP FUNCTION IF EXISTS public.verif_esquema_tablas();
DROP FUNCTION IF EXISTS public.verif_firmas_coupon();
DROP FUNCTION IF EXISTS public.prueba_resultado_seg();

NOTIFY pgrst, 'reload schema';

SELECT '✅ Funciones temporales de verificación eliminadas' AS status;
