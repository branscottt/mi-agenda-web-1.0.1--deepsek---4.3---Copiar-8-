-- Permitir notificaciones de "servicio expirado" (cards auto-eliminadas en admin)
-- El frontend legacy inserta tipo='servicio-expirado' desde el cliente admin.
ALTER TABLE public.notificaciones_admin DROP CONSTRAINT notificaciones_tipo_check;
ALTER TABLE public.notificaciones_admin ADD CONSTRAINT notificaciones_tipo_check CHECK (tipo = ANY (ARRAY['cancelacion', 'reprogramacion', 'nueva_reserva', 'recordatorio', 'servicio-expirado']));
