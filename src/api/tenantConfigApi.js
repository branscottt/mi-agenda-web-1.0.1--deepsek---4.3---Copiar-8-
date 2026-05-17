// src/api/tenantConfigApi.js
// API unica para la tabla tenant_config (configuracion visual por tenant)
// Es una tabla 1:1 con tenants (tenant_id es PK)
import { getSupabase } from '../shared/infrastructure/supabase.js';

const TABLE = 'tenant_config';

export async function getConfigByTenantId(tenantId) {
    if (!tenantId) return null;
    const { data, error } = await getSupabase()
        .from(TABLE)
        .select('*')
        .eq('tenant_id', String(tenantId).trim())
        .single();
    if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows
    return data || null;
}

export async function upsertConfig(tenantId, configData) {
    const payload = { tenant_id: String(tenantId).trim(), ...configData };
    const { data, error } = await getSupabase()
        .from(TABLE)
        .upsert(payload)
        .select()
        .single();
    if (error) throw error;
    return data;
}

export async function deleteConfig(tenantId) {
    const { error } = await getSupabase()
        .from(TABLE)
        .delete()
        .eq('tenant_id', String(tenantId).trim());
    if (error) throw error;
    return true;
}