// clients/ui/matchArchivos.js
// Criterio ÚNICO de emparejamiento archivo → cliente, compartido por el
// Centro de Mudanza, la bandeja "Sin cliente" y (en espejo) el motor SQL
// public._huerfanos_reconciliar de la migración 20261032.
// Si tocás el puntaje acá, tocalo allá: el front sugiere y el SQL decide.

/** Normaliza: minúsculas, sin acentos, solo [a-z0-9]. */
export function normalizar(s) {
    return String(s || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '')
        .trim();
}

/** Extensiones aceptadas (red de seguridad cuando el navegador no da MIME). */
export const EXT_ACEPTADAS = [
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'pdf',
    'doc', 'docx', 'rtf', 'odt', 'xls', 'xlsx', 'ods', 'csv',
    'ppt', 'pptx', 'txt', 'zip'
];

export const MIME_ACEPTADOS = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/rtf',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain', 'text/csv',
    'application/zip'
];

export function extensionDe(nombre) {
    const m = String(nombre || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
}

/**
 * Acepta el archivo por MIME o, si el MIME no es concluyente (vacío o
 * octet-stream, típico en celular/Drive), por extensión. Sin esto, subir
 * varios archivos juntos "descartaba" varios en silencio.
 */
export function esArchivoAceptado(file) {
    const tipo = String((file && file.type) || '').toLowerCase();
    if (MIME_ACEPTADOS.includes(tipo)) return true;
    if (!tipo || tipo === 'application/octet-stream') {
        return EXT_ACEPTADAS.includes(extensionDe(file && file.name));
    }
    return false;
}

/** Atributo accept del <input type="file"> con MIME + extensiones. */
export function acceptAttr() {
    return MIME_ACEPTADOS.join(',') + ',' + EXT_ACEPTADAS.map(e => '.' + e).join(',');
}

/**
 * Puntúa por ESPECIFICIDAD (mismo criterio que el motor SQL):
 *   1000 = nombre del cliente idéntico a la pista
 *    900 = teléfono del nombre del archivo coincide con el del cliente
 *    100 = el nombre del cliente encabeza la pista
 *     50 = el nombre del cliente aparece dentro de la pista
 *     40 = el correo del cliente aparece dentro de la pista
 * Devuelve { email, ambiguo, candidatos, nombresTop }.
 * - email: cliente elegido SOLO si el mejor puntaje es de un único cliente.
 * - ambiguo: true cuando 2+ clientes empatan (dos "Camila") → lo decide el admin.
 */
export function evaluarMatch(nombreArchivo, clientes) {
    const pista = normalizar(String(nombreArchivo || '').replace(/\.[^.]+$/, ''));
    if (!pista) return { email: null, ambiguo: false, candidatos: [], nombresTop: [] };
    const puntuados = [];
    (clientes || []).forEach(c => {
        if (!c || !c.email) return;
        const pnom = normalizar(c.nombre);
        const ptel = String(c.telefono || '').replace(/\D/g, '');
        const emailStr = String(c.email || '');
        const pebox = emailStr.toLowerCase().includes('@sinemail.local') ? '' : normalizar(emailStr.split('@')[0]);
        let sc = 0;
        if (ptel.length >= 6 && pista.includes(ptel)) sc = Math.max(sc, 900 + ptel.length);
        if (pnom && pnom === pista) sc = Math.max(sc, 1000);
        if (pnom.length >= 3 && pista.startsWith(pnom)) sc = Math.max(sc, 100 + pnom.length);
        if (pnom.length >= 4 && pista.includes(pnom)) sc = Math.max(sc, 50 + pnom.length);
        if (pebox.length >= 4 && pista.includes(pebox)) sc = Math.max(sc, 40 + pebox.length);
        if (sc > 0) puntuados.push({ email: c.email, nombre: c.nombre || '', sc });
    });
    if (!puntuados.length) return { email: null, ambiguo: false, candidatos: [], nombresTop: [] };
    const mejor = Math.max(...puntuados.map(p => p.sc));
    const top = puntuados.filter(p => p.sc === mejor);
    const emails = [...new Set(top.map(t => t.email))];
    const nombresTop = [...new Set(top.map(t => t.nombre))];
    if (emails.length === 1) return { email: emails[0], ambiguo: false, candidatos: puntuados, nombresTop };
    return { email: null, ambiguo: true, candidatos: puntuados, nombresTop };
}
