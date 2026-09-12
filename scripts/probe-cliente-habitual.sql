-- probe-cliente-habitual.sql — PROBE del flujo de CLIENTE HABITUAL (migración 20261039)
--
-- Corre TODO dentro de una sola transacción, sobre un tenant de PRUEBA que este
-- mismo archivo crea y que se borra con probe-cliente-habitual-limpiar.sql.
-- NUNCA apuntar a un tenant real: acá se crean clientes y chats ficticios.
--
-- Nota de honestidad sobre los tiempos: dentro de una transacción `now()` es la
-- hora de inicio de la transacción, así que la prenda se carga con
-- `creado_en = now() + interval '3 seconds'` para simular lo que pasa de verdad
-- (el negocio carga la prenda y DESPUÉS llega el pantallazo, en transacciones
-- distintas). No es un parche al producto: es cómo el probe representa el orden.

BEGIN;

-- ── 0. Tenant de prueba ────────────────────────────────────────────────────
DELETE FROM public.vl_wa_avisos  WHERE tenant_id = '00000000-0000-4000-8000-000000002039';
DELETE FROM public.vl_wa_mensajes WHERE tenant_id = '00000000-0000-4000-8000-000000002039';
DELETE FROM public.vl_wa_chats   WHERE tenant_id = '00000000-0000-4000-8000-000000002039';
DELETE FROM public.vl_envios     WHERE tenant_id = '00000000-0000-4000-8000-000000002039';
DELETE FROM public.vl_items      WHERE tenant_id = '00000000-0000-4000-8000-000000002039';
DELETE FROM public.vl_procesos   WHERE tenant_id = '00000000-0000-4000-8000-000000002039';
DELETE FROM public.vl_clientes   WHERE tenant_id = '00000000-0000-4000-8000-000000002039';
DELETE FROM public.vl_config     WHERE tenant_id = '00000000-0000-4000-8000-000000002039';
DELETE FROM public.subscriptions WHERE tenant_id = '00000000-0000-4000-8000-000000002039';
DELETE FROM public.tenants       WHERE id = '00000000-0000-4000-8000-000000002039';

INSERT INTO public.tenants (id, nombre_negocio, email_contacto, proyecto)
VALUES ('00000000-0000-4000-8000-000000002039', 'ZZ Probe Habitual', 'zz-probe@example.com', 'ventas_live');

INSERT INTO public.vl_config (tenant_id, datos_pago)
VALUES ('00000000-0000-4000-8000-000000002039', 'Banco ZZ' || chr(10) || 'Cuenta 000-111' || chr(10) || 'Titular: Prueba');

-- Clientes: A y C ya se identificaron alguna vez (tienen whatsapp), B es nuevo.
INSERT INTO public.vl_clientes (id, tenant_id, tiktok_user, whatsapp)
VALUES ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000002039', 'habitual_probe', '+56900000011'),
       ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-000000002039', 'nuevo_probe',    ''),
       ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000002039', 'datos_probe',    '+56900000012');

INSERT INTO public.vl_procesos (id, tenant_id, cliente_id, estado)
VALUES ('00000000-0000-4000-8000-0000000010a1', '00000000-0000-4000-8000-000000002039', '00000000-0000-4000-8000-0000000000a1', 'esperando_pago'),
       ('00000000-0000-4000-8000-0000000010b1', '00000000-0000-4000-8000-000000002039', '00000000-0000-4000-8000-0000000000b1', 'esperando_whatsapp'),
       ('00000000-0000-4000-8000-0000000010c1', '00000000-0000-4000-8000-000000002039', '00000000-0000-4000-8000-0000000000c1', 'esperando_pago');

INSERT INTO public.vl_items (tenant_id, proceso_id, descripcion, precio)
VALUES ('00000000-0000-4000-8000-000000002039', '00000000-0000-4000-8000-0000000010a1', 'polera', 5000),
       ('00000000-0000-4000-8000-000000002039', '00000000-0000-4000-8000-0000000010a1', 'short',  5000),
       ('00000000-0000-4000-8000-000000002039', '00000000-0000-4000-8000-0000000010b1', 'poleron', 9000),
       ('00000000-0000-4000-8000-000000002039', '00000000-0000-4000-8000-0000000010c1', 'vestido', 7000);

-- ── Bitácora de la simulación ──────────────────────────────────────────────
CREATE TEMP TABLE probe_log (paso text, enviar text, mensaje text, estado text, aviso text);

-- ═══ CASO 1: cliente DESCONOCIDO (no hay cliente con ese WhatsApp) ═════════
INSERT INTO probe_log
SELECT '1a. desconocido escribe "hola"', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000001', 'hola', 'texto') AS r) s;

INSERT INTO probe_log
SELECT '1b. escribe su usuario ("soy nuevo_probe")', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000001', 'soy nuevo_probe', 'texto') AS r) s;

INSERT INTO probe_log
SELECT '1c. confirma ("si")', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000001', 'si', 'texto') AS r) s;

-- ═══ CASO 2: cliente HABITUAL reconocido por su WhatsApp ═══════════════════
INSERT INTO probe_log
SELECT '2a. habitual escribe "hola"', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000011', 'hola', 'texto') AS r) s;

-- El negocio le carga una prenda ANTES de que llegue el pantallazo.
INSERT INTO public.vl_items (tenant_id, proceso_id, descripcion, precio, creado_en)
VALUES ('00000000-0000-4000-8000-000000002039', '00000000-0000-4000-8000-0000000010a1', 'chaqueta', 12000, now() + interval '3 seconds');

INSERT INTO probe_log
SELECT '2b. primer pantallazo de la prenda', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000011', 'como se ve?', 'imagen') AS r) s;

-- El negocio cargó la prenda y DESPUÉS el bot ya habló: se envejece la prenda
-- para que el probe represente esa secuencia (en la vida real son transacciones
-- distintas; acá todo el probe ocurre en una sola y comparte el timestamp).
UPDATE public.vl_items SET creado_en = now() - interval '1 hour'
 WHERE proceso_id = '00000000-0000-4000-8000-0000000010a1' AND descripcion = 'chaqueta';

INSERT INTO probe_log
SELECT '2c. SEGUNDO pantallazo (no debe repetir)', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000011', '', 'imagen') AS r) s;

INSERT INTO probe_log
SELECT '2d. dice "quiero pagar"', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000011', 'quiero pagar', 'texto') AS r) s;

INSERT INTO probe_log
SELECT '2e. manda el comprobante de pago', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000011', 'ya transferi', 'imagen') AS r) s;

-- ═══ CASO 3: habitual que pide los datos para transferir ═══════════════════
INSERT INTO probe_log
SELECT '3a. otro habitual escribe "hola"', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000012', 'hola', 'texto') AS r) s;

INSERT INTO probe_log
SELECT '3b. pide los datos ("me mandas los datos")', r->>'enviar', left(r->>'mensaje', 400), r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000012', 'me mandas los datos para transferir', 'texto') AS r) s;

-- ═══ CASO 4: chat que quedó en estado "listo" (como los de antes de esta mejora) ═══
UPDATE public.vl_wa_chats SET estado = 'listo'
 WHERE tenant_id = '00000000-0000-4000-8000-000000002039' AND wa_id = '+56900000012';

INSERT INTO probe_log
SELECT '4a. en listo dice "ya transferi" (aviso de pago)', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000012', 'ya transferi', 'texto') AS r) s;

INSERT INTO probe_log
SELECT '4b. en listo dice "quiero pagar" (pregunta)', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000012', 'quiero pagar', 'texto') AS r) s;

-- ═══ CASO 5: cliente reconocido a MITAD de un paso dice "hola" ═══
-- No debe perder el paso (elegir envío/presencial) ni la identidad.
INSERT INTO probe_log
SELECT '5a. cliente en paso pendiente dice "hola"', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000001', 'hola', 'texto') AS r) s;

-- ═══ CASO 6: BUG REAL DE PRODUCCIÓN (2026-09-12) ═══
-- Cliente habitual que YA recibió los datos de pago en una conversación anterior
-- (datos_pago_enviado_en marcado) y con el pedido en esperando_pago: antes, ESE
-- estado convertía el pantallazo de la prenda en "comprobante" y el bot no decía
-- nada. Debe confirmar la prenda igual.
INSERT INTO public.vl_clientes (id, tenant_id, tiktok_user, whatsapp)
VALUES ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-000000002039', 'prod_probe', '+56900000013');

INSERT INTO public.vl_procesos (id, tenant_id, cliente_id, estado)
VALUES ('00000000-0000-4000-8000-0000000010d1', '00000000-0000-4000-8000-000000002039',
        '00000000-0000-4000-8000-0000000000d1', 'esperando_pago');

INSERT INTO public.vl_items (tenant_id, proceso_id, descripcion, precio, creado_en)
VALUES ('00000000-0000-4000-8000-000000002039', '00000000-0000-4000-8000-0000000010d1', 'poleron viejo', 8000, now() - interval '2 days');

INSERT INTO probe_log
SELECT '6a. habitual dice "holis"', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000013', 'holis', 'texto') AS r) s;

-- La conversación ANTERIOR ya le había mandado los datos de pago:
UPDATE public.vl_wa_chats SET datos_pago_enviado_en = now() - interval '2 days'
 WHERE tenant_id = '00000000-0000-4000-8000-000000002039' AND wa_id = '+56900000013';

-- El negocio le carga una prenda AHORA y el cliente manda el pantallazo:
INSERT INTO public.vl_items (tenant_id, proceso_id, descripcion, precio, creado_en)
VALUES ('00000000-0000-4000-8000-000000002039', '00000000-0000-4000-8000-0000000010d1', 'chaqueta nueva', 15000, now() + interval '3 seconds');

INSERT INTO probe_log
SELECT '6b. pantallazo de la prenda (BUG: antes salía comprobante)', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000013', '', 'imagen') AS r) s;

-- ═══ CASO 7: EL CHAT REAL (el de "Anubis") puesto en orden ═══
-- Cliente sin WhatsApp guardado (como el primer contacto real): el bot tiene que
-- reconocerla desde lo que escribe, sin pedirle el usuario dos veces.
INSERT INTO public.vl_clientes (id, tenant_id, tiktok_user, nombre_real, whatsapp)
VALUES ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-000000002039', 'anubis', 'Anubis Galindo', '');
INSERT INTO public.vl_procesos (id, tenant_id, cliente_id, estado)
VALUES ('00000000-0000-4000-8000-0000000010e1', '00000000-0000-4000-8000-000000002039', '00000000-0000-4000-8000-0000000000e1', 'esperando_whatsapp');
INSERT INTO public.vl_items (tenant_id, proceso_id, descripcion, precio, creado_en)
VALUES ('00000000-0000-4000-8000-000000002039', '00000000-0000-4000-8000-0000000010e1', 'polera', 12000, now() - interval '2 days'),
       ('00000000-0000-4000-8000-000000002039', '00000000-0000-4000-8000-0000000010e1', 'cartera', 12000, now() - interval '2 days');

INSERT INTO probe_log
SELECT '7a. "Hola." (tramo 1)', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000014', 'Hola.', 'texto') AS r) s;

INSERT INTO probe_log
SELECT '7b. "Aquí Anubis" (tramo 2)', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000014', 'Aquí Anubis', 'texto') AS r) s;

INSERT INTO probe_log
SELECT '7c. "Sii" (confirma)', r->>'enviar', left(r->>'mensaje',120), r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000014', 'Sii', 'texto') AS r) s;

INSERT INTO probe_log
SELECT '7d. "Envio"', r->>'enviar', left(r->>'mensaje',110), r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000014', 'Envio', 'texto') AS r) s;

INSERT INTO probe_log
SELECT '7e. "Por blue por favor" (courier suelto)', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000014', 'Por blue por favor', 'texto') AS r) s;

INSERT INTO probe_log
SELECT '7f. "Mis datos" (tramo, todavía sin datos)', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000014', 'Mis datos', 'texto') AS r) s;

INSERT INTO probe_log
SELECT '7g. "Déjeme hacerle su pago" (tramo)', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000014', 'Déjeme hacerle su pago', 'texto') AS r) s;

INSERT INTO probe_log
SELECT '7h. manda los datos completos (tramo final)', r->>'enviar', left(r->>'mensaje',150), r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000014', 'Juan Pérez, Av. Siempre Viva 742, Maipú, +56912345678, juan@correo.cl', 'texto') AS r) s;

INSERT INTO probe_log
SELECT '7i. "no e podido transferir, me puede esperar?"', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000014', 'no e podido transferir, bloquee la app por error, me puede esperar hasta el lunes porfavor?', 'texto') AS r) s;

INSERT INTO probe_log
SELECT '7j. "por favor me envía sus datos para transferir"', r->>'enviar', left(r->>'mensaje',130), r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000014', 'por favor me envía sus datos para transferir', 'texto') AS r) s;

-- ═══ CASO 8: conversación POR TRAMOS y no redundante ═══
INSERT INTO public.vl_clientes (id, tenant_id, tiktok_user, nombre_real, whatsapp)
VALUES ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-000000002039', 'tramos_probe', '', '');

INSERT INTO probe_log
SELECT '8a. "soy" (primer mensaje)', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000015', 'soy', 'texto') AS r) s;

-- Hora explícita por paso (en una transacción todos los mensajes comparten
-- now(); así el bot ve el orden real).
UPDATE public.vl_wa_mensajes SET creado_en = timestamptz '2026-01-01 00:01:00+00'
 WHERE chat_id = (SELECT id FROM public.vl_wa_chats WHERE tenant_id = '00000000-0000-4000-8000-000000002039' AND wa_id = '+56900000015');


INSERT INTO probe_log
SELECT '8b. "soy" otra vez (tramo sin contenido: NO repite)', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000015', 'soy', 'texto') AS r) s;

-- Hora explícita por paso (en una transacción todos los mensajes comparten
-- now(); así el bot ve el orden real).
UPDATE public.vl_wa_mensajes SET creado_en = timestamptz '2026-01-01 00:02:00+00'
 WHERE chat_id = (SELECT id FROM public.vl_wa_chats WHERE tenant_id = '00000000-0000-4000-8000-000000002039' AND wa_id = '+56900000015');


INSERT INTO probe_log
SELECT '8c. "tramos_probe" (completa el tramo)', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000015', 'tramos_probe', 'texto') AS r) s;

-- Hora explícita por paso (en una transacción todos los mensajes comparten
-- now(); así el bot ve el orden real).
UPDATE public.vl_wa_mensajes SET creado_en = timestamptz '2026-01-01 00:03:00+00'
 WHERE chat_id = (SELECT id FROM public.vl_wa_chats WHERE tenant_id = '00000000-0000-4000-8000-000000002039' AND wa_id = '+56900000015');


-- ═══ CASO 9: foto sin identificar y redundancia ═══
INSERT INTO probe_log
SELECT '9a. foto de un número desconocido', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000016', '', 'imagen') AS r) s;

INSERT INTO probe_log
SELECT '9b. "reiniciar" (vuelve al inicio)', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000015', 'reiniciar', 'texto') AS r) s;

-- Hora explícita por paso (en una transacción todos los mensajes comparten
-- now(); así el bot ve el orden real).
UPDATE public.vl_wa_mensajes SET creado_en = timestamptz '2026-01-01 00:04:00+00'
 WHERE chat_id = (SELECT id FROM public.vl_wa_chats WHERE tenant_id = '00000000-0000-4000-8000-000000002039' AND wa_id = '+56900000015');


INSERT INTO probe_log
SELECT '9c. usuario inexistente 1° vez', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000015', 'llorens', 'texto') AS r) s;

-- Hora explícita por paso (en una transacción todos los mensajes comparten
-- now(); así el bot ve el orden real).
UPDATE public.vl_wa_mensajes SET creado_en = timestamptz '2026-01-01 00:05:00+00'
 WHERE chat_id = (SELECT id FROM public.vl_wa_chats WHERE tenant_id = '00000000-0000-4000-8000-000000002039' AND wa_id = '+56900000015');


-- Ojo del probe: dentro de UNA transacción todos los mensajes comparten now();
-- se adelanta el último "out" un segundo para que el bot lo vea como su mensaje
-- anterior (en la vida real cada mensaje tiene su propia hora).
UPDATE public.vl_wa_mensajes SET creado_en = creado_en + interval '1 second'
 WHERE direction = 'out' AND body LIKE 'no encontre%'
   AND chat_id = (SELECT id FROM public.vl_wa_chats
                  WHERE tenant_id = '00000000-0000-4000-8000-000000002039' AND wa_id = '+56900000015');

INSERT INTO probe_log
SELECT '9d. usuario inexistente 2° vez (NO repite)', r->>'enviar', r->>'mensaje', r->>'chat_estado', COALESCE(r->>'aviso_tipo','')
FROM (SELECT public.vl_wa_conversacion_avanzar('00000000-0000-4000-8000-000000002039', '+56900000015', 'llorens', 'texto') AS r) s;

-- ── Evidencia ──────────────────────────────────────────────────────────────
CREATE TEMP TABLE probe_evidencia AS
SELECT jsonb_pretty(jsonb_build_object(
  'pasos', (SELECT jsonb_agg(jsonb_build_object(
                'paso', paso, 'enviar', enviar, 'respuesta_del_bot', mensaje,
                'estado_chat', estado, 'aviso', aviso) ORDER BY ctid)
            FROM probe_log),
  'chats', (SELECT jsonb_agg(jsonb_build_object(
                'wa_id', wa_id, 'estado', estado, 'modo', modo,
                'cliente', COALESCE((SELECT tiktok_user FROM public.vl_clientes c WHERE c.id = ch.cliente_id), 'SIN_CLIENTE'),
                'saludo_habitual_en', (saludo_habitual_en IS NOT NULL),
                'prendas_respondido_en', (prendas_respondido_en IS NOT NULL)) ORDER BY wa_id)
            FROM public.vl_wa_chats ch WHERE ch.tenant_id = '00000000-0000-4000-8000-000000002039'),
  'avisos', (SELECT COALESCE(jsonb_agg(jsonb_build_object('tipo', tipo, 'resuelto', (resuelto_en IS NOT NULL), 'detalle', left(detalle, 90)) ORDER BY creado_en), '[]'::jsonb)
             FROM public.vl_wa_avisos a WHERE a.tenant_id = '00000000-0000-4000-8000-000000002039'),
  'conteo_avisos_por_tipo', (SELECT COALESCE(jsonb_object_agg(tipo, n), '{}'::jsonb)
             FROM (SELECT tipo, count(*)::int AS n FROM public.vl_wa_avisos
                    WHERE tenant_id = '00000000-0000-4000-8000-000000002039' GROUP BY tipo) t),
  'whatsapp_guardado_de_nuevo_probe', (SELECT COALESCE(whatsapp, '(vacio)') FROM public.vl_clientes
             WHERE id = '00000000-0000-4000-8000-0000000000b1'),
  'mensajes_por_chat', (SELECT COALESCE(jsonb_agg(jsonb_build_object('wa', wa_id, 'in', n_in, 'out', n_out) ORDER BY wa_id), '[]'::jsonb)
             FROM (SELECT ch.wa_id,
                          count(*) FILTER (WHERE m.direction = 'in')  AS n_in,
                          count(*) FILTER (WHERE m.direction = 'out') AS n_out
                   FROM public.vl_wa_chats ch
                   JOIN public.vl_wa_mensajes m ON m.chat_id = ch.id
                   WHERE ch.tenant_id = '00000000-0000-4000-8000-000000002039'
                   GROUP BY ch.wa_id) z)
)) AS ev;

SELECT ev FROM probe_evidencia;

ROLLBACK;

-- Si algo quedó grabado (ROLLBACK no debería dejar nada), limpiar con:
--   supabase db query --linked -f scripts/probe-cliente-habitual-limpiar.sql
