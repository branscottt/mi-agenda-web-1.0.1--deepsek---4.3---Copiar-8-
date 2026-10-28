#!/usr/bin/env node
// Screenshot de la vista LIVE en producción (móvil) para ver la lista de prendas.
const { chromium } = require('playwright');
const fs = require('fs');
const SUPABASE_URL = 'https://dfcfimipkfhitlsyixqu.supabase.co';
const KEY = fs.readFileSync('/tmp/agendapro-key-clean.txt', 'utf8').trim();
const URL = 'https://agenda-pro-red.vercel.app/ventas-live.html';

(async () => {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.com', password: 'demo123' }),
  });
  const s = await res.json();
  if (!s.access_token) { console.log('LOGIN FAIL', JSON.stringify(s).slice(0, 300)); process.exit(1); }
  const u = s.user, meta = u.user_metadata || {};
  const ud = JSON.stringify({ id: u.id, nombre: meta.nombre || 'Admin', email: u.email, rol: meta.rol || 'admin', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '' });
  const sbTok = JSON.stringify({ access_token: s.access_token, refresh_token: s.refresh_token, expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user: u });

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; 22111317G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' });
  await ctx.addInitScript(([at, rt, ud, sb]) => {
    localStorage.setItem('agendapro_access_token', at);
    localStorage.setItem('agendapro_refresh_token', rt);
    localStorage.setItem('agendapro_user_data', ud);
    localStorage.setItem('sb-dfcfimipkfhitlsyixqu-auth-token', sb);
  }, [s.access_token, s.refresh_token, ud, sbTok]);
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (/error|Error/.test(t)) console.log('CONSOLE:', t.slice(0, 200)); });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000);
  console.log('URL final:', page.url());
  const info = await page.evaluate(() => {
    const txt = (id) => { const el = document.getElementById(id); return el ? el.innerText.trim().slice(0, 400) : null; };
    return {
      url: location.pathname,
      secciones: [...document.querySelectorAll('[data-vl-vista],[data-section]')].map(e => e.getAttribute('data-vl-vista') || e.getAttribute('data-section')),
      liveVisible: !!document.querySelector('#vl-view-live'),
      session: txt('lv-session'), ultima: txt('lv-ultima'),
      hoy: txt('lv-hoy-ventas'),
      cards: [...document.querySelectorAll('#vl-view-live .vl-card')].map(c => (c.querySelector('h2') ? c.querySelector('h2').innerText : '?') + ' :: ' + c.innerText.replace(/\s+/g, ' ').slice(0, 260)),
      bodyTexto: document.querySelector('#vl-view-live') ? document.querySelector('#vl-view-live').innerText.replace(/\s+/g, ' ').slice(0, 1500) : null
    };
  });
  console.log(JSON.stringify(info, null, 1));
  await page.screenshot({ path: 'e2e-shots/vl-live-movil.png', fullPage: true });
  await browser.close();
})();
