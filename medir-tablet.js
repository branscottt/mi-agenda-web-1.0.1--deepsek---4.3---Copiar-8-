#!/usr/bin/env node
/**
 * medir-tablet.js — Barrido de evidencia "tablet" para Agenda Pro (prod).
 * Mide overflow horizontal + elementos que se salen del viewport + targets
 * táctiles pequeños, en los anchos reales de tablet (768/800/834/1024px),
 * TODOS con hasTouch (pointer:coarse) — reproduciendo el entorno físico.
 *
 * Uso: node medir-tablet.js
 * Salida: JSON a stdout (compacto por página/viewport).
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'https://agenda-organify.vercel.app';
const OUT = path.join(__dirname, 'e2e-shots');

const VIEWPORTS = [
  { name: 't768',  width: 768,  height: 1024 },  // iPad 9.7/10.2 vertical
  { name: 't800',  width: 800,  height: 1280 },  // Android tablet vertical
  { name: 't834',  width: 834,  height: 1112 },  // iPad Air vertical
  { name: 't1024', width: 1024, height: 1366 },  // iPad Pro 11 vertical
];

const PAGES_PUBLIC = [
  { file: 'index.html', name: 'index' },
  { file: 'login.html', name: 'login' },
  { file: 'planes.html', name: 'planes' },
  { file: 'directorio.html', name: 'directorio' },
];

const PAGES_AUTH = [
  { file: 'admin.html', name: 'admin', email: 'admin@demo.com', password: 'demo123', tab: null },
  { file: 'admin.html', name: 'admin-clientes', email: 'admin@demo.com', password: 'demo123', tab: 'clientes' },
  { file: 'cliente.html', name: 'cliente', email: 'cliente@demo.com', password: 'demo123', tab: null },
];

function loadSupabaseConfig() {
  const envPath = path.join(__dirname, '.env.local');
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    const get = (k) => { const m = raw.match(new RegExp(`^${k}=['"]?(.*?)['"]?\\s*$`, 'm')); return m ? m[1] : ''; };
    return { url: get('SUPABASE_URL'), key: get('SUPABASE_KEY') };
  } catch { return { url: '', key: '' }; }
}

async function loginREST(cfg, email, password) {
  const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, session: await res.json() };
}

function inyectarSesion(page, session) {
  const meta = (session.user && session.user.user_metadata) || {};
  const userData = {
    id: session.user ? session.user.id : '',
    nombre: meta.nombre || 'Demo',
    email: session.user ? session.user.email : '',
    rol: meta.rol || 'cliente',
    tenant_id: meta.tenant_id,
    whatsapp: meta.whatsapp || '',
  };
  return page.addInitScript(
    ({ access, refresh, userData }) => {
      localStorage.setItem('agendapro_access_token', access);
      localStorage.setItem('agendapro_refresh_token', refresh);
      localStorage.setItem('agendapro_user_data', JSON.stringify(userData));
    },
    { access: session.access_token, refresh: session.refresh_token, userData }
  );
}

async function medir(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const vw = doc.clientWidth;
    const sw = Math.max(doc.scrollWidth, document.body.scrollWidth);
    const offenders = [];
    document.querySelectorAll('body *').forEach((el) => {
      const tag = el.tagName.toLowerCase();
      if (['script', 'style', 'svg', 'path', 'link', 'meta'].includes(tag)) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const derrame = r.right - vw;
      const izq = r.left;
      if ((derrame > 2 || izq < -2) && el.offsetParent !== null) {
        // ¿está dentro de un contenedor con scroll horizontal propio? (ej. columnas kanban)
        let p = el.parentElement, dentroScroll = false;
        while (p && p !== document.body) {
          const ps = getComputedStyle(p);
          if (/(auto|scroll)/.test(ps.overflowX) && p.scrollWidth > p.clientWidth + 2) { dentroScroll = true; break; }
          p = p.parentElement;
        }
        if (!dentroScroll) {
          offenders.push({
            tag, cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60),
            id: el.id || '', right: Math.round(r.right), vw: Math.round(r.right - vw), left: Math.round(r.left),
          });
        }
      }
    });
    // Targets táctiles pequeños (botones/links visibles < 36px de alto)
    let targetsChicos = 0;
    document.querySelectorAll('button, a, select, input[type="checkbox"], input[type="radio"], [role="button"], [onclick]').forEach((el) => {
      if (el.offsetParent === null) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (r.height < 36 || r.width < 36) targetsChicos++;
    });
    return { vw, sw, overflowX: sw - vw, offenders: offenders.slice(0, 10), nOffenders: offenders.length, targetsChicos };
  });
}

async function esperarApp(page, name) {
  // Esperar marca de app renderizada según página
  try {
    if (name.startsWith('admin')) await page.waitForSelector('.admin-header, .sidebar, #app-content', { timeout: 15000 });
    else if (name === 'cliente') await page.waitForSelector('.client-header, .catalog, #services-container, .profile-header', { timeout: 15000 });
    else await page.waitForTimeout(2500);
  } catch { /* lo que haya */ }
  await page.waitForTimeout(1200);
}

async function main() {
  const cfg = loadSupabaseConfig();
  const report = [];
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  // Login REST una vez por cuenta (evitar rate-limit)
  const sessions = {};
  for (const p of PAGES_AUTH) {
    if (sessions[p.email]) continue;
    const r = await loginREST(cfg, p.email, p.password);
    if (r.ok) { sessions[p.email] = r.session; console.log(`[auth] OK ${p.email}`); }
    else console.log(`[auth] FALLO ${p.email} HTTP ${r.status}`);
  }

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1, isMobile: false, hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-X700 Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e.message).slice(0, 120)));

    for (const p of PAGES_PUBLIC) {
      try {
        await page.goto(`${BASE}/${p.file}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await esperarApp(page, p.name);
        const m = await medir(page);
        const shot = `${OUT}/tablet/${vp.name}-${p.name}.png`;
        await page.screenshot({ path: shot }).catch(() => {});
        report.push({ page: p.name, vp: vp.name, ...m, screenshot: shot, errs: errs.splice(0) });
        console.log(`[${vp.name}] ${p.name}: overflow=${m.overflowX}px offenders=${m.nOffenders} targets<36px=${m.targetsChicos}`);
      } catch (e) { console.log(`[${vp.name}] ${p.name}: ERROR ${String(e.message).slice(0, 100)}`); }
    }

    for (const p of PAGES_AUTH) {
      const session = sessions[p.email];
      if (!session) { console.log(`[${vp.name}] ${p.name}: sin sesión — omitido`); continue; }
      try {
        const ctx2 = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          deviceScaleFactor: 1, isMobile: false, hasTouch: true,
          userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-X700 Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        });
        const page2 = await ctx2.newPage();
        await inyectarSesion(page2, session);
        await page2.goto(`${BASE}/${p.file}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await esperarApp(page2, p.name);
        if (p.tab) {
          await page2.evaluate(() => { if (window.navigateTo) window.navigateTo('clientes'); }).catch(() => {});
          await page2.waitForTimeout(3500);
        }
        const m = await medir(page2);
        const shot = `${OUT}/tablet/${vp.name}-${p.name}.png`;
        await page2.screenshot({ path: shot }).catch(() => {});
        report.push({ page: p.name, vp: vp.name, ...m, screenshot: shot, errs: errs.splice(0) });
        console.log(`[${vp.name}] ${p.name}: overflow=${m.overflowX}px offenders=${m.nOffenders} targets<36px=${m.targetsChicos}`);
        await ctx2.close();
      } catch (e) { console.log(`[${vp.name}] ${p.name}: ERROR ${String(e.message).slice(0, 100)}`); }
    }
    await ctx.close();
  }

  await browser.close();
  fs.mkdirSync(`${OUT}/tablet`, { recursive: true });
  fs.writeFileSync(`${OUT}/tablet-report.json`, JSON.stringify(report, null, 2));
  console.log(`\nReporte: ${OUT}/tablet-report.json`);
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
