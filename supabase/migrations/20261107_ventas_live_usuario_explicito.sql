-- ============================================================
-- 20261107 — Bot/panel: entender cuando el cliente dice su usuario
-- ============================================================
-- Problema real: la gente escribe "hola soy @micuenta" o "mi usuario es
-- micuenta". El resolvedor encontraba el cliente, pero como el mensaje traía
-- más palabras caía en "parecido" y el bot volvía a preguntar "¿eres @x?".
-- Ahora, si el handle está DICHO explícitamente y coincide exacto con un
-- cliente, se identifica de inmediato (no se pregunta de nuevo). El resto del
-- flujo queda igual: si hay dudas, se sigue preguntando / mostrando la lista.

CREATE OR REPLACE FUNCTION public.vl_wa_usuario_explicito(p_texto text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
    v_low text;
    v_g text[];
    v_stop text[] := ARRAY['usuario','usuaria','user','cuenta','perfil','nick','handle','tiktok','tik','tok',
                           'soy','es','mi','el','la','de','del','en','con','hola','holi','buenas','buenos',
                           'que','tal','aqui','aca','este','esta','para','por','favor','los','las'];
    v_h text;
BEGIN
    v_low := lower(btrim(COALESCE(p_texto, '')));

    -- 1) Arroba explícita: "hola soy @rox", "@rox.lopez"
    v_g := regexp_match(v_low, '@([a-z0-9._]{2,30})');
    IF v_g IS NOT NULL THEN
        v_h := v_g[1];
        IF char_length(v_h) >= 2 AND NOT (v_h = ANY (v_stop)) THEN
            RETURN v_h;
        END IF;
    END IF;

    -- 2) "mi usuario es rox" / "usuario: rox" / "cuenta rox" / "tiktok: rox"
    v_g := regexp_match(v_low, '(usuario|usuaria|user|cuenta|perfil|nick|handle|tiktok)[ ]*(es|:)?[ ]+@?([a-z0-9._]{2,30})');
    IF v_g IS NOT NULL THEN
        v_h := v_g[3];
        IF NOT (v_h = ANY (v_stop)) THEN
            RETURN v_h;
        END IF;
    END IF;

    -- 3) "soy rox" / "me llamo rox" / "mi nombre es rox"
    --    (si dice "soy juan perez" esto toma "juan": igual solo se usa si coincide
    --     EXACTO con el usuario de un cliente, así que no inventa vínculos).
    v_g := regexp_match(v_low, '(^|[ ])(soy|me llamo|mi nombre es)[ ]+@?([a-z0-9._]{2,30})');
    IF v_g IS NOT NULL THEN
        v_h := v_g[3];
        IF NOT (v_h = ANY (v_stop)) THEN
            RETURN v_h;
        END IF;
    END IF;

    RETURN '';
END;
$function$;

CREATE OR REPLACE FUNCTION public.vl_wa_resolver_usuario(p_tenant_id uuid, p_texto text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_cands text[];
    v_cand text;
    v_crudo text;
    v_explicito text;
    v_umbral constant numeric := 0.60;
    v_id uuid;
    v_user text;
    v_score numeric;
BEGIN
    v_crudo := regexp_replace(lower(btrim(COALESCE(p_texto, ''))), '[^a-z0-9]', '', 'g');
    -- Handle que el cliente escribió EXPLÍCITAMENTE ("@rox", "mi usuario es rox",
    -- "hola soy rox"). Si coincide con un cliente, se le identifica al toque.
    v_explicito := public.vl_wa_usuario_explicito(p_texto);

    IF char_length(v_crudo) < 2 THEN
        RETURN jsonb_build_object('tipo', 'ninguno');
    END IF;

    v_cands := public.vl_wa_candidatos_usuario(p_texto);

    IF v_cands IS NULL THEN
        RETURN jsonb_build_object('tipo', 'ninguno');
    END IF;

    -- Los candidatos vienen en orden de prioridad: crudo, todo junto, token x token.
    -- Se acepta el PRIMER candidato que tenga un cliente por encima del umbral.
    FOREACH v_cand IN ARRAY v_cands LOOP
        CONTINUE WHEN char_length(v_cand) < 3;

        v_id := NULL;
        v_user := NULL;
        v_score := NULL;

        SELECT c.id, c.tiktok_user, c.sc INTO v_id, v_user, v_score
        FROM (
            SELECT cl.id,
                   cl.tiktok_user,
                   char_length(public.vl_wa_base_usuario(cl.tiktok_user)) AS lc,
                   greatest(
                       CASE WHEN public.vl_wa_base_usuario(cl.tiktok_user) = v_cand
                            THEN 1.000 ELSE 0 END,
                       CASE WHEN public.vl_wa_base_usuario(cl.tiktok_user) <> ''
                             AND public.vl_wa_clave_usuario(cl.tiktok_user)
                                 = public.vl_wa_clave_usuario(v_cand)
                            THEN 0.920 ELSE 0 END,
                       CASE WHEN public.vl_wa_base_usuario(cl.tiktok_user) <> ''
                             AND (public.vl_wa_base_usuario(cl.tiktok_user) LIKE v_cand || '%'
                                  OR v_cand LIKE public.vl_wa_base_usuario(cl.tiktok_user) || '%')
                             AND least(char_length(public.vl_wa_base_usuario(cl.tiktok_user)),
                                       char_length(v_cand))::numeric
                                 / greatest(char_length(public.vl_wa_base_usuario(cl.tiktok_user)),
                                            char_length(v_cand)) >= 0.6
                            THEN 0.800 ELSE 0 END,
                       CASE WHEN public.vl_wa_base_usuario(cl.tiktok_user) <> ''
                            THEN similarity(public.vl_wa_base_usuario(cl.tiktok_user), v_cand)::numeric * 0.95
                            ELSE 0 END,
                       CASE WHEN public.vl_wa_base_usuario(cl.tiktok_user) <> ''
                            THEN 1 - public.vl_wa_distancia_edicion(
                                         public.vl_wa_base_usuario(cl.tiktok_user), v_cand)::numeric
                                     / greatest(char_length(public.vl_wa_base_usuario(cl.tiktok_user)),
                                                char_length(v_cand))
                            ELSE 0 END
                   ) AS sc
            FROM public.vl_clientes cl
            WHERE cl.tenant_id = p_tenant_id
        ) c
        WHERE c.sc >= v_umbral
        ORDER BY c.sc DESC, c.lc ASC
        LIMIT 1;

        IF v_id IS NOT NULL THEN
            -- Identifica directo si:
            --   (a) escribió el handle tal cual ("rox"), o
            --   (b) lo dijo explícitamente con contexto ("hola soy @rox",
            --       "mi usuario es rox") y coincide EXACTO con un cliente.
            -- Antes (b) caía en "parecido" y el bot volvía a preguntar "¿eres @rox?"
            -- aunque el cliente ya lo había dicho en el chat.
            RETURN jsonb_build_object(
                'tipo', CASE WHEN v_score >= 1.000
                              AND (v_cand = v_crudo
                                   OR (v_explicito <> ''
                                       AND regexp_replace(lower(v_explicito), '[^a-z0-9]', '', 'g') = v_cand))
                             THEN 'exacto' ELSE 'parecido' END,
                'cliente_id', v_id,
                'tiktok_user', v_user,
                'clave', v_crudo,
                'candidato', v_cand,
                'score', round(v_score, 3));
        END IF;
    END LOOP;

    RETURN jsonb_build_object('tipo', 'ninguno', 'clave', v_crudo);
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_wa_usuario_explicito(text) FROM anon, authenticated, public;
REVOKE ALL ON FUNCTION public.vl_wa_resolver_usuario(uuid, text) FROM anon, authenticated, public;

NOTIFY pgrst, 'reload schema';
