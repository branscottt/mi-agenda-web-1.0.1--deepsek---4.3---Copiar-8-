-- ============================================================
-- 20261003_finalizar_cita_venta.sql
-- Confirmar la venta al hacer check (✓) en Citas Programadas y
-- no perder la información al hacer check o X (No Asistió).
--
-- Contexto: los botones ✓/X de Citas Programadas (finalizarCita /
-- noAsistioCita en script.js) borraban la cita y dependían del
-- trigger trg_archivar_venta, que SOLO archivaba citas con
-- fecha < CURRENT_DATE. Las citas de HOY (el caso normal: el
-- cliente vino hoy) se borraban SIN archivar → la venta se
-- perdía y el cliente podía desaparecer de Mis Clientes.
--
-- Solución:
--   1. ventas.resultado: 'completada' (default) | 'no_asistio'.
--   2. RPC finalizar_cita(p_cita_id, p_resultado): archiva la
--      venta SIEMPRE (cualquier fecha, fecha_venta=now()) y
--      borra la cita, en una transacción. El ✓ confirma la
--      venta hecha; el X conserva el registro (no cuenta como
--      ingreso: VentasManager.getAll lo excluye con
--      resultado <> 'no_asistio').
--   3. Trigger: guard de idempotencia — si el RPC ya archivó la
--      cita (existe fila en ventas), no la archiva de nuevo.
--
-- Autorización: SECURITY DEFINER + get_user_tenant_id() +
-- is_admin() (mismo patrón que 20260929/20261002).
-- Sin bloques DO $$. Idempotente.
-- ============================================================

-- ============================================================
-- PASO 1: columna resultado en ventas
-- ============================================================
ALTER TABLE public.ventas
    ADD COLUMN IF NOT EXISTS resultado text NOT NULL DEFAULT 'completada';

-- ============================================================
-- PASO 2: trigger con guard de idempotencia
-- (una cita se archiva una sola vez; si el RPC ya la archivó
-- con su resultado, el borrado posterior no la duplica)
-- ============================================================
CREATE OR REPLACE FUNCTION public.archivar_venta_al_borrar_cita()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
    IF OLD.fecha < CURRENT_DATE
       AND NOT EXISTS (SELECT 1 FROM public.ventas WHERE cita_id = OLD.id) THEN
        INSERT INTO public.ventas (tenant_id, cita_id, servicio_id, precio, contacto, fecha, hora, fecha_venta)
        VALUES (OLD.tenant_id, OLD.id, OLD.servicio_id, OLD.precio, OLD.contacto, OLD.fecha, OLD.hora, OLD.created_at);
    END IF;
    RETURN OLD;
END;
$$;

ALTER FUNCTION public.archivar_venta_al_borrar_cita() OWNER TO postgres;

-- ============================================================
-- PASO 3: RPC finalizar_cita
-- El admin confirma el resultado de la cita (asistió / no
-- asistió). Archiva la venta en `ventas` SIEMPRE (cualquier
-- fecha) y borra la cita de `citas` en la misma transacción.
-- ============================================================
CREATE OR REPLACE FUNCTION public.finalizar_cita(
    p_cita_id text,
    p_resultado text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_actual uuid;
    v_cita public.citas%ROWTYPE;
    v_venta_id uuid;
BEGIN
    SELECT public.get_user_tenant_id() INTO v_tenant_actual;
    IF v_tenant_actual IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio');
    END IF;

    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador puede finalizar citas');
    END IF;

    IF p_resultado NOT IN ('completada', 'no_asistio') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Resultado inválido');
    END IF;

    SELECT * INTO v_cita
    FROM public.citas
    WHERE id = p_cita_id
      AND tenant_id = v_tenant_actual;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Cita no encontrada');
    END IF;

    -- Confirma la venta: archiva SIEMPRE (cualquier fecha), con el
    -- resultado indicado. fecha_venta = momento de la confirmación.
    INSERT INTO public.ventas (tenant_id, cita_id, servicio_id, precio, contacto, fecha, hora, fecha_venta, resultado)
    VALUES (v_cita.tenant_id, v_cita.id, v_cita.servicio_id, v_cita.precio, v_cita.contacto, v_cita.fecha, v_cita.hora, now(), p_resultado)
    RETURNING id INTO v_venta_id;

    -- Borra la cita; el trigger no la re-archiva (guard del PASO 2).
    DELETE FROM public.citas WHERE id = p_cita_id;

    RETURN jsonb_build_object('ok', true, 'venta_id', v_venta_id, 'resultado', p_resultado);
END;
$$;

-- Solo el admin autenticado puede ejecutarlo (nunca anon).
REVOKE EXECUTE ON FUNCTION public.finalizar_cita(text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.finalizar_cita(text, text) TO authenticated;
