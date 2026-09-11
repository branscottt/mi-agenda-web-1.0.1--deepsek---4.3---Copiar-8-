-- ============================================================
-- MIGRACIÓN: Archivos sin dueño persistentes + auto-emparejamiento
-- Fecha: 2026-10-32
--
-- PROBLEMA: la bandeja "archivos sin dueño" del Centro de Mudanza
-- (20261022) vive SOLO en memoria: al cerrar el modal se borran los
-- binarios de Storage (src/clients/ui/MudanzaModal.js:350-357) y no
-- queda registro. Por eso hoy es imposible que un archivo que ya se
-- subió se le entregue solo al cliente cuando ese cliente aparece.
--
-- SOLUCIÓN:
--   - clientes_archivos_huerfanos : bandeja persistente por tenant.
--                                   Guarda el binario (Storage) y la
--                                   "pista" = nombre normalizado del
--                                   archivo. estado pendiente →
--                                   asignado | descartado.
--   - normalizar_pista()          : normalizador único (acentos,
--                                   separadores) compartido por el
--                                   motor y verificable en SQL.
--   - _huerfanos_candidatos()     : universo de clientes del tenant
--                                   (clientes_manuales + citas.contacto,
--                                   con email sintético walkin.<tel>
--                                   cuando falta correo, mismo patrón
--                                   de la casa).
--   - _huerfanos_reconciliar()    : MOTOR. Para cada huérfano pendiente
--                                   calcula el mejor puntaje de match y
--                                   asigna SOLO si el match es ÚNICO.
--                                   Si hay 2+ candidatos (dos "Camila")
--                                   NO auto-asigna: queda pendiente para
--                                   que el admin elija. Nada se pierde.
--   - _huerfano_asignar_interno() : alta en clientes_archivos (+versión
--                                   si ya existe), reutilizando EXACTA-
--                                   mente el patrón de
--                                   admin_archivo_crear_subido.
--   - RPCs admin_* con validación de tenant + is_admin().
--   - Triggers en citas y clientes_manuales: cuando un cliente se
--     registra (reserva) o se da de alta, se corre el motor. Van
--     envueltos en EXCEPTION para que NUNCA puedan tumbar una reserva.
--
-- RLS: mismo patrón validado en 20261022 (authenticated +
-- get_user_tenant_id() + is_admin()).
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: Tabla de archivos sin dueño
-- ============================================================
CREATE TABLE IF NOT EXISTS public.clientes_archivos_huerfanos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    nombre_original text NOT NULL,
    nombre_archivo text NOT NULL,
    pista text NOT NULL DEFAULT '',
    tipo_mime text NOT NULL DEFAULT 'application/octet-stream',
    tamano bigint NOT NULL DEFAULT 0,
    storage_path text NOT NULL DEFAULT '',
    estado text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'asignado', 'descartado')),
    asignado_a_email text,
    asignado_en timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clientes_archivos_huerfanos_tenant_estado
    ON public.clientes_archivos_huerfanos (tenant_id, estado);
CREATE INDEX IF NOT EXISTS idx_clientes_archivos_huerfanos_pista
    ON public.clientes_archivos_huerfanos (tenant_id, pista);

-- ============================================================
-- PASO 2: updated_at automático (función existente set_updated_at)
-- ============================================================
DROP TRIGGER IF EXISTS trigger_set_updated_at_clientes_archivos_huerfanos ON public.clientes_archivos_huerfanos;
CREATE TRIGGER trigger_set_updated_at_clientes_archivos_huerfanos
    BEFORE UPDATE ON public.clientes_archivos_huerfanos
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- PASO 3: RLS — solo el admin de su tenant
-- ============================================================
ALTER TABLE public.clientes_archivos_huerfanos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin gestiona archivos sin dueno de su tenant" ON public.clientes_archivos_huerfanos;
CREATE POLICY "Admin gestiona archivos sin dueno de su tenant" ON public.clientes_archivos_huerfanos
    FOR ALL TO authenticated
    USING (
        tenant_id = public.get_user_tenant_id()
        AND public.is_admin()
    )
    WITH CHECK (
        tenant_id = public.get_user_tenant_id()
        AND public.is_admin()
    );

-- ============================================================
-- PASO 4: Normalizador compartido
-- minúsculas + sin acentos + solo [a-z0-9]. Debe dar el MISMO
-- resultado que normalizar() de MudanzaModal.js para los casos
-- reales (la comparación final igual se hace normalizando los dos
-- lados en SQL, así que no depende del front).
-- ============================================================
CREATE OR REPLACE FUNCTION public.normalizar_pista(p_texto text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT COALESCE(
        regexp_replace(
            translate(
                lower(COALESCE(p_texto, '')),
                'áàäâãéèëêíìïîóòöôõúùüûñç',
                'aaaaaeeeeiiiiooooouuuunc'
            ),
            '[^a-z0-9]+', '', 'g'
        ),
        ''
    );
$$;

-- ============================================================
-- PASO 5: Universo de clientes candidatos del tenant
-- clientes_manuales (alta manual/importada) + citas.contacto
-- (reservas). Si no hay correo, se usa el patrón de la casa
-- walkin.<telefono>@sinemail.local para poder asignarle archivos.
-- ============================================================
CREATE OR REPLACE FUNCTION public._huerfanos_candidatos(p_tenant_id uuid)
RETURNS TABLE (email text, pnom text, ptel text, pebox text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH base AS (
        SELECT cm.nombre, cm.email, cm.telefono
        FROM public.clientes_manuales cm
        WHERE cm.tenant_id = p_tenant_id
        UNION ALL
        SELECT
            COALESCE(c.contacto ->> 'nombre', ''),
            COALESCE(c.contacto ->> 'email', ''),
            COALESCE(c.contacto ->> 'telefono', '')
        FROM public.citas c
        WHERE c.tenant_id = p_tenant_id
    ),
    normalizado AS (
        SELECT
            CASE
                WHEN btrim(COALESCE(email, '')) ~ '@' THEN lower(btrim(email))
                WHEN regexp_replace(COALESCE(telefono, ''), '[^0-9]', '', 'g') <> ''
                    THEN 'walkin.' || regexp_replace(COALESCE(telefono, ''), '[^0-9]', '', 'g') || '@sinemail.local'
                ELSE ''
            END AS email,
            public.normalizar_pista(nombre) AS pnom,
            regexp_replace(COALESCE(telefono, ''), '[^0-9]', '', 'g') AS ptel
        FROM base
    )
    SELECT
        n.email,
        n.pnom,
        n.ptel,
        CASE
            WHEN n.email LIKE '%@sinemail.local' THEN ''
            ELSE public.normalizar_pista(split_part(n.email, '@', 1))
        END AS pebox
    FROM normalizado n
    WHERE n.email <> '' AND n.email ~ '@'
    GROUP BY n.email, n.pnom, n.ptel;
$$;

-- ============================================================
-- PASO 6: Asignación interna (sin chequeo de admin; la usan los
-- RPC admin y el motor de triggers). Mismo patrón que
-- admin_archivo_crear_subido: FOR UPDATE + número de versión.
-- ============================================================
CREATE OR REPLACE FUNCTION public._huerfano_asignar_interno(
    p_tenant_id uuid,
    p_huerfano_id uuid,
    p_cliente_email text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_orf public.clientes_archivos_huerfanos%ROWTYPE;
    v_archivo_id uuid;
    v_tipo_existente text;
    v_numero integer;
    v_email text;
BEGIN
    SELECT * INTO v_orf
    FROM public.clientes_archivos_huerfanos
    WHERE id = p_huerfano_id AND tenant_id = p_tenant_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El archivo sin dueño no existe en este negocio');
    END IF;
    IF v_orf.estado = 'asignado' THEN
        RETURN jsonb_build_object('ok', true, 'ya_asignado', true);
    END IF;
    IF v_orf.estado = 'descartado' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El archivo fue descartado');
    END IF;

    v_email := lower(btrim(p_cliente_email));
    IF v_email = '' OR v_email !~ '@' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Email de cliente inválido');
    END IF;

    -- ¿Ya existe el archivo lógico (tenant, email, nombre)? Bloqueo la
    -- fila para serializar el número de versión.
    SELECT id, tipo INTO v_archivo_id, v_tipo_existente
    FROM public.clientes_archivos
    WHERE tenant_id = p_tenant_id
      AND lower(btrim(cliente_email)) = v_email
      AND nombre = btrim(v_orf.nombre_archivo)
    FOR UPDATE;

    IF v_archivo_id IS NULL THEN
        INSERT INTO public.clientes_archivos (tenant_id, cliente_email, nombre, tipo)
        VALUES (p_tenant_id, v_email, btrim(v_orf.nombre_archivo), 'subido')
        RETURNING id INTO v_archivo_id;
        v_numero := 1;
    ELSE
        IF v_tipo_existente = 'drive' THEN
            RETURN jsonb_build_object(
                'ok', false,
                'error', 'Ya existe un enlace de Drive con ese nombre en la carpeta del cliente: renombralo o asignalo a otro nombre'
            );
        END IF;
        SELECT COALESCE(MAX(numero), 0) + 1 INTO v_numero
        FROM public.clientes_archivo_versiones
        WHERE archivo_id = v_archivo_id;
    END IF;

    INSERT INTO public.clientes_archivo_versiones
        (archivo_id, numero, nombre_archivo, tipo_mime, tamano, storage_path)
    VALUES
        (v_archivo_id, v_numero, btrim(v_orf.nombre_archivo),
         COALESCE(btrim(v_orf.tipo_mime), 'application/octet-stream'),
         COALESCE(v_orf.tamano, 0), btrim(v_orf.storage_path));

    UPDATE public.clientes_archivos_huerfanos
    SET estado = 'asignado',
        asignado_a_email = v_email,
        asignado_en = now()
    WHERE id = p_huerfano_id;

    RETURN jsonb_build_object(
        'ok', true,
        'archivo_id', v_archivo_id,
        'numero', v_numero,
        'cliente_email', v_email
    );
END;
$$;

-- ============================================================
-- PASO 7: Motor de reconciliación
-- Auto-asigna SOLO match ÚNICO. Con 0 candidatos o 2+ queda
-- pendiente (nada se pierde y nadie se lleva el archivo de otro).
-- Corta temprano si el tenant no tiene huérfanos pendientes.
-- ============================================================
CREATE OR REPLACE FUNCTION public._huerfanos_reconciliar(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_orf RECORD;
    v_pista text;
    v_ncand integer;
    v_email text;
    v_res jsonb;
    v_auto integer := 0;
    v_ambiguos integer := 0;
    v_sin integer := 0;
BEGIN
    IF p_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Falta el negocio');
    END IF;

    -- Corto temprano: sin pendientes no hay nada que hacer (indexado).
    IF NOT EXISTS (
        SELECT 1 FROM public.clientes_archivos_huerfanos
        WHERE tenant_id = p_tenant_id AND estado = 'pendiente'
    ) THEN
        RETURN jsonb_build_object('ok', true, 'auto_asignados', 0, 'ambiguos', 0, 'sin_match', 0);
    END IF;

    FOR v_orf IN
        SELECT id, nombre_original, pista
        FROM public.clientes_archivos_huerfanos
        WHERE tenant_id = p_tenant_id AND estado = 'pendiente'
        ORDER BY created_at
    LOOP
        -- La pista se recalcula en SQL desde el nombre original (así no
        -- depende de lo que haya guardado el frontend).
        v_pista := public.normalizar_pista(regexp_replace(v_orf.nombre_original, '\.[^.]+$', ''));
        IF v_pista = '' THEN
            v_sin := v_sin + 1;
            CONTINUE;
        END IF;

        -- Mejor puntaje entre los clientes del tenant. Se puntúa por
        -- ESPECIFICIDAD (cuánto del nombre coincide), así "camila gomez.xlsx"
        -- elige a "Camila Gómez" y no a "Camila"; y un empate real
        -- (dos clientes con el MISMO nombre) NO se auto-asigna.
        --   1000 = nombre del cliente idéntico a la pista
        --    900 = teléfono del archivo coincide con el del cliente
        --    100 = el nombre del cliente encabeza la pista
        --     50 = el nombre del cliente aparece dentro de la pista
        --     40 = el correo del cliente aparece dentro de la pista
        WITH c AS (
            SELECT * FROM public._huerfanos_candidatos(p_tenant_id)
        ),
        s AS (
            SELECT
                c.email,
                GREATEST(
                    CASE WHEN c.ptel <> '' AND length(c.ptel) >= 6 AND v_pista LIKE '%' || c.ptel || '%'
                         THEN 900 + length(c.ptel) ELSE 0 END,
                    CASE WHEN c.pnom <> '' AND c.pnom = v_pista
                         THEN 1000 ELSE 0 END,
                    CASE WHEN length(c.pnom) >= 3 AND v_pista LIKE c.pnom || '%'
                         THEN 100 + length(c.pnom) ELSE 0 END,
                    CASE WHEN length(c.pnom) >= 4 AND v_pista LIKE '%' || c.pnom || '%'
                         THEN 50 + length(c.pnom) ELSE 0 END,
                    CASE WHEN length(c.pebox) >= 4 AND v_pista LIKE '%' || c.pebox || '%'
                         THEN 40 + length(c.pebox) ELSE 0 END
                ) AS sc
            FROM c
        ),
        r AS (
            SELECT email FROM s WHERE sc > 0 AND sc = (SELECT max(sc) FROM s)
        )
        SELECT count(DISTINCT email), min(email)
        INTO v_ncand, v_email
        FROM r;

        IF v_ncand = 0 THEN
            v_sin := v_sin + 1;
            CONTINUE;
        END IF;

        IF v_ncand > 1 THEN
            -- Dos clientes podrían ser ("dos Camila"): NO se auto-asigna.
            v_ambiguos := v_ambiguos + 1;
            CONTINUE;
        END IF;

        v_res := public._huerfano_asignar_interno(p_tenant_id, v_orf.id, v_email);
        IF v_res ->> 'ok' = 'true' THEN
            v_auto := v_auto + 1;
        ELSE
            v_sin := v_sin + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'ok', true,
        'auto_asignados', v_auto,
        'ambiguos', v_ambiguos,
        'sin_match', v_sin
    );
END;
$$;

-- ============================================================
-- PASO 8: RPCs admin (alta / listado / asignar / lote / descartar / reconciliar)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_huerfano_crear(
    p_tenant_id uuid,
    p_nombre_original text,
    p_nombre_archivo text,
    p_tipo_mime text DEFAULT 'application/octet-stream',
    p_tamano bigint DEFAULT 0,
    p_storage_path text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_actual uuid;
    v_id uuid;
BEGIN
    SELECT public.get_user_tenant_id() INTO v_tenant_actual;
    IF v_tenant_actual IS DISTINCT FROM p_tenant_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador puede guardar archivos sin dueño');
    END IF;
    IF p_nombre_original IS NULL OR trim(p_nombre_original) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El nombre del archivo es requerido');
    END IF;
    IF p_storage_path IS NULL OR btrim(p_storage_path) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Falta la ruta del archivo en Storage');
    END IF;

    INSERT INTO public.clientes_archivos_huerfanos
        (tenant_id, nombre_original, nombre_archivo, pista, tipo_mime, tamano, storage_path)
    VALUES (
        p_tenant_id,
        btrim(p_nombre_original),
        COALESCE(NULLIF(btrim(p_nombre_archivo), ''), btrim(p_nombre_original)),
        public.normalizar_pista(regexp_replace(btrim(p_nombre_original), '\.[^.]+$', '')),
        COALESCE(btrim(p_tipo_mime), 'application/octet-stream'),
        COALESCE(p_tamano, 0),
        btrim(p_storage_path)
    )
    RETURNING id INTO v_id;

    RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_huerfanos_listar(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_actual uuid;
    v_items jsonb;
BEGIN
    SELECT public.get_user_tenant_id() INTO v_tenant_actual;
    IF v_tenant_actual IS DISTINCT FROM p_tenant_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador ve los archivos sin dueño');
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', h.id,
        'nombre_original', h.nombre_original,
        'nombre_archivo', h.nombre_archivo,
        'tipo_mime', h.tipo_mime,
        'tamano', h.tamano,
        'estado', h.estado,
        'asignado_a_email', h.asignado_a_email,
        'created_at', h.created_at
    ) ORDER BY h.created_at), '[]'::jsonb)
    INTO v_items
    FROM public.clientes_archivos_huerfanos h
    WHERE h.tenant_id = p_tenant_id AND h.estado = 'pendiente';

    RETURN jsonb_build_object('ok', true, 'items', v_items);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_huerfano_asignar(
    p_tenant_id uuid,
    p_huerfano_id uuid,
    p_cliente_email text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_actual uuid;
BEGIN
    SELECT public.get_user_tenant_id() INTO v_tenant_actual;
    IF v_tenant_actual IS DISTINCT FROM p_tenant_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador puede asignar archivos');
    END IF;
    RETURN public._huerfano_asignar_interno(p_tenant_id, p_huerfano_id, p_cliente_email);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_huerfanos_asignar_lote(
    p_tenant_id uuid,
    p_huerfano_ids uuid[],
    p_cliente_email text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_actual uuid;
    v_id uuid;
    v_res jsonb;
    v_ok integer := 0;
    v_err integer := 0;
BEGIN
    SELECT public.get_user_tenant_id() INTO v_tenant_actual;
    IF v_tenant_actual IS DISTINCT FROM p_tenant_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador puede asignar archivos');
    END IF;
    IF p_huerfano_ids IS NULL OR array_length(p_huerfano_ids, 1) IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'No elegiste archivos');
    END IF;

    FOREACH v_id IN ARRAY p_huerfano_ids LOOP
        v_res := public._huerfano_asignar_interno(p_tenant_id, v_id, p_cliente_email);
        IF v_res ->> 'ok' = 'true' THEN
            v_ok := v_ok + 1;
        ELSE
            v_err := v_err + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object('ok', true, 'asignados', v_ok, 'con_error', v_err);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_huerfano_descartar(
    p_tenant_id uuid,
    p_huerfano_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_actual uuid;
    v_orf public.clientes_archivos_huerfanos%ROWTYPE;
BEGIN
    SELECT public.get_user_tenant_id() INTO v_tenant_actual;
    IF v_tenant_actual IS DISTINCT FROM p_tenant_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador puede descartar archivos');
    END IF;

    UPDATE public.clientes_archivos_huerfanos
    SET estado = 'descartado'
    WHERE id = p_huerfano_id AND tenant_id = p_tenant_id AND estado = 'pendiente'
    RETURNING * INTO v_orf;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'El archivo no existe o ya fue procesado');
    END IF;

    -- El binario lo borra el cliente (mismo orden que deleteAttachment de kanbanApi).
    RETURN jsonb_build_object('ok', true, 'storage_path', v_orf.storage_path);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_huerfanos_reconciliar(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_actual uuid;
BEGIN
    SELECT public.get_user_tenant_id() INTO v_tenant_actual;
    IF v_tenant_actual IS DISTINCT FROM p_tenant_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio');
    END IF;
    IF NOT public.is_admin() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Solo el administrador puede emparejar archivos');
    END IF;
    RETURN public._huerfanos_reconciliar(p_tenant_id);
END;
$$;

-- ============================================================
-- PASO 9: Triggers — al registrarse un cliente (reserva) o al
-- darse de alta (manual/importado), correr el motor.
-- BLINDADO: cualquier error se traga; jamás interrumpe la reserva.
-- ============================================================
CREATE OR REPLACE FUNCTION public.trg_reconciliar_huerfanos()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    BEGIN
        IF NEW.tenant_id IS NOT NULL THEN
            PERFORM public._huerfanos_reconciliar(NEW.tenant_id);
        END IF;
    EXCEPTION WHEN OTHERS THEN
        -- La reconciliación de archivos NUNCA puede hacer fallar el
        -- registro del cliente ni la reserva.
        NULL;
    END;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_citas_reconciliar_huerfanos ON public.citas;
CREATE TRIGGER trg_citas_reconciliar_huerfanos
    AFTER INSERT ON public.citas
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_reconciliar_huerfanos();

DROP TRIGGER IF EXISTS trg_manuales_reconciliar_huerfanos ON public.clientes_manuales;
CREATE TRIGGER trg_manuales_reconciliar_huerfanos
    AFTER INSERT OR UPDATE ON public.clientes_manuales
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_reconciliar_huerfanos();

-- ============================================================
-- PASO 10: Permisos — internos cerrados; RPCs admin solo authenticated
-- ============================================================
REVOKE EXECUTE ON FUNCTION public._huerfanos_candidatos(uuid) FROM public;
REVOKE EXECUTE ON FUNCTION public._huerfano_asignar_interno(uuid, uuid, text) FROM public;
REVOKE EXECUTE ON FUNCTION public._huerfanos_reconciliar(uuid) FROM public;
REVOKE EXECUTE ON FUNCTION public.trg_reconciliar_huerfanos() FROM public;

REVOKE EXECUTE ON FUNCTION public.admin_huerfano_crear(uuid, text, text, text, bigint, text) FROM public;
REVOKE EXECUTE ON FUNCTION public.admin_huerfanos_listar(uuid) FROM public;
REVOKE EXECUTE ON FUNCTION public.admin_huerfano_asignar(uuid, uuid, text) FROM public;
REVOKE EXECUTE ON FUNCTION public.admin_huerfanos_asignar_lote(uuid, uuid[], text) FROM public;
REVOKE EXECUTE ON FUNCTION public.admin_huerfano_descartar(uuid, uuid) FROM public;
REVOKE EXECUTE ON FUNCTION public.admin_huerfanos_reconciliar(uuid) FROM public;

GRANT EXECUTE ON FUNCTION public.admin_huerfano_crear(uuid, text, text, text, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_huerfanos_listar(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_huerfano_asignar(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_huerfanos_asignar_lote(uuid, uuid[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_huerfano_descartar(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_huerfanos_reconciliar(uuid) TO authenticated;

-- ============================================================
-- PASO 11: Refresh schema cache + verificación
-- ============================================================
NOTIFY pgrst, 'reload schema';

SELECT '✅ clientes_archivos_huerfanos + RLS + motor de emparejamiento (match único) + triggers citas/clientes_manuales' AS status;
