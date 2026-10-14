-- ════════════════════════════════════════════════════════════════════════════
-- [VENTAS LIVE] (20261088) SIN "LO MÁS PROBABLE": nada de adivinar la cita
--
-- Pedido del dueño, textual: "la idea es que sepan qué marcó la otra persona, no
-- deberían ver lo más probable sino lo que realmente citaron… quita el probable".
--
-- La 20261087 devolvía en cada candidata un flag `probable` (la última foto antes
-- de la respuesta) y el panel lo mostraba como "la más probable". Eso es una
-- SUPOSICIÓN, no lo que el cliente marcó. Se elimina: las candidatas vuelven a ser
-- simplemente los mensajes anteriores de la conversación (para cuando el dueño
-- tenga que elegir a mano un mensaje viejo), ordenadas de la más nueva a la más
-- antigua, sin ninguna marca de probabilidad.
--
-- OJO: la cita EXACTA sigue igual y es la vía normal — cuando WhatsApp nos manda la
-- referencia (`context.id`) y el mensaje citado está registrado con su wamid, el
-- panel muestra ESO y punto. Esto solo afecta la lista de apoyo para mensajes
-- anteriores a que guardáramos los wamid.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.vl_wa_cita_candidatas(
    p_mensaje_id uuid,
    p_limite     int DEFAULT 8)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_tenant uuid;
    v_base   public.vl_wa_mensajes%ROWTYPE;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    SELECT * INTO v_base
      FROM public.vl_wa_mensajes
     WHERE id = p_mensaje_id AND tenant_id = v_tenant;
    IF v_base.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Mensaje no encontrado');
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'mensaje_id', v_base.id,
        'candidatas', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', x.id,
                'direction', x.direction,
                'origen', x.origen,
                'tipo', x.tipo,
                'body', x.body,
                'media_path', x.media_path,
                'creado_en', x.creado_en
            ) ORDER BY x.creado_en DESC, x.id DESC)
            FROM (
                SELECT m.id, m.direction, m.origen, m.tipo, m.body, m.media_path, m.creado_en
                  FROM public.vl_wa_mensajes m
                 WHERE m.chat_id = v_base.chat_id
                   AND m.id <> v_base.id
                   -- ESTRICTO: la respuesta del bot va en la MISMA transacción y
                   -- comparte `creado_en` con el entrante (con <= se colaba).
                   AND m.creado_en < v_base.creado_en
                 ORDER BY m.creado_en DESC, m.id DESC
                 LIMIT GREATEST(1, LEAST(COALESCE(p_limite, 8), 20))
            ) x
        ), '[]'::jsonb)
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.vl_wa_cita_candidatas(uuid, int) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_wa_cita_candidatas(uuid, int) TO authenticated;

NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE] citas: sin marca de probabilidad (20261088) OK' AS status;
