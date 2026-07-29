// src/shared/infrastructure/analytics.js
// Integración con PostHog para analítica de eventos de usuario.
//
// Gratuito: 1M eventos/mes (cloud), ilimitado (self-hosted).
// Registro: https://posthog.com/signup
//
// La API key se inyecta via window.__APP_CONFIG.posthogApiKey.
// En desarrollo local SIN API key configurada, las llamadas son no-op.
//
// Privacidad:
//   - No se envían datos personales (emails, nombres, teléfonos).
//   - Solo se envían IDs internos (tenant_id, user_id de Supabase).
//   - La decisión de identificar (identify) se toma solo si hay config.
//   - PostHog respeta leyes de privacidad (GDPR-ready).

const POSTHOG_CDN = 'https://cdn.jsdelivr.net/npm/posthog-js@1.216.1/dist/posthog.min.js';

let _initialized = false;
let _posthog = null;

/**
 * Inicializa PostHog si hay API key configurada.
 * No-op en desarrollo sin API key.
 * @returns {Promise<boolean>} true si se inicializó correctamente
 */
export async function initAnalytics() {
    if (_initialized) return true;

    const apiKey = window.__APP_CONFIG?.posthogApiKey;
    const host = window.__APP_CONFIG?.posthogHost || 'https://app.posthog.com';

    // Sin API key: modo silencioso (no-op)
    if (!apiKey || apiKey === 'phc_xx...x') {
        console.log('[Analytics] No configurado (sin POSTHOG_API_KEY)');
        _initialized = true; // marcar como inicializado para evitar reintentos
        return false;
    }

    try {
        // Cargar SDK desde CDN (como Sentry y Supabase)
        await new Promise((resolve, reject) => {
            if (window.posthog) {
                resolve();
                return;
            }
            const script = document.createElement('script');
            script.src = POSTHOG_CDN;
            script.onload = resolve;
            script.onerror = () => reject(new Error('Fallo al cargar PostHog CDN'));
            document.head.appendChild(script);
        });

        if (typeof window.posthog?.init === 'function') {
            window.posthog.init(apiKey, {
                api_host: host,
                capture_pageview: true,       // Auto-track page views
                capture_pageleave: true,       // Auto-track page leaves
                persistence: 'localStorage',   // Mantener ID de visitante
                loaded: (ph) => {
                    _posthog = ph;
                    console.log('[Analytics] PostHog inicializado correctamente');
                },
                // Desactivar si estamos en entorno local (aunque tenga key)
                // para no contaminar datos de producción durante desarrollo
                autocapture: false,            // No auto-capturar clicks (solo eventos manuales)
            });

            _initialized = true;
            return true;
        } else {
            console.warn('[Analytics] SDK cargado pero window.posthog.init no disponible');
            return false;
        }
    } catch (e) {
        console.warn('[Analytics] Error al inicializar:', e);
        return false;
    }
}

/**
 * Trackea un evento en PostHog.
 * No-op si PostHog no está inicializado.
 *
 * @param {string} eventName - Nombre del evento (ej: 'login_success')
 * @param {object} [properties={}] - Propiedades del evento (sin PII)
 */
export function trackEvent(eventName, properties = {}) {
    if (!_posthog) {
        // Si no se inicializó, intentar de nuevo (puede estar cargando aún)
        if (!_initialized) {
            initAnalytics().then(() => {
                if (_posthog) {
                    _posthog.capture(eventName, properties);
                }
            });
        }
        return;
    }

    try {
        _posthog.capture(eventName, properties);
    } catch (e) {
        console.warn('[Analytics] Error trackeando evento:', e);
    }
}

/**
 * Identifica a un usuario en PostHog.
 * Solo se llama cuando hay un usuario autenticado.
 * No envía PII (nombre, email) — solo IDs internos.
 *
 * @param {string} userId - ID interno del usuario (UUID de Supabase)
 * @param {object} [traits={}] - Atributos no-PII (rol, tenant_id, plan)
 */
export function identifyUser(userId, traits = {}) {
    if (!_posthog) return;

    try {
        _posthog.identify(userId, traits);
    } catch (e) {
        console.warn('[Analytics] Error identificando usuario:', e);
    }
}

/**
 * Reinicia la identificación (útil en logout).
 */
export function resetAnalytics() {
    if (!_posthog) return;

    try {
        _posthog.reset();
    } catch (e) {
        console.warn('[Analytics] Error reseteando:', e);
    }
}
