-- 20261125 · Ventas Live: que un mensaje NO entregado no pase desapercibido.
--
-- Caso real (02/11/2026): a una clienta le mandaron el código de seguimiento
-- 4 días después de su último mensaje. WhatsApp (ventana de 24 h) lo aceptó y
-- después lo marcó 'failed': nunca llegó y el dueño se enteró por un pantallazo
-- de la propia clienta. El panel lo guardaba como 'fallido', pero el único
-- aviso era el tooltip del ⚠ (invisible en el celular).
--
-- Se agrega 'no_entregados' a la LISTA de conversaciones: cuántos mensajes
-- nuestros fallaron y todavía no tienen un reenvío exitoso con el mismo
-- texto/tipo. Así se ve en la lista (chip + badge) sin abrir el chat, y el
-- número baja solo cuando el reenvío sale bien (nada de limpiar a mano).

BEGIN;

CREATE OR REPLACE FUNCTION public.vl_wa_chats_listar()
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
 AS $function$
 DECLARE
     v_tenant uuid;
 BEGIN
     v_tenant := public.get_vl_tenant_id();
     IF v_tenant IS NULL THEN
         RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
     END IF;
     IF NOT public.is_admin() THEN
         RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
     END IF;
     RETURN jsonb_build_object(
         'ok', true,
         'chats', COALESCE((
             SELECT jsonb_agg(fila ORDER BY (fila->>'fijado') DESC, (fila->>'ultimo_en') DESC)
             FROM (
                 SELECT jsonb_build_object(
                     'id', c.id,
                     'wa_id', c.wa_id,
                     'estado', c.estado,
                     'modo', c.modo,
                     'oculto', c.oculto,
             'silenciado', COALESCE(c.silenciado, false),
             'archivado', COALESCE(c.archivado, false),
             'fijado', COALESCE(c.fijado, false),
                     'ultimo_mensaje', c.ultimo_mensaje,
                     'ultimo_en', c.ultimo_en,
                     'ultimo_dir', COALESCE(um.direction, ''),
                     'ultimo_origen', COALESCE(um.origen, ''),
                    -- MENSAJES QUE WHATSAPP NO ENTREGÓ (ventana de 24 h cerrada):
                    -- se ven en la LISTA, sin abrir el chat, y cuentan para el badge.
                    -- Dejan de contar solos cuando se reenvía bien (queda un saliente
                    -- con el mismo texto/tipo ya entregado después del fallido).
                    'no_entregados', (
                        SELECT count(*) FROM public.vl_wa_mensajes m3
                        WHERE m3.chat_id = c.id
                          AND m3.direction = 'out'
                          AND m3.estado_wa = 'fallido'
                          AND m3.creado_en > now() - interval '30 days'
                          AND NOT EXISTS (
                              SELECT 1 FROM public.vl_wa_mensajes m4
                              WHERE m4.chat_id = c.id
                                AND m4.direction = 'out'
                                AND m4.estado_wa IN ('enviado','entregado','leido')
                                AND m4.creado_en > m3.creado_en
                                AND COALESCE(m4.tipo,'texto') = COALESCE(m3.tipo,'texto')
                                AND COALESCE(m4.body,'') = COALESCE(m3.body,'')
                          )
                    ),
                     'cliente_id', c.cliente_id,
                     'tiktok_user', COALESCE(cl.tiktok_user, ''),
                     'nombre_real', COALESCE(cl.nombre_real, ''),
                     'categoria', COALESCE(cl.categoria, 'nuevo'),
                     -- PAGOS (para saber, sin abrir el chat: quién pagó, a quién
                     -- falta confirmarle el pago y a quién hay que entregarle ya).
                     'pago_total', COALESCE(pg.total, 0),
                     'pago_abonado', COALESCE(pg.abonado, 0),
                     'pago_saldo', GREATEST(0, COALESCE(pg.total, 0) - COALESCE(pg.abonado, 0)),
                     'pagos_count', COALESCE(pg.pagos, 0),
                     'entrega_tipo', COALESCE(prl.entrega_tipo, ''),
                     'entrega_pendiente', (prl.proceso_id IS NOT NULL
                                           AND COALESCE(pg.total, 0) > 0
                                           AND COALESCE(pg.total, 0) - COALESCE(pg.abonado, 0) <= 0
                                           AND COALESCE(prl.entregado, false) = false),
                     'pago_por_confirmar', (COALESCE(av.tipo, '') IN ('comprobante', 'pago')),
                     'ultimo_live_etiqueta', COALESCE(lv.etiqueta, ''),
                     'ultimo_live_fecha', to_char(lv.abierto_en, 'YYYY-MM-DD'),
                     'pago_en_ultimo_live', (COALESCE(pg.pagos, 0) > 0
                                             AND pg.ultimo_live IS NOT NULL
                                             AND pg.ultimo_live = ult.id),
                     'tiene_aviso', (av.tipo IS NOT NULL)
                                    OR (COALESCE(prl.saldo, 0) > 0 AND COALESCE(prl.dias, 0) >= 3),
                     'aviso_tipo', COALESCE(
                         av.tipo,
                         CASE WHEN COALESCE(prl.saldo, 0) > 0 AND COALESCE(prl.dias, 0) >= 3
                              THEN 'soltar_prenda' ELSE '' END,
                         ''
                     ),
                     'aviso_detalle', COALESCE(
                         av.detalle,
                         CASE WHEN COALESCE(prl.saldo, 0) > 0 AND COALESCE(prl.dias, 0) >= 3
                              THEN 'Sin contacto hace ' || prl.dias || ' día(s) y debe '
                                   || public.vl_wa_fmt_monto(prl.saldo)
                              ELSE '' END,
                         ''
                     ),
                     'proceso', public.vl_proceso_puntos(prl.proceso_id),
                     'sin_leer', (
                         SELECT count(*) FROM public.vl_wa_mensajes m
                         WHERE m.chat_id = c.id
                           AND m.direction = 'in'
                           AND m.creado_en > c.leido_en
                     )
                 ) AS fila
                 FROM public.vl_wa_chats c
                 LEFT JOIN public.vl_clientes cl ON cl.id = c.cliente_id
                 LEFT JOIN LATERAL (
                     SELECT m.direction, m.origen
                     FROM public.vl_wa_mensajes m
                     WHERE m.chat_id = c.id
                     ORDER BY m.creado_en DESC, m.id DESC
                     LIMIT 1
                 ) um ON true
                 LEFT JOIN LATERAL (
                     SELECT a.tipo, a.detalle
                     FROM public.vl_wa_avisos a
                     WHERE a.chat_id = c.id AND a.resuelto_en IS NULL
                     ORDER BY a.creado_en DESC
                     LIMIT 1
                 ) av ON true
                 LEFT JOIN LATERAL (
                     SELECT pr.id AS proceso_id,
                            public.vl_saldo_proceso(pr.id) AS saldo,
                            COALESCE((SELECT ev.tipo FROM public.vl_envios ev
                                      WHERE ev.proceso_id = pr.id AND ev.estado <> 'cancelado'
                                      ORDER BY ev.creado_en DESC LIMIT 1), '') AS entrega_tipo,
                            (pr.estado = 'completado'
                             OR COALESCE((SELECT ev.estado = 'entregado' FROM public.vl_envios ev
                                          WHERE ev.proceso_id = pr.id AND ev.estado <> 'cancelado'
                                          ORDER BY ev.creado_en DESC LIMIT 1), false)) AS entregado,
                            GREATEST(0, CURRENT_DATE - COALESCE((
                                SELECT max(m2.creado_en) FROM public.vl_wa_mensajes m2
                                WHERE m2.chat_id = c.id AND m2.direction = 'in'
                            ), c.creado_en)::date) AS dias
                     FROM public.vl_procesos pr
                     WHERE pr.cliente_id = c.cliente_id AND pr.cerrado_en IS NULL
                     ORDER BY pr.creado_en DESC
                     LIMIT 1
                 ) prl ON true
                 -- Prendas y pagos del pedido abierto (para la etiqueta de pago)
                 LEFT JOIN LATERAL (
                     SELECT COALESCE(SUM(i.precio), 0) AS total,
                            COALESCE(SUM(i.abonado), 0) AS abonado,
                            (SELECT count(*) FROM public.vl_pagos p
                              WHERE p.proceso_id = prl.proceso_id) AS pagos,
                            (SELECT i2.live_id FROM public.vl_items i2
                              WHERE i2.proceso_id = prl.proceso_id AND i2.estado <> 'liberada'
                              ORDER BY i2.creado_en DESC LIMIT 1) AS ultimo_live
                     FROM public.vl_items i
                     WHERE i.proceso_id = prl.proceso_id AND i.estado <> 'liberada'
                 ) pg ON true
                 -- LIVE de esas prendas (nombre y fecha para el chip)
                 LEFT JOIN LATERAL (
                     SELECT l.etiqueta, l.abierto_en
                     FROM public.vl_lives l WHERE l.id = pg.ultimo_live
                 ) lv ON true
                 -- Último LIVE del espacio (para saber si pagó "en el último live")
                 LEFT JOIN LATERAL (
                     SELECT l.id FROM public.vl_lives l
                     WHERE l.tenant_id = v_tenant
                     ORDER BY l.abierto_en DESC LIMIT 1
                 ) ult ON true
                 WHERE c.tenant_id = v_tenant
             ) sub
         ), '[]'::jsonb)
     );
 END;
 $function$;

REVOKE ALL ON FUNCTION public.vl_wa_chats_listar() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_chats_listar() TO authenticated;

REVOKE ALL ON FUNCTION public.vl_wa_chats_listar() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_chats_listar() TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
