// src/shared/infrastructure/env.js
// Detección de entorno de ejecución.
//
// Origen de la configuración (por orden de prioridad):
//   1. window.__APP_CONFIG (inyectado por server.py o hosting)
//   2. location.hostname (fallback: localhost => development, otros => production)
//
// Uso:
//   import { getEnv, isDevelopment, isProduction } from './env.js';
//   if (isDevelopment()) { console.log('Modo desarrollo'); }

/**
 * Obtiene el entorno actual.
 * @returns {'development'|'production'}
 */
export function getEnv() {
    // Prioridad 1: config inyectada por el servidor
    if (window.__APP_CONFIG && window.__APP_CONFIG.environment) {
        return window.__APP_CONFIG.environment;
    }

    // Prioridad 2: hostname
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') {
        return 'development';
    }

    return 'production';
}

/** ¿Estamos en desarrollo local? */
export function isDevelopment() {
    return getEnv() === 'development';
}

/** ¿Estamos en producción? */
export function isProduction() {
    return getEnv() === 'production';
}
