-- 20261113_ventas_live_clasificador_entrega_v3.sql
--
-- QUÉ HACE
--   Amplía vl_tipo_entrega_de_texto (clasificador único de "envío vs presencial")
--   con las formas que faltaban, medidas contra frases reales:
--     · "paso a buscarlo / la / los / las"   -> presencial
--     · "voy a buscarlo / a buscarla / a retirarlo", "lo voy a buscar",
--       "lo retiro yo", "lo paso a retirar"   -> presencial
--
-- POR QUÉ
--   Probado en prod el 2026-11-12: "lo paso a buscar" daba presencial, pero
--   "paso a buscarlo el sabado" devolvía '' (no decidía nada) porque el patrón
--   exigía límite de palabra después de "buscar" y en "buscarlo" no lo hay.
--
-- APLICAR: supabase db query --linked -f 20261113_ventas_live_clasificador_entrega_v3.sql

CREATE OR REPLACE FUNCTION public.vl_tipo_entrega_de_texto(p_texto text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
    v text;
    v_pres boolean := false;
    v_env  boolean := false;
    v_niega_pres boolean := false;
    v_niega_env  boolean := false;
    v_pregunta boolean := false;
    v_decide boolean := false;
    v_pos_pres int := 0;
    v_pos_env  int := 0;
BEGIN
    v := lower(btrim(COALESCE(p_texto, '')));
    IF v = '' THEN
        RETURN '';
    END IF;
    v := translate(v, 'áéíóúüñ', 'aeioun');
    v := regexp_replace(v, '\s+', ' ', 'g');

    -- El cliente repite la pregunta del bot ("envio o presencial", sin signos):
    -- no es una elección.
    IF v ~ '^(envio o (la )?(entrega )?presencial|presencial o (el )?envio|envio o retiro|retiro o envio)\M' THEN
        RETURN '';
    END IF;

    -- ── Señales ──────────────────────────────────────────────────────────────
    v_pres := v ~ '\m(presencial|presencialmente|retiro|retirar|retirarlo|retirarla|en persona|en mano|en el local|en la tienda|al local|a la tienda|nos vemos|vernos|junta|juntos|punto de encuentro|estacion|metro|lo paso a buscar|pasar a buscar|paso a retirar|paso por|voy por|voy a buscar|ir a buscar|iria a buscar|lo iria a buscar|lo busco|la busco|los busco|las busco|me lo llevo|me la llevo|me los llevo|dejarlo en|dejarla en|paso a buscarlo|paso a buscarla|paso a buscarlos|paso a buscarlas|voy a buscarlo|voy a buscarla|voy a retirarlo|lo voy a buscar|la voy a buscar|lo retiro yo|lo paso a retirar)\M';

    v_env := v ~ '\m(envio|envios|enviar|enviame|enviemelo|enviemela|enviarlo|enviarla|despacho|despachos|despachar|despacharlo|domicilio|a mi casa|a la casa|a su casa|en mi casa|courier|blue express|paket|packet|paquet|starken|chilexpress|a region|a provincia|lo mandas|me lo mandas|lo mandai|me lo mandai|lo envias|me lo envias|lo enviaria|mandalo|envialo|mandamelo|se lo manda|se lo mando|lo mando|lo manda)\M';

    -- Courier a secas ("blue" / "paket") solo si el mensaje ES eso (respuesta
    -- corta del paso "¿por blue o paket?"). "polera blue" NO es un envío.
    IF v ~ '^(blue|paket|por blue|por paket|blue express|paket porfis|por blue porfis|por paket porfis)\M' THEN
        v_env := true;
    END IF;

    IF NOT v_pres AND NOT v_env THEN
        RETURN '';
    END IF;

    -- ── Preguntas: NO son una elección ───────────────────────────────────────
    v_pregunta := v ~ '[?¿]'
                  OR v ~ '^(donde|cuando|cuanto|cuanta|cuantos|cuantas|como|cual|cuales|que|hay|tienen|tienes|hacen|haces|se puede|se puede|puedo|podria|podrian|sera|seria)\M';

    v_decide := v ~ '\m(prefiero|quiero|quisiera|necesito|mejor|al final|finalmente|en realidad|me quedo|me quedo con|confirmo|confirmado|asi esta bien|dale|ok|okay|bueno|perfecto|lo retiro|lo paso|voy a buscar|voy por|mandalo|envialo|mandamelo|enviemelo)\M';

    IF v_pregunta AND NOT v_decide THEN
        RETURN '';
    END IF;

    -- ── Negaciones ───────────────────────────────────────────────────────────
    -- La negación tiene que apuntar AL OBJETO que sigue ("no quiero ENVÍO"),
    -- no a cualquier palabra cercana: "no quiero envío, lo retiro" es PRESENCIAL.
    v_niega_env := v ~ '(no (quiero|prefiero|me interesa|necesito) (el |la )?(envio|envios)\M)|(sin envio|nada de envio|no envio|no es envio|no con envio|no a domicilio|no me lo mandes|no me lo envies|no lo mandes|no lo envies)';
    v_niega_pres := v ~ '(no (quiero|prefiero|me interesa|necesito) (el |la )?(presencial|retiro)\M)|(sin retiro|nada de presencial|no presencial|no es presencial|no lo retiro|no voy a buscar)';

    IF v_niega_pres THEN
        v_pres := false;
    END IF;
    IF v_niega_env THEN
        v_env := false;
    END IF;
    IF NOT v_pres AND NOT v_env THEN
        RETURN '';
    END IF;

    IF v_pres AND NOT v_env THEN
        RETURN 'presencial';
    END IF;
    IF v_env AND NOT v_pres THEN
        RETURN 'envio';
    END IF;

    -- Dijo las dos cosas: gana la ÚLTIMA mencionada ("no retiro, envío mejor").
    v_pos_pres := GREATEST(strpos(v, 'presencial'), strpos(v, 'retiro'),
                           strpos(v, 'retirar'), strpos(v, 'en persona'),
                           strpos(v, 'nos vemos'), strpos(v, 'vernos'),
                           strpos(v, 'buscar'), strpos(v, 'me lo llevo'));
    v_pos_env  := GREATEST(strpos(v, 'envio'), strpos(v, 'enviar'),
                           strpos(v, 'despacho'), strpos(v, 'domicilio'),
                           strpos(v, 'courier'), strpos(v, 'paket'),
                           strpos(v, 'mandalo'), strpos(v, 'envialo'));
    IF v_pos_env >= v_pos_pres THEN
        RETURN 'envio';
    END IF;
    RETURN 'presencial';
END;
$fn$;
