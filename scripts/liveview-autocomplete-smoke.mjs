// scripts/liveview-autocomplete-smoke.mjs
// Verificación SIN navegador ni sesión del autocompletado de usuarios del LIVE.
// 1) bundlea el módulo REAL (src/ventas-live/ui/LiveView.js) con esbuild
// 2) lo monta en jsdom con window.supabase stubbeado (RPC vl_buscar_clientes)
// 3) simula escribir "hab" y comprueba la lista, la selección con Enter y el clic
// No toca la base ni producción. Uso: node scripts/liveview-autocomplete-smoke.mjs
import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'node:url';

const OUT = '/tmp/lv-autocomplete.bundle.mjs';
buildSync({
    entryPoints: ['src/ventas-live/ui/LiveView.js'],
    bundle: true, format: 'esm', outfile: OUT,
    platform: 'browser', target: ['es2020'],
    minify: false, legalComments: 'none', logLevel: 'error',
});

const CLIENTES = [
    { cliente_id: 'c1', tiktok_user: 'habitual_ana', nombre_real: 'Ana', categoria: 'nuevo',
      proceso_activo: { prendas: 3, saldo: 17000, estado: 'esperando_pago' } },
    { cliente_id: 'c2', tiktok_user: 'habitual_beto', nombre_real: 'Beto', categoria: 'confiable',
      proceso_activo: null },
    { cliente_id: 'c3', tiktok_user: 'otro_hab', nombre_real: 'Cami', categoria: 'nuevo',
      proceso_activo: { prendas: 1, saldo: 5000, estado: 'acumulando' } },
    { cliente_id: 'c4', tiktok_user: 'zeta', nombre_real: 'Zoe', categoria: 'nuevo', proceso_activo: null },
];

const llamadas = [];
const dom = new JSDOM('<!doctype html><html><body><section id="vl-view-live" class="active"></section></body></html>',
    { url: 'https://agenda-pro-red.vercel.app/ventas-live.html', pretendToBeVisual: true });

const { window } = dom;
window.__APP_CONFIG = { supabaseUrl: 'https://stub.supabase.co', supabaseKey: 'stub' };
window.supabase = {
    createClient: () => ({
        rpc: async (nombre, params = {}) => {
            llamadas.push(nombre);
            if (nombre === 'vl_buscar_clientes') {
                const q = String(params.p_q || '');
                return { data: { ok: true, clientes: CLIENTES.filter(c => c.tiktok_user.includes(q)) }, error: null };
            }
            if (nombre === 'vl_wa_chats_listar') return { data: { ok: true, chats: [] }, error: null };
            if (nombre === 'vl_dashboard') return { data: { ok: true, ventas: {}, pagos: {}, pendiente_total: 0 }, error: null };
            return { data: { ok: true }, error: null };
        },
        channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
        removeChannel: () => {},
    }),
};
global.window = window;
global.document = window.document;
// En Node 22 `navigator` es un getter de solo lectura: se redefine.
Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true });
global.localStorage = window.localStorage;
global.HTMLElement = window.HTMLElement;
global.Event = window.Event;
global.MouseEvent = window.MouseEvent;
window.alert = () => {};

const { initLiveView } = await import(pathToFileURL(OUT).href);
initLiveView();
await new Promise(r => setTimeout(r, 50));

const $ = (id) => window.document.getElementById(id);
const tx = (t) => (window.document.body.textContent || '').includes(t);
let ok = 0, fail = 0;
const check = (nombre, cond, extra = '') => {
    (cond ? ok++ : fail++);
    console.log(`${cond ? 'OK  ' : 'FALLA'} ${nombre}${extra ? ' — ' + extra : ''}`);
};
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// ── 1. Escribir "hab" → aparece la lista ──
const inp = $('lv-usuario');
const box = $('lv-sugerencias');
check('el input de usuario existe', !!inp);
check('el contenedor de sugerencias existe', !!box);
check('la lista arranca oculta', box.hidden === true);

inp.value = 'hab';
inp.dispatchEvent(new window.Event('input', { bubbles: true }));
await esperar(500);

const items = [...box.querySelectorAll('.vl-sugerencia')];
check('la lista se muestra con coincidencias', !box.hidden && items.length === 3, `items=${items.length}`);
check('muestra el @usuario', tx('@habitual_ana') && tx('@habitual_beto') && tx('@otro_hab'));
check('muestra el saldo del pedido abierto', tx('17.000') || tx('17000'), box.textContent.replace(/\s+/g, ' ').trim());
check('3 prendas del pedido', tx('3 prenda(s)'));
check('el primero queda resaltado', items[0].classList.contains('activa'));
check('pide la búsqueda parcial al RPC', llamadas.includes('vl_buscar_clientes'));

// ── 2. Flecha abajo + Enter → selecciona el segundo y llena el campo ──
inp.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
const items2 = [...box.querySelectorAll('.vl-sugerencia')];
check('ArrowDown mueve el resaltado al segundo', items2[1].classList.contains('activa'));
inp.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
await esperar(50);
check('Enter llena el input con el usuario elegido', inp.value === 'habitual_beto', `valor="${inp.value}"`);
check('Enter cierra la lista', box.hidden === true);
check('se ve la tarjeta del cliente elegido', $('lv-nick').textContent === '@habitual_beto');
check('el foco pasa al precio', window.document.activeElement === $('lv-precio'));

// ── 3. Clic (mousedown) sobre una sugerencia ──
inp.value = 'hab';
inp.dispatchEvent(new window.Event('input', { bubbles: true }));
await esperar(500);
const items3 = [...box.querySelectorAll('.vl-sugerencia')];
items3[0].dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
await esperar(50);
check('el clic llena el input', inp.value === 'habitual_ana', `valor="${inp.value}"`);
check('el clic cierra la lista', box.hidden === true);

// ── 4. Coincidencia exacta → tarjeta, sin lista ──
inp.value = 'zeta';
inp.dispatchEvent(new window.Event('input', { bubbles: true }));
await esperar(500);
check('coincidencia exacta pinta la tarjeta', $('lv-nick').textContent === '@zeta');
check('con coincidencia exacta no hay lista', box.hidden === true);

// ── 5. Escape y blur cierran la lista ──
inp.value = 'hab';
inp.dispatchEvent(new window.Event('input', { bubbles: true }));
await esperar(500);
check('la lista vuelve a aparecer', !box.hidden);
inp.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
check('Escape cierra la lista', box.hidden === true);

// ── 6. Sin coincidencias → aviso neutro (no confundir con "no funciona") ──
inp.value = 'zzz';
inp.dispatchEvent(new window.Event('input', { bubbles: true }));
await esperar(500);
check('aparece el aviso de sin coincidencias', !box.hidden);
check('el aviso dice que se guardará como cliente nuevo',
    tx('Sin clientes con ese nombre') && tx('se va a guardar como cliente nuevo'),
    box.textContent.replace(/\s+/g, ' ').trim());
check('el aviso no es clickeable', box.querySelectorAll('.vl-sugerencia').length === 0);

// ── 7. Una sola letra sin coincidencias no abre nada ──
inp.value = 'q';
inp.dispatchEvent(new window.Event('input', { bubbles: true }));
await esperar(500);
check('con 1 letra sin coincidencias no aparece nada', box.hidden === true);

console.log(`\nRESULTADO: ${ok} OK / ${fail} FALLA`);
process.exit(fail ? 1 : 0);
