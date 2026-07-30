// src/shared/infrastructure/config.js
// Configuración centralizada de Agenda Pro.
//
// Fuentes de configuración (por orden de prioridad):
//   1. window.__APP_CONFIG — inyectado por server.py (producción) o por el hosting
//   2. Valores hardcodeados (solo para desarrollo, compatibilidad hacia atrás)
//
// Las credenciales de Supabase son anon/public keys (seguras para el cliente).
// La seguridad real está en las RLS policies de Supabase.
// Las claves de PostHog son públicas (Project API Key, no Personal API Key).

const _defaults = {
    supabaseUrl: 'https://dfcfimipkfhitlsyixqu.supabase.co',
    supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRmY2ZpbWlwa2ZoaXRsc3lpeHF1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxNzczMzAsImV4cCI6MjA4ODc1MzMzMH0.1OviTiPxYIK83bbmrYVY1nUR2o0bxn_wfqnWqK4Ccw0',
    environment: 'development',
    posthogApiKey: '',
    posthogHost: 'https://app.posthog.com',
};

/**
 * Obtiene la configuración de la app.
 * Prioridad: window.__APP_CONFIG > defaults hardcodeados
 * @returns {object}
 */
export function getAppConfig() {
    if (window.__APP_CONFIG) {
        const cfg = {};
        // Valores del servidor (tienen prioridad)
        if (window.__APP_CONFIG.supabaseUrl) cfg.supabaseUrl = window.__APP_CONFIG.supabaseUrl;
        if (window.__APP_CONFIG.supabaseKey) cfg.supabaseKey = window.__APP_CONFIG.supabaseKey;
        if (window.__APP_CONFIG.environment) cfg.environment = window.__APP_CONFIG.environment;
        if (window.__APP_CONFIG.posthogApiKey) cfg.posthogApiKey = window.__APP_CONFIG.posthogApiKey;
        if (window.__APP_CONFIG.posthogHost) cfg.posthogHost = window.__APP_CONFIG.posthogHost;

        // Rellenar desde defaults lo que no vino del servidor
        cfg.supabaseUrl = cfg.supabaseUrl || _defaults.supabaseUrl;
        cfg.supabaseKey = cfg.supabaseKey || _defaults.supabaseKey;
        cfg.environment = cfg.environment || _defaults.environment;
        cfg.posthogApiKey = cfg.posthogApiKey || _defaults.posthogApiKey;
        cfg.posthogHost = cfg.posthogHost || _defaults.posthogHost;

        return cfg;
    }
    return { ..._defaults };
}

// Conveniencia: export directo de las constantes
const _cfg = getAppConfig();
export const SUPABASE_URL = _cfg.supabaseUrl;
export const SUPABASE_KEY = _cfg.supabaseKey;
export const APP_ENV = _cfg.environment;
export const POSTHOG_API_KEY = _cfg.posthogApiKey;
export const POSTHOG_HOST = _cfg.posthogHost;
