#!/usr/bin/env node
// validate-touch-drag.js — VALIDACIÓN del drag táctil del board (build local :8799).
// Basado en debug-tap2 (apertura de board probada y estable).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const ROOT = '/home/branscott/proyectos/mi-agenda-web 1.0.1 (deepsek) (4.3) (Copiar 13)';
const BASE = 'http://127.0.0.1:8799';
const cfgRaw = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
const get = (k) => { const m = cfgRaw.match(new RegExp(`^${k}=['"]?(.*?)['"]?\\s*$`, 'm')); return m ? m[1] : ''; };
const cfg = { url: get('SUPABASE_URL'), key: get('SUPABASE_KEY') };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const colDeCard = (id) => {
  const c = document.querySelector(`.kanban-card[data-card-id="${id}"]`);
  return c ? c.closest('.kanban-list').dataset.listId : null;
};

async function main() {
  const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.com', password: 'demo123' }),
  });
  if (!res.ok) { console.log('LOGIN FALLÓ HTTP', res.status); process.exit(2); }
  const session = await res.json();
  const meta = (session.user && session.user.user_metadata) || {};
  const userData = { id: session.user.id, nombre: meta.nombre || 'Demo', email: 'admin@demo.com', rol: meta.rol || 'admin', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '' };

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 834, height: 1112 }, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('[pageerror]', String(e.message).slice(0, 160)));
  const ref = cfg.url.replace(/^https?:\/\//, '').split('.')[0];
  const sbKey = `sb-${ref}-auth-token`;
  await page.addInitScript(({ access, refresh, userData, sbKey }) => {
    localStorage.setItem('agendapro_access_token', access);
    localStorage.setItem('agendapro_refresh_token', refresh);
    localStorage.setItem('agendapro_user_data', JSON.stringify(userData));
    localStorage.setItem(sbKey, JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user: null }));
  }, { access: session.access_token, refresh: session.refresh_token, userData, sbKey });

  await page.goto(`${BASE}/admin.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('.admin-header', { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(3500);
  await page.evaluate(() => { if (window.navigateTo) window.navigateTo('clientes'); });
  await page.waitForTimeout(4500);

  async function tap(x, y) {
    const s = await ctx.newCDPSession(page);
    await s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await sleep(70);
    await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  async function drag(x0, y0, x1, y1, holdMs = 450, steps = 14) {
    const s = await ctx.newCDPSession(page);
    await s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
    await sleep(holdMs);
    for (let i = 1; i <= steps; i++) {
      const x = Math.round(x0 + ((x1 - x0) * i) / steps);
      const y = Math.round(y0 + ((y1 - y0) * i) / steps);
      await s.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
      await sleep(35);
    }
    await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  // Abrir board del primer cliente utilizable (>=2 listas, >=1 tarjeta)
  await page.evaluate(() => {
    window.__clicks = [];
    document.addEventListener('click', (e) => { window.__clicks.push(((e.target && (e.target.className || e.target.tagName)) || '').toString().slice(0, 40)); }, true);
  });
  let abierto = false;
  for (let n = 0; n < 8 && !abierto; n++) {
    const pos = await page.evaluate((i) => {
      const cards = Array.from(document.querySelectorAll('.cliente-card'));
      const card = cards[i];
      if (!card) return null;
      const b = card.querySelector('.btn-info-cliente') || card;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
      const top = cy > 0 && cy < innerHeight ? document.elementFromPoint(cx, cy) : null;
      return {
        x: cx, y: cy,
        cubierto: top ? !(top === b || b.contains(top)) : true,
        topCls: top ? (top.className || top.tagName || '').toString().slice(0, 40) : null,
      };
    }, n);
    if (!pos) break;
    console.log(`cliente ${n}: pos=${JSON.stringify(pos)}`);
    if (pos.cubierto || pos.y < 0 || pos.y > innerHeight) continue;
    await tap(pos.x, pos.y);
    await sleep(3500);
    const st = await page.evaluate(() => ({
      modal: !!document.getElementById('kanban-modal'),
      cards: document.querySelectorAll('.kanban-card').length,
      listas: document.querySelectorAll('.kanban-list').length,
      clicks: window.__clicks.slice(-3),
    }));
    console.log(`cliente ${n}: modal=${st.modal} listas=${st.listas} cards=${st.cards} clicks=${JSON.stringify(st.clicks)}`);
    if (st.modal && st.listas >= 2 && st.cards >= 1) { abierto = true; break; }
    await page.keyboard.press('Escape'); await sleep(600);
    await page.evaluate(() => { const m = document.getElementById('kanban-modal'); if (m) m.remove(); }).catch(() => {});
    await page.evaluate(() => { if (window.navigateTo) window.navigateTo('clientes'); });
    await sleep(1500);
  }
  if (!abierto) { console.log('NO hay board utilizable'); process.exit(2); }

  const punto = await page.evaluate(() => {
    const card = document.querySelector('.kanban-card');
    const origen = card.closest('.kanban-list');
    const otras = Array.from(document.querySelectorAll('.kanban-list')).filter(l => l !== origen);
    if (!otras.length) return null;
    const a = card.getBoundingClientRect();
    const cardsDest = otras[otras.length - 1].querySelector('.kanban-list-cards');
    const b = cardsDest.getBoundingClientRect();
    card.scrollIntoView({ block: 'center' });
    const a2 = card.getBoundingClientRect();
    const b2 = cardsDest.getBoundingClientRect();
    return {
      cardId: card.dataset.cardId,
      origen: origen.dataset.listId,
      destino: otras[otras.length - 1].dataset.listId,
      from: { x: Math.round(a2.x + a2.width / 2), y: Math.round(a2.y + a2.height / 2) },
      to: { x: Math.round(b2.x + b2.width / 2), y: Math.round(b2.y + Math.min(90, b.height / 2)) },
    };
  });
  if (!punto) { console.log('estructura insuficiente'); process.exit(2); }
  console.log('Mover card', punto.cardId, punto.origen, '→', punto.destino, JSON.stringify(punto.from), '→', JSON.stringify(punto.to));

  // CASO 1: tap corto en tarjeta → abre modal de card
  await tap(punto.from.x, punto.from.y);
  await sleep(1800);
  const caso1 = await page.evaluate(() => !!document.querySelector('#kcard-lista, #kcard-titulo'));
  console.log('CASO 1 (tap abre modal de card):', caso1 ? 'PASS' : 'FAIL');
  await page.keyboard.press('Escape'); await sleep(800);
  await page.evaluate(() => { const ov = document.querySelector('.kanban-card-overlay'); if (ov) ov.remove(); }).catch(() => {});
  await sleep(400);

  // CASO 2: long-press + deslizar a la última columna
  const antes = await page.evaluate(colDeCard, punto.cardId);
  await drag(punto.from.x, punto.from.y, punto.to.x, punto.to.y);
  await sleep(1500);
  const despues = await page.evaluate(colDeCard, punto.cardId);
  const abrioModal = await page.evaluate(() => !!document.querySelector('#kcard-lista'));
  console.log(`CASO 2 (drag táctil mueve de columna): antes=${antes} despues=${despues} → ${antes !== despues ? 'PASS' : 'FAIL'}`);
  console.log('CASO 2b (no abre modal al soltar):', abrioModal ? 'FAIL (abrió modal)' : 'PASS');

  // CASO 3: swipe rápido sin long-press (scroll) → no mueve ni abre
  const card3 = await page.evaluate(() => {
    const c = document.querySelector('.kanban-card');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { id: c.dataset.cardId, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (card3) {
    const antes3 = await page.evaluate(colDeCard, card3.id);
    await drag(card3.x, card3.y, card3.x + 40, card3.y + 80, 90, 6); // hold corto
    await sleep(1200);
    const despues3 = await page.evaluate(colDeCard, card3.id);
    const abrio3 = await page.evaluate(() => !!document.querySelector('#kcard-lista'));
    console.log(`CASO 3 (swipe rápido no mueve): ${antes3 === despues3 ? 'PASS' : 'FAIL'} | no abre modal: ${abrio3 ? 'FAIL' : 'PASS'}`);
  }

  await page.screenshot({ path: 'e2e-shots/tablet/834-touchdrag-final.png' }).catch(() => {});
  console.log('Columnas finales:', await page.evaluate(() => Array.from(document.querySelectorAll('.kanban-list')).map(l => `${l.dataset.listId}:${l.querySelectorAll('.kanban-card').length}`).join(' | ')));
  await browser.close();
  console.log('VALIDACIÓN COMPLETA');
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
