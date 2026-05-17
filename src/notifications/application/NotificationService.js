// notifications/application/NotificationService.js
// Sistema de notificaciones en tiempo real para el admin
// Polling simple contra src/api/notificacionesApi.js

import { getCurrentTenantId } from '../../shared/infrastructure/router.js';
import {
    getAllNotificaciones,
    createNotificacion as apiCreateNotificacion,
    marcarComoLeida as apiMarcarLeida
} from '../../api/notificacionesApi.js';

let _pollInterval = null;
let _ultimaNotificacionId = null;
let _listeners = [];

export function suscribirseNotificaciones(fn) {
    _listeners.push(fn);
    return () => {
        _listeners = _listeners.filter(l => l !== fn);
    };
}

function emitirNotificaciones(notificaciones) {
    _listeners.forEach(fn => {
        try { fn(notificaciones); } catch(e) { console.error('Error en listener:', e); }
    });
}

export async function getNotificaciones(optionalTenantId) {
    const tenantId = optionalTenantId || await getCurrentTenantId();
    if (!tenantId) return [];
    try {
        const data = await getAllNotificaciones(tenantId);
        // Filtrar solo las nuevas
        let notis = data || [];
        if (_ultimaNotificacionId) {
            notis = notis.filter(n => String(n.id) > String(_ultimaNotificacionId));
        }
        if (notis.length) {
            _ultimaNotificacionId = notis[0].id;
        }
        // Mapear snake_case a camelCase
        return (data || []).map(n => ({
            id: n.id,
            tipo: n.tipo || 'info',
            titulo: n.titulo || n.message || '',
            mensaje: n.mensaje || n.message || '',
            leida: n.leida === true || n.leido === true,
            leido: n.leido === true || n.leida === true,
            accion: n.accion || null,
            creadoEn: n.created_at
        }));
    } catch (e) {
        console.error('Error getNotificaciones:', e);
        return [];
    }
}

export async function marcarComoLeida(notificacionId) {
    await apiMarcarLeida(notificacionId);
    return true;
}

export async function marcarTodasLeidas(optionalTenantId) {
    const tenantId = optionalTenantId || await getCurrentTenantId();
    if (!tenantId) return;
    // marcarTodasLeidas no existe en la API, hacemos getAll y marcamos una por una
    try {
        const notis = await getAllNotificaciones(tenantId);
        const noLeidas = notis.filter(n => !n.leida && !n.leido);
        for (const n of noLeidas) {
            await apiMarcarLeida(n.id);
        }
    } catch (e) {
        console.error('Error marcarTodasLeidas:', e);
    }
}

export async function crearNotificacion(notificacion, optionalTenantId) {
    const tenantId = optionalTenantId || await getCurrentTenantId();
    if (!tenantId) return;
    try {
        await apiCreateNotificacion({
            tenant_id: String(tenantId).trim(),
            tipo: notificacion.tipo || 'info',
            titulo: notificacion.titulo || '',
            mensaje: notificacion.mensaje || '',
            accion: notificacion.accion || null,
            leida: false
        });
    } catch (e) {
        console.error('Error crearNotificacion:', e);
    }
}

// --- Polling ---

export function iniciarPolling(intervaloMs = 30000) {
    detenerPolling();
    _pollInterval = setInterval(async () => {
        try {
            const nuevas = await getNotificaciones();
            if (nuevas.length) {
                emitirNotificaciones(nuevas);
            }
        } catch (e) {
            // Silencioso en polling
        }
    }, intervaloMs);
}

export function detenerPolling() {
    if (_pollInterval) {
        clearInterval(_pollInterval);
        _pollInterval = null;
    }
}

export function getNotificacionesNoLeidas(notificaciones) {
    return (notificaciones || []).filter(n => !n.leida && !n.leido);
}

// --- Auto-generacion de notificaciones ---

export function notificarNuevaCita(citaInfo) {
    crearNotificacion({
        tipo: 'success',
        titulo: 'Nueva reserva',
        mensaje: `${citaInfo.cliente || 'Cliente'} reservo ${citaInfo.servicio || 'un servicio'} para ${citaInfo.fecha || 'hoy'}`,
        accion: 'ver_cita'
    });
}

export function notificarRecordatorio(citaInfo) {
    crearNotificacion({
        tipo: 'warning',
        titulo: 'Recordatorio de cita',
        mensaje: `${citaInfo.cliente || 'Cliente'} tiene cita en ${citaInfo.tiempoRestante || '1 hora'}`,
        accion: 'ver_cita'
    });
}