// super-admin/application/SuperAdminService.js
// Servicios exclusivos para super_admin
// Gestion global de tenants, suscripciones, estadisticas del sistema
// Toda la logica de datos va a traves de las APIs de dominio

import { getAllServicios } from '../../api/serviciosApi.js';
import { getAllTenants, updateTenant } from '../../api/tenantsApi.js';
import {
    getAllSubscriptions,
    createSubscription,
    updateSubscription
} from '../../api/subscriptionsApi.js';
import { getSupabase } from '../../shared/infrastructure/supabase.js';

export async function getSystemStats() {
    try {
        const supabase = getSupabase();

        const [tenants, suscripciones] = await Promise.all([
            getAllTenants(),
            getAllSubscriptions()
        ]);

        const suscripcionesActivas = suscripciones.filter(s => s.status === 'active');
        const porPlan = {};
        suscripcionesActivas.forEach(s => {
            porPlan[s.plan] = (porPlan[s.plan] || 0) + 1;
        });

        const ingresos = suscripciones
            .filter(s => s.status !== 'canceled')
            .reduce((sum, s) => sum + (s.monto || 0), 0);

        const { data: authUsers, error: authError } = await supabase.rpc('get_all_users_for_superadmin');
        const totalUsuarios = authError ? 0 : (authUsers?.length || 0);

        return {
            totalTenants: tenants.length,
            totalSuscripciones: suscripciones.length,
            suscripcionesActivas: suscripcionesActivas.length,
            distribucionPlanes: porPlan,
            ingresosTotales: ingresos,
            totalUsuarios,
            tenantsRecientes: tenants.slice(0, 10),
            suscripcionesRecientes: suscripciones.slice(0, 10)
        };
    } catch (e) {
        console.error('Error getSystemStats:', e);
        return {
            totalTenants: 0, totalSuscripciones: 0, suscripcionesActivas: 0,
            distribucionPlanes: {}, ingresosTotales: 0, totalUsuarios: 0,
            tenantsRecientes: [], suscripcionesRecientes: []
        };
    }
}

export async function actualizarPlanTenant(tenantId, nuevoPlan) {
    await updateTenant(tenantId, { plan: nuevoPlan });

    const existing = await getAllSubscriptions({ tenant_id: tenantId, status: 'active' });

    if (existing?.length) {
        await updateSubscription(existing[0].id, { plan: nuevoPlan, updated_at: new Date().toISOString() });
    } else {
        await createSubscription({
            tenant_id: tenantId,
            plan: nuevoPlan,
            status: 'active',
            start_date: new Date().toISOString()
        });
    }

    return true;
}

export async function suspenderTenant(tenantId) {
    await updateTenant(tenantId, { activo: false });

    const subs = await getAllSubscriptions({ tenant_id: tenantId, status: 'active' });
    for (const s of subs) {
        await updateSubscription(s.id, { status: 'suspended' });
    }
    return true;
}

export async function reactivarTenant(tenantId) {
    await updateTenant(tenantId, { activo: true });

    const subs = await getAllSubscriptions({ tenant_id: tenantId, status: 'suspended' });
    for (const s of subs) {
        await updateSubscription(s.id, { status: 'active' });
    }
    return true;
}

export async function getMetricasUso(tenantId) {
    try {
        const [citas, servicios] = await Promise.all([
            (await import('../../api/appointmentsApi.js')).getAllCitas(tenantId).then(d => d || []),
            getAllServicios(tenantId)
        ]);
        return {
            totalCitas: Array.isArray(citas) ? citas.length : 0,
            totalServicios: Array.isArray(servicios) ? servicios.length : 0
        };
    } catch (e) {
        console.error('Error getMetricasUso:', e);
        return { totalCitas: 0, totalServicios: 0 };
    }
}

export async function getLogsSistema(limite = 100) {
    try {
        return [];
    } catch (e) {
        console.error('Error getLogsSistema:', e);
        return [];
    }
}