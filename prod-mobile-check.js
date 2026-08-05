#!/usr/bin/env node
/** prod-mobile-check.js — verificación final en PRODUCCIÓN @393px con sesión real. */
const { chromium } = require('playwright');
const fs = require('fs');
const SUPABASE_URL = 'https://dfcfimipkfhitlsyixqu.supabase.co';
const KEY = fs.readFileSync('/tmp/agendapro-key-clean.txt', 'utf8').trim();
(async () => {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.com', password: 'demo123' }),
  });
  const s = await res.json();
  const u = s.user, meta = u.user_metadata || {};
  const ud = JSON.stringify({ id: u.id, nombre: meta.nombre || 'Admin', email: u.email, rol: meta.rol || 'admin', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '' });
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
    await page.goto('https://agenda-pro-red.vercel.app/admin.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(6000);
    ok = await page.evaluate(() => !!document.querySelector('.admin-screen'));
    if (!ok) {
      await page.evaluate(([at, rt, ud]) => { localStorage.setItem('agendapro_access_token', at); localStorage.setItem('agendapro_refresh_token', rt); localStorage.setItem('agendapro_user_data', ud); location.reload(); }, [s.access_token, s.refresh_token, ud]);
      await page.waitForTimeout(6000);
      ok = await page.evaluate(() => !!document.querySelector('.admin-screen'));
    }
  }
  await page.waitForTimeout(5000);
  const r = await page.evaluate(() => {
    const cs = getComputedStyle.bind(window);
    const magenta = [];
    document.querySelectorAll('.admin-screen *').forEach((el) => {
      if (el.offsetParent === null) return;
      const st = cs(el);
      const vals = [st.color, st.backgroundColor, st.borderTopColor, st.boxShadow || ''];
      const m = vals.find(v => /b300ff|179\s*,\s*0\s*,\s*255|rgba?\(179/i.test(v || ''));
      if (m) { const rc = el.getBoundingClientRect(); if (rc.width > 0 && rc.height > 0) magenta.push({ cls: (el.className || '').toString().slice(0, 35), prop: m.slice(0, 40) }); }
    });
    const exp = document.getElementById('export-services-csv');
    const er = exp ? exp.getBoundingClientRect() : null;
    const kpi = document.querySelector('.kpi-value');
    return {
      url: location.pathname, mq768: matchMedia('(max-width: 768px)').matches,
      magentaCount: magenta.length, magenta: magenta.slice(0, 6),
      exportBtn: er ? { L: Math.round(er.left), R: Math.round(er.right) } : 'no visible',
      kpiColor: kpi ? cs(kpi).color : 'n/a',
      v15: Array.from(document.styleSheets).some(s => (s.href || '').includes('v=15')),
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  console.log(JSON.stringify(r, null, 1));
  await page.screenshot({ path: 'responsive-shots/m393/prod-final.png', fullPage: true });
  await browser.close();
})();
