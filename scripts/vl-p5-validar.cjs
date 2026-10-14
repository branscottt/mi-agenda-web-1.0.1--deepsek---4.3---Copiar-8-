#!/usr/bin/env node
/**
 * Validación del ciclo P5 (Ventas Live) en LOCAL, con sesión real del tenant demo.
 *
 *   - El menú ⋯ (arriba a la derecha) agrupa: ¿Quién es?, + prenda, buscar, modo,
 *     ocultar y fijar/silenciar/archivar.
 *   - El header ya NO muestra "Tomar el control", "Ocultar" ni la lupa.
 *   - "¿Quién es?" se abre como hoja desde el menú; arriba del hilo solo queda el
 *     aviso de una línea si la conversación no está asignada.
 *   - "＋ Prenda" aparece en las fotos; el precio se precarga desde la leyenda.
 *
 * Uso: NODE_PATH="$PWD/node_modules" node scripts/vl-p5-validar.cjs [BASE]
 * Deja capturas en /tmp/vl-p5-<vista>-<paso>.png
 */
const { chromium } = require('playwright');
const fs = require('fs');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dfcfimipkfhitlsyixqu.supabase.co';
const BASE = process.argv[2] || 'http://127.0.0.1:8099';
const KEY = process.env.SUPA_KEY || (fs.readFileSync('.env.local', 'utf8').match(/^SUPABASE_KEY=(.+)$/m) || [])[1];
const DEMO = { email: 'admin@demo.com', password: 'demo123' };

const VIEWPORTS = [
    { nombre: 'PC', width: 1440, height: 900, isMobile: false },
    { nombre: 'Tablet', width: 768, height: 1024, isMobile: true },
    { nombre: 'Movil', width: 390, height: 844, isMobile: true },
];

const itemsEsperados = ['¿Quién es?', 'Agregar prenda', 'Buscar en la conversación',
    'Tomar el control', 'Ocultar de la lista', 'Fijar', 'Silenciar', 'Archivar'];

(async () => {
    if (!KEY) { console.log('FALTA la anon key (SUPABASE_KEY en .env.local)'); process.exit(1); }
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(DEMO),
    });
    const s = await res.json();
    if (!s.access_token) { console.log('LOGIN FALLO', JSON.stringify(s).slice(0, 200)); process.exit(1); }
    const u = s.user, meta = u.user_metadata || {};
    const ud = JSON.stringify({ id: u.id, nombre: meta.nombre || 'Admin', email: u.email, rol: meta.rol || 'admin', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '' });

    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    for (const vp of VIEWPORTS) {
        const ctx = await browser.newContext({
            viewport: { width: vp.width, height: vp.height },
            deviceScaleFactor: 1, isMobile: vp.isMobile, hasTouch: vp.isMobile,
        });
        await ctx.addInitScript(([at, rt, ud]) => {
            localStorage.setItem('agendapro_access_token', at);
            localStorage.setItem('agendapro_refresh_token', rt);
            localStorage.setItem('agendapro_user_data', ud);
        }, [s.access_token, s.refresh_token, ud]);

        const page = await ctx.newPage();
        const errores = [];
        page.on('pageerror', (e) => errores.push('pageerror: ' + String(e.message).slice(0, 160)));
        page.on('console', (m) => { if (m.type() === 'error') errores.push('console: ' + m.text().slice(0, 160)); });

        const out = { vista: vp.nombre, errores: [], datos: {} };
        const snap = (paso) => page.screenshot({ path: `/tmp/vl-p5-${vp.nombre}-${paso}.png`, fullPage: false });

        try {
            let listo = false;
            for (let i = 0; i < 4 && !listo; i++) {
                await page.goto(`${BASE}/ventas-live.html`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
                await page.waitForTimeout(4500);
                listo = await page.evaluate(() => !!document.getElementById('vl-content'));
                if (!listo) { await page.evaluate(() => location.reload()); await page.waitForTimeout(4500); }
            }
            await page.click('#lv-chat-conv', { timeout: 10000 });
            await page.waitForTimeout(3000);
            const nChats = await page.evaluate(() => document.querySelectorAll('.vl-conv-item').length);
            out.datos.chats = nChats;
            await snap('lista');

            let probadoPrenda = false, probadoChip = false, probadoMenu = false;

            for (let i = 0; i < nChats; i++) {
                await page.evaluate((idx) => document.querySelectorAll('.vl-conv-item')[idx].click(), i);
                await page.waitForTimeout(3200);
                const est = await page.evaluate(() => {
                    const vis = (id) => {
                        const e = document.getElementById(id);
                        if (!e) return 'sin-elemento';
                        const st = getComputedStyle(e);
                        return (st.display !== 'none' && e.offsetParent !== null) ? 'visible' : 'oculto';
                    };
                    return {
                        titulo: (document.getElementById('vld-titulo') || {}).textContent || '',
                        menuBtn: vis('vld-menu-btn'),
                        modoBtn: vis('vld-modo'),
                        lupaBtn: vis('vld-buscar-btn'),
                        ocultarBtn: vis('vld-ocultar'),
                        chipQuien: !!document.querySelector('.vl-chip-quien'),
                        prendaChips: document.querySelectorAll('.vl-prenda-chip').length,
                        overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
                        hoja: (() => { const h = document.getElementById('vld-hoja'); return !!h && !h.hidden; })(),
                    };
                });
                out.datos[`chat${i}`] = { titulo: est.titulo, menu: est.menuBtn, modo: est.modoBtn, lupa: est.lupaBtn, ocultar: est.ocultarBtn, chipQuien: est.chipQuien, prendas: est.prendaChips, overflow: est.overflow };
                out.datos.overflowMax = Math.max(out.datos.overflowMax || 0, est.overflow);

                // Hoja "¿Quién es?" + items del menú (una sola vez)
                if (!probadoMenu) {
                    probadoMenu = true;
                    await page.click('#vld-menu-btn');
                    await page.waitForTimeout(700);
                    const menu = await page.evaluate(() => {
                        const m = document.getElementById('vld-menu');
                        return {
                            abierto: !!m && !m.hidden,
                            items: [...m.querySelectorAll('.vl-menu-item span')].map((s) => s.textContent.trim()),
                            pos: (() => { const r = m.getBoundingClientRect(); return { top: Math.round(r.top), right: Math.round(window.innerWidth - r.right), alto: Math.round(r.height) }; })(),
                        };
                    });
                    out.datos.menu = menu;
                    out.datos.menu.items.forEach((t) => {
                        if (!itemsEsperados.some((e) => t.includes(e))) out.errores.push('item inesperado: ' + t);
                    });
                    itemsEsperados.forEach((e) => {
                        if (!menu.items.some((t) => t.includes(e))) out.errores.push('falta el item: ' + e);
                    });
                    await snap('menu');
                    await page.click('#vld-menu-quien');
                    await page.waitForTimeout(2500);
                    const hoja = await page.evaluate(() => {
                        const h = document.getElementById('vld-hoja');
                        const c = document.getElementById('vld-hoja-cuerpo');
                        return { abierta: !!h && !h.hidden, html: (c ? c.textContent.replace(/\s+/g, ' ').trim() : '').slice(0, 120), inputs: c ? c.querySelectorAll('input').length : 0 };
                    });
                    out.datos.hojaQuien = hoja;
                    if (!hoja.abierta) out.errores.push('la hoja "¿Quién es?" no abrió');
                    await snap('quien-es');
                    await page.click('#vld-hoja-x');
                    await page.waitForTimeout(600);
                }

                // "＋ Prenda" sobre una foto: modal con precio precargado (solo si el
                // chat YA está asignado a un usuario; si no, debe avisar y no abrir).
                if (est.prendaChips > 0 && !est.chipQuien && !probadoPrenda) {
                    probadoPrenda = true;
                    await page.evaluate(() => {
                        const chips = document.querySelectorAll('.vl-prenda-chip');
                        const c = chips[chips.length - 1];
                        c.scrollIntoView({ block: 'center' });
                        c.click();
                    });
                    await page.waitForTimeout(900);
                    const modal = await page.evaluate(() => {
                        const p = document.getElementById('vpr-precio');
                        const d = document.getElementById('vpr-desc');
                        const ov = document.querySelector('.vl-modal-overlay');
                        return {
                            abierto: !!ov,
                            precio: p ? p.value : null,
                            desc: d ? d.value : null,
                            ayuda: (() => { const el = ov && ov.querySelector('.vl-form-row div'); return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; })(),
                        };
                    });
                    out.datos.modalPrenda = modal;
                    if (!modal.abierto) out.errores.push('el modal "＋ Prenda" no abrió');
                    if (modal.precio !== '6000') out.errores.push('precio precargado inesperado: ' + modal.precio + ' (esperaba 6000 de "Cinturon a 6mil")');
                    await snap('prenda-modal');
                    await page.click('#vpr-cancelar');
                    await page.waitForTimeout(700);
                }

                // Chip "sin usuario asignado" → avisa que primero hay que asignar
                // (y NO debe abrir el modal de prenda: no sabría a quién cargarla).
                if (est.prendaChips > 0 && est.chipQuien && !probadoChip) {
                    probadoChip = true;
                    await page.evaluate(() => {
                        const c = document.querySelector('.vl-prenda-chip');
                        if (c) { c.scrollIntoView({ block: 'center' }); c.click(); }
                    });
                    await page.waitForTimeout(800);
                    const aviso = await page.evaluate(() => {
                        const cont = document.getElementById('hermes-toast-container');
                        return {
                            texto: (cont ? cont.textContent.replace(/\s+/g, ' ').trim() : '').slice(0, 160),
                            modal: !!document.querySelector('.vl-modal-overlay'),
                        };
                    });
                    out.datos.guardSinAsignar = aviso;
                    if (aviso.modal) out.errores.push('abrió el modal de prenda en un chat SIN usuario asignado (debía avisar)');
                    if (!/asigna el usuario/i.test(aviso.texto)) out.errores.push('no avisó que falta asignar el usuario: ' + aviso.texto);
                    await snap('chip-sin-asignar');
                }

                const volver = await page.$('#vld-volver');
                if (volver) {
                    const visible = await page.evaluate(() => document.getElementById('vld-volver').style.display !== 'none');
                    if (visible) { await volver.click(); await page.waitForTimeout(900); }
                }
            }
        } catch (e) {
            out.errores.push('EXCEPCION: ' + String(e.message).slice(0, 200));
        }
        out.errores = out.errores.concat(errores.slice(0, 6));
        console.log(JSON.stringify(out, null, 1));
        await ctx.close();
    }
    await browser.close();
})();
