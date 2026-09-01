// src/subscriptions/ui/PlansView.js
// Vista de selección y cambio de planes de suscripción
// Incluye integración con Mercado Pago para pagos

import { createMercadoPagoPreference, createMercadoPagoPreapproval, redirectToMercadoPago, checkPaymentStatusFromUrl } from '../infrastructure/mercadopago.js';
import { checkPromoCouponStatus, markPromoCouponUsed } from '../../api/subscriptionsApi.js';

const PLANS = [
    { key: 'free_trial', name: 'Free Trial', price: 'Gratis', color: '#00b894', icon: 'fa-flask', priceValue: 0, desc: '14 días de prueba sin límites' },
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

    // Ocultar navegación para nuevos registros (new=true)
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('new') === 'true') {
        const nav = document.querySelector('.screen-navigation');
        if (nav) nav.style.display = 'none';
    }

    // Free Trial SOLO al crear tenant (?new=true) — nunca al cambiar de plan
    const isNewAdmin = urlParams.get('new') === 'true';
    const plansVisibles = PLANS.filter(p => p.key !== 'free_trial' || isNewAdmin);

    // Mostrar estado de pago si venimos de MP
    const paymentStatus = checkPaymentStatusFromUrl();
    const paymentMessage = getPaymentStatusMessage(paymentStatus);

    // Mostrar banner según motivo de llegada a planes
    const expiredBanner = urlParams.get('expired') === 'true' ? `
        <div class="alert alert-warning" style="background:#f39c12;color:#fff;padding:16px 24px;border-radius:12px;margin-bottom:24px;display:flex;align-items:center;gap:12px;">
            <i class="fas fa-exclamation-triangle" style="font-size:24px;"></i>
            <div>
                <strong style="font-size:1.1rem;">Tu suscripción ha expirado</strong>
                <p style="margin:4px 0 0;opacity:0.9;">Para usar el panel de administración, elige un plan y reactiva tu suscripción. Tus datos están a salvo.</p>
            </div>
        </div>
    ` : '';

    const pendingWhatsapp = urlParams.get('pending_whatsapp') === 'true' ? `
        <div class="alert alert-info" style="background:#3498db;color:#fff;padding:16px 24px;border-radius:12px;margin-bottom:24px;display:flex;align-items:center;gap:12px;">
            <i class="fas fa-info-circle" style="font-size:24px;"></i>
            <div>
                <strong style="font-size:1.1rem;">Completa tu registro</strong>
                <p style="margin:4px 0 0;opacity:0.9;">Antes de usar el panel, ingresa tu número de WhatsApp para que tus clientes puedan contactarte.</p>
            </div>
        </div>
    ` : '';

    const suspendedBanner = urlParams.get('suspended') === 'true' ? `
        <div class="alert alert-danger" style="background:#e74c3c;color:#fff;padding:16px 24px;border-radius:12px;margin-bottom:24px;display:flex;align-items:center;gap:12px;">
            <i class="fas fa-ban" style="font-size:24px;"></i>
            <div>
                <strong style="font-size:1.1rem;">Cuenta desactivada</strong>
                <p style="margin:4px 0 0;opacity:0.9;">Tu cuenta ha sido desactivada por el administrador. Todos tus datos están a salvo. Si crees que es un error, contacta al soporte.</p>
            </div>
        </div>
    ` : '';

    const tenantId = await obtenerTenantId();
    const currentPlan = await obtenerPlanActual(tenantId);
    const userEmail = obtenerUserEmail();

    // Cupón promocional 50% (solo Pro mensual): mostrar SOLO si está aprobado
    let promoActiva = false;
    try {
        const promoStatus = await checkPromoCouponStatus(tenantId);
        const promoData = Array.isArray(promoStatus) ? promoStatus[0] : promoStatus;
        if (promoData && promoData.discount_available) promoActiva = true;
    } catch (e) {
        console.warn('[PlansView] Error verificando cupón promocional:', e);
    }

    // Auto-redirect después de pago exitoso
    if (paymentStatus?.status === 'success') {
        // Marcar cupón promocional como usado si corresponde
        const couponId = sessionStorage.getItem('promo_coupon_used');
        if (couponId) {
            try {
                await markPromoCouponUsed(couponId);
                sessionStorage.removeItem('promo_coupon_used');
                console.log('[PlansView] Cupón promocional marcado como usado:', couponId);
            } catch (e) {
                console.warn('[PlansView] Error marcando cupón como usado:', e);
            }
        }
        setTimeout(() => { window.location.href = 'admin.html'; }, 3000);
    }

    container.innerHTML = `
        <div class="plans-container">
            <h2><i class="fas fa-tags"></i> Planes de suscripción</h2>
            <p class="text-muted">Selecciona el plan que mejor se adapte a tu negocio.</p>
            ${promoActiva ? `
            <div class="promo-activa" style="background:rgba(0,184,148,0.12);border:1px solid rgba(0,184,148,0.45);color:#7ff5d8;padding:12px 16px;border-radius:12px;margin:14px 0 18px;display:flex;align-items:center;gap:10px;">
                <i class="fas fa-tags" style="font-size:18px;"></i>
                <span><strong>¡Cupón 50% activado!</strong> Tu <strong>próximo cobro mensual</strong> automático será de <strong>$7.500</strong> (50% de $15.000); los siguientes meses se cobran <strong>$15.000</strong> normales.</span>
            </div>` : ''}
            ${paymentMessage}
            ${expiredBanner}
            ${pendingWhatsapp}
            ${suspendedBanner}
            <div class="plans-grid" style="display:flex; gap:20px; flex-wrap:wrap; justify-content:center;">
                ${plansVisibles.map(p => {
                    const isCurrent = currentPlan === p.key;
                    const canPay = p.key !== 'freemium' && !isCurrent;
                    return `
                    <div class="plan-card" data-plan="${p.key}" style="border:2px solid ${isCurrent ? p.color : '#dee2e6'}; border-radius:12px; padding:24px; width:280px; text-align:center; background:#fff; box-shadow:0 2px 8px rgba(0,0,0,0.1);">
                        <i class="fas ${p.icon}" style="font-size:48px; color:${p.color};"></i>
                        <h3 style="margin:12px 0 4px;">${p.name}</h3>
                        <p style="font-size:24px; font-weight:bold; color:${p.color};">
                            ${p.price}
                        </p>
                        <ul style="list-style:none; padding:0; margin:16px 0; text-align:left;">
                            <li><i class="fas fa-check text-success"></i> Catálogo de servicios</li>
                            <li><i class="fas fa-check text-success"></i> Gestión de citas</li>
                            <li><i class="fas fa-check text-success"></i> Notificaciones</li>
                            ${p.key === 'free_trial'
                                ? '<li><i class="fas fa-check text-success"></i> Sin límites por 14 días</li><li><i class="fas fa-check text-success"></i> Sin tarjeta de crédito</li>'
                                : p.key !== 'pro' && p.key !== 'premium_anual' ? '' : ''}
                            ${p.key !== 'free_trial' && p.key !== 'freemium' ? '<li><i class="fas fa-check text-success"></i> Estadísticas avanzadas</li><li><i class="fas fa-check text-success"></i> Soporte prioritario</li>' : ''}
                            ${p.key === 'premium_anual' ? '<li><i class="fas fa-check text-success"></i> <strong>Ahorras $40.000 al año</strong></li>' : ''}
                        </ul>
                        ${isCurrent
                            ? `<button class="btn btn-secondary" disabled><i class="fas fa-check-circle"></i> Plan actual</button>`
                            : p.key === 'free_trial'
                                ? `<button class="btn btn-success btn-activar-trial" data-plan="${p.key}">
                                    <i class="fas fa-flask"></i> Activar prueba gratis
                                  </button>`
                                : `<button class="btn btn-primary btn-pagar-mp" data-plan="${p.key}" data-modo="suscripcion" data-price="${p.priceValue}">
                                    <i class="fas fa-sync-alt"></i> Suscribirme (cobro automático)
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
            const modo = e.currentTarget.dataset.modo || 'suscripcion';

            // Validar: no pagar si ya tiene este plan activo
            if (plan === currentPlan) {
                mostrarToast(`Ya tienes el plan ${plan} activo`, 'warning');
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-sync-alt"></i> Suscribirme (cobro automático)';
                return;
            }

            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Procesando...';

            try {
                // El cupón 50% NO afecta el pago: la suscripción SIEMPRE es
                // $15.000/mes (o $140.000/año) con cobro automático. Si el
                // superadmin aprobó el cupón (cada 3 meses), el webhook
                // reembolsa automáticamente $7.500 de UN cobro mensual.
                if (modo === 'suscripcion') {
                    // Suscripción recurrente: cobro automático mensual/anual
                    const pref = await createMercadoPagoPreapproval({
                        plan: plan,
                        tenantId: tenantId,
                        email: userEmail,
                        nombre: userEmail,
                    });
                    redirectToMercadoPago(pref.init_point);
                } else {
                    // Pago único del mes (flujo de respaldo)
                    const pref = await createMercadoPagoPreference({
                        plan: plan,
                        tenantId: tenantId,
                        email: userEmail,
                        nombre: userEmail,
                    });

                    redirectToMercadoPago(pref.init_point || pref.sandbox_init_point);
                }
            } catch (err) {
                console.error('[MP] Error:', err);
                mostrarToast('Error al iniciar pago: ' + err.message, 'error');
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-sync-alt"></i> Suscribirme (cobro automático)';
            }
        });
    });

    // Bindeo de eventos para botones de activar trial gratis
    container.querySelectorAll('.btn-activar-trial').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const plan = 'free_trial';
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Activando...';

            try {
                // Usar SubscriptionService o crear suscripción directa
                const { crearSuscripcion } = await import('../application/SubscriptionService.js');
                await crearSuscripcion(plan, tenantId);
                mostrarToast('Prueba gratis activada con éxito!', 'success');
                setTimeout(() => { window.location.href = 'admin.html'; }, 1500);
            } catch (err) {
                console.error('[Trial] Error:', err);
                mostrarToast('Error al activar prueba: ' + err.message, 'error');
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-flask"></i> Activar prueba gratis';
            }
        });
    });
}

function getPaymentStatusMessage(status) {
    if (!status || !status.status) return '';

    const messages = {
        success: '<div class="alert alert-success"><i class="fas fa-check-circle"></i> ¡Pago exitoso! Tu suscripción se activará en segundos. Serás redirigido al panel de administración...</div>',
        failure: '<div class="alert alert-danger"><i class="fas fa-times-circle"></i> El pago fue rechazado. Intenta con otro método de pago.</div>',
        pending: '<div class="alert alert-warning"><i class="fas fa-clock"></i> El pago está pendiente. Te notificaremos cuando se confirme.</div>',
    };

    return messages[status.status] || '';
}

async function obtenerTenantId() {
    // 1. Usar JwtManager (vía window — expuesto por main.js) si está disponible
    if (window.JwtManager) {
        const userData = window.JwtManager?.getUserData?.();
        if (userData?.tenant_id) return userData.tenant_id;
    }
    // 2. Fallback: JwtManager no cargado, leer de localStorage
    try {
        const stored = localStorage.getItem('agendapro_user_data');
        if (stored) {
            const parsed = JSON.parse(stored);
            if (parsed.tenant_id) return parsed.tenant_id;
        }
    } catch (_) {}
    // 3. Fallback: función global de sesión (script.js legacy)
    try {
        if (typeof getCurrentTenantId === 'function') return await getCurrentTenantId();
        if (window.__session?.tenant_id) return window.__session.tenant_id;
    } catch {}
    return null;
}

function obtenerUserEmail() {
    // 1. Usar JwtManager si está disponible
    if (window.JwtManager) {
        const userData = window.JwtManager?.getUserData?.();
        if (userData?.email) return userData.email;
    }
    // 2. Fallback: leer de localStorage
    try {
        const stored = localStorage.getItem('agendapro_user_data');
        if (stored) {
            const parsed = JSON.parse(stored);
            if (parsed.email) return parsed.email;
        }
    } catch (_) {}
    // 3. Fallback: formato antiguo (compatibilidad)
    try {
        const jwt = JSON.parse(localStorage.getItem('supabase.auth.token') || '{}');
        return jwt?.currentSession?.user?.email || jwt?.currentSession?.user?.user_metadata?.email || '';
    } catch {
        return '';
    }
}

async function obtenerPlanActual(tenantId) {
    // Esperar a que main.js exponga la API (race condition: renderPlans
    // puede correr antes que exposeApi → api undefined → plan 'freemium')
    let api = window.__subscriptionsApi;
    for (let i = 0; i < 10 && !api?.getByTenant; i++) {
        await new Promise(r => setTimeout(r, 150));
        api = window.__subscriptionsApi;
    }
    if (!tenantId || !api?.getByTenant) return 'freemium';
    try {
        const sub = await api.getByTenant(tenantId);
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