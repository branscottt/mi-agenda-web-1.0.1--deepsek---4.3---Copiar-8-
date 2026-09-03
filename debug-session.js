#!/usr/bin/env node
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const ROOT = '/home/branscott/proyectos/mi-agenda-web 1.0.1 (deepsek) (4.3) (Copiar 13)';
const BASE = 'http://127.0.0.1:8799';
const cfgRaw = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
const get = (k) => { const m = cfgRaw.match(new RegExp(`^${k}=['"]?(.*?)['"]?\\s*$`, 'm')); return m ? m[1] : ''; };
const cfg = { url: get('SUPABASE_URL'), key: get('SUPABASE_KEY') };
(async () => {
  const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: cfg.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@demo.com', password: 'demo123' }) });
  console.log('login REST status:', res.status);
  if (!res.ok) { console.log(await res.text()); process.exit(2); }
  const session = await res.json();
  console.log('token ok, exp:', session.expires_in, 'user:', session.user.email, 'rol:', session.user.user_metadata.rol);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 834, height: 1112 }, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.type(); if (t === 'error' || t === 'warning') console.log('[console.' + t + ']', m.text().slice(0, 160)); });
  page.on('request', r => { if (r.url().includes('supabase.co/auth')) console.log('[req]', r.method(), r.url().slice(0, 100)); });
  page.on('response', async r => { if (r.url().includes('supabase.co/auth')) console.log('[resp]', r.status(), r.url().slice(0, 100)); });
  const ref = cfg.url.replace(/^https?:\/\//, '').split('.')[0];
  const sbKey = `sb-${ref}-auth-token`;
  await page.addInitScript(({ access, refresh, userData, sbKey }) => {
    localStorage.setItem('agendapro_access_token', access);
    localStorage.setItem('agendapro_refresh_token', refresh);
    localStorage.setItem('agendapro_user_data', JSON.stringify(userData));
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    localStorage.setItem(sbKey, JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 3600, expires_at: expiresAt, token_type: 'bearer', user: null }));
  }, { access: session.access_token, refresh: session.refresh_token, userData: { id: session.user.id, nombre: 'Demo', email: 'admin@demo.com', rol: session.user.user_metadata.rol || 'admin', tenant_id: session.user.user_metadata.tenant_id, whatsapp: '' }, sbKey });
  await page.goto(`${BASE}/admin.html`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(6000);
  const st = await page.evaluate(() => ({
    url: location.href,
    adminHeader: !!document.querySelector('.admin-header'),
    bodyStart: document.body.innerText.slice(0, 130).replace(/\n/g, ' | '),
  }));
  console.log('ESTADO:', JSON.stringify(st, null, 1));
  await browser.close();
})();
