// src/subscriptions/infrastructure/mercadopago.js
// Cliente para integrar Mercado Pago con Supabase Edge Functions
//
// Flujo:
//   1. Llama a create-preference (Edge Function) con plan, tenant_id, email
//   2. Edge Function devuelve init_point (URL de checkout de MP)
//   3. Redirige al usuario a MP
//   4. MP envía IPN al webhook → activa suscripción
//   5. Usuario vuelve a planes.html?status=success|failure|pending

const EDGE_FUNCTION_URL = 'https://dfcfimipkfhitlsyixqu.supabase.co/functions/v1/create-preference';

/**
 * Crea una preferencia de pago en Mercado Pago y redirige al checkout
 * @param {Object} params
 * @param {string} params.plan - 'pro' | 'premium_anual'
 * @param {string} params.tenantId
 * @param {string} params.email
 * @param {string} params.nombre
 * @returns {Promise<{preference_id: string, init_point: string}>}
 */
export async function createMercadoPagoPreference({ plan, tenantId, email, nombre }) {
    if (!plan || !tenantId || !email) {
        throw new Error('plan, tenantId y email son requeridos');
    }

    const response = await fetch(EDGE_FUNCTION_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
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

    // También soporta los parámetros que MP agrega en el redirect
    const mpStatus = params.get('collection_status') || params.get('status');

    return {
        status: status || mpStatus || null,
        payment_id: paymentId || params.get('payment_id') || null,
        preference_id: preferenceId || null,
    };
}
