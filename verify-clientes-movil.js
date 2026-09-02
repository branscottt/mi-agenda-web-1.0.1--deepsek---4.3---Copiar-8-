#!/usr/bin/env node
/* probe-clientes-movil.js — evidencia móvil 393px del módulo Mis Clientes en PROD. */
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
  page.on('pageerror', e => errors.push('pageerror: ' + e.message.slice(0, 200)));

  // 1) Login por UI
  let ok = false;
  for (let i = 1; i <= 3 && !ok; i++) {
    await page.goto('https://agenda-pro-red.vercel.app/login.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);
    try {
      await page.fill('#login-email', 'admin@demo.com');
      await page.fill('#login-password', 'demo123');
      await page.click('.btn-login');
    } catch (e) { errors.push('login fill: ' + e.message.slice(0, 120)); }
    await page.waitForTimeout(7000);
    ok = await page.evaluate(() => !!document.querySelector('.admin-screen'));
  }
  if (!ok) { console.log(JSON.stringify({ error: 'no se pudo entrar al admin', errors }, null, 1)); await browser.close(); process.exit(2); }

  // 2) Navegar a Mis Clientes
  ok = false;
  for (let i = 1; i <= 4 && !ok; i++) {
    await page.evaluate(() => { try { if (typeof window.navigateTo === 'function') window.navigateTo('clientes'); } catch (e) {} });
    await page.waitForTimeout(5000);
    ok = await page.evaluate(() => document.querySelectorAll('.cliente-card').length > 0);
    if (!ok) await page.waitForTimeout(4000);
  }

  // 3) Medir
  const m = await page.evaluate(() => {
    const cs = getComputedStyle.bind(window);
    const cards = Array.from(document.querySelectorAll('.cliente-card'));
    const cardInfo = cards.slice(0, 6).map(card => {
      const rc = card.getBoundingClientRect();
      const row = card.querySelector('.cliente-actions-row');
      const btns = row ? Array.from(row.querySelectorAll('.btn-small, a.btn-small, button.btn-small')) : [];
      const btnInfo = btns.map(b => {
        const r = b.getBoundingClientRect();
        // desborde: texto real vs rect del botón
        let textOverflow = 0, texts = [];
        const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
          if (!n.nodeValue.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          const tr = range.getBoundingClientRect();
          if (tr.width > 0) {
            texts.push(n.nodeValue.trim().slice(0, 16));
            const overL = Math.max(0, r.left - tr.left);
            const overR = Math.max(0, tr.right - r.right);
            textOverflow = Math.max(textOverflow, overL, overR);
          }
        }
        const s = cs(b);
        return {
          cls: (b.className || '').toString().slice(0, 40),
          label: b.textContent.trim().slice(0, 20),
          w: Math.round(r.width), h: Math.round(r.height),
          scrollW: b.scrollWidth, clientW: b.clientWidth,
          whiteSpace: s.whiteSpace, display: s.display,
          textSpills: textOverflow > 1 ? Math.round(textOverflow) : 0,
          textos: texts,
        };
      });
      return {
        nombre: (card.querySelector('.cliente-info strong') || {}).textContent || '',
        cardTop: Math.round(rc.top), cardW: Math.round(rc.width),
        acciones: btnInfo,
      };
    });
    const doc = document.documentElement;
    return {
      url: location.pathname,
      nCards: cards.length,
      mq768: matchMedia('(max-width: 768px)').matches,
      mq640: matchMedia('(max-width: 640px)').matches,
      overflowX: doc.scrollWidth - doc.clientWidth,
      bodyScrollW: document.body.scrollWidth - doc.clientWidth,
      cardInfo,
      hayEnviarInfo: !!document.querySelector('.btn-enviar-info-cliente'),
      hayCopiarEnlace: !!document.querySelector('.btn-copiar-enlace-cliente'),
    };
  });

  console.log(JSON.stringify(m, null, 1));

  // 4) Screenshots
  await page.screenshot({ path: OUT + '/clientes-movil-antes-full.png', fullPage: true });
  const first = await page.evaluate(() => {
    const c = document.querySelector('.cliente-card');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  if (first) await page.screenshot({ path: OUT + '/clientes-movil-antes-card1.png', clip: { x: 0, y: Math.max(0, first.y - 20), width: 393, height: Math.min(first.h + 40, 852) } });

  console.log(JSON.stringify({ errors: errors.slice(0, 5) }, null, 1));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
