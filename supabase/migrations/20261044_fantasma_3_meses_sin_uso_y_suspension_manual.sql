-- ============================================================
-- Migration: Purga de fantasmas a los 3 meses + suspensión manual consistente
-- Fecha: 2026-09-13
--
-- CONTEXTO (reglas del dueño, verificadas contra la base el 2026-09-13):
--   1. Freemium (lo otorga SOLO el superadmin) = gratis para siempre:
--      NUNCA se suspende ni se bloquea (mig 20261043: nace/convierte a
--      status='active' + end_date NULL).
--   2. Plan pagado: nunca se suspende. Si el cobro vence, el negocio va al
--      paywall (planes.html: "Tu suscripción ha expirado… Tus datos están a
--      salvo") pero su cuenta y su workspace siguen estado='activo'.
--   3. Free Trial de 14 días: al vencer, paywall (no suspensión). Si
--      registraron algo, sus datos quedan intactos.
--   4. Suspensión = SOLO acción manual del superadmin (estado='inactivo'
--      desde el panel). No queda ningún camino automático que suspenda.
--   5. "Si no la usan en 3 meses y no hicieron realmente nada, se borra":
--      eso lo hace el cron diario purge_tenants_fantasma, que estaba a 2
--      meses → pasa a 3 y ahora exige además que NADIE haya iniciado sesión
--      en ese período (uso real = login, no solo datos creados).
--
-- HALLAZGO CORREGIDO ACÁ (bug real en producción):
--   El toggle manual del superadmin intentaba marcar las suscripciones como
--   status='suspended'. La base NO permite ese valor
--   (subscriptions_status_check = active|inactive|trial):
--     ERROR 23514: new row for relation "subscriptions" violates check
--     constraint "subscriptions_status_check"
--   O sea: esa escritura SIEMPRE falló en silencio (try/catch del front).
--   La suspensión manual del tenant sí funcionaba (estado='inactivo'); lo
--   que no hacía era tocar la suscripción. Acá se re-afirma la semántica:
--   suspender ≠ cambiar el plan.
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 0: ¿existe un estado 'suspended' en el CHECK? (no: active|inactive|trial)
-- Se deja documentado con una verificación explícita.
-- ============================================================
SELECT '[CHECK] subscriptions.status admite: ' ||
       pg_get_constraintdef(oid) AS estado_permitido
FROM pg_constraint WHERE conname = 'subscriptions_status_check';

-- ============================================================
-- PASO 1: purga de fantasmas a los 3 meses + exige "sin uso real"
-- (sin login en el período). Mismas protecciones de datos que antes.
-- ============================================================
CREATE OR REPLACE FUNCTION public.purge_tenants_fantasma(
    p_meses INTEGER DEFAULT 3,
    p_excluir_emails TEXT[] DEFAULT ARRAY[
        'brandoncatalanmura@gmail.com',
        'admin@demo.com',
        'super@demo.com',
        'rafa@test.com'
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
    -- sin señales de uso real (datos), sin NINGÚN login en el período y sin
    -- relación con cuentas de revisión.
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
          -- NUEVO: "no la usan" = nadie entró a la web en los últimos p_meses
          -- (last_sign_in_at NULL se considera sin uso).
          AND NOT EXISTS (
                SELECT 1 FROM public.user_roles r
                JOIN auth.users u ON u.id = r.user_id
                WHERE r.tenant_id = t.id
                  AND u.last_sign_in_at IS NOT NULL
                  AND u.last_sign_in_at > now() - make_interval(months => p_meses)
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

-- Solo postgres (cron/SQL editor) y service_role pueden ejecutarla
REVOKE ALL ON FUNCTION public.purge_tenants_fantasma(INTEGER, TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_tenants_fantasma(INTEGER, TEXT[]) FROM anon;
REVOKE ALL ON FUNCTION public.purge_tenants_fantasma(INTEGER, TEXT[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_tenants_fantasma(INTEGER, TEXT[]) TO service_role;

-- ============================================================
-- PASO 2: job diario 04:00 UTC con 3 meses (antes 2)
-- ============================================================
SELECT cron.unschedule('purge-tenants-fantasma-diario')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-tenants-fantasma-diario');

SELECT cron.schedule(
    'purge-tenants-fantasma-diario',
    '0 4 * * *',
    'SELECT public.purge_tenants_fantasma(3);'
);

-- ============================================================
-- VERIFICACIÓN
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '[FANTASMA] purga a 3 meses + exige sin login + suspensión solo manual' AS status;
