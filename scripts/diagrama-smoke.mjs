// scripts/diagrama-smoke.mjs
// Smoke del DIAGRAMA de procesos sin sesión ni base de datos:
//   - bundlea el módulo real con esbuild
//   - lo renderiza en jsdom con window.supabaseClient stubbeado
//   - verifica filas, puntos, alerta y que presionar un punto llame la RPC
// Uso:  node scripts/diagrama-smoke.mjs
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'node:url';

const OUT = '/tmp/diagrama-smoke-bundle.mjs';
execFileSync('./node_modules/.bin/esbuild', [
    'src/ventas-live/ui/DiagramaView.js', '--bundle', '--format=esm',
    `--outfile=${OUT}`, '--log-level=warning'
], { stdio: 'inherit' });

const dom = new JSDOM('<!doctype html><html><body><div id="vp-diag"></div><div id="vp-modo"></div></body></html>',
    { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
try { Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true }); } catch (_) {}
global.HTMLElement = dom.window.HTMLElement;
global.confirm = () => true;
window.confirm = () => true;

const llamadas = [];
const FAKE = {
    vl_procesos_diagrama: {
        ok: true, total: 2,
        procesos: [
            {
                proceso_id: 'p1', estado: 'esperando_pago', saldo: 12000, total: 12000, prendas: 2,
                dias_sin_contacto: 5,
                alerta: { tipo: 'soltar_prenda', dias: 5, detalle: 'Sin contacto hace 5 día(s) y debe $12.000' },
                cliente: { cliente_id: 'c1', tiktok_user: 'anubisss', nombre_real: 'Anubis', whatsapp: '+56911111111', categoria: 'nuevo' },
                puntos: {
                    region: { valor: null, opciones: [{ v: 'santiago', l: 'Santiago (RM)' }, { v: 'region', l: 'Región' }] },
                    entrega: { valor: null, opciones: [{ v: 'envio', l: 'Envío' }, { v: 'presencial', l: 'Presencial' }] },
                    courier: { valor: 'paket', opciones: [{ v: 'blue', l: 'Blue Express' }, { v: 'paket', l: 'Paket' }] },
                    pago: { valor: 'sin_pagar', opciones: [] },
                    fecha: { valor: null, opciones: [], manual: true }
                },
                envio: null
            },
            {
                proceso_id: 'p2', estado: 'envio_programado', saldo: 0, total: 8000, prendas: 1,
                dias_sin_contacto: 0, alerta: null,
                cliente: { cliente_id: 'c2', tiktok_user: 'cami', nombre_real: 'Cami', whatsapp: '+56922222222', categoria: 'confiable' },
                puntos: {
                    region: { valor: 'santiago', opciones: [] },
                    entrega: { valor: 'envio', opciones: [] },
                    courier: { valor: 'blue', opciones: [] },
                    pago: { valor: 'pagado', opciones: [] },
                    fecha: { valor: '2026-10-20', opciones: [], manual: true }
                },
                envio: { tipo: 'envio', empresa: 'blue_express', fecha_programada: '2026-10-20' }
            }
        ]
    }
};
window.supabaseClient = {
    rpc: (name, params) => { llamadas.push({ name, params }); return Promise.resolve({ data: FAKE[name] || { ok: true }, error: null }); }
};

const mod = await import(pathToFileURL(OUT).href);
const cont = document.getElementById('vp-diag');
mod.initDiagrama(cont);
await new Promise(r => setTimeout(r, 60));

const checks = [];
const ok = (n, c) => checks.push([n, !!c]);
ok('renderiza 2 filas', cont.querySelectorAll('.vlg-row').length === 2);
ok('fila 1 con alerta', cont.querySelector('.vlg-row.con-alerta') !== null);
ok('fila 2 sin alerta', cont.querySelectorAll('.vlg-row.con-alerta').length === 1);
ok('5 puntos en fila 1', cont.querySelectorAll('.vlg-row[data-p="p1"] .vlg-punto').length === 5);
ok('texto alerta visible', /Sin contacto hace 5/.test(cont.textContent));
ok('contador de alertas', /1 con posible soltar prenda/.test(cont.textContent));
ok('punto pagado (ok) en fila 2', cont.querySelector('.vlg-row[data-p="p2"] .vlg-punto.ok') !== null);
ok('punto pendiente en fila 1', cont.querySelector('.vlg-row[data-p="p1"] .vlg-punto.pendiente') !== null);
ok('botón Liberar prenda en fila con alerta', !!cont.querySelector('.vlg-row[data-p="p1"] button[data-acc="liberar"]'));
ok('sin Liberar en fila sin alerta', !cont.querySelector('.vlg-row[data-p="p2"] button[data-acc="liberar"]'));
ok('botón Bloquear y borrar presente', cont.querySelectorAll('button[data-acc="bloquear"]').length === 2);
ok('botón Ver chat presente', cont.querySelectorAll('button[data-acc="chat"]').length === 2);
ok('fecha formateada dd/mm', /20\/10/.test(cont.textContent));
ok('valor courier legible', /Paket/.test(cont.textContent));

// Presionar el punto "Región" de la fila 1 -> abre modal con opciones
const chip = cont.querySelector('.vlg-row[data-p="p1"] .vlg-punto[data-punto="region"]');
chip.click();
await new Promise(r => setTimeout(r, 30));
const overlay = document.querySelector('.vl-modal-overlay');
ok('modal de punto se abre', !!overlay);
ok('modal trae opciones', overlay ? overlay.querySelectorAll('#vpu-opciones .vl-opcion').length === 2 : false);

// Elegir "Santiago (RM)" -> llama vl_proceso_punto_set con punto=region valor=santiago
if (overlay) {
    const op = Array.from(overlay.querySelectorAll('#vpu-opciones .vl-opcion'))
        .find(e => e.dataset.v === 'santiago');
    op.click();
    await new Promise(r => setTimeout(r, 60));
}
const call = llamadas.find(l => l.name === 'vl_proceso_punto_set');
ok('llamó vl_proceso_punto_set', !!call);
ok('punto=region', call && call.params.p_punto === 'region');
ok('valor=santiago', call && call.params.p_valor === 'santiago');
ok('proceso p1', call && call.params.p_proceso_id === 'p1');

// --- Caso vacío (usa el MISMO contenedor: el módulo guarda su referencia) ---
FAKE.vl_procesos_diagrama = { ok: true, total: 0, procesos: [] };
await mod.refrescarDiagrama();
ok('estado vacío', /Sin procesos activos/.test(cont.textContent));

let fails = 0;
for (const [n, c] of checks) { console.log((c ? '✅' : '❌') + ' ' + n); if (!c) fails++; }
console.log(`\n${checks.length - fails}/${checks.length} checks OK`);
process.exit(fails ? 1 : 0);
