-- ============================================================================
-- [VENTAS LIVE] Configurador de respuestas — Paso B (20261080).
-- 1) Modo por momento: 'aleatorio' (rota las variantes) o 'fijo'/'elegir una'
--    (manda la opción ACTIVA de un carrusel de burbujas etiquetadas).
-- 2) Tabla vl_wa_respuesta_opciones: burbujas con ETIQUETA + texto; una activa.
-- 3) Cuentas bancarias como opciones de la clave 'datos_pago': al activar una,
--    se sincroniza vl_config.datos_pago (el bot manda la activa, sin tocar el
--    cerebro). 4) Los textos del bloque de pago pasan a ser editables.
-- ============================================================================

ALTER TABLE public.vl_wa_respuestas
    ADD COLUMN IF NOT EXISTS modo text NOT NULL DEFAULT 'aleatorio';

CREATE TABLE IF NOT EXISTS public.vl_wa_respuesta_opciones (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    clave           text NOT NULL,
    etiqueta        text NOT NULL DEFAULT '',
    texto           text NOT NULL DEFAULT '',
    activa          boolean NOT NULL DEFAULT false,
    orden           int NOT NULL DEFAULT 100,
    creado_en       timestamptz NOT NULL DEFAULT now(),
    actualizado_en  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_vl_wa_resp_opc ON public.vl_wa_respuesta_opciones(tenant_id, clave);
ALTER TABLE public.vl_wa_respuesta_opciones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vl_wa_respuesta_opciones FROM anon, authenticated;

-- Semillas nuevas (textos del bloque de pago) — idempotente.
INSERT INTO public.vl_wa_respuestas (tenant_id, clave, tipo, descripcion, cuerpo, activo, orden, modo)
SELECT * FROM (VALUES
 (NULL::uuid,'pago_titulo','sistema','Encabezado que sale arriba de tus datos para pagar.','💰 Datos para pagar:',true,15,'aleatorio'),
 (NULL::uuid,'pago_sin_datos','sistema','Lo que dice el bot cuando todavía no cargaste tus datos de pago.','📌 Los datos para transferir te los mando en un momento por aquí 💜',true,16,'aleatorio')
) AS v(tenant_id, clave, tipo, descripcion, cuerpo, activo, orden, modo)
WHERE NOT EXISTS (SELECT 1 FROM public.vl_wa_respuestas WHERE tenant_id IS NULL AND clave IN ('pago_titulo','pago_sin_datos'));

-- ── Helper v2: opciones (elegir una) → override → base ──
CREATE OR REPLACE FUNCTION public.vl_wa_texto(p_tenant uuid, p_clave text, p_base text[])
 RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_cuerpo text; v_modo text; v_hay boolean := false; v_op text[]; v_opc text;
BEGIN
    -- 1) Opciones etiquetadas ("elegir una"): manda la ACTIVA.
    SELECT texto INTO v_opc
      FROM public.vl_wa_respuesta_opciones
     WHERE tenant_id = p_tenant AND clave = p_clave AND activa
     ORDER BY orden, creado_en LIMIT 1;
    IF v_opc IS NOT NULL THEN
        RETURN v_opc;   -- puede ser '' si la dejaron en blanco (=> aviso)
    END IF;
    -- 2) Override del tenant
    SELECT cuerpo, modo, true INTO v_cuerpo, v_modo, v_hay
      FROM public.vl_wa_respuestas
     WHERE tenant_id = p_tenant AND clave = p_clave AND tipo = 'sistema' AND activo
     LIMIT 1;
    IF v_hay THEN
        IF v_modo = 'fijo' THEN
            v_op := ARRAY(SELECT x FROM unnest(string_to_array(v_cuerpo, E'\n')) x WHERE btrim(x) <> '');
            RETURN COALESCE(v_op[1], '');
        END IF;
        IF btrim(COALESCE(v_cuerpo, '')) = '' THEN RETURN ''; END IF;
        v_op := ARRAY(SELECT x FROM unnest(string_to_array(v_cuerpo, E'\n')) x WHERE btrim(x) <> '');
    ELSE
        v_op := p_base;
    END IF;
    RETURN public.vl_wa_variar(v_op);
END; $function$;

-- ── Listar (base + overrides con MODO) ──
CREATE OR REPLACE FUNCTION public.vl_wa_respuestas_listar()
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_tenant uuid;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live'); END IF;
    IF NOT public.is_admin() THEN RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador'); END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'momentos', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'clave', b.clave,
                'descripcion', b.descripcion,
                'base', b.cuerpo,
                'cuerpo', COALESCE(o.cuerpo, b.cuerpo),
                'editada', (o.id IS NOT NULL),
                'blanqueada', (o.id IS NOT NULL AND btrim(COALESCE(o.cuerpo, '')) = ''),
                'activo', COALESCE(o.activo, b.activo),
                'modo', COALESCE(o.modo, b.modo, 'aleatorio')
            ) ORDER BY b.orden, b.clave)
            FROM public.vl_wa_respuestas b
            LEFT JOIN public.vl_wa_respuestas o
                   ON o.tenant_id = v_tenant AND o.clave = b.clave AND o.tipo = 'sistema'
            WHERE b.tenant_id IS NULL AND b.tipo = 'sistema'
        ), '[]'::jsonb),
        'reglas', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', r.id, 'gatillos', r.gatillos, 'cuerpo', r.cuerpo,
                'activo', r.activo, 'orden', r.orden) ORDER BY r.orden, r.creado_en)
            FROM public.vl_wa_respuestas r
            WHERE r.tenant_id = v_tenant AND r.tipo = 'regla'
        ), '[]'::jsonb),
        'cuentas', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', c.id, 'etiqueta', c.etiqueta, 'texto', c.texto, 'activa', c.activa)
                ORDER BY c.orden, c.creado_en)
            FROM public.vl_wa_respuesta_opciones c
            WHERE c.tenant_id = v_tenant AND c.clave = 'datos_pago'
        ), '[]'::jsonb),
        'datos_pago_vigente', COALESCE((SELECT datos_pago FROM public.vl_config WHERE tenant_id = v_tenant), '')
    );
END; $function$;

-- ── Modo del momento: aleatorio | fijo ──
CREATE OR REPLACE FUNCTION public.vl_wa_respuesta_modo(p_clave text, p_modo text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_tenant uuid; v_modo text;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live'); END IF;
    IF NOT public.is_admin() THEN RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador'); END IF;
    v_modo := CASE WHEN lower(btrim(COALESCE(p_modo,''))) = 'fijo' THEN 'fijo' ELSE 'aleatorio' END;

    UPDATE public.vl_wa_respuestas SET modo = v_modo, actualizado_en = now()
     WHERE tenant_id = v_tenant AND clave = p_clave AND tipo = 'sistema';
    IF NOT FOUND THEN
        INSERT INTO public.vl_wa_respuestas (tenant_id, clave, tipo, descripcion, cuerpo, activo, orden, modo)
        SELECT v_tenant, p_clave, 'sistema', b.descripcion, b.cuerpo, true, b.orden, v_modo
          FROM public.vl_wa_respuestas b
         WHERE b.tenant_id IS NULL AND b.clave = p_clave AND b.tipo = 'sistema';
    END IF;
    RETURN jsonb_build_object('ok', true, 'modo', v_modo);
END; $function$;

-- ── Opciones (burbujas etiquetadas) de un momento ──
CREATE OR REPLACE FUNCTION public.vl_wa_opciones_listar(p_clave text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_tenant uuid;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live'); END IF;
    IF NOT public.is_admin() THEN RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador'); END IF;
    RETURN jsonb_build_object('ok', true, 'opciones', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', c.id, 'etiqueta', c.etiqueta, 'texto', c.texto, 'activa', c.activa)
               ORDER BY c.orden, c.creado_en)
        FROM public.vl_wa_respuesta_opciones c
        WHERE c.tenant_id = v_tenant AND c.clave = p_clave
    ), '[]'::jsonb));
END; $function$;

-- ── Guardar opción (agregar/editar burbuja) ──
CREATE OR REPLACE FUNCTION public.vl_wa_opcion_guardar(p_clave text, p_etiqueta text, p_texto text, p_activa boolean DEFAULT false, p_id uuid DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_tenant uuid; v_id uuid;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live'); END IF;
    IF NOT public.is_admin() THEN RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador'); END IF;
    IF btrim(COALESCE(p_texto, '')) = '' THEN RETURN jsonb_build_object('ok', false, 'error', 'Escribe el texto de la respuesta'); END IF;

    IF p_id IS NOT NULL THEN
        UPDATE public.vl_wa_respuesta_opciones
           SET etiqueta = COALESCE(p_etiqueta,''), texto = p_texto, actualizado_en = now()
         WHERE id = p_id AND tenant_id = v_tenant AND clave = p_clave
         RETURNING id INTO v_id;
        IF v_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'Esa opción no existe'); END IF;
    ELSE
        INSERT INTO public.vl_wa_respuesta_opciones (tenant_id, clave, etiqueta, texto, activa, orden)
        VALUES (v_tenant, p_clave, COALESCE(p_etiqueta,''), p_texto,
                COALESCE(p_activa,false),
                COALESCE((SELECT max(orden)+10 FROM public.vl_wa_respuesta_opciones WHERE tenant_id=v_tenant AND clave=p_clave), 100))
        RETURNING id INTO v_id;
    END IF;

    IF COALESCE(p_activa,false) THEN
        PERFORM public.vl_wa_opcion_activar(v_id);
    END IF;
    RETURN jsonb_build_object('ok', true, 'id', v_id);
END; $function$;

-- ── Activar una opción (y sincronizar datos de pago si es una cuenta) ──
CREATE OR REPLACE FUNCTION public.vl_wa_opcion_activar(p_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_tenant uuid; v_clave text; v_texto text;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live'); END IF;
    IF NOT public.is_admin() THEN RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador'); END IF;

    SELECT clave, texto INTO v_clave, v_texto
      FROM public.vl_wa_respuesta_opciones WHERE id = p_id AND tenant_id = v_tenant;
    IF v_clave IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'Esa opción no existe'); END IF;

    UPDATE public.vl_wa_respuesta_opciones SET activa = false
     WHERE tenant_id = v_tenant AND clave = v_clave;
    UPDATE public.vl_wa_respuesta_opciones SET activa = true, actualizado_en = now()
     WHERE id = p_id AND tenant_id = v_tenant;

    -- Si es una cuenta bancaria, el bot manda esa: se sincroniza la config.
    IF v_clave = 'datos_pago' THEN
        UPDATE public.vl_config SET datos_pago = v_texto WHERE tenant_id = v_tenant;
        IF NOT FOUND THEN
            INSERT INTO public.vl_config (tenant_id, datos_pago) VALUES (v_tenant, v_texto);
        END IF;
    END IF;
    RETURN jsonb_build_object('ok', true);
END; $function$;

-- ── Eliminar una opción ──
CREATE OR REPLACE FUNCTION public.vl_wa_opcion_eliminar(p_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_tenant uuid;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live'); END IF;
    IF NOT public.is_admin() THEN RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador'); END IF;
    DELETE FROM public.vl_wa_respuesta_opciones WHERE id = p_id AND tenant_id = v_tenant;
    RETURN jsonb_build_object('ok', true);
END; $function$;

-- ── Bloque de pago: header y respaldo editables por tenant ──
CREATE OR REPLACE FUNCTION public.vl_wa_bloque_pago_para(p_tenant_id uuid, p_chat_id uuid, p_reenviar boolean DEFAULT false)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_datos text := ''; v_ya timestamptz; v_sin text;
BEGIN
    SELECT COALESCE(datos_pago, '') INTO v_datos FROM public.vl_config WHERE tenant_id = p_tenant_id;

    IF btrim(v_datos) = '' THEN
        v_sin := public.vl_wa_texto(p_tenant_id, 'pago_sin_datos',
                     ARRAY['📌 Los datos para transferir te los mando en un momento por aquí 💜']);
        IF btrim(v_sin) = '' THEN RETURN ''; END IF;
        RETURN v_sin;
    END IF;

    IF p_chat_id IS NOT NULL THEN
        SELECT datos_pago_enviado_en INTO v_ya FROM public.vl_wa_chats WHERE id = p_chat_id;
        IF v_ya IS NOT NULL AND NOT COALESCE(p_reenviar, false) THEN RETURN ''; END IF;
        UPDATE public.vl_wa_chats SET datos_pago_enviado_en = now() WHERE id = p_chat_id;
    END IF;

    RETURN public.vl_wa_texto(p_tenant_id, 'pago_titulo', ARRAY['💰 Datos para pagar:'])
           || chr(10) || v_datos;
END; $function$;

REVOKE ALL ON FUNCTION public.vl_wa_respuesta_modo(text, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_respuesta_modo(text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.vl_wa_opciones_listar(text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_opciones_listar(text) TO authenticated;
REVOKE ALL ON FUNCTION public.vl_wa_opcion_guardar(text, text, text, boolean, uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_opcion_guardar(text, text, text, boolean, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.vl_wa_opcion_activar(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_opcion_activar(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.vl_wa_opcion_eliminar(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_opcion_eliminar(uuid) TO authenticated;
