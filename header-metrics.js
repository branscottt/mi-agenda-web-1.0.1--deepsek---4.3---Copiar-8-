#!/usr/bin/env node
/**
 * header-metrics.js — métricas DOM exactas del header (admin + cliente)
 * en varios viewports, con sesión real inyectada (mismo patrón que
 * responsive-viewer.js). NO imprime tokens ni secretos.
 *
 * Uso: node header-metrics.js [admin|cliente]
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, isMobile: false, dsf: 1 },
  { name: 'tablet', width: 768, height: 1024, isMobile: true, dsf: 1 },
  { name: 'm393', width: 393, height: 852, isMobile: true, dsf: 2 },
  { name: 'm375', width: 375, height: 667, isMobile: true, dsf: 2 },
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

async function metrics(page, pageName) {
  return page.evaluate((pageName) => {
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
        pos: cs.position, display: cs.display,
        bg: cs.backgroundImage !== 'none' ? cs.backgroundImage.slice(0, 90) : cs.backgroundColor,
        padding: cs.padding, margin: cs.margin,
        radius: cs.borderRadius,
      };
    };
    const headerSel = pageName === 'admin' ? '.admin-header' : '.client-header';
    const profile = q('.profile-header');
    const header = q(headerSel);
    const cover = q('.cover-banner-container');
    const ph = document.querySelector('.profile-header');
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    const phBefore = ph ? getComputedStyle(ph, '::before').backgroundImage : '';
    const phBeforeH = ph ? getComputedStyle(ph, '::before').height : '';
    // Posición en el DOCUMENTO (independiente del scroll)
    const docTop = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      return Math.round(el.getBoundingClientRect().top + window.scrollY);
    };
    // ¿Qué elemento hay realmente en el píxel (0,0) del viewport y en (20,20)?
    const at = (x, y) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      return { tag: el.tagName, id: el.id || '', cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60) };
    };
    // Estilos inyectados por config visual del tenant
    const tenantStyle = document.getElementById('tenant-custom-styles');
    const headerBgRule = tenantStyle ? [...tenantStyle.sheet.cssRules]
      .filter(r => r.selectorText && /admin-header|client-header/.test(r.selectorText))
      .map(r => r.cssText) : [];
    return {
      page: pageName,
      viewport: vw, scrollWidth: sw, overflowX: sw - vw,
      scrollY: Math.round(window.scrollY),
      pageHeight: Math.round(document.documentElement.scrollHeight),
      hasCover: ph ? ph.classList.contains('has-cover') : false,
      bodyBg,
      profile, header, cover,
      phBefore: phBefore !== 'none' ? phBefore.slice(0, 120) : 'none',
      phBeforeHeight: phBeforeH,
      profileDocTop: docTop('.profile-header'),
      headerDocTop: docTop(headerSel),
      firstScreenChild: (() => {
        const sc = document.querySelector('.admin-screen, .client-screen');
        return sc ? sc.firstElementChild ? sc.firstElementChild.className : null : null;
      })(),
      elementAt_0_0: at(0, 0),
      elementAt_20_20: at(20, 20),
      elementAt_100_100: at(100, 100),
      headerBgRule,
      headerLeft: q(headerSel + ' .header-left'),
      headerRight: q(headerSel + ' .header-right'),
      h1: q(headerSel + ' h1'),
      tenantBrand: q('.tenant-brand'),
      tenantLogo: q('#tenant-logo'),
      tenantName: q('.tenant-name-header'),
      notifBell: q('.notif-bell-wrapper'),
      btnBack: q('.btn-back'),
      btnGrad: q('header .btn-grad'),
    };
  }, pageName);
}

async function main() {
  const only = process.argv[2] || 'admin';
  const cfg = loadSupabaseConfig();
  const p = PAGES[only];
  if (!p) { console.error('Página inválida'); process.exit(1); }

  const r = await loginREST(cfg, p.email, p.password);
  if (!r.ok) { console.error(`Login falló HTTP ${r.status}`); process.exit(1); }

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const report = [];
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
    report.push({ vp: vp.name, ...(await metrics(page, only)) });
    await context.close();
  }
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
