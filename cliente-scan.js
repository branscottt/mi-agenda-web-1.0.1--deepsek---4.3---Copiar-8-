#!/usr/bin/env node
/** cliente-scan.js — escaneo móvil de la vista cliente: magenta legacy, overflow, header. */
const { chromium } = require('playwright');
const fs = require('fs');
const SUPABASE_URL = 'https://dfcfimipkfhitlsyixqu.supabase.co';
const KEY = fs.readFileSync('/tmp/agendapro-key-clean.txt', 'utf8').trim();
(async () => {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'cliente@demo.com', password: 'demo123' }),
  });
  if (!res.ok) { console.log('login fail', res.status); return; }
  const s = await res.json();
  const u = s.user, meta = u.user_metadata || {};
  const ud = JSON.stringify({ id: u.id, nombre: meta.nombre || 'Cliente', email: u.email, rol: meta.rol || 'cliente', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '' });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; 22111317G Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' });
  await ctx.addInitScript(([at, rt, ud]) => {
    localStorage.setItem('agendapro_access_token', at);
    localStorage.setItem('agendapro_refresh_token', rt);
    localStorage.setItem('agendapro_user_data', ud);
  }, [s.access_token, s.refresh_token, ud]);
  const page = await ctx.newPage();
  let ok = false;
  for (let i = 1; i <= 4 && !ok; i++) {
    await page.goto('http://localhost:8080/cliente.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);
    ok = await page.evaluate(() => !!document.querySelector('.client-screen'));
    if (!ok) {
      await page.evaluate(([at, rt, ud]) => { localStorage.setItem('agendapro_access_token', at); localStorage.setItem('agendapro_refresh_token', rt); localStorage.setItem('agendapro_user_data', ud); location.reload(); }, [s.access_token, s.refresh_token, ud]);
      await page.waitForTimeout(5000);
      ok = await page.evaluate(() => !!document.querySelector('.client-screen'));
    }
  }
  if (!ok) { console.log('no cliente'); await browser.close(); return; }
  await page.waitForTimeout(3500);
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const magenta = [];
    const overflow = [];
    const cs = getComputedStyle.bind(window);
    document.querySelectorAll('.client-screen *').forEach((el) => {
      if (el.offsetParent === null) return;
      const st = cs(el);
      const vals = [st.color, st.backgroundColor, st.borderTopColor, st.borderLeftColor, st.boxShadow || '', st.outlineColor];
      const m = vals.find(v => /b300ff|179\s*,\s*0\s*,\s*255|rgba?\(179/i.test(v || ''));
      if (m) {
        const rct = el.getBoundingClientRect();
        if (rct.width > 0 && rct.height > 0) magenta.push({ cls: (el.className || '').toString().slice(0, 45), id: el.id || '', prop: m.slice(0, 50), w: Math.round(rct.width), h: Math.round(rct.height) });
      }
      const rct = el.getBoundingClientRect();
      if (rct.width > 0 && (rct.right > vw + 1 || rct.left < -1)) {
        let p = el.parentElement, dentro = false;
        while (p) {
          const pc = (p.className || '').toString();
          if (pc.includes('sidebar') || pc.includes('bg-circle')) { dentro = true; break; }
          p = p.parentElement;
        }
        if (!dentro) overflow.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 45), id: el.id || '', L: Math.round(rct.left), R: Math.round(rct.right), W: Math.round(rct.width) });
      }
    });
    const header = document.querySelector('.client-header');
    const hr = header ? header.getBoundingClientRect() : null;
    const logout = document.querySelector('#logout-btn');
    const lr = logout ? logout.getBoundingClientRect() : null;
    return {
      vw, scrollH: document.documentElement.scrollHeight,
      headerH: hr ? Math.round(hr.height) : 0,
      logout: lr ? { w: Math.round(lr.width), h: Math.round(lr.height), txt: logout.innerText.slice(0, 20) } : null,
      magenta: magenta.slice(0, 20), overflow: overflow.slice(0, 10),
      cards: Array.from(document.querySelectorAll('.service-card, .cliente-card, .service-card-client')).map(el => {
        const rct = el.getBoundingClientRect();
        return { cls: (el.className || '').toString().slice(0, 30), w: Math.round(rct.width), h: Math.round(rct.height) };
      }).slice(0, 6),
    };
  });
  console.log(JSON.stringify(r, null, 1));
  await page.screenshot({ path: 'responsive-shots/m393/audit-cliente-actual.png', fullPage: true });
  await browser.close();
})();
