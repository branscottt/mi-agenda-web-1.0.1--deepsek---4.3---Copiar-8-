// src/workers/application/WorkersService.js
// Lógica de negocio para gestión de trabajadores

import { getCurrentTenantId } from '../../shared/infrastructure/router.js';
import {
    getTrabajadores,
    getTrabajadoresActivos,
    getTrabajadorById,
    createTrabajador,
    updateTrabajador,
    deleteTrabajador
} from '../../api/trabajadoresApi.js';
import {
    getTrabajadoresByServicio,
    setTrabajadoresForServicio
} from '../../api/serviciosTrabajadoresApi.js';

export async function getAllTrabajadores(optionalTenantId) {
    const tenantId = optionalTenantId || await getCurrentTenantId();
    if (!tenantId) return [];
    try {
        return await getTrabajadores(tenantId);
    } catch (e) {
        console.error('Error getAllTrabajadores:', e);
        return [];
    }
}

export async function getTrabajadoresDisponibles(optionalTenantId) {
    const tenantId = optionalTenantId || await getCurrentTenantId();
    if (!tenantId) return [];
    try {
        return await getTrabajadoresActivos(tenantId);
    } catch (e) {
        console.error('Error getTrabajadoresDisponibles:', e);
        return [];
    }
}

export async function agregarTrabajador(data) {
    const tenantId = await getCurrentTenantId();
    if (!tenantId) throw new Error('No tenant ID');
    return await createTrabajador({
        tenant_id: String(tenantId).trim(),
        nombre: data.nombre,
        email: data.email || '',
        telefono: data.telefono || '',
        habilidades: data.habilidades || '',
        color: data.color || '#9d4edd',
        tipo_jornada: data.tipo_jornada || 'full_time',
        horario_semanal: data.horario_semanal || {},
        activo: true
    });
}

export async function editarTrabajador(id, updates) {
    return await updateTrabajador(id, updates);
}

export async function quitarTrabajador(id) {
    return await deleteTrabajador(id);
}

export async function getTrabajadoresDelServicio(servicioId) {
    try {
        return await getTrabajadoresByServicio(servicioId);
    } catch (e) {
        console.error('Error getTrabajadoresDelServicio:', e);
        return [];
    }
}

export async function asignarTrabajadoresAlServicio(servicioId, trabajadorIds) {
    return await setTrabajadoresForServicio(servicioId, trabajadorIds);
}

export function getWorkerPortalUrl(tenantId, workerId) {
    const baseUrl = window.location.origin + window.location.pathname.replace(/admin\.html.*/, 'trabajador.html');
    return `${baseUrl}?tenant=${tenantId}&id=${workerId}`;
}
