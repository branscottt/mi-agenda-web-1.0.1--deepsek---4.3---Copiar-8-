// verify-login-recovery.js — Validación E2E del flujo "nueva contraseña" (cuentas Google)
// Escenarios: (1) enlace de recovery válido, (2) enlace vencido, (3) regresión del login normal
// Viewports: PC 1440, tablet 820, móvil 390
// Uso: node verify-login-recovery.js   (con http.server en BASE)
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8899';
const SEL_TOGGLE_REC = '.toggle-password[data-target="recovery-password"]';
const HASH_RECOVERY = '#access_token=token-de-prueba-falso&refresh_token=refresh-falso&expires_in=3600&token_type=bearer&type=recovery';
const HASH_VENCIDO = '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';

const viewports = [
  { name: 'pc-1440', width: 1440, height: 900 },
  { name: 'tablet-820', width: 820, height: 1180 },
  { name: 'movil-390', width: 390, height: 844 },
];

async function visible(page, sel) { return page.isVisible(sel).catch(() => false); }

// goto con recarga REAL: un cambio de solo-hash no recarga el documento y
// dejaría el DOM del escenario anterior.
async function abrir(page, url) {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (_) {} });
  await page.reload({ waitUntil: 'load', timeout: 30000 });
}

async function escenarioEnlaceValido(page) {
  const out = {};
  await abrir(page, `${BASE}/login.html${HASH_RECOVERY}`);
  await page.waitForSelector('#recovery-form', { timeout: 20000 });
  await page.waitForTimeout(2500); // dar tiempo a legacy.js (guard de rutas) y al SDK

  out.urlFinal = page.url().replace(BASE, '');
  out.noRedirigido = /login\.html/.test(page.url()) && !/hub\.html|cliente\.html|superadmin\.html/.test(page.url());
  out.recoveryVisible = await visible(page, '#recovery-container');
  out.loginOculto = !(await visible(page, '#login-container'));
  out.registroOculto = !(await visible(page, '#register-container'));
  out.modeToggleOculto = !(await visible(page, '.mode-toggle'));

  // el "ojito" funciona también aquí
  out.tipoInicial = await page.getAttribute('#recovery-password', 'type');
  await page.click(SEL_TOGGLE_REC);
  out.tipoTrasOjo = await page.getAttribute('#recovery-password', 'type');
  await page.click(SEL_TOGGLE_REC);

  // validación: contraseñas distintas
  await page.fill('#recovery-password', 'ClaveNueva123');
  await page.fill('#recovery-confirm-password', 'OtraClave456');
  await page.click('#recovery-form button[type="submit"]');
  await page.waitForTimeout(400);
  out.errorNoCoinciden = ((await page.textContent('#recovery-error-message')) || '').trim();

  // validación: muy corta (las dos iguales, pero de 3 caracteres) → la bloquea el navegador (minlength=6)
  await page.fill('#recovery-password', 'abc');
  await page.fill('#recovery-confirm-password', 'abc');
  await page.click('#recovery-form button[type="submit"]');
  await page.waitForTimeout(400);
  out.bloqueoNativo = await page.evaluate(() => {
    const i = document.getElementById('recovery-password');
    return { valido: i.checkValidity(), mensaje: i.validationMessage };
  });
  out.errorCorta = ((await page.textContent('#recovery-error-message')) || '').trim();
  // mensaje propio del JS (sin el minlength del navegador)
  await page.evaluate(() => { document.getElementById('recovery-password').removeAttribute('minlength'); document.getElementById('recovery-confirm-password').removeAttribute('minlength'); });
  await page.click('#recovery-form button[type="submit"]');
  await page.waitForTimeout(400);
  out.errorCortaJs = ((await page.textContent('#recovery-error-message')) || '').trim();

  // envío con token falso: el servidor rechaza la sesión y el mensaje debe salir en español
  await page.fill('#recovery-password', 'ClaveNueva123');
  await page.fill('#recovery-confirm-password', 'ClaveNueva123');
  await page.click('#recovery-form button[type="submit"]');
  await page.waitForTimeout(6000);
  out.errorEnvioReal = ((await page.textContent('#recovery-error-message')) || '').trim();
  out.envioEnEspanol = !/auth session missing|invalid|error/i.test(out.errorEnvioReal) || /enlace/i.test(out.errorEnvioReal);

  await page.screenshot({ path: `e2e-shots/recovery-${page.viewportSize().width}.png`, fullPage: false });
  return out;
}

async function escenarioEnlaceVencido(page) {
  await abrir(page, `${BASE}/login.html${HASH_VENCIDO}`);
  await page.waitForSelector('#login-form-modern', { timeout: 20000, state: 'visible' });
  await page.waitForTimeout(2000);
  return {
    loginVisible: await visible(page, '#login-container'),
    recoveryOculto: !(await visible(page, '#recovery-container')),
    mensaje: ((await page.textContent('#login-error-message')) || '').trim(),
  };
}

async function escenarioLoginNormal(page) {
  await abrir(page, `${BASE}/login.html`);
  await page.waitForSelector('#login-form-modern', { timeout: 20000, state: 'visible' });
  await page.waitForTimeout(1500);
  const out = {
    loginVisible: await visible(page, '#login-container'),
    recoveryOculto: !(await visible(page, '#recovery-container')),
    toggleLoginExiste: await visible(page, '.toggle-password[data-target="login-password"]'),
    overflowX: await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
  };
  await page.fill('#login-email', 'admin@demo.com');
  await page.fill('#login-password', 'claveIncorrectaXYZ123');
  await page.click('.btn-login');
  await page.waitForFunction(() => {
    const el = document.getElementById('login-error-message');
    return el && el.style.display !== 'none' && el.textContent.trim().length > 0;
  }, { timeout: 25000 }).catch(() => {});
  out.mensajeLogin = ((await page.textContent('#login-error-message')) || '').trim();
  out.mencionaGoogle = /Continuar con Google/i.test(out.mensajeLogin);
  out.mencionaCrearContrasena = /Olvidaste tu contraseña/i.test(out.mensajeLogin);
  return out;
}

(async () => {
  const browser = await chromium.launch();
  const res = {};
  for (const vp of viewports) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    const errores = [];
    page.on('pageerror', (e) => errores.push('pageerror: ' + String(e).slice(0, 160)));
    const r = {};
    r.recovery = await escenarioEnlaceValido(page);
    if (vp.name === 'pc-1440') {
      r.vencido = await escenarioEnlaceVencido(page);
      r.loginNormal = await escenarioLoginNormal(page);
    } else {
      r.overflowRecovery = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    }
    r.erroresPagina = errores.filter((e) => !/status of 400|status of 422|font-size:0/.test(e));
    res[vp.name] = r;
    await page.close();
  }
  await browser.close();
  console.log(JSON.stringify(res, null, 2));
})();
