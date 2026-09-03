#!/usr/bin/env node
// debug-tap2.js — con scroll correcto: qué hay bajo el punto, clicks capturados, errores JS/red
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
  page.on('console', m => { const t = m.type(); if (t === 'error') console.log('[console.error]', m.text().slice(0, 200)); });
  page.on('pageerror', e => console.log('[pageerror]', String(e.message).slice(0, 200)));
  page.on('requestfailed', r => console.log('[reqfail]', r.url().slice(0, 110), r.failure()?.errorText));
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
  await page.waitForTimeout(4500);
  const info = await page.evaluate(() => {
    const card = document.querySelector('.cliente-card');
    if (!card) return { sinCard: true };
    const b = card.querySelector('.btn-info-cliente');
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
    const top = document.elementFromPoint(cx, cy);
    window.__clicks = [];
    document.addEventListener('click', (e) => { window.__clicks.push(((e.target && (e.target.className || e.target.tagName)) || '').toString().slice(0, 50)); }, true);
    // listener directo en el botón
    window.__btnClicks = 0;
    b.addEventListener('click', () => window.__btnClicks++);
    return {
      cardTop: Math.round(card.getBoundingClientRect().top),
      btn: { x: cx, y: cy, w: Math.round(r.width), h: Math.round(r.height), topTag: top ? top.tagName : null, topCls: top ? (top.className || '').toString().slice(0, 60) : null, esBtnOChild: top ? (top === b || b.contains(top)) : false },
    };
  });
  console.log('info:', JSON.stringify(info, null, 1));
  if (info.sinCard) { await browser.close(); return; }
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: info.btn.x, y: info.btn.y }] });
  await sleep(60);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(3500);
  const despues = await page.evaluate(() => ({
    modal: !!document.getElementById('kanban-modal'),
    clicks: window.__clicks, btnClicks: window.__btnClicks,
    scrollY: window.scrollY,
  }));
  console.log('despues:', JSON.stringify(despues, null, 1));
  await browser.close();
})();
