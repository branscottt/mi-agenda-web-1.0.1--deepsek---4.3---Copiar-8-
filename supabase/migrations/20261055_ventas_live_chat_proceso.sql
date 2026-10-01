-- ============================================================================
-- MIGRACIÓN 20261055: Ventas Live — proceso de una conversación (para el chat)
-- Fecha: 2026-10-01
--
-- Por qué: el dueño pidió poder cerrar la entrega "en el mismo lado del chat".
-- Los modales de proceso ya existen (Confirmar pago / Decidir entrega / ENVÍO
-- CREADO / Marcar entregado), pero el cajón de conversaciones no tenía el
-- `proceso_id`: `vl_wa_chats_listar` devuelve los datos del proceso con
-- `vl_proceso_puntos()`, que NO incluye el id.
--
-- En vez de reescribir `vl_wa_chats_listar` (función larga y ya probada) se agrega
-- esta RPC chica: dado un chat devuelve su proceso abierto con el id incluido.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.vl_wa_chat_proceso(p_chat_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_chat public.vl_wa_chats%ROWTYPE;
    v_proc_id uuid;
    v_user text;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    SELECT * INTO v_chat
    FROM public.vl_wa_chats
    WHERE id = p_chat_id AND tenant_id = v_tenant;

    IF v_chat.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Conversación no encontrada');
    END IF;

    IF v_chat.cliente_id IS NULL THEN
        RETURN jsonb_build_object('ok', true, 'proceso', NULL, 'tiktok_user', '');
    END IF;

    SELECT c.tiktok_user INTO v_user
    FROM public.vl_clientes c WHERE c.id = v_chat.cliente_id;

    SELECT pr.id INTO v_proc_id
    FROM public.vl_procesos pr
    WHERE pr.cliente_id = v_chat.cliente_id AND pr.cerrado_en IS NULL
    ORDER BY pr.creado_en DESC
    LIMIT 1;

    IF v_proc_id IS NULL THEN
        RETURN jsonb_build_object('ok', true, 'proceso', NULL, 'tiktok_user', COALESCE(v_user, ''));
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'proceso', public.vl_proceso_puntos(v_proc_id)
                   || jsonb_build_object('proceso_id', v_proc_id),
        'tiktok_user', COALESCE(v_user, '')
    );
END;
$function$;

-- ── Permisos ────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.vl_wa_chat_proceso(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_chat_proceso(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] proceso de la conversación OK' AS status;
