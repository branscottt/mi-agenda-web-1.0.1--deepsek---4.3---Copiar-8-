// src/shared/infrastructure/sentry.js
// Integración con Sentry para monitoreo de errores en producción.
//
// Activar: descomentar la línea SENTRY_CDN con tu URL de Sentry.
// El DSN se auto-detecta desde la URL del script (no necesita config manual).
//
// Sentry es GRATIS para uso básico (5k eventos/mes, 50k transacciones/mes).

// Tu URL única de Sentry (de Project Settings > Client Keys > DSN)
const SENTRY_CDN = 'https://js.sentry-cdn.com/333f0f359a3edbfcb15fcbd0854696ee.min.js';

/**
 * Inicializa Sentry cargando el SDK desde tu CDN único.
 * No afecta HTML ni CSS. Se llama desde main.js.
 * @returns {Promise<boolean>} true si se inicializó correctamente
 */
export async function initSentry() {
    const cdnUrl = SENTRY_CDN;
    if (!cdnUrl) {
        console.log('[Sentry] No configurado (CDN vacío)');
        return false;
    }

    try {
        // Cargar SDK desde CDN mediante script tag (el CDN no es ES module,
        // usa window.Sentry global — NO se puede import() como modulo)
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = cdnUrl;
            script.onload = resolve;
            script.onerror = () => reject(new Error('Fallo al cargar Sentry CDN'));
            document.head.appendChild(script);
        });

        if (typeof window.Sentry?.init === 'function') {
            window.Sentry.init({
                environment: location.hostname === 'localhost' ? 'development' : 'production',
                release: 'agenda-pro@1.0.0',
                tracesSampleRate: 0.1,
                ignoreErrors: [
                    'ResizeObserver',
                    'NetworkError',
                    'Chrome',
                    'extension',
                    'popup',
                ],
            });
            console.log('[Sentry] Inicializado correctamente');
            return true;
        } else {
            console.warn('[Sentry] SDK cargado pero window.Sentry.init no está disponible');
            return false;
        }
    } catch (e) {
        console.warn('[Sentry] Error al inicializar:', e);
        return false;
    }
}
