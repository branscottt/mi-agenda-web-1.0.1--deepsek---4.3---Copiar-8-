#!/usr/bin/env node
// verify-dnd-desktop.js — regresión: DnD HTML5 con MOUSE sigue funcionando en desktop (1280px, sin touch).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const ROOT = '/home/branscott/proyectos/mi-agenda-web 1.0.1 (deepsek) (4.3) (Copiar 13)';
const BASE = 'http://127.0.0.1:8799';
const cfgRaw = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
const get = (k) => { const m = cfgRaw.match(new RegExp(`^${k}=['"]?(.*?)['"]?\\s*$`, 'm')); return m ? m[1] : ''; };
const cfg = { url: get('SUPABASE_URL'), key: get('SUPABASE_KEY') };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: cfg.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@demo.com', password: 'demo123' }) });
  if (!res.ok) { console.log('LOGIN FALLÓ', res.status); process.exit(2); }
  const session = await res.json();
  const meta = (session.user && session.user.user_metadata) || {};
  const userData = { id: session.user.id, nombre: meta.nombre || 'Demo', email: 'admin@demo.com', rol: meta.rol || 'admin', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '' };
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } }); // desktop, SIN touch
  const page = await ctx.newPage();
  const ref = cfg.url.replace(/^https?:\/\//, '').split('.')[0];
  await page.addInitScript(({ access, refresh, userData, sbKey }) => {
    localStorage.setItem('agendapro_access_token', access);
    localStorage.setItem('agendapro_refresh_token', refresh);
    localStorage.setItem('agendapro_user_data', JSON.stringify(userData));
    localStorage.setItem(sbKey, JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user: null }));
    if (userData.tenant_id) localStorage.setItem('agendapro_tour_' + userData.tenant_id, 'visto');
  }, { access: session.access_token, refresh: session.refresh_token, userData, sbKey: `sb-${ref}-auth-token` });
  await page.goto(`${BASE}/admin.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('.admin-header', { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(3500);
  await page.evaluate(() => { if (window.navigateTo) window.navigateTo('clientes'); });
  await page.waitForTimeout(4500);
  const pos = await page.evaluate(() => {
    const b = document.querySelector('.cliente-card .btn-info-cliente');
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!pos) { console.log('sin clientes'); process.exit(2); }
  await page.mouse.click(pos.x, pos.y);
  await sleep(3500);
  const board = await page.evaluate(() => !!document.getElementById('kanban-modal'));
  console.log('board abierto en desktop:', board);
  if (!board) process.exit(2);
  const datos = await page.evaluate(() => {
    const card = document.querySelector('.kanban-card');
    const origen = card.closest('.kanban-list');
    const destino = Array.from(document.querySelectorAll('.kanban-list')).find(l => l !== origen);
    if (!destino) return null;
    const a = card.getBoundingClientRect();
    const b = destino.querySelector('.kanban-list-cards').getBoundingClientRect();
    return { cardId: card.dataset.cardId, origen: origen.dataset.listId, destino: destino.dataset.listId, from: { x: a.x + a.width / 2, y: a.y + a.height / 2 }, to: { x: b.x + b.width / 2, y: b.y + Math.min(80, b.height / 2) } };
  });
  if (!datos) { console.log('estructura insuficiente'); process.exit(2); }
  const colDe = (id) => page.evaluate((cid) => {
    const c = document.querySelector(`.kanban-card[data-card-id="${cid}"]`);
    return c ? c.closest('.kanban-list').dataset.listId : null;
  }, id);
  const antes = await colDe(datos.cardId);
  // Drag con mouse (HTML5 DnD nativo de escritorio)
  await page.mouse.move(datos.from.x, datos.from.y);
  await page.mouse.down();
  await page.mouse.move(datos.to.x, datos.to.y, { steps: 12 });
  await sleep(300);
  await page.mouse.up();
  await sleep(1800);
  const despues = await colDe(datos.cardId);
  console.log(`DnD MOUSE desktop: antes=${antes} despues=${despues} → ${antes !== despues && despues === datos.destino ? 'PASS' : 'FAIL'}`);
  // restaurar
  if (antes !== despues) {
    const back = await page.evaluate(({ cardId, origenId }) => {
      const card = document.querySelector(`.kanban-card[data-card-id="${cardId}"]`);
      const origen = document.querySelector(`.kanban-list[data-list-id="${origenId}"] .kanban-list-cards`);
      if (!card || !origen) return null;
      const a = card.getBoundingClientRect();
      const b = origen.getBoundingClientRect();
      return { from: { x: a.x + a.width / 2, y: a.y + a.height / 2 }, to: { x: b.x + b.width / 2, y: b.y + Math.min(80, b.height / 2) } };
    }, datos);
    if (back) {
      await page.mouse.move(back.from.x, back.from.y);
      await page.mouse.down();
      await page.mouse.move(back.to.x, back.to.y, { steps: 12 });
      await sleep(300);
      await page.mouse.up();
      await sleep(1800);
      const restaurada = await colDe(datos.cardId);
      console.log(`restauración desktop: ${restaurada === datos.origen ? 'PASS' : 'FAIL (' + restaurada + ')'}`);
    }
  }
  await browser.close();
  console.log('FIN');
})();
