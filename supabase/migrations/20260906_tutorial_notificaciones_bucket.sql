-- ============================================================
-- MIGRACIÓN: Política TEMPORAL de subida para el video tutorial
-- de Notificaciones (popover de la campana, admin).
-- Fecha: 2026-09-06
--
-- 1) Asegura el bucket público 'tutoriales' (ya existe, ON CONFLICT
--    DO NOTHING — idempotente).
-- 2) Política TEMPORAL de subida para rol anon: permite SOLO crear
--    el objeto exacto 'tutorial-notificaciones.mp4' en ese bucket
--    (necesaria para subir el archivo vía REST API con la anon key;
--    se elimina en la migración siguiente 20260907).
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('tutoriales', 'tutoriales', true, 52428800, ARRAY['video/mp4'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "anon_upload_tutorial_notificaciones" ON storage.objects;
CREATE POLICY "anon_upload_tutorial_notificaciones" ON storage.objects
FOR INSERT TO anon
WITH CHECK (bucket_id = 'tutoriales' AND name = 'tutorial-notificaciones.mp4');
