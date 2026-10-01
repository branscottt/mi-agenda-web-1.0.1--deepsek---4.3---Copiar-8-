// scripts/chat-lista-smoke.mjs
// Smoke de la LISTA de conversaciones: bundlea el módulo real, lo monta en
// jsdom con la RPC stubbeada y verifica que cada fila muestre (a) quién tiene
// que contestar, (b) los puntos del proceso y (c) la deuda.
// Uso: node scripts/chat-lista-smoke.mjs
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'node:url';

const OUT = '/tmp/chatlista-smoke.mjs';
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
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const proc = (saldo, extra = {}) => ({
    estado: 'esperando_pago', saldo, total: 20000, prendas: 1,
    puntos: Object.assign({
        region: { valor: 'santiago' },
        entrega: { valor: 'envio' },
        courier: { valor: 'paket' },
        pago: { valor: saldo > 0 ? 'sin_pagar' : 'pagado' },
        fecha: { valor: null }
    }, extra)
});

const CHATS = [
    {
        id: 'c1', wa_id: '+56 9 0000 0001', estado: 'esperando_tiktok', modo: 'bot', oculto: false,
        ultimo_mensaje: 'no se que era', ultimo_en: new Date().toISOString(),
        ultimo_dir: 'in', ultimo_origen: '',
        tiktok_user: 'anubisss', nombre_real: 'Anubis', categoria: 'nuevo',
        tiene_aviso: true, aviso_tipo: 'no_entendido', aviso_detalle: 'no se entendió',
        sin_leer: 2, proceso: proc(12000)
    },
    {
        id: 'c2', wa_id: '+56 9 0000 0002', estado: 'listo', modo: 'bot', oculto: false,
        ultimo_mensaje: 'okis serian $8.000 su total', ultimo_en: new Date().toISOString(),
        ultimo_dir: 'out', ultimo_origen: 'bot',
        tiktok_user: 'cami', nombre_real: 'Cami', categoria: 'confiable',
        tiene_aviso: false, aviso_tipo: '', aviso_detalle: '',
        sin_leer: 0, proceso: proc(0)
    },
    {
        id: 'c3', wa_id: '+56 9 0000 0003', estado: 'habitual', modo: 'bot', oculto: false,
        ultimo_mensaje: 'hola?', ultimo_en: new Date().toISOString(),
        ultimo_dir: 'in', ultimo_origen: '',
        tiktok_user: 'juan', nombre_real: '', categoria: 'nuevo',
        tiene_aviso: false, aviso_tipo: '', aviso_detalle: '',
        sin_leer: 1, proceso: null
    }
];

window.supabaseClient = {
    rpc: (name) => Promise.resolve({
        data: name === 'vl_wa_chats_listar' ? { ok: true, chats: CHATS } : { ok: true },
        error: null
    })
};

const mod = await import(pathToFileURL(OUT).href);
mod.initConversacionesDrawer({ onBadge: () => {} });
mod.abrirConversaciones();
mod.refrescarContador();          // dispara la carga real de la lista
await new Promise(r => setTimeout(r, 120));

const cont = document.getElementById('vld-body');
const filas = cont.querySelectorAll('.vl-conv-item');
const c1 = cont.querySelector('.vl-conv-item[data-chat="c1"]');
const c2 = cont.querySelector('.vl-conv-item[data-chat="c2"]');
const c3 = cont.querySelector('.vl-conv-item[data-chat="c3"]');

const checks = [];
const ok = (n, c) => checks.push([n, !!c]);
ok('renderiza 3 filas', filas.length === 3);
ok('fila 1: "Contesta tú"', /Contesta tú/.test(c1.textContent));
ok('fila 1: chip humano (late)',
    c1.querySelector('.vl-conv-quien.humano') !== null);
ok('fila 1: fila marcada tu-turno', c1.classList.contains('tu-turno'));
ok('fila 1: tooltip con qué hacer',
    /respóndele tú/i.test(c1.querySelector('.vl-conv-quien').getAttribute('title')));
ok('fila 2: "Contestó el bot"', /Contestó el bot/.test(c2.textContent));
ok('fila 2: llama bot (verde)', c2.querySelector('.vl-conv-quien.bot') !== null);
ok('fila 3: el cliente habló último', /El cliente habló último/.test(c3.textContent));
ok('fila 3: espera (neutro)', c3.querySelector('.vl-conv-quien.espera') !== null);
ok('proceso visible en fila 1', c1.querySelector('.vl-conv-proc') !== null);
ok('5 puntos + deuda', c1.querySelectorAll('.vl-conv-proc .p').length === 6);
ok('muestra Región Santiago', /Región.*Santiago/.test(c1.textContent));
ok('muestra Courier Paket', /Courier.*Paket/.test(c1.textContent));
ok('muestra Fecha sin definir', /Fecha.*—/.test(c1.textContent));
ok('deuda en rojo-ámbar (debe)', c1.querySelector('.vl-conv-proc .p.debe') !== null);
ok('fila 2 pagada', /Pagado/.test(c2.querySelector('.vl-conv-proc').textContent));
ok('fila 3 sin pedido', /Sin pedido abierto/.test(c3.textContent));
ok('estado del chat sigue visible', /Esperando @TikTok/.test(c1.textContent));
ok('chip de no leídos', c1.querySelector('.vl-conv-noleido') !== null);

let fails = 0;
for (const [n, c] of checks) { console.log((c ? '✅' : '❌') + ' ' + n); if (!c) fails++; }
console.log(`\n${checks.length - fails}/${checks.length} checks OK`);
process.exit(fails ? 1 : 0);
