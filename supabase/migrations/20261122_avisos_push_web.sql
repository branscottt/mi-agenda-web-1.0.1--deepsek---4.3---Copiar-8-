-- ============================================================================
-- MIGRACIÓN 20261122: AVISOS PUSH GENERALES (reservas y todo el panel)
-- Fecha: 2026-11-02
--
-- OBJETIVO: que al dueño le llegue una notificación al PC / móvil / tablet
-- CUALQUIER aviso de la web (reserva nueva, cambio de horario, cancelación,
-- recordatorio, cambio de plan…), tenga la web abierta o cerrada. Si el
-- dispositivo no tiene los avisos activados, el correo de la cuenta recibe el
-- aviso (eso lo hace la Edge Function `avisos-push`, no la base).
--
-- PIEZAS:
--   * avisos_subs  → 1 fila por dispositivo suscrito (Web Push, gratis).
--   * avisos_log   → 1 fila por envío (observabilidad: si algo no llega, se ve).
--   * RPCs         → guardar / borrar / estado / últimos (panel).
--   * TRIGGER      → tras insertar en notificaciones_admin se llama a la Edge
--                    Function vía pg_net. Es "mejor esfuerzo": si falla, la
--                    reserva NUNCA se rompe (EXCEPTION WHEN OTHERS → NULL).
--
-- El token que el trigger manda a la función vive en Vault
-- (vault.secretos name='avisos_push_token'); no hay service_role en la base.
-- Idempotente: se puede reaplicar sin duplicar nada.
-- ============================================================================

-- ── 0. pg_net: llamadas HTTP desde la base (cola en background) ──────────────
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ── 1. Suscripciones de cada dispositivo ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.avisos_subs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    user_id uuid,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    agente text,
    creado_en timestamptz NOT NULL DEFAULT now(),
    visto_en timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT avisos_subs_tenant_endpoint_uk UNIQUE (tenant_id, endpoint)
);

ALTER TABLE public.avisos_subs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.avisos_subs FROM anon, authenticated, public;
CREATE INDEX IF NOT EXISTS idx_avisos_subs_tenant ON public.avisos_subs (tenant_id);

-- ── 2. Bitácora de envíos (una fila por aviso) ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.avisos_log (
    id bigserial PRIMARY KEY,
    tenant_id uuid,
    origen text,
    tipo text,
    notificacion_id text,
    titulo text,
    suscripciones int DEFAULT 0,
    enviados int DEFAULT 0,
    borrados int DEFAULT 0,
    errores int DEFAULT 0,
    email text,
    email_estado text,
    detalle text,
    creado_en timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.avisos_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.avisos_log FROM anon, authenticated, public;
CREATE INDEX IF NOT EXISTS idx_avisos_log_tenant ON public.avisos_log (tenant_id, creado_en DESC);

-- ── 3. Marca de "este aviso ya se empujó" (idempotencia del trigger) ────────
ALTER TABLE public.notificaciones_admin
    ADD COLUMN IF NOT EXISTS push_enviado_en timestamptz;

CREATE INDEX IF NOT EXISTS idx_notif_admin_push
    ON public.notificaciones_admin (tenant_id, creado_en DESC)
    WHERE push_enviado_en IS NULL;

-- ── 4. RPC: guardar la suscripción del dispositivo (panel) ──────────────────
CREATE OR REPLACE FUNCTION public.avisos_guardar_sub(
    p_endpoint text,
    p_p256dh text,
    p_auth text,
    p_agente text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
BEGIN
    v_tenant := public.get_user_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin espacio asociado a la cuenta');
    END IF;
    IF btrim(COALESCE(p_endpoint, '')) = ''
       OR btrim(COALESCE(p_p256dh, '')) = ''
       OR btrim(COALESCE(p_auth, '')) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Suscripción incompleta');
    END IF;

    INSERT INTO public.avisos_subs (tenant_id, user_id, endpoint, p256dh, auth, agente)
    VALUES (v_tenant, auth.uid(), btrim(p_endpoint), btrim(p_p256dh), btrim(p_auth), left(p_agente, 200))
    ON CONFLICT (tenant_id, endpoint) DO UPDATE
        SET p256dh = EXCLUDED.p256dh,
            auth = EXCLUDED.auth,
            user_id = EXCLUDED.user_id,
            agente = EXCLUDED.agente,
            visto_en = now();

    RETURN jsonb_build_object(
        'ok', true,
        'dispositivos', (SELECT count(*) FROM public.avisos_subs WHERE tenant_id = v_tenant)
    );
END;
$$;

-- ── 5. RPC: borrar la suscripción (apagar avisos) ───────────────────────────
CREATE OR REPLACE FUNCTION public.avisos_borrar_sub(p_endpoint text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_n int;
BEGIN
    v_tenant := public.get_user_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin espacio asociado a la cuenta');
    END IF;
    WITH del AS (
        DELETE FROM public.avisos_subs
        WHERE tenant_id = v_tenant
          AND endpoint = btrim(COALESCE(p_endpoint, ''))
        RETURNING 1
    )
    SELECT count(*) INTO v_n FROM del;

    RETURN jsonb_build_object('ok', true, 'borrados', v_n,
        'dispositivos', (SELECT count(*) FROM public.avisos_subs WHERE tenant_id = v_tenant));
END;
$$;

-- ── 6. RPC: estado para el panel (¿hay avisos activos? ¿a qué correo cae?) ──
CREATE OR REPLACE FUNCTION public.avisos_estado()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_email text;
    v_n int;
BEGIN
    v_tenant := public.get_user_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin espacio asociado a la cuenta');
    END IF;

    SELECT count(*) INTO v_n FROM public.avisos_subs WHERE tenant_id = v_tenant;
    SELECT email_contacto INTO v_email FROM public.tenants WHERE id = v_tenant;

    RETURN jsonb_build_object('ok', true, 'dispositivos', v_n, 'email', v_email);
END;
$$;

-- ── 7. RPC: últimos avisos (para el aviso en primer plano del navegador) ────
CREATE OR REPLACE FUNCTION public.avisos_ultimos(p_limite int DEFAULT 10)
RETURNS TABLE (
    id text,
    tipo text,
    titulo text,
    cuerpo text,
    cita_id text,
    -- OJO: notificaciones_admin.creado_en es timestamp SIN zona; si se declara
    -- timestamptz PostgREST falla con "structure of query does not match
    -- function result type". Debe coincidir exactamente.
    creado_en timestamp
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_n int := greatest(1, least(coalesce(p_limite, 10), 30));
BEGIN
    v_tenant := public.get_user_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT n.id,
           coalesce(n.tipo, 'info') AS tipo,
           CASE coalesce(n.tipo, '')
               WHEN 'nueva_reserva' THEN 'Nueva reserva'
               WHEN 'nueva_cita'    THEN 'Nueva cita'
               WHEN 'cancelacion'   THEN 'Reserva cancelada'
               WHEN 'cambio_horario' THEN 'Cambio de horario'
               WHEN 'cambio_plan'   THEN 'Cambio de plan'
               WHEN 'cambio-admin'  THEN 'Cambio de reserva'
               WHEN 'recordatorio'  THEN 'Recordatorio de cita'
               ELSE 'Aviso'
           END AS titulo,
           trim(both ' ·' from concat_ws(' · ',
               nullif(btrim(coalesce(n.cliente->>'nombre', '')), ''),
               nullif(btrim(coalesce(n.metadata->>'servicio', '')), ''),
               nullif(btrim(coalesce(n.fecha_nueva, n.metadata->>'fecha', n.fecha_original, '')), ''),
               nullif(btrim(coalesce(n.hora_nueva, n.metadata->>'hora', n.hora_original, '')), '')
           )) AS cuerpo,
           n.cita_id,
           n.creado_en
    FROM public.notificaciones_admin n
    WHERE n.tenant_id = v_tenant
      AND coalesce(n.leido, false) = false
      AND n.creado_en > now() - interval '2 days'
    ORDER BY n.creado_en DESC
    LIMIT v_n;
END;
$$;

-- ── 8. Permisos (solo usuarios con sesión) ──────────────────────────────────
REVOKE ALL ON FUNCTION public.avisos_guardar_sub(text, text, text, text) FROM anon, public;
REVOKE ALL ON FUNCTION public.avisos_borrar_sub(text) FROM anon, public;
REVOKE ALL ON FUNCTION public.avisos_estado() FROM anon, public;
REVOKE ALL ON FUNCTION public.avisos_ultimos(int) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.avisos_guardar_sub(text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.avisos_borrar_sub(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.avisos_estado() TO authenticated;
GRANT EXECUTE ON FUNCTION public.avisos_ultimos(int) TO authenticated;

-- ── 9. Token del sistema (Vault) — lo lee el trigger, lo valida la función ──
CREATE OR REPLACE FUNCTION public.avisos_token_sistema()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $$
DECLARE
    v text;
BEGIN
    BEGIN
        SELECT decrypted_secret INTO v
        FROM vault.decrypted_secrets
        WHERE name = 'avisos_push_token'
        LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
        v := NULL;
    END;
    RETURN NULLIF(btrim(COALESCE(v, '')), '');
END;
$$;

REVOKE ALL ON FUNCTION public.avisos_token_sistema() FROM anon, authenticated, public;

-- ── 10. Trigger: cada aviso del panel se empuja al instante ─────────────────
CREATE OR REPLACE FUNCTION public.notif_avisar_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_token text;
    v_titulo text;
    v_cuerpo text;
    v_url text;
    v_tipo text := coalesce(NEW.tipo, 'aviso');
BEGIN
    BEGIN
        IF NEW.tenant_id IS NULL THEN
            RETURN NEW;
        END IF;
        -- Ya empujado (o el aviso nació leído): nada que hacer.
        IF NEW.push_enviado_en IS NOT NULL OR coalesce(NEW.leido, false) THEN
            RETURN NEW;
        END IF;

        v_token := public.avisos_token_sistema();
        IF v_token IS NULL THEN
            RETURN NEW;   -- sin token configurado: mejor esfuerzo, no rompe nada
        END IF;

        v_titulo := CASE v_tipo
            WHEN 'nueva_reserva'  THEN 'Nueva reserva'
            WHEN 'nueva_cita'     THEN 'Nueva cita'
            WHEN 'cancelacion'    THEN 'Reserva cancelada'
            WHEN 'cambio_horario' THEN 'Cambio de horario'
            WHEN 'cambio_plan'    THEN 'Cambio de plan'
            WHEN 'cambio-admin'   THEN 'Cambio de reserva'
            WHEN 'recordatorio'   THEN 'Recordatorio de cita'
            WHEN 'pago_confirmado' THEN 'Pago confirmado'
            ELSE 'Aviso de tu agenda'
        END;

        v_cuerpo := trim(both ' ·' from concat_ws(' · ',
            nullif(btrim(coalesce(NEW.cliente->>'nombre', '')), ''),
            nullif(btrim(coalesce(NEW.metadata->>'servicio', '')), ''),
            nullif(btrim(coalesce(NEW.fecha_nueva, NEW.metadata->>'fecha', NEW.fecha_original, '')), ''),
            nullif(btrim(coalesce(NEW.hora_nueva, NEW.metadata->>'hora', NEW.hora_original, '')), '')
        ));
        IF v_cuerpo IS NULL OR v_cuerpo = '' THEN
            v_cuerpo := 'Tienes algo que revisar en tu panel.';
        END IF;

        v_url := '/admin.html';

        PERFORM net.http_post(
            url := 'https://dfcfimipkfhitlsyixqu.supabase.co/functions/v1/avisos-push',
            body := jsonb_build_object(
                'accion', 'enviar',
                'origen', 'notificacion',
                'tenant_id', NEW.tenant_id,
                'notificacion_id', NEW.id,
                'tipo', v_tipo,
                'titulo', v_titulo,
                'cuerpo', v_cuerpo,
                'url', v_url,
                'email_fallback', true
            ),
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'x-avisos-token', v_token
            ),
            timeout_milliseconds := 5000
        );
    EXCEPTION WHEN OTHERS THEN
        -- Un fallo del aviso JAMÁS puede romper la reserva.
        RAISE WARNING 'notif_avisar_push: %', SQLERRM;
    END;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notif_avisar_push ON public.notificaciones_admin;
CREATE TRIGGER trg_notif_avisar_push
    AFTER INSERT ON public.notificaciones_admin
    FOR EACH ROW
    EXECUTE FUNCTION public.notif_avisar_push();
