// src/subscriptions/ui/PlansView.js
// Vista de selección y cambio de planes de suscripción
// Incluye integración con Mercado Pago para pagos

import { createMercadoPagoPreference, redirectToMercadoPago, checkPaymentStatusFromUrl } from '../infrastructure/mercadopago.js';

const PLANS = [
    { key: 'freemium', name: 'Freemium', price: 'Gratis', color: '#6c757d', icon: 'fa-star', priceValue: 0 },
    { key: 'pro', name: 'Pro', price: '$15.000/mes', color: '#007bff', icon: 'fa-gem', priceValue: 15000 },
    { key: 'premium_anual', name: 'Premium Anual', price: '$140.000/año', color: '#ffc107', icon: 'fa-crown', priceValue: 140000 }
];

/**
 * Renderiza la página de planes disponibles
 * @param {HTMLElement} container
 * @param {Object} apis - window.__apis
 */
export async function renderPlans(container, apis) {
    if (!container) return;

    // Mostrar estado de pago si venimos de MP
    const paymentStatus = checkPaymentStatusFromUrl();
    const paymentMessage = getPaymentStatusMessage(paymentStatus);

    const tenantId = await obtenerTenantId();
    const currentPlan = await obtenerPlanActual(tenantId, apis);
    const userEmail = obtenerUserEmail();

    container.innerHTML = `
        <div class="plans-container">
            <h2><i class="fas fa-tags"></i> Planes de suscripción</h2>
            <p class="text-muted">Selecciona el plan que mejor se adapte a tu negocio.</p>
            ${paymentMessage}
            <div class="plans-grid" style="display:flex; gap:20px; flex-wrap:wrap; justify-content:center;">
                ${PLANS.map(p => {
                    const isCurrent = currentPlan === p.key;
                    const canPay = p.key !== 'freemium' && !isCurrent;
                    return `
                    <div class="plan-card" data-plan="${p.key}" style="border:2px solid ${isCurrent ? p.color : '#dee2e6'}; border-radius:12px; padding:24px; width:280px; text-align:center; background:#fff; box-shadow:0 2px 8px rgba(0,0,0,0.1);">
                        <i class="fas ${p.icon}" style="font-size:48px; color:${p.color};"></i>
                        <h3 style="margin:12px 0 4px;">${p.name}</h3>
                        <p style="font-size:24px; font-weight:bold; color:${p.color};">${p.price}</p>
                        <ul style="list-style:none; padding:0; margin:16px 0; text-align:left;">
                            <li><i class="fas fa-check text-success"></i> Catálogo de servicios</li>
                            <li><i class="fas fa-check text-success"></i> Gestión de citas</li>
                            <li><i class="fas fa-check text-success"></i> Notificaciones</li>
                            ${p.key !== 'freemium' ? '<li><i class="fas fa-check text-success"></i> Estadísticas avanzadas</li><li><i class="fas fa-check text-success"></i> Soporte prioritario</li>' : ''}
                            ${p.key === 'premium_anual' ? '<li><i class="fas fa-check text-success"></i> <strong>Ahorras $40.000 al año</strong></li>' : ''}
                        </ul>
                        ${isCurrent
                            ? `<button class="btn btn-secondary" disabled><i class="fas fa-check-circle"></i> Plan actual</button>`
                            : p.key === 'freemium'
                                ? `<button class="btn btn-outline-secondary" disabled><i class="fas fa-star"></i> Gratuito</button>`
                                : `<button class="btn btn-primary btn-pagar-mp" data-plan="${p.key}" data-price="${p.priceValue}">
                                    <i class="fas fa-credit-card"></i> Pagar con Mercado Pago
                                  </button>`
                        }
                    </div>`;
                }).join('')}
            </div>
        </div>
    `;

    // Bindeo de eventos para botones de pago
    container.querySelectorAll('.btn-pagar-mp').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const plan = e.currentTarget.dataset.plan;
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Procesando...';

            try {
                const pref = await createMercadoPagoPreference({
                    plan: plan,
                    tenantId: tenantId,
                    email: userEmail,
                    nombre: userEmail,
                });
                redirectToMercadoPago(pref.init_point || pref.sandbox_init_point);
            } catch (err) {
                console.error('[MP] Error:', err);
                mostrarToast('Error al iniciar pago: ' + err.message, 'error');
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-credit-card"></i> Pagar con Mercado Pago';
            }
        });
    });
}

function getPaymentStatusMessage(status) {
    if (!status || !status.status) return '';

    const messages = {
        success: '<div class="alert alert-success"><i class="fas fa-check-circle"></i> ¡Pago exitoso! Tu suscripción se activará en unos segundos.</div>',
        failure: '<div class="alert alert-danger"><i class="fas fa-times-circle"></i> El pago fue rechazado. Intenta con otro método de pago.</div>',
        pending: '<div class="alert alert-warning"><i class="fas fa-clock"></i> El pago está pendiente. Te notificaremos cuando se confirme.</div>',
    };

    return messages[status.status] || '';
}

async function obtenerTenantId() {
    const jwt = JSON.parse(localStorage.getItem('supabase.auth.token') || '{}');
    const fromSession = jwt?.currentSession?.user?.user_metadata?.tenant_id;
    if (fromSession) return fromSession;
    // Fallback: obtener de la función global de sesión
    try {
        if (typeof getCurrentTenantId === 'function') return await getCurrentTenantId();
        if (window.__session?.tenant_id) return window.__session.tenant_id;
    } catch {}
    return null;
}

function obtenerUserEmail() {
    const jwt = JSON.parse(localStorage.getItem('supabase.auth.token') || '{}');
    return jwt?.currentSession?.user?.email || jwt?.currentSession?.user?.user_metadata?.email || '';
}

async function obtenerPlanActual(tenantId, apis) {
    if (!tenantId || !apis?.subscriptions?.getActiveByTenant) return 'freemium';
    try {
        const sub = await apis.subscriptions.getActiveByTenant(tenantId);
        return sub?.plan || 'freemium';
    } catch {
        return 'freemium';
    }
}

export function mostrarToast(mensaje, tipo = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${tipo}`;
    toast.textContent = mensaje;
    toast.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;padding:12px 24px;border-radius:8px;color:#fff;font-weight:500;animation:fadeIn 0.3s;';
    const colors = { info: '#17a2b8', success: '#28a745', error: '#dc3545', warning: '#ffc107' };
    toast.style.background = colors[tipo] || '#17a2b8';
    if (tipo === 'warning') toast.style.color = '#333';
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.5s'; setTimeout(() => toast.remove(), 500); }, 3000);
}