-- ============================================================
-- MIGRACIÓN: Eliminar política temporal de subida anon del tutorial
-- de Compartir con Clientes.
-- Fecha: 2026-08-21
--
-- El video tutorial-compartir-clientes.mp4 ya fue subido al bucket
-- público 'tutoriales' (ver 20260904_tutorial_compartir_bucket.sql).
-- Se retira la política INSERT para anon: el bucket queda solo
-- lectura pública; futuras actualizaciones del video se hacen
-- desde el dashboard de Supabase (rol service_role).
--
-- Script lineal, idempotente, sin DO $$.
-- ============================================================

DROP POLICY IF EXISTS "anon_upload_tutorial_compartir" ON storage.objects;
