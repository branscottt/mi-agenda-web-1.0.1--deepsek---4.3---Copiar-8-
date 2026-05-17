// src/api/serviciosApi.js
// API unica para la tabla servicios (catalogo de servicios del negocio)
import { getSupabase } from '../shared/infrastructure/supabase.js';

const TABLE = 'servicios';

export async function getAllServicios(tenantId) {
    if (!tenantId) return [];
    const { data, error } = await getSupabase()
        .from(TABLE)
        .select('*')
        .eq('tenant_id', String(tenantId).trim());
    if (error) throw error;
    return data || [];
}

export async function getServicioById(id) {
    const { data, error } = await getSupabase()
        .from(TABLE)
        .select('*')
        .eq('id', id)
        .single();
    if (error) throw error;
    return data;
}

export async function createServicio(data) {
    const { data: result, error } = await getSupabase()
        .from(TABLE)
        .insert(data)
        .select()
        .single();
    if (error) throw error;
    return result;
}

export async function updateServicio(id, updates) {
    const { data, error } = await getSupabase()
        .from(TABLE)
        .update(updates)
        .eq('id', id)
        .select()
        .single();
    if (error) throw error;
    return data;
}

export async function deleteServicio(id) {
    const { error } = await getSupabase()
        .from(TABLE)
        .delete()
        .eq('id', id);
    if (error) throw error;
    return true;
}

export async function upsertServicio(data) {
    const { data: result, error } = await getSupabase()
        .from(TABLE)
        .upsert(data)
        .select()
        .single();
    if (error) throw error;
    return result;
}