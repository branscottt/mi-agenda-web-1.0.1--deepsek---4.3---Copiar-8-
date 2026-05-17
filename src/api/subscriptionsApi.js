// src/api/subscriptionsApi.js
// API unica para la tabla subscriptions (planes de suscripcion)
import { getSupabase } from '../shared/infrastructure/supabase.js';

const TABLE = 'subscriptions';

export async function getAllSubscriptions() {
    const { data, error } = await getSupabase()
        .from(TABLE)
        .select('*')
        .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

export async function getSubscriptionById(id) {
    const { data, error } = await getSupabase()
        .from(TABLE)
        .select('*')
        .eq('id', id)
        .single();
    if (error) throw error;
    return data;
}

export async function getActiveSubscriptionByTenantId(tenantId) {
    if (!tenantId) return null;
    const { data, error } = await getSupabase()
        .from(TABLE)
        .select('*')
        .eq('tenant_id', String(tenantId).trim())
        .eq('status', 'active')
        .order('start_date', { ascending: false })
        .limit(1);
    if (error) throw error;
    return data?.[0] || null;
}

export async function createSubscription(data) {
    const { data: result, error } = await getSupabase()
        .from(TABLE)
        .insert(data)
        .select()
        .single();
    if (error) throw error;
    return result;
}

export async function updateSubscription(id, updates) {
    const { data, error } = await getSupabase()
        .from(TABLE)
        .update(updates)
        .eq('id', id)
        .select()
        .single();
    if (error) throw error;
    return data;
}

export async function cancelSubscription(id) {
    const { data, error } = await getSupabase()
        .from(TABLE)
        .update({ status: 'inactive', end_date: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
    if (error) throw error;
    return data;
}

export async function deleteSubscription(id) {
    const { error } = await getSupabase()
        .from(TABLE)
        .delete()
        .eq('id', id);
    if (error) throw error;
    return true;
}