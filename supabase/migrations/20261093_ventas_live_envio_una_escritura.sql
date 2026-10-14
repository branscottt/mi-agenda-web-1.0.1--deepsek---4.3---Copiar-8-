-- ventas-live: el envío manual pasa a hacer UNA sola escritura en vez de dos.
--
-- PROBLEMA medido en vivo (2026-10-14): mandar un texto costaba ~1,5 s porque el
-- navegador esperaba 3 saltos de red secuenciales DESPUÉS de hablar con WhatsApp:
--   1) vl_wa_chat_para_envio   (~300 ms)  → credenciales del negocio + permiso
--   2) Meta Graph POST /messages (~450 ms) → el envío real (irreducible)
--   3) vl_wa_registrar_saliente (~300 ms) → la fila del mensaje en el historial
--   4) vl_wa_guardar_meta_wa    (~300 ms) → el wamid, para poder citar ese mensaje
-- Cada RPC por PostgREST cuesta ~300 ms (medido con 5 tomas: 299-505 ms; el piso
-- de red a Supabase es ~70 ms, el resto es auth + PostgREST + Postgres).
--
-- SOLUCIÓN: el wamid (y la cita) entran en la MISMA inserción del saliente, así
-- que el paso 4 desaparece del camino crítico. Además queda MÁS EXACTO: antes el
-- wamid se pegaba a la fila "más parecida de los últimos 15 minutos" (heurística
-- por texto/cuerpo, frágil si se manda dos veces lo mismo); ahora cae exacto en
-- su propia fila, sin heurística y sin carrera.
--
-- Compatibilidad: los parámetros nuevos van con DEFAULT NULL, así que cualquier
-- llamada vieja (2 o 4 argumentos) sigue funcionando igual.

-- ── 1) Saliente de TEXTO ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.vl_wa_registrar_saliente(
    p_chat_id uuid,
    p_texto text,
    p_wamid text DEFAULT NULL,
    p_contexto_wa_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_chat public.vl_wa_chats%ROWTYPE;
    v_txt text;
    v_msg_id uuid;
    v_creado timestamptz;
    v_wamid text := NULLIF(btrim(COALESCE(p_wamid, '')), '');
    v_ctx   text := NULLIF(btrim(COALESCE(p_contexto_wa_id, '')), '');
BEGIN
    SELECT * INTO v_chat FROM public.vl_wa_chats WHERE id = p_chat_id;
    IF v_chat.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Conversación no encontrada');
    END IF;
    v_txt := btrim(COALESCE(p_texto, ''));
    IF v_txt = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Mensaje vacío');
    END IF;
    INSERT INTO public.vl_wa_mensajes
        (tenant_id, chat_id, direction, tipo, body, origen, wa_message_id, context_wa_id, estado_wa)
    VALUES
        (v_chat.tenant_id, v_chat.id, 'out', 'texto', left(v_txt, 1000), 'humano',
         v_wamid, v_ctx, CASE WHEN v_wamid IS NULL THEN NULL ELSE 'enviado' END)
    RETURNING id, creado_en INTO v_msg_id, v_creado;
    UPDATE public.vl_wa_chats
    SET ultimo_mensaje = left(v_txt, 200),
        ultimo_en = now(),
        leido_en = now()
    WHERE id = v_chat.id;
    -- El humano ya respondió: los avisos abiertos de este chat quedan cerrados
    UPDATE public.vl_wa_avisos
    SET resuelto_en = now()
    WHERE chat_id = v_chat.id AND resuelto_en IS NULL;
    RETURN jsonb_build_object(
        'ok', true,
        'mensaje_id', v_msg_id,
        'creado_en', v_creado,
        'body', left(v_txt, 1000),
        'wa_message_id', v_wamid
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_wa_registrar_saliente(uuid, text, text, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_registrar_saliente(uuid, text, text, text) TO service_role;

-- ── 2) Saliente de ARCHIVO/FOTO/VIDEO/AUDIO ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.vl_wa_registrar_saliente_media(
    p_chat_id uuid,
    p_texto text,
    p_tipo text,
    p_media_path text,
    p_wamid text DEFAULT NULL,
    p_contexto_wa_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_chat     public.vl_wa_chats%ROWTYPE;
    v_txt      text;
    v_tipo     text;
    v_path     text;
    v_resumen  text;
    v_msg_id   uuid;
    v_creado   timestamptz;
    v_wamid    text := NULLIF(btrim(COALESCE(p_wamid, '')), '');
    v_ctx      text := NULLIF(btrim(COALESCE(p_contexto_wa_id, '')), '');
BEGIN
    SELECT * INTO v_chat FROM public.vl_wa_chats WHERE id = p_chat_id;
    IF v_chat.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Conversación no encontrada');
    END IF;
    v_tipo := lower(btrim(COALESCE(p_tipo, '')));
    IF v_tipo NOT IN ('imagen', 'video', 'documento', 'audio') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Tipo de archivo no soportado');
    END IF;
    -- El archivo tiene que estar en la carpeta del negocio de ESTA conversación.
    v_path := btrim(COALESCE(p_media_path, ''));
    IF v_path = ''
       OR left(v_path, length(v_chat.tenant_id::text) + 1) <> v_chat.tenant_id::text || '/' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El archivo no es de este negocio');
    END IF;
    v_txt := btrim(COALESCE(p_texto, ''));
    v_resumen := CASE
        WHEN v_txt <> '' THEN v_txt
        WHEN v_tipo = 'imagen' THEN '📷 Foto'
        WHEN v_tipo = 'video' THEN '🎬 Video'
        WHEN v_tipo = 'audio' THEN '🎤 Audio'
        ELSE '📎 Archivo'
    END;
    INSERT INTO public.vl_wa_mensajes
        (tenant_id, chat_id, direction, tipo, body, origen, media_path, wa_message_id, context_wa_id, estado_wa)
    VALUES
        (v_chat.tenant_id, v_chat.id, 'out', v_tipo,
         left(v_txt, 1000), 'humano', v_path,
         v_wamid, v_ctx, CASE WHEN v_wamid IS NULL THEN NULL ELSE 'enviado' END)
    RETURNING id, creado_en INTO v_msg_id, v_creado;
    UPDATE public.vl_wa_chats
       SET ultimo_mensaje = left(v_resumen, 200),
           ultimo_en = now(),
           leido_en = now()
     WHERE id = v_chat.id;
    -- El humano ya respondió: los avisos abiertos de este chat quedan cerrados
    UPDATE public.vl_wa_avisos
        SET resuelto_en = now()
      WHERE chat_id = v_chat.id AND resuelto_en IS NULL;
    RETURN jsonb_build_object(
        'ok', true,
        'mensaje_id', v_msg_id,
        'creado_en', v_creado,
        'body', v_resumen,
        'media_path', v_path,
        'wa_message_id', v_wamid
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_wa_registrar_saliente_media(uuid, text, text, text, text, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_registrar_saliente_media(uuid, text, text, text, text, text) TO authenticated, service_role;
