// verify-final.js — verificación final: scroll lateral bloqueado + errores consola
const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const key = fs.readFileSync('/tmp/agendapro-key.txt', 'utf8').trim();
  const res = await fetch('https://dfcfimipkfhitlsyixqu.supabase.co/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.com', password: 'demo123' }),
  });
  const session = await res.json();
  const meta = (session.user && session.user.user_metadata) || {};

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({
    viewport: { width: 375, height: 667 },
    deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  });

  for (const [pageName, file, email] of [['admin', 'admin.html', 'admin@demo.com'], ['cliente', 'cliente.html', 'cliente@demo.com']]) {
    const page = await context.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 150)); });
    page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message.slice(0, 150)));
    await page.addInitScript(({ access, refresh }) => {
      localStorage.setItem('agendapro_access_token', access);
      localStorage.setItem('agendapro_refresh_token', refresh);
      localStorage.setItem('agendapro_user_data', JSON.stringify({
        id: 'v', nombre: 'V', email, rol: email.startsWith('admin') ? 'admin' : 'cliente',
        tenant_id: 'v', whatsapp: '',
      }));
    }, { access: session.access_token, refresh: session.refresh_token });
    await page.goto(`http://localhost:8080/${file}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
    // intentar scroll lateral forzado
    const scrollTest = await page.evaluate(async () => {
      window.scrollTo(200, 0);
      await new Promise(r => setTimeout(r, 300));
      const sx = window.scrollX;
      const sw = document.documentElement.scrollWidth;
      const cw = document.documentElement.clientWidth;
      window.scrollTo(0, 0);
      return { scrollX_after_force: sx, scrollWidth: sw, clientWidth: cw, overflowReported: sw - cw };
    });
    console.log(`\n=== ${pageName} @375 ===`);
    console.log('  scroll lateral forzado -> scrollX:', scrollTest.scrollX_after_force, '(0 = bloqueado)');
    console.log('  scrollWidth:', scrollTest.scrollWidth, 'clientWidth:', scrollTest.clientWidth);
    console.log('  errores consola:', errors.length ? errors : 'NINGUNO');
    await page.close();
  }

  // Login sin sesión (público)
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 150)); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message.slice(0, 150)));
  await page.goto('http://localhost:8080/login.html', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  console.log(`\n=== login @375 ===`);
  console.log('  altura contenido:', h, '(viewport 667 — scroll vertical normal)');
  console.log('  errores consola:', errors.length ? errors : 'NINGUNO');
  await page.close();

  await browser.close();
})();
