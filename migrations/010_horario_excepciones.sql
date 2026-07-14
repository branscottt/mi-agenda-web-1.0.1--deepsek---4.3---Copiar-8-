-- Columna: horario_excepciones (excepciones por semana ISO)
-- Permite tener horarios diferentes por semana sin modificar la plantilla base
-- Estructura: { "2026-W29": { "1": {...}, "2": {...} }, "2026-W30": {...} }
ALTER TABLE public.trabajadores ADD COLUMN IF NOT EXISTS horario_excepciones JSONB DEFAULT '{}'::jsonb;
NOTIFY pgrst, 'reload schema';
