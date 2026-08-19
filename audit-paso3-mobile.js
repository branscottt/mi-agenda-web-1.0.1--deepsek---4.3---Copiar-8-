#!/usr/bin/env node
/**
 * audit-paso3-mobile.js — Reproduce el PASO 3 (Horarios del servicio) en móvil
 * y mide el desbordamiento horizontal real de cada contenedor.
 * Uso: node audit-paso3-mobile.js [BASE_URL] [VP_WIDTH]
 */
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = process.argv[2] || 'https://agenda-organify.vercel.app';
const VP_W = parseInt(process.argv[3] || '393', 10);
const OUT = 'responsive-shots/paso3';
const SUPABASE_URL = 'https://dfcfimipkfhitlsyixqu.supabase.co';
const KEY = fs.readFileSync('.env.local', 'utf8').match(/SUPABASE_KEY=(.+)/)[1].trim();
const EMAIL = 'admin@demo.com';
const PASSWORD = 'demo123';

async function loginREST() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error('Login REST falló: ' + (await res.text()).slice(0, 200));
  return res.json();
}

(async () => {
  const session = await loginREST();
  const u = session.user;
  const userData = JSON.stringify({
    id: u.id, nombre: u.user_metadata.nombre, email: u.email,
    rol: u.user_metadata.rol, tenant_id: u.user_metadata.tenant_id,
    whatsapp: u.user_metadata.whatsapp,
  });

  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({
    viewport: { width: VP_W, height: 852 },
    isMobile: VP_W < 768, hasTouch: VP_W < 768, deviceScaleFactor: VP_W < 768 ? 2 : 1,
    userAgent: VP_W < 768
      ? 'Mozilla/5.0 (Linux; Android 13; 22111317G Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
      : 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  await ctx.addInitScript(([at, rt, ud]) => {
    localStorage.setItem('agendapro_access_token', at);
    localStorage.setItem('agendapro_refresh_token', rt);
    localStorage.setItem('agendapro_user_data', ud);
  }, [session.access_token, session.refresh_token, userData]);

  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + String(e).slice(0, 200)));

  await page.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  // DIAGNÓSTICO DE SESIÓN
  const diag = await page.evaluate(() => {
    const ls = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && /agendapro|supabase/i.test(k)) ls[k] = (localStorage.getItem(k) || '').slice(0, 40);
    }
    return {
      url: location.href,
      title: document.title,
      ls,
      tieneLoginScreen: !!document.querySelector('.login-screen, #login-screen'),
      tieneAdminScreen: !!document.querySelector('.admin-screen, #admin-screen'),
      sectionCrearVisible: (document.getElementById('section-crear-servicio') || {}).style?.display,
      bodySnippet: (document.body.innerText || '').slice(0, 300).replace(/\n+/g, ' | '),
    };
  });
  console.log('=== DIAGNÓSTICO ===');
  console.log(JSON.stringify(diag, null, 1));

  // Ir a Crear Servicio
  await page.evaluate(() => {
    const btn = document.querySelector('[data-section="crear-servicio"]');
    if (btn) btn.click();
  });
  await page.waitForTimeout(1500);

  // Abrir el details del paso 3
  const paso3Abierto = await page.evaluate(() => {
    const details = document.querySelectorAll('details.form-step');
    for (const d of details) {
      if (d.textContent.includes('Horarios del servicio')) {
        d.open = true;
        return true;
      }
    }
    return false;
  });
  console.log('Paso 3 abierto:', paso3Abierto);
  await page.waitForTimeout(800);

  // Generar módulos (3 por defecto)
  const genOK = await page.evaluate(() => {
    const btn = document.getElementById('generate-modules-btn');
    if (!btn) return false;
    btn.click();
    return true;
  });
  console.log('Generar clickeado:', genOK);
  await page.waitForTimeout(1500);

  // MEDIR desbordamiento
  const medidas = await page.evaluate(() => {
    const docW = document.documentElement.clientWidth;
    const res = { viewport: docW };
    const sels = [
      '#modules-list', '.modules-list', '.module-card', '.module-card-body',
      '.module-time-group .module-time-selects', '.modulo-row', '.fecha-card',
      '.module-generator-controls', '.step-content', '.assignment-mode-selector',
      '.mode-selector-buttons', '#confirm-modules-btn', '.modules-list-container',
      '.hierarchy-status-bar', 'details.form-step[open] .step-content'
    ];
    for (const sel of sels) {
      const els = document.querySelectorAll(sel);
      if (els.length === 0) { res[sel] = 'NO ENCONTRADO'; continue; }
      const info = [];
      els.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        info.push({
          i, left: Math.round(r.left), right: Math.round(r.right),
          w: Math.round(r.width), scrollW: el.scrollWidth,
          overflow: el.scrollWidth > el.clientWidth + 1,
          clientW: el.clientWidth,
          display: getComputedStyle(el).display,
        });
      });
      res[sel] = info;
    }
    return res;
  });
  console.log('=== MEDIDAS (viewport ' + medidas.viewport + 'px) ===');
  for (const [k, v] of Object.entries(medidas)) {
    if (k === 'viewport') continue;
    if (v === 'NO ENCONTRADO') { console.log(k + ': NO ENCONTRADO'); continue; }
    for (const it of v) {
      const desborda = it.overflow ? '⚠️ DESBORDA' : 'ok';
      console.log(`${k}[${it.i}] left=${it.left} right=${it.right} w=${it.w} scrollW=${it.scrollW} clientW=${it.clientW} ${desborda} (${it.display})`);
    }
  }

  // Detectar scroll horizontal global
  const globalOverflow = await page.evaluate(() => {
    const de = document.documentElement;
    return { docScrollW: de.scrollWidth, docClientW: de.clientWidth };
  });
  console.log('=== GLOBAL ===');
  console.log('document scrollWidth:', globalOverflow.docScrollW, 'clientWidth:', globalOverflow.docClientW,
    globalOverflow.docScrollW > globalOverflow.docClientW ? '⚠️ LA PAGINA DESBORDA' : 'ok');

  await page.screenshot({ path: OUT + '/paso3-mobile-' + VP_W + '.png', fullPage: false });
  console.log('Screenshot: ' + OUT + '/paso3-mobile-' + VP_W + '.png');
  if (consoleErrors.length) {
    console.log('=== ERRORES CONSOLA ===');
    consoleErrors.slice(0, 10).forEach(e => console.log(e));
  } else {
    console.log('Sin errores de consola');
  }
  await browser.close();
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
