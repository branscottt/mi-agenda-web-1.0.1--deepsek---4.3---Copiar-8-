-- ============================================================
-- MIGRACIÓN: Ubicación de la pyme (Personalizar estilo)
-- Fecha: 2026-09-30
--
-- PROBLEMA: los negocios no pueden configurar cómo manejan la
-- ubicación: o muestran su local (el cliente va a ellos) o van
-- al domicilio del cliente (plomeros, técnicos, etc.).
--
-- SOLUCIÓN: dos columnas nuevas en tenant_config (mismo patrón
-- que instagram_url/tiktok_url):
--   ubicacion_tipo TEXT NULL -> 'local' | 'domicilio' | NULL
--     - 'local'     : la vista cliente muestra dirección + mapa
--                     + enlace a Google Maps (campo direccion).
--     - 'domicilio' : el cliente debe escribir su dirección al
--                     reservar; queda en citas.contacto.direccion
--                     y se muestra en el panel admin.
--     - NULL/vacío : comportamiento actual (nada se muestra, la
--                     reserva no pide dirección). Tenants nuevos
--                     sin configurar no ven cambios.
--   direccion TEXT NULL -> dirección del local (modo local).
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: Columnas en tenant_config
-- ============================================================
ALTER TABLE public.tenant_config ADD COLUMN IF NOT EXISTS ubicacion_tipo TEXT;
ALTER TABLE public.tenant_config ADD COLUMN IF NOT EXISTS direccion TEXT;
