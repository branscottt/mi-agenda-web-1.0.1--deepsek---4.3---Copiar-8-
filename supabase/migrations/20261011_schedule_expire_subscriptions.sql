-- ============================================================
-- Migration: Agendar expiración automática de suscripciones
-- Fecha: 2026-10-11
--
-- CONTEXTO: la migración 20260703_auto_expire_subscriptions creó
-- public.expirar_suscripciones_vencidas() y su cron.schedule,
-- pero en ese momento pg_cron NO estaba instalado en prod, así
-- que el job jamás se registró (código muerto silencioso). Con
-- pg_cron habilitado (migración 20261010), se agenda ahora el
-- job horario que estaba previsto: minuto 0 de cada hora.
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- (Re)agendar el job horario (unschedule previo = idempotente)
SELECT cron.unschedule('expire-subscriptions-hourly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'expire-subscriptions-hourly');

SELECT cron.schedule(
    'expire-subscriptions-hourly',
    '0 * * * *',
    'SELECT public.expirar_suscripciones_vencidas();'
);

-- ============================================================
-- VERIFICACIÓN
-- ============================================================
SELECT '[EXPIRE] Job agendado: expire-subscriptions-hourly (cada hora, minuto 0)' AS status;
