// appointments/application/AppointmentService.js
// @deprecated Usar src/api/appointmentsApi.js directamente para nuevos modulos.
// CRUD de citas - DELEGA a src/api/appointmentsApi.js (capa unica de datos)
// Se mantiene como capa de transformacion para compatibilidad con consumidores existentes:
//   - src/appointments/ui/AdminAppointmentList.js
//   - src/appointments/application/SalesService.js
//   - src/appointments/ui/ClientReservationList.js
// Mantiene transformaciones de formato (camelCase <-> snake_case) que
// los consumidores (UI) esperan, y logica adicional como getCuposDisponibles

import { getCurrentTenantId } from '../../shared/infrastructure/router.js';

let _api = null;
async function getApi() {
    if (!_api) {
        _api = await import('../../api/appointmentsApi.js');
    }
    return _api;
}

function mapToCamelCase(c) {
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

export async function getAllCitas(optionalTenantId) {
    try {
        const api = await getApi();
        const tenantId = optionalTenantId || await getCurrentTenantId();
        if (!tenantId) return [];
        const data = await api.getAllCitas(tenantId);
        return (data || []).map(mapToCamelCase);
    } catch (e) {
        console.error('Error getAllCitas:', e);
        return [];
    }
}

export async function upsertCita(cita, optionalTenantId) {
    try {
        const api = await getApi();
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
        await api.upsertCita(data);
        return true;
    } catch (e) {
        console.error('Error upsertCita:', e);
        return false;
    }
}

export async function deleteCita(citaId) {
    try {
        const api = await getApi();
        await api.deleteCita(citaId);
        return true;
    } catch (e) {
        console.error('Error deleteCita:', e);
        return false;
    }
}

export async function limpiarCitasExpiradas(optionalTenantId) {
    try {
        const api = await getApi();
        const tenantId = optionalTenantId || await getCurrentTenantId();
        if (!tenantId) return 0;
        return await api.limpiarCitasExpiradas(tenantId);
    } catch (e) {
        console.error('Error limpiarCitasExpiradas:', e);
        return 0;
    }
}

export async function getCitasPorFecha(fecha) {
    try {
        const api = await getApi();
        const tenantId = await getCurrentTenantId();
        if (!tenantId) return [];
        return await api.getCitasByDate(fecha, tenantId);
    } catch (e) {
        console.error('Error getCitasPorFecha:', e);
        return [];
    }
}

export async function getCuposDisponibles(servicioId, fecha) {
    try {
        const citas = await getCitasPorFecha(fecha);
        return citas.filter(c => c.servicio_id === servicioId).length;
    } catch (e) {
        console.error('Error getCuposDisponibles:', e);
        return 0;
    }
}