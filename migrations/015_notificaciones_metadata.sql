-- MIGRACIÓN 015: Columna metadata (jsonb) para notificaciones_admin
-- Motivo: el módulo moderno de notificaciones (src/api/notificacionesApi.js)
-- lee y escribe la columna metadata (select L11, insert L28), pero el esquema
-- real de la tabla nunca la tuvo -> error 42703 "column notificaciones_admin.metadata
-- does not exist" -> el panel de notificaciones del admin no carga (catch silencioso).
-- El path legacy no usa esta columna: quedará null en filas existentes (compatible).
ALTER TABLE public.notificaciones_admin ADD COLUMN IF NOT EXISTS metadata jsonb;
