-- ============================================================
-- MIGRACIÓN: Limpieza de la política TEMPORAL de subida del
-- video tutorial de Citas Programadas.
-- Fecha: 2026-09-11
--
-- Elimina la política anon de subida creada en 20260911 (el
-- objeto ya fue subido). El bucket queda público-solo-lectura.
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

DROP POLICY IF EXISTS "anon_upload_tutorial_citas" ON storage.objects;
