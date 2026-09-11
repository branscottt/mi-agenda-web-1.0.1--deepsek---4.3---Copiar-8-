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
    vl_wa_chat_por_cliente: { chat_id: 'c1', modo: 'bot' }
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

    await browser.close();
    srv.close();

    console.log('\n== Errores de consola / RPC sin fixture ==');
    console.log(errores.length ? [...new Set(errores)].join('\n') : 'ninguno');
    console.log('\n== Screenshots ==\n' + OUT);
    fs.writeFileSync(path.join(OUT, 'medidas.json'), JSON.stringify(resumen, null, 2));
})().catch(e => { console.error('FALLO:', e); process.exit(1); });
