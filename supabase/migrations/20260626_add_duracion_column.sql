-- Migración: agregar columna duracion a la tabla servicios
-- Ejecutar en Supabase SQL Editor
-- Creada: 2026-06-26
-- Motivo: persistencia de duración por turno en el módulo de servicios del admin

ALTER TABLE servicios
ADD COLUMN IF NOT EXISTS duracion INTEGER NOT NULL DEFAULT 60;

-- Poblar registros existentes que pudieran quedar en NULL (seguridad)
UPDATE servicios SET duracion = 60 WHERE duracion IS NULL;
