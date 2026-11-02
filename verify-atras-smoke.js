const { chromium, devices } = require('playwright');
const BASE = 'http://127.0.0.1:8099';
const pages = ['/hub.html', '/trabajador.html', '/superadmin.html', '/login.html', '/directorio.html', '/planes.html', '/info-cliente.html'];
(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  let fails = 0;
  for (const p of pages) {
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto(BASE + p, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    const r = await page.evaluate(() => ({ atras: typeof window.Atras, pila: window.Atras ? window.Atras.pila() : null, url: location.pathname }));
    const pass = r.atras === 'object' && errs.length === 0;
    if (!pass) fails++;
    console.log((pass ? 'PASS ' : 'FAIL ') + p, JSON.stringify(r), errs.length ? 'ERRORES: ' + errs.join(' | ').slice(0, 200) : '');
    await page.close();
  }
  await browser.close();
  process.exit(fails ? 1 : 0);
})();
