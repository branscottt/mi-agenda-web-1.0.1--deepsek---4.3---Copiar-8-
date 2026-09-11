// verify-vl-tema.js
// Validación visual de Ventas Live (tema morado+negro, chat con aire y
// layout tablet/móvil) sobre el build REAL de dist/.
//
// Cómo funciona:
//  1. Sirve dist/ en localhost (mismo build que se despliega).
//  2. Intercepta el dominio de Supabase y responde las RPCs con datos de
//     ejemplo (no se toca la base real). El resto del frontend es el real.
//  3. Inyecta la sesión (JwtManager usa localStorage).
//  4. Abre ventas-live.html y mide/screenshot en web, tablet y móvil.
//
// Uso: node verify-vl-tema.js
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, 'dist');
const PORT = 8791;
const OUT = process.env.VL_SHOTS || '/tmp/vl-shots';
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

// ── Sesión simulada (admin del workspace Ventas Live) ───────────────
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
    return {
        access_token: JWT_ACCESO, token_type: 'bearer', expires_in: 3600,
        expires_at: EXP, refresh_token: 'refresh-simulado', user: USUARIO
    };
}

async function medir(page, etiqueta) {
    const m = await page.evaluate(() => {
        const r = (sel) => { const e = document.querySelector(sel); if (!e) return null;
            const b = e.getBoundingClientRect();
            return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
        const d = document.getElementById('vl-drawer');
        const dd = d ? d.getBoundingClientRect() : null;
        const tabs = [...document.querySelectorAll('.vl-tab')];
        return {
            viewport: { w: window.innerWidth, h: window.innerHeight },
            drawer: dd ? {
                gapDerecha: Math.round(window.innerWidth - dd.right),
                gapAbajo: Math.round(window.innerHeight - dd.bottom),
                gapArriba: Math.round(dd.top),
                ancho: Math.round(dd.width), alto: Math.round(dd.height)
            } : null,
            nav: (() => { const n = document.querySelector('.vl-nav'); return n ? {
                filas: new Set(tabs.map(t => t.getBoundingClientRect().top)).size,
                scrollX: n.scrollWidth > n.clientWidth + 1
            } : null; })(),
            scrollH: document.documentElement.scrollWidth,
            overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
            grid: r('.vl-live-grid'),
            chatMini: r('.vl-chat-mini-scroll'),
            chatCard: r('#lv-chat-card')
        };
    });
    console.log(`\n[${etiqueta}] ${JSON.stringify(m, null, 1)}`);
    return m;
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const srv = await servirDist();
    const browser = await chromium.launch();
    const ctx = await browser.newContext();
    const errores = [];

    await ctx.route(`**://${HOST}/**`, (route) => {
        const u = route.request().url();
        // Auth simulada: el guard legacy exige una sesión de Supabase válida.
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
        if (m && FIXTURES[m[1]] === undefined) errores.push('RPC sin fixture: ' + m[1]);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(cuerpo) });
    });

    const jwt = JWT_ACCESO;
    const sesionSb = sesion();
    await ctx.addInitScript(([tk, rk, ud, claveSb, sesionJson]) => {
        localStorage.setItem('agendapro_access_token', tk);
        localStorage.setItem('agendapro_refresh_token', rk);
        localStorage.setItem('agendapro_user_data', ud);
        // Sesión que lee supabase-js del storage (sb-<ref>-auth-token)
        localStorage.setItem(claveSb, sesionJson);
    }, [jwt, 'refresh-simulado', JSON.stringify(USUARIO), `sb-${HOST.split('.')[0]}-auth-token`, JSON.stringify(sesionSb)]);

    const page = await ctx.newPage();
    page.on('pageerror', e => errores.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errores.push('console.error: ' + m.text()); });

    const url = `http://127.0.0.1:${PORT}/ventas-live.html`;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('#vl-view-live .vl-live-grid', { timeout: 20000 });
    await page.waitForTimeout(600);

    const vistas = [
        { nombre: '1440-web', w: 1440, h: 900 },
        { nombre: '1024-tablet', w: 1024, h: 768 },
        { nombre: '834-tablet', w: 834, h: 1112 },
        { nombre: '390-movil', w: 390, h: 844 }
    ];

    const resumen = {};
    for (const v of vistas) {
        await page.setViewportSize({ width: v.w, height: v.h });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(350);
        await page.screenshot({ path: path.join(OUT, `vl-live-${v.nombre}.png`) });
        await page.screenshot({ path: path.join(OUT, `vl-live-${v.nombre}-full.png`), fullPage: true });
        await page.evaluate(() => window.scrollTo(0, 0));
        const antes = await medir(page, `LIVE ${v.nombre}`);
        // Cajón de conversaciones (lista)
        await page.click('#lv-chat-conv');
        await page.waitForTimeout(500);
        const conCajon = await medir(page, `Conversaciones ${v.nombre}`);
        await page.screenshot({ path: path.join(OUT, `vl-chat-lista-${v.nombre}.png`) });
        // Hilo abierto
        await page.click('.vl-conv-item');
        await page.waitForTimeout(600);
        await page.screenshot({ path: path.join(OUT, `vl-chat-hilo-${v.nombre}.png`) });
        await page.click('#vld-cerrar');
        await page.waitForTimeout(400);
        resumen[v.nombre] = { antes, conCajon };
        // Detalle por bloque (para revisar recortes finos en móvil/tablet)
        for (const [nom, sel] of [['topbar', '.vl-topbar'], ['nav', '.vl-nav'], ['workspace', '.vl-workspace-head'],
                                  ['session', '.vl-session'], ['chatcard', '#lv-chat-card']]) {
            const loc = page.locator(sel).first();
            if (await loc.count()) {
                await loc.scrollIntoViewIfNeeded().catch(() => {});
                await loc.screenshot({ path: path.join(OUT, `det-${nom}-${v.nombre}.png`) }).catch(() => {});
            }
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        // Diagnóstico fino del bloque de sesión (detecta hijos desbordados)
        const sesion = await page.evaluate(() => {
            const el = document.querySelector('.vl-session');
            if (!el) return null;
            const b = el.getBoundingClientRect();
            return {
                caja: { w: Math.round(b.width), h: Math.round(b.height) },
                overflow: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1,
                hijos: [...el.children].map(c => {
                    const r = c.getBoundingClientRect();
                    return { tag: c.tagName, clase: c.className, texto: (c.textContent || '').trim().slice(0, 40),
                             y: Math.round(r.top), alto: Math.round(r.height), ancho: Math.round(r.width) };
                })
            };
        });
        if (sesion) console.log(`[sesión ${v.nombre}] ` + JSON.stringify(sesion));
    }

    // ── Secciones Procesos / Clientes / Envíos / Finanzas ────────────
    // La paleta toca clases compartidas (.vl-fila, .vl-chip, .vl-btn,
    // .vl-badge, .vl-card), así que se revisan las 4 secciones en web,
    // tablet y móvil: sin scroll horizontal y sin desbordes.
    const SECCIONES = ['procesos', 'clientes', 'envios', 'finanzas'];
    for (const v of [{ n: '1440', w: 1440, h: 900 }, { n: '834', w: 834, h: 1112 }, { n: '390', w: 390, h: 844 }]) {
        await page.setViewportSize({ width: v.w, height: v.h });
        for (const sec of SECCIONES) {
            await page.click(`.vl-tab[data-view="${sec}"]`);
            await page.waitForTimeout(700);
            await page.evaluate(() => window.scrollTo(0, 0));
            const m = await page.evaluate(() => ({
                overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
                scrollW: document.documentElement.scrollWidth,
                vw: window.innerWidth,
                alto: document.documentElement.scrollHeight,
                filas: document.querySelectorAll('.vl-view.active .vl-fila').length,
                filasDesbordadas: [...document.querySelectorAll('.vl-view.active .vl-fila')]
                    .filter(f => f.scrollWidth > f.clientWidth + 1).length,
                chips: document.querySelectorAll('.vl-view.active .vl-chip').length,
                acento: (() => {
                    const e = document.querySelector('.vl-view.active .vl-btn.primary') || document.querySelector('.vl-view.active .vl-chip.active');
                    return e ? getComputedStyle(e).backgroundImage.slice(0, 46) : 'n/a';
                })()
            }));
            console.log(`[${sec} ${v.n}] ` + JSON.stringify(m));
            await page.screenshot({ path: path.join(OUT, `sec-${sec}-${v.n}.png`), fullPage: false });
            await page.screenshot({ path: path.join(OUT, `sec-${sec}-${v.n}-full.png`), fullPage: true });
        }
    }
    // Ficha del cliente (tabla + contadores) en móvil
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('.vl-tab[data-view="clientes"]');
    await page.waitForTimeout(500);
    await page.locator('.vl-view.active .vl-fila').first().click();
    await page.waitForTimeout(600);
    await page.evaluate(() => window.scrollTo(0, 0));
    const ficha = await page.evaluate(() => ({
        overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
        tablas: document.querySelectorAll('#vc-ficha .vl-tabla').length,
        tablaDesborda: [...document.querySelectorAll('#vc-ficha .vl-tabla')].some(t => t.scrollWidth > t.clientWidth + 1)
    }));
    console.log('[ficha 390] ' + JSON.stringify(ficha));
    await page.screenshot({ path: path.join(OUT, 'sec-ficha-390-full.png'), fullPage: true });

    await browser.close();
    srv.close();

    console.log('\n== Errores de consola / RPC sin fixture ==');
    console.log(errores.length ? [...new Set(errores)].join('\n') : 'ninguno');
    console.log('\n== Screenshots ==\n' + OUT);
    fs.writeFileSync(path.join(OUT, 'medidas.json'), JSON.stringify(resumen, null, 2));
})().catch(e => { console.error('FALLO:', e); process.exit(1); });
