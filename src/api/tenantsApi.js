// src/api/tenantsApi.js
// API unica para la tabla tenants (multi-tenant)
import { getSupabase } from '../shared/infrastructure/supabase.js';
import { trackEvent } from '../shared/infrastructure/analytics.js';

const TABLE = 'tenants';

export async function getAllTenants() {
    const { data, error } = await getSupabase()
        .from(TABLE)
        .select('id, nombre_negocio, email_contacto, telefono, plan, estado, fecha_registro, created_at')
        .order('fecha_registro', { ascending: false });
    if (error) throw error;
    return data || [];
}

export async function getTenantById(id) {
    const { data, error } = await getSupabase()
        .from(TABLE)
        .select('*')
        .eq('id', id)
        .single();
    if (error) throw error;
    return data;
}

export async function getTenantByEmail(email) {
    const { data, error } = await getSupabase()
        .from(TABLE)
        .select('id, nombre_negocio, email_contacto, plan, estado')
        .eq('email_contacto', email)
        .limit(1)
        .single();
    if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows
    return data || null;
}

export async function createTenant(data) {
    const { data: result, error } = await getSupabase()
        .from(TABLE)
        .insert(data)
        .select()
        .single();
    if (error) {
        trackEvent('tenant_created_failed', { reason: error.message });
        throw error;
    }
    trackEvent('tenant_created', { tenant_id: result?.id });
    return result;
}

export async function updateTenant(id, updates) {
    const { error } = await getSupabase()
        .from(TABLE)
        .update(updates)
        .eq('id', id);
    if (error) {
        trackEvent('tenant_updated_failed', { reason: error.message });
        throw error;
    }
    trackEvent('tenant_updated', { tenant_id: id, fields: Object.keys(updates) });
    return true;
}

export async function deleteTenant(id) {
    const { error } = await getSupabase()
        .from(TABLE)
        .delete()
        .eq('id', id);
    if (error) {
        trackEvent('tenant_deleted_failed', { reason: error.message });
        throw error;
    }
    trackEvent('tenant_deleted', { tenant_id: id });
    return true;
}