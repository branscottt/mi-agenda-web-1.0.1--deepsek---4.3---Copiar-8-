-- ============================================================================
-- MIGRACIÓN 20261077: Ventas Live — aviso garantizado cuando el bot NO responde
-- Fecha: 2026-10-11
--
-- PROBLEMA (reportado): un cliente escribió y el bot no respondió ni quedó
-- ningún aviso. Causa: el aviso "no_entendido" del cerebro está condicionado a
-- que el cliente tenga un PEDIDO ABIERTO (20261053:556 `ELSIF v_proc.id IS NOT
-- NULL`). Un cliente CONOCIDO SIN pedido en curso que escribe algo que el bot no
-- entiende queda en silencio total y nadie se entera.
--
-- SOLUCIÓN (sin tocar el cerebro): una RPC chica que el WEBHOOK llama SOLO
-- cuando el cerebro decidió no responder y no dejó aviso. Deja un aviso
-- 'no_entendido' (el mismo tipo que ya pinta la web: "Contesta tú"), con dos
-- protecciones para no llenar de ruido:
--   * los ACUSES ("ok", "gracias", "si", "hola"…) NO generan aviso (mismo
--     criterio de lista que el cerebro);
--   * un solo aviso ABIERTO de este tipo por chat (no se apila con cada mensaje).
-- Idempotente. No toca nada del proyecto 'reservas'.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.vl_wa_avisar_sin_respuesta(
    p_tenant_id uuid,
    p_wa_id text,
    p_texto text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_chat_id uuid;
    v_txt text;
    v_low text;
BEGIN
    IF p_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'tenant requerido');
    END IF;

    v_txt := btrim(COALESCE(p_texto, ''));
    -- Texto "solo palabras" (sin emojis ni signos, sin acentos) para reconocer un ACUSE.
    v_low := btrim(regexp_replace(
        translate(lower(v_txt), 'áéíóúüñ', 'aeioun'), '[^a-z ]', '', 'g'));

    IF v_low <> '' AND v_low ~
        '^(ok|okey|okay|dale|gracias|graci|muchas|muchisimas|jaja|jeje|si|sii+|sip|no|nop|ya|listo|hola|holi|holis|holas|buenas|buenos|hey|hi|perfecto|genial|buenisimo|excelente|cuidate|chao|adios|nos vemos|buen dia|buenas noches|buenas tardes)'
    THEN
        RETURN jsonb_build_object('ok', true, 'omitido', 'acuse');
    END IF;

    SELECT id INTO v_chat_id
    FROM public.vl_wa_chats
    WHERE tenant_id = p_tenant_id AND wa_id = p_wa_id;
    IF v_chat_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'chat no encontrado');
    END IF;

    -- Un solo aviso ABIERTO de este tipo por chat: no se apila con cada mensaje.
    IF EXISTS (
        SELECT 1 FROM public.vl_wa_avisos a
        WHERE a.chat_id = v_chat_id AND a.tipo = 'no_entendido' AND a.resuelto_en IS NULL
    ) THEN
        RETURN jsonb_build_object('ok', true, 'omitido', 'ya_habia');
    END IF;

    INSERT INTO public.vl_wa_avisos (tenant_id, chat_id, tipo, detalle)
    VALUES (
        p_tenant_id, v_chat_id, 'no_entendido',
        CASE WHEN v_txt = ''
             THEN 'Te escribió un cliente y el bot no respondió (revisa el chat). Contéstale tú.'
             ELSE 'El cliente escribió algo que el bot no supo responder ("'
                  || left(v_txt, 120) || '"). Contéstale tú.'
        END
    );

    RETURN jsonb_build_object('ok', true, 'creado', true, 'chat_id', v_chat_id);
END;
$$;

REVOKE ALL ON FUNCTION public.vl_wa_avisar_sin_respuesta(uuid, text, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_avisar_sin_respuesta(uuid, text, text) TO service_role, authenticated;
