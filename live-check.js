#!/usr/bin/env node
/** live-check.js — verifica en vivo el banner MFA y el toolbar de servicios @393px */
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
    await page.goto('http://localhost:8080/admin.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);
    ok = await page.evaluate(() => !!document.querySelector('.admin-screen'));
    if (!ok) {
      await page.evaluate(([at, rt, ud]) => { localStorage.setItem('agendapro_access_token', at); localStorage.setItem('agendapro_refresh_token', rt); localStorage.setItem('agendapro_user_data', ud); location.reload(); }, [s.access_token, s.refresh_token, ud]);
      await page.waitForTimeout(5000);
      ok = await page.evaluate(() => !!document.querySelector('.admin-screen'));
    }
  }
  await page.waitForTimeout(4000);
  await page.evaluate(() => { if (window.navigateTo) window.navigateTo('mis-servicios'); });
  await page.waitForTimeout(2500);

  const r = await page.evaluate(() => {
    const cs = getComputedStyle.bind(window);
    const mfa = document.getElementById('mfa-banner');
    const mfaBtn = document.getElementById('mfa-setup-btn');
    const fc = document.querySelector('#section-mis-servicios .filter-controls');
    const pa = document.querySelector('#section-mis-servicios .panel-actions');
    const fs1 = document.getElementById('filter-status');
    const exp = document.getElementById('export-services-csv');
    const ref = document.getElementById('refresh-services');
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), L: Math.round(r.left), R: Math.round(r.right), display: cs(el).display, flexDir: cs(el).flexDirection, flexWrap: cs(el).flexWrap, border: cs(el).borderTopColor, pos: cs(el).position }; };
    return {
      mfaBanner: mfa ? { ...rect(mfa), text: mfa.innerText.slice(0, 80) } : 'NO EXISTE',
      mfaBtn: mfaBtn ? rect(mfaBtn) : 'NO EXISTE',
      filterControls: rect(fc),
      panelActions: rect(pa),
      filterStatus: rect(fs1),
      exportBtn: rect(exp),
      refreshBtn: rect(ref),
      vw: document.documentElement.clientWidth,
    };
  });
  console.log(JSON.stringify(r, null, 1));
  await browser.close();
})();
