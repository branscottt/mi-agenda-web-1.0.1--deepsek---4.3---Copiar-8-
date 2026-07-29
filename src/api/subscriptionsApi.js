// src/api/subscriptionsApi.js
// API unica para la tabla subscriptions (planes de suscripcion)
import { getSupabase } from '../shared/infrastructure/supabase.js';

const TABLE = 'subscriptions';

export async function getAllSubscriptions() {
    const { data, error } = await getSupabase()
        .from(TABLE)
        .select('id, tenant_id, plan, status, start_date, end_date, monto, created_at')
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
        .select('id, tenant_id, plan, status, start_date, end_date, monto')
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

/**
 * Busca suscripciones por filtros dinamicos.
 * Ej: getSubscriptionsByFilter({ tenant_id: 'xxx', status: 'active' })
 */
export async function getSubscriptionsByFilter(filters) {
    let query = getSupabase().from(TABLE).select('id, tenant_id, plan, status, start_date, end_date, monto, created_at');
    for (const [key, val] of Object.entries(filters)) {
        if (val !== undefined && val !== null) {
            query = query.eq(key, val);
        }
    }
    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

// ============================================================
// PROMO VIDEO COUPONS — Cupón 50% descuento por video promocional
// ============================================================

const PROMO_TABLE = 'promo_video_coupons';

/**
 * Verifica si el tenant puede usar un cupón promocional.
 * Llama a la RPC can_use_promo_coupon en Supabase.
 */
export async function checkPromoCouponStatus(tenantId) {
    if (!tenantId) return { can_use: false, current_period: null };
    const { data, error } = await getSupabase()
        .rpc('can_use_promo_coupon', { p_tenant_id: tenantId });
    if (error) {
        console.warn('[PromoCoupon] Error checking status:', error);
        return { can_use: false, current_period: null, error: error.message };
    }
    return data || { can_use: false, current_period: null };
}

/**
 * Crea una nueva solicitud de cupón promocional
 */
export async function createPromoCoupon({ tenantId, videoUrl, businessDescription, couponPeriod }) {
    const { data, error } = await getSupabase()
        .from(PROMO_TABLE)
        .insert({
            tenant_id: tenantId,
            video_url: videoUrl,
            business_description: businessDescription,
            coupon_period: couponPeriod,
            status: 'pending'
        })
        .select()
        .single();
    if (error) throw error;
    return data;
}

/**
 * Obtiene todas las solicitudes de cupón (para superadmin)
 */
export async function getAllPromoCoupons() {
    const { data, error } = await getSupabase()
        .from(PROMO_TABLE)
        .select('*, tenants!inner(nombre_negocio, email_contacto, plan)')
        .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

/**
 * Actualiza el estado de un cupón (superadmin: approve/reject)
 */
export async function updatePromoCouponStatus(id, { status, adminComment }) {
    const updates = { status };
    if (adminComment !== undefined) updates.admin_comment = adminComment;
    const { data, error } = await getSupabase()
        .from(PROMO_TABLE)
        .update(updates)
        .eq('id', id)
        .select()
        .single();
    if (error) throw error;
    return data;
}

/**
 * Marca un cupón como usado (descuento aplicado al siguiente pago)
 */
export async function markPromoCouponUsed(id) {
    const { data, error } = await getSupabase()
        .from(PROMO_TABLE)
        .update({ discount_applied: true, used_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
    if (error) throw error;
    return data;
}
