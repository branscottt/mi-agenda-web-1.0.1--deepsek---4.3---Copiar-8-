#!/usr/bin/env node
// probe-admin-tablet.js — toques reales en admin a 834px (iPad Air) y 1024px:
// navegación por secciones + apertura del board kanban + geometría del modal.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const ROOT = '/home/branscott/proyectos/mi-agenda-web 1.0.1 (deepsek) (4.3) (Copiar 13)';
const BASE = 'https://agenda-organify.vercel.app';
const cfgRaw = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
const get = (k) => { const m = cfgRaw.match(new RegExp(`^${k}=['"]?(.*?)['"]?\\s*$`, 'm')); return m ? m[1] : ''; };
const cfg = { url: get('SUPABASE_URL'), key: get('SUPABASE_KEY') };

async function login(email, password) {
  const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error('login ' + res.status);
  return await res.json();
}

async function main() {
  const session = await login('admin@demo.com', 'demo123');
  const meta = (session.user && session.user.user_metadata) || {};
  const userData = { id: session.user.id, nombre: meta.nombre || 'Demo', email: 'admin@demo.com', rol: meta.rol || 'admin', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '' };

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const vp of [{ name: '834', width: 834, height: 1112 }, { name: '1024', width: 1024, height: 1366 }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e.message).slice(0, 140)));
    await page.addInitScript(({ access, refresh, userData }) => {
      localStorage.setItem('agendapro_access_token', access);
      localStorage.setItem('agendapro_refresh_token', refresh);
      localStorage.setItem('agendapro_user_data', JSON.stringify(userData));
    }, { access: session.access_token, refresh: session.refresh_token, userData });

    await page.goto(`${BASE}/admin.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('.admin-header', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(4000);
    const out = { vp: vp.name, secciones: {}, errs: [] };

    // Secciones principales del menú lateral — tocar botones reales por texto
    const secciones = ['Inicio', 'Citas', 'Clientes', 'Servicios', 'Equipo', 'Configuración', 'Personalizar'];
    for (const s of secciones) {
      const ok = await page.evaluate((label) => {
        const els = Array.from(document.querySelectorAll('button, a, [role="menuitem"], .sidebar-item, .nav-item, [data-tab]'))
          .filter(el => el.offsetParent !== null && (el.textContent || '').trim().slice(0, 30) === label || ((el.textContent || '').includes(label) && el.textContent.trim().length < 30));
        if (!els.length) return { found: false };
        const el = els[0]; const r = el.getBoundingClientRect();
        return { found: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), n: els.length };
      }, s);
      if (ok && ok.found) {
        await page.touchscreen.tap(ok.x, ok.y).catch(() => page.mouse.click(ok.x, ok.y));
        await page.waitForTimeout(2600);
        const estado = await page.evaluate(() => {
          const h = document.querySelector('h1, h2, .view-title, .tab-title');
          const visible = Array.from(document.querySelectorAll('.view, .tab-panel, [class*="view"]')).filter(v => v.offsetParent !== null && v.getBoundingClientRect().width > 100);
          return { h: h ? h.textContent.trim().slice(0, 60) : '', visibles: visible.length };
        });
        out.secciones[s] = { tap: { x: ok.x, y: ok.y, w: ok.w, h: ok.h }, luego: estado };
      } else {
        out.secciones[s] = { tap: null };
      }
      // volver a inicio para no encadenar estados (solo si hay nav de sidebar)
      await page.evaluate(() => { if (window.navigateTo) window.navigateTo('inicio'); }).catch(() => {});
      await page.waitForTimeout(1200);
    }
    out.errs = errs.splice(0);
    console.log('=== ' + vp.name + ' ===\n' + JSON.stringify(out, null, 1));
    await ctx.close();
  }
  await browser.close();
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
