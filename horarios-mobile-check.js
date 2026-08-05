#!/usr/bin/env node
/**
 * horarios-mobile-check.js — Audita la vista "Horarios del Equipo" en PRODUCCIÓN
 * con sesión real (admin@demo.com) a viewport móvil 393px (Redmi Note 12 Pro).
 * Navega a la sección horarios, mide el layout (CSS nuevo vs viejo) y captura
 * la vista + el modal editor abierto.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'https://agenda-organify.vercel.app';
const OUT = path.join(__dirname, 'responsive-shots', 'm393');
const SUPABASE_URL = 'https://dfcfimipkfhitlsyixqu.supabase.co';
const KEY = fs.readFileSync('/tmp/agendapro-key.txt', 'utf8').trim();

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
  const VP_W = parseInt(process.env.VP_WIDTH || '393', 10);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({
    viewport: { width: VP_W, height: VP_W < 768 ? 852 : 900 },
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
  const allLogs = [];
  page.on('console', m => {
    const t = m.text().slice(0, 160);
    allLogs.push('[' + m.type() + '] ' + t);
    if (m.type() === 'error') consoleErrors.push(t);
  });
  page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + String(e).slice(0, 160)));

  // Inyectar sesión y entrar al admin con reintento (el AuthGuard puede redirigir a login)
  let enAdmin = false;
  for (let intento = 1; intento <= 4 && !enAdmin; intento++) {
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
  await page.waitForTimeout(1500);

  // Navegar a Horarios (el router SPA requiere navigateTo, no click)
  await page.evaluate(() => { if (window.navigateTo) window.navigateTo('horarios'); });
  await page.waitForTimeout(800);
  await page.evaluate(() => { if (window.__initWorkerSchedule) window.__initWorkerSchedule(); });
  await page.waitForTimeout(4000);

  const report = await page.evaluate(() => {
    const cs = getComputedStyle.bind(window);
    const c = document.getElementById('schedule-container');
    if (!c) return { error: 'sin schedule-container' };
    const corner = document.querySelector('.schedule-corner');
    const wi = document.querySelector('.schedule-worker-info');
    const nav = document.querySelector('.schedule-nav-bar');
    const filas = document.querySelectorAll('.schedule-worker-row');
    const weekCards = document.querySelectorAll('.week-card');
    const hr = document.querySelector('.schedule-header-row');
    const wr = filas[0];
    const celdas = wr ? [...wr.querySelectorAll('.schedule-day-cell')] : [];
    return {
      viewport: innerWidth,
      workers: filas.length,
      corner_texto: corner ? (cs(corner, '::before').content + ' / ' + cs(corner, '::after').content) : 'SIN CORNER',
      wi_position: wi ? cs(wi).position : 'sin wi',
      grid_scrolls: c.scrollWidth > c.clientWidth,
      grid_sw: c.scrollWidth, grid_cw: c.clientWidth,
      header_cols: hr ? cs(hr).gridTemplateColumns : '',
      worker_cols: wr ? cs(wr).gridTemplateColumns : '',
      celdas_ancho: celdas.map(x => Math.round(x.getBoundingClientRect().width)),
      horas_texto: celdas[0] ? celdas[0].textContent.slice(0, 40) : '',
      nav_display: nav ? cs(nav).display : 'sin nav',
      nav_areas: nav ? cs(nav).gridTemplateAreas.replace(/\s+/g, ' ') : '',
      week_label_visible: document.querySelector('.schedule-week-label') ? cs(document.querySelector('.schedule-week-label')).display !== 'none' : 'n/a',
      week_cards: weekCards.length,
      fila_1_h: filas[0] ? Math.round(filas[0].getBoundingClientRect().height) : 0,
      fila_1_detalle: filas[0] ? filas[0].textContent.slice(0, 120) : '',
      overflow_global: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      url: location.pathname,
    };
  });

  // Re-medición en estado estable — sobre el .schedule-container INTERNO (el grid)
  await page.waitForTimeout(6000);
  const report2 = await page.evaluate(() => {
    const c = document.querySelector('.schedule-container');
    if (!c) return null;
    const wr = document.querySelector('.schedule-worker-row');
    const hr = document.querySelector('.schedule-header-row');
    const gp = document.querySelector('.glass-panel.schedule-main-panel');
    const rect = el => el ? { sw: el.scrollWidth, cw: el.clientWidth, w: Math.round(el.getBoundingClientRect().width), ov: getComputedStyle(el).overflowX } : null;
    // Alineación: offset X de la 1ª celda del header vs 1ª celda del trabajador
    const hCell = hr ? hr.children[1] : null;
    const wCell = wr ? wr.children[1] : null;
    const alineacion = (hCell && wCell) ? {
      header_1ra_celda_x: Math.round(hCell.getBoundingClientRect().left),
      worker_1ra_celda_x: Math.round(wCell.getBoundingClientRect().left),
      alineadas: Math.abs(hCell.getBoundingClientRect().left - wCell.getBoundingClientRect().left) < 2,
    } : null;
    return {
      grid_sw: c.scrollWidth, grid_cw: c.clientWidth, grid_scrolls: c.scrollWidth > c.clientWidth,
      worker_cols: wr ? getComputedStyle(wr).gridTemplateColumns : '',
      header_cols: hr ? getComputedStyle(hr).gridTemplateColumns : '',
      celdas: wr ? [...wr.querySelectorAll('.schedule-day-cell')].map(x => Math.round(x.getBoundingClientRect().width)) : [],
      worker_row: rect(wr),
      header_row: rect(hr),
      glass_panel: rect(gp),
      body_sw: document.body.scrollWidth, body_cw: document.body.clientWidth,
      html_sw: document.documentElement.scrollWidth,
      scroll_test: (() => { const before = c.scrollLeft; c.scrollLeft = 200; const after = c.scrollLeft; c.scrollLeft = 0; return { before, after, scrolleable: after > 0 }; })(),
      alineacion,
      horas_visibles: (() => { const t = wCell ? wCell.textContent : ''; return t.length > 3; })(),
    };
  });

  // Screenshot de la vista (scroll al grid)
  await page.evaluate(() => document.querySelector('.schedule-container')?.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, 'horarios-vista.png') });

  // Abrir el modal editor (click en la fila del trabajador)
  let modalReport = null;
  try {
    await page.evaluate(() => {
      const row = document.querySelector('.schedule-worker-row.clickable');
      if (row) row.click();
    });
    await page.waitForTimeout(1500);
    modalReport = await page.evaluate(() => {
      const ov = document.getElementById('schedule-editor-overlay');
      if (!ov) return { error: 'modal no abrió' };
      const cs = getComputedStyle.bind(window);
      const mc = ov.querySelector('.modal-content');
      const filas = [...ov.querySelectorAll('.se-dia-row')];
      return {
        modal_w: Math.round(mc.getBoundingClientRect().width),
        modal_scrollW: mc.scrollWidth,
        modal_overflow: mc.scrollWidth > mc.clientWidth + 1,
        filas: filas.length,
        filas_con_overflow: filas.filter(r => r.scrollWidth > r.clientWidth + 1).length,
        fila_1_display: cs(filas[0]).display,
        fila_1_grid: cs(filas[0]).gridTemplateAreas.replace(/\s+/g, ' '),
        iconos_ocultos: filas.every(r => { const i = r.querySelector('i'); return !i || cs(i).display === 'none'; }),
        uniforme_labels: [...document.querySelectorAll('#se-uniforme .time-input-group')].map(g => cs(g, '::before').content).filter(x => x !== 'none'),
        guardar_h: Math.round((mc.querySelector('.btn-save-primary') || { getBoundingClientRect: () => ({ height: 0 }) }).getBoundingClientRect().height),
        titulo: ov.querySelector('h3') ? ov.querySelector('h3').textContent : '',
      };
    });
    await page.evaluate(() => document.getElementById('schedule-editor-overlay')?.scrollTo(0, 0));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, 'horarios-modal.png') });
  } catch (e) {
    modalReport = { error: e.message };
  }

  console.log(JSON.stringify({ vista: report, vista_estable: report2, modal: modalReport, consoleErrors: consoleErrors.slice(0, 8) }, null, 2));
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
