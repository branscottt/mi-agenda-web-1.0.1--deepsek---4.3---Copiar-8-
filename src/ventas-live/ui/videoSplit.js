// ── Partir un video en trozos, SIN re-comprimir (calidad intacta) ────────────
// WhatsApp acepta hasta 100 MB por archivo. Antes, un video más pesado
// simplemente no se podía mandar. Ahora se PARTE en trozos que se mandan uno
// tras otro, en orden, y el cliente los ve completos.
//
// Cómo: no se re-codifica nada. Se copian los fotogramas tal cual vienen
// (mismos bytes, misma calidad) y se reconstruye el índice de cada trozo para
// que sea un MP4 válido y reproducible por sí solo. Los cortes caen SIEMPRE en
// un keyframe, así que cada trozo arranca mostrando imagen (nunca un cuadro
// roto ni una pantalla en verde).
//
// Se carga sólo cuando hace falta (import dinámico): quien no parte videos no
// descarga esta librería.
import { createFile, DataStream } from 'mp4box';

const MB = 1024 * 1024;
const BIG = DataStream.BIG_ENDIAN;

/** Tope por trozo: 85 MB deja margen bajo los 100 MB de WhatsApp. */
export const TROZO_OBJETIVO = 70 * MB;
/** Ningún trozo puede pasar de acá (100 MB es el límite de WhatsApp). */
const LIMITE_TROZO = 98 * MB;
/** Más que esto no se intenta partir (memoria del celular). */
export const TAMANO_MAX_PARTIR = 400 * MB;

/** Escribe una caja a bytes (OJO: el buffer es un getter que recorta). */
function bytesDe(caja) {
    const s = new DataStream(undefined, 0, BIG);
    caja.write(s);
    const buf = s.buffer;
    const off = s.byteOffset || 0;
    const len = s.byteLength;
    return new Uint8Array(buf).subarray(off, off + len).slice();
}

/** Run-length de una lista de valores (lo que usan stts y ctts). */
function runLength(items, valor) {
    const counts = [];
    const vals = [];
    for (const it of items) {
        const v = valor(it);
        if (vals.length && vals[vals.length - 1] === v) counts[counts.length - 1]++;
        else { vals.push(v); counts.push(1); }
    }
    return { counts, vals };
}

function nombreParte(nombreOriginal, k, total) {
    const base = String(nombreOriginal || 'video').replace(/\.[A-Za-z0-9]{2,5}$/, '') || 'video';
    return `${base}-parte-${k}-de-${total}.mp4`;
}

/**
 * Arma un trozo: mismas muestras, índice reconstruido.
 * @returns {Uint8Array} MP4 completo y válido
 */
function construirTrozo(file, info, pistas, fuente) {
    const moov = file.moov;
    const movieTs = info.timescale;

    let durMaxMovie = 0;
    const datos = pistas.map(({ id, samples }) => {
        const trak = moov.traks.find((t) => t.tkhd.track_id === id);
        const stbl = trak.mdia.minf.stbl;
        const mdhdTs = trak.mdia.mdhd.timescale;
        const total = samples.reduce((n, sm) => n + sm.size, 0);
        const durMed = samples.reduce((n, sm) => n + sm.duration, 0);
        const durMovie = Math.round(durMed * movieTs / mdhdTs);
        if (durMovie > durMaxMovie) durMaxMovie = durMovie;
        return { trak, stbl, samples, total, durMed, durMovie };
    });

    for (const d of datos) {
        const { stbl, samples } = d;
        const n = samples.length;

        // tamaños
        stbl.stsz.sample_size = 0;
        stbl.stsz.sample_count = n;
        stbl.stsz.sample_sizes = samples.map((sm) => sm.size);

        // duraciones
        const stts = runLength(samples, (sm) => sm.duration);
        stbl.stts.sample_counts = stts.counts;
        stbl.stts.sample_deltas = stts.vals;

        // cts - dts (sin esto los B-frames se ven mal)
        const deltas = samples.map((sm) => (sm.cts || 0) - (sm.dts || 0));
        if (stbl.ctts) {
            if (deltas.some((v) => v !== 0)) {
                const c = runLength(deltas, (v) => v);
                stbl.ctts.sample_counts = c.counts;
                stbl.ctts.sample_offsets = c.vals;
            } else {
                stbl.boxes = stbl.boxes.filter((b) => b.type !== 'ctts');
                delete stbl.ctts;
            }
        }

        // 1 muestra por chunk: siempre válido
        stbl.stsc.first_chunk = Array.from({ length: n }, (_, i) => i + 1);
        stbl.stsc.samples_per_chunk = Array.from({ length: n }, () => 1);
        stbl.stsc.sample_description_index = Array.from({ length: n }, () => 1);

        // keyframes del trozo (1-based)
        if (stbl.stss) {
            const syncs = [];
            samples.forEach((sm, i) => { if (sm.is_sync) syncs.push(i + 1); });
            stbl.stss.sample_numbers = syncs;
        }

        d.trak.mdia.mdhd.duration = d.durMed;
        d.trak.tkhd.duration = d.durMovie;

        // que el trozo arranque en su primer fotograma
        if (d.trak.edts && d.trak.edts.elst) {
            const p = samples[0];
            d.trak.edts.elst.entries = [{
                segment_duration: d.durMovie,
                media_time: Math.max(0, Math.round((p.cts || 0) - (p.dts || 0))),
                media_rate_integer: 1,
                media_rate_fraction: 0,
            }];
        }
        d.n = n;
    }

    moov.mvhd.duration = durMaxMovie;

    // offsets provisorios → tamaño del moov → offsets reales
    for (const d of datos) {
        d.stbl.stco.chunk_offsets = Array.from({ length: d.n }, () => 0);
        if (d.stbl.co64) {
            d.stbl.boxes = d.stbl.boxes.filter((b) => b.type !== 'co64');
            delete d.stbl.co64;
        }
    }
    // Un MOV de iPhone trae marca 'qt  ' (QuickTime): se deja como MP4 normal.
    if (String(file.ftyp.major_brand || '').startsWith('qt')) {
        file.ftyp.major_brand = 'isom';
        file.ftyp.minor_version = 512;
    }
    const ftyp = bytesDe(file.ftyp);
    let moovBytes = bytesDe(moov);
    let cursor = ftyp.length + moovBytes.length + 8;

    for (const d of datos) {
        d.base = cursor;
        cursor += d.total;
    }
    for (const d of datos) {
        let off = d.base;
        const offs = [];
        for (const sm of d.samples) { offs.push(off); off += sm.size; }
        d.stbl.stco.chunk_offsets = offs;
    }
    const moovFinal = bytesDe(moov);
    if (moovFinal.length !== moovBytes.length) {
        throw new Error('el índice del trozo no quedó estable');
    }
    moovBytes = moovFinal;

    const payload = datos.reduce((n, d) => n + d.total, 0);
    const salida = new Uint8Array(ftyp.length + moovBytes.length + 8 + payload);
    let p = 0;
    salida.set(ftyp, p); p += ftyp.length;
    salida.set(moovBytes, p); p += moovBytes.length;
    const mdatSize = 8 + payload;
    salida[p] = (mdatSize >>> 24) & 255;
    salida[p + 1] = (mdatSize >>> 16) & 255;
    salida[p + 2] = (mdatSize >>> 8) & 255;
    salida[p + 3] = mdatSize & 255;
    salida[p + 4] = 0x6d; salida[p + 5] = 0x64; salida[p + 6] = 0x61; salida[p + 7] = 0x74; // 'mdat'
    p += 8;
    for (const d of datos) {
        for (const sm of d.samples) {
            salida.set(fuente.subarray(sm.offset, sm.offset + sm.size), p);
            p += sm.size;
        }
    }
    return salida;
}

/**
 * Parte un video MP4/MOV en trozos válidos de ~objetivo bytes.
 * @param {File} archivo
 * @param {Object} o {objetivo, onProgreso}
 * @returns {Promise<{ok:boolean, partes?:Array<{archivo:File, inicio:number, fin:number, peso:number}>, error?:string}>}
 */
/** Lee y parsea el video una sola vez (lo comparten partir y recortar). */
async function abrirVideo(archivo, avisar) {
    if (!archivo) return { ok: false, error: 'No hay video' };
    if (archivo.size > TAMANO_MAX_PARTIR) {
        return {
            ok: false,
            error: `El video pesa ${(archivo.size / MB).toFixed(0)} MB. Para procesarlo hay que abrirlo en el `
                + 'teléfono y eso necesita memoria: grábalo en 1080p o recórtalo en partes más cortas.'
        };
    }
    let bytes;
    try {
        if (typeof avisar === 'function') avisar(0, 0);   // "leyendo…"
        bytes = new Uint8Array(await archivo.arrayBuffer());
    } catch (_) {
        return { ok: false, error: 'No se pudo leer el video en este dispositivo' };
    }

    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    ab.fileStart = 0;
    const file = createFile();
    let info = null;
    let errorParseo = '';
    file.onReady = (i) => { info = i; };
    file.onError = (e) => { errorParseo = (e && e.message) || 'formato no reconocido'; };
    try {
        file.appendBuffer(ab);
        file.flush();
    } catch (e) {
        return { ok: false, error: 'Este video no se pudo leer (' + ((e && e.message) || 'formato raro') + ')' };
    }
    if (errorParseo || !info || !info.videoTracks || !info.videoTracks.length) {
        return { ok: false, error: 'Este video no se pudo leer (formato no compatible con el navegador)' };
    }

    const vT = info.videoTracks[0];
    const aT = (info.audioTracks && info.audioTracks[0]) || null;
    const vTrack = file.getTrackById(vT.id);
    const aTrack = aT ? file.getTrackById(aT.id) : null;
    if (!vTrack || !vTrack.samples || !vTrack.samples.length) {
        return { ok: false, error: 'Este video no tiene fotogramas que se puedan leer' };
    }
    return { ok: true, bytes, file, info, vT, aT, vTrack, aTrack };
}

/** Arma las pistas de un tramo [i0, i1) de video, con el audio que le corresponde. */
function pistasDelTramo({ vT, aT, vTrack, aTrack }, i0, i1, durTotal) {
    const seg = vT.timescale;
    const totalMuestras = vTrack.samples.length;
    const vSamples = vTrack.samples.slice(i0, i1);
    const t0 = vSamples[0].cts / seg;
    const t1 = (i1 < totalMuestras) ? vTrack.samples[i1].cts / seg : durTotal;

    const aSamples = aTrack
        ? aTrack.samples.filter((sm) => {
            const ini = sm.cts / aT.timescale;
            const fin = (sm.cts + sm.duration) / aT.timescale;
            // incluye el frame que toca el corte: mejor 20 ms repetidos que un hueco
            return fin > t0 + 1e-6 && ini < t1 - 1e-6;
        })
        : [];

    const pistas = [{ id: vT.id, samples: vSamples }];
    if (aTrack && aSamples.length) pistas.push({ id: aT.id, samples: aSamples });
    return { pistas, t0, t1 };
}

export async function partirVideo(archivo, { objetivo = TROZO_OBJETIVO, onProgreso } = {}) {
    const avisar = (n, t) => { if (typeof onProgreso === 'function') { try { onProgreso(n, t); } catch (_) { /* opcional */ } } };
    const abierto = await abrirVideo(archivo, avisar);
    if (!abierto.ok) return abierto;
    const { bytes, file, info, vT, aT, vTrack, aTrack } = abierto;
    if (!archivo) return { ok: false, error: 'No hay video para partir' };
    const durTotal = (vT.duration || 0) / vT.timescale;

    // Cortes en keyframes, acumulando bytes hasta el objetivo.
    const totalMuestras = vTrack.samples.length;

    // El corte cae en el SIGUIENTE keyframe: hay que dejarle lugar al GOP más
    // largo o una parte podría pasarse de los 100 MB de WhatsApp.
    let gopMax = 0;
    let gop = 0;
    for (let k = 0; k < totalMuestras; k++) {
        gop += vTrack.samples[k].size;
        if (vTrack.samples[k].is_sync && k > 0) { if (gop > gopMax) gopMax = gop; gop = vTrack.samples[k].size; }
    }
    if (gop > gopMax) gopMax = gop;
    const topeParte = LIMITE_TROZO - gopMax;
    if (topeParte < 8 * MB) {
        return {
            ok: false,
            error: 'Este video tiene los keyframes demasiado separados para partirlo sin perder calidad. '
                + 'Grábalo en 1080p (o recórtalo) y se manda sin problema.'
        };
    }
    if (objetivo > topeParte) objetivo = topeParte;

    const cortes = [0];
    let i = 0;
    let acum = 0;
    while (i < totalMuestras) {
        acum += vTrack.samples[i].size;
        if (acum >= objetivo) {
            let j = i + 1;
            while (j < totalMuestras && !vTrack.samples[j].is_sync) j++;
            if (j >= totalMuestras) break;      // no quedan keyframes: no se corta más
            cortes.push(j);
            acum = 0;
            i = j;
            continue;
        }
        i++;
    }
    cortes.push(totalMuestras);
    while (cortes.length > 2 && totalMuestras - cortes[cortes.length - 2] < 8) {
        cortes.splice(cortes.length - 2, 1);    // cola de menos de 8 fotogramas
    }
    if (cortes.length < 3) {
        return { ok: false, error: 'Este video no se puede partir (tiene los keyframes muy separados)' };
    }

    const total = cortes.length - 1;
    const partes = [];
    for (let k = 0; k < total; k++) {
        avisar(k + 1, total);
        const { pistas, t0, t1 } = pistasDelTramo(
            { vT, aT, vTrack, aTrack }, cortes[k], cortes[k + 1], durTotal);
        let trozo;
        try {
            trozo = construirTrozo(file, info, pistas, bytes);
        } catch (e) {
            return { ok: false, error: 'No se pudo armar la parte ' + (k + 1) + ' del video' };
        }
        if (trozo.length > LIMITE_TROZO) {
            return { ok: false, error: 'Una parte quedó demasiado grande para WhatsApp: recorta el video o grábalo en 1080p.' };
        }
        partes.push({
            archivo: new File([trozo], nombreParte(archivo.name, k + 1, total), { type: 'video/mp4', lastModified: Date.now() }),
            inicio: t0,
            fin: t1,
            peso: trozo.length,
        });
    }
    avisar(total, total);
    return { ok: true, partes };
}

/**
 * Recorta un video entre dos tiempos, SIN recomprimir (misma calidad).
 * El corte de ENTRADA cae en el keyframe anterior más cercano (es lo que permite
 * no re-codificar); el de SALIDA es exacto. Devuelve también el tramo REAL.
 * @param {File} archivo
 * @param {Object} o {desde, hasta} en segundos
 * @returns {Promise<{ok:boolean, archivo?:File, inicio?:number, fin?:number, peso?:number, error?:string}>}
 */
export async function recortarVideo(archivo, { desde = 0, hasta = Infinity, onProgreso } = {}) {
    const avisar = (n, t) => { if (typeof onProgreso === 'function') { try { onProgreso(n, t); } catch (_) { /* opcional */ } } };
    const abierto = await abrirVideo(archivo, avisar);
    if (!abierto.ok) return abierto;
    const { bytes, file, info, vT, aT, vTrack, aTrack } = abierto;

    const seg = vT.timescale;
    const totalMuestras = vTrack.samples.length;
    const durTotal = (vT.duration || 0) / seg;
    const t0Pedido = Math.max(0, Number(desde) || 0);
    const t1Pedido = Math.min(durTotal || Number(hasta) || 0, Number(hasta) || Infinity);

    // Entrada: último keyframe que empieza en/antes del punto pedido.
    let i0 = 0;
    for (let k = 0; k < totalMuestras; k++) {
        const t = vTrack.samples[k].cts / seg;
        if (t > t0Pedido + 1e-6) break;
        if (vTrack.samples[k].is_sync) i0 = k;
    }
    // Salida: última muestra que empieza antes del punto pedido.
    let i1 = totalMuestras;
    for (let k = i0; k < totalMuestras; k++) {
        if (vTrack.samples[k].cts / seg >= t1Pedido - 1e-6) { i1 = k; break; }
    }
    if (i1 - i0 < 8) {
        return { ok: false, error: 'El tramo elegido es demasiado corto (deja al menos 1 segundo)' };
    }

    avisar(1, 1);
    const { pistas, t0, t1 } = pistasDelTramo({ vT, aT, vTrack, aTrack }, i0, i1, durTotal);
    let trozo;
    try {
        trozo = construirTrozo(file, info, pistas, bytes);
    } catch (_) {
        return { ok: false, error: 'No se pudo recortar el video en este dispositivo' };
    }
    const base = String(archivo.name || 'video').replace(/\.[A-Za-z0-9]{2,5}$/, '') || 'video';
    return {
        ok: true,
        archivo: new File([trozo], `${base}-recortado.mp4`, { type: 'video/mp4', lastModified: Date.now() }),
        inicio: t0,
        fin: t1,
        peso: trozo.length,
    };
}

/** "1:23" para mostrar en la nota del trozo. */
export function duracionCorta(seg) {
    const s = Math.max(0, Math.round(Number(seg) || 0));
    const m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
}
