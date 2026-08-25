-- Tutorial Mi Equipo: bucket publico + policy anon TEMPORAL scoped al objeto exacto
-- (se dropea en la migracion siguiente tras el upload)

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('tutoriales', 'tutoriales', true, 52428800, ARRAY['video/mp4'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "anon_upload_tutorial_equipo" ON storage.objects;
CREATE POLICY "anon_upload_tutorial_equipo" ON storage.objects
    FOR INSERT TO anon
    WITH CHECK (bucket_id = 'tutoriales' AND name = 'tutorial-mi-equipo.mp4');
