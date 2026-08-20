-- ============================================================
-- MIGRACIÓN: Bucket público 'tutoriales' para el video tutorial
-- de la sección Crear Servicio (admin).
-- Fecha: 2026-08-19
--
-- 1) Crea el bucket público 'tutoriales' (50MB máx, solo video/mp4).
-- 2) Política TEMPORAL de subida para rol anon: permite SOLO crear
--    el objeto exacto 'tutorial-crear-servicio.mp4' en ese bucket
--    (necesaria para subir el archivo vía REST API con la anon key;
--    se elimina en la migración siguiente 20260903).
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('tutoriales', 'tutoriales', true, 52428800, ARRAY['video/mp4'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "anon_upload_tutorial_servicio" ON storage.objects;
CREATE POLICY "anon_upload_tutorial_servicio" ON storage.objects
FOR INSERT TO anon
WITH CHECK (bucket_id = 'tutoriales' AND name = 'tutorial-crear-servicio.mp4');
