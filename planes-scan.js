#!/usr/bin/env node
/** planes-scan.js — escaneo móvil de planes.html: magenta legacy, overflow, layout. */
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; 22111317G Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' });
  const SUPABASE_URL = 'https://dfcfimipkfhitlsyixqu.supabase.co';
  const KEY = fs.readFileSync('/tmp/agendapro-key-clean.txt', 'utf8').trim();
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.com', password: 'demo123' }),
  });
  if (!res.ok) { console.log('LOGIN FAIL', res.status, (await res.text()).slice(0,120)); await browser.close(); return; }
  const s = await res.json();
  const u = s.user, meta = u.user_metadata || {};
  const ud = JSON.stringify({ id: u.id, nombre: meta.nombre || 'Admin', email: u.email, rol: meta.rol || 'admin', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '' });
  await ctx.addInitScript(([at, rt, ud]) => {
    localStorage.setItem('agendapro_access_token', at);
    localStorage.setItem('agendapro_refresh_token', rt);
    localStorage.setItem('agendapro_user_data', ud);
  }, [s.access_token, s.refresh_token, ud]);
  const page = await ctx.newPage();
  await page.goto('http://localhost:8080/planes.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(8000); // planes carga datos de la API
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const cs = getComputedStyle.bind(window);
    const magenta = [];
    const overflow = [];
    document.querySelectorAll('body *').forEach((el) => {
      if (el.offsetParent === null) return;
      const st = cs(el);
      const vals = [st.color, st.backgroundColor, st.borderTopColor, st.borderLeftColor, st.boxShadow || '', st.outlineColor];
      const m = vals.find(v => /b300ff|179\s*,\s*0\s*,\s*255|rgba?\(179/i.test(v || ''));
      if (m) {
        const rc = el.getBoundingClientRect();
        if (rc.width > 0 && rc.height > 0) magenta.push({ cls: (el.className || '').toString().slice(0, 45), id: el.id || '', prop: m.slice(0, 45), w: Math.round(rc.width), h: Math.round(rc.height) });
      }
      const rc = el.getBoundingClientRect();
      if (rc.width > 0 && (rc.right > vw + 1 || rc.left < -1)) {
        let p = el.parentElement, dentro = false;
        while (p) { const pc = (p.className || '').toString(); if (pc.includes('sidebar') || pc.includes('bg-circle')) { dentro = true; break; } p = p.parentElement; }
        if (!dentro) overflow.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 45), id: el.id || '', L: Math.round(rc.left), R: Math.round(rc.right), W: Math.round(rc.width) });
      }
    });
    const cards = Array.from(document.querySelectorAll('.plan-card')).map(el => {
      const rc = el.getBoundingClientRect();
      return { w: Math.round(rc.width), h: Math.round(rc.height), txt: el.innerText.replace(/\s+/g, ' ').slice(0, 50) };
    });
    const btn = document.querySelector('.select-plan-btn');
    const btnLogin = document.querySelector('.btn-login');
    const h1 = document.querySelector('.login-screen h1, .planes-container h1, .logo-header h1');
    return {
      vw, scrollH: document.documentElement.scrollHeight,
      overflowX: document.documentElement.scrollWidth - vw,
      screenClass: (document.querySelector('.login-screen') ? 'login-screen' : (document.querySelector('.planes-screen') ? 'planes-screen' : 'otro')),
      selectBtn: btn ? { bg: cs(btn).backgroundImage.slice(0, 60), shadow: cs(btn).boxShadow.slice(0, 50), h: Math.round(btn.getBoundingClientRect().height) } : null,
      loginBtn: btnLogin ? cs(btnLogin).backgroundImage.slice(0, 60) : 'no visible',
      h1: h1 ? { txt: h1.innerText.slice(0, 40), fs: cs(h1).fontSize, color: cs(h1).color } : null,
      cards: cards.slice(0, 4),
      magenta: magenta.slice(0, 20), overflow: overflow.slice(0, 10),
    };
  });
  console.log(JSON.stringify(r, null, 1));
  await page.screenshot({ path: 'responsive-shots/m393/planes-sesion.png', fullPage: true });
  await browser.close();
})();
