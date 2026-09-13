-- ============================================================
-- Migration: Quitar la suspensión automática de tenants + freemium sin vencimiento
-- Fecha: 2026-09-13
--
-- CONTEXTO (evidencia real en producción, 2026-09-13):
--   La función public.expirar_suscripciones_vencidas() que corría en prod
--   NO era la de la migración 20260703: tenía un UPDATE extra (aplicado
--   directo en la base, nunca versionado) que suspendía tenants:
--
--     UPDATE public.tenants t SET estado = 'inactivo'
--     WHERE t.estado = 'activo'
--       AND NOT EXISTS (SELECT 1 FROM public.subscriptions s
--                       WHERE s.tenant_id = t.id AND s.status = 'active'
--                         AND (s.end_date IS NULL OR s.end_date >= NOW()));
--
--   Como el cron "expire-subscriptions-hourly" la ejecuta cada hora en punto,
--   CUALQUIER tenant sin suscripción activa vigente quedaba en "Suspendido
--   por administración" (HubView.js:199-207 oculta el botón Entrar).
--   audit_log lo confirma: 5 tenants activo→inactivo con user_id = NULL y
--   timestamps exactos xx:00:00 (tarea programada, no un superadmin):
--     - rafa                    2026-09-07 11:00
--     - Vertex hp center        2026-09-07 11:00
--     - bran coach              2026-09-12 13:00
--     - Dra. Javiera Lara       2026-09-12 15:00
--     - Miu Street workout      2026-09-12 22:00  (10 citas, 1 trabajador)
--
--   Además: al pasar un tenant de Free Trial a Freemium, el superadmin
--   sincronizaba el plan en subscriptions (script.js:6439) pero NO limpiaba
--   end_date → la suscripción "freemium" (plan gratis para siempre) heredaba
--   el vencimiento del trial y el cron la expiraba.
--
-- FIX:
--   1. expirar_suscripciones_vencidas() vuelve a la versión del repo
--      (20260703): SOLO expira suscripciones. NO toca tenants.
--      La suspensión de un tenant queda como acción manual del superadmin.
--   2. Reactivar los tenants que el cron suspendió.
--   3. Freemium (gratis para siempre) nunca vence → end_date = NULL.
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: función sin suspensión de tenants (versión del repo)
-- ============================================================
CREATE OR REPLACE FUNCTION public.expirar_suscripciones_vencidas()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_count integer;
BEGIN
    -- Marcar suscripciones vencidas como inactivas.
    -- NO se suspende el tenant: sin plan activo el usuario va a planes.html,
    -- pero su cuenta y su workspace siguen activos (estado='activo').
    UPDATE public.subscriptions
    SET status = 'inactive'
    WHERE status = 'active'
      AND end_date IS NOT NULL
      AND end_date < NOW();

    GET DIAGNOSTICS v_count = ROW_COUNT;

    IF v_count > 0 THEN
        RAISE NOTICE '✅ % suscripción(es) vencida(s) marcada(s) como inactive', v_count;
    END IF;

    RETURN v_count;
END;
$$;

-- ============================================================
-- PASO 2: reactivar los tenants suspendidos por el cron
-- (los 5 del audit_log con user_id NULL; están nombrados en el contexto)
-- ============================================================
UPDATE public.tenants
SET estado = 'activo'
WHERE estado = 'inactivo'
  AND id IN (
    'bee07bcd-6c45-469b-aaf1-bf0e3481a3ca', -- Miu Street workout training
    '13a69b69-9b15-44c8-b9c3-8f0007041707', -- Dra. Javiera Lara
    '311d8841-bfea-4393-8f90-1ad1abad630d', -- bran coach
    'ec06ee5a-cb0e-492a-bf1e-b9eeebb7822a', -- Vertex hp center
    '43fd1a98-4bbb-448b-a12d-15448c3aa4e1'  -- rafa
  );

-- ============================================================
-- PASO 3: freemium es gratis para siempre → activo y sin fecha de fin
--
-- El superadmin asignó freemium (plan libre, sin vencimiento) a los
-- tenants que venían de Free Trial (audit_log: super@demo.com,
-- 2026-08-29). Al sincronizar el plan NO se limpió end_date → la fila
-- quedó 'freemium' con el vencimiento del trial, y el cron la expiró.
-- Se reactivan SOLO las filas freemium que tienen end_date (es decir,
-- las que fueron expiradas por el cron). El marcador freemium/inactive
-- con end_date NULL (creado por el trigger al registrar el tenant) NO se
-- toca: sigue siendo "sin plan elegido".
-- ============================================================
UPDATE public.subscriptions
SET status = 'active',
    end_date = NULL
WHERE plan = 'freemium'
  AND end_date IS NOT NULL
  AND status = 'inactive';

UPDATE public.subscriptions
SET end_date = NULL
WHERE plan = 'freemium'
  AND status = 'active'
  AND end_date IS NOT NULL;

-- ============================================================
-- VERIFICACIÓN
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '[SUSPENSION] auto-suspensión de tenants eliminada + tenants reactivados + freemium sin vencimiento' AS status;
