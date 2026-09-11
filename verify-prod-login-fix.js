// verify-prod-login-fix.js — E2E contra PRODUCCIÓN + capturas PC/tablet/móvil
//  1) "ojito" en el login
//  2) mensaje claro al fallar el login (cuenta Google) contra Supabase real
//  3) pantalla "Crea tu nueva contraseña" (enlace del correo), sin redirección
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'https://agenda-organify.vercel.app';
const HASH_RECOVERY = '#access_token=token-de-prueba-falso&refresh_token=refresh-falso&expires_in=3600&token_type=bearer&type=recovery';
const SEL_TOGGLE = '.toggle-password[data-target="login-password"]';
const SEL_TOGGLE_REC = '.toggle-password[data-target="recovery-password"]';

const viewports = [
  { name: 'pc-1440', width: 1440, height: 900 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'movil-390', width: 390, height: 844 },
];

const visible = (page, sel) => page.isVisible(sel).catch(() => false);

(async () => {
  const browser = await chromium.launch();
  const res = {};

  for (const vp of viewports) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    const errores = [];
    page.on('pageerror', (e) => errores.push('pageerror: ' + String(e).slice(0, 140)));
    const r = {};

    // --- 1) LOGIN + ojito + mensaje de error real ---
    await page.goto(`${BASE}/login.html`, { waitUntil: 'load', timeout: 40000 });
    await page.waitForSelector('#login-form-modern', { state: 'visible', timeout: 30000 });
    await page.waitForTimeout(2000);

    await page.click(SEL_TOGGLE);
    r.tipoTrasOjo = await page.getAttribute('#login-password', 'type');
    r.icono = await page.getAttribute(`${SEL_TOGGLE} i`, 'class');
    await page.fill('#login-password', 'ClaveVisible123');
    r.valorVisible = await page.inputValue('#login-password');
    await page.screenshot({ path: `/tmp/fix-login-${vp.name}.png` });

    await page.click(SEL_TOGGLE); // volver a ocultar
    await page.fill('#login-email', 'admin@demo.com');
    await page.fill('#login-password', 'claveIncorrectaXYZ123');
    await page.click('.btn-login');
    await page.waitForFunction(() => {
      const el = document.getElementById('login-error-message');
      return el && el.style.display !== 'none' && el.textContent.trim().length > 0;
    }, { timeout: 25000 }).catch(() => {});
    r.mensajeLogin = ((await page.textContent('#login-error-message')) || '').trim();
    r.mencionaGoogle = /Continuar con Google/i.test(r.mensajeLogin);
    r.mencionaCrearContrasena = /Olvidaste tu contraseña/i.test(r.mensajeLogin);
    r.overflowX = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

    // --- 2) PANTALLA "NUEVA CONTRASEÑA" (enlace del correo) ---
    await page.goto(`${BASE}/login.html${HASH_RECOVERY}`, { waitUntil: 'load', timeout: 40000 });
    await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (_) {} });
    await page.reload({ waitUntil: 'load', timeout: 40000 });
    await page.waitForSelector('#recovery-form', { timeout: 25000 });
    await page.waitForTimeout(2500);
    r.recoveryVisible = await visible(page, '#recovery-container');
    r.loginOculto = !(await visible(page, '#login-container'));
    r.sinRedireccion = /login\.html/.test(page.url());
    r.urlFinal = page.url().replace(BASE, '');
    await page.click(SEL_TOGGLE_REC);
    r.tipoRecoveryTrasOjo = await page.getAttribute('#recovery-password', 'type');
    await page.screenshot({ path: `/tmp/fix-recovery-${vp.name}.png` });

    r.erroresPagina = errores.filter((e) => !/status of (400|401|422)|Turnstile|font-size:0/i.test(e));
    res[vp.name] = r;
    await ctx.close();
  }

  await browser.close();
  console.log(JSON.stringify(res, null, 2));
})();
