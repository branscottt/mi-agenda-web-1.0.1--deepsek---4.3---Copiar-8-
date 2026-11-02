-- ============================================================================
-- MIGRACIÓN 20261124: AVISO cuando se registra una CUENTA NUEVA (tenant)
-- Fecha: 2026-11-02
--
-- PEDIDO: "avisar cuando en superadmin se crea un tenant / alguien se registra,
-- para saberlo cuando invierta y pueda tener más clientes".
--
-- Cómo funciona:
--   * Un trigger AFTER INSERT en `tenants` llama a la Edge Function
--     `avisos-push` (vía pg_net) con destino 'plataforma'.
--   * `avisos_destinos` es la lista de correos que reciben esos avisos (se
--     siembra con los superadmins + el dueño de la plataforma). El push va a
--     los dispositivos de los espacios de esos correos; si no hay ninguno con
--     avisos activados, cae al correo (Resend).
--   * Mejor esfuerzo: si falla, el registro del cliente NUNCA se ve afectado.
-- Idempotente.
-- ============================================================================

-- ── 1. Quién recibe los avisos de la plataforma ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.avisos_destinos (
    email text PRIMARY KEY,
    etiqueta text,
    activo boolean NOT NULL DEFAULT true,
    creado_en timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.avisos_destinos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.avisos_destinos FROM anon, authenticated, public;

-- Semilla: los superadmins que ya existen…
INSERT INTO public.avisos_destinos (email, etiqueta)
SELECT DISTINCT lower(btrim(u.email)), 'superadmin'
FROM public.usuarios_con_rol u
WHERE u.rol = 'super_admin' AND u.email IS NOT NULL AND btrim(u.email) <> ''
ON CONFLICT (email) DO NOTHING;

-- …y el dueño de la plataforma (recibe el aviso en sus propios espacios).
INSERT INTO public.avisos_destinos (email, etiqueta)
VALUES ('brandoncatalanmura@gmail.com', 'dueño')
ON CONFLICT (email) DO NOTHING;

-- ── 2. Trigger: cuenta nueva → aviso inmediato ─────────────────────────────
CREATE OR REPLACE FUNCTION public.aviso_nuevo_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_token text;
    v_cuerpo text;
BEGIN
    BEGIN
        v_token := public.avisos_token_sistema();
        IF v_token IS NULL THEN
            RETURN NEW;   -- sin token configurado: no rompe nada
        END IF;

        v_cuerpo := trim(both ' ·' from concat_ws(' · ',
            nullif(btrim(coalesce(NEW.nombre_negocio, '')), ''),
            coalesce(NEW.proyecto, 'proyecto'),
            nullif(btrim(coalesce(NEW.email_contacto, '')), ''),
            to_char(now(), 'DD/MM HH24:MI')
        ));
        IF v_cuerpo IS NULL OR v_cuerpo = '' THEN
            v_cuerpo := 'Se registró un negocio nuevo en la plataforma.';
        END IF;

        PERFORM net.http_post(
            url := 'https://dfcfimipkfhitlsyixqu.supabase.co/functions/v1/avisos-push',
            body := jsonb_build_object(
                'accion', 'enviar',
                'origen', 'nuevo_tenant',
                'destino', 'plataforma',
                'tipo', 'nuevo_tenant',
                'titulo', '🏪 Cuenta nueva',
                'cuerpo', v_cuerpo,
                'url', '/hub.html',
                'email_fallback', true
            ),
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'x-avisos-token', v_token
            ),
            timeout_milliseconds := 5000
        );
    EXCEPTION WHEN OTHERS THEN
        -- El aviso nunca puede romper el registro de un cliente nuevo.
        RAISE WARNING 'aviso_nuevo_tenant: %', SQLERRM;
    END;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_aviso_nuevo_tenant ON public.tenants;
CREATE TRIGGER trg_aviso_nuevo_tenant
    AFTER INSERT ON public.tenants
    FOR EACH ROW
    EXECUTE FUNCTION public.aviso_nuevo_tenant();
