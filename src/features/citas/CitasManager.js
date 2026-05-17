// src/features/citas/CitasManager.js
// CitasManager extraido de script.js - gestion de citas del lado admin
// Mantiene transformacion camelCase que los templates HTML esperan
// Delega a src/api/appointmentsApi.js para la capa unica de datos

import { createCita, updateCita, deleteCita, getAllCitas, upsertCita, limpiarCitasExpiradas, getCitasByDate } from '../../api/appointmentsApi.js';
import { getCurrentTenantId } from '../../shared/infrastructure/router.js';

function mapCitaToCamelCase(c) {
    return {
        id: c.id,
        servicioId: c.servicio_id,
        nombre: 'Servicio',
        fecha: c.fecha,
        hora: c.hora,
        precio: c.precio,
        contacto: c.contacto || {},
        notificaciones: c.notificaciones || { emailEnviado: false, whatsappEnviado: false },
        creadoEn: c.created_at
    };
}

function toSnakeCase(cita) {
    return {
        id: cita.id,
        servicio_id: cita.servicioId,
        fecha: cita.fecha,
        hora: cita.hora,
        precio: cita.precio,
        contacto: cita.contacto || {},
        notificaciones: cita.notificaciones || { emailEnviado: false, whatsappEnviado: false }
    };
}

export async function getAll(optionalTenantId) {
    const tenantId = optionalTenantId || await getCurrentTenantId();
    if (!tenantId) return [];
    const data = await getAllCitas(tenantId);
    return (data || []).map(mapCitaToCamelCase);
}

export async function upsert(cita, optionalTenantId) {
    const tenantId = optionalTenantId || await getCurrentTenantId();
    if (!tenantId) throw new Error('No tenant ID');
    const data = {
        id: cita.id,
        tenant_id: String(tenantId).trim(),
        ...toSnakeCase(cita)
    };
    await upsertCita(data);
    return true;
}

export async function del(citaId) {
    await deleteCita(citaId);
    return true;
}

export async function limpiarExpiradas() {
    const tenantId = await getCurrentTenantId();
    if (!tenantId) return 0;
    return await limpiarCitasExpiradas(tenantId);
}

export async function finalizar(citaId) {
    return del(citaId);
}

export async function getCitasPorFecha(fecha) {
    const tenantId = await getCurrentTenantId();
    if (!tenantId) return [];
    return await getCitasByDate(fecha, tenantId);
}

// Compatibilidad con script.js legacy
window.__CitasManagerModular = {
    getAll, upsert, delete: del,
    limpiarExpiradas, finalizar, getCitasPorFecha
};