// notifications/application/NotificationService.js
// Sistema de notificaciones en tiempo real para el admin
// Polling simple contra tabla notificaciones_admin en Supabase

import { getSupabase } from '../../shared/infrastructure/supabase.js';
import { getCurrentTenantId } from '../../shared/infrastructure/router.js';

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
        let query = getSupabase()
            .from('notificaciones_admin')
            .select('id, tipo, cita_id, fecha_original, hora_original, fecha_nueva, hora_nueva, cliente, leido, creado_en')
            .eq('tenant_id', String(tenantId).trim())
            .order('created_at', { ascending: false })
            .limit(50);

        if (_ultimaNotificacionId) {
            query = query.gt('id', _ultimaNotificacionId);
        }

        const { data, error } = await query;
        if (error) throw error;
        if (data?.length) {
            _ultimaNotificacionId = data[0].id;
        }
        return (data || []).map(n => ({
            id: n.id,
            tipo: n.tipo || 'info',
            titulo: n.titulo || '',
            mensaje: n.mensaje || '',
            leida: n.leido || false,
            accion: n.accion || null,
            creadoEn: n.created_at
        }));
    } catch (e) {
        console.error('Error getNotificaciones:', e);
        return [];
    }
}

export async function marcarComoLeida(notificacionId) {
    const { error } = await getSupabase()
        .from('notificaciones_admin')
        .update({ leido: true })
        .eq('id', notificacionId);
    if (error) throw error;
    return true;
}

export async function marcarTodasLeidas(optionalTenantId) {
    const tenantId = optionalTenantId || await getCurrentTenantId();
    if (!tenantId) return;
    const { error } = await getSupabase()
        .from('notificaciones_admin')
        .update({ leido: true })
        .eq('tenant_id', String(tenantId).trim())
        .eq('leido', false);
    if (error) throw error;
}

export async function crearNotificacion(notificacion, optionalTenantId) {
    const tenantId = optionalTenantId || await getCurrentTenantId();
    if (!tenantId) return;
    const { error } = await getSupabase()
        .from('notificaciones_admin')
        .insert({
            tenant_id: String(tenantId).trim(),
            tipo: notificacion.tipo || 'info',
            titulo: notificacion.titulo || '',
            mensaje: notificacion.mensaje || '',
            accion: notificacion.accion || null,
            leido: false
        });
    if (error) console.error('Error crearNotificacion:', error);
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
    return (notificaciones || []).filter(n => !n.leida);
}

// --- Auto-generacion de notificaciones ---
// Se integra desde admin.html cuando se crea/confirma una cita

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