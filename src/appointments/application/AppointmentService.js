// appointments/application/AppointmentService.js
// CRUD de citas contra Supabase

import { getSupabase } from '../../shared/infrastructure/supabase.js';
import { getCurrentTenantId } from '../../shared/infrastructure/router.js';

export async function getAllCitas(optionalTenantId) {
    const tenantId = optionalTenantId || await getCurrentTenantId();
    if (!tenantId) return [];
    try {
        const { data, error } = await getSupabase()
            .from('citas')
            .select('*')
            .eq('tenant_id', String(tenantId).trim())
            .order('created_at', { ascending: false });
        if (error) throw error;
        return (data || []).map(c => ({
            id: c.id,
            servicioId: c.servicio_id,
            nombre: c.servicio_nombre || 'Servicio',
            fecha: c.fecha,
            hora: c.hora,
            precio: c.precio,
            contacto: c.contacto || {},
            notificaciones: c.notificaciones || { emailEnviado: false, whatsappEnviado: false },
            creadoEn: c.created_at
        }));
    } catch (e) {
        console.error('Error getAllCitas:', e);
        return [];
    }
}

export async function upsertCita(cita, optionalTenantId) {
    const tenantId = optionalTenantId || await getCurrentTenantId();
    if (!tenantId) throw new Error('No tenant ID');
    const data = {
        id: cita.id,
        tenant_id: String(tenantId).trim(),
        servicio_id: cita.servicioId,
        fecha: cita.fecha,
        hora: cita.hora,
        precio: cita.precio,
        contacto: cita.contacto || {},
        notificaciones: cita.notificaciones || { emailEnviado: false, whatsappEnviado: false }
    };
    const { error } = await getSupabase().from('citas').upsert(data);
    if (error) throw error;
    return true;
}

export async function deleteCita(citaId) {
    const { error } = await getSupabase().from('citas').delete().eq('id', citaId);
    if (error) throw error;
    return true;
}

export async function limpiarCitasExpiradas(optionalTenantId) {
    const tenantId = optionalTenantId || await getCurrentTenantId();
    if (!tenantId) return 0;
    const hoy = new Date().toISOString().split('T')[0];
    const { data, error } = await getSupabase()
        .from('citas')
        .delete()
        .eq('tenant_id', String(tenantId).trim())
        .lt('fecha', hoy)
        .select('id');
    if (error) throw error;
    return data?.length || 0;
}

export async function getCitasPorFecha(fecha) {
    const tenantId = await getCurrentTenantId();
    if (!tenantId) return [];
    const { data, error } = await getSupabase()
        .from('citas')
        .select('*')
        .eq('tenant_id', String(tenantId).trim())
        .eq('fecha', fecha);
    if (error) throw error;
    return data || [];
}

export async function getCuposDisponibles(servicioId, fecha) {
    const citas = await getCitasPorFecha(fecha);
    return citas.filter(c => c.servicio_id === servicioId).length;
}