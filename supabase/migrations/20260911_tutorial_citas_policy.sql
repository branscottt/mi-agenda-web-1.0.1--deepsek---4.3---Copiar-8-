-- ============================================================
-- MIGRACIÓN: Política TEMPORAL de subida para el video tutorial
-- de Citas Programadas (864x1920).
-- Fecha: 2026-09-11
--
-- 1) Asegura el bucket público 'tutoriales' (ON CONFLICT DO
--    NOTHING — idempotente).
-- 2) Política TEMPORAL de subida para rol anon: permite SOLO
--    crear el objeto exacto 'tutorial-citas-programadas.mp4'
--    (necesaria para subir el archivo vía REST API con la anon
--    key; se elimina en la migración siguiente 20260912).
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('tutoriales', 'tutoriales', true, 52428800, ARRAY['video/mp4'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "anon_upload_tutorial_citas" ON storage.objects;
CREATE POLICY "anon_upload_tutorial_citas" ON storage.objects
FOR INSERT TO anon
WITH CHECK (bucket_id = 'tutoriales' AND name = 'tutorial-citas-programadas.mp4');
