// verify-vl-atras.js
// VALIDACIÓN del botón "atrás" del celular en Ventas Live.
//
// Comprueba, sobre el build REAL de dist/ y con Supabase simulado (no toca
// datos), que apretar atrás deshace UN paso y no se va de la página:
//
//   chat abierto      → atrás → lista de conversaciones
//   hoja ¿Quién es?   → atrás → chat
//   modal ＋ Prenda   → atrás → chat
//   lista (cajón)     → atrás → cajón cerrado, seguimos en ventas-live.html
//   ficha de cliente  → atrás → lista de clientes
//   pestaña Clientes  → atrás → LIVE
//   (sin capas)       → atrás → sale de la página, como siempre
//
// Uso: node verify-vl-atras.js
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, 'dist');
const PORT = Number(process.env.VL_ATRAS_PORT || 8793);
const HOST = 'dfcfimipkfhitlsyixqu.supabase.co';

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json',
    '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8'
};

// ── Datos de ejemplo para las RPCs del workspace ────────────────────
const CHATS = [
    { id: 'c1', tiktok_user: 'maria_tt', nombre_real: 'María López', wa_id: '+56911112222', estado: 'esperando_pago',
      modo: 'bot', sin_leer: 2, ultimo_mensaje: 'Te mandé el comprobante de la transferencia 🙌', ultimo_en: new Date().toISOString(),
      tiene_aviso: true, aviso_tipo: 'comprobante', aviso_detalle: 'Mandó una foto del comprobante' },
    { id: 'c2', tiktok_user: 'jorge_v', nombre_real: null, wa_id: '+56933334444', estado: 'esperando_datos_envio',
      modo: 'humano', sin_leer: 0, ultimo_mensaje: '¿A qué dirección lo mando?', ultimo_en: new Date(Date.now() - 3600e3).toISOString(),
      tiene_aviso: false, aviso_tipo: null, aviso_detalle: null },
    { id: 'c3', tiktok_user: 'sofi.cl', nombre_real: 'Sofía Ramírez', wa_id: '+56955556666', estado: 'nuevo',
      modo: 'bot', sin_leer: 0, ultimo_mensaje: 'Hola! vi el live de hoy', ultimo_en: new Date(Date.now() - 86400e3).toISOString(),
      tiene_aviso: false, aviso_tipo: null, aviso_detalle: null }
];

const MENSAJES = [
    { direction: 'in',  body: 'Hola! quiero la polera negra del live', origen: 'cliente', creado_en: new Date(Date.now() - 900e3).toISOString() },
    { direction: 'out', body: 'Hola María! anotada con la polera negra talla M a $8.000 🛍️ Te mando los datos para transferir.', origen: 'bot', creado_en: new Date(Date.now() - 840e3).toISOString() },
    { direction: 'in',  body: 'Listo, ya transferí 🙌 te mandé el comprobante por acá', origen: 'cliente', creado_en: new Date(Date.now() - 300e3).toISOString() },
    { direction: 'out', body: 'Perfecto, reviso el pago y te confirmo la entrega.', origen: 'humano', creado_en: new Date(Date.now() - 240e3).toISOString() }
];

const FIXTURES = {
    get_mis_proyectos: [{ proyecto: 'ventas_live', nombre_negocio: 'Pico Store', estado: 'activo', sub_plan: 'vl_free', whatsapp: '+56 9 4832 7766' }],
    vl_workspace_info: { whatsapp: '+56 9 4832 7766', nombre_negocio: 'Pico Store' },
    vl_wa_conexion_info: { conectado: true, tiene_token: true, tiene_app_secret: true, wa_phone_id: '123456789012345' },
    vl_dashboard: { live_actual: { live_id: 'l1', etiqueta: 'LIVE · 11 sep', ventas: 86000, prendas: 11 },
                    ventas: { hoy: 124000 }, pagos: { hoy: 78000 }, pendiente_total: 46000 },
    vl_wa_chats_listar: { chats: CHATS },
    vl_wa_chat_hilo: { chat: CHATS[0], mensajes: MENSAJES },
    vl_wa_chat_por_cliente: { chat_id: 'c1', modo: 'bot' },

    // ── Secciones Procesos / Clientes / Envíos / Finanzas ──
    vl_panel_procesos: {
        conteos: { esperando_pago: 2, pagado_sin_decision: 1, envio_programado: 1 },
        procesos: [
            { proceso_id: 'p1', grupo: 'esperando_pago', estado: 'esperando_pago', dias_espera: 1, prendas: 2, total: 16000, pagado: 0, saldo: 16000, envio: {},
              cliente: { tiktok_user: 'maria_tt', nombre_real: 'María López', whatsapp: '+56 9 1111 2222' } },
            { proceso_id: 'p2', grupo: 'esperando_pago', estado: 'pago_parcial', dias_espera: 4, prendas: 1, total: 12000, pagado: 6000, saldo: 6000, envio: {},
              cliente: { tiktok_user: 'jorge_v', nombre_real: null, whatsapp: '+56 9 3333 4444' } },
            { proceso_id: 'p3', grupo: 'pagado_sin_decision', estado: 'pagado', dias_espera: 0, prendas: 3, total: 24000, pagado: 24000, saldo: 0, envio: {},
              cliente: { tiktok_user: 'sofi.cl', nombre_real: 'Sofía Ramírez', whatsapp: '+56 9 5555 6666' } },
            { proceso_id: 'p4', grupo: 'envio_programado', estado: 'envio_programado', dias_espera: 0, prendas: 2, total: 18000, pagado: 18000, saldo: 0,
              envio: { empresa: 'blue_express', tracking: 'BX123456', fecha_programada: '2026-09-12' },
              cliente: { tiktok_user: 'cami_tt', nombre_real: 'Camila Soto', whatsapp: '+56 9 7777 8888' } }
        ]
    },
    vl_envios_pendientes: {
        grupos: {
            hoy: [{ proceso_id: 'p4', tipo: 'envio', empresa: 'blue_express', tracking: 'BX123456', fecha_programada: '2026-09-11', envio_estado: 'pendiente',
                    cliente: { tiktok_user: 'cami_tt', nombre_real: 'Camila Soto', whatsapp: '+56 9 7777 8888', direccion: 'Av. Providencia 1234', comuna: 'Providencia', ciudad: 'Santiago' } }],
            manana: [{ proceso_id: 'p5', tipo: 'presencial', empresa: null, tracking: null, fecha_programada: '2026-09-12', envio_estado: 'pendiente',
                       cliente: { tiktok_user: 'jorge_v', nombre_real: null, whatsapp: '+56 9 3333 4444', direccion: 'Calle Falsa 123', comuna: 'Valparaíso', ciudad: 'Valparaíso' } }],
            proximos: [], presenciales: [], en_proceso: []
        }
    },
    vl_finanzas_resumen: {
        ingresos: { ventas_total: 480000, ventas_mes: 210000, recibido_total: 390000, pendiente: 90000 },
        inversiones: { total: 200000, mes: 80000 },
        gastos: { total: 35000, mes: 15000 },
        resultado: { ganancia_estimada: 155000, flujo_caja: 355000 },
        ultimos_gastos: [
            { gasto_id: 'g1', tipo: 'gasto', concepto: 'Bolsas y etiquetas', monto: 12000, fecha: '2026-09-10' },
            { gasto_id: 'g2', tipo: 'inversion', concepto: 'Compra de prendas', monto: 80000, fecha: '2026-09-09' }
        ]
    },
    vl_buscar_clientes: {
        clientes: [
            { cliente_id: 'c1', tiktok_user: 'maria_tt', nombre_real: 'María López', whatsapp: '+56 9 1111 2222', ciudad: 'Santiago', categoria: 'confiable',
              proceso_activo: { estado: 'esperando_pago', prendas: 2, saldo: 16000 } },
            { cliente_id: 'c2', tiktok_user: 'jorge_v', nombre_real: null, whatsapp: '+56 9 3333 4444', ciudad: 'Valparaíso', categoria: 'nuevo', proceso_activo: null },
            { cliente_id: 'c3', tiktok_user: 'sofi.cl', nombre_real: 'Sofía Ramírez', whatsapp: '+56 9 5555 6666', ciudad: 'Concepción', categoria: 'problematico',
              proceso_activo: { estado: 'pagado', prendas: 1, saldo: 0 } }
        ]
    },
    vl_ficha_cliente: {
        cliente: { cliente_id: 'c1', tiktok_user: 'maria_tt', nombre_real: 'María López', whatsapp: '+56 9 1111 2222', ciudad: 'Santiago', comuna: 'Ñuñoa',
                   direccion: 'Av. Providencia 1234', categoria: 'confiable' },
        contadores: { reservas: 4, concretadas: 3, no_concretadas: 1, comprado_total: 96000, pagado_total: 80000 },
        proceso_activo: { proceso_id: 'p1', estado: 'esperando_pago', prendas: 2, saldo: 16000, items: [{ descripcion: 'Polera negra M', precio: 8000 }, { descripcion: 'Jeans azul 38', precio: 8000 }], pagos: [], envio: null },
        historial: [{ estado: 'completado', cerrado_en: '2026-08-30', prendas: 2, total_comprado: 16000, total_pagado: 16000 }]
    }
};

// ── Servidor estático de dist/ ──────────────────────────────────────
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
const JWT_ACCESO = 'x.' + b64({ sub: 'u1', email: 'demo@demo.com', exp: EXP, iat: EXP - 3600,
    user_metadata: USUARIO.user_metadata }) + '.y';
function sesion() {
    return { access_token: JWT_ACCESO, token_type: 'bearer', expires_in: 3600,
        expires_at: EXP, refresh_token: 'refresh-simulado', user: USUARIO };
}

// Estado visible de la pantalla (lo que el dueño ve al apretar atrás).
function estado(page) {
    return page.evaluate(() => {
        const $ = (s) => document.querySelector(s);
        const drawer = $('#vl-drawer');
        const titulo = $('#vld-titulo');
        const foot = $('#vld-foot');
        const hoja = $('#vld-hoja');
        const busq = $('#vld-busq');
        const ficha = $('#vc-ficha');
        return {
            pagina: location.pathname.split('/').pop() || '',
            drawerAbierto: !!drawer && drawer.classList.contains('abierto'),
            listaVisible: !!titulo && titulo.textContent.trim() === 'Conversaciones',
            composerVisible: !!foot && foot.style.display !== 'none',
            hojaAbierta: !!hoja && !hoja.hidden,
            buscadorAbierto: !!busq && !busq.hidden,
            modalAbierto: !!document.querySelector('.vl-modal-overlay'),
            fichaAbierta: !!ficha && ficha.style.display === 'block',
            vista: [...document.querySelectorAll('.vl-view.active')].map(v => v.id),
            capas: (typeof window.__vlCapas === 'function') ? window.__vlCapas() : null
        };
    });
}

let fallos = 0;
function check(nombre, cond, extra) {
    console.log((cond ? '  ✔ ' : '  ✘ ') + nombre + (cond ? '' : '  → ' + JSON.stringify(extra)));
    if (!cond) fallos++;
}

(async () => {
    const srv = await servirDist();
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const errores = [];

    await ctx.route(`**://${HOST}/**`, (route) => {
        const u = route.request().url();
        if (u.includes('/auth/v1/user')) {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(USUARIO) });
        }
        if (u.includes('/auth/v1/')) {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sesion()) });
        }
        const m = u.match(/\/rest\/v1\/rpc\/([A-Za-z0-9_]+)/);
        const cuerpo = m && FIXTURES[m[1]] !== undefined
            ? FIXTURES[m[1]]
            : (m ? { ok: false, error: 'sin fixture: ' + m[1] } : {});
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(cuerpo) });
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

    const base = `http://127.0.0.1:${PORT}/ventas-live.html`;
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForSelector('#vl-view-live .vl-live-grid', { timeout: 20000 });
    await page.waitForTimeout(500);

    // ── 1. Cajón de conversaciones ──────────────────────────────────
    console.log('\n[1] Abrir Conversaciones');
    await page.click('#lv-chat-conv');
    await page.waitForTimeout(400);
    let s = await estado(page);
    check('el cajón queda abierto', s.drawerAbierto, s);
    check('hay 1 capa (conv-drawer)', JSON.stringify(s.capas) === '["conv-drawer"]', s.capas);
    check('seguimos en ventas-live.html', s.pagina === 'ventas-live.html', s.pagina);

    // ── 2. Conversación abierta + atrás → lista ─────────────────────
    console.log('\n[2] Abrir una conversación');
    await page.click('.vl-conv-item[data-chat="c1"]');
    await page.waitForSelector('#vld-foot[style*="flex"]', { timeout: 10000 });
    await page.waitForTimeout(400);
    s = await estado(page);
    check('la conversación está abierta (composer visible)', s.composerVisible, s);
    check('hay 2 capas (drawer + chat)', JSON.stringify(s.capas) === '["conv-drawer","conv-chat"]', s.capas);

    console.log('\n[2a] ATRÁS con la conversación abierta');
    await page.goBack();
    await page.waitForTimeout(500);
    s = await estado(page);
    check('vuelve a la LISTA de conversaciones', s.listaVisible && !s.composerVisible, s);
    check('el cajón sigue abierto', s.drawerAbierto, s);
    check('NO se fue de la página', s.pagina === 'ventas-live.html', s.pagina);
    check('queda 1 capa', JSON.stringify(s.capas) === '["conv-drawer"]', s.capas);

    // ── 3. Hoja "¿Quién es?" ────────────────────────────────────────
    console.log('\n[3] Abrir chat y la hoja ¿Quién es?');
    await page.click('.vl-conv-item[data-chat="c1"]');
    await page.waitForSelector('#vld-foot[style*="flex"]', { timeout: 10000 });
    await page.waitForTimeout(300);
    await page.click('#vld-menu-btn');
    await page.waitForTimeout(200);
    await page.click('#vld-menu-quien');
    await page.waitForSelector('#vld-hoja:not([hidden])', { timeout: 8000 });
    s = await estado(page);
    check('la hoja está abierta', s.hojaAbierta, s);
    check('capas = drawer + chat + hoja', JSON.stringify(s.capas) === '["conv-drawer","conv-chat","conv-quien"]', s.capas);

    console.log('\n[3a] ATRÁS con la hoja abierta');
    await page.goBack();
    await page.waitForTimeout(500);
    s = await estado(page);
    check('la hoja se cierra', !s.hojaAbierta, s);
    check('la conversación sigue abierta', s.composerVisible, s);
    check('NO se fue de la página', s.pagina === 'ventas-live.html', s.pagina);

    // ── 4. Modal (＋ Prenda) ────────────────────────────────────────
    console.log('\n[4] Abrir un modal desde el chat');
    await page.click('#vld-menu-btn');
    await page.waitForTimeout(200);
    await page.click('#vld-menu-prenda');
    await page.waitForSelector('.vl-modal-overlay', { timeout: 8000 });
    s = await estado(page);
    check('el modal está abierto', s.modalAbierto, s);

    console.log('\n[4a] ATRÁS con el modal abierto');
    await page.goBack();
    await page.waitForTimeout(500);
    s = await estado(page);
    check('el modal se cierra', !s.modalAbierto, s);
    check('la conversación sigue abierta', s.composerVisible, s);
    check('NO se fue de la página', s.pagina === 'ventas-live.html', s.pagina);

    // ── 5. Cerrar el cajón con atrás ────────────────────────────────
    console.log('\n[5] ATRÁS: chat → lista → cajón cerrado');
    await page.goBack();                    // chat → lista
    await page.waitForTimeout(400);
    s = await estado(page);
    check('vuelve a la lista', s.listaVisible && !s.composerVisible, s);
    await page.goBack();                    // lista → cajón cerrado
    await page.waitForTimeout(400);
    s = await estado(page);
    check('el cajón queda cerrado', !s.drawerAbierto, s);
    check('seguimos en ventas-live.html', s.pagina === 'ventas-live.html', s.pagina);
    check('sin capas', JSON.stringify(s.capas) === '[]', s.capas);

    // ── 6. Ficha de cliente ─────────────────────────────────────────
    console.log('\n[6] Pestaña Clientes → ficha');
    await page.click('.vl-tab[data-view="clientes"]');
    await page.waitForSelector('#vc-lista .vl-fila', { timeout: 10000 });
    s = await estado(page);
    check('la capa de sección está abierta', JSON.stringify(s.capas) === '["vl-seccion"]', s.capas);
    await page.click('#vc-lista .vl-fila');
    await page.waitForTimeout(600);
    s = await estado(page);
    check('la ficha está abierta', s.fichaAbierta, s);
    check('capas = sección + ficha', JSON.stringify(s.capas) === '["vl-seccion","cli-ficha"]', s.capas);

    console.log('\n[6a] ATRÁS con la ficha abierta');
    await page.goBack();
    await page.waitForTimeout(500);
    s = await estado(page);
    check('vuelve a la LISTA de clientes', !s.fichaAbierta, s);
    check('sigue en la pestaña Clientes', s.vista.includes('vl-view-clientes'), s.vista);
    check('NO se fue de la página', s.pagina === 'ventas-live.html', s.pagina);

    // ── 7. Pestaña → LIVE ───────────────────────────────────────────
    console.log('\n[7] ATRÁS estando en una pestaña');
    await page.goBack();
    await page.waitForTimeout(500);
    s = await estado(page);
    check('vuelve a LIVE', s.vista.includes('vl-view-live'), s.vista);
    check('la pestaña LIVE queda activa', await page.evaluate(() => {
        const t = document.querySelector('.vl-tab.active');
        return !!t && t.dataset.view === 'live';
    }), s);
    check('sin capas', JSON.stringify(s.capas) === '[]', s.capas);
    check('seguimos en ventas-live.html', s.pagina === 'ventas-live.html', s.pagina);

    // ── 8. Sin capas: atrás sale como siempre ───────────────────────
    console.log('\n[8] ATRÁS sin nada abierto (comportamiento normal)');
    const antes = page.url();
    await page.goBack();
    await page.waitForTimeout(600);
    const salio = (page.url() !== antes) && !page.url().endsWith('/ventas-live.html');
    check('sale de la página (atrás normal del navegador)', salio, page.url());

    // ── 9. Cierre por UI no deja entradas mudas ─────────────────────
    console.log('\n[9] Cerrar con la X (no debe dejar "atrás" mudo)');
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForSelector('#vl-view-live .vl-live-grid', { timeout: 20000 });
    await page.waitForTimeout(400);
    await page.click('#lv-chat-conv');
    await page.waitForTimeout(300);
    await page.click('.vl-conv-item[data-chat="c1"]');
    await page.waitForSelector('#vld-foot[style*="flex"]', { timeout: 10000 });
    await page.waitForTimeout(300);
    await page.click('#vld-cerrar');          // X: cierra chat + cajón de una
    await page.waitForTimeout(500);
    s = await estado(page);
    check('el cajón quedó cerrado', !s.drawerAbierto, s);
    check('sin capas tras la X', JSON.stringify(s.capas) === '[]', s.capas);
    await page.goBack();
    await page.waitForTimeout(600);
    check('el atrás posterior sale de la página (sin paso mudo)', !page.url().endsWith('/ventas-live.html'), page.url());

    // ── 10. Escritorio: mismo comportamiento ────────────────────────
    console.log('\n[10] Escritorio 1440x900 (mismo comportamiento)');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForSelector('#vl-view-live .vl-live-grid', { timeout: 20000 });
    await page.waitForTimeout(400);
    await page.click('#lv-chat-conv');
    await page.waitForTimeout(300);
    await page.click('.vl-conv-item[data-chat="c1"]');
    await page.waitForSelector('#vld-foot[style*="flex"]', { timeout: 10000 });
    await page.waitForTimeout(300);
    await page.goBack();
    await page.waitForTimeout(400);
    s = await estado(page);
    check('escritorio: atrás vuelve a la lista', s.listaVisible && !s.composerVisible, s);
    check('escritorio: no se fue de la página', s.pagina === 'ventas-live.html', s.pagina);

    // ── 11. Buscador dentro de la conversación ─────────────────────
    console.log('\n[11] Buscador dentro de la conversación');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForSelector('#vl-view-live .vl-live-grid', { timeout: 20000 });
    await page.waitForTimeout(400);
    await page.click('#lv-chat-conv');
    await page.waitForTimeout(300);
    await page.click('.vl-conv-item[data-chat="c1"]');
    await page.waitForSelector('#vld-foot[style*="flex"]', { timeout: 10000 });
    await page.waitForTimeout(300);
    await page.click('#vld-menu-btn');
    await page.waitForTimeout(200);
    await page.click('#vld-menu-buscar');
    await page.waitForSelector('#vld-busq:not([hidden])', { timeout: 8000 });
    s = await estado(page);
    check('el buscador está abierto', s.buscadorAbierto, s);
    await page.goBack();
    await page.waitForTimeout(500);
    s = await estado(page);
    check('atrás cierra el buscador', !s.buscadorAbierto, s);
    check('la conversación sigue abierta', s.composerVisible, s);
    check('NO se fue de la página', s.pagina === 'ventas-live.html', s.pagina);

    // ── 12. Ficha + modal (dos capas encima de la sección) ──────────
    console.log('\n[12] Ficha de cliente → modal encima');
    await page.goBack();                 // chat → lista
    await page.waitForTimeout(500);
    await page.goBack();                 // lista → cajón cerrado
    await page.waitForFunction(() => {
        const d = document.getElementById('vl-drawer');
        return d && !d.classList.contains('abierto');
    }, null, { timeout: 5000 });
    await page.waitForTimeout(500);      // deja terminar la animación de salida
    await page.click('.vl-tab[data-view="clientes"]');
    await page.waitForSelector('#vc-lista .vl-fila', { timeout: 10000 });
    await page.click('#vc-lista .vl-fila');
    await page.waitForTimeout(600);
    const hayEditar = await page.evaluate(() => !!document.querySelector('#vf-editar'));
    if (hayEditar) {
        await page.click('#vf-editar');
        await page.waitForSelector('.vl-modal-overlay', { timeout: 8000 });
        s = await estado(page);
        check('modal sobre la ficha (sección + ficha + modal)',
            JSON.stringify(s.capas) === '["vl-seccion","cli-ficha","vl-modal"]', s.capas);
        await page.goBack();
        await page.waitForTimeout(500);
        s = await estado(page);
        check('atrás cierra el modal', !s.modalAbierto, s);
        check('la ficha sigue abierta', s.fichaAbierta, s);
        check('NO se fue de la página', s.pagina === 'ventas-live.html', s.pagina);
        await page.goBack();
        await page.waitForTimeout(500);
        s = await estado(page);
        check('siguiente atrás vuelve a la lista de clientes', !s.fichaAbierta, s);
        await page.goBack();
        await page.waitForTimeout(500);
        s = await estado(page);
        check('y el siguiente vuelve a LIVE', s.vista.includes('vl-view-live'), s.vista);
        check('sin capas', JSON.stringify(s.capas) === '[]', s.capas);
    } else {
        console.log('  (sin botón Editar perfil en este fixture: se omite)');
    }

    const erroresReales = errores.filter(e => !/sin fixture|Failed to load resource|localStorage/i.test(e));
    console.log('\nErrores de consola: ' + (erroresReales.length ? '\n  ' + erroresReales.join('\n  ') : 'ninguno'));
    console.log('\n' + (fallos ? '✘ ' + fallos + ' comprobación(es) fallaron' : '✔ TODO OK'));

    await browser.close();
    srv.close();
    process.exit(fallos ? 1 : 0);
})().catch(e => { console.error('FALLO DEL TEST:', e); process.exit(1); });
