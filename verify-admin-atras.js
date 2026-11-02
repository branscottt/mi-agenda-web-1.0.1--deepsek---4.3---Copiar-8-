const { chromium, devices } = require('playwright');

const BASE = 'http://127.0.0.1:8099';
const results = [];
function ok(name, cond, extra) {
  results.push({ name, pass: !!cond });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  → ' + extra : ''));
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));

  const visibleSection = () => page.evaluate(() => {
    const s = Array.from(document.querySelectorAll('.section-content')).find(el => el.style.display !== 'none' && el.offsetParent !== null);
    return s ? s.id : null;
  });

  await page.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  ok('admin: motor cargado', await page.evaluate(() => !!window.Atras && typeof window.navigateTo === 'function'));
  ok('admin: arranca en dashboard', (await visibleSection()) === 'section-dashboard', await visibleSection());

  // ---- A. Menú lateral (móvil): atrás lo cierra ----
  await page.evaluate(() => window.toggleSidebar());
  await page.waitForTimeout(500);
  ok('menú: abierto y con capa', await page.evaluate(() => ({
    open: document.getElementById('sidebar').classList.contains('open'),
    pila: window.Atras.pila()
  }).open && window.Atras.pila().length === 1));

  await page.goBack();
  await page.waitForTimeout(500);
  const menuTras = await page.evaluate(() => ({
    open: document.getElementById('sidebar').classList.contains('open'),
    pila: window.Atras.pila(),
    url: location.href
  }));
  ok('menú: atrás lo cierra sin salir de admin', !menuTras.open && menuTras.url.includes('/admin.html'), JSON.stringify(menuTras));

  // ---- B. Secciones: atrás vuelve a la anterior ----
  await page.evaluate(() => window.navigateTo('citas'));
  await page.waitForTimeout(500);
  ok('sección citas abierta', (await visibleSection()) === 'section-citas');

  await page.evaluate(() => window.navigateTo('clientes'));
  await page.waitForTimeout(500);
  ok('sección clientes abierta', (await visibleSection()) === 'section-clientes');

  await page.goBack();
  await page.waitForTimeout(600);
  ok('atrás vuelve a citas (no sale)', (await visibleSection()) === 'section-citas', await visibleSection());

  await page.goBack();
  await page.waitForTimeout(600);
  ok('otro atrás vuelve a dashboard', (await visibleSection()) === 'section-dashboard', await visibleSection());
  ok('sigue en admin', page.url().includes('/admin.html'), page.url());

  // ---- C. Modal clásico (.modal) ----
  await page.evaluate(() => { document.getElementById('modal-solicitud-css').style.display = 'flex'; });
  await page.waitForTimeout(500);
  await page.goBack();
  await page.waitForTimeout(500);
  const modalTras = await page.evaluate(() => ({
    disp: getComputedStyle(document.getElementById('modal-solicitud-css')).display,
    pila: window.Atras.pila()
  }));
  ok('modal: atrás lo cierra', modalTras.disp === 'none', JSON.stringify(modalTras));

  // ---- D. Popup de reserva/reagenda del admin ----
  await page.evaluate(() => { document.getElementById('popup-reserva').style.display = 'flex'; });
  await page.waitForTimeout(500);
  await page.goBack();
  await page.waitForTimeout(500);
  const popupTras = await page.evaluate(() => ({
    disp: getComputedStyle(document.getElementById('popup-reserva')).display,
    pila: window.Atras.pila()
  }));
  ok('reagendar: atrás cierra el popup', popupTras.disp === 'none', JSON.stringify(popupTras));

  // ---- E. Popover de notificaciones ----
  await page.evaluate(() => { document.getElementById('notif-popover').style.display = 'flex'; });
  await page.waitForTimeout(500);
  await page.goBack();
  await page.waitForTimeout(500);
  const notifTras = await page.evaluate(() => ({
    disp: getComputedStyle(document.getElementById('notif-popover')).display,
    pila: window.Atras.pila()
  }));
  ok('notificaciones: atrás cierra el popover', notifTras.disp === 'none', JSON.stringify(notifTras));

  console.log('ERRORES JS:', errors.length ? errors.join(' | ') : 'ninguno');
  console.log('RESUMEN: ' + results.filter(r => r.pass).length + '/' + results.length);
  await browser.close();
  process.exit(results.every(r => r.pass) ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
