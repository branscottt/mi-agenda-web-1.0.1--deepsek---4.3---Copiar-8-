// src/shared/infrastructure/config.js
// Configuración centralizada de Agenda Pro
// 
// En desarrollo: usa valores hardcodeados (compatibilidad hacia atrás)
// En producción: server.py o el hosting puede inyectar window.__APP_CONFIG
// con las variables de entorno reales.
//
// Las credenciales de Supabase son anon/public keys (seguras para el cliente).
// La seguridad real está en las RLS policies de Supabase.

const _defaults = {
    supabaseUrl: 'https://dfcfimipkfhitlsyixqu.supabase.co',
    supabaseKey: 'eyJhbG...Ccw0',
};

/**
 * Obtiene la configuración de la app.
 * Prioridad: window.__APP_CONFIG > defaults hardcodeados
 */
export function getAppConfig() {
    if (window.__APP_CONFIG && window.__APP_CONFIG.supabaseUrl && window.__APP_CONFIG.supabaseKey) {
        return {
            supabaseUrl: window.__APP_CONFIG.supabaseUrl,
            supabaseKey: window.__APP_CONFIG.supabaseKey,
        };
    }
    return { ..._defaults };
}

// Conveniencia: export directo de las constantes
export const SUPABASE_URL = getAppConfig().supabaseUrl;
export const SUPABASE_KEY = getAppConfig().supabaseKey;
