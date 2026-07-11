-- ============================================================
-- MIGRACIÓN: Tipo de jornada y horario semanal por trabajador
-- Columnas: tipo_jornada TEXT, horario_semanal JSONB
-- Script lineal, secuencial, idempotente.
-- ============================================================

-- 1. tipo_jornada: full_time, part_time, 30hrs, custom
ALTER TABLE public.trabajadores ADD COLUMN IF NOT EXISTS tipo_jornada TEXT;
UPDATE public.trabajadores SET tipo_jornada = 'full_time' WHERE tipo_jornada IS NULL;
ALTER TABLE public.trabajadores ALTER COLUMN tipo_jornada SET DEFAULT 'full_time';
ALTER TABLE public.trabajadores ALTER COLUMN tipo_jornada SET NOT NULL;

-- 2. horario_semanal: JSONB con horarios por día de la semana
-- Estructura: {"1": {"activo": true, "inicio": "09:00", "fin": "18:00"}, ...}
-- Keys: 1=Lunes, 2=Martes, 3=Miércoles, 4=Jueves, 5=Viernes, 6=Sábado, 7=Domingo
ALTER TABLE public.trabajadores ADD COLUMN IF NOT EXISTS horario_semanal JSONB;

-- Valor por defecto: full time (lun-vie 9-18, sáb 9-14, dom descanso)
UPDATE public.trabajadores 
SET horario_semanal = '{
  "1": {"activo": true, "inicio": "09:00", "fin": "18:00"},
  "2": {"activo": true, "inicio": "09:00", "fin": "18:00"},
  "3": {"activo": true, "inicio": "09:00", "fin": "18:00"},
  "4": {"activo": true, "inicio": "09:00", "fin": "18:00"},
  "5": {"activo": true, "inicio": "09:00", "fin": "18:00"},
  "6": {"activo": true, "inicio": "09:00", "fin": "14:00"},
  "7": {"activo": false, "inicio": "00:00", "fin": "00:00"}
}'::jsonb
WHERE horario_semanal IS NULL;

ALTER TABLE public.trabajadores ALTER COLUMN horario_semanal SET DEFAULT '{}'::jsonb;
ALTER TABLE public.trabajadores ALTER COLUMN horario_semanal SET NOT NULL;

-- 3. Recargar caché
NOTIFY pgrst, 'reload schema';
