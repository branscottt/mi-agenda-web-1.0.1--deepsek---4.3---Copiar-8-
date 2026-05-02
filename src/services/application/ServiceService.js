// services/application/ServiceService.js
// CRUD de servicios contra Supabase

import { getSupabase } from '../../shared/infrastructure/supabase.js';
import { getCurrentTenantId } from '../../shared/infrastructure/router.js';

export async function getAllServicios(optionalTenantId) {
    const tenantId = optionalTenantId || await getCurrentTenantId();
    if (!tenantId) return [];
    try {
        const { data, error } = await getSupabase()
            .from('servicios')
            .select('*')
            .eq('tenant_id', String(tenantId).trim())
            .order('created_at', { ascending: false });
        if (error) throw error;
        return (data || []).map(s => ({
            id: s.id,
            nombre: s.nombre,
            categoria: s.categoria,
            precio: s.precio,
            descripcion: s.descripcion || '',
            imagen: s.imagen || 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874',
            destacado: s.destacado || false,
            activo: s.activo !== false,
            disponibilidad: s.disponibilidad || {},
            fechas: s.fechas || Object.keys(s.disponibilidad || {}),
            fechaCreacion: s.created_at
        }));
    } catch (e) {
        console.error('Error getAllServicios:', e);
        return [];
    }
}

export async function saveServicio(servicio) {
    const tenantId = await getCurrentTenantId();
    if (!tenantId) throw new Error('No tenant ID');
    const cleanTenantId = String(tenantId).trim();
    const data = {
        tenant_id: cleanTenantId,
        nombre: servicio.nombre,
        categoria: servicio.categoria,
        precio: servicio.precio,
        descripcion: servicio.descripcion || '',
        imagen: servicio.imagen,
        destacado: servicio.destacado || false,
        activo: servicio.activo !== false,
        disponibilidad: servicio.disponibilidad || {},
        fechas: Object.keys(servicio.disponibilidad || {})
    };
    let result;
    if (servicio.id) {
        result = await getSupabase().from('servicios').update(data).eq('id', servicio.id).select();
    } else {
        result = await getSupabase().from('servicios').insert(data).select();
    }
    if (result.error) throw result.error;
    return result.data?.[0] || null;
}

export async function deleteServicio(id) {
    const { error } = await getSupabase().from('servicios').delete().eq('id', id);
    if (error) throw error;
    return true;
}

export async function toggleActivoServicio(id, activo) {
    const { error } = await getSupabase().from('servicios').update({ activo }).eq('id', id);
    if (error) throw error;
    return true;
}

export function buildDisponibilidad(fechas, modules) {
    const disponibilidad = {};
    fechas.forEach(f => {
        disponibilidad[f] = modules.map(m => ({
            startTime: m.startTime,
            endTime: m.endTime,
            cupos: m.cupos ?? 10
        }));
    });
    return disponibilidad;
}

export function filtrarServiciosConFuturo(servicios) {
    const ahora = new Date();
    return (servicios || []).filter(s => {
        if (!s.disponibilidad || typeof s.disponibilidad !== 'object') return false;
        const fechas = Object.keys(s.disponibilidad).filter(f => {
            const partes = f.split('-');
            if (partes.length !== 3) return false;
            const fechaServicio = new Date(partes[0], partes[1] - 1, partes[2], 12, 0, 0);
            if (fechaServicio < new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate())) return false;
            const modulos = s.disponibilidad[f] || [];
            return modulos.some(m => {
                if (Number(m.cupos || 0) <= 0) return false;
                if (fechaServicio.toDateString() === new Date().toDateString()) {
                    const hora = m.hora || m.startTime || '00:00';
                    const hp = hora.match(/(\d{1,2}):(\d{2})/);
                    if (!hp) return true;
                    const fh = new Date();
                    fh.setHours(parseInt(hp[1]), parseInt(hp[2]), 0, 0);
                    return fh > new Date();
                }
                return true;
            });
        });
        return fechas.length > 0;
    });
}