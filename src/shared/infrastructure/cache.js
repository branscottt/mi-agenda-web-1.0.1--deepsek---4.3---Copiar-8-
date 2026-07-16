// shared/infrastructure/cache.js
// Caché en memoria con TTL para peticiones a Supabase.
// Clave: `${fnName}:${JSON.stringify(args)}`
// TTL por defecto: 30 segundos.
// Se limpia automáticamente en cada escritura (create/update/delete).

const DEFAULT_TTL_MS = 30_000;
const _store = new Map();

/**
 * Obtiene un valor del caché.
 * @param {string} key
 * @returns {*|null} valor cacheado o null si no existe/expirado
 */
export function cacheGet(key) {
    const entry = _store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        _store.delete(key);
        return null;
    }
    return entry.data;
}

/**
 * Guarda un valor en el caché.
 * @param {string} key
 * @param {*} data
 * @param {number} [ttlMs=30000] tiempo de vida en ms
 */
export function cacheSet(key, data, ttlMs = DEFAULT_TTL_MS) {
    _store.set(key, { data, expiresAt: Date.now() + ttlMs });
}

/**
 * Limpia todas las entradas del caché que coincidan con un prefijo.
 * Ej: cacheClearPrefix('getAllServicios') limpia todas las variantes.
 * @param {string} prefix
 */
export function cacheClearPrefix(prefix) {
    for (const key of _store.keys()) {
        if (key.startsWith(prefix)) {
            _store.delete(key);
        }
    }
}

/**
 * Limpia TODO el caché (forzar recarga completa).
 */
export function cacheClearAll() {
    _store.clear();
}

/**
 * Helper: envuelve una función async con caché.
 * @param {string} cachePrefix identificador único del tipo de consulta
 * @param {Function} fn función async que obtiene los datos
 * @param {Array} args argumentos para fn
 * @param {number} [ttlMs] TTL opcional
 * @returns {Promise<*>}
 */
export async function cacheWrapper(cachePrefix, fn, args = [], ttlMs) {
    const cacheKey = `${cachePrefix}:${JSON.stringify(args)}`;
    const cached = cacheGet(cacheKey);
    if (cached !== null) return cached;
    const data = await fn(...args);
    cacheSet(cacheKey, data, ttlMs);
    return data;
}
