-- FIX del envío manual: quitar el OVERLOAD ambiguo que dejó la 20261093.
--
-- QUÉ PASÓ: la 20261093 agregó p_wamid/p_contexto_wa_id CON DEFAULT a las dos RPC
-- de registro, pero dejó vivas las firmas viejas. PostgREST no sabe elegir entre
-- dos candidatas cuando la nueva tiene defaults (devuelve PGRST203:
-- "Could not choose the best candidate function between: ..."), así que TODA
-- llamada con la firma vieja empezó a fallar. Como el error sale después de que
-- WhatsApp ya aceptó el mensaje, el panel mostraba 500
-- "El mensaje se envió pero no se pudo guardar en el historial" — el mensaje
-- llegaba al cliente pero NO quedaba en el historial.
--
-- FIX: borrar las firmas viejas. La nueva acepta las dos formas de llamada
-- porque los parámetros del wamid tienen DEFAULT NULL (llamadas de 2/4 args
-- siguen funcionando), pero queda UNA sola candidata y no hay ambigüedad.

DROP FUNCTION IF EXISTS public.vl_wa_registrar_saliente(uuid, text);
DROP FUNCTION IF EXISTS public.vl_wa_registrar_saliente_media(uuid, text, text, text);
