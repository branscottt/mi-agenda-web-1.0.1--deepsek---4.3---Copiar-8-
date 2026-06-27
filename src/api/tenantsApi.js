// src/api/tenantsApi.js
// API unica para la tabla tenants (multi-tenant)
import { getSupabase } from '../shared/infrastructure/supabase.js';

const TABLE = 'tenants';

export async function getAllTenants() {
    const { data, error } = await getSupabase()
        .from(TABLE)
        .select('*')
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
        .select('*')
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
    if (error) throw error;
    return result;
}

export async function updateTenant(id, updates) {
    const { error } = await getSupabase()
        .from(TABLE)
        .update(updates)
        .eq('id', id);
    if (error) throw error;
    return true;
}

export async function deleteTenant(id) {
    const { error } = await getSupabase()
        .from(TABLE)
        .delete()
        .eq('id', id);
    if (error) throw error;
    return true;
}