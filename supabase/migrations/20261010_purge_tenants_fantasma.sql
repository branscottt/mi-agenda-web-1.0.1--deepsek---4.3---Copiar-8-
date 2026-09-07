-- ============================================================
-- Migration: Purga automática de tenants fantasma
-- Fecha: 2026-10-10
--
-- PROBLEMA: los tenants que se crean (registro público) y no
-- rellenan ni usan la web quedan para siempre como "falsos".
--
-- SOLUCIÓN:
--   1. Habilita pg_cron (extensión en allowlist de Supabase).
--   2. Función purge_tenants_fantasma(p_meses, p_excluir_emails)
--      que elimina tenants "fantasma": sin servicios, sin citas,
--      sin config, sin trabajadores, sin pagos ni plan pagado,
--      con antigüedad >= p_meses. Borra suscripciones primero
--      (trigger prevent_tenant_delete_with_data bloquea si hay
--      subs activas), luego los usuarios auth del tenant y por
--      último el tenant (el resto de tablas cascada).
--      Cuentas de revisión (p_excluir_emails) jamás se tocan.
--   3. Cron diario 04:00 UTC que ejecuta la purga (2 meses).
--   4. Blindaje: solo postgres/service_role (nunca anon/auth).
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 0: Habilitar pg_cron (el job diario lo requiere)
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ============================================================
-- PASO 1: Función de purga (SECURITY DEFINER, ejecuta como postgres)
-- ============================================================
CREATE OR REPLACE FUNCTION public.purge_tenants_fantasma(
    p_meses INTEGER DEFAULT 2,
    p_excluir_emails TEXT[] DEFAULT ARRAY[
        'brandoncatalanmura@gmail.com',
        'admin@demo.com',
        'super@demo.com'
    ]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_total INTEGER;
    v_candidatos INTEGER := 0;
    v_eliminados INTEGER := 0;
    v_errores JSONB := '[]'::jsonb;
    v_tenant RECORD;
BEGIN
    SELECT count(*) INTO v_total FROM public.tenants;

    -- Candidato fantasma = activo, antigüedad >= p_meses, plan gratis,
    -- sin señales de uso real y sin relación con cuentas de revisión.
    FOR v_tenant IN
        SELECT t.id, t.nombre_negocio, t.email_contacto
        FROM public.tenants t
        WHERE t.estado = 'activo'
          AND t.fecha_registro < now() - make_interval(months => p_meses)
          AND (t.plan IS NULL OR t.plan = 'freemium')
          AND lower(coalesce(t.email_contacto, '')) <> ALL (
                SELECT lower(x) FROM unnest(p_excluir_emails) AS x
          )
          AND NOT EXISTS (
                SELECT 1 FROM public.user_roles r
                JOIN auth.users u ON u.id = r.user_id
                WHERE r.tenant_id = t.id
                  AND (
                        lower(coalesce(u.email, '')) = ANY (
                            SELECT lower(x) FROM unnest(p_excluir_emails) AS x
                        )
                        OR r.rol = 'super_admin'
                  )
          )
          AND NOT EXISTS (SELECT 1 FROM public.servicios s WHERE s.tenant_id = t.id)
          AND NOT EXISTS (SELECT 1 FROM public.citas c WHERE c.tenant_id = t.id)
          AND NOT EXISTS (SELECT 1 FROM public.tenant_config tc WHERE tc.tenant_id = t.id)
          AND NOT EXISTS (SELECT 1 FROM public.trabajadores w WHERE w.tenant_id = t.id)
          AND NOT EXISTS (SELECT 1 FROM public.clientes_manuales cm WHERE cm.tenant_id = t.id)
          AND NOT EXISTS (SELECT 1 FROM public.kanban_boards k WHERE k.tenant_id = t.id)
          AND NOT EXISTS (SELECT 1 FROM public.mercadopago_payments m WHERE m.tenant_id = t.id)
          AND NOT EXISTS (
                SELECT 1 FROM public.subscriptions s2
                WHERE s2.tenant_id = t.id AND s2.plan <> 'freemium'
          )
          AND NOT EXISTS (SELECT 1 FROM public.promo_video_coupons p WHERE p.tenant_id = t.id)
          AND NOT EXISTS (SELECT 1 FROM public.tenant_feedback f WHERE f.tenant_id = t.id)
          AND NOT EXISTS (SELECT 1 FROM public.pyme_resenas pr WHERE pr.tenant_id = t.id)
    LOOP
        v_candidatos := v_candidatos + 1;

        -- Bloque propio: si un tenant falla, el resto continúa
        BEGIN
            -- a) Suscripciones primero: prevent_tenant_delete_with_data
            --    bloquea el DELETE si quedan subs 'active'
            DELETE FROM public.subscriptions WHERE tenant_id = v_tenant.id;

            -- b) Usuarios auth del tenant (user_roles se va en cascada).
            --    Los super_admin jamás se eliminan.
            DELETE FROM auth.users u
            USING public.user_roles r
            WHERE r.user_id = u.id
              AND r.tenant_id = v_tenant.id
              AND r.rol <> 'super_admin';

            -- c) Tenant: servicios, citas, config, kanban, pagos,
            --    notificaciones, etc. se eliminan por CASCADE.
            DELETE FROM public.tenants WHERE id = v_tenant.id;

            v_eliminados := v_eliminados + 1;
            RAISE NOTICE 'purge_tenants_fantasma: tenant eliminado % (%)', v_tenant.nombre_negocio, v_tenant.email_contacto;
        EXCEPTION WHEN OTHERS THEN
            v_errores := v_errores || jsonb_build_object(
                'tenant_id', v_tenant.id,
                'negocio', v_tenant.nombre_negocio,
                'email', v_tenant.email_contacto,
                'error', SQLERRM
            );
            RAISE NOTICE 'purge_tenants_fantasma: fallo al eliminar % (%): %',
                v_tenant.nombre_negocio, v_tenant.email_contacto, SQLERRM;
        END;
    END LOOP;

    RETURN jsonb_build_object(
        'total_tenants', v_total,
        'candidatos', v_candidatos,
        'eliminados', v_eliminados,
        'errores', v_errores
    );
END;
$$;

-- ============================================================
-- PASO 2: Blindaje — solo postgres (cron/SQL editor) y service_role
-- ============================================================
REVOKE ALL ON FUNCTION public.purge_tenants_fantasma(INTEGER, TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_tenants_fantasma(INTEGER, TEXT[]) FROM anon;
REVOKE ALL ON FUNCTION public.purge_tenants_fantasma(INTEGER, TEXT[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_tenants_fantasma(INTEGER, TEXT[]) TO service_role;

-- ============================================================
-- PASO 3: Job diario 04:00 UTC (purga a los 2 meses)
-- ============================================================
SELECT cron.unschedule('purge-tenants-fantasma-diario')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-tenants-fantasma-diario');

SELECT cron.schedule(
    'purge-tenants-fantasma-diario',
    '0 4 * * *',
    'SELECT public.purge_tenants_fantasma(2);'
);

-- ============================================================
-- VERIFICACIÓN
-- ============================================================
SELECT '[PURGE] Migración completada: purge_tenants_fantasma + cron diario 04:00 UTC' AS status;
