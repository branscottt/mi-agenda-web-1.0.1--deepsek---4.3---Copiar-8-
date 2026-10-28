#!/usr/bin/env node
// Verifica el BLOQUE PAGADO del LIVE con datos reales de un LIVE con prendas pagadas,
// interceptando solo la respuesta del RPC (no se toca la base).
const { chromium } = require('playwright');
const fs = require('fs');
const SUPABASE_URL = 'https://dfcfimipkfhitlsyixqu.supabase.co';
const KEY = fs.readFileSync('/tmp/agendapro-key-clean.txt', 'utf8').trim();
const BASE = 'http://localhost:8099/ventas-live.html';

const PAGADO = {
  ok: true,
  live: { id: 'ebbfe24a-fdb6-4edf-a096-9d78005db53b', etiqueta: 'LIVE 2026-10-28' },
  n_pagadas: 4, total_pagado: 25000,
  n_sin_pagar: 1, total_sin_pagar: 14000,
  pagadas: [
    { id: '71cb08cc', precio: 3000, estado: 'pagada', tiktok_user: 'gasparinajavi' },
    { id: 'fd91677f', precio: 2000, estado: 'pagada', tiktok_user: 'watonasugoi' },
    { id: '8ef1cd98', precio: 8000, estado: 'pagada', tiktok_user: 'bybabbinails' },
    { id: '493504df', precio: 12000, estado: 'entregada', tiktok_user: 'dark.cl7' }
  ]
};

(async () => {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.com', password: 'demo123' }),
  });
  const s = await r.json();
  const u = s.user, meta = u.user_metadata || {};
  const ud = JSON.stringify({ id: u.id, nombre: meta.nombre || 'Admin', email: u.email, rol: meta.rol || 'admin', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '' });
  const sbTok = JSON.stringify({ access_token: s.access_token, refresh_token: s.refresh_token, expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user: u });

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const v of [
    { nombre: 'movil-pagado', width: 393, height: 852, isMobile: true, hasTouch: true },
    { nombre: 'pc-pagado', width: 1280, height: 720, isMobile: false, hasTouch: false },
  ]) {
    const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: 2, isMobile: v.isMobile, hasTouch: v.hasTouch });
    await ctx.addInitScript(([at, rt, ud, sb]) => {
      localStorage.setItem('agendapro_access_token', at);
      localStorage.setItem('agendapro_refresh_token', rt);
      localStorage.setItem('agendapro_user_data', ud);
      localStorage.setItem('sb-dfcfimipkfhitlsyixqu-auth-token', sb);
    }, [s.access_token, s.refresh_token, ud, sbTok]);
    const page = await ctx.newPage();
    // Solo esta llamada se simula con datos de un LIVE real con ventas pagadas.
    await page.route('**/rest/v1/rpc/vl_live_vendido', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PAGADO) }));
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 160)));
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);

    const info = await page.evaluate(() => {
      const t = id => { const e = document.getElementById(id); return e ? e.innerText.replace(/\s+/g, ' ').trim() : null; };
      const card = document.getElementById('lv-card-vendido');
      const filas = [...document.querySelectorAll('.vl-vendido-fila')].map(f => f.innerText.replace(/\s+/g, ' ').trim());
      const tot = document.getElementById('lv-vendido-tot');
      const money = tot ? tot.querySelector('.vl-vendido-money') : null;
      return {
        session: t('lv-session'),
        titulo: card ? card.querySelector('h2').innerText.trim() : null,
        total: t('lv-vendido-tot'),
        colorMoney: money ? getComputedStyle(money).color : null,
        filas, nFilas: filas.length,
        nota: t('lv-vendido-nota'),
        chipEntregada: document.querySelectorAll('.vl-vendido-chip').length,
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      };
    });
    await page.screenshot({ path: `e2e-shots/vl-${v.nombre}.png`, fullPage: false });
    console.log(JSON.stringify({ vista: v.nombre, ...info, errores: errs }, null, 1));
    await ctx.close();
  }
  await browser.close();
})();
