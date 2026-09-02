#!/usr/bin/env node
/* verify-clientes-movil.js — verificación POST-DEPLOY en PRODUCCIÓN @393px del módulo Mis Clientes.
   Aserciones: Enviar info full-width sin derrame, toolbar ordenada, banner ayuda plegado en móvil. */
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = 'responsive-shots/m393';
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; 22111317G Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message.slice(0, 160)));

  // Login UI demo
  let ok = false;
  for (let i = 1; i <= 3 && !ok; i++) {
    await page.goto('https://agenda-pro-red.vercel.app/login.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);
    try {
      await page.fill('#login-email', 'admin@demo.com');
      await page.fill('#login-password', 'demo123');
      await page.click('.btn-login');
    } catch (e) { errors.push('login: ' + e.message.slice(0, 80)); }
    await page.waitForTimeout(7000);
    ok = await page.evaluate(() => !!document.querySelector('.admin-screen'));
  }
  if (!ok) { console.log(JSON.stringify({ error: 'sin acceso admin', errors }, null, 1)); await browser.close(); process.exit(2); }

  let nCards = 0;
  for (let i = 1; i <= 5 && nCards === 0; i++) {
    await page.evaluate(() => { try { if (typeof window.navigateTo === 'function') window.navigateTo('clientes'); } catch (e) {} });
    await page.waitForTimeout(6000);
    nCards = await page.evaluate(() => document.querySelectorAll('.cliente-card').length);
    if (nCards === 0) {
      const estado = await page.evaluate(() => {
        const cont = document.getElementById('clientes-list-container') || document.querySelector('#section-clientes');
        return cont ? (cont.textContent || '').trim().slice(0, 200) : 'sin contenedor';
      });
      console.log('intento ' + i + ': 0 cards. estado=' + JSON.stringify(estado));
      await page.waitForTimeout(4000);
    }
  }

  const m = await page.evaluate(() => {
    const cs = getComputedStyle.bind(window);
    const doc = document.documentElement;
    const firstCard = document.querySelector('.cliente-card');
    const fc = firstCard ? firstCard.getBoundingClientRect() : null;
    const rows = Array.from(document.querySelectorAll('.cliente-actions-row'));
    const btnsInfo = rows.slice(0, 3).map(row => Array.from(row.querySelectorAll('.btn-small')).map(b => {
      const r = b.getBoundingClientRect();
      let spill = 0;
      const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) { if (!n.nodeValue.trim()) continue; const range = document.createRange(); range.selectNodeContents(n); const tr = range.getBoundingClientRect(); if (tr.width > 0) spill = Math.max(spill, Math.max(0, r.left - tr.left), Math.max(0, tr.right - r.right)); }
      return { cls: (b.className || '').toString().replace('btn-small ', '').slice(0, 30), w: Math.round(r.width), h: Math.round(r.height), spill: Math.round(spill) };
    }));
    const env = btnsInfo.flat().find(b => b.cls.includes('btn-enviar-info-cliente'));
    const helpBody = document.getElementById('clientes-help-body');
    const t = (() => {
      const h = document.querySelector('.clientes-header-actions');
      if (!h) return null;
      const hr = h.getBoundingClientRect();
      const pos = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { y: Math.round(r.top - hr.top), w: Math.round(r.width) }; };
      return { alto: Math.round(hr.height), buscar: pos('.clientes-header-actions .search-box'), agregar: pos('#agregar-cliente-btn'), exportar: pos('#export-clientes-csv'), etiquetas: pos('#toggle-permiso-etiquetas') };
    })();
    return {
      nCards: document.querySelectorAll('.cliente-card').length,
      primerCardTop: fc ? Math.round(fc.top + window.scrollY) : null,
      helpPlegado: helpBody ? helpBody.style.display === 'none' : null,
      enviarInfo: env || null,
      desbordes: Array.from(document.querySelectorAll('.cliente-card *')).filter(b => b.scrollWidth > b.clientWidth + 2 && (b.textContent || '').trim() && b.offsetParent !== null).map(b => (b.className || '').toString().slice(0, 40)),
      overflowX: doc.scrollWidth - doc.clientWidth,
      toolbar: t,
      v12css: Array.from(document.styleSheets).some(s => { try { return Array.from(s.cssRules).some(r => r.cssText && r.cssText.includes('btn-enviar-info-cliente')); } catch (e) { return false; } }),
    };
  });

  const A = [];
  const okA = (cond, msg) => A.push((cond ? 'PASS' : 'FAIL') + ' | ' + msg);
  okA(!!m.enviarInfo && m.enviarInfo.w > 200 && m.enviarInfo.spill === 0, 'Enviar info full-width sin derrame (' + (m.enviarInfo ? 'w=' + m.enviarInfo.w + ' spill=' + m.enviarInfo.spill : 'no encontrado') + ')');
  okA(m.desbordes.length === 0, 'Sin texto fuera de caja en cards (desbordes=' + m.desbordes.length + ')');
  okA(m.overflowX === 0, 'Sin overflow horizontal (overflowX=' + m.overflowX + ')');
  okA(m.helpPlegado === true, 'Banner ayuda plegado por defecto en móvil (helpPlegado=' + m.helpPlegado + ')');
  okA(m.primerCardTop !== null && m.primerCardTop < 1000, 'Primera card visible arriba (top=' + m.primerCardTop + ')');
  const t = m.toolbar;
  okA(t && t.agregar && t.exportar && t.agregar.y === t.exportar.y && t.agregar.w > 150, 'Toolbar: Agregar/Exportar misma fila parejos (y=' + (t ? t.agregar.y + '/' + t.exportar.y : '?') + ' w=' + (t ? t.agregar.w : '?') + ')');
  okA(m.v12css === true, 'CSS v12 presente en producción');

  console.log(JSON.stringify(m, null, 1));
  console.log('\n=== RESULTADO POST-DEPLOY ===');
  A.forEach(x => console.log(x));

  await page.screenshot({ path: OUT + '/clientes-movil-despues-full.png', fullPage: true });
  const clip = await page.evaluate(() => {
    const c = document.querySelector('.cliente-card');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: 0, y: Math.max(0, r.y - 24), width: 393, height: Math.min(r.height + 48, 852) };
  });
  if (clip) await page.screenshot({ path: OUT + '/clientes-movil-despues-card1.png', clip });
  console.log('screenshots: ' + OUT + '/clientes-movil-despues-*.png');
  if (errors.length) console.log('errores consola:', JSON.stringify(errors.slice(0, 5)));
  await browser.close();
  process.exit(A.some(x => x.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
