// scripts/chat-candidatos-smoke.mjs
// Smoke de los candidatos apretables ("¿Quién es?") del chat: bundlea el módulo
// REAL de chatComun, lo monta en jsdom y verifica el HTML, el escapado y que el
// click entregue el cliente_id.
// Uso: node scripts/chat-candidatos-smoke.mjs
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'node:url';

const OUT = '/tmp/chatcand-smoke.mjs';
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

// 1) sin candidatos no pinta nada
t('sin candidatos: cadena vacía', mod.candidatosHtml([]) === '' && mod.candidatosHtml(null) === '');

// 2) un botón por candidato, con @, prendas, saldo y motivo
const cands = [
    { cliente_id: 'a1', tiktok_user: 'khami', prendas: 1, saldo: 12000, motivo: 'compró y no está vinculado' },
    { cliente_id: 'b2', tiktok_user: '', nombre_real: 'Sin arroba', prendas: 2, saldo: 0, motivo: 'se parece a lo que escribió' }
];
const html = mod.candidatosHtml(cands);
const cont = document.createElement('div');
cont.innerHTML = html;
t('un botón por candidato', cont.querySelectorAll('button.vl-cand').length === 2);
t('muestra el @ del cliente', cont.textContent.includes('@khami'));
t('muestra prendas y saldo', cont.textContent.includes('1 prenda(s)') && cont.textContent.includes('12.000'));
t('usa el nombre real si no hay @', cont.textContent.includes('Sin arroba'));
t('muestra el motivo', cont.textContent.includes('compró y no está vinculado'));
t('no muestra saldo cuando es 0', !cont.textContent.includes('$0'));

// 3) escapa HTML (nada de inyección desde un @)
const evil = mod.candidatosHtml([{ cliente_id: 'x', tiktok_user: '<img src=x onerror=alert(1)>', prendas: 0, saldo: 0, motivo: 'm<' }]);
t('escapa el @ malicioso', !evil.includes('<img src=x') && evil.includes('&lt;img'));

// 4) el click entrega cliente_id y nick
let llamo = null;
mod.bindCandidatos(cont, (id, nick) => { llamo = { id, nick }; });
cont.querySelector('button[data-cliente="a1"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
t('el click entrega el cliente_id', !!llamo && llamo.id === 'a1');
t('el click entrega el nick', !!llamo && llamo.nick === '@khami');

// 5) robustez
mod.bindCandidatos(null, () => {});
mod.bindCandidatos(cont, null);
t('sin contenedor o sin callback no explota', true);

console.log(`\n${ok}/${ok + fail} checks OK`);
process.exit(fail ? 1 : 0);
