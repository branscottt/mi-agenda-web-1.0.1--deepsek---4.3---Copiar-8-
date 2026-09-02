#!/usr/bin/env node
/* verify-board.js — verificación POST-DEPLOY del header del board Información (393/700px). */
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const out = [];
  for (const vp of [{ w: 393, h: 852 }, { w: 700, h: 900 }]) {
    const ctx = await browser.newContext({
      viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 2, isMobile: vp.w < 500, hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 13; 22111317G Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    });
    const page = await ctx.newPage();
    let ok = false;
    for (let i = 1; i <= 3 && !ok; i++) {
      await page.goto('https://agenda-organify.vercel.app/login.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(4000);
      try { await page.fill('#login-email', 'admin@demo.com'); await page.fill('#login-password', 'demo123'); await page.click('.btn-login'); } catch (e) {}
      await page.waitForTimeout(7000);
      ok = await page.evaluate(() => !!document.querySelector('.admin-screen'));
    }
    let n = 0;
    for (let i = 1; i <= 5 && n === 0; i++) {
      await page.evaluate(() => { try { window.navigateTo('clientes'); } catch (e) {} });
      await page.waitForTimeout(6000);
      n = await page.evaluate(() => document.querySelectorAll('.cliente-card').length);
    }
    await page.evaluate(() => { const b = document.querySelector('.cliente-card .btn-info-cliente'); if (b) b.click(); });
    await page.waitForTimeout(5000);
    const m = await page.evaluate(() => {
      const header = document.querySelector('.kanban-modal-header');
      const h3 = document.querySelector('.kanban-cliente-info h3');
      const actions = document.querySelector('.kanban-estilos-actions');
      const close = document.getElementById('kanban-cerrar');
      if (!header) return { abierto: false };
      const r = (el) => { const x = el.getBoundingClientRect(); return { l: Math.round(x.left), r: Math.round(x.right), t: Math.round(x.top), b: Math.round(x.bottom), w: Math.round(x.width) }; };
      const hr = r(header), cr = close ? r(close) : null, ar = actions ? r(actions) : null, ir = r(document.querySelector('.kanban-cliente-info'));
      const inter = (a, b) => b && !(a.r <= b.l || b.r <= a.l) && !(a.b <= b.t || b.b <= a.t);
      const txtOculto = actions ? getComputedStyle(actions.querySelector('.kanban-estilos-txt')).display === 'none' : null;
      return {
        abierto: true, cssV43: Array.from(document.querySelectorAll('link')).some(l => (l.href || '').includes('style.css?v=43')),
        headerH: Math.round(hr.r - hr.l ? header.getBoundingClientRect().height : 0),
        headerH2: Math.round(header.getBoundingClientRect().height),
        infoW: ir.w, closeL: cr ? cr.l : null, actionsW: ar ? ar.w : null,
        txtOculto, colisionInfoActions: inter(ir, ar), colisionInfoClose: inter(ir, cr),
        h3Ellipsis: getComputedStyle(h3).textOverflow === 'ellipsis' && getComputedStyle(h3).overflow === 'hidden',
      };
    });
    // volver con back
    await page.goBack().catch(() => {});
    await page.waitForTimeout(2500);
    const cerro = await page.evaluate(() => !document.getElementById('kanban-modal'));
    out.push({ vw: vp.w, ...m, backCierra: cerro });
    await ctx.close();
  }
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
  const fail = out.some(o => !o.abierto || !o.backCierra || o.colisionInfoActions || o.colisionInfoClose || !o.txtOculto || !o.h3Ellipsis || (o.vw === 393 && (o.closeL < 300 || o.headerH2 > 140)) || (o.vw === 700 && o.headerH2 > 110));
  console.log('RESULT:', fail ? 'FAIL' : 'PASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
