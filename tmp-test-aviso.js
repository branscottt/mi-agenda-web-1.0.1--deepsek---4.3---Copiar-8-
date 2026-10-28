#!/usr/bin/env node
// Aviso del día: toast 1 vez por día (no en la segunda carga).
const { chromium } = require('playwright');
const fs = require('fs');
const SUPABASE_URL = 'https://dfcfimipkfhitlsyixqu.supabase.co';
const KEY = fs.readFileSync('/tmp/agendapro-key-clean.txt', 'utf8').trim();
const BASE = process.env.BASE || 'http://localhost:8099/ventas-live.html';
const s = fs.existsSync('/tmp/tok.json') ? JSON.parse(fs.readFileSync('/tmp/tok.json', 'utf8')) : null;

(async () => {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.com', password: 'demo123' }),
  });
  const ses = await r.json();
  const u = ses.user, meta = u.user_metadata || {};
  const ud = JSON.stringify({ id: u.id, nombre: meta.nombre || 'Admin', email: u.email, rol: meta.rol || 'admin', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '' });
  const sbTok = JSON.stringify({ access_token: ses.access_token, refresh_token: ses.refresh_token, expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user: u });

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(([at, rt, ud, sb]) => {
    localStorage.setItem('agendapro_access_token', at);
    localStorage.setItem('agendapro_refresh_token', rt);
    localStorage.setItem('agendapro_user_data', ud);
    localStorage.setItem('sb-dfcfimipkfhitlsyixqu-auth-token', sb);
  }, [ses.access_token, ses.refresh_token, ud, sbTok]);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).slice(0, 200)));

  // Los toasts viven 4 s: se recolectan sondeando el contenedor cada 300 ms.
  const recolectar = async (ms) => {
    const vistos = new Set();
    for (let t = 0; t < ms; t += 300) {
      const txt = await page.evaluate(() => {
        const c = document.getElementById('hermes-toast-container');
        return c ? c.innerText.replace(/\s+/g, ' ').trim() : '';
      });
      if (txt) txt.split('\n').forEach(x => { if (x.trim()) vistos.add(x.trim()); });
      await page.waitForTimeout(300);
    }
    return [...vistos];
  };

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const t1 = await recolectar(9000);
  const marca = await page.evaluate(() => localStorage.getItem('vl_aviso_prendas_sin_contacto'));

  await page.reload({ waitUntil: 'domcontentloaded' });
  const t2 = await recolectar(9000);

  console.log(JSON.stringify({ primeraCarga: t1, marcaDia: marca, segundaCarga: t2, errores: errs }, null, 1));
  await browser.close();
})();
