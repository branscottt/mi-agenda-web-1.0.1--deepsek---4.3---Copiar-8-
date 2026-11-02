const { chromium, devices } = require('playwright');

const BASE = 'http://127.0.0.1:8099';
const results = [];
function ok(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra || '' });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  → ' + extra : ''));
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ ...devices[process.env.DEVICE || 'iPhone 13'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));

  // ---------- 1. Motor genérico: un modal sintético ----------
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  ok('index: atras.js cargado', await page.evaluate(() => typeof window.Atras === 'object'));

  await page.evaluate(() => {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.id = 'test-overlay';
    ov.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);';
    ov.innerHTML = '<div><button id="test-close">Cancelar</button></div>';
    document.body.appendChild(ov);
    document.getElementById('test-close').addEventListener('click', () => ov.remove());
  });
  await page.waitForTimeout(500);
  const pila1 = await page.evaluate(() => window.Atras.pila());
  ok('modal sintético registra capa', pila1.length === 1, JSON.stringify(pila1));

  const urlAntes = page.url();
  await page.goBack();
  await page.waitForTimeout(500);
  const tras1 = await page.evaluate(() => ({
    existe: !!document.getElementById('test-overlay'),
    pila: window.Atras.pila(),
    url: location.href
  }));
  ok('atrás cierra el modal (no la página)', !tras1.existe && tras1.url === urlAntes, JSON.stringify(tras1));
  ok('pila vacía tras cerrar', tras1.pila.length === 0, JSON.stringify(tras1.pila));

  // ---------- 2. Dos modales anidados: atrás cierra SOLO el de arriba ----------
  await page.evaluate(() => {
    ['m1', 'm2'].forEach((id) => {
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      ov.id = id;
      ov.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);';
      ov.innerHTML = '<button class="modal-close">Cerrar</button>';
      document.body.appendChild(ov);
      ov.querySelector('.modal-close').addEventListener('click', () => ov.remove());
    });
  });
  await page.waitForTimeout(500);
  const pila2 = await page.evaluate(() => window.Atras.pila());
  ok('dos modales → dos capas', pila2.length === 2, JSON.stringify(pila2));

  await page.goBack();
  await page.waitForTimeout(400);
  const tras2 = await page.evaluate(() => ({
    m1: !!document.getElementById('m1'),
    m2: !!document.getElementById('m2'),
    pila: window.Atras.pila()
  }));
  ok('atrás cierra solo el modal de arriba', tras2.m1 === true && tras2.m2 === false, JSON.stringify(tras2));

  await page.goBack();
  await page.waitForTimeout(400);
  const tras3 = await page.evaluate(() => ({
    m1: !!document.getElementById('m1'),
    pila: window.Atras.pila(),
    url: location.href
  }));
  ok('segundo atrás cierra el otro modal', !tras3.m1 && tras3.pila.length === 0, JSON.stringify(tras3));

  // ---------- 3. Cliente: popup de reserva real ----------
  await page.goto(BASE + '/cliente.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const tienePopup = await page.evaluate(() => typeof window.abrirPopupReserva === 'function');
  ok('cliente: abrirPopupReserva disponible', tienePopup);

  await page.evaluate(() => window.abrirPopupReserva({ nombre: 'Test', fecha: '—', hora: '—', precio: '$1' }));
  await page.waitForTimeout(500);
  const popupAbierto = await page.evaluate(() => {
    const p = document.getElementById('popup-reserva');
    return p && getComputedStyle(p).display !== 'none';
  });
  ok('cliente: popup visible', popupAbierto);

  const urlCliente = page.url();
  await page.goBack();
  await page.waitForTimeout(500);
  const popupTras = await page.evaluate(() => {
    const p = document.getElementById('popup-reserva');
    return {
      visible: p && getComputedStyle(p).display !== 'none',
      pila: window.Atras.pila(),
      url: location.href
    };
  });
  ok('cliente: atrás cierra el popup y NO sale de la página',
     !popupTras.visible && popupTras.url === urlCliente, JSON.stringify(popupTras));

  // ---------- 4. Cierre por X consume la entrada (no deja atrás mudo) ----------
  await page.evaluate(() => window.abrirPopupReserva({ nombre: 'Test2', fecha: '—', hora: '—', precio: '$1' }));
  await page.waitForTimeout(450);
  await page.click('#popup-reserva .popup-close');
  await page.waitForTimeout(500);
  const trasX = await page.evaluate(() => ({
    visible: getComputedStyle(document.getElementById('popup-reserva')).display !== 'none',
    pila: window.Atras.pila(),
    url: location.href
  }));
  ok('cliente: X cierra y consume la entrada', !trasX.visible && trasX.pila.length === 0, JSON.stringify(trasX));
  // El siguiente atrás debe salir de la página (no quedar mudo)
  let salio = false;
  try {
    await Promise.all([page.waitForNavigation({ timeout: 2500 }), page.goBack()]);
    salio = true;
  } catch (e) { salio = false; }
  ok('cliente: sin capas, atrás navega normal', salio, page.url());

  console.log('ERRORES JS:', errors.length ? errors.join(' | ') : 'ninguno');
  console.log('RESUMEN: ' + results.filter(r => r.pass).length + '/' + results.length);
  await browser.close();
  process.exit(results.every(r => r.pass) ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
