// super-admin/application/SuperAdminService.js
// Servicios exclusivos para super_admin
// Gestion global de tenants, suscripciones, estadisticas del sistema

import { getSupabase } from '../../shared/infrastructure/supabase.js';
import { getAllTenants } from '../../tenants/application/TenantService.js';
import { getAllSuscripciones } from '../../subscriptions/application/SubscriptionService.js';

export async function getSystemStats() {
    try {
        const tenants = await getAllTenants();
        const suscripciones = await getAllSuscripciones();
        const suscripcionesActivas = suscripciones.filter(s => s.estado === 'activa');

        // Contar por plan
        const porPlan = {};
        suscripcionesActivas.forEach(s => {
            porPlan[s.plan] = (porPlan[s.plan] || 0) + 1;
        });

        // Ingresos totales
        const ingresos = suscripciones
            .filter(s => s.estado !== 'cancelada')
            .reduce((sum, s) => sum + (s.monto || 0), 0);

        // Usuarios totales (de auth)
        const { data: authUsers, error: authError } = await getSupabase().auth.admin.listUsers();
        const totalUsuarios = authError ? 0 : (authUsers?.users?.length || 0);

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
    // Actualiza plan en tenant
    await getSupabase().from('tenants').update({ plan: nuevoPlan }).eq('id', tenantId);

    // Crear/actualizar suscripcion
    const { data: existing } = await getSupabase()
        .from('subscriptions')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('estado', 'activa')
        .limit(1);

    if (existing?.length) {
        await getSupabase()
            .from('subscriptions')
            .update({ plan: nuevoPlan, updated_at: new Date().toISOString() })
            .eq('id', existing[0].id);
    } else {
        await getSupabase().from('subscriptions').insert({
            tenant_id: tenantId,
            plan: nuevoPlan,
            estado: 'activa',
            fecha_inicio: new Date().toISOString()
        });
    }

    return true;
}

export async function suspenderTenant(tenantId) {
    await getSupabase().from('tenants').update({ activo: false }).eq('id', tenantId);
    await getSupabase()
        .from('subscriptions')
        .update({ status: 'suspended' })
        .eq('tenant_id', tenantId)
        .eq('status', 'active');
    return true;
}

export async function reactivarTenant(tenantId) {
    await getSupabase().from('tenants').update({ activo: true }).eq('id', tenantId);
    return true;
}

export async function getLogsSistema(limite = 100) {
    try {
        // system_logs no existe en el schema actual - retornar vacio
        return [];
    } catch (e) {
        console.error('Error getLogsSistema:', e);
        return [];
    }
}

export async function getMetricasUso(tenantId) {
    try {
        const [citas, servicios] = await Promise.all([
            getSupabase().from('citas').select('id,created_at').eq('tenant_id', tenantId),
            getSupabase().from('servicios').select('id').eq('tenant_id', tenantId)
        ]);

        return {
            totalCitas: citas.data?.length || 0,
            totalServicios: servicios.data?.length || 0
        };
    } catch (e) {
        console.error('Error getMetricasUso:', e);
        return { totalCitas: 0, totalServicios: 0 };
    }
}