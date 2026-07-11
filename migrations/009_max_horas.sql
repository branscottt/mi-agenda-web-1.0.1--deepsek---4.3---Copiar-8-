-- Columna: horario_max_semanal (horas máximas por semana, opcional)
ALTER TABLE public.trabajadores ADD COLUMN IF NOT EXISTS horario_max_semanal INT;
NOTIFY pgrst, 'reload schema';
