#!/usr/bin/env node
// probe-board2.js — board de CUALQUIER cliente en tablet: geometría header + drag táctil + selector Lista.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const ROOT = '/home/branscott/proyectos/mi-agenda-web 1.0.1 (deepsek) (4.3) (Copiar 13)';
const BASE = 'https://agenda-organify.vercel.app';
const cfgRaw = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
const get = (k) => { const m = cfgRaw.match(new RegExp(`^${k}=['"]?(.*?)['"]?\\s*$`, 'm')); return m ? m[1] : ''; };
const cfg = { url: get('SUPABASE_URL'), key: get('SUPABASE_KEY') };
async function login(email, password) {
  const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error('login ' + res.status);
  return await res.json();
}
async function main() {
  const session = await login('admin@demo.com', 'demo123');
  const meta = (session.user && session.user.user_metadata) || {};
  const userData = { id: session.user.id, nombre: meta.nombre || 'Demo', email: 'admin@demo.com', rol: meta.rol || 'admin', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '' };
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  for (const vp of [{ name: '834', width: 834, height: 1112 }, { name: '1024', width: 1024, height: 1366 }, { name: '800', width: 800, height: 1280 }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });
    const page = await ctx.newPage();
    await page.addInitScript(({ access, refresh, userData }) => {
      localStorage.setItem('agendapro_access_token', access);
      localStorage.setItem('agendapro_refresh_token', refresh);
      localStorage.setItem('agendapro_user_data', JSON.stringify(userData));
    }, { access: session.access_token, refresh: session.refresh_token, userData });
    await page.goto(`${BASE}/admin.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4500);
    await page.evaluate(() => { if (window.navigateTo) window.navigateTo('clientes'); });
    await page.waitForTimeout(3500);
    console.log(`\n===== ${vp.name} =====`);

    // Abrir "Información" (board) del primer cliente con tarjetas: tap en su fila/tarjeta
    const cli = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('.cliente-card, .cliente-row, [class*="cliente-item"], [class*="cliente"] a, [class*="cliente"] button'))
        .filter(el => el.offsetParent !== null && el.getBoundingClientRect().width > 80 && el.getBoundingClientRect().height > 20);
      if (!els.length) return null;
      const r = els[0].getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(40, r.height / 2)) };
    });
    if (!cli) { console.log('sin clientes'); await ctx.close(); continue; }
    await page.touchscreen.tap(cli.x, cli.y).catch(() => page.mouse.click(cli.x, cli.y));
    await page.waitForTimeout(3000);

    let hayBoard = await page.evaluate(() => !!document.querySelector('.kanban-card'));
    if (!hayBoard) {
      // quizás abrió info-cliente: buscar pestaña/botón tablero
      const b = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('button, a, [role="tab"]')).filter(el => /tablero|board/i.test((el.textContent || '').slice(0, 40)) && el.offsetParent !== null);
        if (!els.length) return null;
        const r = els[0].getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      if (b) { await page.touchscreen.tap(b.x, b.y).catch(() => {}); await page.waitForTimeout(3000); }
      hayBoard = await page.evaluate(() => !!document.querySelector('.kanban-card'));
    }
    if (!hayBoard) { console.log('no se pudo abrir board'); await ctx.close(); continue; }

    const g = await page.evaluate(() => {
      const R = (el) => { if (!el) return null; const x = el.getBoundingClientRect(); return { l: Math.round(x.left), r: Math.round(x.right), t: Math.round(x.top), b: Math.round(x.bottom), w: Math.round(x.width), h: Math.round(x.height) }; };
      const modal = document.querySelector('.kanban-modal') || document.querySelector('[id="kanban-modal"]');
      const header = modal ? modal.querySelector('.kanban-modal-header, [class*="modal-header"]') : null;
      const titulo = header ? header.querySelector('h1,h2,h3,[class*="titulo"],[class*="title"]') : null;
      const btns = header ? Array.from(header.querySelectorAll('button, a')).map(b => R(b)) : [];
      const close = (modal ? modal.querySelectorAll('button') : []).length ? Array.from(modal.querySelectorAll('button')).find(b => /×|✕|x|cerrar/i.test(b.getAttribute('aria-label') || b.title || '')) : null;
      return { modal: R(modal), header: R(header), titulo: R(titulo), botones: btns.map((b, i) => ({ ...b, i })), close: R(close) };
    });
    const colision = (g.header && g.titulo && g.botones.length) ? g.botones.some(b => b && !(g.titulo.r <= b.l || b.r <= g.titulo.l) && !(g.titulo.b <= b.t || b.b <= g.titulo.t)) : null;
    console.log(`header: ${JSON.stringify(g.header)} titulo: ${JSON.stringify(g.titulo)} botones: ${JSON.stringify(g.botones)} colisionTituloBotones: ${colision}`);
    await page.screenshot({ path: `e2e-shots/tablet/${vp.name}-board.png` }).catch(() => {});

    // DRAG TÁCTIL: ¿mueve la tarjeta? (touch drag simulada entre columnas)
    const drag = await page.evaluate(() => {
      const card = document.querySelector('.kanban-card');
      const cols = Array.from(document.querySelectorAll('.kanban-list-cards, [class*="list-cards"], [class*="column"] [class*="cards"]'));
      if (!card || cols.length < 1) return { ok: false };
      const a = card.getBoundingClientRect();
      const b = (cols[cols.length - 1]).getBoundingClientRect();
      return { ok: true, from: { x: Math.round(a.x + a.width / 2), y: Math.round(a.y + a.height / 2) }, to: { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }, draggable: card.getAttribute('draggable') };
    });
    if (drag.ok) {
      const antes = await page.evaluate(() => Array.from(document.querySelectorAll('.kanban-card')).map(c => c.closest('[data-list-id], [class*="list"]') ? c.closest('[data-list-id]').dataset.listId : c.parentElement.dataset.listId).join(','));
      try {
        await page.touchscreen.tap(drag.from.x, drag.from.y);
        await page.waitForTimeout(400);
        // gesto: mantener + deslizar (Chrome Android intenta DnD nativo con long-press+drag)
        await page.evaluate(() => { const c = document.querySelector('.kanban-card'); if (c) c.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() })); }).catch(() => {});
        await page.touchscreen.tap(drag.to.x, drag.to.y);
        await page.waitForTimeout(1200);
      } catch (e) { console.log('drag err', String(e.message).slice(0, 80)); }
      const despues = await page.evaluate(() => Array.from(document.querySelectorAll('.kanban-card')).map(c => c.closest('[data-list-id]') ? c.closest('[data-list-id]').dataset.listId : c.parentElement.dataset.listId).join(','));
      console.log(`drag táctil: draggable=${drag.draggable} antes=[${antes}] despues=[${despues}] -> ${antes !== despues ? 'MOVIDA' : 'NO MOVIDA (sin DnD táctil)'}`);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(600);
    }

    // Modal de tarjeta: ¿selector Lista alcanzable con tap?
    const cardTap = await page.evaluate(() => {
      const card = document.querySelector('.kanban-card:not(.kanban-dragging)');
      if (!card) return null;
      const r = card.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 30), h: Math.round(r.height) };
    });
    if (cardTap) {
      await page.touchscreen.tap(cardTap.x, cardTap.y).catch(() => page.mouse.click(cardTap.x, cardTap.y));
      await page.waitForTimeout(1800);
      const cardModal = await page.evaluate(() => {
        const sel = document.querySelector('#kcard-lista, [id*="lista"], [id*="list"] select');
        const ov = document.querySelector('[id*="card-overlay"], .kanban-card-modal');
        if (!ov) return { ok: false, why: 'sin overlay' };
        const r = sel ? sel.getBoundingClientRect() : null;
        return { ok: true, tieneSelectorLista: !!sel, sel: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null, vw: document.documentElement.clientWidth, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      console.log(`modal de card: ${JSON.stringify(cardModal)}`);
      await page.keyboard.press('Escape').catch(() => {});
    }
    await ctx.close();
  }
  await browser.close();
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
