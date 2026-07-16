// src/api/appointmentsApi.js
// ÚNICA capa de acceso a datos para citas.
// Exporta funciones CRUD convergentes: nombradas por acción (getAll, create, update, delete, upsert).
// Evita duplicación: todos los consumidores deben importar desde aquí.

import { getSupabase } from '../shared/infrastructure/supabase.js';
import { cacheWrapper, cacheClearPrefix } from '../shared/infrastructure/cache.js';

const TABLE = 'citas';
const CACHE_PREFIX = 'appointmentsApi';

export async function getAllCitas(tenantId) {
    if (!tenantId) return [];
    return cacheWrapper(CACHE_PREFIX, async (tid) => {
        const { data, error } = await getSupabase()
            .from(TABLE)
            .select('id, servicio_id, fecha, hora, precio, contacto, notificaciones, created_at, trabajador_id, trabajadores!left(nombre, color)')
            .eq('tenant_id', String(tid).trim())
            .order('created_at', { ascending: false })
            .range(0, 199);
        if (error) throw error;
        return data || [];
    }, [tenantId], 15_000); // TTL más corto: 15s para citas (cambian frecuentemente)
}

export async function getCitaById(id) {
    const { data, error } = await getSupabase()
        .from(TABLE)
        .select('*')
        .eq('id', id)
        .single();
    if (error) throw error;
    return data;
}

export async function createCita(data) {
    const { data: result, error } = await getSupabase()
        .from(TABLE)
        .insert(data)
        .select()
        .single();
    if (error) throw error;
    cacheClearPrefix(CACHE_PREFIX);
    return result;
}

/**
 * Inserta multiples citas a la vez (carrito de compras).
 */
export async function createCitasBulk(citas) {
    const { data, error } = await getSupabase()
        .from(TABLE)
        .insert(citas)
        .select();
    if (error) throw error;
    cacheClearPrefix(CACHE_PREFIX);
    return data || [];
}

export async function updateCita(id, updates) {
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

export async function deleteCita(id) {
    const { error } = await getSupabase()
        .from(TABLE)
        .delete()
        .eq('id', id);
    if (error) throw error;
    cacheClearPrefix(CACHE_PREFIX);
    return true;
}

export async function upsertCita(data) {
    const { data: result, error } = await getSupabase()
        .from(TABLE)
        .upsert(data)
        .select()
        .single();
    if (error) throw error;
    cacheClearPrefix(CACHE_PREFIX);
    return result;
}

export async function getCitasByDate(fecha, tenantId) {
    if (!tenantId) return [];
    const { data, error } = await getSupabase()
        .from(TABLE)
        .select('id, servicio_id, fecha, hora, precio, contacto')
        .eq('tenant_id', String(tenantId).trim())
        .eq('fecha', fecha)
        .range(0, 199);
    if (error) throw error;
    return data || [];
}

/**
 * Obtiene citas en un rango de fechas con datos del trabajador.
 * Útil para vista de ocupación semanal/mensual.
 */
export async function getCitasByDateRange(fechaInicio, fechaFin, tenantId) {
    if (!tenantId) return [];
    const { data, error } = await getSupabase()
        .from(TABLE)
        .select('id, servicio_id, fecha, hora, trabajador_id')
        .eq('tenant_id', String(tenantId).trim())
        .gte('fecha', fechaInicio)
        .lte('fecha', fechaFin)
        .range(0, 199);
    if (error) throw error;
    return data || [];
}

export async function limpiarCitasExpiradas(tenantId) {
    if (!tenantId) return 0;
    const hoy = new Date().toISOString().split('T')[0];
    const { data, error } = await getSupabase()
        .from(TABLE)
        .delete()
        .eq('tenant_id', String(tenantId).trim())
        .lt('fecha', hoy)
        .select('id');
    if (error) throw error;
    cacheClearPrefix(CACHE_PREFIX);
    return data?.length || 0;
}