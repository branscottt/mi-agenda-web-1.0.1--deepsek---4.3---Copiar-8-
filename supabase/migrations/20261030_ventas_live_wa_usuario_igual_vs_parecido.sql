-- ============================================================
-- MIGRACIÓN 20261030: Ventas Live — separar "igual" de "parecido"
-- Fecha: 2026-10-11
--
-- Problema detectado al probar 20261029: el resolver comparaba las claves
-- colapsando letras repetidas TAMBIÉN en el caso "exacto", así que
-- "anubis" == "anubisss" y el bot se saltaba la confirmación
-- ("eres @anubisss?"), que es justamente lo que el negocio pidió.
--
-- Ahora:
--   - "igual"    = mismo usuario sin @, sin mayúsculas y sin símbolos.
--                  --> se identifica directo, sin preguntar.
--   - "parecido" = mismo esqueleto (letras repetidas), empieza igual, o muy
--                  similar por trigramas. --> el bot pregunta "eres @x?".
--   - "ninguno"  = aviso al negocio.
-- ============================================================

-- Base del usuario: minúsculas, sin símbolos (sin colapsar repetidos)
CREATE OR REPLACE FUNCTION public.vl_wa_base_usuario(p_txt text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
    SELECT regexp_replace(lower(COALESCE(p_txt, '')), '[^a-z0-9]', '', 'g');
$$;

CREATE OR REPLACE FUNCTION public.vl_wa_resolver_usuario(
    p_tenant_id uuid,
    p_texto text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_base text;
    v_clave text;
    v_id uuid;
    v_user text;
    v_sim real;
BEGIN
    v_base  := public.vl_wa_base_usuario(p_texto);
    v_clave := public.vl_wa_clave_usuario(p_texto);

    IF char_length(v_clave) < 3 THEN
        RETURN jsonb_build_object('tipo', 'ninguno');
    END IF;

    -- 1) IGUAL: el usuario tal cual (sin @, mayúsculas ni símbolos)
    SELECT c.id, c.tiktok_user INTO v_id, v_user
    FROM public.vl_clientes c
    WHERE c.tenant_id = p_tenant_id
      AND public.vl_wa_base_usuario(c.tiktok_user) = v_base
    ORDER BY c.creado_en
    LIMIT 1;

    IF v_id IS NOT NULL THEN
        RETURN jsonb_build_object(
            'tipo', 'exacto', 'cliente_id', v_id, 'tiktok_user', v_user, 'clave', v_base);
    END IF;

    -- 2) PARECIDO: mismo esqueleto, empieza igual o suena muy similar
    SELECT c.id, c.tiktok_user,
           similarity(public.vl_wa_base_usuario(c.tiktok_user), v_base) AS sim
    INTO v_id, v_user, v_sim
    FROM public.vl_clientes c
    WHERE c.tenant_id = p_tenant_id
      AND public.vl_wa_base_usuario(c.tiktok_user) <> ''
      AND (
            public.vl_wa_clave_usuario(c.tiktok_user) = v_clave
         OR public.vl_wa_base_usuario(c.tiktok_user) LIKE v_base || '%'
         OR similarity(public.vl_wa_base_usuario(c.tiktok_user), v_base) >= 0.5
      )
    ORDER BY
        (public.vl_wa_clave_usuario(c.tiktok_user) = v_clave) DESC,
        (public.vl_wa_base_usuario(c.tiktok_user) LIKE v_base || '%') DESC,
        similarity(public.vl_wa_base_usuario(c.tiktok_user), v_base) DESC,
        char_length(c.tiktok_user)
    LIMIT 1;

    IF v_id IS NOT NULL THEN
        RETURN jsonb_build_object(
            'tipo', 'parecido', 'cliente_id', v_id, 'tiktok_user', v_user,
            'clave', v_base, 'similitud', v_sim);
    END IF;

    RETURN jsonb_build_object('tipo', 'ninguno', 'clave', v_base);
END;
$$;

REVOKE ALL ON FUNCTION public.vl_wa_base_usuario(text) FROM anon, authenticated, public;
REVOKE ALL ON FUNCTION public.vl_wa_resolver_usuario(uuid, text) FROM anon, authenticated, public;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] Resolver: igual vs parecido OK' AS status;
