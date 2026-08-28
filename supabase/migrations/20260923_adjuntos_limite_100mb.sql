-- ============================================================
-- MIGRACIÓN: Límite de subida de adjuntos 25MB → 100MB
-- Fecha: 2026-09-23
--
-- PROBLEMA: el usuario quiere subir archivos más grandes en las
-- tarjetas de "Información del cliente" (el límite de 25MB se
-- queda corto para videos/PDF pesados).
--
-- SOLUCIÓN: subir file_size_limit del bucket 'kanban-adjuntos'
-- a 100MB (104857600 bytes). El upload va directo del navegador
-- a Supabase Storage (no pasa por Vercel), así que no hay otros
-- límites de infraestructura que tocar.
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

UPDATE storage.buckets
SET file_size_limit = 104857600
WHERE id = 'kanban-adjuntos';

NOTIFY pgrst, 'reload schema';

SELECT '✅ Límite de adjuntos subido a 100MB' AS status;
