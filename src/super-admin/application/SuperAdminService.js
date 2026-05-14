// super-admin/application/SuperAdminService.js
// Servicios exclusivos para super_admin
// Gestion global de tenants, suscripciones, estadisticas del sistema
// Consulta Supabase directamente para no depender de tenants/ ni subscriptions/.

import { getSupabase } from '../../shared/infrastructure/supabase.js';

export async function getSystemStats() {
    try {
        const supabase = getSupabase();

        const [tenantsRes, suscripcionesRes] = await Promise.all([
            supabase.from('tenants')
                .select('id, nombre_negocio, email_contacto, plan, fecha_registro, estado, activo')
                .order('fecha_registro', { ascending: false }),
            supabase.from('subscriptions')
                .select('*, tenants(nombre_negocio, email_contacto)')
                .order('created_at', { ascending: false })
        ]);

        const tenants = tenantsRes.data || [];
        const suscripciones = suscripcionesRes.data || [];

        const suscripcionesActivas = suscripciones.filter(s => s.status === 'active');
        const porPlan = {};
        suscripcionesActivas.forEach(s => {
            porPlan[s.plan] = (porPlan[s.plan] || 0) + 1;
        });

        const ingresos = suscripciones
            .filter(s => s.status !== 'canceled')
            .reduce((sum, s) => sum + (s.monto || 0), 0);

        const { data: authUsers, error: authError } = await supabase.auth.admin.listUsers();
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
    const supabase = getSupabase();
    await supabase.from('tenants').update({ plan: nuevoPlan }).eq('id', tenantId);

    const { data: existing } = await supabase
        .from('subscriptions')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('status', 'active')
        .limit(1);

    if (existing?.length) {
        await supabase
            .from('subscriptions')
            .update({ plan: nuevoPlan, updated_at: new Date().toISOString() })
            .eq('id', existing[0].id);
    } else {
        await supabase.from('subscriptions').insert({
            tenant_id: tenantId,
            plan: nuevoPlan,
            status: 'active',
            start_date: new Date().toISOString()
        });
    }

    return true;
}

export async function suspenderTenant(tenantId) {
    const supabase = getSupabase();
    await supabase.from('tenants').update({ activo: false }).eq('id', tenantId);
    await supabase
        .from('subscriptions')
        .update({ status: 'suspended' })
        .eq('tenant_id', tenantId)
        .eq('status', 'active');
    return true;
}

export async function reactivarTenant(tenantId) {
    const supabase = getSupabase();
    await supabase.from('tenants').update({ activo: true }).eq('id', tenantId);
    await supabase
        .from('subscriptions')
        .update({ status: 'active' })
        .eq('tenant_id', tenantId)
        .eq('status', 'suspended');
    return true;
}

export async function getMetricasUso(tenantId) {
    try {
        const supabase = getSupabase();
        const [citas, servicios] = await Promise.all([
            supabase.from('citas').select('id,created_at').eq('tenant_id', tenantId),
            supabase.from('servicios').select('id').eq('tenant_id', tenantId)
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

export async function getLogsSistema(limite = 100) {
    try {
        return [];
    } catch (e) {
        console.error('Error getLogsSistema:', e);
        return [];
    }
}