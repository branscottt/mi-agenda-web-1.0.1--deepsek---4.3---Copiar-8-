-- ============================================================
-- MIGRACIÓN: Política TEMPORAL de subida para el video tutorial
-- de la sección Compartir con Clientes (admin).
-- Fecha: 2026-08-21
--
-- 1) Asegura el bucket público 'tutoriales' (ya existe, ON CONFLICT
--    DO NOTHING — idempotente).
-- 2) Política TEMPORAL de subida para rol anon: permite SOLO crear
--    el objeto exacto 'tutorial-compartir-clientes.mp4' en ese bucket
--    (necesaria para subir el archivo vía REST API con la anon key;
--    se elimina en la migración siguiente 20260905).
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('tutoriales', 'tutoriales', true, 52428800, ARRAY['video/mp4'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "anon_upload_tutorial_compartir" ON storage.objects;
CREATE POLICY "anon_upload_tutorial_compartir" ON storage.objects
FOR INSERT TO anon
WITH CHECK (bucket_id = 'tutoriales' AND name = 'tutorial-compartir-clientes.mp4');
