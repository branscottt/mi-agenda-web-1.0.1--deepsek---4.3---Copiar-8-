-- Ventas Live: silenciar / archivar / fijar conversaciones (como WhatsApp).
--
-- Tres preferencias POR CONVERSACIÓN. Se resuelven con una sola RPC chica
-- (vl_wa_chat_preferencia) en vez de uno por acción, y la propia lista
-- (vl_wa_chats_listar) ya devuelve los tres campos con los FIJADOS ARRIBA, así el
-- panel no tiene que reordenar nada.
--
-- OJO (aprendido a la mala en 20261093): se REEMPLAZA la misma firma
-- `vl_wa_chats_listar()` — no se agrega otra. Dos funciones con los mismos
-- parámetros (aunque tengan DEFAULT) hacen que PostgREST no sepa elegir y
-- devuelva PGRST203.

ALTER TABLE public.vl_wa_chats ADD COLUMN IF NOT EXISTS silenciado boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.vl_wa_chats.silenciado IS 'No suena ni avisa en el navegador; igual cuenta en el contador de pendientes.';
ALTER TABLE public.vl_wa_chats ADD COLUMN IF NOT EXISTS archivado boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.vl_wa_chats.archivado IS 'Sale de la lista de conversaciones (se ve con "Ver archivados").';
ALTER TABLE public.vl_wa_chats ADD COLUMN IF NOT EXISTS fijado boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.vl_wa_chats.fijado IS 'Queda arriba de la lista, como en WhatsApp.';

CREATE OR REPLACE FUNCTION public.vl_wa_chat_preferencia(p_chat_id uuid, p_campo text, p_valor boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_campo  text := lower(btrim(COALESCE(p_campo, '')));
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;
    IF v_campo NOT IN ('silenciado', 'archivado', 'fijado') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Preferencia no soportada');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.vl_wa_chats WHERE id = p_chat_id AND tenant_id = v_tenant
    ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Conversación no encontrada');
    END IF;
    IF v_campo = 'silenciado' THEN
        UPDATE public.vl_wa_chats SET silenciado = COALESCE(p_valor, false) WHERE id = p_chat_id;
    ELSIF v_campo = 'archivado' THEN
        UPDATE public.vl_wa_chats SET archivado = COALESCE(p_valor, false) WHERE id = p_chat_id;
    ELSE
        UPDATE public.vl_wa_chats SET fijado = COALESCE(p_valor, false) WHERE id = p_chat_id;
    END IF;
    RETURN jsonb_build_object('ok', true, 'campo', v_campo, 'valor', COALESCE(p_valor, false));
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_wa_chat_preferencia(uuid, text, boolean) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_chat_preferencia(uuid, text, boolean) TO authenticated, service_role;

-- ── La lista, con las 3 preferencias y los fijados arriba ──
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
                     'cliente_id', c.cliente_id,
                     'tiktok_user', COALESCE(cl.tiktok_user, ''),
                     'nombre_real', COALESCE(cl.nombre_real, ''),
                     'categoria', COALESCE(cl.categoria, 'nuevo'),
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
                            GREATEST(0, CURRENT_DATE - COALESCE((
                                SELECT max(m2.creado_en) FROM public.vl_wa_mensajes m2
                                WHERE m2.chat_id = c.id AND m2.direction = 'in'
                            ), c.creado_en)::date) AS dias
                     FROM public.vl_procesos pr
                     WHERE pr.cliente_id = c.cliente_id AND pr.cerrado_en IS NULL
                     ORDER BY pr.creado_en DESC
                     LIMIT 1
                 ) prl ON true
                 WHERE c.tenant_id = v_tenant
             ) sub
         ), '[]'::jsonb)
     );
 END;
 $function$;
