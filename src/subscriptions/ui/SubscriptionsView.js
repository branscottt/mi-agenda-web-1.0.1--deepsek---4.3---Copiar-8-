// src/subscriptions/ui/SubscriptionsView.js
// Vista de suscripción actual del tenant
// Extraida de script.js (funcion: cargarSuscripcionTenant)

import { getCurrentTenantId } from '../../shared/infrastructure/supabase.js';

/**
 * Renderiza la información de suscripción actual del tenant
 * @param {HTMLElement} container
 * @param {Object} apis - window.__apis
 */
export async function renderSubscriptions(container, apis) {
    if (!container) return;

    // Intentar obtener tenantId desde el contenedor o la sesión
    let tenantId = container?.dataset?.tenantId || getCurrentTenantId();

    if (!tenantId) {
        container.innerHTML = '<p class="text-muted">No se pudo identificar el tenant.</p>';
        return;
    }

    try {
        const subscription = await apis.subscriptions.getActiveByTenant(tenantId);
        if (!subscription) {
            container.innerHTML = `
                <div class="alert alert-warning">
                    <i class="fas fa-exclamation-triangle"></i> No tienes una suscripción activa. 
                    <a href="#" onclick="event.preventDefault(); cargarPlanes();">Ver planes disponibles</a>
                </div>
            `;
            return;
        }

        container.innerHTML = `
            <div class="subscription-card">
                <div class="subscription-header">
                    <h3><i class="fas fa-crown"></i> Plan: <strong>${subscription.plan}</strong></h3>
                    <span class="badge badge-${subscription.status === 'active' ? 'success' : 'warning'}">${subscription.status}</span>
                </div>
                <div class="subscription-details">
                    <p><i class="fas fa-calendar-alt"></i> Inicio: ${new Date(subscription.start_date || subscription.created_at).toLocaleDateString()}</p>
                    <p><i class="fas fa-calendar-times"></i> Fin: ${subscription.end_date ? new Date(subscription.end_date).toLocaleDateString() : 'Sin fecha de fin'}</p>
                    ${subscription.features ? `<p><i class="fas fa-list"></i> Características: ${subscription.features}</p>` : ''}
                </div>
                <button class="btn btn-outline-primary" onclick="event.preventDefault(); cargarPlanes();">
                    <i class="fas fa-exchange-alt"></i> Cambiar plan
                </button>
            </div>
        `;
    } catch (e) {
        console.error('[SubscriptionsView] Error:', e);
        container.innerHTML = '<p class="text-danger">Error al cargar suscripción.</p>';
    }
}