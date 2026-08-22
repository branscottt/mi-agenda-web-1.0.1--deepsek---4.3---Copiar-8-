-- ============================================================
-- MIGRACIÓN: Eliminar política temporal de subida anon del tutorial
-- de Notificaciones (popover de la campana, admin).
-- Fecha: 2026-09-06
--
-- El video tutorial-notificaciones.mp4 ya fue subido al bucket
-- público 'tutoriales' (ver 20260906_tutorial_notificaciones_bucket.sql).
-- Se retira la política INSERT para anon: el bucket queda solo
-- lectura pública; futuras actualizaciones del video se hacen
-- desde el dashboard de Supabase (rol service_role).
--
-- Script lineal, idempotente, sin DO $$.
-- ============================================================

DROP POLICY IF EXISTS "anon_upload_tutorial_notificaciones" ON storage.objects;
