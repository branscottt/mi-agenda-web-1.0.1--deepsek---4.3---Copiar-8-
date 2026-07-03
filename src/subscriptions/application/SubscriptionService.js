// subscriptions/application/SubscriptionService.js
// Gestion de suscripciones/planes de los tenants
// Delega a src/api/subscriptionsApi.js y src/api/tenantsApi.js

import { getCurrentTenantId } from '../../shared/infrastructure/router.js';
import { PLANES } from '../../shared/domain/constants.js';
import {
    getActiveSubscriptionByTenantId,
    createSubscription,
    cancelSubscription as apiCancelSubscription,
    getAllSubscriptions as apiGetAll,
    getSubscriptionsByFilter
} from '../../api/subscriptionsApi.js';
import { updateTenant } from '../../api/tenantsApi.js';

export async function getSuscripcionActual(optionalTenantId) {
    const tenantId = optionalTenantId || await getCurrentTenantId();
    if (!tenantId) return null;
    try {
        const data = await getActiveSubscriptionByTenantId(tenantId);
        return data ? normalizarSuscripcion(data) : null;
    } catch (e) {
        console.error('Error getSuscripcionActual:', e);
        return null;
    }
}

function normalizarSuscripcion(s) {
    return {
        id: s.id,
        tenant_id: s.tenant_id,
        plan: s.plan,
        estado: s.status || 'inactive',
        fecha_inicio: s.start_date || s.created_at,
        fecha_fin: s.end_date || null,
        monto: s.monto || 0,
        created_at: s.created_at
    };
}

export async function crearSuscripcion(plan, tenantId, periodoMeses = null) {
    if (!tenantId) throw new Error('tenantId requerido');
    if (!PLANES[plan]) throw new Error('Plan invalido: ' + plan);

    const infoPlan = PLANES[plan];
    const duracion = periodoMeses || infoPlan.duracionMeses || null;
    const inicio = new Date().toISOString();
    const fin = duracion ? new Date(Date.now() + duracion * 30 * 24 * 60 * 60 * 1000).toISOString() : null;

    const data = await createSubscription({
        tenant_id: String(tenantId).trim(),
        plan: plan,
        status: 'active',
        start_date: inicio,
        end_date: fin,
        monto: infoPlan.precio === 'Gratis' ? 0 : parseInt(String(infoPlan.precio).replace(/[^0-9]/g, '')) || 0
    });

    await updateTenant(tenantId, { plan });

    return data ? normalizarSuscripcion(data) : null;
}

export async function cancelarSuscripcion(subscriptionId) {
    await apiCancelSubscription(subscriptionId);
    return true;
}

export async function getAllSuscripciones() {
    try {
        // Nota: getAllSubscriptions no hace join con tenants.
        // Si en el futuro se necesita el nombre del negocio, se puede añadir
        // un campo 'negocio' adicional o hacer un segundo llamado a tenantsApi.
        // Por ahora devolvemos los datos planos sin join.
        const data = await apiGetAll();
        return (data || []).map(s => ({
            id: s.id,
            tenantId: s.tenant_id,
            negocio: 'N/A', // join removido; se puede resolver con getTenantById si es necesario
            email: '',
            plan: s.plan,
            estado: s.status || 'inactive',
            fechaInicio: s.start_date,
            fechaFin: s.end_date,
            monto: s.monto,
            creadoEn: s.created_at
        }));
    } catch (e) {
        console.error('Error getAllSuscripciones:', e);
        return [];
    }
}

export function getInfoPlan(planKey) {
    return PLANES[planKey] || null;
}

export function planesDisponibles() {
    return Object.entries(PLANES)
        .filter(([_, p]) => !p.soloSuperAdmin)
        .map(([key, val]) => ({ key, ...val }));
}

export async function actualizarPlan(tenantId, nuevoPlan) {
    if (!PLANES[nuevoPlan]) throw new Error('Plan invalido');
    await updateTenant(tenantId, { plan: nuevoPlan });
    return crearSuscripcion(nuevoPlan, tenantId);
}

export async function tieneAccesoPremium() {
    const sub = await getSuscripcionActual();
    if (!sub) return false;
    if (sub.estado !== 'active') return false;
    if (sub.fecha_fin && new Date(sub.fecha_fin) < new Date()) return false;
    return sub.plan === 'pro' || sub.plan === 'premium_anual' || sub.plan === 'free_trial';
}