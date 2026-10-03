-- ============================================================================
-- [VENTAS LIVE] v10 — (a) alerta por NUEVO vs CONOCIDO (¿juego o esperar?) y
-- (b) ELIMINAR COMPRA (borra el pedido como si nunca hubiera existido). (20261063)
--
-- Pedido del dueño:
--   * "si separa por nuevos y conocidos; si uno nunca nos escribió seguramente es
--     juego; para conocidos solo avisa después de 3 días (más flexible)".
--   * "si juegan lo ideal es liberar… que borren esa compra como si nunca existió
--     o nos pongan botón de eliminar compra y desaparezca".
--
--   (a) vl_procesos_diagrama(): cada proceso trae `nunca_escribio` y la alerta
--       distingue: 'juego' (nuevo que NUNCA escribió, >=1 día) vs 'atencion'
--       (cliente conocido/de siempre, sin contacto >=3 días). El detalle lo dice.
--   (b) vl_eliminar_compra(proceso): DESTRUCTIVO — borra items, envíos y el
--       proceso (la compra desaparece de Procesos/Envíos/Finanzas). La ficha del
--       cliente NO se toca. Bloqueado si la compra ya tiene pagos registrados.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.vl_procesos_diagrama()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_res jsonb;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    WITH base AS (
        SELECT
            pr.id AS proceso_id,
            public.vl_proceso_puntos(pr.id) AS info,
            GREATEST(
                pr.creado_en,
                COALESCE((
                    SELECT max(m.creado_en)
                    FROM public.vl_wa_mensajes m
                    JOIN public.vl_wa_chats ch ON ch.id = m.chat_id
                    WHERE ch.cliente_id = c.id AND m.direction = 'in'
                ), pr.creado_en)
            ) AS ultimo_contacto,
            NOT EXISTS (
                SELECT 1 FROM public.vl_wa_mensajes m
                JOIN public.vl_wa_chats ch ON ch.id = m.chat_id
                WHERE ch.cliente_id = c.id AND m.direction = 'in'
            ) AS nunca_escribio
        FROM public.vl_procesos pr
        JOIN public.vl_clientes c ON c.id = pr.cliente_id
        WHERE pr.tenant_id = v_tenant AND pr.cerrado_en IS NULL
    ),
    calc AS (
        SELECT b.*, (CURRENT_DATE - b.ultimo_contacto::date) AS dias_sin_contacto
        FROM base b
    )
    SELECT jsonb_build_object(
        'ok', true,
        'total', (SELECT count(*) FROM calc),
        'procesos', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'proceso_id', x.proceso_id,
                'estado', x.info->>'estado',
                'saldo', (x.info->>'saldo')::numeric,
                'total', (x.info->>'total')::numeric,
                'prendas', (x.info->>'prendas')::int,
                'dias_sin_contacto', x.dias_sin_contacto,
                'alerta', CASE
                    WHEN (x.info->>'saldo')::numeric > 0 AND cl.categoria = 'nuevo'
                         AND x.nunca_escribio AND x.dias_sin_contacto >= 1 THEN jsonb_build_object(
                        'tipo', 'juego',
                        'dias', x.dias_sin_contacto,
                        'detalle', 'Compró y NUNCA te escribió (posible juego): si no contesta, '
                                   || 'libera la prenda y bloquéalo. Debe '
                                   || public.vl_wa_fmt_monto((x.info->>'saldo')::numeric)
                    )
                    WHEN (x.info->>'saldo')::numeric > 0 AND x.dias_sin_contacto >= 3 THEN jsonb_build_object(
                        'tipo', CASE WHEN cl.categoria = 'nuevo' THEN 'juego' ELSE 'atencion' END,
                        'dias', x.dias_sin_contacto,
                        'detalle', CASE WHEN cl.categoria = 'nuevo'
                                        THEN 'Cliente nuevo sin contacto hace ' || x.dias_sin_contacto
                                             || ' día(s) y debe '
                                             || public.vl_wa_fmt_monto((x.info->>'saldo')::numeric)
                                             || '. Posible juego: libera si no contesta.'
                                        ELSE 'Conocido sin contacto hace ' || x.dias_sin_contacto
                                             || ' día(s) y debe '
                                             || public.vl_wa_fmt_monto((x.info->>'saldo')::numeric)
                                             || '. Puedes esperarlo o escribirle.' END
                    )
                    ELSE NULL
                END,
                'cliente', jsonb_build_object(
                    'cliente_id', (x.info->>'cliente_id')::uuid,
                    'tiktok_user', cl.tiktok_user,
                    'nombre_real', cl.nombre_real,
                    'whatsapp', cl.whatsapp,
                    'categoria', cl.categoria
                ),
                'puntos', x.info->'puntos',
                'envio', x.info->'envio'
            ) ORDER BY
                ((x.info->>'saldo')::numeric > 0 AND x.nunca_escribio) DESC,
                ((x.info->>'saldo')::numeric > 0 AND x.dias_sin_contacto >= 3) DESC,
                x.dias_sin_contacto DESC,
                (x.info->>'saldo')::numeric DESC,
                cl.tiktok_user ASC)
            FROM calc x
            JOIN public.vl_clientes cl ON cl.id = (x.info->>'cliente_id')::uuid
        ), '[]'::jsonb)
    ) INTO v_res;

    RETURN v_res;
END;
$function$;

-- ── Eliminar compra (DESTRUCTIVO) ───────────────────────────────────────────
-- Borra el pedido completo (items + envíos + proceso) para que desaparezca como
-- si nunca hubiera existido. NO borra la ficha del cliente (el bloqueo en TikTok
-- lo hace el negocio por su lado). Se niega si la compra ya tiene pagos
-- registrados (no se toca la caja real de Finanzas).
CREATE OR REPLACE FUNCTION public.vl_eliminar_compra(p_proceso_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_proc public.vl_procesos%ROWTYPE;
    v_items int := 0;
    v_envios int := 0;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    SELECT * INTO v_proc
    FROM public.vl_procesos
    WHERE id = p_proceso_id AND tenant_id = v_tenant;
    IF v_proc.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Compra no encontrada');
    END IF;

    IF EXISTS (SELECT 1 FROM public.vl_pagos pg WHERE pg.proceso_id = v_proc.id) THEN
        RETURN jsonb_build_object('ok', false,
            'error', 'Esta compra tiene pagos registrados: no se puede eliminar (afectaría la caja). Usá Liberar prenda.');
    END IF;

    DELETE FROM public.vl_items  WHERE proceso_id = v_proc.id;
    GET DIAGNOSTICS v_items = ROW_COUNT;
    DELETE FROM public.vl_envios WHERE proceso_id = v_proc.id;
    GET DIAGNOSTICS v_envios = ROW_COUNT;
    DELETE FROM public.vl_procesos WHERE id = v_proc.id;

    RETURN jsonb_build_object('ok', true, 'items_borrados', v_items, 'envios_borrados', v_envios);
END;
$function$;

-- ── Permisos + recarga de esquema ───────────────────────────────────────────
REVOKE ALL ON FUNCTION public.vl_eliminar_compra(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_eliminar_compra(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] v10: alerta nuevo/conocido + eliminar compra OK' AS status;
