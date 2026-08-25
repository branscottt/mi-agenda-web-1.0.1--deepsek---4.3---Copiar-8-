// src/api/appointmentsApi.js
// ÚNICA capa de acceso a datos para citas.
// Exporta funciones CRUD convergentes: nombradas por acción (getAll, create, update, delete, upsert).
// Evita duplicación: todos los consumidores deben importar desde aquí.

import { getSupabase } from '../shared/infrastructure/supabase.js';
import { cacheWrapper, cacheClearPrefix } from '../shared/infrastructure/cache.js';
import { trackEvent } from '../shared/infrastructure/analytics.js';

const TABLE = 'citas';
const CACHE_PREFIX = 'appointmentsApi';

export async function getAllCitas(tenantId) {
    if (!tenantId) return [];
    return cacheWrapper(CACHE_PREFIX, async (tid) => {
        const { data, error } = await getSupabase()
            .from(TABLE)
            .select('id, servicio_id, fecha, hora, precio, contacto, notificaciones, created_at, trabajador_id, trabajadores!left(nombre, color)')
            .eq('tenant_id', String(tid).trim())
            .order('created_at', { ascending: false });
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
    if (error) {
        trackEvent('appointment_created_failed', { reason: error.message });
        throw error;
    }
    cacheClearPrefix(CACHE_PREFIX);
    trackEvent('appointment_created', { tenant_id: data.tenant_id, servicio_id: data.servicio_id });
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
    if (error) {
        trackEvent('appointment_bulk_created_failed', { reason: error.message, count: citas.length });
        throw error;
    }
    cacheClearPrefix(CACHE_PREFIX);
    trackEvent('appointment_bulk_created', { count: data?.length || 0 });
    return data || [];
}

export async function updateCita(id, updates) {
    const { data, error } = await getSupabase()
        .from(TABLE)
        .update(updates)
        .eq('id', id)
        .select()
        .single();
    if (error) {
        trackEvent('appointment_updated_failed', { reason: error.message });
        throw error;
    }
    cacheClearPrefix(CACHE_PREFIX);
    trackEvent('appointment_updated', { id, fields: Object.keys(updates) });
    return data;
}

export async function deleteCita(id) {
    const { error } = await getSupabase()
        .from(TABLE)
        .delete()
        .eq('id', id);
    if (error) {
        trackEvent('appointment_deleted_failed', { reason: error.message });
        throw error;
    }
    cacheClearPrefix(CACHE_PREFIX);
    trackEvent('appointment_deleted', { id });
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
        .eq('fecha', fecha);
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
        .lte('fecha', fechaFin);
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

/**
 * Borra TODAS las citas del tenant (botón "Limpiar Base de Datos").
 * El trigger trg_archivar_venta conserva el histórico en `ventas`
 * para que el dashboard no pierda el acumulado.
 */
export async function deleteAllCitas(tenantId) {
    if (!tenantId) return 0;
    const { data, error } = await getSupabase()
        .from(TABLE)
        .delete()
        .eq('tenant_id', String(tenantId).trim())
        .select('id');
    if (error) throw error;
    cacheClearPrefix(CACHE_PREFIX);
    trackEvent('appointments_cleared', { tenant_id: String(tenantId).trim(), count: data?.length || 0 });
    return data?.length || 0;
}