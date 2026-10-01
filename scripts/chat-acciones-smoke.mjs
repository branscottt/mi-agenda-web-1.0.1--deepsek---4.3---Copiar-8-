// scripts/chat-acciones-smoke.mjs
// Smoke de las mejoras pedidas tras la prueba real en Umbralis:
//   (a) botones de proceso DENTRO del chat (confirmar pago / decidir entrega /
//       envío creado / marcar entregado / liberar) según el estado del proceso;
//   (b) alarma al llegar mensajes: el título de la pestaña queda con "● (n)";
//   (c) el cajón sigue pintando el hilo y el chip de "quién contesta".
// Uso: node scripts/chat-acciones-smoke.mjs
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'node:url';

const OUT = '/tmp/chat-acciones.mjs';
execFileSync('./node_modules/.bin/esbuild', [
    'src/ventas-live/ui/ConversacionesDrawer.js', '--bundle', '--format=esm',
    `--outfile=${OUT}`, '--log-level=warning'
], { stdio: 'inherit' });

const dom = new JSDOM(
    '<!doctype html><html><head><title>Ventas Live — Organify</title></head>' +
    '<body><div class="vl-topbar"></div><div id="vl-view-live" class="active"></div></body></html>',
    { pretendToBeVisual: true, url: 'https://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
try { Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true }); } catch (_) {}
global.HTMLElement = dom.window.HTMLElement;
global.localStorage = dom.window.localStorage;
global.Notification = dom.window.Notification;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

// ---- estado del stub (se cambia entre casos) ----
let CHAT = {
    id: 'c1', wa_id: '+56 9 0000 0001', estado: 'listo', modo: 'bot', oculto: false,
    ultimo_mensaje: 'voy subiendo', ultimo_en: new Date().toISOString(),
    ultimo_dir: 'in', ultimo_origen: '', sin_leer: 0,
    tiktok_user: 'anubisss', nombre_real: 'Anubis', categoria: 'nuevo',
    tiene_aviso: false, aviso_tipo: '', aviso_detalle: '', proceso: null
};
let PROC = { proceso_id: 'p1', estado: 'pagado', saldo: 0, prendas: 2, puntos: {} };

const rpc = (name) => {
    if (name === 'vl_wa_chats_listar') return Promise.resolve({ data: { ok: true, chats: [CHAT] }, error: null });
    if (name === 'vl_wa_chat_hilo') return Promise.resolve({ data: { ok: true, chat: CHAT, mensajes: [] }, error: null });
    if (name === 'vl_wa_chat_proceso') {
        return Promise.resolve({ data: { ok: true, proceso: PROC, tiktok_user: 'anubisss' }, error: null });
    }
    return Promise.resolve({ data: { ok: true }, error: null });
};
window.supabaseClient = { rpc };

const mod = await import(pathToFileURL(OUT).href);
mod.initConversacionesDrawer({ onBadge: () => {} });

const $ = (id) => document.getElementById(id);
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
const checks = [];
const ok = (n, c) => checks.push([n, !!c]);
const accs = () => Array.from(document.querySelectorAll('#vl-acc-chat button[data-acc]')).map(b => b.dataset.acc);

// ---------- 1) estado 'pagado' sin saldo -> decidir entrega ----------
mod.abrirConversaciones();
await esperar(40);
await mod.abrirChatDeUsuario('anubisss');
await esperar(80);
ok('hay fila de acciones en el chat', !!$('vl-acc-chat'));
ok('pagado + saldo 0 muestra "Decidir entrega"', accs().indexOf('entrega') >= 0);
ok('no muestra "Marcar entregado" todavía', accs().indexOf('entregado') < 0);

// ---------- 2) clic en el botón abre el modal correcto ----------
const btnEntrega = document.querySelector('#vl-acc-chat button[data-acc="entrega"]');
ok('existe el botón de decidir entrega', !!btnEntrega);
if (btnEntrega) btnEntrega.dispatchEvent(new dom.window.Event('click'));
await esperar(60);
const modalTxt = (document.body.textContent || '');
ok('el clic abre el modal de entrega', /Decisión de entrega/i.test(modalTxt));

// ---------- 3) en entrega presencial -> marcar entregado ----------
mod.cerrarConversaciones();
CHAT = Object.assign({}, CHAT);
PROC = { proceso_id: 'p1', estado: 'entrega_presencial', saldo: 0, prendas: 2, puntos: {} };
mod.abrirConversaciones();
await esperar(40);
await mod.abrirChatDeUsuario('anubisss');
await esperar(80);
ok('entrega_presencial muestra "Marcar entregado"', accs().indexOf('entregado') >= 0);
const btnEnt = document.querySelector('#vl-acc-chat button[data-acc="entregado"]');
ok('existe el botón de marcar entregado', !!btnEnt);
if (btnEnt) btnEnt.dispatchEvent(new dom.window.Event('click'));
await esperar(60);
ok('el clic abre el modal de entregado',
    /Marcar entregado/i.test(document.body.textContent || '') &&
    !!document.getElementById('vg-ok'));

// ---------- 4) con deuda -> confirmar pago + liberar ----------
mod.cerrarConversaciones();
PROC = { proceso_id: 'p1', estado: 'esperando_pago', saldo: 9000, prendas: 1, puntos: {} };
mod.abrirConversaciones();
await esperar(40);
await mod.abrirChatDeUsuario('anubisss');
await esperar(80);
ok('con saldo muestra "Confirmar pago"', accs().indexOf('pago') >= 0);
ok('con saldo muestra "Liberar"', accs().indexOf('liberar') >= 0);
ok('con saldo NO muestra "Marcar entregado"', accs().indexOf('entregado') < 0);

// ---------- 5) alarma: el título queda con "● (n)" ----------
document.title = 'Ventas Live — Organify';
mod.cerrarConversaciones();
CHAT = Object.assign({}, CHAT, { sin_leer: 3 });
mod.refrescarContador();                     // primera carga: registra sin alarmar
await esperar(80);
CHAT = Object.assign({}, CHAT, { sin_leer: 5 });
mod.refrescarContador();                     // sube el contador -> alarma
await esperar(80);
ok('el título avisa "● (n)" cuando suben los no leídos', /^● \(\d+\)/.test(document.title));

// ---------- 6) al abrir el cajón, el título se limpia ----------
mod.abrirConversaciones();
await esperar(40);
ok('al abrir conversaciones se limpia el título', !/^● \(/.test(document.title));

// ---------- 7) sin proceso: no hay botones (nada que hacer) ----------
mod.cerrarConversaciones();
PROC = null;
mod.abrirConversaciones();
await esperar(40);
await mod.abrirChatDeUsuario('anubisss');
await esperar(80);
ok('sin proceso abierto no hay botones', !$('vl-acc-chat'));

// ---------- 8) el aviso no repite la etiqueta ----------
// El cerebro manda "No se entendió si quiere envío…" y la etiqueta ya dice
// "No se entendió": la alerta debe leerse una sola vez.
mod.cerrarConversaciones();
PROC = { proceso_id: 'p1', estado: 'esperando_pago', saldo: 9000, prendas: 1, puntos: {} };
CHAT = Object.assign({}, CHAT, {
    tiene_aviso: true, aviso_tipo: 'no_entendido',
    aviso_detalle: 'No se entendió si quiere envío o entrega presencial: "hola"'
});
mod.abrirConversaciones();
await esperar(40);
await mod.abrirChatDeUsuario('anubisss');
await esperar(80);
const alerta = document.querySelector('.vl-chat-alerta, .vl-aviso-titulo');
const alertaTxt = alerta ? alerta.textContent : '';
ok('la alerta del chat existe', !!alerta);
ok('no repite "No se entendió"', (alertaTxt.match(/No se entendió/gi) || []).length <= 1);
ok('conserva el detalle', /quiere envío o entrega presencial/i.test(alertaTxt));

let fails = 0;
for (const [n, c] of checks) { console.log((c ? '✅' : '❌') + ' ' + n); if (!c) fails++; }
console.log(`\n${checks.length - fails}/${checks.length} checks OK`);
process.exit(fails ? 1 : 0);
