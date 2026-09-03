#!/usr/bin/env node
// restore-demo-card.js — devuelve la tarjeta movida por el test desktop a su columna original.
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
  const session = await res.json();
  const meta = (session.user && session.user.user_metadata) || {};
  const userData = { id: session.user.id, nombre: meta.nombre || 'Demo', email: 'admin@demo.com', rol: meta.rol || 'admin', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '' };
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
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
  const estado = await page.evaluate(() => Array.from(document.querySelectorAll('.kanban-list')).map(l => `${l.dataset.listId}:${l.querySelectorAll('.kanban-card').length}`).join(' | '));
  console.log('columnas ANTES:', estado);
  // Encontrar la tarjeta extra en la 2ª lista (la que no estaba: se movió en el test).
  // Criterio: comparar contra el estado conocido pre-test (origen 8 / destino 1): si destino tiene 2, mover la 1ª de destino a origen.
  const mover = await page.evaluate(() => {
    const listas = Array.from(document.querySelectorAll('.kanban-list'));
    if (listas.length < 2) return null;
    const destino = listas[1];
    const origen = listas[0];
    const cardsDest = destino.querySelectorAll('.kanban-card');
    if (cardsDest.length < 2) return null; // nada extra que mover
    const card = cardsDest[cardsDest.length - 1]; // la última = la recién soltada (appendChild en drop)
    const a = card.getBoundingClientRect();
    const b = origen.querySelector('.kanban-list-cards').getBoundingClientRect();
    card.scrollIntoView({ block: 'center' });
    const a2 = card.getBoundingClientRect();
    const b2 = origen.querySelector('.kanban-list-cards').getBoundingClientRect();
    return { cardId: card.dataset.cardId, from: { x: a2.x + a2.width / 2, y: a2.y + a2.height / 2 }, to: { x: b2.x + b2.width / 2, y: b2.y + 30 } };
  });
  if (!mover) { console.log('nada que restaurar (destino ya tiene 1 card)'); await browser.close(); return; }
  console.log('restaurando card', mover.cardId);
  await page.mouse.move(mover.from.x, mover.from.y);
  await page.mouse.down();
  await page.mouse.move(mover.to.x, mover.to.y, { steps: 12 });
  await sleep(250);
  await page.mouse.up();
  await sleep(1800);
  const estadoFinal = await page.evaluate(() => Array.from(document.querySelectorAll('.kanban-list')).map(l => `${l.dataset.listId}:${l.querySelectorAll('.kanban-card').length}`).join(' | '));
  const col = await page.evaluate((cid) => {
    const c = document.querySelector(`.kanban-card[data-card-id="${cid}"]`);
    return c ? c.closest('.kanban-list').dataset.listId : 'no-encontrada';
  }, mover.cardId);
  console.log('columnas DESPUÉS:', estadoFinal);
  console.log('card', mover.cardId, 'ahora en:', col, '→', col === (await page.evaluate(() => Array.from(document.querySelectorAll('.kanban-list'))[0].dataset.listId)) ? 'PASS restaurada a 1ª columna' : 'verificar');
  await browser.close();
})();
