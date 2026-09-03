#!/usr/bin/env node
// debug-tap.js — ¿por qué el tap no abre el modal? prueba mouse.click vs CDP touch + elementFromPoint
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const ROOT = '/home/branscott/proyectos/mi-agenda-web 1.0.1 (deepsek) (4.3) (Copiar 13)';
const BASE = 'http://127.0.0.1:8799';
const cfgRaw = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
const get = (k) => { const m = cfgRaw.match(new RegExp(`^${k}=['"]?(.*?)['"]?\\s*$`, 'm')); return m ? m[1] : ''; };
const cfg = { url: get('SUPABASE_URL'), key: get('SUPABASE_KEY') };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: cfg.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@demo.com', password: 'demo123' }) });
  const session = await res.json();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 834, height: 1112 }, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });
  const page = await ctx.newPage();
  const ref = cfg.url.replace(/^https?:\/\//, '').split('.')[0];
  await page.addInitScript(({ access, refresh, sbKey }) => {
    localStorage.setItem('agendapro_access_token', access);
    localStorage.setItem('agendapro_refresh_token', refresh);
    localStorage.setItem('agendapro_user_data', JSON.stringify({ id: 'x', nombre: 'Demo', email: 'admin@demo.com', rol: 'admin', tenant_id: 'x', whatsapp: '' }));
    localStorage.setItem(sbKey, JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user: null }));
  }, { access: session.access_token, refresh: session.refresh_token, sbKey: `sb-${ref}-auth-token` });
  await page.goto(`${BASE}/admin.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('.admin-header', { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(3500);
  await page.evaluate(() => { if (window.navigateTo) window.navigateTo('clientes'); });
  await page.waitForTimeout(4000);
  const btn = await page.evaluate(() => {
    const b = document.querySelector('.cliente-card .btn-info-cliente');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const top = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), topTag: top ? top.tagName : null, topCls: top ? (top.className || '').toString().slice(0, 50) : null, visible: b.offsetParent !== null };
  });
  console.log('btn:', JSON.stringify(btn));
  // registrar clicks
  await page.evaluate(() => {
    window.__clicks = [];
    document.addEventListener('click', (e) => { const t = e.target; window.__clicks.push((t.className || t.tagName || '').toString().slice(0, 40)); }, true);
  });
  // 1) mouse click
  await page.mouse.click(btn.x, btn.y);
  await sleep(3000);
  let modal = await page.evaluate(() => !!document.getElementById('kanban-modal'));
  console.log('tras mouse.click: modal=', modal, 'clicks:', JSON.stringify(await page.evaluate(() => window.__clicks)));
  if (modal) { console.log('MOUSE FUNCIONA'); await page.keyboard.press('Escape'); await sleep(800); await page.evaluate(() => { const m = document.getElementById('kanban-modal'); if (m) m.remove(); }); }
  // 2) CDP touch tap
  await page.evaluate(() => { window.__clicks = []; });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: btn.x, y: btn.y }] });
  await sleep(60);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(3000);
  modal = await page.evaluate(() => !!document.getElementById('kanban-modal'));
  console.log('tras CDP tap: modal=', modal, 'clicks:', JSON.stringify(await page.evaluate(() => window.__clicks)));
  await browser.close();
})();
