// verify-login-oauth-error.js — el error de Google/Supabase NUNCA puede ser silencioso
//  S1 error OAuth en login.html       S2 access_denied
//  S3 rebote desde hub.html conserva el error    S4 el flujo de recovery sigue OK
//  S5 sesión en la URL completa el login
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8899';

const visible = (p, s) => p.isVisible(s).catch(() => false);
const txt = async (p, s) => ((await p.textContent(s).catch(() => '')) || '').trim();

// el manejador vive en un chunk dinámico: esperar el texto, no un sleep fijo
async function esperarMensaje(page, minLen = 15, timeout = 20000) {
  const t0 = Date.now();
  try {
    await page.waitForFunction((n) => {
      const el = document.getElementById('login-error-message');
      return !!el && (el.textContent || '').trim().length >= n;
    }, minLen, { timeout });
  } catch (_) {}
  return { texto: await txt(page, '#login-error-message'), ms: Date.now() - t0 };
}

async function abrir(page, url) {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (_) {} });
  await page.reload({ waitUntil: 'load', timeout: 30000 });
}

(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e).slice(0, 120)));
  const r = {};

  // S1: error server_error/unexpected_failure en login.html
  await abrir(page, `${BASE}/login.html#error=server_error&error_code=unexpected_failure&error_description=Unable+to+exchange+external+code`);
  await page.waitForSelector('#login-form-modern', { state: 'visible', timeout: 20000 });
  const s1 = await esperarMensaje(page);
  r.s1_mensaje = s1.texto;
  r.s1_ms = s1.ms;
  r.s1_visible = await visible(page, '#login-error-message');

  // S2: access_denied
  await abrir(page, `${BASE}/login.html?error=access_denied&error_code=access_denied#error=access_denied&error_code=access_denied`);
  r.s2_mensaje = (await esperarMensaje(page)).texto;

  // S3: rebote desde hub.html (sin sesión) con error en la URL
  await abrir(page, `${BASE}/hub.html#error=server_error&error_code=unexpected_failure&error_description=Unable+to+exchange+external+code`);
  await page.waitForTimeout(2000);
  r.s3_urlFinal = page.url().replace(BASE, '');
  r.s3_mensaje = (await esperarMensaje(page)).texto;

  // S4: el flujo de recuperación sigue funcionando
  await abrir(page, `${BASE}/login.html#access_token=f&refresh_token=r&expires_in=3600&type=recovery`);
  await page.waitForSelector('#recovery-form', { timeout: 20000 });
  await page.waitForTimeout(2000);
  r.s4_recoveryVisible = await visible(page, '#recovery-container');
  r.s4_loginOculto = !(await visible(page, '#login-container'));
  r.s4_mensajeError = await txt(page, '#login-error-message');

  // S5: sesión en la URL (aterrizó en login.html) → debe intentar completar el login
  let pidioHub = false;
  page.on('request', (req) => { if (/hub\.html/.test(req.url())) pidioHub = true; });
  await abrir(page, `${BASE}/login.html#access_token=token-falso&refresh_token=refresh-falso&expires_in=3600&token_type=bearer`);
  await page.waitForTimeout(2500);
  r.s5_pidioHub = pidioHub;
  r.s5_urlFinal = page.url().replace(BASE, '');

  r.erroresPagina = errores;
  await b.close();
  console.log(JSON.stringify(r, null, 2));
})();
