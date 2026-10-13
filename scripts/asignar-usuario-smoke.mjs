// scripts/asignar-usuario-smoke.mjs
// Smoke del bloque "¿Quién es?" (ASIGNAR el usuario del chat a mano): bundlea el
// módulo REAL de chatComun, lo monta en jsdom y verifica el HTML, el abrir/cerrar,
// la BUSQUEDA con freno y que el click entregue el cliente_id.
// Uso: node scripts/asignar-usuario-smoke.mjs
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'node:url';

const OUT = '/tmp/asignar-user-smoke.mjs';
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

const mod = await import(pathToFileURL(OUT).href);

let ok = 0, fail = 0;
const t = (nombre, cond) => {
    if (cond) { ok++; console.log('✅', nombre); } else { fail++; console.log('❌', nombre); }
};

const usuarios = [
    { cliente_id: 'j1', tiktok_user: 'jolumaaf', nombre_real: '', prendas: 1, saldo: 10000, saldo_abierto: 10000, compro: true, motivo: 'compró y no está vinculado' },
    { cliente_id: 'd2', tiktok_user: 'la_diabla888', nombre_real: '', prendas: 1, saldo: 16000, saldo_abierto: 0, compro: true, motivo: 'ya compró antes' },
    { cliente_id: 's3', tiktok_user: '', nombre_real: 'Sin Arroba', prendas: 0, saldo: 0, compro: false, motivo: 'se parece a lo que escribió' }
];

// ── 1. Chat SIN asignar: el panel sale abierto (no se pierde abajo del hilo) ──
const cont = document.createElement('div');
cont.innerHTML = mod.quienEsHtml({ vinculado: false, usuarios });
t('sin asignar: muestra "¿Quién es?"', cont.textContent.includes('¿Quién es?'));
t('sin asignar: el panel va ABIERTO', cont.querySelector('.vl-quien-panel').hidden === false);
t('sin asignar: aria-expanded=true', cont.querySelector('.vl-quien-cab').getAttribute('aria-expanded') === 'true');
t('un botón por usuario que compró', cont.querySelectorAll('button.vl-cand').length === 3);
t('muestra el @', cont.textContent.includes('@jolumaaf') && cont.textContent.includes('@la_diabla888'));
t('muestra prendas y saldo', cont.textContent.includes('1 prenda(s)') && cont.textContent.includes('10.000'));
t('muestra el motivo', cont.textContent.includes('compró y no está vinculado'));
t('usa el nombre real si no hay @', cont.textContent.includes('Sin Arroba'));
t('trae el buscador', !!cont.querySelector('.vl-quien-busca .vl-control'));

// ── 2. Chat YA asignado: sirve para CAMBIARLO ──
const contY = document.createElement('div');
contY.innerHTML = mod.quienEsHtml({
    vinculado: true, clienteActual: { tiktok_user: 'jolumaaf', nombre_real: '' }, usuarios
});
t('asignado: dice a quién está asignado', contY.textContent.includes('Asignado a @jolumaaf'));
t('asignado: el panel va CERRADO', contY.querySelector('.vl-quien-panel').hidden === true);

// ── 3. Escapado (nada de inyección desde un @) ──
const evil = mod.quienEsHtml({
    vinculado: false,
    usuarios: [{ cliente_id: 'x', tiktok_user: '<img src=x onerror=alert(1)>', prendas: 0, saldo: 0, motivo: 'm<' }]
});
t('escapa el @ malicioso', !evil.includes('<img src=x') && evil.includes('&lt;img'));

// ── 4. Sin resultados: explica qué hacer ──
const vac = document.createElement('div');
vac.innerHTML = mod.quienEsHtml({ vinculado: false, usuarios: [] });
t('sin usuarios: mensaje de ayuda', vac.textContent.includes('Nadie con ese texto'));

// ── 5. Abrir/cerrar y click ──
let elegido = null;
let busquedas = [];
const cont2 = document.createElement('div');
cont2.innerHTML = mod.quienEsHtml({ vinculado: true, clienteActual: { tiktok_user: 'x' }, usuarios });
document.body.appendChild(cont2);
const api = mod.bindQuienEs(cont2, {
    onBuscar: async (texto) => { busquedas.push(texto); return { usuarios: texto ? [usuarios[0]] : [] }; },
    onElegir: (id, nick) => { elegido = { id, nick }; }
});
const panel = cont2.querySelector('.vl-quien-panel');

cont2.querySelector('.vl-quien-cab').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
t('la cabecera ABRE el panel', panel.hidden === false);
t('abrir deja aria-expanded=true', cont2.querySelector('.vl-quien-cab').getAttribute('aria-expanded') === 'true');
cont2.querySelector('.vl-quien-cab').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
t('la cabecera CIERRA el panel', panel.hidden === true);
api.abrir();
t('api.abrir() lo vuelve a abrir', panel.hidden === false);

cont2.querySelector('button[data-cliente="j1"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
t('el click entrega el cliente_id', !!elegido && elegido.id === 'j1');
t('el click entrega el nick', !!elegido && elegido.nick === '@jolumaaf');

// ── 6. Buscar: escribe, espera el freno (300 ms) y repinta ──
const input = cont2.querySelector('.vl-quien-busca .vl-control');
input.value = 'jolum';
input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
t('mientras busca avisa "Buscando…"', cont2.querySelector('.vl-quien-ayuda').textContent.includes('Buscando'));
await new Promise(r => setTimeout(r, 420));
t('la búsqueda llegó con el texto escrito', busquedas.length === 1 && busquedas[0] === 'jolum');
t('la lista se repintó con el resultado', cont2.querySelectorAll('button.vl-cand').length === 1
    && cont2.textContent.includes('@jolumaaf'));

// ── 7. Robustez ──
t('sin contenedor devuelve un api vacío', typeof mod.bindQuienEs(null, {}).abrir === 'function');
mod.bindQuienEs(document.createElement('div'), {});   // sin callbacks: no explota
mod.bindQuienEs(document.createElement('div'));        // sin opciones: no explota
t('sin contenedor/callbacks no explota', true);

console.log(`\n${ok}/${ok + fail} checks OK`);
process.exit(fail ? 1 : 0);
