// ── Preparar FOTOS y VIDEOS antes de mandarlas a WhatsApp ────────────────────
// El problema que resuelve: una foto de un celular nuevo pesa 6–10 MB y WhatsApp
// (Cloud API) sólo acepta fotos de hasta 5 MB, videos de hasta 16 MB y archivos
// de hasta 100 MB. Antes se RECHAZABA el archivo con un error de tamaño; ahora
// se PREPARA en el mismo dispositivo (celular, tablet o computador) para que
// salga siempre:
//
//   1. FOTO: se reduce en el propio navegador (canvas, lado mayor 2048 px y
//      calidad ajustada hacia abajo) hasta quedar cómoda bajo los 5 MB. A ojo no
//      se nota: 2048 px es más de lo que WhatsApp muestra en el chat.
//   2. VIDEO que pasa de 16 MB: se manda como ARCHIVO (hasta 100 MB). A WhatsApp
//      le llega igual y el cliente lo reproduce desde el mismo chat; se avisa en
//      la vista previa para que nadie se sorprenda.
//   3. VIDEO en un formato que WhatsApp no reproduce como video (MOV del iPhone,
//      WebM del navegador…): se manda como archivo.
//   4. Si el navegador no puede leer la foto (formato exótico), se deja pasar
//      tal cual y el envío avisa el motivo exacto.
//
// Nada de esto manda datos de más: la reducción es local, así que una foto de
// 9 MB se sube como 1,5 MB (más rápido en datos móviles).

const MB = 1024 * 1024;

/** Lo que acepta WhatsApp por tipo (espejo de la Edge Function wa-enviar). */
export const LIMITES_WA = {
    imagen: 5 * MB,
    video: 16 * MB,
    documento: 100 * MB,
    audio: 16 * MB
};

/** Lado mayor al que se deja una foto (px). Más que suficiente para el chat. */
export const FOTO_LADO_MAX = 2048;
/** Peso al que se apunta al reducir una foto (queda con margen bajo los 5 MB). */
export const FOTO_OBJETIVO = Math.round(1.8 * MB);

/** "350 KB" / "2.4 MB" (mismo formato que usa el chat). */
function peso(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
}

/** Extensión en minúsculas del archivo ('' si no tiene). */
function extensionDe(nombre) {
    const partes = String(nombre || '').toLowerCase().split('.');
    return partes.length > 1 ? partes.pop() : '';
}

/** Un File (o Blob con nombre) con el nombre y el tipo que se le piden. */
function comoArchivo(fuente, nombre, mime) {
    try {
        return new File([fuente], nombre, { type: mime, lastModified: Date.now() });
    } catch (_) {
        // Navegador sin constructor File (raro): se le pega el nombre al Blob.
        try {
            Object.defineProperty(fuente, 'name', { value: nombre, configurable: true });
            Object.defineProperty(fuente, 'type', { value: mime, configurable: true });
        } catch (_) { /* nada */ }
        return fuente;
    }
}

/** Mismo archivo con otra extensión (para lo que se manda como archivo). */
function conExtension(archivo, ext) {
    const base = String((archivo && archivo.name) || 'archivo');
    const limpio = base.replace(/\.[A-Za-z0-9]{2,5}$/, '');
    return comoArchivo(archivo, `${limpio || 'archivo'}.${ext}`, archivo.type || '');
}

/** Nombre .jpg para la foto ya reducida. */
function nombreJpg(archivo) {
    const base = String((archivo && archivo.name) || 'foto');
    return (base.replace(/\.[A-Za-z0-9]{2,5}$/, '') || 'foto') + '.jpg';
}

/** ¿WhatsApp lo puede mandar como VIDEO (burbuja con play)? */
export function esVideoDeWhatsApp(archivo) {
    const mime = String((archivo && archivo.type) || '').toLowerCase();
    const ext = extensionDe(archivo && archivo.name);
    if (mime === 'video/mp4' || mime === 'video/3gpp') return true;
    // Hay celulares que no declaran el tipo: manda la extensión.
    return (!mime || mime === 'application/octet-stream') && (ext === 'mp4' || ext === '3gp' || ext === '3gpp');
}

/** Lienzo de trabajo (OffscreenCanvas si está; si no, <canvas>). */
function nuevoLienzo(ancho, alto) {
    if (typeof OffscreenCanvas === 'function') {
        try { return new OffscreenCanvas(ancho, alto); } catch (_) { /* sigue abajo */ }
    }
    const c = document.createElement('canvas');
    c.width = ancho;
    c.height = alto;
    return c;
}

/** Lienzo → Blob en el formato pedido. */
function lienzoABlob(lienzo, mime, calidad) {
    if (typeof lienzo.convertToBlob === 'function') {
        return lienzo.convertToBlob({ type: mime, quality: calidad }).catch(() => null);
    }
    return new Promise((res) => {
        try { lienzo.toBlob((b) => res(b || null), mime, calidad); } catch (_) { res(null); }
    });
}

/**
 * Lee una imagen del disco/cámara a algo dibujable.
 * Devuelve {fuente, ancho, alto, limpiar} o null si el navegador no la entiende.
 */
async function abrirImagen(archivo) {
    if (typeof createImageBitmap === 'function') {
        // 'from-image' respeta la orientación EXIF: la foto de la cámara no sale girada.
        try {
            const bmp = await createImageBitmap(archivo, { imageOrientation: 'from-image' });
            return { fuente: bmp, ancho: bmp.width, alto: bmp.height, limpiar: () => { try { bmp.close(); } catch (_) {} } };
        } catch (_) { /* se prueba el camino clásico */ }
        try {
            const bmp = await createImageBitmap(archivo);
            return { fuente: bmp, ancho: bmp.width, alto: bmp.height, limpiar: () => { try { bmp.close(); } catch (_) {} } };
        } catch (_) { /* se prueba el camino clásico */ }
    }
    if (typeof document === 'undefined' || typeof Image !== 'function') return null;
    const url = URL.createObjectURL(archivo);
    try {
        const img = new Image();
        img.decoding = 'async';
        await new Promise((res, rej) => {
            img.onload = () => res();
            img.onerror = () => rej(new Error('imagen ilegible'));
            img.src = url;
        });
        const ancho = img.naturalWidth || img.width;
        const alto = img.naturalHeight || img.height;
        if (!ancho || !alto) throw new Error('imagen vacía');
        return { fuente: img, ancho, alto, limpiar: () => { try { URL.revokeObjectURL(url); } catch (_) {} } };
    } catch (_) {
        try { URL.revokeObjectURL(url); } catch (_) { /* nada */ }
        return null;
    }
}

/**
 * Reduce una foto hasta que entre en WhatsApp (JPG, lado mayor ≤ 2048 px).
 * @returns {Promise<File|null>} null si el navegador no pudo procesarla.
 */
export async function reducirFoto(archivo, { ladoMax = FOTO_LADO_MAX, objetivo = FOTO_OBJETIVO } = {}) {
    const img = await abrirImagen(archivo);
    if (!img) return null;
    let escala = Math.min(1, ladoMax / Math.max(img.ancho, img.alto));
    let menor = null;   // el JPG más liviano logrado (por si nunca baja del objetivo)
    try {
        // Tres vueltas: si con la mejor calidad todavía pesa, se achica y se repite.
        for (let vuelta = 0; vuelta < 3; vuelta++) {
            const ancho = Math.max(1, Math.round(img.ancho * escala));
            const alto = Math.max(1, Math.round(img.alto * escala));
            const lienzo = nuevoLienzo(ancho, alto);
            const ctx = lienzo.getContext && lienzo.getContext('2d');
            if (!ctx) break;
            // Fondo blanco: una PNG/HEIC con transparencia no queda con manchas negras.
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, ancho, alto);
            if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img.fuente, 0, 0, ancho, alto);

            for (const calidad of [0.9, 0.82, 0.74, 0.66, 0.58]) {
                const blob = await lienzoABlob(lienzo, 'image/jpeg', calidad);
                if (!blob || !blob.size) continue;
                if (!menor || blob.size < menor.size) menor = blob;
                if (blob.size <= objetivo) {
                    return comoArchivo(blob, nombreJpg(archivo), 'image/jpeg');
                }
            }
            escala *= 0.78;   // todavía pesa demasiado: se reduce un 22% más
        }
    } finally {
        img.limpiar();
    }
    // No llegó al objetivo pero sí entra en WhatsApp: se usa igual.
    if (menor && menor.size <= LIMITES_WA.imagen - 150 * 1024) {
        return comoArchivo(menor, nombreJpg(archivo), 'image/jpeg');
    }
    return null;
}

/**
 * Deja un archivo listo para mandar a WhatsApp, sin importar cómo venga.
 * NO rechaza por tamaño: reduce la foto, cambia el video a "archivo" o lo PARTE
 * en trozos (calidad original) cuando pasa de los 100 MB de WhatsApp.
 * @param {File} archivo
 * @param {string} tipo 'imagen' | 'video' | 'documento' | 'audio'
 * @param {Object} o {onProgreso}
 * @returns {Promise<{items: Array<{archivo:File, tipo:string, nota:string, rotulo:string}>, aviso: string}>}
 */
export async function prepararArchivo(archivo, tipo, { onProgreso } = {}) {
    const uno = (extra = {}) => ({
        items: [{ archivo, tipo, nota: '', rotulo: '', ...extra }],
        aviso: ''
    });
    const falla = (aviso) => ({ items: [], aviso });
    if (!archivo) return falla('No se eligió ningún archivo.');
    const mime = String(archivo.type || '').toLowerCase();
    const ext = extensionDe(archivo.name);
    const pesa = Number(archivo.size) || 0;

    // ── FOTO ────────────────────────────────────────────────────────────────
    if (tipo === 'imagen') {
        const yaEsJpgOPng = ['image/jpeg', 'image/jpg', 'image/png'].includes(mime);
        // Ya viene liviana y en un formato que WhatsApp acepta: no se toca (así no
        // se pierde nada de calidad al recomprimir dos veces).
        if (yaEsJpgOPng && pesa && pesa <= Math.round(1.9 * MB) && ext !== 'heic') {
            return uno();
        }
        const reducida = await reducirFoto(archivo);
        if (reducida) {
            return uno({
                archivo: reducida, tipo: 'imagen',
                nota: `Optimizada: ${peso(pesa)} → ${peso(reducida.size)}`
            });
        }
        // No se pudo reducir (formato que este navegador no sabe leer: HEIC del
        // iPhone en Chrome, AVIF viejo…).
        if (yaEsJpgOPng && pesa <= LIMITES_WA.imagen) return uno();   // igual entra
        if (pesa <= LIMITES_WA.documento) {
            // Mejor que llegue como ARCHIVO a que reviente con "formato no válido":
            // WhatsApp sólo acepta JPG/PNG como foto.
            return uno({
                tipo: 'documento',
                nota: `Va como archivo ${(ext || mime.split('/').pop() || '').toUpperCase()}: `
                    + 'este navegador no la pudo convertir a JPG. Se abre igual desde el chat.'
            });
        }
        return falla(`No se pudo reducir esta foto (${peso(pesa)}) y WhatsApp acepta hasta 5 MB. `
            + 'Prueba sacándola otra vez desde la cámara.');
    }

    // ── VIDEO ───────────────────────────────────────────────────────────────
    if (tipo === 'video') {
        const comoVideo = esVideoDeWhatsApp(archivo);
        if (comoVideo && pesa <= LIMITES_WA.video) return uno();   // caso normal: burbuja de video
        if (pesa <= LIMITES_WA.documento) {
            return uno({
                archivo: conExtension(archivo, comoVideo ? 'mp4' : (ext || 'mp4')),
                tipo: 'documento',
                nota: comoVideo
                    ? `Va como archivo (${peso(pesa)}): WhatsApp no acepta videos de más de 16 MB como video. Se reproduce igual desde el chat.`
                    : `Va como archivo (${peso(pesa)}): formato ${(ext || mime || 'desconocido').toUpperCase()} no se manda como video, pero llega igual.`
            });
        }
        // Más de 100 MB: se PARTE en trozos copiando los fotogramas (sin
        // recomprimir) y se mandan en orden. El cliente los ve todos.
        let mod = null;
        try {
            mod = await import('./videoSplit.js');
        } catch (_) {
            return falla('No se pudo cargar el partidor de video en este dispositivo. '
                + 'Revisa la conexión e intenta de nuevo (o manda el video más corto).');
        }
        const res = await mod.partirVideo(archivo, { onProgreso });
        if (!res.ok || !res.partes || !res.partes.length) {
            return falla(res.error || 'No se pudo partir el video para mandarlo');
        }
        const n = res.partes.length;
        return {
            items: res.partes.map((p, k) => ({
                archivo: p.archivo,
                tipo: 'documento',
                // El rótulo "Parte k/n" y el peso ya se ven en el chip: acá sólo el tramo.
                nota: `${mod.duracionCorta(p.inicio)}–${mod.duracionCorta(p.fin)}`,
                rotulo: `Parte ${k + 1}/${n}`,
            })),
            aviso: ''
        };
    }

    // ── ARCHIVO / AUDIO ─────────────────────────────────────────────────────
    const limite = LIMITES_WA[tipo] || LIMITES_WA.documento;
    if (pesa > limite) {
        return falla(`Pesa ${peso(pesa)} y WhatsApp acepta hasta ${Math.round(limite / MB)} MB. `
            + 'Divídelo o comprímalo antes de mandarlo.');
    }
    return uno();
}
