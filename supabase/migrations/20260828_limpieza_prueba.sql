-- ============================================================
-- MIGRACIÓN: Limpieza de residuos de la prueba de ataques
-- (tenant de prueba creado por la migración 20260827 fallida)
-- ============================================================
DELETE FROM public.subscriptions WHERE tenant_id = '99999999-9999-4999-8999-999999999999';
DELETE FROM public.tenants WHERE id = '99999999-9999-4999-8999-999999999999';
DROP FUNCTION IF EXISTS public.prueba_resultado_seg();

NOTIFY pgrst, 'reload schema';

SELECT '✅ Residuos de prueba eliminados' AS status;
