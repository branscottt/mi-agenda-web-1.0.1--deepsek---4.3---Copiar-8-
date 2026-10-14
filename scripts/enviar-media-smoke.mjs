// scripts/enviar-media-smoke.mjs
// Smoke de "mandar foto/video con comentario" desde el chat: bundlea el módulo
// REAL de chatComun, lo monta en jsdom y verifica la validación (formatos y
// límites de WhatsApp), la vista previa y el enganche del selector.
// Uso: node scripts/enviar-media-smoke.mjs
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'node:url';

const OUT = '/tmp/enviar-media-smoke.mjs';
execFileSync('./node_modules/.bin/esbuild', [
    'src/ventas-live/ui/chatComun.js', '--bundle', '--format=esm',
    `--outfile=${OUT}`, '--log-level=warning'
], { stdio: 'inherit' });

const dom = new JSDOM('<!doctype html><html><body></body></html>',
    { pretendToBeVisual: true, url: 'https://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
try { Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true }); } catch (_) {}
global.HTMLElement = dom.window.HTMLElement;
global.File = dom.window.File;
global.Event = dom.window.Event;
global.MouseEvent = dom.window.MouseEvent;

const mod = await import(pathToFileURL(OUT).href);

let ok = 0, fail = 0;
const t = (nombre, cond) => {
    if (cond) { ok++; console.log('✅', nombre); } else { fail++; console.log('❌', nombre); }
};
const archivo = (nombre, type, bytes) => new File([new Uint8Array(bytes)], nombre, { type });
const MB = 1024 * 1024;

// ── 1. Tipo de archivo ──────────────────────────────────────────────────────
t('foto → imagen', mod.tipoDeArchivo(archivo('f.jpg', 'image/jpeg', 10)) === 'imagen');
t('video → video', mod.tipoDeArchivo(archivo('v.mp4', 'video/mp4', 10)) === 'video');
t('pdf → documento (ahora se puede mandar)', mod.tipoDeArchivo(archivo('x.pdf', 'application/pdf', 10)) === 'documento');

// ── 2. Peso legible ─────────────────────────────────────────────────────────
t('peso en bytes', mod.etiquetaPeso(500) === '500 B');
t('peso en KB', mod.etiquetaPeso(2048) === '2 KB');
t('peso en MB', mod.etiquetaPeso(1.5 * MB) === '1.5 MB');

// ── 3. Validación (formatos y límites de WhatsApp) ──────────────────────────
t('foto JPG de 1 MB: se puede', mod.validarAdjunto(archivo('a.jpg', 'image/jpeg', 1 * MB)).ok);
t('foto PNG de 4.9 MB: se puede', mod.validarAdjunto(archivo('a.png', 'image/png', 4.9 * MB)).ok);
const grande = mod.validarAdjunto(archivo('a.jpg', 'image/jpeg', 5.2 * MB));
t('foto de 5.2 MB: se rechaza con el límite', !grande.ok && grande.error.includes('5 MB'));
t('video MP4 de 10 MB: se puede', mod.validarAdjunto(archivo('v.mp4', 'video/mp4', 10 * MB)).ok);
const videogrande = mod.validarAdjunto(archivo('v.mp4', 'video/mp4', 17 * MB));
t('video de 17 MB: se rechaza con el límite', !videogrande.ok && videogrande.error.includes('16 MB'));
const mov = mod.validarAdjunto(archivo('video.MOV', 'video/quicktime', 2 * MB));
t('video MOV (iPhone): dice que solo MP4', !mov.ok && mov.error.includes('MP4') && mov.error.includes('MOV'));
const heic = mod.validarAdjunto(archivo('foto.HEIC', 'image/heic', 1 * MB));
t('foto HEIC: dice que solo JPG o PNG', !heic.ok && heic.error.includes('JPG'));
const pdf = mod.validarAdjunto(archivo('doc.pdf', 'application/pdf', 1 * MB));
t('PDF: ahora SÍ se puede (se manda como archivo)', pdf.ok === true && pdf.tipo === 'documento');
const pdfGigante = mod.validarAdjunto(archivo('doc.pdf', 'application/pdf', 120 * MB));
t('PDF de 120 MB: se rechaza con el límite de 100 MB', !pdfGigante.ok && pdfGigante.error.includes('100 MB'));
const audio = mod.validarAdjunto(archivo('nota.mp3', 'audio/mpeg', 2 * MB));
t('audio MP3: se puede (16 MB)', audio.ok === true && audio.tipo === 'audio');

// ── 4. Vista previa ────────────────────────────────────────────────────────
const pImg = mod.previaAdjuntoHtml([{ id: 'a1', nombre: 'prenda.jpg', tipo: 'imagen', url: 'blob:x', peso: 900 * 1024 }]);
t('previa de foto: miniatura <img>', pImg.includes('vl-adj-mini') && pImg.includes('<img'));
t('previa de foto: nombre y peso', pImg.includes('prenda.jpg') && pImg.includes('900 KB'));
t('previa: botón para quitar', pImg.includes('vl-adj-quitar'));
const pVid = mod.previaAdjuntoHtml([{ id: 'a2', nombre: 'v.mp4', tipo: 'video', url: 'blob:y', peso: 2 * MB }]);
t('previa de video: <video muted>', pVid.includes('<video') && pVid.includes('muted'));
const pEvil = mod.previaAdjuntoHtml([{ id: 'a3', nombre: '<img src=x onerror=alert(1)>', tipo: 'imagen', url: '', peso: 1 }]);
t('previa: escapa el nombre del archivo', !pEvil.includes('<img src=x onerror') && pEvil.includes('&lt;img'));
const pTira = mod.previaAdjuntoHtml([
    { id: 'a1', nombre: 'u1.jpg', tipo: 'imagen', url: 'blob:1', peso: 1000 },
    { id: 'a2', nombre: 'u2.jpg', tipo: 'imagen', url: 'blob:2', peso: 1000 },
    { id: 'a3', nombre: 'u3.jpg', tipo: 'imagen', url: 'blob:3', peso: 1000 },
]);
t('tira de varias: una miniatura por archivo', (pTira.match(/vl-adj-item/g) || []).length === 3);
t('tira de varias: cada una con su quitar', (pTira.match(/data-quitar=/g) || []).length === 3);

// ── 5. Enganche del selector (botón, elegir, avisar, quitar) ────────────────
const cont = document.createElement('div');
cont.innerHTML = `<button id="adj" type="button">adjuntar</button>
    <input type="file" id="file">
    <div id="previa" hidden></div>`;
document.body.appendChild(cont);
let avisos = [];
const api = mod.montarAdjunto(cont, {
    btn: '#adj', input: '#file', previa: '#previa',
    alCambiar: (items, error) => avisos.push({ cuantos: Array.isArray(items) ? items.length : 0, error })
});
const btn = cont.querySelector('#adj');
const input = cont.querySelector('#file');
const previa = cont.querySelector('#previa');

let abrio = 0;
input.addEventListener('click', () => { abrio++; });
btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
t('el botón abre el selector de archivos', abrio === 1);
t('sin archivo elegido: no hay nada pendiente', api.tiene() === false);

const foto = archivo('foto.jpg', 'image/jpeg', 1 * MB);
Object.defineProperty(input, 'files', { value: [foto], configurable: true });
input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
t('al elegir una foto queda lista para mandar', api.tiene() === true && api.tipos()[0] === 'imagen');
t('el archivo guardado es el elegido', api.archivos()[0] === foto);
t('la vista previa se muestra con el nombre', previa.hidden === false && previa.textContent.includes('foto.jpg'));
t('avisa al cambiar sin error', avisos.length === 1 && avisos[0].cuantos === 1 && avisos[0].error === '');

// quitar con el botón de la previa
previa.querySelector('.vl-adj-quitar')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
t('el botón quitar suelta el archivo', api.tiene() === false && api.cuantos() === 0);
t('la previa se esconde al quitar', previa.hidden === true && previa.innerHTML === '');

// elegir un archivo que WhatsApp no acepta
const exe = archivo('virus.exe', 'application/x-msdownload', 10);
Object.defineProperty(input, 'files', { value: [exe], configurable: true });
input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
t('archivo no soportado: no queda pendiente', api.tiene() === false);
t('archivo no soportado: avisa el motivo', avisos[avisos.length - 1].error.includes('fotos, videos'));

// video válido tras el intento fallido
const video = archivo('clip.mp4', 'video/mp4', 3 * MB);
Object.defineProperty(input, 'files', { value: [video], configurable: true });
input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
t('después de un error se puede elegir un video', api.tiene() === true && api.tipos()[0] === 'video');

// ── VARIAS fotos de una (como WhatsApp) ────────────────────────────────────
const f1 = archivo('p1.jpg', 'image/jpeg', 1 * MB);
const f2 = archivo('p2.jpg', 'image/jpeg', 1 * MB);
const f3 = archivo('p3.jpg', 'image/jpeg', 1 * MB);
api.limpiar();
Object.defineProperty(input, 'files', { value: [f1, f2, f3], configurable: true });
input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
t('elegir 3 fotos juntas: las 3 quedan listas', api.cuantos() === 3 && api.archivos().length === 3);
t('los 3 son imágenes', api.tipos().every((x) => x === 'imagen'));
t('la tira muestra las 3 en orden', (previa.querySelectorAll('.vl-adj-item').length === 3)
    && previa.textContent.includes('p1.jpg') && previa.textContent.includes('p3.jpg'));

// se pueden AGREGAR más después (no reemplaza)
const f4 = archivo('p4.jpg', 'image/jpeg', 1 * MB);
Object.defineProperty(input, 'files', { value: [f4], configurable: true });
input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
t('agregar otra después SUMA (4 en total)', api.cuantos() === 4);

// quitar la del medio (la 2ª) deja las otras
const ids = api.items().map((x) => x.id);
previa.querySelector(`[data-quitar="${ids[1]}"]`)
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
t('quitar la 2ª de 4 deja 3', api.cuantos() === 3);
t('quedan p1, p3 y p4 (no la p2)', api.archivos().map((a) => a.name).join(',') === 'p1.jpg,p3.jpg,p4.jpg');
t('el quitar no dispara el click del contenedor', api.cuantos() === 3);

// mezcla: una foto y un PDF
const mixto = [archivo('m1.jpg', 'image/jpeg', 1000), archivo('m2.pdf', 'application/pdf', 1000)];
api.limpiar();
Object.defineProperty(input, 'files', { value: mixto, configurable: true });
input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
t('mezcla foto + PDF: 2 y cada uno con su tipo',
    api.cuantos() === 2 && api.tipos().join(',') === 'imagen,documento');

// una mala en el lote no bota las buenas
const lote = [archivo('ok1.jpg', 'image/jpeg', 1000), archivo('malo.exe', 'application/x-msdownload', 10), archivo('ok2.jpg', 'image/jpeg', 1000)];
api.limpiar();
Object.defineProperty(input, 'files', { value: lote, configurable: true });
input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
t('lote con un archivo malo: entran las 2 buenas', api.cuantos() === 2);
t('lote con un archivo malo: avisa el motivo', avisos[avisos.length - 1].error.includes('fotos, videos'));

// tope de archivos
api.limpiar();
const muchos = Array.from({ length: 14 }, (_, i) => archivo('n' + i + '.jpg', 'image/jpeg', 1000));
Object.defineProperty(input, 'files', { value: muchos, configurable: true });
input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
t('tope: no pasa de ' + mod.ADJUNTO_MAX, api.cuantos() === mod.ADJUNTO_MAX);

// ── 6. Robustez ────────────────────────────────────────────────────────────
t('sin contenedor: api vacío sin explotar', mod.montarAdjunto(null, {}).tiene() === false);
mod.montarAdjunto(document.createElement('div'), {});      // sin botón/input
mod.montarAdjunto(document.createElement('div'), { btn: '#nada', input: '#nada' });
t('sin botón/input no explota', true);

console.log(`\n${ok}/${ok + fail} checks OK`);
process.exit(fail ? 1 : 0);
