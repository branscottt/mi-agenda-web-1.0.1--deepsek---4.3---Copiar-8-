// directory/application/DirectoryService.js
// Acceso a datos del Directorio Público de PYMEs y Reseñas
// Toda la lectura pública va por RPC SECURITY DEFINER (whitelist),
// porque anon no tiene RLS sobre tenants/tenant_config/subscriptions.
import { getSupabase } from '../../shared/infrastructure/supabase.js';

/**
 * Trae las pymes del directorio público (solo campos whitelist).
 * @returns {Promise<Array>} filas con tenant_id, nombre_negocio, categoria,
 *   tipo_pyme, direccion, fotos[], logo_url, flags, promedio, total_resenas, resenas[]
 */
export async function getDirectorio() {
    const { data, error } = await getSupabase().rpc('get_directorio_pymes');
    if (error) throw error;
    return data || [];
}

/**
 * Slugs públicos de un conjunto de tenants (para URLs amigables /p/:slug).
 * @param {string[]} tenantIds
 * @returns {Promise<Record<string,string>>} mapa tenant_id → slug
 */
export async function getSlugs(tenantIds) {
    if (!Array.isArray(tenantIds) || tenantIds.length === 0) return {};
    const { data, error } = await getSupabase().rpc('get_slugs_by_ids', { p_ids: tenantIds });
    if (error) throw error;
    const mapa = {};
    (data || []).forEach(fila => { if (fila?.tenant_id && fila?.slug) mapa[fila.tenant_id] = fila.slug; });
    return mapa;
}

/**
 * Crea una reseña para una pyme (queda 'pendiente' hasta moderación).
 * @param {string} tenantId
 * @param {string} nombreCliente
 * @param {number|null} puntuacion 1-5
 * @param {string|null} comentario
 */
export async function crearResena(tenantId, nombreCliente, puntuacion, comentario) {
    const { data, error } = await getSupabase().rpc('crear_resena_pyme', {
        p_tenant_id: tenantId,
        p_nombre_cliente: nombreCliente,
        p_puntuacion: puntuacion || null,
        p_comentario: (comentario && comentario.trim()) ? comentario.trim() : null
    });
    if (error) throw error;
    return data;
}

/**
 * Reseñas del tenant actual (todas las estados, para moderación).
 * El RPC valida que el llamador sea admin del tenant o superadmin.
 */
export async function getResenasAdmin() {
    const { data, error } = await getSupabase().rpc('get_resenas_admin');
    if (error) throw error;
    return data || [];
}

/**
 * Aprueba o rechaza una reseña (admin del tenant o superadmin).
 * @param {string} resenaId
 * @param {'aprobado'|'rechazado'} estado
 */
export async function moderarResena(resenaId, estado) {
    const { data, error } = await getSupabase().rpc('moderar_resena', {
        p_resena_id: resenaId,
        p_estado: estado
    });
    if (error) throw error;
    return data;
}
