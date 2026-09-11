-- ============================================================
-- MIGRACIÓN 20261031: Ventas Live — un chat nuevo nace SIN LEER
-- Fecha: 2026-10-11
--
-- Problema: vl_wa_chats.leido_en nacía con DEFAULT now(), y el mensaje
-- entrante se inserta en la MISMA transacción, así que `creado_en > leido_en`
-- daba falso y el contador de no leídos quedaba en 0. En la práctica: el
-- primer mensaje de un cliente nuevo NO marcaba el badge de "sin leer" en el
-- panel (justo la señal que se usa para darse cuenta de que alguien escribió).
--
-- Fix: la columna nace en época (todo sin leer) hasta que el admin abre el
-- chat (vl_wa_chat_hilo pone leido_en = now()).
-- ============================================================

ALTER TABLE public.vl_wa_chats
    ALTER COLUMN leido_en SET DEFAULT to_timestamp(0);

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] Chat nuevo nace sin leer OK' AS status;
