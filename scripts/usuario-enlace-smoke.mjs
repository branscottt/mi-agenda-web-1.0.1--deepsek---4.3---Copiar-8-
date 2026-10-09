// scripts/usuario-enlace-smoke.mjs
// Smoke de la normalización de @usuario con ENLACE del LIVE de TikTok:
// bundlea el módulo REAL (vlApi.js) y comprueba que un enlace pegado se
// convierte en el @usuario y que el resto de casos no cambian.
// Uso: node scripts/usuario-enlace-smoke.mjs
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'node:url';

const OUT = '/tmp/usuario-enlace-smoke.mjs';
execFileSync('./node_modules/.bin/esbuild', [
    'src/ventas-live/domain/vlApi.js', '--bundle', '--format=esm',
    `--outfile=${OUT}`, '--log-level=warning'
], { stdio: 'inherit' });

const dom = new JSDOM('<!doctype html><html><body></body></html>',
    { pretendToBeVisual: true, url: 'https://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
try { Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true }); } catch (_) {}
global.localStorage = dom.window.localStorage;
global.HTMLElement = dom.window.HTMLElement;

const mod = await import(pathToFileURL(OUT).href);
const n = mod.normalizarTiktok;

let ok = 0, fail = 0;
const t = (nombre, got, esperado) => {
    if (got === esperado) { ok++; console.log('✅', nombre, '->', JSON.stringify(got)); }
    else { fail++; console.log('❌', nombre, '->', JSON.stringify(got), '(esperado', JSON.stringify(esperado) + ')'); }
};

// 1) Enlaces de TikTok (el caso que antes guardaba la URL completa)
t('enlace perfil', n('https://www.tiktok.com/@ianaianita'), 'ianaianita');
t('enlace con /live', n('https://www.tiktok.com/@ianaianita/live'), 'ianaianita');
t('enlace con querystring', n('https://www.tiktok.com/@ianaianita?lang=es'), 'ianaianita');
t('enlace sin esquema', n('www.tiktok.com/@ianaianita'), 'ianaianita');
t('enlace móvil', n('https://m.tiktok.com/@ian.anita_9'), 'ian.anita_9');
t('enlace con punto final', n('https://www.tiktok.com/@ianaianita.'), 'ianaianita');
t('enlace con espacios al pegar', n('  https://www.tiktok.com/@ianaianita  '), 'ianaianita');
t('mayúsculas en el enlace', n('https://www.TikTok.com/@IanaIanita'), 'ianaianita');

// 2) Casos de siempre (no deben romperse)
t('@ directo', n('@ianaianita'), 'ianaianita');
t('sin @', n('ianaianita'), 'ianaianita');
t('con espacios internos', n('iana ianita'), 'ianaianita');
t('MAYÚSCULAS', n('IANAIANITA'), 'ianaianita');
t('vacío', n(''), '');
t('null', n(null), '');
t('undefined', n(undefined), '');

// 3) Un @ válido con punto interno NO debe recortarse
t('punto interno se conserva', n('maria.jose'), 'maria.jose');

console.log(`\n${fail === 0 ? '✅' : '❌'} usuario-enlace-smoke: ${ok}/${ok + fail}`);
process.exit(fail === 0 ? 0 : 1);
