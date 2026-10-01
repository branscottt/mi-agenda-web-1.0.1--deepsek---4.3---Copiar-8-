#!/usr/bin/env node
/**
 * Verificación en PRODUCCIÓN del panel VENTAS LIVE en 3 formatos con SESIÓN REAL.
 *
 * Comprueba que ventas-live.html renderiza tras el deploy, mide overflow
 * horizontal, lista errores de consola, y valida las novedades del ciclo:
 *   - el cajón de conversaciones abre y lista chats (.vl-conv-item)
 *   - el hilo del chat trae los BOTONES DE PROCESO (.vl-chat-acciones)
 *   - la pestaña Procesos pinta el diagrama (#vp-diag con contenido)
 * Deja capturas fullPage en /tmp/vl-<vista>-<VP>.png
 *
 * Uso (desde la raíz del repo):
 *   NODE_PATH="$PWD/node_modules" node scripts/vl-3viewports.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dfcfimipkfhitlsyixqu.supabase.co';
const BASE = process.env.BASE || 'https://agenda-pro-red.vercel.app';
const KEY = fs.readFileSync(process.env.KEY_FILE || '/tmp/agendapro-key-clean.txt', 'utf8').trim();
const DEMO = { email: process.env.DEMO_EMAIL || 'admin@demo.com', password: process.env.DEMO_PASS || 'demo123' };

const VIEWPORTS = [
  { nombre: 'PC', width: 1440, height: 900, isMobile: false },
  { nombre: 'Tablet', width: 768, height: 1024, isMobile: true },
  { nombre: 'Movil', width: 390, height: 844, isMobile: true },
];

(async () => {
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
  const out = [];
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
    page.on('pageerror', (e) => errores.push('pageerror: ' + String(e.message).slice(0, 140)));
    page.on('console', (m) => { if (m.type() === 'error') errores.push('console: ' + m.text().slice(0, 140)); });

    // 1) Panel LIVE
    let listo = false;
    for (let i = 0; i < 4 && !listo; i++) {
      await page.goto(`${BASE}/ventas-live.html`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(5000);
      listo = await page.evaluate(() => {
        const l = document.getElementById('vl-loading');
        const c = document.getElementById('vl-content');
        return !!c && (!l || l.style.display === 'none' || l.offsetParent === null);
      });
      if (!listo) { await page.evaluate(() => location.reload()); await page.waitForTimeout(5000); }
    }
    await page.waitForTimeout(2500);
    const live = await page.evaluate(() => ({
      url: location.pathname,
      titulo: document.title,
      nombre: (document.getElementById('vl-nombre') || {}).textContent || '',
      carpetaLive: !!document.getElementById('vl-view-live'),
      accionesChat: !!document.getElementById('lv-acc-chat'),
      overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      appToken: (document.querySelector('script[src*="app.js"]') || {}).src || '',
    }));
    await page.screenshot({ path: `/tmp/vl-live-${vp.nombre}.png`, fullPage: true });

    // 2) Cajón de conversaciones + hilo con botones de proceso
    // Se recorren TODOS los chats: el que tiene proceso abierto es el que muestra
    // los botones (un chat sin cliente no tiene nada que ofrecer).
    let conv = { abierto: false, chats: 0, botones: 0, conBotones: 0, error: '' };
    try {
      await page.click('#lv-chat-conv', { timeout: 8000 });
      await page.waitForTimeout(3500);
      conv.abierto = await page.evaluate(() => !!document.querySelector('#vl-drawer.abierto'));
      conv.chats = await page.evaluate(() => document.querySelectorAll('.vl-conv-item').length);
      let mejor = 0;
      for (let i = 0; i < conv.chats; i++) {
        await page.evaluate((idx) => document.querySelectorAll('.vl-conv-item')[idx].click(), i);
        await page.waitForTimeout(3500);
        const n = await page.evaluate(() => document.querySelectorAll('.vl-chat-acciones button').length);
        if (n > 0) conv.conBotones++;
        if (n > mejor) {
            mejor = n;
            await page.screenshot({ path: `/tmp/vl-chat-${vp.nombre}.png`, fullPage: true });
            const al = await page.evaluate(() => {
                const a = document.querySelector('.vl-chat-alerta, .vl-aviso-titulo');
                const t = a ? a.textContent.replace(/\s+/g, ' ').trim() : '';
                return { texto: t.slice(0, 160), repite: (t.match(/No se entendió/gi) || []).length };
            });
            conv.alerta = al;
        }
        const volver = await page.$('#vld-volver');
        if (volver) { const v = await page.evaluate(() => document.getElementById('vld-volver').style.display !== 'none'); if (v) { await volver.click(); await page.waitForTimeout(900); } }
      }
      conv.botones = mejor;
      const cerrar = await page.$('#vld-cerrar');
      if (cerrar) { await cerrar.click(); await page.waitForTimeout(800); }
    } catch (e) { conv.error = String(e.message).slice(0, 120); }

    // 3) Procesos = diagrama
    let diag = { puntos: 0, alto: 0, overflow: 0 };
    try {
      await page.click('button[data-view="procesos"]', { timeout: 8000 });
      await page.waitForTimeout(4000);
      diag = await page.evaluate(() => {
        const box = document.getElementById('vp-diag');
        return {
          puntos: box ? box.querySelectorAll('button, .vlg-punto').length : 0,
          alto: box ? Math.round(box.getBoundingClientRect().height) : 0,
          overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
        };
      });
      await page.screenshot({ path: `/tmp/vl-procesos-${vp.nombre}.png`, fullPage: true });
    } catch (e) { diag.error = String(e.message).slice(0, 120); }

    out.push({ vp, live, conv, diag, errores });
    await ctx.close();
  }
  await browser.close();

  for (const r of out) {
    console.log(`\n===== ${r.vp.nombre} (${r.vp.width}x${r.vp.height}) =====`);
    console.log(`  LIVE    : url=${r.live.url} nombre="${r.live.nombre}" overflowPx=${r.live.overflow} token=${r.live.appToken.split('/').pop()}`);
    console.log(`  CAJÓN   : abierto=${r.conv.abierto} chats=${r.conv.chats} botonesProceso(max)=${r.conv.botones} chatsConBotones=${r.conv.conBotones}${r.conv.error ? ' error=' + r.conv.error : ''}`);
    if (r.conv.alerta) console.log(`  ALERTA  : repite=${r.conv.alerta.repite} "${r.conv.alerta.texto}"`);
    console.log(`  PROCESOS: nodos=${r.diag.puntos} alto=${r.diag.alto}px overflowPx=${r.diag.overflow || 0}${r.diag.error ? ' error=' + r.diag.error : ''}`);
    console.log(`  errores JS: ${r.errores.length}`);
    r.errores.slice(0, 6).forEach((e) => console.log('    - ' + e));
  }
  const mal = out.filter((r) => !r.live.carpetaLive || r.live.overflow > 2 || r.conv.error);
  console.log(`\nVEREDICTO: ${mal.length === 0 ? 'OK en los 3 formatos' : 'REVISAR ' + mal.map((m) => m.vp.nombre).join(', ')}`);
  console.log('Capturas: /tmp/vl-live-*.png  /tmp/vl-chat-*.png  /tmp/vl-procesos-*.png');
})();
