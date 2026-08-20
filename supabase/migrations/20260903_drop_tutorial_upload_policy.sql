-- ============================================================
-- MIGRACIÓN: Eliminar política temporal de subida anon del tutorial
-- Fecha: 2026-08-19
--
-- El video tutorial-crear-servicio.mp4 ya fue subido al bucket
-- público 'tutoriales' (ver 20260902_tutoriales_bucket.sql).
-- Se retira la política INSERT para anon: el bucket queda solo
-- lectura pública; futuras actualizaciones del video se hacen
-- desde el dashboard de Supabase (rol service_role).
--
-- Script lineal, idempotente, sin DO $$.
-- ============================================================

DROP POLICY IF EXISTS "anon_upload_tutorial_servicio" ON storage.objects;
