-- ============================================================
-- VERIFICACIÓN DE SEGURIDAD
-- Ejecutar en Supabase SQL Editor (Dashboard > SQL Editor)
--
-- Verifica:
--   - RLS policies activas por tabla
--   - Permisos actuales de anon
--   - CHECK constraints
--   - Funciones SECURITY DEFINER y sus permisos
--   - Storage buckets
-- ============================================================

-- ============================================================
-- 1. RLS POLICIES ACTIVAS
-- ============================================================
SELECT '[1/5] RLS Policies activas' AS paso;
SELECT schemaname, tablename, policyname, permissive, roles, cmd,
       substring(qual::text, 1, 80) AS qual_resumido
FROM pg_policies
WHERE tablename IN ('citas','servicios','tenants','trabajadores',
                    'servicios_trabajadores','tenant_config',
                    'notificaciones_admin','subscriptions',
                    'usuarios_con_rol')
ORDER BY tablename, policyname;

-- ============================================================
-- 2. PERMISOS DE ANON (debe mostrar solo SELECT e INSERT)
-- ============================================================
SELECT '[2/5] Permisos de anon en tablas públicas' AS paso;
SELECT table_schema, table_name, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
FROM information_schema.table_privileges
WHERE grantee = 'anon'
  AND table_schema = 'public'
GROUP BY table_schema, table_name
ORDER BY table_name;

-- ============================================================
-- 3. CHECK CONSTRAINTS
-- ============================================================
SELECT '[3/5] CHECK constraints activas' AS paso;
SELECT conrelid::regclass AS table_name,
       conname AS constraint_name,
       pg_get_constraintdef(c.oid) AS constraint_def
FROM pg_constraint c
JOIN pg_namespace n ON n.oid = c.connamespace
WHERE n.nspname = 'public'
  AND contype = 'c'
ORDER BY table_name, constraint_name;

-- ============================================================
-- 4. FUNCIONES SECURITY DEFINER + permisos de anon
-- ============================================================
SELECT '[4/5] Funciones SECURITY DEFINER' AS paso;
SELECT n.nspname AS schema_name,
       p.proname AS function_name,
       CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'SECURITY INVOKER' END AS security,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosecdef = true
ORDER BY p.proname;

-- ============================================================
-- 5. STORAGE BUCKETS
-- ============================================================
SELECT '[5/5] Storage buckets' AS paso;
SELECT id AS bucket_name,
       public,
       file_size_limit,
       allowed_mime_types
FROM storage.buckets
ORDER BY id;

-- ============================================================
-- RESUMEN FINAL
-- ============================================================
SELECT '[RESUMEN] Verificación completada' AS estado;
