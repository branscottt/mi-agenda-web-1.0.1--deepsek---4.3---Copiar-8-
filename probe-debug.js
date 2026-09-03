#!/usr/bin/env node
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const ROOT = '/home/branscott/proyectos/mi-agenda-web 1.0.1 (deepsek) (4.3) (Copiar 13)';
const BASE = 'https://agenda-organify.vercel.app';
const cfgRaw = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
const get = (k) => { const m = cfgRaw.match(new RegExp(`^${k}=['"]?(.*?)['"]?\\s*$`, 'm')); return m ? m[1] : ''; };
const cfg = { url: get('SUPABASE_URL'), key: get('SUPABASE_KEY') };
(async () => {
  const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: cfg.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@demo.com', password: 'demo123' }) });
  const session = await res.json();
  const meta = (session.user && session.user.user_metadata) || {};
  const userData = { id: session.user.id, nombre: meta.nombre || 'Demo', email: 'admin@demo.com', rol: meta.rol || 'admin', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '' };
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 834, height: 1112 }, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });
  const page = await ctx.newPage();
  await page.addInitScript(({ access, refresh, userData }) => {
    localStorage.setItem('agendapro_access_token', access);
    localStorage.setItem('agendapro_refresh_token', refresh);
    localStorage.setItem('agendapro_user_data', JSON.stringify(userData));
  }, { access: session.access_token, refresh: session.refresh_token, userData });
  await page.goto(`${BASE}/admin.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(6000);
  const pre = await page.evaluate(() => ({
    tieneNavigate: typeof window.navigateTo, header: !!document.querySelector('.admin-header'),
    bodySnippet: (document.body.innerText || '').slice(0, 250).replace(/\n+/g, ' | '),
  }));
  console.log('PRE:', JSON.stringify(pre, null, 1));
  await page.evaluate(() => { if (window.navigateTo) window.navigateTo('clientes'); }).catch(e => console.log('nav err', e.message));
  await page.waitForTimeout(6000);
  const post = await page.evaluate(() => ({
    clienteCards: document.querySelectorAll('.cliente-card, .cliente-row, [class*="cliente-item"]').length,
    kanban: document.querySelectorAll('.kanban-card').length,
    claseVistas: Array.from(document.querySelectorAll('[class*="view"], [id*="view"]')).filter(v => v.offsetParent !== null).map(v => (v.className || '').toString().slice(0, 40)).slice(0, 12),
    snippet: (document.body.innerText || '').slice(0, 350).replace(/\n+/g, ' | '),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  console.log('POST:', JSON.stringify(post, null, 1));
  await page.screenshot({ path: 'e2e-shots/tablet/834-debug-clientes.png', fullPage: false }).catch(() => {});
  await browser.close();
})();
