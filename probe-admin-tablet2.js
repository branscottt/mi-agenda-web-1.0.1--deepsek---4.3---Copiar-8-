#!/usr/bin/env node
// probe-admin-tablet2.js — admin en tablet (834/1024) navegando por navigateTo()
// con toque real, midiendo offenders + estado de cada sección + errores JS.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const ROOT = '/home/branscott/proyectos/mi-agenda-web 1.0.1 (deepsek) (4.3) (Copiar 13)';
const BASE = 'https://agenda-organify.vercel.app';
const cfgRaw = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
const get = (k) => { const m = cfgRaw.match(new RegExp(`^${k}=['"]?(.*?)['"]?\\s*$`, 'm')); return m ? m[1] : ''; };
const cfg = { url: get('SUPABASE_URL'), key: get('SUPABASE_KEY') };
const SECCIONES = ['dashboard', 'citas', 'clientes', 'mis-servicios', 'equipo', 'horarios', 'personalizar', 'suscripcion', 'compartir'];

async function login(email, password) {
  const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error('login ' + res.status);
  return await res.json();
}

async function medir(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const offenders = [];
    document.querySelectorAll('body *').forEach((el) => {
      const tag = el.tagName.toLowerCase();
      if (['script', 'style', 'svg', 'path', 'link'].includes(tag)) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || el.offsetParent === null) return;
      const derrame = r.right - vw;
      if (derrame > 2 || r.left < -2) {
        let p = el.parentElement, scrollOk = false;
        while (p && p !== document.body) {
          const ps = getComputedStyle(p);
          if (/(auto|scroll)/.test(ps.overflowX) && p.scrollWidth > p.clientWidth + 2) { scrollOk = true; break; }
          if (ps.overflowX === 'hidden') { scrollOk = true; break; }
          p = p.parentElement;
        }
        if (!scrollOk) offenders.push({ tag, cls: (typeof el.className === 'string' ? el.className : '').slice(0, 55), id: el.id || '', der: Math.round(derrame) });
      }
    });
    return { vw, overflowX: document.documentElement.scrollWidth - vw, offenders: offenders.slice(0, 8), nOff: offenders.length };
  });
}

async function main() {
  const session = await login('admin@demo.com', 'demo123');
  const meta = (session.user && session.user.user_metadata) || {};
  const userData = { id: session.user.id, nombre: meta.nombre || 'Demo', email: 'admin@demo.com', rol: meta.rol || 'admin', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '' };
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  for (const vp of [{ name: '834', width: 834, height: 1112 }, { name: '1024', width: 1024, height: 1366 }, { name: '768', width: 768, height: 1024 }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e.message).slice(0, 130)));
    await page.addInitScript(({ access, refresh, userData }) => {
      localStorage.setItem('agendapro_access_token', access);
      localStorage.setItem('agendapro_refresh_token', refresh);
      localStorage.setItem('agendapro_user_data', JSON.stringify(userData));
    }, { access: session.access_token, refresh: session.refresh_token, userData });

    await page.goto(`${BASE}/admin.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('.admin-header', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(4000);
    console.log(`\n===== vp ${vp.name} =====`);
    for (const s of SECCIONES) {
      const navOk = await page.evaluate((tab) => { if (!window.navigateTo) return false; window.navigateTo(tab); return true; }, s);
      if (!navOk) { console.log(`[${s}] sin navigateTo`); continue; }
      await page.waitForTimeout(3000);
      const m = await medir(page);
      const vis = await page.evaluate(() => {
        const cands = Array.from(document.querySelectorAll('h1, h2, .view-title, .section-title, [class*="header"] h2, [class*="titulo"]')).filter(el => el.offsetParent !== null);
        const txt = cands.length ? cands.map(c => c.textContent.trim().slice(0, 45)).filter(Boolean).slice(0, 2) : [];
        return { txt };
      });
      console.log(`[${s}] h=${JSON.stringify(vis.txt)} overflow=${m.overflowX} nOff=${m.nOff} errs=${errs.length}`);
      if (m.nOff) m.offenders.forEach(o => console.log(`     offender: ${o.tag} .${o.cls} #${o.id} derrame=${o.der}`));
    }
    console.log(`errores JS (${errs.length}):`, [...new Set(errs)].slice(0, 4));
    await ctx.close();
  }
  await browser.close();
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
