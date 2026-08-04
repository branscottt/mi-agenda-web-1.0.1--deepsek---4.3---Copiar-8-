// src/api/notificacionesApi.js
// API unica para la tabla notificaciones_admin (alertas del sistema)
import { getSupabase } from '../shared/infrastructure/supabase.js';

const TABLE = 'notificaciones_admin';

export async function getAllNotificaciones(tenantId) {
    if (!tenantId) return [];
    const { data, error } = await getSupabase()
        .from(TABLE)
        .select('id, tenant_id, tipo, cita_id, fecha_original, hora_original, fecha_nueva, hora_nueva, cliente, leido, creado_en, metadata')
        .eq('tenant_id', String(tenantId).trim())
        .order('creado_en', { ascending: false });
    if (error) throw error;
    return data || [];
}

export async function createNotificacion(data) {
    // El esquema real no tiene titulo/mensaje/leida: se guardan en cliente/metadata/leido
    const { data: result, error } = await getSupabase()
        .from(TABLE)
        .insert({
            tenant_id: data.tenant_id,
            tipo: data.tipo || 'info',
            cliente: data.cliente || { nombre: data.titulo || 'Notificación' },
            leido: data.leido === true || data.leida === true,
            creado_en: new Date().toISOString(),
            metadata: data.metadata || { mensaje: data.mensaje || '', accion: data.accion || null }
        })
        .select()
        .single();
    if (error) throw error;
    return result;
}

export async function marcarComoLeida(id) {
    const { data, error } = await getSupabase()
        .from(TABLE)
        .update({ leido: true })
        .eq('id', id)
        .select()
        .single();
    if (error) throw error;
    return data;
}

export async function deleteNotificacion(id) {
    const { error } = await getSupabase()
        .from(TABLE)
        .delete()
        .eq('id', id);
    if (error) throw error;
    return true;
}

export async function getUnreadCount(tenantId) {
    if (!tenantId) return 0;
    const { count, error } = await getSupabase()
        .from(TABLE)
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', String(tenantId).trim())
        .eq('leido', false);
    if (error) throw error;
    return count || 0;
}