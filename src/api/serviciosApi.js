// src/api/serviciosApi.js
// API unica para la tabla servicios (catalogo de servicios del negocio)
import { getSupabase } from '../shared/infrastructure/supabase.js';
import { cacheWrapper, cacheClearPrefix } from '../shared/infrastructure/cache.js';

const TABLE = 'servicios';
const CACHE_PREFIX = 'serviciosApi';

export async function getAllServicios(tenantId) {
    if (!tenantId) return [];
    return cacheWrapper(CACHE_PREFIX, async (tid) => {
        const { data, error } = await getSupabase()
            .from(TABLE)
            .select('id, tenant_id, nombre, descripcion, precio, duracion, imagen, activo, destacado, categoria, disponibilidad, fechas, created_at')
            .eq('tenant_id', String(tid).trim());
        if (error) throw error;
        return data || [];
    }, [tenantId]);
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
    cacheClearPrefix(CACHE_PREFIX);
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
    cacheClearPrefix(CACHE_PREFIX);
    return data;
}

export async function deleteServicio(id) {
    const { error } = await getSupabase()
        .from(TABLE)
        .delete()
        .eq('id', id);
    if (error) throw error;
    cacheClearPrefix(CACHE_PREFIX);
    return true;
}

export async function upsertServicio(data) {
    const { data: result, error } = await getSupabase()
        .from(TABLE)
        .upsert(data)
        .select()
        .single();
    if (error) throw error;
    cacheClearPrefix(CACHE_PREFIX);
    return result;
}
