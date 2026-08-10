// src/subscriptions/infrastructure/mercadopago.js
// Cliente para integrar Mercado Pago con Supabase Edge Functions
//
// Flujo:
//   1. Llama a create-preference (Edge Function) con plan, tenant_id, email
//   2. Edge Function devuelve init_point (URL de checkout de MP)
//   3. Redirige al usuario a MP
//   4. MP envía IPN al webhook → activa suscripción
//   5. Usuario vuelve a planes.html?status=success|failure|pending
//
// Seguridad:
//   - Envía JWT en Authorization header para que el Edge Function valide
//     que el usuario autenticado es dueño del tenant_id
//   - La URL de la Edge Function se obtiene de window.__APP_CONFIG
//     o usa el valor por defecto

/** Obtiene la URL base de las Edge Functions desde la config o usa default */
function getEdgeFunctionUrl() {
    const cfg = window.__APP_CONFIG || {};
    return cfg.edgeFunctionsUrl || 'https://dfcfimipkfhitlsyixqu.supabase.co/functions/v1';
}

/** Obtiene el token JWT actual del usuario */
function getAuthToken() {
    // 1. JwtManager (moderno)
    if (window.JwtManager && typeof window.JwtManager.getAccessToken === 'function') {
        const token = window.JwtManager.getAccessToken();
        if (token) return token;
    }
    // 2. Supabase client session (getSession es async, intentamos obtener sincrónicamente)
    if (window.__session?.access_token) {
        return window.__session.access_token;
    }
    // 3. Fallback: localStorage (compatibilidad script.js legacy)
    try {
        const stored = localStorage.getItem('supabase.auth.token');
        if (stored) {
            const parsed = JSON.parse(stored);
            return parsed?.currentSession?.access_token || null;
        }
    } catch (e) {}
    return null;
}

/**
 * Crea una preferencia de pago en Mercado Pago y redirige al checkout
 * @param {Object} params
 * @param {string} params.plan - 'pro' | 'premium_anual'
 * @param {string} params.tenantId
 * @param {string} params.email
 * @param {string} params.nombre
 * @returns {Promise<{preference_id: string, init_point: string}>}
 */
export async function createMercadoPagoPreference({ plan, tenantId, email, nombre, monto }) {
    if (!plan || !tenantId || !email) {
        throw new Error('plan, tenantId y email son requeridos');
    }

    const token = getAuthToken();
    const headers = {
        'Content-Type': 'application/json',
    };

    // Enviar JWT si está disponible (el Edge Function requiere autenticación)
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    } else {
        console.warn('[MP] No JWT disponible — la solicitud podría ser rechazada');
    }

    const response = await fetch(`${getEdgeFunctionUrl()}/create-preference`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            tenant_id: tenantId,
            plan: plan,
            email: email,
            nombre: nombre || email,
            ...(monto !== undefined ? { monto } : {}),
        }),
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Error desconocido' }));
        throw new Error(errorData.error || `Error HTTP ${response.status}`);
    }

    return await response.json();
}

/**
 * Crea una SUSCRIPCIÓN RECURRENTE en Mercado Pago (preapproval) y redirige al checkout
 * @param {Object} params
 * @param {string} params.plan - 'pro' | 'premium_anual'
 * @param {string} params.tenantId
 * @param {string} params.email
 * @param {string} params.nombre
 * @returns {Promise<{preapproval_id: string, init_point: string}>}
 */
export async function createMercadoPagoPreapproval({ plan, tenantId, email, nombre }) {
    if (!plan || !tenantId || !email) {
        throw new Error('plan, tenantId y email son requeridos');
    }

    const token = getAuthToken();
    const headers = {
        'Content-Type': 'application/json',
    };

    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    } else {
        console.warn('[MP] No JWT disponible — la solicitud podría ser rechazada');
    }

    const response = await fetch(`${getEdgeFunctionUrl()}/create-preapproval`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            tenant_id: tenantId,
            plan: plan,
            email: email,
            nombre: nombre || email,
        }),
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Error desconocido' }));
        throw new Error(errorData.error || `Error HTTP ${response.status}`);
    }

    return await response.json();
}

/**
 * Redirige al usuario al checkout de Mercado Pago
 * @param {string} initPoint - URL de checkout (init_point o sandbox_init_point)
 */
export function redirectToMercadoPago(initPoint) {
    if (!initPoint) {
        throw new Error('init_point no proporcionado');
    }
    window.location.href = initPoint;
}

/**
 * Verifica el estado de pago desde los parámetros de URL
 * @returns {{ status: string|null, payment_id: string|null, preference_id: string|null }}
 */
export function checkPaymentStatusFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('status');
    const paymentId = params.get('payment_id');
    const preferenceId = params.get('preference_id');

    // Parámetros que Mercado Pago agrega al redirect de vuelta
    const mpStatus = params.get('collection_status') || status;
    const mpPaymentId = params.get('collection_id') || paymentId;
    const mpPreferenceId = params.get('preference_id') || preferenceId;

    return {
        status: status || mpStatus || null,
        payment_id: paymentId || mpPaymentId || null,
        preference_id: preferenceId || mpPreferenceId || null,
    };
}
