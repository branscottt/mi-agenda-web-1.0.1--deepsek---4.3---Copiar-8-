-- 20261121_ventas_live_media_100mb.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Chat de Ventas Live: que una foto o un video se pueda mandar SIEMPRE, sin
-- importar el celular, la tablet o el computador desde donde se mande.
--
-- QUÉ PASABA (reporte del dueño, 02/11): su pareja sacó una foto con el celular
-- y al mandarla por el chat de Ventas Live salió "error por tamaño".
--
-- CAUSA (bucket `vl-media` en producción):
--   file_size_limit    = 16.777.216 (16 MB)  ← una foto de 8 MB entraba, pero
--                                                un video de celular (>16 MB)
--                                                moría acá
--   allowed_mime_types = lista corta (sin image/heic, video/quicktime…)
--                        ← el video MOV del iPhone y la foto HEIC se rechazaban
--                          en la subida aunque pesaran poco
--
-- WhatsApp (Cloud API) acepta: foto 5 MB · video 16 MB · audio 16 MB ·
-- archivo 100 MB. Las fotos se reducen en el dispositivo (mediaPrep.js) y los
-- videos grandes van como archivo, así que el límite real es 100 MB.
--
-- QUÉ HACE ESTA MIGRACIÓN:
--   1. file_size_limit → 100 MB (el tope de WhatsApp para archivos).
--   2. allowed_mime_types → NULL: la validación de formato queda en la Edge
--      Function `wa-enviar` (whitelist por tipo), que es la que habla con Meta.
--      Sin esto, HEIC/MOV/WEBM no se podían ni subir.
--   3. No toca políticas RLS: la carpeta por negocio sigue igual.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE storage.buckets
   SET file_size_limit    = 104857600,   -- 100 MB
       allowed_mime_types = NULL
 WHERE id = 'vl-media';

-- Verificación (tiene que decir 104857600 y vacío en mimes):
--   SELECT id, file_size_limit, allowed_mime_types
--     FROM storage.buckets WHERE id = 'vl-media';

SELECT '[VENTAS LIVE] chat media: bucket vl-media hasta 100 MB y sin filtro de MIME (20261121) OK' AS status;
