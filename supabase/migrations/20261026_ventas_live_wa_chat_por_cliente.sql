-- ============================================================
-- MIGRACIÓN 20261026: Ventas Live — chat del cliente por cliente_id
-- Fecha: 2026-10-11
--
-- OBJETIVO: en MODO LIVE, al escribir un @usuario conocido, mostrar su
-- conversación de WhatsApp al lado para ir cargando el pedido viendo el
-- chat. La búsqueda del chat se hace por cliente (el número de WhatsApp
-- queda asociado al cliente cuando éste escribe por primera vez).
--
-- Devuelve el chat_id (o null si el cliente todavía no escribió). El hilo
-- se lee con vl_wa_chat_hilo, que ya marca como leído.
-- ============================================================

CREATE OR REPLACE FUNCTION public.vl_wa_chat_por_cliente(p_cliente_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_chat public.vl_wa_chats%ROWTYPE;
    v_cli public.vl_clientes%ROWTYPE;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    IF p_cliente_id IS NULL THEN
        RETURN jsonb_build_object('ok', true, 'chat_id', NULL);
    END IF;

    SELECT * INTO v_cli
    FROM public.vl_clientes
    WHERE id = p_cliente_id AND tenant_id = v_tenant;

    IF v_cli.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Cliente no encontrado');
    END IF;

    -- El chat se identifica por el número de WhatsApp del cliente. Si
    -- todavía no hay chat asociado por cliente_id, se busca por ese número
    -- (el bot lo asocia al identificarse, pero puede llegar antes).
    SELECT * INTO v_chat
    FROM public.vl_wa_chats
    WHERE tenant_id = v_tenant AND cliente_id = v_cli.id
    ORDER BY ultimo_en DESC
    LIMIT 1;

    IF v_chat.id IS NULL AND btrim(COALESCE(v_cli.whatsapp, '')) <> '' THEN
        SELECT * INTO v_chat
        FROM public.vl_wa_chats
        WHERE tenant_id = v_tenant AND wa_id = v_cli.whatsapp
        ORDER BY ultimo_en DESC
        LIMIT 1;
    END IF;

    IF v_chat.id IS NULL THEN
        RETURN jsonb_build_object('ok', true, 'chat_id', NULL, 'whatsapp', COALESCE(v_cli.whatsapp, ''));
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'chat_id', v_chat.id,
        'wa_id', v_chat.wa_id,
        'modo', v_chat.modo,
        'estado', v_chat.estado
    );
END;
$$;

REVOKE ALL ON FUNCTION public.vl_wa_chat_por_cliente(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_chat_por_cliente(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] Chat por cliente (MODO LIVE) OK' AS status;
