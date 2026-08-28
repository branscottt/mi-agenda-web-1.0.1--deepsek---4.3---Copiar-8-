-- ============================================================
-- MIGRACIÓN: Directorio Público de PYMEs y Reseñas
-- Fecha: 2026-10-01
--
-- PROBLEMA: los negocios no pueden promocionarse públicamente
-- ni recibir reseñas de sus clientes. El login no tiene forma
-- de mostrar las pymes que ya trabajan con la plataforma.
--
-- SOLUCIÓN:
--   1. Columnas nuevas en tenant_config (mismo patrón que
--      ubicacion_tipo/direccion/instagram_url):
--        directorio_activo      bool   -> opt-in al directorio
--        directorio_categoria   text   -> una de las 5 categorías
--        directorio_tipo_pyme   text   -> tipo de pyme (28 + Otros)
--        directorio_fotos       jsonb  -> URLs de fotos elegidas
--        directorio_estrellas   bool   -> activa puntuación 1-5
--        directorio_comentarios bool   -> activa comentarios públicos
--        directorio_posicion    int    -> orden (superadmin)
--   2. Tabla pyme_resenas: reseñas con moderación
--        estado: pendiente -> aprobado/rechazado (el admin del
--        tenant modera; las públicas solo muestran 'aprobado').
--   3. RPCs SECURITY DEFINER (el anon NO puede leer tenants/
--      tenant_config/subscriptions por RLS):
--        get_directorio_pymes()      -> whitelist pública (anon)
--        crear_resena_pyme(...)      -> inserta reseña (anon)
--        get_resenas_admin()         -> reseñas del tenant (auth)
--        moderar_resena(...)         -> aprobar/rechazar (auth)
--   4. Gate de plan: directorio visible SOLO con suscripción
--      activa en pro, premium_anual o freemium (NO free_trial),
--      consistente con _verificarPlan de VisualConfigService.
--
-- Script lineal, secuencial, idempotente, sin DO $$.
-- ============================================================

-- ============================================================
-- PASO 1: Columnas en tenant_config
-- ============================================================
ALTER TABLE public.tenant_config ADD COLUMN IF NOT EXISTS directorio_activo boolean DEFAULT false;
ALTER TABLE public.tenant_config ADD COLUMN IF NOT EXISTS directorio_categoria text;
ALTER TABLE public.tenant_config ADD COLUMN IF NOT EXISTS directorio_tipo_pyme text;
ALTER TABLE public.tenant_config ADD COLUMN IF NOT EXISTS directorio_fotos jsonb DEFAULT '[]'::jsonb;
ALTER TABLE public.tenant_config ADD COLUMN IF NOT EXISTS directorio_estrellas boolean DEFAULT false;
ALTER TABLE public.tenant_config ADD COLUMN IF NOT EXISTS directorio_comentarios boolean DEFAULT false;
ALTER TABLE public.tenant_config ADD COLUMN IF NOT EXISTS directorio_posicion integer DEFAULT 0;

-- ============================================================
-- PASO 2: Tabla pyme_resenas (acceso solo vía RPCs definer)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.pyme_resenas (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    nombre_cliente text NOT NULL,
    puntuacion integer,
    comentario text,
    estado text NOT NULL DEFAULT 'pendiente',
    creado_en timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT pyme_resenas_pkey PRIMARY KEY (id),
    CONSTRAINT pyme_resenas_tenant_id_fkey FOREIGN KEY (tenant_id)
        REFERENCES public.tenants(id) ON DELETE CASCADE,
    CONSTRAINT pyme_resenas_puntuacion_check CHECK (
        puntuacion IS NULL OR (puntuacion BETWEEN 1 AND 5)
    ),
    CONSTRAINT pyme_resenas_estado_check CHECK (
        estado IN ('pendiente', 'aprobado', 'rechazado')
    )
);

ALTER TABLE public.pyme_resenas ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_pyme_resenas_tenant ON public.pyme_resenas USING btree (tenant_id);
CREATE INDEX IF NOT EXISTS idx_pyme_resenas_estado ON public.pyme_resenas USING btree (estado);

-- ============================================================
-- PASO 3: RPC get_directorio_pymes — lectura pública whitelist
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_directorio_pymes()
RETURNS TABLE(
    tenant_id uuid,
    nombre_negocio text,
    categoria text,
    tipo_pyme text,
    direccion text,
    fotos jsonb,
    logo_url text,
    estrellas_activas boolean,
    comentarios_activos boolean,
    posicion integer,
    promedio real,
    total_resenas bigint,
    resenas jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $function$
BEGIN
    RETURN QUERY
    SELECT
        t.id,
        t.nombre_negocio,
        tc.directorio_categoria,
        tc.directorio_tipo_pyme,
        tc.direccion,
        COALESCE(tc.directorio_fotos, '[]'::jsonb),
        tc.logo_url,
        COALESCE(tc.directorio_estrellas, false),
        COALESCE(tc.directorio_comentarios, false),
        COALESCE(tc.directorio_posicion, 0),
        COALESCE(AVG(r.puntuacion) FILTER (WHERE r.puntuacion IS NOT NULL), 0)::real,
        COUNT(r.id)::bigint,
        COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'nombre_cliente', sub.nombre_cliente,
                'puntuacion', sub.puntuacion,
                'comentario', sub.comentario,
                'creado_en', sub.creado_en
            ))
            FROM (
                SELECT r2.nombre_cliente, r2.puntuacion, r2.comentario, r2.creado_en
                FROM public.pyme_resenas r2
                WHERE r2.tenant_id = t.id AND r2.estado = 'aprobado'
                ORDER BY r2.creado_en DESC
                LIMIT 5
            ) sub
        ), '[]'::jsonb)
    FROM public.tenants t
    JOIN public.tenant_config tc ON tc.tenant_id = t.id
    LEFT JOIN public.pyme_resenas r ON r.tenant_id = t.id AND r.estado = 'aprobado'
    WHERE tc.directorio_activo = true
      AND t.estado = 'activo'
      AND EXISTS (
          SELECT 1 FROM public.subscriptions s
          WHERE s.tenant_id = t.id
            AND s.status = 'active'
            AND s.plan IN ('pro', 'premium_anual', 'freemium')
      )
    GROUP BY t.id, tc.directorio_categoria, tc.directorio_tipo_pyme,
             tc.direccion, tc.directorio_fotos, tc.logo_url,
             tc.directorio_estrellas, tc.directorio_comentarios,
             tc.directorio_posicion
    ORDER BY COALESCE(tc.directorio_posicion, 0) ASC, t.fecha_registro DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_directorio_pymes() TO anon, public;

-- ============================================================
-- PASO 4: RPC crear_resena_pyme — inserta reseña (moderada)
-- ============================================================
CREATE OR REPLACE FUNCTION public.crear_resena_pyme(
    p_tenant_id uuid,
    p_nombre_cliente text,
    p_puntuacion integer,
    p_comentario text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $function$
DECLARE
    v_activo boolean;
    v_estrellas boolean;
    v_comentarios boolean;
BEGIN
    -- Validar que la pyme participe en el directorio con plan válido
    SELECT tc.directorio_activo,
           COALESCE(tc.directorio_estrellas, false),
           COALESCE(tc.directorio_comentarios, false)
      INTO v_activo, v_estrellas, v_comentarios
    FROM public.tenant_config tc
    JOIN public.tenants t ON t.id = tc.tenant_id
    WHERE tc.tenant_id = p_tenant_id
      AND t.estado = 'activo'
      AND EXISTS (
          SELECT 1 FROM public.subscriptions s
          WHERE s.tenant_id = t.id
            AND s.status = 'active'
            AND s.plan IN ('pro', 'premium_anual', 'freemium')
      );

    IF v_activo IS NULL OR NOT v_activo THEN
        RAISE EXCEPTION 'Esta pyme no participa en el directorio público';
    END IF;

    IF p_nombre_cliente IS NULL OR length(trim(p_nombre_cliente)) < 2 THEN
        RAISE EXCEPTION 'Escribe tu nombre para dejar la reseña';
    END IF;
    IF p_puntuacion IS NULL AND (p_comentario IS NULL OR length(trim(p_comentario)) = 0) THEN
        RAISE EXCEPTION 'Agrega una puntuación o un comentario';
    END IF;
    IF p_puntuacion IS NOT NULL THEN
        IF NOT v_estrellas THEN
            RAISE EXCEPTION 'Esta pyme no acepta puntuaciones con estrellas';
        END IF;
        IF p_puntuacion < 1 OR p_puntuacion > 5 THEN
            RAISE EXCEPTION 'La puntuación debe estar entre 1 y 5 estrellas';
        END IF;
    END IF;
    IF p_comentario IS NOT NULL AND length(trim(p_comentario)) > 0 AND NOT v_comentarios THEN
        RAISE EXCEPTION 'Esta pyme no acepta comentarios públicos';
    END IF;
    IF p_comentario IS NOT NULL AND length(p_comentario) > 500 THEN
        RAISE EXCEPTION 'El comentario es demasiado largo (máximo 500 caracteres)';
    END IF;

    INSERT INTO public.pyme_resenas (tenant_id, nombre_cliente, puntuacion, comentario, estado)
    VALUES (
        p_tenant_id,
        trim(p_nombre_cliente),
        p_puntuacion,
        CASE WHEN p_comentario IS NULL OR length(trim(p_comentario)) = 0
             THEN NULL ELSE trim(p_comentario) END,
        'pendiente'
    );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.crear_resena_pyme(uuid, text, integer, text) TO anon, public;

-- ============================================================
-- PASO 5: RPC get_resenas_admin — reseñas del tenant (admin/super)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_resenas_admin()
RETURNS TABLE(
    id uuid,
    tenant_id uuid,
    nombre_cliente text,
    puntuacion integer,
    comentario text,
    estado text,
    creado_en timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $function$
DECLARE
    v_tenant uuid;
BEGIN
    IF public.is_super_admin() THEN
        RETURN QUERY
        SELECT r.id, r.tenant_id, r.nombre_cliente, r.puntuacion, r.comentario, r.estado, r.creado_en
        FROM public.pyme_resenas r
        ORDER BY r.creado_en DESC;
        RETURN;
    END IF;

    v_tenant := public.get_user_tenant_id();
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'No autorizado';
    END IF;

    RETURN QUERY
    SELECT r.id, r.tenant_id, r.nombre_cliente, r.puntuacion, r.comentario, r.estado, r.creado_en
    FROM public.pyme_resenas r
    WHERE r.tenant_id = v_tenant
    ORDER BY r.creado_en DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_resenas_admin() TO authenticated;

-- ============================================================
-- PASO 6: RPC moderar_resena — aprobar/rechazar (admin/super)
-- ============================================================
CREATE OR REPLACE FUNCTION public.moderar_resena(p_resena_id uuid, p_estado text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $function$
DECLARE
    v_tenant_resena uuid;
    v_tenant_llamador uuid;
BEGIN
    IF p_estado NOT IN ('aprobado', 'rechazado') THEN
        RAISE EXCEPTION 'Estado inválido';
    END IF;

    SELECT tenant_id INTO v_tenant_resena
    FROM public.pyme_resenas
    WHERE id = p_resena_id;

    IF v_tenant_resena IS NULL THEN
        RAISE EXCEPTION 'Reseña no encontrada';
    END IF;

    IF public.is_super_admin() THEN
        v_tenant_llamador := v_tenant_resena;
    ELSE
        v_tenant_llamador := public.get_user_tenant_id();
        IF v_tenant_llamador IS NULL OR v_tenant_llamador <> v_tenant_resena THEN
            RAISE EXCEPTION 'No autorizado para moderar esta reseña';
        END IF;
    END IF;

    UPDATE public.pyme_resenas
    SET estado = p_estado
    WHERE id = p_resena_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.moderar_resena(uuid, text) TO authenticated;
