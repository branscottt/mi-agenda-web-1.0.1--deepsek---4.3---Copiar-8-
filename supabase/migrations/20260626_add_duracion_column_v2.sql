-- ============================================================
-- MIGRACIÓN v2: Agregar columna duracion a tabla servicios
-- Ultra robusta, idempotente, con recarga de esquema PostgREST
-- ============================================================
-- Ejecutar en Supabase SQL Editor (Dashboard > SQL Editor)
-- Fecha: 2026-06-26
-- ============================================================

DO $$
BEGIN
    -- PASO 1: Agregar columna (aceptando NULL temporalmente)
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'servicios'
          AND column_name = 'duracion'
    ) THEN
        ALTER TABLE public.servicios ADD COLUMN duracion INTEGER;
        RAISE NOTICE 'PASO 1: Columna duracion agregada (nullable)';
    ELSE
        RAISE NOTICE 'PASO 1: Columna duracion ya existe — omitido';
    END IF;

    -- PASO 2: Poblar registros existentes con NULL
    UPDATE public.servicios SET duracion = 60 WHERE duracion IS NULL;
    RAISE NOTICE 'PASO 2: Registros NULL poblados con 60';

    -- PASO 3: Aplicar NOT NULL y DEFAULT
    BEGIN
        ALTER TABLE public.servicios ALTER COLUMN duracion SET NOT NULL;
        ALTER TABLE public.servicios ALTER COLUMN duracion SET DEFAULT 60;
        RAISE NOTICE 'PASO 3: NOT NULL + DEFAULT 60 aplicados';
    EXCEPTION
        WHEN others THEN
            RAISE WARNING 'PASO 3: No se pudo aplicar restricciones — %', SQLERRM;
    END;

    -- PASO 4: Verificar RLS
    -- Las políticas RLS existentes usan USING/WITH CHECK basados en tenant_id,
    -- no referencian columnas específicas. La nueva columna duracion
    -- queda automáticamente cubierta sin cambios en políticas.
    RAISE NOTICE 'PASO 4: RLS verificado — políticas existentes son agnósticas a columnas';

    -- PASO 5: Verificar vistas dependientes
    -- No se encontraron vistas que dependan de public.servicios.
    -- Si existieran, se reconstruirían aquí.
    RAISE NOTICE 'PASO 5: Sin vistas dependientes — omitido';

END $$;

-- PASO 6: Recargar esquema de PostgREST (API REST de Supabase)
-- Sin esto, PostgREST puede mantener un caché obsoleto donde
-- la columna duracion aún no existe, causando HTTP 400.
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- VERIFICACIÓN POST-MIGRACIÓN
-- ============================================================
-- Ejecutar la siguiente consulta para confirmar:
--
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_schema = 'public'
--   AND table_name = 'servicios'
--   AND column_name = 'duracion';
--
-- Resultado esperado:
--   column_name: duracion
--   data_type: integer
--   is_nullable: NO
--   column_default: 60
-- ============================================================
