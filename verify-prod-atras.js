const { chromium, devices } = require('playwright');
const BASE = 'https://agenda-organify.vercel.app';
(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));

  await page.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const base = await page.evaluate(() => ({ atras: typeof window.Atras, nav: typeof window.navigateTo, url: location.pathname }));
  console.log('admin base:', JSON.stringify(base));
  const sec = () => page.evaluate(() => {
    const s = Array.from(document.querySelectorAll('.section-content')).find(el => el.style.display !== 'none' && el.offsetParent !== null);
    return s ? s.id : null;
  });
  if (base.nav === 'function' && base.url === '/admin.html') {
    await page.evaluate(() => window.navigateTo('citas'));
    await page.waitForTimeout(400);
    await page.evaluate(() => window.navigateTo('clientes'));
    await page.waitForTimeout(400);
    console.log('seccion clientes:', await sec());
    await page.goBack(); await page.waitForTimeout(700);
    console.log((await sec()) === 'section-citas' ? 'PASS prod: atrás vuelve a citas' : 'FAIL prod seccion ' + await sec());
    await page.goBack(); await page.waitForTimeout(700);
    console.log((await sec()) === 'section-dashboard' ? 'PASS prod: atrás vuelve a dashboard' : 'FAIL prod seccion ' + await sec());
    console.log('sigue en admin:', page.url().includes('/admin.html'));
  } else {
    console.log('admin redirigió (normal sin sesión):', page.url());
  }

  await page.goto(BASE + '/cliente.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const fn = await page.evaluate(() => typeof window.abrirPopupReserva);
  if (fn === 'function') {
    await page.evaluate(() => window.abrirPopupReserva({ nombre: 'x', fecha: '—', hora: '—', precio: '$1' }));
    await page.waitForTimeout(600);
    const url = page.url();
    await page.goBack(); await page.waitForTimeout(700);
    const r = await page.evaluate(() => ({ vis: getComputedStyle(document.getElementById('popup-reserva')).display !== 'none', url: location.href }));
    console.log((!r.vis && r.url === url ? 'PASS' : 'FAIL') + ' prod: atrás cierra popup cliente', JSON.stringify(r));
  } else console.log('cliente sin abrirPopupReserva (redirigió):', page.url());
  console.log('errores JS:', errs.length ? errs.join(' | ').slice(0, 300) : 'ninguno');
  await browser.close();
})();
