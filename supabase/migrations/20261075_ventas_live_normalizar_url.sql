-- ============================================================================
-- MIGRACIÓN 20261075: Ventas Live — normalizar @usuario desde un ENLACE
-- Fecha: 2026-10-10
--
-- PROBLEMA: en el LIVE de TikTok NO se puede copiar el nombre de usuario
-- (TikTok bloquea copiar solo el nombre). Lo que sí se puede copiar/arrastrar
-- es el ENLACE del perfil, p.ej. https://www.tiktok.com/@ianaianita. Al
-- pegarlo, se guardaba el ENLACE COMPLETO como si fuera el usuario: se creaba
-- una ficha basura "https://www.tiktok.com/@ianaianita".
--   Esto afectaba a la vez:
--     * la web (campo "Usuario TikTok" del MODO LIVE) — también arreglado en JS
--       con normalizarTiktok (src/ventas-live/domain/vlApi.js);
--     * el bot de WhatsApp, cuando el cliente PEGA el enlace de su perfil al
--       bot preguntarle su usuario (vl_wa_conversacion_avanzar → vl_normalizar_tiktok).
--
-- SOLUCIÓN: vl_normalizar_tiktok reconoce el enlace de TikTok y se queda con el
-- @usuario que va en él. El resto de la regla NO cambia (minúsculas, sin @
-- inicial, sin espacios) y los @ ya guardados quedan igual (no son enlaces),
-- así que el CHECK de vl_clientes sigue válido y no hay que migrar datos.
-- Idempotente (CREATE OR REPLACE). No toca nada del proyecto 'reservas'.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.vl_normalizar_tiktok(p_tiktok text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
    SELECT trim(both '.' from
        regexp_replace(
            regexp_replace(
                CASE
                    -- Enlace de TikTok (perfil o /live, con o sin querystring):
                    -- se toma el @usuario que va dentro del enlace.
                    WHEN position('tiktok.com/' in lower(COALESCE(p_tiktok, ''))) > 0
                    THEN COALESCE(
                        (regexp_match(lower(p_tiktok), 'tiktok\.com/@?([a-z0-9._]+)'))[1],
                        COALESCE(p_tiktok, ''))
                    ELSE COALESCE(p_tiktok, '')
                END,
                '^@+', '', 'g'),
            '\s+', '', 'g'))
$$;
