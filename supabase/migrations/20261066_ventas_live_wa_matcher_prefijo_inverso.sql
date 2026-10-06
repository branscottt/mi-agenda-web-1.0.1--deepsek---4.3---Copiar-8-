-- ============================================================================
-- [VENTAS LIVE] Matcher de usuario: PREFIJO INVERSO (ciclo 20261066)
--
-- Bug real (probado por el dueño 2026-10-06): en la web la ficha quedó como
-- "@bran" (corto) y el cliente escribió "branscott" (más completo). El bot dijo
-- "no encontre ese usuario" y NO lo tomó como parecido.
--
-- Causa: la regla de "prefijo inverso" (lo guardado es prefijo de lo escrito)
-- existía desde v5 (20261058) pero exigía cubrir el 60% del texto
-- (bran=4 / branscott=9 = 0.44 → quedaba fuera). La regla de ABREVIATURA (al
-- revés: el cliente escribe más corto) sí usa 40% desde v5.
--
-- Arreglo: mismo 40% que la abreviatura + mínimo 3 letras guardadas.
-- Con esto el matcher devuelve tipo 'parecido' (0.800) y el bot PREGUNTA
-- "eres @bran?" antes de vincular (nunca identifica directo).
--
-- NO es un retroceso: los ciclos 20261064/20261065 no tocaron el matcher.
-- Solo se re-define la función; no cambia frontend.
-- ============================================================================

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
    v_umbral constant numeric := 0.60;
    v_id uuid;
    v_user text;
    v_score numeric;
BEGIN
    v_crudo := regexp_replace(lower(btrim(COALESCE(p_texto, ''))), '[^a-z0-9]', '', 'g');

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
                       -- ABREVIATURA: lo escrito es prefijo del usuario guardado
                       -- ("bran" -> "branscott"). Antes esta regla exigía cubrir
                       -- el 60% del nombre y "bran" quedaba fuera. 40% alcanza.
                       CASE WHEN public.vl_wa_base_usuario(cl.tiktok_user) <> ''
                             AND public.vl_wa_base_usuario(cl.tiktok_user) LIKE v_cand || '%'
                             AND least(char_length(public.vl_wa_base_usuario(cl.tiktok_user)),
                                       char_length(v_cand))::numeric
                                 / greatest(char_length(public.vl_wa_base_usuario(cl.tiktok_user)),
                                            char_length(v_cand)) >= 0.4
                            THEN 0.860 ELSE 0 END,
                       -- Prefijo inverso: lo guardado es prefijo de lo escrito
                       -- ("bran" en la web -> el cliente escribe "branscott").
                       -- 40% (igual que la abreviatura) y minimo 3 letras
                       -- guardadas; antes pedia 60% y este caso quedaba fuera.
                       CASE WHEN public.vl_wa_base_usuario(cl.tiktok_user) <> ''
                             AND char_length(public.vl_wa_base_usuario(cl.tiktok_user)) >= 3
                             AND v_cand LIKE public.vl_wa_base_usuario(cl.tiktok_user) || '%'
                             AND least(char_length(public.vl_wa_base_usuario(cl.tiktok_user)),
                                       char_length(v_cand))::numeric
                                 / greatest(char_length(public.vl_wa_base_usuario(cl.tiktok_user)),
                                            char_length(v_cand)) >= 0.4
                            THEN 0.800 ELSE 0 END,
                       CASE WHEN public.vl_wa_base_usuario(cl.tiktok_user) <> ''
                            THEN similarity(public.vl_wa_base_usuario(cl.tiktok_user), v_cand)::numeric * 0.95
                            ELSE 0 END,
                       CASE WHEN public.vl_wa_base_usuario(cl.tiktok_user) <> ''
                            THEN 1 - public.vl_wa_distancia_edicion(
                                         public.vl_wa_base_usuario(cl.tiktok_user), v_cand)::numeric
                                     / greatest(char_length(public.vl_wa_base_usuario(cl.tiktok_user)),
                                                char_length(v_cand))
                            ELSE 0 END,
                       -- Nombre real del cliente: "buscar más" cuando la persona
                       -- escribe su nombre en vez del @usuario. x0.99 a propósito:
                       -- NUNCA identifica directo (siempre pide confirmación).
                       CASE WHEN btrim(COALESCE(cl.nombre_real, '')) <> ''
                             AND public.vl_wa_base_usuario(cl.nombre_real) <> ''
                            THEN 0.99 * greatest(
                                     CASE WHEN public.vl_wa_base_usuario(cl.nombre_real) = v_cand
                                          THEN 1.000 ELSE 0 END,
                                     CASE WHEN public.vl_wa_base_usuario(cl.nombre_real) LIKE v_cand || '%'
                                           AND least(char_length(public.vl_wa_base_usuario(cl.nombre_real)),
                                                     char_length(v_cand))::numeric
                                               / greatest(char_length(public.vl_wa_base_usuario(cl.nombre_real)),
                                                          char_length(v_cand)) >= 0.4
                                          THEN 0.860 ELSE 0 END,
                                     similarity(public.vl_wa_base_usuario(cl.nombre_real), v_cand)::numeric,
                                     1 - public.vl_wa_distancia_edicion(
                                             public.vl_wa_base_usuario(cl.nombre_real), v_cand)::numeric
                                         / greatest(char_length(public.vl_wa_base_usuario(cl.nombre_real)),
                                                    char_length(v_cand))
                                 )
                            ELSE 0 END
                   ) AS sc
            FROM public.vl_clientes cl
            WHERE cl.tenant_id = p_tenant_id
        ) c
        WHERE c.sc >= v_umbral
        ORDER BY c.sc DESC, c.lc ASC
        LIMIT 1;

        IF v_id IS NOT NULL THEN
            -- Identifica directo SOLO si escribió el handle tal cual (crudo == candidato).
            RETURN jsonb_build_object(
                'tipo', CASE WHEN v_cand = v_crudo AND v_score >= 1.000 THEN 'exacto' ELSE 'parecido' END,
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

REVOKE ALL ON FUNCTION public.vl_wa_resolver_usuario(uuid, text) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_resolver_usuario(uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] matcher prefijo inverso (20261066): "bran" guardado + "branscott" escrito -> parecido OK' AS status;
