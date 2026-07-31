#!/usr/bin/env node
/**
 * responsive-viewer.js — "Responsive Viewer" para Agenda Pro.
 *
 * Captura cada página de la web en 4 viewports (desktop / tablet / móvil 393px / móvil 375px),
 * con sesión real inyectada vía Supabase Auth REST (evita el captcha del formulario),
 * y reporta overflow horizontal + elementos que sobresalen del viewport.
 *
 * Uso:
 *   node responsive-viewer.js                # captura todo (login, planes, admin, cliente)
 *   node responsive-viewer.js --page login   # solo una página
 *   node responsive-viewer.js --vp m393      # solo un viewport
 *
 * Salida: responsive-shots/<viewport>/<pagina>.png + responsive-shots/report.json
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const OUT = path.join(__dirname, 'responsive-shots');

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, isMobile: false, dsf: 1 },
  { name: 'tablet', width: 768, height: 1024, isMobile: true, dsf: 1 },
  { name: 'm393', width: 393, height: 852, isMobile: true, dsf: 2 }, // Redmi Note 12 Pro
  { name: 'm375', width: 375, height: 667, isMobile: true, dsf: 2 }, // iPhone SE
];

const PAGES_PUBLIC = [
  { file: 'login.html', name: 'login' },
  { file: 'planes.html', name: 'planes' },
];

const PAGES_AUTH = [
  { file: 'admin.html', name: 'admin', email: 'admin@demo.com', password: 'demo123' },
  { file: 'cliente.html', name: 'cliente', email: 'cliente@demo.com', password: 'demo123' },
];

// ── Leer config de Supabase: env > /tmp/agendapro-key.txt (prod) > .env.local ──
function loadSupabaseConfig() {
  // 1. Variables de entorno explícitas
  if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    return { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_KEY };
  }
  // 2. Key extraída del bundle de producción (anon key pública)
  try {
    const prodKey = fs.readFileSync('/tmp/agendapro-key.txt', 'utf8').trim();
    if (prodKey && prodKey.length > 100) {
      return { url: 'https://dfcfimipkfhitlsyixqu.supabase.co', key: prodKey };
    }
  } catch { /* no existe */ }
  // 3. Fallback: .env.local
  const envPath = path.join(__dirname, '.env.local');
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    const get = (k) => {
      const m = raw.match(new RegExp(`^${k}=['"]?(.*?)['"]?\\s*$`, 'm'));
      return m ? m[1] : '';
    };
    return { url: get('SUPABASE_URL'), key: get('SUPABASE_KEY') };
  } catch {
    return { url: '', key: '' };
  }
}

// ── Login REST contra Supabase Auth (sin captcha) ──
async function loginREST(cfg, email, password) {
  const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: err.slice(0, 200) };
  }
  return { ok: true, session: await res.json() };
}

// ── Inyectar sesión en localStorage ANTES de cargar la página ──
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

// ── Métricas: overflow horizontal + elementos fuera de viewport ──
async function measure(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const vw = doc.clientWidth;
    const sw = Math.max(doc.scrollWidth, document.body.scrollWidth);
    const offenders = [];
    document.querySelectorAll('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > vw + 1 || r.left < -1)) {
        let p = el.parentElement;
        let insideScroll = false;
        while (p) {
          const ps = getComputedStyle(p);
          if (/(auto|scroll)/.test(ps.overflowX) && p.scrollWidth > p.clientWidth) {
            insideScroll = true;
            break;
          }
          p = p.parentElement;
        }
        if (!insideScroll && el.offsetParent !== null) {
          offenders.push({
            tag: el.tagName.toLowerCase(),
            cls: (typeof el.className === 'string' ? el.className : '').slice(0, 70),
            id: el.id || '',
            left: Math.round(r.left),
            right: Math.round(r.right),
            width: Math.round(r.width),
          });
        }
      }
    });
    return {
      viewport: vw,
      scrollWidth: sw,
      overflowX: sw - vw,
      offenders: offenders.slice(0, 12),
    };
  });
}

async function capturePage(page, vp, pageName, file) {
  const url = `${BASE}/${file}`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  // Esperar a que la app renderice (SPA)
  await page.waitForTimeout(3500);
  const metrics = await measure(page);
  const shotPath = path.join(OUT, vp.name, `${pageName}.png`);
  await page.screenshot({ path: shotPath, fullPage: true });
  return { page: pageName, ...metrics, screenshot: shotPath };
}

async function main() {
  const args = process.argv.slice(2);
  const onlyPage = args.includes('--page') ? args[args.indexOf('--page') + 1] : null;
  const onlyVp = args.includes('--vp') ? args[args.indexOf('--vp') + 1] : null;

  const cfg = loadSupabaseConfig();
  fs.mkdirSync(OUT, { recursive: true });
  const report = [];

  // Login REST una sola vez por cuenta
  const sessions = {};
  if (cfg.url && cfg.key) {
    for (const p of PAGES_AUTH) {
      const r = await loginREST(cfg, p.email, p.password);
      if (r.ok) {
        sessions[p.email] = r.session;
        console.log(`[auth] sesión OK para ${p.email}`);
      } else {
        console.log(`[auth] FALLO login ${p.email} (HTTP ${r.status}): ${r.error}`);
      }
    }
  } else {
    console.log('[auth] .env.local sin SUPABASE_URL/KEY — solo páginas públicas');
  }

  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  for (const vp of VIEWPORTS) {
    if (onlyVp && vp.name !== onlyVp) continue;
    fs.mkdirSync(path.join(OUT, vp.name), { recursive: true });
    console.log(`\n=== Viewport: ${vp.name} (${vp.width}x${vp.height}) ===`);

    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.dsf,
      isMobile: vp.isMobile,
      hasTouch: vp.isMobile,
      userAgent: vp.isMobile
        ? 'Mozilla/5.0 (Linux; Android 13; 22111317G Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
        : undefined,
    });

    for (const p of PAGES_PUBLIC) {
      if (onlyPage && p.name !== onlyPage) continue;
      const page = await context.newPage();
      const r = await capturePage(page, vp, p.name, p.file);
      console.log(`  ${p.name}: overflow=${r.overflowX}px offenders=${r.offenders.length}`);
      report.push(r);
      await page.close();
    }

    for (const p of PAGES_AUTH) {
      if (onlyPage && p.name !== onlyPage) continue;
      const session = sessions[p.email];
      if (!session) {
        console.log(`  ${p.name}: SIN SESIÓN (login falló) — omitida`);
        continue;
      }
      const page = await context.newPage();
      await injectSession(page, session);
      const r = await capturePage(page, vp, p.name, p.file);
      console.log(`  ${p.name}: overflow=${r.overflowX}px offenders=${r.offenders.length}`);
      report.push(r);
      await page.close();
    }

    await context.close();
  }

  await browser.close();

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\nReporte: ${path.join(OUT, 'report.json')}`);
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
