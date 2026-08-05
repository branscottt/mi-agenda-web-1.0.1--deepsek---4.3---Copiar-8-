#!/usr/bin/env node
/**
 * magenta-scan.js — Escanea TODAS las vistas admin @393px:
 * 1) elementos con color legacy magenta (rgb(179,0,255)/rgba(179,0,255)/#b300ff)
 * 2) overflow horizontal real (elementos visibles fuera del viewport)
 * 3) elementos con margen/altura excesivos en la parte superior
 */
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = 'http://localhost:8080';
const SUPABASE_URL = 'https://dfcfimipkfhitlsyixqu.supabase.co';
const KEY = fs.readFileSync('/tmp/agendapro-key-clean.txt', 'utf8').trim();

async function loginREST(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error('login fail ' + res.status);
  return res.json();
}

const VISTAS = [
  ['dashboard', 'dashboard'], ['mis-servicios', 'servicios'], ['crear-servicio', 'crear-servicio'],
  ['citas', 'citas'], ['clientes', 'clientes'], ['equipo', 'equipo'], ['horarios', 'horarios'],
  ['compartir-trabajadores', 'compartir-trab'], ['personalizar', 'personalizar'],
  ['compartir', 'compartir-clientes'], ['suscripcion', 'suscripcion'],
];

(async () => {
  const s = await loginREST('admin@demo.com', 'demo123');
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
  let enAdmin = false;
  for (let i = 1; i <= 4 && !enAdmin; i++) {
    await page.goto(`${BASE}/admin.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);
    enAdmin = await page.evaluate(() => !!document.querySelector('.admin-screen'));
    if (!enAdmin) {
      await page.evaluate(([at, rt, ud]) => { localStorage.setItem('agendapro_access_token', at); localStorage.setItem('agendapro_refresh_token', rt); localStorage.setItem('agendapro_user_data', ud); location.reload(); }, [s.access_token, s.refresh_token, ud]);
      await page.waitForTimeout(5000);
      enAdmin = await page.evaluate(() => !!document.querySelector('.admin-screen'));
    }
  }
  if (!enAdmin) { console.log('no admin'); await browser.close(); process.exit(1); }
  await page.waitForTimeout(3000);

  for (const [target, label] of VISTAS) {
    await page.evaluate((t) => { if (window.navigateTo) window.navigateTo(t); }, target);
    await page.waitForTimeout(2600);
    const r = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const magenta = [];
      const overflow = [];
      const cs = getComputedStyle.bind(window);
      document.querySelectorAll('.admin-screen *').forEach((el) => {
        if (el.offsetParent === null) return;
        const st = cs(el);
        const vals = [st.color, st.backgroundColor, st.borderTopColor, st.borderLeftColor, st.boxShadow || '', st.outlineColor];
        const m = vals.find(v => /b300ff|179\s*,\s*0\s*,\s*255|rgba?\(179/i.test(v || ''));
        if (m) {
          const rct = el.getBoundingClientRect();
          if (rct.width > 0 && rct.height > 0) {
            magenta.push({ cls: (el.className || '').toString().slice(0, 45), id: el.id || '', prop: m.slice(0, 50), w: Math.round(rct.width), h: Math.round(rct.height) });
          }
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
      // elementos visibles con margen inferior grande (>24px)
      const bigMargins = [];
      document.querySelectorAll('.admin-screen section, .admin-screen .panel, .admin-screen .glass-panel, .admin-screen .admin-panel, .admin-screen .stats-container, .admin-screen .triple-stats, .admin-screen h3').forEach((el) => {
        if (el.offsetParent === null) return;
        const st = cs(el);
        const mb = parseFloat(st.marginBottom);
        if (mb > 24) {
          const rct = el.getBoundingClientRect();
          bigMargins.push({ cls: (el.className || '').toString().slice(0, 45), id: el.id || '', mb, h: Math.round(rct.height) });
        }
      });
      const visible = document.querySelector('.section-content[style*="block"], #section-' + (window.__curSection || ''));
      return { vw, scrollH: document.documentElement.scrollHeight, magenta: magenta.slice(0, 25), overflow: overflow.slice(0, 10), bigMargins: bigMargins.slice(0, 12) };
    });
    console.log(`\n=== ${label} ===`);
    console.log(`  altura: ${r.scrollH}px`);
    if (r.magenta.length) {
      console.log(`  [MAGENTA LEGACY] ${r.magenta.length}`);
      for (const m of r.magenta.slice(0, 15)) console.log(`    .${m.cls}${m.id ? '#' + m.id : ''} ${m.w}x${m.h} → ${m.prop}`);
    }
    if (r.overflow.length) {
      console.log(`  [OVERFLOW] ${r.overflow.length}`);
      for (const o of r.overflow.slice(0, 8)) console.log(`    ${o.tag}.${o.cls}${o.id ? '#' + o.id : ''} L=${o.L} R=${o.R} W=${o.W}`);
    }
    if (r.bigMargins.length) {
      console.log(`  [MARGENES GRANDES]`);
      for (const b of r.bigMargins.slice(0, 8)) console.log(`    .${b.cls}${b.id ? '#' + b.id : ''} mb=${b.mb}px h=${b.h}px`);
    }
    if (!r.magenta.length && !r.overflow.length && !r.bigMargins.length) console.log('  (limpio)');
  }
  await browser.close();
})();
