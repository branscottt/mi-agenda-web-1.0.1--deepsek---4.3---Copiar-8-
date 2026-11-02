// verify-vl-tablero.js
// VALIDACIÓN del tablero de Envíos (estilo Trello) sobre el build REAL de dist/
// con Supabase simulado (no toca datos):
//   * columnas y tarjetas en su columna
//   * fotos firmadas, chips de pago, prendas y totales
//   * tarjeta abierta: prendas, totales, contacto editable, fotos, etiquetas
//   * editar datos -> confirmación (2 toques) -> RPC
//   * borrar foto -> confirmación -> RPC + borrar archivo
//   * arrastrar tarjeta a Blue -> confirmación -> RPC vl_tablero_mover
//   * atrás con la tarjeta abierta -> cierra y no sale de la página
//   * capturas PC 1440x900 y móvil 390x844
//
// Uso: node verify-vl-tablero.js
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, 'dist');
const PORT = Number(process.env.VL_TABLERO_PORT || 8795);
const HOST = 'dfcfimipkfhitlsyixqu.supabase.co';
const SHOTS = path.join(__dirname, 'e2e-shots');

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json',
    '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8'
};

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64');

// ── Tarjetas de ejemplo (una por columna) ────────────────────────────
const IT = (id, desc, precio, abonado, estado) => ({ id, descripcion: desc, precio, abonado, estado });
const FOTO = (n) => ({ mensaje_id: 'm' + n, media_path: `t/chat/${n}.jpg` });

const TARJETAS = [
    {
        proceso_id: 'p1', cliente_id: 'c1', columna: 'blue', orden: 1, etiquetas: ['urgente'], nota_interna: 'Pidió que llegue antes del viernes',
        tipo: 'envio', courier: 'blue', empresa: null, tracking: '', fecha_programada: null, envio_estado: 'pendiente', proceso_estado: 'listo_preparar',
        cerrado: false, saldo: 0, total: 24000, prendas: 2, pagado: true, notas: '', accion: 'crear_envio',
        items: [IT('i1', 'Polera negra M', 12000, 12000, 'pagada'), IT('i2', 'Jeans azul 38', 12000, 12000, 'pagada')],
        fotos: [FOTO(1), FOTO(2)],
        cliente: { cliente_id: 'c1', tiktok_user: 'maria_tt', nombre_real: 'María López', whatsapp: '+56 9 1111 2222', correo: 'maria@mail.cl',
                   direccion: 'Av. Providencia 1234', comuna: 'Providencia', ciudad: 'Santiago', contacto: '', datos_envio: 'depto 41, tocar el timbre' }
    },
    {
        proceso_id: 'p2', cliente_id: 'c2', columna: 'paket', orden: 2, etiquetas: [], nota_interna: '',
        tipo: 'envio', courier: 'paket', empresa: null, tracking: '', fecha_programada: null, envio_estado: null, proceso_estado: 'pago_parcial',
        cerrado: false, saldo: 6000, total: 12000, prendas: 1, pagado: false, notas: '', accion: 'pagar',
        items: [IT('i3', 'Vestido floreado', 12000, 6000, 'adjudicada')],
        fotos: [],
        cliente: { cliente_id: 'c2', tiktok_user: 'jorge_v', nombre_real: 'Jorge Vera', whatsapp: '+56 9 3333 4444', correo: '',
                   direccion: '', comuna: 'Valparaíso', ciudad: 'Valparaíso', contacto: '', datos_envio: '' }
    },
    {
        proceso_id: 'p3', cliente_id: 'c3', columna: 'presencial', orden: 3, etiquetas: ['retiro'], nota_interna: '',
        tipo: 'presencial', courier: '', empresa: null, tracking: '', fecha_programada: null, envio_estado: 'pendiente', proceso_estado: 'esperando_pago',
        cerrado: false, saldo: 8000, total: 8000, prendas: 1, pagado: false, notas: 'el sábado en el centro', accion: 'pagar',
        items: [IT('i4', 'Falda jean S', 8000, 0, 'adjudicada')],
        fotos: [FOTO(3)],
        cliente: { cliente_id: 'c3', tiktok_user: 'sofi.cl', nombre_real: 'Sofía Ramírez', whatsapp: '+56 9 5555 6666', correo: 'sofi@mail.cl',
                   direccion: '', comuna: 'Ñuñoa', ciudad: 'Santiago', contacto: '', datos_envio: '' }
    },
    {
        proceso_id: 'p4', cliente_id: 'c4', columna: 'sin_definir', orden: 4, etiquetas: [], nota_interna: '',
        tipo: null, courier: '', empresa: null, tracking: '', fecha_programada: null, envio_estado: null, proceso_estado: 'esperando_pago',
        cerrado: false, saldo: 14000, total: 14000, prendas: 2, pagado: false, notas: '', accion: 'pagar',
        items: [IT('i5', 'Parka negra', 9000, 0, 'adjudicada'), IT('i6', 'Bufanda', 5000, 0, 'adjudicada')],
        fotos: [],
        cliente: { cliente_id: 'c4', tiktok_user: 'cami_tt', nombre_real: '', whatsapp: '+56 9 7777 8888', correo: '',
                   direccion: '', comuna: '', ciudad: '', contacto: '', datos_envio: '' }
    },
    {
        proceso_id: 'p5', cliente_id: 'c5', columna: 'sin_definir', orden: 5, etiquetas: ['revisar'], nota_interna: '',
        tipo: 'envio', courier: '', empresa: null, tracking: '', fecha_programada: null, envio_estado: null, proceso_estado: 'pagado',
        cerrado: false, saldo: 0, total: 5000, prendas: 1, pagado: true, notas: '', accion: 'abrir_chat',
        items: [IT('i7', 'Cinturón', 5000, 5000, 'pagada')],
        fotos: [],
        cliente: { cliente_id: 'c5', tiktok_user: 'vale.rc', nombre_real: 'Valentina Rojas', whatsapp: '+56 9 9999 0000', correo: '',
                   direccion: 'Los Aromos 55', comuna: 'La Florida', ciudad: 'Santiago', contacto: '', datos_envio: '' }
    },
    {
        proceso_id: 'p6', cliente_id: 'c6', columna: 'listo', orden: 6, etiquetas: [], nota_interna: '',
        tipo: 'envio', courier: 'blue', empresa: 'blue_express', tracking: 'BX998877', fecha_programada: '2026-10-30', envio_estado: 'entregado', proceso_estado: 'completado',
        cerrado: true, saldo: 0, total: 16000, prendas: 1, pagado: true, notas: '', accion: 'abrir_chat',
        items: [IT('i8', 'Chaqueta', 16000, 16000, 'entregada')],
        fotos: [],
        cliente: { cliente_id: 'c6', tiktok_user: 'anto_m', nombre_real: 'Antonia Muñoz', whatsapp: '+56 9 2222 3333', correo: '',
                   direccion: 'San Diego 900', comuna: 'Santiago', ciudad: 'Santiago', contacto: '', datos_envio: '' }
    },
    {
        proceso_id: 'p7', cliente_id: 'c7', columna: 'listo', orden: 7, etiquetas: [], nota_interna: '',
        tipo: 'presencial', courier: '', empresa: null, tracking: '', fecha_programada: null, envio_estado: 'entregado', proceso_estado: 'entregado_por_cobrar',
        cerrado: false, saldo: 7000, total: 7000, prendas: 1, pagado: false, notas: '', accion: 'pagar',
        items: [IT('i9', 'Top tejido', 7000, 0, 'entregada')],
        fotos: [],
        cliente: { cliente_id: 'c7', tiktok_user: 'pau.v', nombre_real: 'Paula Vega', whatsapp: '+56 9 4444 5555', correo: '',
                   direccion: '', comuna: 'Maipú', ciudad: 'Santiago', contacto: '', datos_envio: '' }
    },
    {
        proceso_id: 'p8', cliente_id: 'c8', columna: 'otros', orden: 8, etiquetas: [], nota_interna: '',
        tipo: 'envio', courier: 'otros', empresa: 'chilexpress', tracking: 'CHX1122', fecha_programada: '2026-11-06', envio_estado: 'en_proceso', proceso_estado: 'envio_proceso',
        cerrado: false, saldo: 0, total: 9000, prendas: 1, pagado: true, notas: '', accion: 'entregado',
        items: [IT('i10', 'Polerón gris', 9000, 9000, 'pagada')],
        fotos: [],
        cliente: { cliente_id: 'c8', tiktok_user: 'flor.m', nombre_real: 'Florencia Mena', whatsapp: '+56 9 1212 3434', correo: '',
                   direccion: 'Bilbao 777', comuna: 'Providencia', ciudad: 'Santiago', contacto: '', datos_envio: '' }
    }
];

const FIXTURES = {
    get_mis_proyectos: [{ proyecto: 'ventas_live', nombre_negocio: 'Pico Store', estado: 'activo', sub_plan: 'vl_free', whatsapp: '+56 9 4832 7766' }],
    vl_workspace_info: { whatsapp: '+56 9 4832 7766', nombre_negocio: 'Pico Store' },
    vl_wa_conexion_info: { conectado: true, tiene_token: true, tiene_app_secret: true, wa_phone_id: '123456789012345' },
    vl_dashboard: { live_actual: null, ventas: { hoy: 0 }, pagos: { hoy: 0 }, pendiente_total: 0 },
    vl_live_actual: null,
    vl_wa_chats_listar: { chats: [] },
    vl_config_faltantes: { faltantes: [], recomendados: [] },
    vl_envios_pendientes: { ok: true, revisar_chat: true, grupos: {}, tarjetas: TARJETAS },
    vl_tablero_mover: { ok: true, columna: 'blue', tipo: 'envio', courier: 'blue', estado: 'listo_preparar' },
    vl_tablero_orden: { ok: true, guardadas: 1 },
    vl_tablero_tarjeta: { ok: true, etiquetas: [] },
    vl_item_editar: { ok: true },
    vl_wa_mensaje_media_borrar: { ok: true, media_path: 't/chat/1.jpg', eliminado: true },
    vl_actualizar_cliente: { ok: true },
    vl_wa_chat_por_cliente: { chat_id: null },
    vl_panel_procesos: { conteos: {}, procesos: [] },
    vl_buscar_clientes: { clientes: [] },
    vl_finanzas_resumen: { ingresos: {}, inversiones: {}, gastos: {}, resultado: {}, ultimos_gastos: [] }
};

function servirDist() {
    return new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
            const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
            const f = path.join(DIST, rel);
            if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
                res.writeHead(404); res.end('no encontrado'); return;
            }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
            fs.createReadStream(f).pipe(res);
        });
        srv.listen(PORT, '127.0.0.1', () => resolve(srv));
    });
}

function b64(o) { return Buffer.from(JSON.stringify(o)).toString('base64'); }

const USUARIO = {
    id: 'u1', aud: 'authenticated', role: 'authenticated',
    email: 'demo@demo.com', created_at: new Date().toISOString(),
    user_metadata: { nombre: 'Demo', rol: 'admin', tenant_id: '00000000-0000-4000-8000-000000000001', whatsapp: '' },
    app_metadata: { provider: 'email', providers: ['email'] }
};
const EXP = Math.floor(Date.now() / 1000) + 3600;
const JWT_ACCESO = 'x.' + b64({ sub: 'u1', email: 'demo@demo.com', exp: EXP, iat: EXP - 3600, user_metadata: USUARIO.user_metadata }) + '.y';
function sesion() {
    return { access_token: JWT_ACCESO, token_type: 'bearer', expires_in: 3600,
        expires_at: EXP, refresh_token: 'refresh-simulado', user: USUARIO };
}

let fallos = 0;
function check(nombre, cond, extra) {
    console.log((cond ? '  ✔ ' : '  ✘ ') + nombre + (cond ? '' : '  → ' + JSON.stringify(extra)));
    if (!cond) fallos++;
}

(async () => {
    if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });
    const srv = await servirDist();
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const errores = [];
    const llamadas = [];

    await ctx.route(`**://${HOST}/**`, (route) => {
        const req = route.request();
        const u = req.url();
        if (/\/storage\/v1\/object\/sign\//.test(u)) {
            let cuerpo = {};
            try { cuerpo = JSON.parse(req.postData() || '{}'); } catch (_) { /* sin cuerpo */ }
            const paths = Array.isArray(cuerpo.paths) ? cuerpo.paths : [];
            const data = paths.map(p => ({ path: p, signedURL: `https://${HOST}/test.png?p=${encodeURIComponent(p)}`, error: null }));
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
        }
        if (u.includes('test.png')) {
            return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
        }
        if (u.includes('/storage/v1/object/')) {
            return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        }
        if (u.includes('/auth/v1/user')) {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(USUARIO) });
        }
        if (u.includes('/auth/v1/')) {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sesion()) });
        }
        const m = u.match(/\/rest\/v1\/rpc\/([A-Za-z0-9_]+)/);
        if (m) {
            let cuerpo = null;
            try { cuerpo = JSON.parse(req.postData() || 'null'); } catch (_) { cuerpo = null; }
            llamadas.push({ nombre: m[1], cuerpo });
            const fixture = FIXTURES[m[1]] !== undefined ? FIXTURES[m[1]] : { ok: false, error: 'sin fixture: ' + m[1] };
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    const sesionSb = sesion();
    await ctx.addInitScript(([tk, rk, ud, claveSb, sesionJson]) => {
        localStorage.setItem('agendapro_access_token', tk);
        localStorage.setItem('agendapro_refresh_token', rk);
        localStorage.setItem('agendapro_user_data', ud);
        localStorage.setItem(claveSb, sesionJson);
    }, [JWT_ACCESO, 'refresh-simulado', JSON.stringify(USUARIO), `sb-${HOST.split('.')[0]}-auth-token`, JSON.stringify(sesionSb)]);

    const page = await ctx.newPage();
    page.on('pageerror', e => errores.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errores.push('console.error: ' + m.text()); });

    await page.goto(`http://127.0.0.1:${PORT}/ventas-live.html`, { waitUntil: 'load' });
    await page.waitForSelector('#vl-view-live .vl-live-grid', { timeout: 20000 });

    console.log('\n[1] Abrir la pestaña Envíos');
    await page.click('.vl-tab[data-view="envios"]');
    await page.waitForSelector('#ve-board .kanban-card', { timeout: 10000 });
    await page.waitForTimeout(400);

    const cols = await page.evaluate(() => [...document.querySelectorAll('#ve-board .vl-tcol')].map(c => ({
        col: c.dataset.col, titulo: c.querySelector('.kanban-list-titulo').textContent.trim(),
        n: c.querySelectorAll('.kanban-card').length
    })));
    console.log('   columnas:', JSON.stringify(cols));
    check('hay 6 columnas (incluye Otros porque hay un courier)', cols.length === 6, cols);
    check('Otros couriers tiene 1 tarjeta', cols.find(c => c.col === 'otros')?.n === 1, cols);
    check('Blue tiene 1 tarjeta', cols.find(c => c.col === 'blue')?.n === 1, cols);
    check('Paket tiene 1 tarjeta', cols.find(c => c.col === 'paket')?.n === 1, cols);
    check('Presencial tiene 1 tarjeta', cols.find(c => c.col === 'presencial')?.n === 1, cols);
    check('Sin definir tiene 2 tarjetas', cols.find(c => c.col === 'sin_definir')?.n === 2, cols);
    check('Listos tiene 2 tarjetas', cols.find(c => c.col === 'listo')?.n === 2, cols);

    const resumen = await page.textContent('#ve-resumen');
    check('el resumen cuenta los pedidos en curso', /7 pedido/.test(resumen), resumen);

    const tarjeta = await page.evaluate(() => {
        const el = document.querySelector('.kanban-card[data-proceso="p1"]');
        return {
            chips: [...el.querySelectorAll('.kanban-chip')].map(c => c.textContent.trim()),
            titulo: el.querySelector('.kanban-card-titulo').textContent.trim(),
            fotos: el.querySelectorAll('.vl-tcard-fotos img').length,
            monto: el.querySelector('.vl-tcard-monto').textContent.trim()
        };
    });
    console.log('   tarjeta p1:', JSON.stringify(tarjeta));
    check('muestra @usuario y nombre', tarjeta.titulo.includes('@maria_tt') && tarjeta.titulo.includes('María'), tarjeta.titulo);
    check('etiqueta pagado', tarjeta.chips.includes('pagado'), tarjeta.chips);
    check('etiqueta libre urgente', tarjeta.chips.includes('urgente'), tarjeta.chips);
    check('2 miniaturas de fotos', tarjeta.fotos === 2, tarjeta);
    check('total formateado', tarjeta.monto.includes('24.000'), tarjeta.monto);

    await page.screenshot({ path: path.join(SHOTS, 'vl-tablero-pc-1440.png'), fullPage: false });
    await page.evaluate(() => { const b = document.querySelector('#ve-board'); b.scrollLeft = b.scrollWidth; });
    await page.waitForTimeout(300);
    const listos = await page.evaluate(() => [...document.querySelectorAll('.vl-tcol[data-col="listo"] .kanban-card')].map(c => ({
        proceso: c.dataset.proceso,
        chips: [...c.querySelectorAll('.kanban-chip')].map(x => x.textContent.trim()),
        bloqueda: c.dataset.bloqueada
    })));
    console.log('   listos:', JSON.stringify(listos));
    check('p6 (pagado y entregado) sin deuda', !!listos.find(l => l.proceso === 'p6' && l.chips.includes('entregado')), listos);
    check('p7 (entregado sin pagar) avisa falta cobrar', !!listos.find(l => l.proceso === 'p7' && l.chips.some(c => c.includes('falta cobrar'))), listos);
    check('las tarjetas entregadas no se arrastran', listos.every(l => l.bloqueda === '1'), listos);
    await page.screenshot({ path: path.join(SHOTS, 'vl-tablero-pc-listos.png'), fullPage: false });
    await page.evaluate(() => { document.querySelector('#ve-board').scrollLeft = 0; });

    console.log('\n[2] Abrir la tarjeta (detalle estilo Trello)');
    await page.click('.kanban-card[data-proceso="p1"] .kanban-card-titulo');
    await page.waitForSelector('.vl-card-overlay .vl-card-modal', { timeout: 8000 });
    const ficha = await page.evaluate(() => ({
        items: [...document.querySelectorAll('#vc-items .vl-item-desc')].map(e => e.textContent.trim()),
        precios: [...document.querySelectorAll('#vc-items .vl-item-precio')].map(e => e.textContent.trim()),
        totales: document.querySelector('.vl-card-totales')?.textContent.replace(/\s+/g, ' ').trim(),
        fotos: document.querySelectorAll('#vc-fotos .vl-card-foto').length,
        etiquetas: [...document.querySelectorAll('.vl-etq.activa')].map(e => e.textContent.trim()),
        nombre: document.querySelector('#vc-nombre')?.value,
        direccion: document.querySelector('#vc-direccion')?.value,
        capas: window.__vlCapas()
    }));
    console.log('   ficha:', JSON.stringify(ficha));
    check('lista las prendas con su precio', ficha.items.length === 2 && ficha.precios[0].includes('12.000'), ficha);
    check('muestra total/pagado/saldo', /Total/.test(ficha.totales) && /Saldo/.test(ficha.totales), ficha.totales);
    check('muestra las 2 fotos', ficha.fotos === 2, ficha.fotos);
    check('precarga los datos del chat', ficha.nombre === 'María López' && ficha.direccion.includes('Providencia'), ficha);
    check('capa vl-card registrada', JSON.stringify(ficha.capas).includes('vl-card'), ficha.capas);

    await page.screenshot({ path: path.join(SHOTS, 'vl-tablero-ficha-pc.png'), fullPage: false });

    console.log('\n[3] Editar un dato leído del chat (doble confirmación)');
    await page.fill('#vc-direccion', 'Av. Providencia 1234, depto 52');
    await page.click('#vc-guardar-datos');
    await page.waitForSelector('.vl-confirm-overlay', { timeout: 5000 });
    check('pide confirmación antes de guardar', true);
    await page.click('.vl-confirm button[data-r="1"]');
    await page.waitForTimeout(600);
    const llamadaDatos = llamadas.filter(l => l.nombre === 'vl_actualizar_cliente').pop();
    console.log('   RPC:', JSON.stringify(llamadaDatos));
    check('guarda la dirección corregida', !!llamadaDatos && llamadaDatos.cuerpo.p_direccion.includes('depto 52'), llamadaDatos);
    check('no borra los datos que no cambió', !!llamadaDatos && llamadaDatos.cuerpo.p_nombre_real === 'María López', llamadaDatos);

    console.log('\n[4] Borrar una foto (doble confirmación)');
    await page.click('#vc-fotos .vl-card-foto-del');
    await page.waitForSelector('.vl-confirm-overlay', { timeout: 5000 });
    await page.click('.vl-confirm button[data-r="1"]');
    await page.waitForTimeout(600);
    const llamadaFoto = llamadas.filter(l => l.nombre === 'vl_wa_mensaje_media_borrar').pop();
    check('borra la foto del chat', !!llamadaFoto && !!llamadaFoto.cuerpo.p_mensaje_id, llamadaFoto);

    console.log('\n[5] Atrás con la tarjeta abierta');
    await page.waitForSelector('.vl-card-overlay', { timeout: 8000 });
    await page.goBack();
    await page.waitForTimeout(500);
    const trasAtras = await page.evaluate(() => ({
        ficha: !!document.querySelector('.vl-card-overlay'),
        pagina: location.pathname.split('/').pop(),
        vista: [...document.querySelectorAll('.vl-view.active')].map(v => v.id)
    }));
    console.log('   estado:', JSON.stringify(trasAtras));
    check('la tarjeta se cierra', !trasAtras.ficha, trasAtras);
    check('NO se sale de ventas-live.html', trasAtras.pagina === 'ventas-live.html', trasAtras);

    console.log('\n[6] Arrastrar de "Sin definir" a Blue');
    await page.waitForSelector('.kanban-card[data-proceso="p5"]', { timeout: 8000 });
    await page.dragAndDrop('.kanban-card[data-proceso="p5"]', '.vl-tcol[data-col="blue"] .kanban-list-cards');
    await page.waitForTimeout(400);
    const hayConfirm = await page.evaluate(() => !!document.querySelector('.vl-confirm-overlay'));
    check('pide confirmación al mover', hayConfirm);
    if (hayConfirm) await page.click('.vl-confirm button[data-r="1"]');
    await page.waitForTimeout(700);
    const llamadaMover = llamadas.filter(l => l.nombre === 'vl_tablero_mover').pop();
    console.log('   RPC:', JSON.stringify(llamadaMover));
    check('mueve a blue (RPC)', !!llamadaMover && llamadaMover.cuerpo.p_columna === 'blue', llamadaMover);

    console.log('\n[7] Buscar');
    await page.fill('#ve-buscar', 'sofía');
    await page.waitForTimeout(300);
    const filtradas = await page.evaluate(() => document.querySelectorAll('#ve-board .kanban-card').length);
    check('el buscador filtra por nombre', filtradas === 1, filtradas);
    await page.fill('#ve-buscar', '');
    await page.waitForTimeout(300);

    console.log('\n[8] Móvil 390x844');
    const pageM = await ctx.newPage();
    await pageM.setViewportSize({ width: 390, height: 844 });
    await pageM.goto(`http://127.0.0.1:${PORT}/ventas-live.html`, { waitUntil: 'load' });
    await pageM.waitForSelector('#vl-view-live .vl-live-grid', { timeout: 20000 });
    await pageM.click('.vl-tab[data-view="envios"]');
    await pageM.waitForSelector('#ve-board .kanban-card', { timeout: 10000 });
    await pageM.waitForTimeout(400);
    const ancho = await pageM.evaluate(() => {
        const col = document.querySelector('#ve-board .kanban-list');
        const board = document.querySelector('#ve-board');
        return { col: col?.getBoundingClientRect().width, board: board?.getBoundingClientRect().width, scroll: board?.scrollWidth };
    });
    console.log('   medidas móvil:', JSON.stringify(ancho));
    check('la columna ocupa ~88% del ancho', ancho.col > 300 && ancho.col < 380, ancho);
    check('el tablero se desplaza en horizontal', ancho.scroll > ancho.board, ancho);
    await pageM.screenshot({ path: path.join(SHOTS, 'vl-tablero-movil-390.png'), fullPage: false });

    console.log('\n[9] Errores de consola');
    if (errores.length) console.log(errores.map(e => '   - ' + e).join('\n'));
    check('sin errores de JavaScript', errores.length === 0, errores);

    await browser.close();
    srv.close();
    console.log(`\n${fallos ? '✘ ' + fallos + ' fallo(s)' : '✔ todo OK'}`);
    process.exit(fallos ? 1 : 0);
})().catch(e => { console.error('ERROR:', e); process.exit(2); });
