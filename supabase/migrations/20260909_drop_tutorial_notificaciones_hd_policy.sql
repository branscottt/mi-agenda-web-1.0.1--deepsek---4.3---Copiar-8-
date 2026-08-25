-- ============================================================
-- MIGRACIÓN: Limpieza de la política TEMPORAL de subida del
-- video tutorial de Notificaciones en alta calidad.
-- Fecha: 2026-09-08
--
-- Elimina la política anon de subida creada en 20260908 (el
-- objeto ya fue subido). El bucket queda público-solo-lectura.
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

DROP POLICY IF EXISTS "anon_upload_tutorial_notif_hd" ON storage.objects;
