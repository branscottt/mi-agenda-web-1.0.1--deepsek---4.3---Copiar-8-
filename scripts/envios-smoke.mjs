// scripts/envios-smoke.mjs
// Smoke de la vista ENVÍOS (ahora armada desde el PROCESO, igual que el
// diagrama) sin sesión ni base de datos:
//   - bundlea el módulo real con esbuild
//   - lo renderiza en jsdom con window.supabaseClient stubbeado
//   - verifica los grupos, los chips del proceso y los botones
//   - presiona "Pagar prendas" y controla que abra el modal con las prendas
// Uso:  node scripts/envios-smoke.mjs
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'node:url';

const OUT = '/tmp/envios-smoke-bundle.mjs';
execFileSync('./node_modules/.bin/esbuild', [
    'src/ventas-live/ui/EnviosView.js', '--bundle', '--format=esm',
    `--outfile=${OUT}`, '--log-level=warning'
], { stdio: 'inherit' });

const dom = new JSDOM('<!doctype html><html><body><div id="vl-view-envios"></div></body></html>',
    { pretendToBeVisual: true, url: 'https://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
try { Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true }); } catch (_) {}
global.HTMLElement = dom.window.HTMLElement;
window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
window.confirm = () => true;
global.confirm = () => true;

// ── Payload REAL de producción (@anubisss: compra nueva, sin entrega decidida,
//    la vez pasada fue presencial) + 3 filas sintéticas para cubrir los botones.
const fila = (o) => Object.assign({
    envio_id: null, empresa: null, tracking: null, fecha_programada: null,
    envio_estado: null, notas: '', fecha_dicha: false, courier: '', total: 0,
    prendas: 1, tipo: null, tipo_sugerido: null, pago_confirmado: false,
    siguiente_paso: '', accion: 'abrir_chat', prioridad: 5
}, o);

const PAYLOAD = {
    ok: true, revisar_chat: true,
    grupos: {
        por_cobrar: [fila({
            proceso_id: 'p5', cliente_id: 'c5', proceso_estado: 'entregado_por_cobrar',
            tipo: 'presencial', saldo: 7000, total: 7000, prendas: 1, envio_estado: 'entregado',
            accion: 'pagar', pago_confirmado: false,
            siguiente_paso: 'Entregado: falta cobrar $7.000 de $7.000. Al cobrar el saldo el pedido se cierra solo.',
            cliente: { cliente_id: 'c5', tiktok_user: 'entregado', nombre_real: '', whatsapp: '+569****5555', ciudad: '', comuna: '', direccion: '' }
        })],
        sin_entrega: [fila({
            proceso_id: 'p1', cliente_id: 'c1', proceso_estado: 'esperando_whatsapp',
            tipo: null, tipo_sugerido: 'presencial', saldo: 25000, total: 25000, prendas: 2,
            accion: 'pagar', siguiente_paso: 'Falta decidir entrega. Cobrar $25.000 o darle plazo y liberar la prenda.',
            cliente: { cliente_id: 'c1', tiktok_user: 'anubisss', nombre_real: '', whatsapp: '+569****4047', ciudad: '', comuna: '', direccion: '' }
        })],
        por_preparar: [fila({
            proceso_id: 'p2', cliente_id: 'c2', proceso_estado: 'pagado',
            tipo: 'envio', courier: 'blue', saldo: 0, total: 8000, prendas: 1,
            envio_estado: 'pendiente', accion: 'crear_envio',
            siguiente_paso: 'Pedir en Blue Express (el envío se paga al recibir)',
            cliente: { cliente_id: 'c2', tiktok_user: 'cami', nombre_real: 'Cami', whatsapp: '+569****2222', ciudad: 'Santiago', comuna: 'Maipú', direccion: 'Los Aromos 456' }
        })],
        presenciales: [fila({
            proceso_id: 'p3', cliente_id: 'c3', proceso_estado: 'esperando_pago',
            tipo: 'presencial', notas: 'mañana', fecha_dicha: true, saldo: 12000, total: 12000, prendas: 1,
            accion: 'pagar', siguiente_paso: 'Entrega presencial con $12.000 por cobrar. Puede pagar al verse.',
            cliente: { cliente_id: 'c3', tiktok_user: 'presen', nombre_real: 'Presen', whatsapp: '+569****3333', ciudad: '', comuna: '', direccion: '' }
        })],
        listos: [fila({
            proceso_id: 'p4', cliente_id: 'c4', proceso_estado: 'envio_proceso',
            tipo: 'envio', courier: 'paket', empresa: 'paket', tracking: 'PK123', saldo: 0, total: 5000, prendas: 1,
            envio_estado: 'en_proceso', accion: 'entregado', pago_confirmado: true,
            siguiente_paso: 'En camino: marcar entregado cuando llegue.',
            cliente: { cliente_id: 'c4', tiktok_user: 'paketito', nombre_real: '', whatsapp: '+569****4444', ciudad: 'Santiago', comuna: 'Ñuñoa', direccion: '' }
        })]
    }
};

const llamadas = [];
const FAKE = {
    vl_envios_pendientes: PAYLOAD,
    vl_config_faltantes: { ok: true, faltantes: [], recomendados: [] },
    vl_ficha_cliente: {
        ok: true,
        proceso_activo: {
            id: 'p1',
            items: [
                { id: 'i1', descripcion: 'Polera', precio: 10000, abonado: 0, estado: 'adjudicada' },
                { id: 'i2', descripcion: 'Pantalón', precio: 15000, abonado: 0, estado: 'adjudicada' },
                { id: 'i3', descripcion: 'Ya pagada', precio: 5000, abonado: 5000, estado: 'pagada' }
            ]
        }
    }
};
window.supabaseClient = {
    rpc: (name, params) => {
        llamadas.push({ name, params });
        return Promise.resolve({ data: FAKE[name] || { ok: true }, error: null });
    }
};

const mod = await import(pathToFileURL(OUT).href);
mod.initEnvios();
await new Promise(r => setTimeout(r, 120));
const cont = document.getElementById('ve-contenido');
const txt = () => cont.textContent;

const checks = [];
const ok = (n, c) => checks.push([n, !!c]);

ok('renderiza las 5 filas', cont.querySelectorAll('.vl-fila').length === 5);
ok('el grupo "entregado — falta cobrar" va PRIMERO', txt().indexOf('ENTREGADO — FALTA COBRAR') < txt().indexOf('FALTA DECIDIR LA ENTREGA'));
ok('la fila entregada-por-cobrar muestra el saldo a cobrar', /falta cobrar \$7\.000/.test(txt()));
ok('botón "Cobrar saldo" en entregado-por-cobrar', !!cont.querySelector('[data-proceso="p5"] button[data-acc="pagar"]'));
ok('grupo "falta decidir la entrega" después', txt().indexOf('FALTA DECIDIR LA ENTREGA') < txt().indexOf('FALTA CREAR EL ENVÍO'));
ok('la fila del que vuelve muestra la entrega como SUGERENCIA',
    /falta \(la vez pasada: presencial\)/.test(txt()));
ok('no la muestra como decidida', !/🤝 Presencial\s*·/.test(txt()));
ok('chip de deuda con el total', /Debe \$25\.000 de \$25\.000/.test(txt()));
ok('botón Registrar pago', !!cont.querySelector('[data-proceso="p1"] button[data-acc="pagar"]'));
ok('botón Pagar prendas (una o todas)', !!cont.querySelector('[data-proceso="p1"] button[data-acc="pagar-items"]'));
ok('botón Liberar prenda con saldo', !!cont.querySelector('[data-proceso="p1"] button[data-acc="liberar"]'));
ok('sin Liberar cuando está pagado', !cont.querySelector('[data-proceso="p4"] button[data-acc="liberar"]'));
ok('envío sin crear -> ENVÍO CREADO', !!cont.querySelector('[data-proceso="p2"] button[data-acc="crear-envio"]'));
ok('presencial con fecha dicha', /dijo: mañana/.test(txt()));
ok('en camino -> Ya lo envié / entregué', !!cont.querySelector('[data-proceso="p4"] button[data-acc="entregado"]'));
ok('el grupo respeta el orden declarado', txt().indexOf('FALTA CREAR EL ENVÍO') < txt().indexOf('ENTREGAS PRESENCIALES'));
ok('la fila muestra el estado del proceso', /Esperando WhatsApp/.test(txt()));
ok('dice cuántas prendas', /2 prenda\(s\)/.test(txt()));
ok('los datos del envío se pueden copiar', !!cont.querySelector('[data-proceso="p2"] button[data-copiar]'));

// Presionar "Pagar prendas" -> pide la ficha y abre el modal con las 2 prendas con saldo
cont.querySelector('[data-proceso="p1"] button[data-acc="pagar-items"]').click();
await new Promise(r => setTimeout(r, 120));
ok('pidió la ficha del cliente', llamadas.some(l => l.name === 'vl_ficha_cliente'));
const overlay = document.querySelector('.vl-modal-overlay');
ok('abre el modal de pagar prendas', !!overlay);
ok('lista sólo las prendas con saldo (2)', overlay ? overlay.querySelectorAll('#vl-pg-items input').length === 2 : false);
ok('total pendiente sumado', overlay ? /\$25\.000/.test(overlay.textContent) : false);

// Registrar el pago -> llama vl_pagar_items con las 2 prendas elegidas
if (overlay) {
    overlay.querySelector('#vl-pg-ok').click();
    await new Promise(r => setTimeout(r, 150));
}
const call = llamadas.find(l => l.name === 'vl_pagar_items');
ok('llamó vl_pagar_items', !!call);
ok('con las 2 prendas', call && Array.isArray(call.params.p_item_ids) && call.params.p_item_ids.length === 2);
ok('con método por defecto', call && call.params.p_metodo === 'transferencia');

// Vacío
FAKE.vl_envios_pendientes = { ok: true, grupos: {} };
await mod.initEnvios();
await new Promise(r => setTimeout(r, 80));
ok('estado vacío claro', /Sin pedidos abiertos/.test(cont.textContent));

let fails = 0;
for (const [n, c] of checks) { console.log((c ? '✅' : '❌') + ' ' + n); if (!c) fails++; }
console.log(`\n${checks.length - fails}/${checks.length} checks OK`);
process.exit(fails ? 1 : 0);
