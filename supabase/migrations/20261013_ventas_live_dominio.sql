-- ============================================================
-- MIGRACIÓN: Ventas Live — dominio (v1)
-- Fecha: 2026-10-13
--
-- OBJETIVO: construir el dominio del producto Ventas Live sobre
-- la base multi-proyecto de 20261012 (tenants.proyecto,
-- get_vl_tenant_id(), plan vl_free). Esta migración NO toca nada
-- del proyecto 'reservas'.
--
-- PRINCIPIOS (alineados a la especificación del producto):
--   * Durante el LIVE solo se ingresa @usuario + $precio; el RPC
--     vl_agregar_item hace el resto (busca/crea cliente, live,
--     proceso, item y saldo) en UNA transacción.
--   * Cuenta corriente: el saldo pendiente SIEMPRE se calcula
--     sobre el PROCESO ACTIVO (1 por cliente, bolsa única), así
--     los pagos históricos jamás se confunden con la deuda actual.
--   * Imputación FIFO por prenda: cada pago abona las prendas
--     'adjudicada' más antiguas (trigger). Resuelve el caso
--     "acumulando + nueva compra" con saldo exacto.
--   * Estados del proceso = los 13 de la especificación §10.
--   * Tablas internas: RLS habilitado, SIN policies y SIN grants
--     a anon/authenticated → solo los RPCs SECURITY DEFINER
--     (guard get_vl_tenant_id + is_admin) las tocan.
--   * Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: Helper de normalización de usuario TikTok
-- (minúsculas, sin @ inicial, sin espacios; usado también como
-- CHECK de la columna para que ningún camino escriba sucio)
-- ============================================================
CREATE OR REPLACE FUNCTION public.vl_normalizar_tiktok(p_tiktok text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
    SELECT regexp_replace(
        regexp_replace(btrim(lower(p_tiktok)), '^@+', '', 'g'),
        '\s+', '', 'g')
$$;

-- ============================================================
-- PASO 2: Tablas del dominio (todas con prefijo vl_)
-- ============================================================

-- 2.1 vl_clientes: perfil del cliente + categoría de confianza
-- (categoría SIEMPRE manual, nunca automática — spec §12)
CREATE TABLE IF NOT EXISTS public.vl_clientes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    tiktok_user text NOT NULL,
    nombre_real text NOT NULL DEFAULT '',
    whatsapp text NOT NULL DEFAULT '',
    ciudad text NOT NULL DEFAULT '',
    comuna text NOT NULL DEFAULT '',
    direccion text NOT NULL DEFAULT '',
    entrega_preferida text CHECK (entrega_preferida IN ('envio', 'presencial')),
    categoria text NOT NULL DEFAULT 'nuevo' CHECK (categoria IN ('nuevo', 'confiable', 'problematico', 'bloqueado')),
    notas text NOT NULL DEFAULT '',
    creado_en timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT vl_clientes_tiktok_normalizado_check
        CHECK (tiktok_user <> '' AND tiktok_user = public.vl_normalizar_tiktok(tiktok_user))
);

ALTER TABLE public.vl_clientes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.vl_clientes FROM anon, authenticated, public;

-- Un usuario TikTok por tenant (dedup del MODO LIVE)
CREATE UNIQUE INDEX IF NOT EXISTS uq_vl_clientes_tenant_tiktok
    ON public.vl_clientes (tenant_id, tiktok_user);
CREATE INDEX IF NOT EXISTS idx_vl_clientes_tenant
    ON public.vl_clientes (tenant_id);

-- 2.2 vl_lives: sesiones de transmisión (ventas agrupadas por LIVE)
CREATE TABLE IF NOT EXISTS public.vl_lives (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    etiqueta text NOT NULL DEFAULT '',
    abierto_en timestamptz NOT NULL DEFAULT now(),
    cerrado_en timestamptz
);

ALTER TABLE public.vl_lives ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.vl_lives FROM anon, authenticated, public;

CREATE INDEX IF NOT EXISTS idx_vl_lives_tenant_abierto
    ON public.vl_lives (tenant_id, cerrado_en);

-- 2.3 vl_procesos: estado actual del cliente (bolsa única).
-- 1 proceso ACTIVO por cliente; al completar/liberar se cierra y
-- una compra futura abre uno nuevo (el historial de procesos es la
-- base de los contadores de confiabilidad).
CREATE TABLE IF NOT EXISTS public.vl_procesos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    cliente_id uuid NOT NULL REFERENCES public.vl_clientes(id) ON DELETE RESTRICT,
    estado text NOT NULL DEFAULT 'esperando_whatsapp'
        CHECK (estado IN (
            'esperando_whatsapp',      -- 🟡 adjudicó en LIVE, sin contacto aún
            'identificando_cliente',   -- 🔵 identificándose por WhatsApp (bot fase 2)
            'esperando_pago',          -- 🟠 datos entregados, esperando pago
            'pago_parcial',            -- 🟣 pagó una parte
            'pagara_presencial',       -- 🔵 pagará en la entrega
            'pagado',                  -- 🟢 pago confirmado, falta decidir entrega
            'acumulando',              -- 🛍️ sigue comprando antes de recibir
            'listo_preparar',          -- 📦 pago ok, preparar pedido
            'envio_programado',        -- 📅 fecha definida para el envío
            'envio_proceso',           -- 🚚 envío creado / en proceso
            'entrega_presencial',      -- 🤝 pendiente de entregar presencial
            'completado',              -- ✅ pedido/entrega finalizada
            'no_pago_liberado'         -- 🔴 no pagó / prenda liberada
        )),
    motivo_cierre text CHECK (motivo_cierre IN ('completado', 'liberado', 'cancelado')),
    creado_en timestamptz NOT NULL DEFAULT now(),
    cerrado_en timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.vl_procesos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.vl_procesos FROM anon, authenticated, public;

-- Un solo proceso activo por cliente (bolsa única, spec §17)
CREATE UNIQUE INDEX IF NOT EXISTS uq_vl_procesos_activo_por_cliente
    ON public.vl_procesos (cliente_id) WHERE (cerrado_en IS NULL);
CREATE INDEX IF NOT EXISTS idx_vl_procesos_tenant_estado
    ON public.vl_procesos (tenant_id, estado);

-- 2.4 vl_items: cada prenda adjudicada (movimiento de compra).
-- Sin inventario previo: solo precio + descripción opcional (spec §7).
CREATE TABLE IF NOT EXISTS public.vl_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    proceso_id uuid NOT NULL REFERENCES public.vl_procesos(id) ON DELETE CASCADE,
    live_id uuid REFERENCES public.vl_lives(id) ON DELETE SET NULL,
    descripcion text NOT NULL DEFAULT '',
    precio numeric(10,2) NOT NULL CHECK (precio > 0),
    abonado numeric(10,2) NOT NULL DEFAULT 0 CHECK (abonado >= 0 AND abonado <= precio),
    estado text NOT NULL DEFAULT 'adjudicada'
        CHECK (estado IN ('adjudicada', 'pagada', 'liberada', 'entregada')),
    creado_en timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.vl_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.vl_items FROM anon, authenticated, public;

CREATE INDEX IF NOT EXISTS idx_vl_items_proceso
    ON public.vl_items (proceso_id);
CREATE INDEX IF NOT EXISTS idx_vl_items_tenant_estado
    ON public.vl_items (tenant_id, estado);
CREATE INDEX IF NOT EXISTS idx_vl_items_live
    ON public.vl_items (live_id);

-- 2.5 vl_pagos: movimientos de pago (historial + finanzas)
CREATE TABLE IF NOT EXISTS public.vl_pagos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    proceso_id uuid NOT NULL REFERENCES public.vl_procesos(id) ON DELETE CASCADE,
    monto numeric(10,2) NOT NULL CHECK (monto > 0),
    metodo text NOT NULL DEFAULT 'transferencia' CHECK (metodo IN ('transferencia', 'efectivo', 'otro')),
    nota text NOT NULL DEFAULT '',
    confirmado_por uuid,
    confirmado_en timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.vl_pagos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.vl_pagos FROM anon, authenticated, public;

CREATE INDEX IF NOT EXISTS idx_vl_pagos_proceso
    ON public.vl_pagos (proceso_id);
CREATE INDEX IF NOT EXISTS idx_vl_pagos_tenant_fecha
    ON public.vl_pagos (tenant_id, confirmado_en);

-- 2.6 vl_envios: entrega (envío o presencial) del proceso activo
CREATE TABLE IF NOT EXISTS public.vl_envios (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    proceso_id uuid NOT NULL UNIQUE REFERENCES public.vl_procesos(id) ON DELETE CASCADE,
    tipo text NOT NULL CHECK (tipo IN ('envio', 'presencial')),
    empresa text CHECK (empresa IN ('blue_express', 'paket', 'chilexpress', 'starken', 'otra')),
    tracking text NOT NULL DEFAULT '',
    fecha_programada date,
    estado text NOT NULL DEFAULT 'pendiente'
        CHECK (estado IN ('pendiente', 'programado', 'en_proceso', 'entregado', 'cancelado')),
    notas text NOT NULL DEFAULT '',
    creado_en timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.vl_envios ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.vl_envios FROM anon, authenticated, public;

CREATE INDEX IF NOT EXISTS idx_vl_envios_tenant_fecha
    ON public.vl_envios (tenant_id, fecha_programada);

-- 2.7 vl_gastos: finanzas (inversión en mercadería y gastos)
CREATE TABLE IF NOT EXISTS public.vl_gastos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    tipo text NOT NULL CHECK (tipo IN ('inversion', 'gasto')),
    concepto text NOT NULL,
    monto numeric(10,2) NOT NULL CHECK (monto > 0),
    fecha date NOT NULL DEFAULT CURRENT_DATE,
    creado_en timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.vl_gastos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.vl_gastos FROM anon, authenticated, public;

CREATE INDEX IF NOT EXISTS idx_vl_gastos_tenant_fecha
    ON public.vl_gastos (tenant_id, fecha);

-- 2.8 vl_config: configuración del workspace vl (1 fila por tenant)
CREATE TABLE IF NOT EXISTS public.vl_config (
    tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
    datos_pago text NOT NULL DEFAULT '',
    dias_reserva int NOT NULL DEFAULT 3 CHECK (dias_reserva BETWEEN 1 AND 60),
    whatsapp_negocio text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.vl_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.vl_config FROM anon, authenticated, public;

-- ============================================================
-- PASO 3: Triggers de updated_at (reutiliza set_updated_at global)
-- ============================================================
DROP TRIGGER IF EXISTS trg_vl_clientes_updated_at ON public.vl_clientes;
CREATE TRIGGER trg_vl_clientes_updated_at
    BEFORE UPDATE ON public.vl_clientes
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_vl_procesos_updated_at ON public.vl_procesos;
CREATE TRIGGER trg_vl_procesos_updated_at
    BEFORE UPDATE ON public.vl_procesos
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_vl_envios_updated_at ON public.vl_envios;
CREATE TRIGGER trg_vl_envios_updated_at
    BEFORE UPDATE ON public.vl_envios
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_vl_config_updated_at ON public.vl_config;
CREATE TRIGGER trg_vl_config_updated_at
    BEFORE UPDATE ON public.vl_config
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- PASO 4: Helpers de lectura internos (solo contexto SECURITY
-- DEFINER; sin GRANT a usuarios)
-- ============================================================
-- Saldo pendiente de un proceso = Σ(precio − abonado) de prendas
-- 'adjudicada'. Nunca se almacena: siempre derivado.
CREATE OR REPLACE FUNCTION public.vl_saldo_proceso(p_proceso_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT COALESCE(SUM(precio - abonado), 0)
    FROM public.vl_items
    WHERE proceso_id = p_proceso_id
      AND estado = 'adjudicada'
$$;

-- Proceso activo de un tenant (NULL si no existe o ya está cerrado)
CREATE OR REPLACE FUNCTION public.vl_proceso_activo(p_proceso_id uuid, p_tenant_id uuid)
RETURNS public.vl_procesos
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT *
    FROM public.vl_procesos
    WHERE id = p_proceso_id
      AND tenant_id = p_tenant_id
      AND cerrado_en IS NULL
    LIMIT 1
$$;

-- ============================================================
-- PASO 5: Trigger de imputación FIFO de pagos
-- Al insertar un pago, abona las prendas 'adjudicada' más antiguas
-- del proceso hasta cubrir el monto; las cubiertas pasan a 'pagada'.
-- La RPC vl_confirmar_pago valida monto <= saldo ANTES del insert.
-- ============================================================
CREATE OR REPLACE FUNCTION public.vl_imputar_pago()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_restante numeric := NEW.monto;
    v_delta numeric;
    v_item record;
BEGIN
    FOR v_item IN
        SELECT id, precio, abonado
        FROM public.vl_items
        WHERE proceso_id = NEW.proceso_id
          AND estado = 'adjudicada'
        ORDER BY creado_en ASC, id ASC
    LOOP
        IF v_restante <= 0 THEN
            EXIT;
        END IF;
        v_delta := LEAST(v_restante, v_item.precio - v_item.abonado);
        UPDATE public.vl_items
        SET abonado = abonado + v_delta,
            estado = CASE WHEN abonado + v_delta >= precio THEN 'pagada' ELSE 'adjudicada' END
        WHERE id = v_item.id;
        v_restante := v_restante - v_delta;
    END LOOP;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vl_imputar_pago ON public.vl_pagos;
CREATE TRIGGER trg_vl_imputar_pago
    AFTER INSERT ON public.vl_pagos
    FOR EACH ROW EXECUTE FUNCTION public.vl_imputar_pago();

-- ============================================================
-- PASO 6: RPC — vl_agregar_item (el corazón del MODO LIVE)
-- Entrada: @usuario TikTok + $precio (spec §4). Hace TODO:
--   1) normaliza y busca/crea el cliente
--   2) obtiene o crea el LIVE del día (auto-cierra lives viejos)
--   3) obtiene o crea el proceso activo (nuevo → esperando_whatsapp)
--   4) inserta la prenda
-- Devuelve resumen + alerta si el cliente tiene historial negativo
-- (nunca bloquea: la decisión es del admin, spec §12).
-- ============================================================
CREATE OR REPLACE FUNCTION public.vl_agregar_item(
    p_tiktok_user text,
    p_precio numeric,
    p_descripcion text DEFAULT ''
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

-- ============================================================
-- PASO 7: RPCs de LIVE (abrir / cerrar / consultar)
-- ============================================================
CREATE OR REPLACE FUNCTION public.vl_live_actual()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_live_id uuid;
    v_etiqueta text;
    v_abierto_en timestamptz;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    -- Auto-roll: un LIVE abierto de un día anterior se cierra solo
    UPDATE public.vl_lives
    SET cerrado_en = now()
    WHERE tenant_id = v_tenant AND cerrado_en IS NULL AND abierto_en::date < CURRENT_DATE;

    SELECT id, etiqueta, abierto_en INTO v_live_id, v_etiqueta, v_abierto_en
    FROM public.vl_lives
    WHERE tenant_id = v_tenant AND cerrado_en IS NULL
    ORDER BY abierto_en DESC
    LIMIT 1;

    IF v_live_id IS NULL THEN
        RETURN jsonb_build_object('ok', true, 'live', NULL);
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'live', jsonb_build_object('id', v_live_id, 'etiqueta', v_etiqueta, 'abierto_en', v_abierto_en)
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.vl_abrir_live(p_etiqueta text DEFAULT '')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_live_id uuid;
    v_etiqueta text;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    v_etiqueta := btrim(COALESCE(p_etiqueta, ''));
    IF v_etiqueta = '' THEN
        v_etiqueta := 'LIVE ' || to_char(CURRENT_DATE, 'YYYY-MM-DD');
    END IF;

    -- Cierra lives abiertos de días anteriores, conserva el de hoy
    UPDATE public.vl_lives
    SET cerrado_en = now()
    WHERE tenant_id = v_tenant AND cerrado_en IS NULL AND abierto_en::date < CURRENT_DATE;

    SELECT id INTO v_live_id
    FROM public.vl_lives
    WHERE tenant_id = v_tenant AND cerrado_en IS NULL AND abierto_en::date = CURRENT_DATE
    ORDER BY abierto_en DESC
    LIMIT 1;

    IF v_live_id IS NULL THEN
        INSERT INTO public.vl_lives (tenant_id, etiqueta)
        VALUES (v_tenant, v_etiqueta)
        RETURNING id INTO v_live_id;
    END IF;

    RETURN jsonb_build_object('ok', true, 'live', jsonb_build_object('id', v_live_id, 'etiqueta', v_etiqueta));
END;
$$;

CREATE OR REPLACE FUNCTION public.vl_cerrar_live(p_live_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_actualizado int;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    UPDATE public.vl_lives
    SET cerrado_en = now()
    WHERE id = p_live_id AND tenant_id = v_tenant AND cerrado_en IS NULL;
    GET DIAGNOSTICS v_actualizado = ROW_COUNT;

    IF v_actualizado = 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'LIVE no encontrado o ya cerrado');
    END IF;

    RETURN jsonb_build_object('ok', true);
END;
$$;

-- ============================================================
-- PASO 8: RPC — vl_actualizar_cliente (perfil + categoría manual)
-- Semántica PATCH: parámetro NULL = no tocar; '' = limpiar el campo.
-- ============================================================
CREATE OR REPLACE FUNCTION public.vl_actualizar_cliente(
    p_cliente_id uuid,
    p_tiktok_user text DEFAULT NULL,
    p_nombre_real text DEFAULT NULL,
    p_whatsapp text DEFAULT NULL,
    p_ciudad text DEFAULT NULL,
    p_comuna text DEFAULT NULL,
    p_direccion text DEFAULT NULL,
    p_entrega_preferida text DEFAULT NULL,
    p_categoria text DEFAULT NULL,
    p_notas text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_tenant_cliente uuid;
    v_user text;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    SELECT tenant_id INTO v_tenant_cliente
    FROM public.vl_clientes WHERE id = p_cliente_id;
    IF v_tenant_cliente IS DISTINCT FROM v_tenant THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Cliente no encontrado');
    END IF;

    IF p_categoria IS NOT NULL AND p_categoria NOT IN ('nuevo', 'confiable', 'problematico', 'bloqueado') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Categoría inválida');
    END IF;
    IF p_entrega_preferida IS NOT NULL AND p_entrega_preferida <> '' AND p_entrega_preferida NOT IN ('envio', 'presencial') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Preferencia de entrega inválida');
    END IF;

    IF p_tiktok_user IS NOT NULL THEN
        v_user := public.vl_normalizar_tiktok(p_tiktok_user);
        IF v_user = '' THEN
            RETURN jsonb_build_object('ok', false, 'error', 'Usuario de TikTok inválido');
        END IF;
        IF EXISTS (
            SELECT 1 FROM public.vl_clientes
            WHERE tenant_id = v_tenant AND tiktok_user = v_user AND id <> p_cliente_id
        ) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'Ya existe otro cliente con ese usuario de TikTok');
        END IF;
    END IF;

    UPDATE public.vl_clientes
    SET tiktok_user = CASE WHEN v_user IS NULL THEN tiktok_user ELSE v_user END,
        nombre_real = CASE WHEN p_nombre_real IS NULL THEN nombre_real ELSE btrim(p_nombre_real) END,
        whatsapp = CASE WHEN p_whatsapp IS NULL THEN whatsapp ELSE btrim(p_whatsapp) END,
        ciudad = CASE WHEN p_ciudad IS NULL THEN ciudad ELSE btrim(p_ciudad) END,
        comuna = CASE WHEN p_comuna IS NULL THEN comuna ELSE btrim(p_comuna) END,
        direccion = CASE WHEN p_direccion IS NULL THEN direccion ELSE btrim(p_direccion) END,
        entrega_preferida = CASE
            WHEN p_entrega_preferida IS NULL THEN entrega_preferida
            WHEN btrim(p_entrega_preferida) = '' THEN NULL
            ELSE btrim(p_entrega_preferida)
        END,
        categoria = CASE WHEN p_categoria IS NULL THEN categoria ELSE p_categoria END,
        notas = CASE WHEN p_notas IS NULL THEN notas ELSE btrim(p_notas) END
    WHERE id = p_cliente_id;

    RETURN jsonb_build_object('ok', true, 'cliente_id', p_cliente_id);
END;
$$;

-- ============================================================
-- PASO 9: RPCs de transición de estado del proceso
-- ============================================================

-- 9.1 Marcar "esperando pago" (el cliente ya fue identificado y
-- recibió los datos de pago; v1: lo hace el admin manualmente)
CREATE OR REPLACE FUNCTION public.vl_marcar_esperando_pago(p_proceso_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_proc public.vl_procesos%ROWTYPE;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    v_proc := public.vl_proceso_activo(p_proceso_id, v_tenant);
    IF v_proc.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Proceso no encontrado o ya cerrado');
    END IF;

    IF v_proc.estado NOT IN ('esperando_whatsapp', 'identificando_cliente', 'pagara_presencial') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Transición no permitida desde ' || v_proc.estado);
    END IF;

    UPDATE public.vl_procesos SET estado = 'esperando_pago' WHERE id = p_proceso_id;

    RETURN jsonb_build_object('ok', true, 'proceso_id', p_proceso_id, 'estado', 'esperando_pago');
END;
$$;

-- 9.2 Marcar "pagará presencialmente"
CREATE OR REPLACE FUNCTION public.vl_marcar_pagara_presencial(p_proceso_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_proc public.vl_procesos%ROWTYPE;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    v_proc := public.vl_proceso_activo(p_proceso_id, v_tenant);
    IF v_proc.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Proceso no encontrado o ya cerrado');
    END IF;

    IF v_proc.estado NOT IN ('esperando_whatsapp', 'identificando_cliente', 'esperando_pago', 'pago_parcial') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Transición no permitida desde ' || v_proc.estado);
    END IF;

    UPDATE public.vl_procesos SET estado = 'pagara_presencial' WHERE id = p_proceso_id;

    RETURN jsonb_build_object('ok', true, 'proceso_id', p_proceso_id, 'estado', 'pagara_presencial');
END;
$$;

-- 9.3 Confirmar pago (spec §13). p_monto = lo que realmente pagó.
--   * monto >= saldo → imputa todo; estado → 'pagado' (o sigue
--     'acumulando' si el cliente ya había elegido acumular; o pasa
--     a 'entrega_presencial' si había dicho que pagaría presencial)
--   * monto < saldo  → 'pago_parcial'
CREATE OR REPLACE FUNCTION public.vl_confirmar_pago(
    p_proceso_id uuid,
    p_monto numeric,
    p_metodo text DEFAULT 'transferencia',
    p_nota text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_proc public.vl_procesos%ROWTYPE;
    v_saldo numeric;
    v_restante numeric;
    v_nuevo_estado text;
    v_pago_id uuid;
    v_metodo text;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    v_proc := public.vl_proceso_activo(p_proceso_id, v_tenant);
    IF v_proc.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Proceso no encontrado o ya cerrado');
    END IF;

    v_metodo := btrim(COALESCE(p_metodo, ''));
    IF v_metodo = '' THEN
        v_metodo := 'transferencia';
    END IF;
    IF v_metodo NOT IN ('transferencia', 'efectivo', 'otro') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Método de pago inválido');
    END IF;

    v_saldo := public.vl_saldo_proceso(p_proceso_id);
    IF v_saldo <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'No hay saldo pendiente en este proceso');
    END IF;
    IF p_monto IS NULL OR p_monto <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Monto inválido');
    END IF;
    IF p_monto > v_saldo THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El monto supera el saldo pendiente ($' || v_saldo || ')');
    END IF;

    INSERT INTO public.vl_pagos (tenant_id, proceso_id, monto, metodo, nota, confirmado_por)
    VALUES (v_tenant, p_proceso_id, p_monto, v_metodo, btrim(COALESCE(p_nota, '')), auth.uid())
    RETURNING id INTO v_pago_id;

    -- El trigger trg_vl_imputar_pago ya abonó las prendas (FIFO)
    v_restante := public.vl_saldo_proceso(p_proceso_id);

    IF v_restante > 0 THEN
        v_nuevo_estado := 'pago_parcial';
    ELSIF v_proc.estado = 'acumulando' THEN
        -- El cliente sigue acumulando: no pierde su decisión
        v_nuevo_estado := 'acumulando';
    ELSIF v_proc.estado = 'pagara_presencial' THEN
        -- Pagó: ahora hay que preparar la entrega presencial
        INSERT INTO public.vl_envios (tenant_id, proceso_id, tipo)
        VALUES (v_tenant, p_proceso_id, 'presencial')
        ON CONFLICT (proceso_id) DO NOTHING;
        v_nuevo_estado := 'entrega_presencial';
    ELSE
        v_nuevo_estado := 'pagado';
    END IF;

    UPDATE public.vl_procesos SET estado = v_nuevo_estado WHERE id = p_proceso_id;

    RETURN jsonb_build_object(
        'ok', true,
        'pago_id', v_pago_id,
        'monto', p_monto,
        'metodo', v_metodo,
        'saldo_restante', v_restante,
        'estado', v_nuevo_estado
    );
END;
$$;

-- 9.4 Decidir entrega post-pago (spec §15). Solo con saldo 0.
--   'acumular'      → ACUMULANDO (sigue comprando en futuros LIVE)
--   'despues'       → se queda PAGADO (no sabe cuándo; el panel recuerda)
--   'enviar_ahora'  → LISTO PARA PREPARAR (envío) / ENTREGA PRESENCIAL
--   'fecha'         → ENVÍO PROGRAMADO (crea la tarea de envío)
CREATE OR REPLACE FUNCTION public.vl_decidir_entrega(
    p_proceso_id uuid,
    p_opcion text,
    p_fecha date DEFAULT NULL,
    p_tipo text DEFAULT 'envio'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_proc public.vl_procesos%ROWTYPE;
    v_saldo numeric;
    v_nuevo_estado text;
    v_tipo text;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    v_proc := public.vl_proceso_activo(p_proceso_id, v_tenant);
    IF v_proc.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Proceso no encontrado o ya cerrado');
    END IF;

    IF v_proc.estado NOT IN ('pagado', 'acumulando') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'La decisión de entrega solo aplica con el proceso pagado');
    END IF;

    v_saldo := public.vl_saldo_proceso(p_proceso_id);
    IF v_saldo > 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Primero debe quedar pagado (saldo pendiente $' || v_saldo || ')');
    END IF;

    v_tipo := btrim(COALESCE(p_tipo, 'envio'));

    IF p_opcion = 'acumular' THEN
        v_nuevo_estado := 'acumulando';
    ELSIF p_opcion = 'despues' THEN
        v_nuevo_estado := CASE WHEN v_proc.estado = 'acumulando' THEN 'acumulando' ELSE 'pagado' END;
    ELSIF p_opcion = 'enviar_ahora' THEN
        IF v_tipo NOT IN ('envio', 'presencial') THEN
            RETURN jsonb_build_object('ok', false, 'error', 'Tipo de entrega inválido');
        END IF;
        INSERT INTO public.vl_envios (tenant_id, proceso_id, tipo)
        VALUES (v_tenant, p_proceso_id, v_tipo)
        ON CONFLICT (proceso_id) DO NOTHING;
        v_nuevo_estado := CASE WHEN v_tipo = 'presencial' THEN 'entrega_presencial' ELSE 'listo_preparar' END;
    ELSIF p_opcion = 'fecha' THEN
        IF p_fecha IS NULL OR p_fecha < CURRENT_DATE THEN
            RETURN jsonb_build_object('ok', false, 'error', 'Fecha de envío inválida (debe ser hoy o futura)');
        END IF;
        INSERT INTO public.vl_envios (tenant_id, proceso_id, tipo, fecha_programada, estado)
        VALUES (v_tenant, p_proceso_id, 'envio', p_fecha, 'programado')
        ON CONFLICT (proceso_id) DO UPDATE
            SET fecha_programada = p_fecha, estado = 'programado', updated_at = now();
        v_nuevo_estado := 'envio_programado';
    ELSE
        RETURN jsonb_build_object('ok', false, 'error', 'Opción inválida');
    END IF;

    UPDATE public.vl_procesos SET estado = v_nuevo_estado WHERE id = p_proceso_id;

    RETURN jsonb_build_object('ok', true, 'proceso_id', p_proceso_id, 'estado', v_nuevo_estado);
END;
$$;

-- 9.5 Crear envío (spec §22): el admin hizo el proceso en la empresa
-- de transporte y vuelve a marcar [ENVÍO CREADO]. Empresa/tracking
-- opcionales en v1.
CREATE OR REPLACE FUNCTION public.vl_crear_envio(
    p_proceso_id uuid,
    p_empresa text DEFAULT NULL,
    p_tracking text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_proc public.vl_procesos%ROWTYPE;
    v_empresa text;
    v_envio_actualizado int;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    v_proc := public.vl_proceso_activo(p_proceso_id, v_tenant);
    IF v_proc.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Proceso no encontrado o ya cerrado');
    END IF;

    IF v_proc.estado NOT IN ('listo_preparar', 'envio_programado', 'envio_proceso') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Este proceso no tiene un envío pendiente de crear');
    END IF;

    v_empresa := btrim(COALESCE(p_empresa, ''));
    IF v_empresa <> '' AND v_empresa NOT IN ('blue_express', 'paket', 'chilexpress', 'starken', 'otra') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Empresa de envío inválida');
    END IF;

    UPDATE public.vl_envios
    SET empresa = NULLIF(v_empresa, ''),
        tracking = btrim(COALESCE(p_tracking, '')),
        estado = 'en_proceso',
        updated_at = now()
    WHERE proceso_id = p_proceso_id AND tenant_id = v_tenant;
    GET DIAGNOSTICS v_envio_actualizado = ROW_COUNT;

    IF v_envio_actualizado = 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Primero define la decisión de entrega (opción envío)');
    END IF;

    IF v_proc.estado IN ('listo_preparar', 'envio_programado') THEN
        UPDATE public.vl_procesos SET estado = 'envio_proceso' WHERE id = p_proceso_id;
    END IF;

    RETURN jsonb_build_object('ok', true, 'proceso_id', p_proceso_id, 'estado', 'envio_proceso');
END;
$$;

-- 9.6 Marcar entregado / completado: cierra el proceso (✅ COMPLETADO)
CREATE OR REPLACE FUNCTION public.vl_marcar_entregado(p_proceso_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_proc public.vl_procesos%ROWTYPE;
    v_saldo numeric;
    v_items int;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    v_proc := public.vl_proceso_activo(p_proceso_id, v_tenant);
    IF v_proc.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Proceso no encontrado o ya cerrado');
    END IF;

    IF v_proc.estado NOT IN ('envio_proceso', 'entrega_presencial') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El proceso no está en una etapa de entrega');
    END IF;

    v_saldo := public.vl_saldo_proceso(p_proceso_id);
    IF v_saldo > 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'No se puede entregar con saldo pendiente ($' || v_saldo || ')');
    END IF;

    UPDATE public.vl_items
    SET estado = 'entregada'
    WHERE proceso_id = p_proceso_id AND estado = 'pagada';
    GET DIAGNOSTICS v_items = ROW_COUNT;

    UPDATE public.vl_envios
    SET estado = 'entregado', updated_at = now()
    WHERE proceso_id = p_proceso_id;

    UPDATE public.vl_procesos
    SET estado = 'completado', cerrado_en = now(), motivo_cierre = 'completado'
    WHERE id = p_proceso_id;

    RETURN jsonb_build_object(
        'ok', true,
        'proceso_id', p_proceso_id,
        'prendas_entregadas', v_items,
        'estado', 'completado'
    );
END;
$$;

-- 9.7 Liberar prendas (spec §11): cliente que no concretó. Solo se
-- liberan prendas 'adjudicada' SIN abonos (las pagadas o con abonos
-- se negocian aparte). Si el proceso queda vacío se cierra como
-- 'no_pago_liberado' (queda en el historial del cliente).
CREATE OR REPLACE FUNCTION public.vl_liberar_items(
    p_proceso_id uuid,
    p_item_ids uuid[],
    p_nota text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_proc public.vl_procesos%ROWTYPE;
    v_item_id uuid;
    v_estado_item text;
    v_abonado numeric;
    v_liberadas int := 0;
    v_total_activos int;
    v_adjudicadas_restantes int;
    v_cliente_id uuid;
    v_nuevo_estado text;
    v_cerrado boolean := false;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    v_proc := public.vl_proceso_activo(p_proceso_id, v_tenant);
    IF v_proc.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Proceso no encontrado o ya cerrado');
    END IF;

    IF v_proc.estado NOT IN ('esperando_whatsapp', 'identificando_cliente', 'esperando_pago', 'pago_parcial', 'pagara_presencial', 'pagado', 'acumulando') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'No se pueden liberar prendas en este estado');
    END IF;

    IF p_item_ids IS NULL OR array_length(p_item_ids, 1) IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Selecciona al menos una prenda');
    END IF;

    -- Validación previa de todas las prendas
    FOREACH v_item_id IN ARRAY p_item_ids LOOP
        SELECT estado, abonado INTO v_estado_item, v_abonado
        FROM public.vl_items
        WHERE id = v_item_id AND proceso_id = p_proceso_id AND tenant_id = v_tenant;

        IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'error', 'Prenda inexistente en este proceso');
        END IF;
        IF v_estado_item <> 'adjudicada' THEN
            RETURN jsonb_build_object('ok', false, 'error', 'La prenda ya no está adjudicada');
        END IF;
        IF v_abonado > 0 THEN
            RETURN jsonb_build_object('ok', false, 'error', 'No se puede liberar una prenda con abonos pagados');
        END IF;
    END LOOP;

    UPDATE public.vl_items
    SET estado = 'liberada'
    WHERE id = ANY(p_item_ids);
    GET DIAGNOSTICS v_liberadas = ROW_COUNT;

    SELECT count(*)::int,
           count(*) FILTER (WHERE estado = 'adjudicada')::int
    INTO v_total_activos, v_adjudicadas_restantes
    FROM public.vl_items
    WHERE proceso_id = p_proceso_id AND estado IN ('adjudicada', 'pagada');

    v_cliente_id := v_proc.cliente_id;

    -- Registro en las notas del cliente (auditoría visible)
    UPDATE public.vl_clientes
    SET notas = concat_ws(E'\n',
            NULLIF(notas, ''),
            '[liberadas ' || v_liberadas || ' prenda(s) el ' || to_char(now(), 'YYYY-MM-DD HH24:MI') || ']'
                || CASE WHEN btrim(COALESCE(p_nota, '')) <> '' THEN ' ' || btrim(p_nota) ELSE '' END)
    WHERE id = v_cliente_id;

    IF v_total_activos = 0 THEN
        -- Proceso vacío: se cierra (histórico "no pagó / prenda liberada")
        UPDATE public.vl_procesos
        SET estado = 'no_pago_liberado', cerrado_en = now(), motivo_cierre = 'liberado'
        WHERE id = p_proceso_id;
        v_nuevo_estado := 'no_pago_liberado';
        v_cerrado := true;
    ELSIF v_adjudicadas_restantes = 0 THEN
        -- Solo quedan prendas pagadas: el proceso pasa a pagado
        IF v_proc.estado IN ('esperando_whatsapp', 'identificando_cliente', 'esperando_pago', 'pago_parcial', 'pagara_presencial') THEN
            UPDATE public.vl_procesos SET estado = 'pagado' WHERE id = p_proceso_id;
            v_nuevo_estado := 'pagado';
        ELSE
            v_nuevo_estado := v_proc.estado;
        END IF;
    ELSE
        v_nuevo_estado := v_proc.estado;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'proceso_id', p_proceso_id,
        'liberadas', v_liberadas,
        'estado', v_nuevo_estado,
        'proceso_cerrado', v_cerrado
    );
END;
$$;

-- 9.8 Eliminar prenda (undo de un error del LIVE). Solo prendas sin
-- abonos del mismo día; el proceso queda intacto en lo demás.
CREATE OR REPLACE FUNCTION public.vl_eliminar_item(p_item_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_item public.vl_items%ROWTYPE;
    v_proceso_id uuid;
    v_restantes int;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    SELECT * INTO v_item
    FROM public.vl_items
    WHERE id = p_item_id AND tenant_id = v_tenant;

    IF v_item.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Prenda no encontrada');
    END IF;
    IF v_item.estado <> 'adjudicada' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo se puede eliminar una prenda sin pagar');
    END IF;
    IF v_item.abonado > 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'No se puede eliminar una prenda con abonos');
    END IF;
    IF v_item.creado_en < now() - interval '1 day' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo se puede eliminar una prenda del mismo día');
    END IF;

    v_proceso_id := v_item.proceso_id;
    DELETE FROM public.vl_items WHERE id = p_item_id;

    -- Si el proceso quedó vacío y sigue activo, se cierra (motivo cancelado)
    SELECT count(*)::int INTO v_restantes
    FROM public.vl_items
    WHERE proceso_id = v_proceso_id AND estado IN ('adjudicada', 'pagada');

    IF v_restantes = 0 THEN
        UPDATE public.vl_procesos
        SET cerrado_en = now(), motivo_cierre = 'cancelado'
        WHERE id = v_proceso_id AND cerrado_en IS NULL;
    END IF;

    RETURN jsonb_build_object('ok', true, 'item_id', p_item_id);
END;
$$;

-- ============================================================
-- PASO 10: RPC — vl_guardar_config (datos de pago que el admin
-- configura; el bot de WhatsApp los enviará en fase 2)
-- ============================================================
CREATE OR REPLACE FUNCTION public.vl_guardar_config(
    p_datos_pago text DEFAULT NULL,
    p_dias_reserva int DEFAULT NULL,
    p_whatsapp_negocio text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_dias int;
BEGIN
    v_tenant := public.get_vl_tenant_id();
    IF v_tenant IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a un espacio de Ventas Live');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador');
    END IF;

    v_dias := COALESCE(p_dias_reserva, 3);
    IF v_dias NOT BETWEEN 1 AND 60 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'dias_reserva debe estar entre 1 y 60');
    END IF;

    INSERT INTO public.vl_config (tenant_id, datos_pago, dias_reserva, whatsapp_negocio)
    VALUES (
        v_tenant,
        btrim(COALESCE(p_datos_pago, '')),
        v_dias,
        btrim(COALESCE(p_whatsapp_negocio, ''))
    )
    ON CONFLICT (tenant_id) DO UPDATE SET
        datos_pago = btrim(COALESCE(p_datos_pago, vl_config.datos_pago)),
        dias_reserva = COALESCE(p_dias_reserva, vl_config.dias_reserva),
        whatsapp_negocio = btrim(COALESCE(p_whatsapp_negocio, vl_config.whatsapp_negocio)),
        updated_at = now();

    RETURN jsonb_build_object('ok', true);
END;
$$;

-- ============================================================
-- PASO 11: Permisos
-- RPCs de dominio: solo authenticated (nunca anon).
-- Helpers y trigger: sin GRANT → solo invocables en contexto
-- SECURITY DEFINER (o por postgres).
-- ============================================================
REVOKE ALL ON FUNCTION public.vl_normalizar_tiktok(text) FROM anon, public;
REVOKE ALL ON FUNCTION public.vl_saldo_proceso(uuid) FROM anon, public;
REVOKE ALL ON FUNCTION public.vl_proceso_activo(uuid, uuid) FROM anon, public;
REVOKE ALL ON FUNCTION public.vl_imputar_pago() FROM anon, public;

REVOKE ALL ON FUNCTION public.vl_agregar_item(text, numeric, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_agregar_item(text, numeric, text) TO authenticated;

REVOKE ALL ON FUNCTION public.vl_live_actual() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_live_actual() TO authenticated;

REVOKE ALL ON FUNCTION public.vl_abrir_live(text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_abrir_live(text) TO authenticated;

REVOKE ALL ON FUNCTION public.vl_cerrar_live(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_cerrar_live(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.vl_actualizar_cliente(uuid, text, text, text, text, text, text, text, text, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_actualizar_cliente(uuid, text, text, text, text, text, text, text, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.vl_marcar_esperando_pago(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_marcar_esperando_pago(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.vl_marcar_pagara_presencial(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_marcar_pagara_presencial(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.vl_confirmar_pago(uuid, numeric, text, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_confirmar_pago(uuid, numeric, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.vl_decidir_entrega(uuid, text, date, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_decidir_entrega(uuid, text, date, text) TO authenticated;

REVOKE ALL ON FUNCTION public.vl_crear_envio(uuid, text, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_crear_envio(uuid, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.vl_marcar_entregado(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_marcar_entregado(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.vl_liberar_items(uuid, uuid[], text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_liberar_items(uuid, uuid[], text) TO authenticated;

REVOKE ALL ON FUNCTION public.vl_eliminar_item(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_eliminar_item(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.vl_guardar_config(text, int, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.vl_guardar_config(text, int, text) TO authenticated;

-- ============================================================
-- PASO 12: Refresh schema cache + verificación
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '[VENTAS LIVE DOMINIO] tablas vl_* + imputación FIFO + RPCs de escritura OK' AS status;
