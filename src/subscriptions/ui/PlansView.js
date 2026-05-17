// src/subscriptions/ui/PlansView.js
// Vista de selección y cambio de planes de suscripción
// Extraida de script.js (funciones: cargarPlanes, crearSuscripcionInicial, solicitarCambioPlan, crearNotificacionCambioPlan)

const PLANS = [
    { key: 'freemium', name: 'Freemium', price: 'Gratis', color: '#6c757d', icon: 'fa-star' },
    { key: 'pro', name: 'Pro', price: 'Próximamente', color: '#007bff', icon: 'fa-gem' },
    { key: 'premium_anual', name: 'Premium Anual', price: 'Próximamente', color: '#ffc107', icon: 'fa-crown' }
];

/**
 * Renderiza la página de planes disponibles
 * @param {HTMLElement} container
 * @param {Object} apis - window.__apis
 */
export async function renderPlans(container, apis) {
    if (!container) return;

    const tenantId = await obtenerTenantId();
    const currentPlan = await obtenerPlanActual(tenantId, apis);

    container.innerHTML = `
        <div class="plans-container">
            <h2><i class="fas fa-tags"></i> Planes de suscripción</h2>
            <p class="text-muted">Selecciona el plan que mejor se adapte a tu negocio.</p>
            <div class="plans-grid" style="display:flex; gap:20px; flex-wrap:wrap; justify-content:center;">
                ${PLANS.map(p => `
                    <div class="plan-card" style="border:2px solid ${currentPlan === p.key ? p.color : '#dee2e6'}; border-radius:12px; padding:24px; width:280px; text-align:center; background:#fff; box-shadow:0 2px 8px rgba(0,0,0,0.1);">
                        <i class="fas ${p.icon}" style="font-size:48px; color:${p.color};"></i>
                        <h3 style="margin:12px 0 4px;">${p.name}</h3>
                        <p style="font-size:24px; font-weight:bold; color:${p.color};">${p.price}</p>
                        <ul style="list-style:none; padding:0; margin:16px 0; text-align:left;">
                            <li><i class="fas fa-check text-success"></i> Catálogo de servicios</li>
                            <li><i class="fas fa-check text-success"></i> Gestión de citas</li>
                            ${p.key !== 'freemium' ? '<li><i class="fas fa-check text-success"></i> Estadísticas avanzadas</li><li><i class="fas fa-check text-success"></i> Soporte prioritario</li>' : ''}
                        </ul>
                        ${currentPlan === p.key
                            ? `<button class="btn btn-secondary" disabled><i class="fas fa-check-circle"></i> Plan actual</button>`
                            : `<button class="btn btn-primary" onclick="event.preventDefault(); window.crearNotificacionCambioPlan('${tenantId}', '${currentPlan}', '${p.key}')">
                                <i class="fas fa-exchange-alt"></i> Solicitar cambio
                              </button>`
                        }
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

async function obtenerTenantId() {
    const jwt = JSON.parse(localStorage.getItem('supabase.auth.token') || '{}');
    return jwt?.currentSession?.user?.user_metadata?.tenant_id || null;
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

/**
 * Crea una notificación de solicitud de cambio de plan
 */
export async function solicitarCambioPlan(tenantId, planAnterior, planNuevo) {
    if (!tenantId || !window.__apis?.notificaciones?.create) {
        mostrarToast('Error: APIs no disponibles', 'error');
        return;
    }
    try {
        await window.__apis.notificaciones.create({
            title: 'Solicitud de cambio de plan',
            message: `El tenant ${tenantId} solicita cambiar de ${planAnterior} a ${planNuevo}`,
            tenant_id: tenantId,
            tipo: 'cambio_plan',
            leida: false,
            created_at: new Date().toISOString()
        });
        mostrarToast('Solicitud enviada. Un administrador la revisará.', 'success');
    } catch (e) {
        mostrarToast('Error al enviar solicitud: ' + e.message, 'error');
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