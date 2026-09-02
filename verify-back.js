#!/usr/bin/env node
/* verify-back.js — verificación POST-DEPLOY: botón "atrás" cierra el tablero
   Información y devuelve a Mis Clientes (sin salir de la página). 393px. */
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; 22111317G Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  });
  const page = await ctx.newPage();
  const A = [];
  const okA = (cond, msg) => A.push((cond ? 'PASS' : 'FAIL') + ' | ' + msg);

  // Login
  let ok = false;
  for (let i = 1; i <= 3 && !ok; i++) {
    await page.goto('https://agenda-pro-red.vercel.app/login.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
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
  okA(n > 0, 'Mis Clientes cargado (' + n + ' cards)');
  const urlBase = page.url();

  // 1) Abrir tablero Información
  await page.evaluate(() => { const b = document.querySelector('.cliente-card .btn-info-cliente'); if (b) b.click(); });
  await page.waitForTimeout(5000);
  const abierto = await page.evaluate(() => ({
    modal: !!document.getElementById('kanban-modal'),
    state: (history.state || null),
  }));
  okA(abierto.modal === true, 'Board abierto al tocar Información');
  okA(abierto.state && abierto.state.maBoard === true, 'Entrada de historial propia creada (state=' + JSON.stringify(abierto.state) + ')');

  // 2) Presionar "atrás" (equivale al back de Android)
  await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(3000);
  const trasBack = await page.evaluate(() => ({
    modal: !!document.getElementById('kanban-modal'),
    enAdmin: !!document.querySelector('.admin-screen'),
    cards: document.querySelectorAll('.cliente-card').length,
    url: location.pathname,
    seccionVisible: (() => { const s = document.getElementById('section-clientes'); return !!(s && s.style.display !== 'none'); })(),
  }));
  okA(trasBack.modal === false, '"Atrás" cerró el tablero (modal=false)');
  okA(trasBack.enAdmin && trasBack.url === '/admin.html', 'Sigue en admin.html (no salió de la página)');
  okA(trasBack.seccionVisible === true && trasBack.cards > 0, 'Volvió a Mis Clientes (sección visible, ' + trasBack.cards + ' cards)');

  // 3) Abrir de nuevo y cerrar con X: la entrada debe consumirse (state limpio)
  await page.evaluate(() => { const b = document.querySelector('.cliente-card .btn-info-cliente'); if (b) b.click(); });
  await page.waitForTimeout(4500);
  await page.evaluate(() => { const x = document.getElementById('kanban-cerrar'); if (x) x.click(); });
  await page.waitForTimeout(2500);
  const trasX = await page.evaluate(() => ({
    modal: !!document.getElementById('kanban-modal'),
    state: (history.state || null),
  }));
  okA(trasX.modal === false, 'X cerró el tablero');
  okA(!trasX.state || trasX.state.maBoard !== true, 'X consumió la entrada de historial (state=' + JSON.stringify(trasX.state) + ')');

  console.log('\n=== RESULTADO BACK/BOTÓN ATRÁS ===');
  A.forEach(x => console.log(x));
  console.log('urlBase=' + urlBase);
  await browser.close();
  process.exit(A.some(x => x.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
