// shared/infrastructure/cache.js
// Caché en memoria con TTL + deduplicación de peticiones en vuelo.
// Clave: `${fnName}:${JSON.stringify(args)}`
// TTL por defecto: 30 segundos.
// Se limpia automáticamente en cada escritura (create/update/delete).

const DEFAULT_TTL_MS = 30_000;
const _store = new Map();      // datos cacheados con TTL
const _pending = new Map();    // promesas en vuelo (para deduplicar)

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
 * También cancela promesas pendientes para ese prefijo.
 * Ej: cacheClearPrefix('serviciosApi') limpia todas las variantes.
 * @param {string} prefix
 */
export function cacheClearPrefix(prefix) {
    for (const key of _store.keys()) {
        if (key.startsWith(prefix)) {
            _store.delete(key);
        }
    }
    // También limpiar pending para forzar recarga real
    for (const key of _pending.keys()) {
        if (key.startsWith(prefix)) {
            _pending.delete(key);
        }
    }
}

/**
 * Limpia TODO el caché y peticiones pendientes.
 */
export function cacheClearAll() {
    _store.clear();
    _pending.clear();
}

/**
 * Helper: envuelve una función async con caché + deduplicación.
 * - Si el dato está en caché (TTL vigente), lo retorna inmediatamente.
 * - Si hay una petición en vuelo para la misma clave, la reusa.
 * - Si no, ejecuta fn, guarda en caché y retorna.
 *
 * @param {string} cachePrefix identificador único del tipo de consulta
 * @param {Function} fn función async que obtiene los datos
 * @param {Array} args argumentos para fn
 * @param {number} [ttlMs] TTL opcional
 * @returns {Promise<*>}
 */
export async function cacheWrapper(cachePrefix, fn, args = [], ttlMs) {
    const cacheKey = `${cachePrefix}:${JSON.stringify(args)}`;

    // 1. Intentar desde caché
    const cached = cacheGet(cacheKey);
    if (cached !== null) return cached;

    // 2. Si ya hay una petición en vuelo para esta misma clave, reusarla
    const inFlight = _pending.get(cacheKey);
    if (inFlight) return inFlight;

    // 3. Iniciar nueva petición y registrarla como pendiente
    const promise = fn(...args)
        .then(result => {
            cacheSet(cacheKey, result, ttlMs);
            _pending.delete(cacheKey);
            return result;
        })
        .catch(err => {
            _pending.delete(cacheKey);
            throw err;
        });

    _pending.set(cacheKey, promise);
    return promise;
}
