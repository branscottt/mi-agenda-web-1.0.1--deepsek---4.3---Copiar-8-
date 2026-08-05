#!/usr/bin/env node
/** planes-both.js — verifica planes.html en PROD (navegador limpio) en desktop 1440px y móvil 393px, con sesión real. */
const { chromium } = require('playwright');
const fs = require('fs');
const SUPABASE_URL = 'https://dfcfimipkfhitlsyixqu.supabase.co';
const KEY = fs.readFileSync('/tmp/agendapro-key-clean.txt', 'utf8').trim();
const URL = process.env.PLANES_URL || 'https://agenda-pro-red.vercel.app/planes.html';

async function loginREST() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.com', password: 'demo123' }),
  });
  if (!res.ok) throw new Error('login fail ' + res.status);
  return res.json();
}

async function checkViewport(browser, name, width, height, session) {
  const u = session.user, meta = u.user_metadata || {};
  const ud = JSON.stringify({ id: u.id, nombre: meta.nombre || 'Admin', email: u.email, rol: meta.rol || 'admin', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '' });
  const ctx = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: width < 768 ? 2 : 1, isMobile: width < 768, hasTouch: width < 768,
    userAgent: width < 768
      ? 'Mozilla/5.0 (Linux; Android 13; 22111317G Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  await ctx.addInitScript(([at, rt, ud]) => {
    localStorage.setItem('agendapro_access_token', at);
    localStorage.setItem('agendapro_refresh_token', rt);
    localStorage.setItem('agendapro_user_data', ud);
  }, [session.access_token, session.refresh_token, ud]);
  const page = await ctx.newPage();
  let ok = false;
  for (let i = 1; i <= 4 && !ok; i++) {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(7000);
    ok = await page.evaluate(() => !!document.querySelector('.plan-card'));
    if (!ok) {
      await page.evaluate(([at, rt, ud]) => {
        localStorage.setItem('agendapro_access_token', at);
        localStorage.setItem('agendapro_refresh_token', rt);
        localStorage.setItem('agendapro_user_data', ud);
        location.reload();
      }, [session.access_token, session.refresh_token, ud]);
      await page.waitForTimeout(7000);
      ok = await page.evaluate(() => !!document.querySelector('.plan-card'));
    }
  }
  if (!ok) { console.log(`[${name}] NO renderizó planes`); await ctx.close(); return; }
  await page.waitForTimeout(2000);
  const r = await page.evaluate(() => {
    const cs = getComputedStyle.bind(window);
    const vw = document.documentElement.clientWidth;
    const cards = Array.from(document.querySelectorAll('.plan-card')).map(el => {
      const rc = el.getBoundingClientRect();
      return { w: Math.round(rc.width), h: Math.round(rc.height), txt: el.innerText.replace(/\s+/g, ' ').slice(0, 45) };
    });
    const container = document.querySelector('.planes-container .stats-container, #planes-container .stats-container');
    const cr = container ? container.getBoundingClientRect() : null;
    const btn = document.querySelector('.select-plan-btn');
    const bc = btn ? cs(btn) : null;
    const card0 = document.querySelector('.plan-card');
    const cc = card0 ? cs(card0) : null;
    // magenta legacy visible (excluyendo colores de plan inline: h3/checks usan plan.color)
    const magenta = [];
    document.querySelectorAll('.plan-card *').forEach((el) => {
      if (el.offsetParent === null) return;
      const st = cs(el);
      if (el.tagName === 'I' && el.className.includes('fa-check')) return; // color de plan (dato)
      const vals = [st.color, st.backgroundColor, st.borderTopColor, st.borderLeftColor, st.boxShadow || ''];
      const m = vals.find(v => /b300ff|179\s*,\s*0\s*,\s*255|rgba?\(179/i.test(v || ''));
      if (m) { const rc = el.getBoundingClientRect(); if (rc.width > 0 && rc.height > 0) magenta.push({ cls: (el.className || '').toString().slice(0, 35), prop: m.slice(0, 45) }); }
    });
    return {
      vw, mq768: matchMedia('(max-width: 768px)').matches,
      containerGrid: container ? cs(container).gridTemplateColumns : 'n/a',
      containerW: cr ? Math.round(cr.width) : 0,
      cards, cardBorder: cc ? cc.borderTopColor + ' / ' + cc.borderLeftColor : '',
      btnGradient: bc ? bc.backgroundImage.slice(0, 60) : '',
      btnShadow: bc ? bc.boxShadow.slice(0, 45) : '',
      magenta, overflowX: document.documentElement.scrollWidth - vw,
      v16: Array.from(document.styleSheets).some(s => (s.href || '').includes('v=16')),
    };
  });
  console.log(`\n=== ${name} (${width}px) ===`);
  console.log(JSON.stringify(r, null, 1));
  await page.screenshot({ path: `responsive-shots/planes-${name}.png`, fullPage: true });
  await ctx.close();
}

(async () => {
  const session = await loginREST();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  await checkViewport(browser, 'desktop', 1440, 900, session);
  await checkViewport(browser, 'm393', 393, 852, session);
  await browser.close();
})();
