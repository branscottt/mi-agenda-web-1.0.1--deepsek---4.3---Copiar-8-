-- ============================================
-- CREAR BUCKET service-images + POLÍTICAS RLS
-- ============================================
-- Ejecutar esto en SQL Editor de Supabase

-- 1. Crear el bucket (público, solo imágenes, max 10MB)
INSERT INTO storage.buckets (id, name, public, avif_autodetection, file_size_limit, allowed_mime_types)
VALUES ('service-images', 'service-images', true, false, 10485760, '{image/jpeg,image/png,image/webp}')
ON CONFLICT (id) DO NOTHING;

-- 2. Permitir SUBIR archivos a usuarios autenticados
CREATE POLICY "Usuarios autenticados pueden subir imágenes de servicio"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'service-images'
);

-- 3. Permitir LECTURA pública (para mostrar las imágenes en cards)
CREATE POLICY "Cualquiera puede leer imágenes de servicio"
ON storage.objects FOR SELECT TO public
USING (
  bucket_id = 'service-images'
);

-- 4. Permitir ACTUALIZAR a usuarios autenticados
CREATE POLICY "Usuarios autenticados pueden actualizar imágenes de servicio"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'service-images')
WITH CHECK (bucket_id = 'service-images');

-- 5. Permitir ELIMINAR a usuarios autenticados
CREATE POLICY "Usuarios autenticados pueden eliminar imágenes de servicio"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'service-images');

-- Opcional: si quieres aislar por tenant (recomendado)
-- Los archivos se guardan como {tenant_id}/{filename}
-- Así que la separación es por carpeta, no por RLS.
-- Si necesitas que un tenant no vea archivos de otro,
-- puedes agregar una policy más específica:
-- CREATE POLICY "Tenants solo ven sus propias imágenes"
-- ON storage.objects FOR SELECT TO authenticated
-- USING (
--   bucket_id = 'service-images'
--   AND (storage.foldername(name))[1] = (SELECT (raw_user_meta_data->>'tenant_id') FROM auth.users WHERE id = auth.uid())
-- );
