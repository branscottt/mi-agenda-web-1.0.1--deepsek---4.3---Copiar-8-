-- ════════════════════════════════════════════════════════════════════════════
-- [VENTAS LIVE] (20261084) MANDAR FOTO/VIDEO con comentario desde el panel
--
-- Pedido del dueño: desde el chat poder mandarle al cliente una FOTO o un VIDEO
-- con un comentario, desde el computador, el celular o la tablet.
--
--   1. El panel sube el archivo al bucket privado 'vl-media', en la carpeta de
--      SU negocio ({tenant}/{chat}/{uuid}.ext). Hasta ahora SOLO el webhook
--      (service_role) escribía ahí; se le da permiso al negocio dueño. La ruta
--      lleva el tenant adelante porque la política de lectura ya filtra por esa
--      carpeta (misma regla de aislamiento entre negocios).
--   2. vl_wa_registrar_saliente_media(...) guarda el saliente con su archivo y
--      su comentario (igual que vl_wa_registrar_saliente hace con el texto):
--      aparece en el hilo, cierra los avisos abiertos y actualiza el resumen.
--      El envío real por WhatsApp lo hace la Edge Function wa-enviar.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. El negocio sube (y borra) sus propios medios ──────────────────────────
DROP POLICY IF EXISTS "Ventas Live sube sus medios" ON storage.objects;
CREATE POLICY "Ventas Live sube sus medios" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'vl-media'
    AND (storage.foldername(name))[1] = (public.get_vl_tenant_id())::text
  );

-- Para poder limpiar el archivo si el envío por WhatsApp falla.
DROP POLICY IF EXISTS "Ventas Live borra sus medios" ON storage.objects;
CREATE POLICY "Ventas Live borra sus medios" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'vl-media'
    AND (storage.foldername(name))[1] = (public.get_vl_tenant_id())::text
  );

GRANT EXECUTE ON FUNCTION public.get_vl_tenant_id() TO authenticated;

-- ── 2. Registrar el saliente CON archivo (foto/video) ────────────────────────
CREATE OR REPLACE FUNCTION public.vl_wa_registrar_saliente_media(
    p_chat_id uuid,
    p_texto text,
    p_tipo text,
    p_media_path text)
RETURNS jsonb
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
BEGIN
    SELECT * INTO v_chat FROM public.vl_wa_chats WHERE id = p_chat_id;
    IF v_chat.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Conversación no encontrada');
    END IF;

    v_tipo := lower(btrim(COALESCE(p_tipo, '')));
    IF v_tipo NOT IN ('imagen', 'video', 'documento') THEN
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
        ELSE '📎 Archivo'
    END;

    INSERT INTO public.vl_wa_mensajes
        (tenant_id, chat_id, direction, tipo, body, origen, media_path)
    VALUES
        (v_chat.tenant_id, v_chat.id, 'out', v_tipo,
         NULLIF(left(v_txt, 1000), ''), 'humano', v_path)
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
        'media_path', v_path
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_wa_registrar_saliente_media(uuid, text, text, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_registrar_saliente_media(uuid, text, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] foto/video con comentario desde el panel (20261084) OK' AS status;
