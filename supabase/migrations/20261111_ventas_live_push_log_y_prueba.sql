-- 20261111_ventas_live_push_log_y_prueba.sql
--
-- QUÉ HACE
--   1) vl_push_log: registro de cada envío de Web Push (cuántas suscripciones
--      había, cuántas se entregaron, cuántas se borraron por muertas y los
--      errores reales del servicio push). Hasta ahora el sender no dejaba
--      rastro: si la entrega fallaba, nadie se enteraba.
--   2) vl_push_contexto(): devuelve el espacio de Ventas Live del usuario que
--      llama y si es administrador. Lo usa la Edge Function wa-push para
--      permitir un aviso de PRUEBA desde el panel ("Probar notificación") sin
--      exponer la service_role en el navegador.
--
-- POR QUÉ
--   El dueño reportó "no llegaban las notificaciones de cuando hablan". El
--   cerebro sí devuelve el push y las suscripciones existen; lo que no había
--   era forma de ver si la ENTREGA funcionaba. Con este log + el botón de
--   prueba se responde con datos, no con suposiciones.
--
-- APLICAR: supabase db query --linked -f 20261111_ventas_live_push_log_y_prueba.sql

CREATE TABLE IF NOT EXISTS public.vl_push_log (
    id             bigserial PRIMARY KEY,
    tenant_id      uuid,
    origen         text NOT NULL DEFAULT 'webhook',   -- webhook | prueba
    suscripciones  integer NOT NULL DEFAULT 0,
    enviados       integer NOT NULL DEFAULT 0,
    borrados       integer NOT NULL DEFAULT 0,
    errores        integer NOT NULL DEFAULT 0,
    detalle        text NOT NULL DEFAULT '',
    creado_en      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vl_push_log_fecha ON public.vl_push_log (creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_vl_push_log_tenant ON public.vl_push_log (tenant_id, creado_en DESC);

ALTER TABLE public.vl_push_log ENABLE ROW LEVEL SECURITY;
-- Sin policies ni grants: solo la service_role (que salta RLS) escribe y lee.
REVOKE ALL ON public.vl_push_log FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.vl_push_log_id_seq FROM anon, authenticated;

COMMENT ON TABLE public.vl_push_log IS
    'Registro de envíos de Web Push de Ventas Live (una fila por llamada a wa-push): suscripciones, enviados, borrados y errores. Sirve para diagnosticar "no me llegó el aviso".';

-- ── Espacio de Ventas Live del usuario que llama ────────────────────────────
CREATE OR REPLACE FUNCTION public.vl_push_contexto()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin sesión');
    END IF;
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    RETURN jsonb_build_object('ok', true, 'tenant_id', v_tenant, 'es_admin', public.is_admin());
END;
$function$;

COMMENT ON FUNCTION public.vl_push_contexto() IS
    'Tenant de Ventas Live + rol admin del usuario autenticado. Lo usa wa-push para mandar un aviso de prueba desde el panel sin service_role en el navegador.';

REVOKE ALL ON FUNCTION public.vl_push_contexto() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_push_contexto() TO authenticated;
