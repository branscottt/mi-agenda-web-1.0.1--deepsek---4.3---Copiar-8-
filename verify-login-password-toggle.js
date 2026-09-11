// verify-login-password-toggle.js — Validación E2E del fix de login
//  1) Botón "ojito" para mostrar/ocultar la contraseña
//  2) Mensaje claro cuando la cuenta se creó con Google (sin contraseña)
// Uso:  node verify-login-password-toggle.js   (con http.server en BASE)
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8899';
const CLIP_DIR = 'e2e-shots';
const SEL_BTN = '.toggle-password[data-target="login-password"]';
const EMAIL_EXISTENTE = 'admin@demo.com';
const PASS_MALA = 'claveIncorrectaXYZ123';

async function probarToggle(page) {
  const out = {};
  out.botonExiste = await page.isVisible(SEL_BTN).catch(() => false);
  out.tipoInicial = await page.getAttribute('#login-password', 'type');
  if (!out.botonExiste) return out;

  await page.click(SEL_BTN);
  out.tipoTrasMostrar = await page.getAttribute('#login-password', 'type');
  out.iconoTrasMostrar = await page.getAttribute(`${SEL_BTN} i`, 'class');
  out.ariaPressedTrasMostrar = await page.getAttribute(SEL_BTN, 'aria-pressed');
  out.focoEnInput = await page.evaluate(() => document.activeElement && document.activeElement.id);
  // la contraseña escrita debe verse en claro
  await page.fill('#login-password', 'Secreta123');
  out.valorVisible = await page.inputValue('#login-password');
  await page.screenshot({ path: `${CLIP_DIR}/login-password-visible.png`, clip: await page.locator('#login-container').boundingBox() });

  await page.click(SEL_BTN);
  out.tipoTrasOcultar = await page.getAttribute('#login-password', 'type');
  out.iconoTrasOcultar = await page.getAttribute(`${SEL_BTN} i`, 'class');
  out.ariaPressedTrasOcultar = await page.getAttribute(SEL_BTN, 'aria-pressed');
  out.valorSeConserva = await page.inputValue('#login-password');
  await page.fill('#login-password', '');
  return out;
}

async function probarMensajeLogin(page) {
  await page.fill('#login-email', EMAIL_EXISTENTE);
  await page.fill('#login-password', PASS_MALA);
  await page.click('.btn-login');
  await page
    .waitForFunction(() => {
      const el = document.getElementById('login-error-message');
      return el && el.style.display !== 'none' && el.textContent.trim().length > 0;
    }, { timeout: 25000 })
    .catch(() => {});
  const msg = ((await page.textContent('#login-error-message')) || '').trim();
  return {
    mensaje: msg,
    mencionaGoogle: /Continuar con Google/i.test(msg),
    mencionaContrasena: /contrase/i.test(msg),
    enEspanol: !/invalid login credentials/i.test(msg),
  };
}

async function probarMensajeRegistro(page) {
  await page.click('#register-mode');
  await page.fill('#register-name', 'Prueba QA');
  await page.fill('#register-email', EMAIL_EXISTENTE);
  await page.fill('#register-password', 'Demo123456');
  await page.fill('#register-confirm-password', 'Demo123456');
  await page.fill('#register-whatsapp', '+56912345678');
  await page.click('#register-form-modern button[type="submit"]');
  await page
    .waitForFunction(() => {
      const el = document.getElementById('register-error-message');
      return el && el.style.display !== 'none' && el.textContent.trim().length > 0;
    }, { timeout: 25000 })
    .catch(() => {});
  const msg = ((await page.textContent('#register-error-message')) || '').trim();
  await page.click('#back-to-login');
  return { mensaje: msg, mencionaGoogle: /Google/i.test(msg), mencionaRegistrado: /registrad/i.test(msg) };
}

(async () => {
  const browser = await chromium.launch();
  const resultado = {};

  for (const vp of [
    { name: 'desktop-1440', width: 1440, height: 900 },
    { name: 'movil-390', width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    const errores = [];
    page.on('pageerror', (e) => errores.push('pageerror: ' + String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errores.push('console: ' + m.text()); });

    await page.goto(`${BASE}/login.html`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#login-form-modern', { timeout: 20000 });
    await page.waitForTimeout(1200);

    const r = { toggle: await probarToggle(page) };
    r.overflowX = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    r.anchoInput = await page.evaluate(() => Math.round(document.getElementById('login-password').getBoundingClientRect().width));

    if (vp.name === 'desktop-1440') {
      // la password debe volver a estar oculta antes de medir el error
      await page.fill('#login-password', '');
      r.mensajeLogin = await probarMensajeLogin(page);
      r.mensajeRegistro = await probarMensajeRegistro(page);
    }
    r.erroresPagina = errores;
    await page.screenshot({ path: `${CLIP_DIR}/login-${vp.name}-fix.png`, fullPage: false });
    await page.close();
    resultado[vp.name] = r;
  }

  await browser.close();
  console.log(JSON.stringify(resultado, null, 2));
})();
