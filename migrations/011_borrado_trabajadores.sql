-- Cambiar FK de citas.trabajador_id a ON DELETE SET NULL
-- Al eliminar un trabajador, sus citas pasadas conservan el ID en NULL
ALTER TABLE public.citas DROP CONSTRAINT IF EXISTS citas_trabajador_id_fkey;
ALTER TABLE public.citas ADD CONSTRAINT citas_trabajador_id_fkey
    FOREIGN KEY (trabajador_id) REFERENCES public.trabajadores(id) ON DELETE SET NULL;
NOTIFY pgrst, 'reload schema';
