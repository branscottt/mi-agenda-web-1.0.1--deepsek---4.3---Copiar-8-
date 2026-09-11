-- ============================================================
-- MIGRACIÓN 20261028: Ventas Live — estados del chat v2
-- Fecha: 2026-10-11
--
-- El guion nuevo reemplaza las 3 preguntas encadenadas del envío
-- (ciudad / comuna / dirección) por un único paso de datos y agrega el
-- paso "presencial: transfiere ahora o paga al verse".
--
-- Estados viejos que dejan de existir:
--   esperando_ciudad, esperando_comuna, esperando_direccion
-- Estados nuevos:
--   esperando_datos_envio  (todos los datos de envío en un mensaje)
--   esperando_forma_pago   (presencial: esperando si transfiere o paga al verse)
-- ============================================================

ALTER TABLE public.vl_wa_chats
    DROP CONSTRAINT IF EXISTS vl_wa_chats_estado_check;

ALTER TABLE public.vl_wa_chats
    ADD CONSTRAINT vl_wa_chats_estado_check
    CHECK (estado IN (
        'nuevo',
        'esperando_tiktok',
        'esperando_tipo_entrega',
        'esperando_datos_envio',
        'esperando_forma_pago',
        'listo'
    ));

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] Estados del chat v2 OK' AS status;
