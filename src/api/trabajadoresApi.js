// src/api/trabajadoresApi.js
// API de trabajadores — CRUD contra Supabase
import { cacheWrapper, cacheClearPrefix } from '../shared/infrastructure/cache.js';

const CACHE_PREFIX = 'trabajadoresApi';

export async function getTrabajadores(tenantId) {
    const supabase = window.supabaseClient;
    if (!supabase) throw new Error('Supabase client not available');
    return cacheWrapper(CACHE_PREFIX, async (tid) => {
        const { data, error } = await supabase
            .from('trabajadores')
            .select('id, tenant_id, nombre, email, telefono, color, activo, tipo_jornada, horario_semanal, horario_excepciones, horario_max_semanal, habilidades, created_at')
            .eq('tenant_id', String(tid).trim())
            .order('nombre');
        if (error) throw error;
        return data || [];
    }, [tenantId]);
}

export async function getTrabajadoresActivos(tenantId) {
    const supabase = window.supabaseClient;
    if (!supabase) throw new Error('Supabase client not available');
    return cacheWrapper(CACHE_PREFIX + '_activos', async (tid) => {
        const { data, error } = await supabase
            .from('trabajadores')
            .select('id, tenant_id, nombre, email, telefono, color, activo, tipo_jornada, horario_semanal, horario_excepciones, horario_max_semanal, habilidades, created_at')
            .eq('tenant_id', String(tid).trim())
            .eq('activo', true)
            .order('nombre');
        if (error) throw error;
        return data || [];
    }, [tenantId]);
}

export async function getTrabajadorById(id) {
    const supabase = window.supabaseClient;
    if (!supabase) throw new Error('Supabase client not available');
    const { data, error } = await supabase
        .from('trabajadores')
        .select('*')
        .eq('id', id)
        .single();
    if (error) throw error;
    return data;
}

export async function createTrabajador(trabajador) {
    const supabase = window.supabaseClient;
    if (!supabase) throw new Error('Supabase client not available');
    const { data, error } = await supabase
        .from('trabajadores')
        .insert(trabajador)
        .select()
        .single();
    if (error) throw error;
    cacheClearPrefix(CACHE_PREFIX);
    return data;
}

export async function updateTrabajador(id, updates) {
    const supabase = window.supabaseClient;
    if (!supabase) throw new Error('Supabase client not available');
    const { data, error } = await supabase
        .from('trabajadores')
        .update(updates)
        .eq('id', id)
        .select()
        .single();
    if (error) throw error;
    cacheClearPrefix(CACHE_PREFIX);
    return data;
}

export async function deleteTrabajador(id) {
    // Borrado real: ON DELETE SET NULL en citas, CASCADE en servicios_trabajadores
    const supabase = window.supabaseClient;
    if (!supabase) throw new Error('Supabase client not available');
    const { error } = await supabase
        .from('trabajadores')
        .delete()
        .eq('id', id);
    if (error) throw error;
    cacheClearPrefix(CACHE_PREFIX);
    return true;
}
