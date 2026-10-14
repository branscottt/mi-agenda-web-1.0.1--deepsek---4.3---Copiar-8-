-- ════════════════════════════════════════════════════════════════════════════
-- [VENTAS LIVE] (20261092) ELIMINAR UN CLIENTE (de verdad)
--
-- Pedido del dueño: *"en clientes debería poder eliminar clientes… o porque
-- nunca compraron y los bloqueamos, o simplemente soltaron prenda y no los
-- quiero de clientes"*.
--
-- Hasta ahora lo único destructivo era vl_cliente_bloquear_borrar (migración
-- 20261047), que NO borra la ficha: la deja con categoria='bloqueado', los datos
-- vacíos y los chats ocultos — y esa ficha "eliminada" seguía apareciendo en la
-- lista de "¿Quién es?" (arreglado en 20261091). El dueño quiere que la ficha
-- DESAPAREZCA.
--
--   * vl_cliente_eliminar(cliente, solo_ver):
--       - solo_ver = true  → NO borra nada: devuelve qué se borraría (ventas,
--         prendas, plata, conversaciones, avisos) y si SE PUEDE o no, para que
--         el panel lo muestre ANTES de confirmar (nada de sorpresas).
--       - solo_ver = false → borra.
--
-- DOS CANDADOS que protegen la plata y las ventas en curso (mismos criterios que
-- ya usa el proyecto para no tocar la caja):
--   1. VENTA ACTIVA: si tiene alguna prenda adjudicada/pagada/entregada en un
--      proceso ABIERTO, NO se borra → primero se libera la prenda o se cierra el
--      pedido (así el dueño decide qué pasa con esa venta, no el borrado).
--   2. PLATA COBRADA: si hay pagos registrados (vl_pagos) o algo abonado, NO se
--      borra → borrarla cambiaría lo que muestran Finanzas y "recibido". Es la
--      misma regla de vl_eliminar_compra.
-- Los dos casos que el dueño nombró (nunca compraron / soltaron prenda) pasan
-- los dos candados: no tienen venta activa ni plata cobrada.
--
-- Qué borra: sus procesos (prendas, pagos y envíos caen en cascada) y la ficha.
-- Qué NO borra: las CONVERSACIONES de WhatsApp quedan (el FK las deja sin
-- cliente) con sus avisos cerrados — son el registro de lo que se habló y, si la
-- persona vuelve a escribir, el chat se reusa en vez de perderse.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.vl_cliente_eliminar(
    p_cliente_id uuid,
    p_solo_ver   boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant       uuid;
    v_cli          public.vl_clientes%ROWTYPE;
    v_procesos     int := 0;
    v_prendas      int := 0;
    v_cobrado      numeric := 0;
    v_pagos        int := 0;
    v_chats        int := 0;
    v_avisos       int := 0;
    v_activas      int := 0;
    v_por_cobrar   numeric := 0;
    v_puede        boolean := true;
    v_motivo       text := '';
    v_avisos_cerr  int := 0;
    v_pend_pago    numeric := 0;
    v_pend_n       int := 0;
    v_pagadas_n    int := 0;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    SELECT * INTO v_cli
      FROM public.vl_clientes
     WHERE id = p_cliente_id AND tenant_id = v_tenant;
    IF v_cli.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Cliente no encontrado');
    END IF;

    -- ── Qué hay colgando de esta ficha ──────────────────────────────────────
    SELECT count(*) INTO v_procesos
      FROM public.vl_procesos p WHERE p.cliente_id = v_cli.id;

    SELECT count(*),
           COALESCE(SUM(i.abonado), 0),
           COALESCE(SUM(i.precio - i.abonado) FILTER (
               WHERE i.estado IN ('adjudicada', 'pagada', 'entregada')), 0)
      INTO v_prendas, v_cobrado, v_por_cobrar
      FROM public.vl_items i
      JOIN public.vl_procesos p ON p.id = i.proceso_id
     WHERE p.cliente_id = v_cli.id;

    SELECT count(*) INTO v_pagos
      FROM public.vl_pagos pg
      JOIN public.vl_procesos p ON p.id = pg.proceso_id
     WHERE p.cliente_id = v_cli.id;

    SELECT count(*) INTO v_chats
      FROM public.vl_wa_chats c WHERE c.cliente_id = v_cli.id;

    SELECT count(*) INTO v_avisos
      FROM public.vl_wa_avisos a
      JOIN public.vl_wa_chats c ON c.id = a.chat_id
     WHERE c.cliente_id = v_cli.id AND a.resuelto_en IS NULL;

    -- Venta en curso: prenda adjudicada/pagada/entregada en proceso ABIERTO.
    SELECT count(*) INTO v_activas
      FROM public.vl_items i
      JOIN public.vl_procesos p ON p.id = i.proceso_id
     WHERE p.cliente_id = v_cli.id
       AND p.cerrado_en IS NULL
       AND i.estado IN ('adjudicada', 'pagada', 'entregada');

    -- Para explicar BIEN qué queda pendiente (a quién le falta pagar y qué ya pagó).
    SELECT COALESCE(SUM(i.precio - i.abonado), 0), count(*)
      INTO v_pend_pago, v_pend_n
      FROM public.vl_items i
      JOIN public.vl_procesos p ON p.id = i.proceso_id
     WHERE p.cliente_id = v_cli.id AND p.cerrado_en IS NULL AND i.estado = 'adjudicada';

    SELECT count(*) INTO v_pagadas_n
      FROM public.vl_items i
      JOIN public.vl_procesos p ON p.id = i.proceso_id
     WHERE p.cliente_id = v_cli.id AND p.cerrado_en IS NULL
       AND i.estado IN ('pagada', 'entregada');

    -- ── Candados ────────────────────────────────────────────────────────────
    IF v_activas > 0 THEN
        v_puede := false;
        v_motivo := 'Tiene una venta en curso: '
                 || CASE WHEN v_pend_n > 0
                         THEN v_pend_n || CASE WHEN v_pend_n = 1 THEN ' prenda' ELSE ' prendas' END
                              || ' con $' || to_char(v_pend_pago, 'FM999G999G999') || ' por cobrar'
                              || CASE WHEN v_pagadas_n > 0 THEN ' y ' ELSE '' END
                         ELSE '' END
                 || CASE WHEN v_pagadas_n > 0
                         THEN v_pagadas_n || CASE WHEN v_pagadas_n = 1 THEN ' prenda' ELSE ' prendas' END
                              || ' ya pagada(s), pendiente(s) de entrega'
                         ELSE '' END
                 || '. Libérala o cierra el pedido primero.'
                 || CASE WHEN v_cobrado > 0
                         THEN ' (Ojo: ya tiene $' || to_char(v_cobrado, 'FM999G999G999')
                              || ' cobrados que no se pueden perder.)'
                         ELSE '' END;
    ELSIF v_pagos > 0 OR v_cobrado > 0 THEN
        v_puede := false;
        v_motivo := 'Tiene $' || to_char(v_cobrado, 'FM999G999G999')
                 || ' cobrados (caja real): si se borra, ese dinero desaparece de Finanzas. '
                 || 'Elimina la compra desde su proceso (Eliminar compra) o déjala bloqueada.';
    END IF;

    IF p_solo_ver THEN
        RETURN jsonb_build_object(
            'ok', true,
            'solo_ver', true,
            'cliente_id', v_cli.id,
            'tiktok_user', COALESCE(v_cli.tiktok_user, ''),
            'nombre_real', COALESCE(v_cli.nombre_real, ''),
            'categoria', v_cli.categoria,
            'puede', v_puede,
            'motivo', v_motivo,
            'procesos', v_procesos,
            'prendas', v_prendas,
            'prendas_activas', v_activas,
            'cobrado', v_cobrado,
            'pagos', v_pagos,
            'por_cobrar', v_por_cobrar,
            'chats', v_chats,
            'avisos', v_avisos
        );
    END IF;

    IF NOT v_puede THEN
        RETURN jsonb_build_object('ok', false, 'error', v_motivo, 'puede', false);
    END IF;

    -- ── Borrar ──────────────────────────────────────────────────────────────
    -- Los avisos abiertos de sus conversaciones quedan cerrados (si no, el panel
    -- seguiría pidiendo "contesta tú" por alguien que ya no existe).
    UPDATE public.vl_wa_avisos a
       SET resuelto_en = now()
     WHERE a.resuelto_en IS NULL
       AND a.chat_id IN (SELECT c.id FROM public.vl_wa_chats c WHERE c.cliente_id = v_cli.id);
    GET DIAGNOSTICS v_avisos_cerr = ROW_COUNT;

    -- Sus ventas: items, pagos y envíos caen en CASCADE con el proceso.
    DELETE FROM public.vl_procesos WHERE cliente_id = v_cli.id;

    -- La ficha. Los chats NO se borran: el FK los deja sin cliente.
    DELETE FROM public.vl_clientes WHERE id = v_cli.id;

    RETURN jsonb_build_object(
        'ok', true,
        'borrado', true,
        'tiktok_user', COALESCE(v_cli.tiktok_user, ''),
        'procesos', v_procesos,
        'prendas', v_prendas,
        'chats', v_chats,
        'avisos_cerrados', v_avisos_cerr
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_cliente_eliminar(uuid, boolean) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_cliente_eliminar(uuid, boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] eliminar cliente de verdad, con candados de venta activa y plata (20261092) OK' AS status;
