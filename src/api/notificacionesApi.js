// src/api/notificacionesApi.js
// API unica para la tabla notificaciones_admin (alertas del sistema)
import { getSupabase } from '../shared/infrastructure/supabase.js';

const TABLE = 'notificaciones_admin';

export async function getAllNotificaciones(tenantId) {
    if (!tenantId) return [];
    const { data, error } = await getSupabase()
        .from(TABLE)
        .select('*')
        .eq('tenant_id', String(tenantId).trim())
        .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

export async function createNotificacion(data) {
    const { data: result, error } = await getSupabase()
        .from(TABLE)
        .insert(data)
        .select()
        .single();
    if (error) throw error;
    return result;
}

export async function marcarComoLeida(id) {
    const { data, error } = await getSupabase()
        .from(TABLE)
        .update({ leida: true })
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