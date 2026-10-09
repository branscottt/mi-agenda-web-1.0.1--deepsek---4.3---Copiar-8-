-- ============================================================================
-- MIGRACIÓN 20261076: Ventas Live — registrar venta en UNA SOLA llamada
-- Fecha: 2026-10-11
--
-- PROBLEMA (velocidad durante el LIVE): guardar una venta hacía DOS viajes al
-- servidor en serie — primero vl_buscar_clientes (para el aviso de "posible
-- duplicado") y después vl_agregar_item. Con ~70-120 ms por viaje, cada prenda
-- tardaba el doble de lo necesario.
--
-- SOLUCIÓN: el aviso de "parecido" se mueve DENTRO de vl_agregar_item. Si el @
-- escrito NO coincide exacto pero EMPIEZA igual que un cliente existente
-- ("anubis" vs "@anubisss"), la función devuelve
--   {ok:true, requiere_confirmacion:true, parecidos:[…]}  SIN crear nada,
-- y el cliente decide:
--   * usar la ficha existente  -> no se crea (mismo comportamiento de antes);
--   * crear la nueva           -> vuelve a llamar con p_confirmar_parecido=false
--                                 y ahí sí se crea (1 viaje, caso raro).
-- Caso normal (cliente exacto o nombre nuevo): 1 SOLO viaje → ~mitad del tiempo.
--
-- Compatibilidad: p_confirmar_parecido tiene DEFAULT true, así que una llamada
-- de 3 argumentos sigue funcionando. Se reemplaza la firma anterior de 3 args
-- (DROP + CREATE) para no dejar dos sobrecargas ambiguas; se re-otorgan los
-- permisos a la firma NUEVA. No toca nada del proyecto 'reservas'.
-- ============================================================================

DROP FUNCTION IF EXISTS public.vl_agregar_item(text, numeric, text);

CREATE OR REPLACE FUNCTION public.vl_agregar_item(
    p_tiktok_user text,
    p_precio numeric,
    p_descripcion text DEFAULT '',
    p_confirmar_parecido boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_user text;
    v_cliente_id uuid;
    v_categoria text;
    v_es_nuevo boolean := false;
    v_live_id uuid;
    v_live_etiqueta text;
    v_proceso_id uuid;
    v_proceso_estado text;
    v_item_id uuid;
    v_reservas int := 0;
    v_concretadas int := 0;
    v_alerta jsonb;
    v_pat text;
    v_parecidos jsonb;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador puede registrar ventas');
    END IF;

    v_user := public.vl_normalizar_tiktok(p_tiktok_user);
    IF v_user = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Usuario de TikTok inválido');
    END IF;
    IF p_precio IS NULL OR p_precio <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Precio inválido');
    END IF;

    -- 0) Aviso de POSIBLE DUPLICADO (antes era una llamada aparte del cliente).
    --    Solo si NO hay coincidencia EXACTA y lo escrito EMPIEZA igual que un
    --    cliente que ya existe. No crea nada: el cliente decide y reintenta.
    IF p_confirmar_parecido THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.vl_clientes
            WHERE tenant_id = v_tenant AND tiktok_user = v_user
        ) THEN
            -- LIKE literal: el @ puede traer _ o % (válidos en TikTok), se escapan.
            v_pat := replace(replace(replace(v_user, '\', '\\'), '%', '\%'), '_', '\_') || '%';
            SELECT jsonb_agg(jsonb_build_object('cliente_id', x.id, 'tiktok_user', x.tiktok_user)
                             ORDER BY x.tiktok_user)
              INTO v_parecidos
            FROM (
                SELECT id, tiktok_user
                FROM public.vl_clientes
                WHERE tenant_id = v_tenant
                  AND tiktok_user LIKE v_pat ESCAPE '\'
                  AND tiktok_user <> v_user
                ORDER BY tiktok_user
                LIMIT 3
            ) x;

            IF v_parecidos IS NOT NULL THEN
                RETURN jsonb_build_object(
                    'ok', true,
                    'requiere_confirmacion', true,
                    'tiktok_user', v_user,
                    'parecidos', v_parecidos
                );
            END IF;
        END IF;
    END IF;

    -- 1) Cliente: buscar o crear
    SELECT id, categoria INTO v_cliente_id, v_categoria
    FROM public.vl_clientes
    WHERE tenant_id = v_tenant AND tiktok_user = v_user;

    IF v_cliente_id IS NULL THEN
        INSERT INTO public.vl_clientes (tenant_id, tiktok_user)
        VALUES (v_tenant, v_user)
        RETURNING id INTO v_cliente_id;
        v_categoria := 'nuevo';
        v_es_nuevo := true;
    END IF;

    -- 2) LIVE del día: usa el abierto hoy; si el abierto es de un día
    -- anterior lo cierra y abre uno nuevo automáticamente.
    SELECT id, etiqueta INTO v_live_id, v_live_etiqueta
    FROM public.vl_lives
    WHERE tenant_id = v_tenant AND cerrado_en IS NULL
    ORDER BY abierto_en DESC
    LIMIT 1;

    IF v_live_id IS NOT NULL THEN
        IF (SELECT abierto_en::date FROM public.vl_lives WHERE id = v_live_id) < CURRENT_DATE THEN
            UPDATE public.vl_lives SET cerrado_en = now() WHERE id = v_live_id;
            v_live_id := NULL;
        END IF;
    END IF;

    IF v_live_id IS NULL THEN
        INSERT INTO public.vl_lives (tenant_id, etiqueta)
        VALUES (v_tenant, 'LIVE ' || to_char(CURRENT_DATE, 'YYYY-MM-DD'))
        RETURNING id, etiqueta INTO v_live_id, v_live_etiqueta;
    END IF;

    -- 3) Proceso activo: obtener o crear (1 por cliente)
    SELECT id, estado INTO v_proceso_id, v_proceso_estado
    FROM public.vl_procesos
    WHERE cliente_id = v_cliente_id AND cerrado_en IS NULL;

    IF v_proceso_id IS NULL THEN
        INSERT INTO public.vl_procesos (tenant_id, cliente_id)
        VALUES (v_tenant, v_cliente_id)
        ON CONFLICT (cliente_id) WHERE (cerrado_en IS NULL) DO NOTHING;
        SELECT id, estado INTO v_proceso_id, v_proceso_estado
        FROM public.vl_procesos
        WHERE cliente_id = v_cliente_id AND cerrado_en IS NULL;
    END IF;

    -- 4) Prenda
    INSERT INTO public.vl_items (tenant_id, proceso_id, live_id, descripcion, precio)
    VALUES (v_tenant, v_proceso_id, v_live_id, btrim(COALESCE(p_descripcion, '')), p_precio)
    RETURNING id INTO v_item_id;

    -- 5) Alerta de comportamiento (solo informativa)
    IF v_categoria IN ('problematico', 'bloqueado') THEN
        SELECT count(*)::int,
               count(*) FILTER (
                   WHERE EXISTS (
                       SELECT 1 FROM public.vl_pagos pg WHERE pg.proceso_id = pr.id
                   )
               )::int
        INTO v_reservas, v_concretadas
        FROM public.vl_procesos pr
        WHERE pr.cliente_id = v_cliente_id;

        v_alerta := jsonb_build_object(
            'categoria', v_categoria,
            'reservas', v_reservas,
            'concretadas', v_concretadas,
            'no_concretadas', v_reservas - v_concretadas
        );
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'cliente', jsonb_build_object(
            'id', v_cliente_id,
            'tiktok_user', v_user,
            'categoria', v_categoria,
            'es_nuevo', v_es_nuevo
        ),
        'proceso', jsonb_build_object('id', v_proceso_id, 'estado', v_proceso_estado),
        'item', jsonb_build_object('id', v_item_id, 'precio', p_precio),
        'saldo_pendiente', public.vl_saldo_proceso(v_proceso_id),
        'prendas_en_bolsa', (
            SELECT count(*) FROM public.vl_items
            WHERE proceso_id = v_proceso_id AND estado IN ('adjudicada', 'pagada')
        ),
        'live', jsonb_build_object('id', v_live_id, 'etiqueta', v_live_etiqueta),
        'alerta', v_alerta
    );
END;
$$;

REVOKE ALL ON FUNCTION public.vl_agregar_item(text, numeric, text, boolean) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_agregar_item(text, numeric, text, boolean) TO authenticated;
