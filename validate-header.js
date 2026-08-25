#!/usr/bin/env node
/**
 * validate-header.js — validación del HEADER POLISH (FIX v14).
 * Carga admin/cliente con sesión real, fuerza scroll a top (la app se
 * asienta antes), captura viewport (fiable también en contexto móvil,
 * a diferencia de fullPage) y mide el DOM. NO imprime secretos.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
const OUT = path.join(__dirname, 'responsive-shots', 'verify');
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, isMobile: false, dsf: 1 },
  { name: 'm393', width: 393, height: 852, isMobile: true, dsf: 2 },
];
const PAGES = {
  admin: { file: 'admin.html', email: 'admin@demo.com', password: 'demo123' },
  cliente: { file: 'cliente.html', email: 'cliente@demo.com', password: 'demo123' },
};

function loadSupabaseConfig() {
  const envPath = path.join(__dirname, '.env.local');
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    const get = (k) => {
      const m = raw.match(new RegExp(`^${k}=['"]?(.*?)['"]?\\s*$`, 'm'));
      return m ? m[1] : '';
    };
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

function injectSession(page, session) {
  const meta = (session.user && session.user.user_metadata) || {};
  const userData = {
    id: session.user ? session.user.id : '',
    nombre: meta.nombre || (session.user && session.user.email ? session.user.email.split('@')[0] : 'Usuario'),
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

async function main() {
  const cfg = loadSupabaseConfig();
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const report = [];

  for (const [pageName, p] of Object.entries(PAGES)) {
    const r = await loginREST(cfg, p.email, p.password);
    if (!r.ok) { console.error(`[${pageName}] login falló HTTP ${r.status}`); process.exit(1); }
    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vp.dsf,
        isMobile: vp.isMobile, hasTouch: vp.isMobile,
        userAgent: vp.isMobile
          ? 'Mozilla/5.0 (Linux; Android 13; 22111317G Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
          : undefined,
      });
      const page = await context.newPage();
      await injectSession(page, r.session);
      await page.goto(`${BASE}/${p.file}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(3500);
      // Fuerza scroll a top y deja asentar
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);

      const metrics = await page.evaluate((pageName) => {
        const doc = document.documentElement;
        const vw = doc.clientWidth;
        const sw = Math.max(doc.scrollWidth, document.body.scrollWidth);
        const q = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return {
            top: Math.round(r.top), left: Math.round(r.left),
            right: Math.round(r.right), bottom: Math.round(r.bottom),
            width: Math.round(r.width), height: Math.round(r.height),
            bg: cs.backgroundImage !== 'none' ? cs.backgroundImage.slice(0, 60) : cs.backgroundColor,
            margin: cs.margin, radius: cs.borderRadius,
          };
        };
        const headerSel = pageName === 'admin' ? '.admin-header' : '.client-header';
        const ph = document.querySelector('.profile-header');
        const at = (x, y) => {
          const el = document.elementFromPoint(x, y);
          return el ? (el.className || el.tagName).toString().slice(0, 40) : null;
        };
        return {
          scrollY: Math.round(window.scrollY),
          overflowX: sw - vw,
          profileDocTop: Math.round((ph ? ph.getBoundingClientRect().top : 0) + window.scrollY),
          hasCover: ph ? ph.classList.contains('has-cover') : false,
          profile: q('.profile-header'),
          header: q(headerSel),
          at_0_0: at(0, 0),
          at_5_5: at(5, 5),
          at_centerTop: at(Math.round(vw / 2), 5),
        };
      }, pageName);

      const shotPath = path.join(OUT, `${pageName}-${vp.name}.png`);
      await page.screenshot({ path: shotPath });
      report.push({ page: pageName, vp: vp.name, shot: shotPath, ...metrics });
      await context.close();
    }
  }
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
