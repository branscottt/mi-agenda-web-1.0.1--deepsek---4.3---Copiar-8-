// scripts/liveview-parecido-smoke.mjs
// Smoke de la pantalla "Registrar venta" (MODO LIVE) para el aviso de POSIBLE
// DUPLICADO: si escribes "anubis" y ya existe "@anubisss", (a) sale una franja
// ámbar informativa, (b) al guardar pide confirmación antes de crear una ficha
// nueva, y (c) si existe el @ exacto no molesta.
// Uso: node scripts/liveview-parecido-smoke.mjs
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'node:url';

const OUT = '/tmp/liveview-parecido.mjs';
execFileSync('./node_modules/.bin/esbuild', [
    'src/ventas-live/ui/LiveView.js', '--bundle', '--format=esm',
    `--outfile=${OUT}`, '--log-level=warning'
], { stdio: 'inherit' });

const dom = new JSDOM(
    '<!doctype html><html><body><div id="vl-view-live"></div></body></html>',
    { pretendToBeVisual: true, url: 'https://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
try { Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true }); } catch (_) {}
global.HTMLElement = dom.window.HTMLElement;
global.localStorage = dom.window.localStorage;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

// ---- RPC stubbeada ----
// La búsqueda por "contiene" (vl_buscar_clientes) devuelve "@anubisss" cuando se
// escribe "anubis": así el front tiene que AVISAR en vez de crear un duplicado.
const CLIENTES = [
    { cliente_id: 'k1', tiktok_user: 'anubisss', nombre_real: 'Anubis', whatsapp: '', ciudad: '',
      categoria: 'nuevo', proceso_activo: { proceso_id: 'p9', estado: 'esperando_pago', saldo: 12000, prendas: 2 } },
    { cliente_id: 'k2', tiktok_user: 'otra_persona', nombre_real: '', whatsapp: '', ciudad: '',
      categoria: 'nuevo', proceso_activo: null }
];

let agregarLlamadas = [];
const rpc = (name, args) => {
    if (name === 'vl_buscar_clientes') {
        const q = String((args && args.p_q) || '').toLowerCase();
        const hits = CLIENTES.filter(c => !q || c.tiktok_user.indexOf(q) >= 0);
        return Promise.resolve({ data: { ok: true, clientes: hits }, error: null });
    }
    if (name === 'vl_agregar_item') {
        agregarLlamadas.push(args);
        return Promise.resolve({
            data: { ok: true, cliente: { tiktok_user: args.p_tiktok_user, es_nuevo: true },
                    item: { id: 'it1' }, proceso: { id: 'p1' } },
            error: null
        });
    }
    if (name === 'vl_dashboard') {
        return Promise.resolve({ data: { live_actual: null, ventas: { hoy: 0 }, pagos: { hoy: 0 },
                                         pendiente_total: 0 }, error: null });
    }
    return Promise.resolve({ data: { ok: true }, error: null });
};
window.supabaseClient = { rpc };

const mod = await import(pathToFileURL(OUT).href);
mod.initLiveView();
await new Promise(r => setTimeout(r, 60));

const $ = (id) => document.getElementById(id);
const parecido = $('lv-parecido');
const sugerencias = $('lv-sugerencias');
const checks = [];
const ok = (n, c) => checks.push([n, !!c]);
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- 1) escribes "anubis" y ya existe "@anubisss" ----------
$('lv-usuario').value = 'anubis';
$('lv-usuario').dispatchEvent(new dom.window.Event('input'));
await esperar(420);   // debounce de 300 ms

ok('franja de posible duplicado visible', parecido && !parecido.hidden);
ok('nombra el @ parecido', /@anubisss/.test(parecido.textContent));
ok('avisa que confirmará al guardar', /confirmar/i.test(parecido.textContent));
ok('la franja NO es roja', !/danger|rojo/i.test(parecido.className));
ok('lista de sugerencias con @anubisss', /@anubisss/.test(sugerencias.textContent));

// ---------- 2) guardar: el usuario dice "usar la existente" (Aceptar) ----------
$('lv-precio').value = '9000';
agregarLlamadas = [];
window.confirm = () => true;                 // Aceptar = usar la ficha existente
$('lv-agregar').dispatchEvent(new dom.window.Event('click'));
await esperar(60);
ok('con "usar la existente" NO crea cliente nuevo', agregarLlamadas.length === 0);
ok('no se perdió el usuario escrito', $('lv-usuario').value === 'anubis');

// ---------- 3) guardar: el usuario dice "es otra persona" (Cancelar) ----------
agregarLlamadas = [];
window.confirm = () => false;                // Cancelar = crear la ficha nueva
$('lv-agregar').dispatchEvent(new dom.window.Event('click'));
await esperar(80);
ok('con "es otra" SÍ registra la venta', agregarLlamadas.length === 1);
ok('registra con el @ escrito', agregarLlamadas[0] && agregarLlamadas[0].p_tiktok_user === 'anubis');

// ---------- 4) @ exacto: no molesta con el aviso ----------
$('lv-usuario').value = 'anubisss';
$('lv-usuario').dispatchEvent(new dom.window.Event('input'));
await esperar(420);
ok('con @ exacto la franja queda oculta', parecido.hidden === true);

// ---------- 5) campo vacío: todo oculto ----------
$('lv-usuario').value = '';
$('lv-usuario').dispatchEvent(new dom.window.Event('input'));
await esperar(60);
ok('campo vacío: sin franja', parecido.hidden === true);

// ---------- 6) botones de proceso EN EL CHAT del LIVE (pedido del dueño) ----------
// Se elige la sugerencia (@anubisss, que tiene deuda) para que se cargue su chat;
// las sugerencias escuchan 'mousedown' a propósito (le gana al blur del input).
$('lv-usuario').value = 'anubis';
$('lv-usuario').dispatchEvent(new dom.window.Event('input'));
await esperar(420);
const btnSug = sugerencias.querySelector('button.vl-sugerencia');
if (btnSug) btnSug.dispatchEvent(new dom.window.Event('mousedown', { bubbles: true, cancelable: true }));
await esperar(120);
const accChat = document.querySelector('#lv-acc-chat button[data-acc="pago"]');
ok('el chat del LIVE muestra "Confirmar pago" con deuda', !!accChat);

let fails = 0;
for (const [n, c] of checks) { console.log((c ? '✅' : '❌') + ' ' + n); if (!c) fails++; }
console.log(`\n${checks.length - fails}/${checks.length} checks OK`);
process.exit(fails ? 1 : 0);
