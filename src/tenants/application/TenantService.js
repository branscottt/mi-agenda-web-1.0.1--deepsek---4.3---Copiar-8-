// tenants/application/TenantService.js
// CRUD de tenants (negocios) contra Supabase

import { getSupabase } from '../../shared/infrastructure/supabase.js';

export async function getAllTenants() {
    const { data, error } = await getSupabase().from('tenants').select('*').order('fecha_registro', { ascending: false });
    if (error) throw error;
    return data || [];
}

export async function getTenantByEmail(email) {
    const { data, error } = await getSupabase().from('tenants').select('*').eq('email_contacto', email).limit(1).single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

export async function saveTenant(tenant) {
    let result;
    if (tenant.id) {
        result = await getSupabase().from('tenants').update(tenant).eq('id', tenant.id).select().single();
    } else {
        result = await getSupabase().from('tenants').insert(tenant).select().single();
    }
    if (result.error) throw result.error;
    return result.data;
}

export async function deleteTenant(id) {
    const { error } = await getSupabase().from('tenants').delete().eq('id', id);
    if (error) throw error;
    return true;
}