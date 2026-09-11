// verify-prod-oauth-landing.js — simula el RETORNO de Google con una sesión REAL
// (tokens de la cuenta demo pasados por entorno). Mide si el aterrizaje se pierde.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'https://agenda-organify.vercel.app';
const TK = process.env.TK, RT = process.env.RT;
if (!TK) { console.error('faltan tokens'); process.exit(1); }
const HASH = `#access_token=${TK}&expires_in=3600&refresh_token=${RT}&token_type=bearer`;

(async () => {
  const b = await chromium.launch();
  const r = {};

  // --- T1: aterrizaje en hub.html (lo que hace signInWithOAuth con redirectTo hub) ---
  {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    const logs = [];
    p.on('console', (m) => { const t = m.text(); if (/Rutas|HubView|LoginPage|OAuth|JwtManager/i.test(t)) logs.push(t.slice(0, 110)); });
    p.on('pageerror', (e) => logs.push('ERR ' + String(e).slice(0, 100)));
    await p.goto(`${BASE}/hub.html${HASH}`, { waitUntil: 'load', timeout: 40000 });
    await p.waitForTimeout(6000);
    r.t1_urlFinal = p.url().replace(BASE, '').slice(0, 120);
    r.t1_seQuedoEnHub = /hub\.html/.test(p.url());
    r.t1_hubRenderizado = await p.evaluate(() => {
      const txt = document.body.innerText || '';
      return txt.includes('Mis Proyectos') && txt.includes('Reservas de Pymes');
    });
    r.t1_tokenGuardado = await p.evaluate(() => !!localStorage.getItem('agendapro_access_token'));
    r.t1_logs = logs;
    await p.screenshot({ path: '/tmp/oauth-landing-hub.png' });
    await ctx.close();
  }

  // --- T2: aterrizaje en login.html con sesión (fallback del Site URL) ---
  {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    const logs = [];
    p.on('console', (m) => { const t = m.text(); if (/Rutas|HubView|LoginPage|completando/i.test(t)) logs.push(t.slice(0, 110)); });
    await p.goto(`${BASE}/login.html${HASH}`, { waitUntil: 'load', timeout: 40000 });
    await p.waitForTimeout(7000);
    r.t2_urlFinal = p.url().replace(BASE, '').slice(0, 120);
    r.t2_completoLogin = !/login\.html/.test(p.url());
    r.t2_logs = logs;
    await ctx.close();
  }

  // --- T3: pantalla de nueva contraseña con sesión real (sin guardar nada) ---
  {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    await p.goto(`${BASE}/login.html${HASH}&type=recovery`, { waitUntil: 'load', timeout: 40000 });
    await p.waitForTimeout(4000);
    r.t3_urlFinal = p.url().replace(BASE, '').slice(0, 120);
    r.t3_recoveryVisible = await p.isVisible('#recovery-container').catch(() => false);
    r.t3_loginOculto = !(await p.isVisible('#login-container').catch(() => false));
    await ctx.close();
  }

  // --- T4: sin sesión, el hub debe rebotar al login (y no quedarse colgado) ---
  {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    const t0 = Date.now();
    await p.goto(`${BASE}/hub.html`, { waitUntil: 'load', timeout: 40000 });
    await p.waitForURL(/login\.html/, { timeout: 20000 }).catch(() => {});
    r.t4_ms_hasta_login = Date.now() - t0;
    r.t4_urlFinal = p.url().replace(BASE, '');
    await ctx.close();
  }

  await b.close();
  console.log(JSON.stringify(r, null, 2));
})();
