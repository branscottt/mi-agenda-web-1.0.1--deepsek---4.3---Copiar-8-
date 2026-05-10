-- Mejora: agregar columna updated_at y trigger automatico a servicios y citas

-- 1. Agregar columna updated_at a servicios
ALTER TABLE public.servicios ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT now();

-- 2. Agregar columna updated_at a citas
ALTER TABLE public.citas ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT now();

-- 3. Funcion trigger para actualizar updated_at automaticamente
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4. Trigger para servicios
DROP TRIGGER IF EXISTS trigger_set_updated_at_servicios ON public.servicios;
CREATE TRIGGER trigger_set_updated_at_servicios
    BEFORE UPDATE ON public.servicios
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

-- 5. Trigger para citas
DROP TRIGGER IF EXISTS trigger_set_updated_at_citas ON public.citas;
CREATE TRIGGER trigger_set_updated_at_citas
    BEFORE UPDATE ON public.citas
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();