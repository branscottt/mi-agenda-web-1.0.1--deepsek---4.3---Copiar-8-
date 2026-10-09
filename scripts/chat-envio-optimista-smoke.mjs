// scripts/chat-envio-optimista-smoke.mjs
// Smoke del ENVÍO OPTIMISTA en el cajón de Conversaciones:
//   (a) al apretar enviar, la burbuja aparece AL INSTANTE (sin esperar a WhatsApp)
//       y el campo se limpia;
//   (b) si el envío FALLA, la burbuja se quita y el texto vuelve al campo;
//   (c) si el envío OK, la burbuja queda y luego la reemplaza el hilo real.
// Uso: node scripts/chat-envio-optimista-smoke.mjs
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'node:url';

const OUT = '/tmp/chat-envio.mjs';
execFileSync('./node_modules/.bin/esbuild', [
    'src/ventas-live/ui/ConversacionesDrawer.js', '--bundle', '--format=esm',
    `--outfile=${OUT}`, '--log-level=warning'
], { stdio: 'inherit' });

const dom = new JSDOM('<!doctype html><html><body></body></html>',
    { pretendToBeVisual: true, url: 'https://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
try { Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true }); } catch (_) {}
global.HTMLElement = dom.window.HTMLElement;
global.localStorage = dom.window.localStorage;
global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const AHORA = new Date().toISOString();
const MENSAJES = [{ id: 'm1', body: 'hola', direction: 'in', tipo: 'texto', creado_en: AHORA }];
const rpc = (name) => {
    if (name === 'vl_wa_chats_listar') return Promise.resolve({ data: { ok: true, chats: [
        { id: 'c1', wa_id: '+56912345678', tiktok_user: 'ana', nombre_real: '', ultimo_mensaje: 'hola',
          ultimo_en: AHORA, no_leidos: 0, modo: 'bot', oculto: false, sin_leer: 0 }] }, error: null });
    if (name === 'vl_wa_chat_hilo') return Promise.resolve({ data: { ok: true,
        chat: { id: 'c1', modo: 'bot', cliente_id: 'k1', tiktok_user: 'ana', nombre_real: '' },
        mensajes: MENSAJES }, error: null });
    if (name === 'vl_wa_candidatos_chat') return Promise.resolve({ data: { ok: true, vinculado: true, candidatos: [] }, error: null });
    if (name === 'vl_wa_chat_proceso') return Promise.resolve({ data: { ok: true, proceso: null, tiktok_user: 'ana' }, error: null });
    if (name === 'vl_wa_chat_modo') return Promise.resolve({ data: { ok: true }, error: null });
    return Promise.resolve({ data: { ok: true }, error: null });
};
window.supabaseClient = { rpc };
// Token de sesión para que enviarMensajeManual llegue de verdad al fetch.
window.__session = { access_token: 'test-token' };

// fetch de la Edge Function: respuestas controladas por el test
let pendingResolvers = [];
window.fetch = () => new Promise((res) => { pendingResolvers.push(res); });
global.fetch = window.fetch;
const resolverFetch = (r) => { const f = pendingResolvers.shift(); if (!f) throw new Error('no había fetch pendiente'); f(r); };

const mod = await import(pathToFileURL(OUT).href);
mod.initConversacionesDrawer({});
mod.abrirConversaciones();
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
await mod.abrirChatDeUsuario('ana');
await esperar(60);

const $ = (id) => document.getElementById(id);
const checks = [];
const ok = (n, c) => checks.push([n, !!c]);
const pendiente = () => document.querySelector('#vld-hilo [data-pendiente]');
const clickEnviar = () => $('vld-enviar').dispatchEvent(new dom.window.Event('click'));
const hasta = async (cond, ms = 800) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await esperar(5); };

// ---------- (a) la burbuja aparece AL INSTANTE ----------
$('vld-input').value = 'te transfiero altiro';
clickEnviar();
ok('burbuja optimista aparece al instante', !!pendiente());
ok('dice "enviando…"', /enviando/i.test((pendiente() && pendiente().textContent) || ''));
ok('el campo se limpió de inmediato', $('vld-input').value === '');

// ---------- (b) si FALLA: se quita y se devuelve el texto ----------
await hasta(() => pendingResolvers.length > 0);
resolverFetch({ ok: false, status: 502, json: async () => ({ ok: false, error: 'WhatsApp rechazó el envío' }) });
await esperar(80);
ok('al fallar, la burbuja se quita', !pendiente());
ok('al fallar, el texto vuelve al campo', $('vld-input').value === 'te transfiero altiro');

// ---------- (c) si OK: la burbuja queda y el hilo real la reemplaza ----------
$('vld-input').value = 'ya te mando el comprobante';
clickEnviar();
ok('2ª vez: burbuja aparece al instante', !!pendiente());
await hasta(() => pendingResolvers.length > 0);
resolverFetch({ ok: true, status: 200, json: async () => ({ ok: true, mensaje: { id: 'm2', body: 'ya te mando el comprobante', creado_en: AHORA } }) });
await esperar(150);
ok('tras OK: sin burbuja pendiente (reconciliada)', !pendiente());
ok('tras OK: el campo queda vacío', $('vld-input').value === '');

let fails = 0;
for (const [n, c] of checks) { console.log((c ? '✅' : '❌') + ' ' + n); if (!c) fails++; }
console.log(`\n${checks.length - fails}/${checks.length} checks OK`);
process.exit(fails ? 1 : 0);
