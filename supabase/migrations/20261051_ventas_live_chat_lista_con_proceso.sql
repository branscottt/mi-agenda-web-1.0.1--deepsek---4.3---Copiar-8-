-- ============================================================
-- MIGRACIÓN 20261051: Ventas Live — la LISTA de chats muestra el proceso
-- Fecha: 2026-10-12
--
-- PEDIDO DEL DUEÑO: "quiero que en la lista de conversaciones, donde salen las
-- marcas de bot / esperando tiktok / no se entendió, salga también el proceso en
-- el que está, con todos los puntos del diagrama, para solo mirar los chats y
-- saber el contexto: si el bot contestó o si debo contestar yo".
--
-- Para eso la lista necesita saber QUIÉN habló último (el cliente, el bot o una
-- persona). vl_wa_mensajes ya tiene direction ('in'/'out') y origen
-- ('bot'/'humano'): se exponen el del ÚLTIMO mensaje de cada chat.
--
-- Piezas: vl_wa_chats_listar() v5 -> agrega 'ultimo_dir' y 'ultimo_origen'.
-- Idempotente.
-- ============================================================

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
            SELECT jsonb_agg(fila ORDER BY (fila->>'ultimo_en') DESC)
            FROM (
                SELECT jsonb_build_object(
                    'id', c.id,
                    'wa_id', c.wa_id,
                    'estado', c.estado,
                    'modo', c.modo,
                    'oculto', c.oculto,
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

REVOKE ALL ON FUNCTION public.vl_wa_chats_listar() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_chats_listar() TO authenticated;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] lista de chats con proceso y quién habló último OK' AS status;
