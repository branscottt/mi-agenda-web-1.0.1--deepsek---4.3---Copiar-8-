#!/usr/bin/env node
/**
 * mobile-audit.js — Auditoría móvil completa de Agenda Pro @393px (Redmi Note 12 Pro).
 * Sesión real admin vía Supabase Auth REST + patrón de reintento (AuthGuard puede
 * redirigir a login y login.html puede borrar las claves inyectadas).
 * Recorre: dashboard + todas las vistas del sidebar + cliente.
 * Mide: overflow horizontal, texto cortado, botones pequeños, stats.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const OUT = path.join(__dirname, 'responsive-shots', 'm393');
const SUPABASE_URL = 'https://dfcfimipkfhitlsyixqu.supabase.co';
const KEY = fs.readFileSync('/tmp/agendapro-key-clean.txt', 'utf8').trim();
const VP_W = parseInt(process.env.VP_WIDTH || '393', 10);

async function loginREST(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error('Login REST falló: ' + res.status);
  return res.json();
}

async function auditView(page, label) {
  await page.waitForTimeout(2200);
  const data = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const issues = [];

    // 1. Texto cortado (scrollWidth > clientWidth en contenedor overflow hidden)
    document.querySelectorAll('body *').forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.overflowX === 'hidden' && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.width < vw && el.offsetParent !== null) {
          issues.push({
            tipo: 'TEXTO_CORTADO', tag: el.tagName.toLowerCase(),
            cls: (el.className || '').toString().slice(0, 45), id: el.id || '',
            w: Math.round(el.clientWidth), sw: el.scrollWidth,
          });
        }
      }
    });

    // 2. Botones < 34px de alto
    document.querySelectorAll('button, .btn-grad, .btn-secondary, .btn-small, .btn-icon, .btn-primary').forEach((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width > 0 && r.height > 0 && r.height < 34 && cs.display !== 'none' && el.offsetParent !== null) {
        issues.push({
          tipo: 'BOTON_PEQUENO', tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().slice(0, 45), id: el.id || '',
          h: Math.round(r.height), w: Math.round(r.width),
        });
      }
    });

    // 3. Fuera de viewport (excluyendo sidebar/decoración y sus descendientes)
    document.querySelectorAll('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && el.offsetParent !== null && (r.right > vw + 1 || r.left < -1)) {
        const cls = (el.className || '').toString();
        if (cls.includes('sidebar') || cls.includes('bg-circle')) return;
        let p = el.parentElement;
        let dentroSidebar = false;
        while (p) {
          const pc = (p.className || '').toString();
          if (pc.includes('sidebar') || pc.includes('bg-circle')) { dentroSidebar = true; break; }
          p = p.parentElement;
        }
        if (dentroSidebar) return;
        issues.push({
          tipo: 'FUERA_PANTALLA', tag: el.tagName.toLowerCase(),
          cls: cls.slice(0, 45), id: el.id || '',
          L: Math.round(r.left), R: Math.round(r.right), W: Math.round(r.width),
        });
      }
    });

    // 4. Tarjetas y elementos clave visibles
    const statBoxes = Array.from(document.querySelectorAll('.stat-box, .stat-card')).map((el) => {
      const r = el.getBoundingClientRect();
      return { cls: (el.className || '').toString().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height), txt: el.innerText.replace(/\s+/g, ' ').slice(0, 60) };
    });
    const headers = Array.from(document.querySelectorAll('.admin-header, .client-header')).map((el) => {
      const r = el.getBoundingClientRect();
      return { h: Math.round(r.height), txt: el.innerText.replace(/\s+/g, ' ').slice(0, 80) };
    });

    return {
      vw, url: location.pathname,
      overflow: document.documentElement.scrollWidth - vw,
      scrollHeight: document.documentElement.scrollHeight,
      issues, statBoxes, headers,
      screen: (document.querySelector('.admin-screen') ? 'admin' : (document.querySelector('.client-screen') ? 'cliente' : (document.querySelector('.login-screen') ? 'login' : 'otro'))),
    };
  });

  await page.screenshot({ path: path.join(OUT, `audit-${label}.png`), fullPage: true });
  console.log(`\n=== VISTA: ${label} (${data.screen}) ===`);
  console.log(`  altura: ${data.scrollHeight}px | overflowX: ${data.overflow}px`);
  if (data.headers.length) console.log(`  headers: ${data.headers.map(h => `${h.h}px [${h.txt}]`).join(' | ')}`);
  if (data.statBoxes.length) console.log(`  stats: ${data.statBoxes.map(s => `${s.w}x${s.h}px "${s.txt}"`).join(' | ')}`);
  const byType = {};
  for (const i of data.issues) {
    byType[i.tipo] = byType[i.tipo] || [];
    byType[i.tipo].push(i);
  }
  for (const [tipo, list] of Object.entries(byType)) {
    console.log(`  [${tipo}] ${list.length}`);
    for (const i of list.slice(0, 10)) {
      console.log(`    ${i.tag}.${i.cls}${i.id ? '#' + i.id : ''} ${i.w ? 'w=' + i.w : ''}${i.sw ? ' sw=' + i.sw : ''}${i.h ? ' h=' + i.h : ''}${i.L !== undefined ? ' L=' + i.L + ' R=' + i.R : ''}`);
    }
  }
  return data;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const session = await loginREST('admin@demo.com', 'demo123');
  const u = session.user;
  const meta = u.user_metadata || {};
  const userData = JSON.stringify({
    id: u.id, nombre: meta.nombre || 'Admin', email: u.email,
    rol: meta.rol || 'admin', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '',
  });

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({
    viewport: { width: VP_W, height: 852 },
    deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; 22111317G Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  });
  await ctx.addInitScript(([at, rt, ud]) => {
    localStorage.setItem('agendapro_access_token', at);
    localStorage.setItem('agendapro_refresh_token', rt);
    localStorage.setItem('agendapro_user_data', ud);
  }, [session.access_token, session.refresh_token, userData]);

  const page = await ctx.newPage();
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)); });
  page.on('pageerror', e => errs.push('PAGEERROR: ' + String(e).slice(0, 120)));

  // Entrar al admin con reintento (AuthGuard puede redirigir a login)
  let enAdmin = false;
  for (let i = 1; i <= 4 && !enAdmin; i++) {
    await page.goto(`${BASE}/admin.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);
    enAdmin = await page.evaluate(() => !!document.querySelector('.admin-screen'));
    if (!enAdmin) {
      await page.evaluate(([at, rt, ud]) => {
        localStorage.setItem('agendapro_access_token', at);
        localStorage.setItem('agendapro_refresh_token', rt);
        localStorage.setItem('agendapro_user_data', ud);
        location.reload();
      }, [session.access_token, session.refresh_token, userData]);
      await page.waitForTimeout(5000);
      enAdmin = await page.evaluate(() => !!document.querySelector('.admin-screen'));
    }
  }
  if (!enAdmin) {
    console.log('NO se pudo entrar al admin. Errores:', errs.slice(0, 10).join('\n'));
    await browser.close();
    process.exit(1);
  }

  // Dashboard
  await auditView(page, 'dashboard');

  // Vistas del sidebar vía navigateTo (router SPA)
  const vistas = [
    ['mis-servicios', 'servicios'], ['crear-servicio', 'crear-servicio'], ['citas', 'citas'], ['clientes', 'clientes'],
    ['equipo', 'equipo'], ['horarios', 'horarios'], ['compartir-trabajadores', 'compartir-trab'],
    ['personalizar', 'personalizar'], ['compartir', 'compartir-clientes'], ['suscripcion', 'suscripcion'],
  ];
  for (const [target, label] of vistas) {
    await page.evaluate((t) => { if (window.navigateTo) window.navigateTo(t); }, target);
    await page.waitForTimeout(2500);
    const ok = await page.evaluate(() => !!document.querySelector('.admin-screen'));
    if (!ok) {
      console.log(`\n=== VISTA: ${label} — no cargó (¿ruta inexistente?) ===`);
      continue;
    }
    await auditView(page, label);
  }

  // Cliente (segunda sesión)
  const sessC = await loginREST('cliente@demo.com', 'demo123');
  const uc = sessC.user;
  const metac = uc.user_metadata || {};
  const ctxC = await browser.newContext({
    viewport: { width: VP_W, height: 852 },
    deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; 22111317G Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  });
  await ctxC.addInitScript(([at, rt, ud]) => {
    localStorage.setItem('agendapro_access_token', at);
    localStorage.setItem('agendapro_refresh_token', rt);
    localStorage.setItem('agendapro_user_data', ud);
  }, [sessC.access_token, sessC.refresh_token, JSON.stringify({
    id: uc.id, nombre: metac.nombre || 'Cliente', email: uc.email,
    rol: metac.rol || 'cliente', tenant_id: metac.tenant_id, whatsapp: metac.whatsapp || '',
  })]);
  const pageC = await ctxC.newPage();
  let enCliente = false;
  for (let i = 1; i <= 4 && !enCliente; i++) {
    await pageC.goto(`${BASE}/cliente.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await pageC.waitForTimeout(5000);
    enCliente = await pageC.evaluate(() => !!document.querySelector('.client-screen'));
    if (!enCliente) {
      await pageC.evaluate(([at, rt, ud]) => {
        localStorage.setItem('agendapro_access_token', at);
        localStorage.setItem('agendapro_refresh_token', rt);
        localStorage.setItem('agendapro_user_data', ud);
        location.reload();
      }, [sessC.access_token, sessC.refresh_token, JSON.stringify({
        id: uc.id, nombre: metac.nombre || 'Cliente', email: uc.email,
        rol: metac.rol || 'cliente', tenant_id: metac.tenant_id, whatsapp: metac.whatsapp || '',
      })]);
      await pageC.waitForTimeout(5000);
      enCliente = await pageC.evaluate(() => !!document.querySelector('.client-screen'));
    }
  }
  if (enCliente) await auditView(pageC, 'cliente');

  await browser.close();
  console.log('\n[errores consola]', errs.slice(0, 8).join(' | ') || 'ninguno');
})();
