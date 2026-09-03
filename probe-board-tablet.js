#!/usr/bin/env node
// probe-board-tablet.js — modal del board Kanban en tablet (834/1024):
// header con nombre largo (¿botones tapados?), apertura por toque, drag táctil.
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

const geom = () => {
  const r = (el) => { if (!el) return null; const x = el.getBoundingClientRect(); return { l: Math.round(x.left), r: Math.round(x.right), t: Math.round(x.top), b: Math.round(x.bottom), w: Math.round(x.width), h: Math.round(x.height) }; };
  const header = document.querySelector('.kanban-modal-header, .board-modal-header, [class*="kanban-modal"] [class*="header"]');
  const actions = document.querySelector('.kanban-modal-header-actions, [class*="kanban"] [class*="actions"]');
  const close = document.querySelector('.kanban-modal .close, .kanban-modal [class*="close"], .board-modal [class*="close"]');
  const titulo = document.querySelector('.kanban-modal-header h2, .kanban-modal-header h3, [class*="kanban-modal"] [class*="titulo"], [class*="kanban-modal"] h1');
  const inter = (a, b) => a && b && !(a.r <= b.l || b.r <= a.l) && !(a.b <= b.t || b.b <= a.t);
  return { header: r(header), titulo: r(titulo), actions: r(actions), close: r(close), colisionTituloAcciones: inter(r(titulo), r(actions)) };
};

async function main() {
  const session = await login('admin@demo.com', 'demo123');
  const meta = (session.user && session.user.user_metadata) || {};
  const userData = { id: session.user.id, nombre: meta.nombre || 'Demo', email: 'admin@demo.com', rol: meta.rol || 'admin', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '' };
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  for (const vp of [{ name: '834', width: 834, height: 1112 }, { name: '1024', width: 1024, height: 1366 }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e.message).slice(0, 130)));
    await page.addInitScript(({ access, refresh, userData }) => {
      localStorage.setItem('agendapro_access_token', access);
      localStorage.setItem('agendapro_refresh_token', refresh);
      localStorage.setItem('agendapro_user_data', JSON.stringify(userData));
    }, { access: session.access_token, refresh: session.refresh_token, userData });

    await page.goto(`${BASE}/admin.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4500);
    await page.evaluate(() => { if (window.navigateTo) window.navigateTo('clientes'); });
    await page.waitForTimeout(3500);

    // 1. Abrir el board del cliente con nombre largo (si existe) vía tarjeta/lista
    const abierto = await page.evaluate(() => {
      const target = Array.from(document.querySelectorAll('.cliente-card, .cliente-row, [class*="cliente"]'))
        .find(el => /Administrador General/i.test(el.textContent || ''));
      if (!target) return { ok: false, why: 'sin cliente de nombre largo' };
      const r = target.getBoundingClientRect();
      return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(r.height / 2, 60)), cls: (target.className || '').toString().slice(0, 40) };
    });
    if (!abierto.ok) { console.log(`[${vp.name}] ${abierto.why}`); await ctx.close(); continue; }
    await page.touchscreen.tap(abierto.x, abierto.y).catch(() => page.mouse.click(abierto.x, abierto.y));
    await page.waitForTimeout(3500);
    // Si abrió info-cliente (nueva pestaña) en vez del board, buscar botón tablero/board
    let tieneBoard = await page.evaluate(() => !!document.querySelector('.kanban-card, .kanban-list, [class*="kanban-column"], [class*="tablero"]'));
    if (!tieneBoard) {
      const b = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('button, a, [role="tab"]')).filter(el => /tablero|board|kanban|información|info del cliente/i.test((el.textContent || '').slice(0, 60)) && el.offsetParent !== null);
        if (!els.length) return null;
        const r = els[0].getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      if (b) { await page.touchscreen.tap(b.x, b.y).catch(() => {}); await page.waitForTimeout(3000); tieneBoard = await page.evaluate(() => !!document.querySelector('.kanban-card, .kanban-list')); }
    }
    console.log(`[${vp.name}] board abierto: ${tieneBoard}`);
    if (tieneBoard) {
      const g = await page.evaluate(geom);
      console.log(`[${vp.name}] geometría modal board: ${JSON.stringify(g)}`);
      await page.screenshot({ path: `e2e-shots/tablet/${vp.name}-board.png` }).catch(() => {});
      // Drag táctil sobre una tarjeta (¿funciona HTML5 DnD con touch?)
      const dragInfo = await page.evaluate(() => {
        const card = document.querySelector('.kanban-card');
        if (!card) return { ok: false };
        const r = card.getBoundingClientRect();
        return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), draggable: card.getAttribute('draggable') };
      });
      if (dragInfo.ok) {
        const antes = await page.evaluate(() => document.querySelectorAll('.kanban-card').length);
        try {
          await page.touchscreen.tap(dragInfo.x, dragInfo.y); // 1er toque abre modal de card (no drag)
          await page.waitForTimeout(1500);
          const cardModalAbierto = await page.evaluate(() => !!document.querySelector('#kcard-lista, .kanban-card-modal, [id*="card-modal"], #kcard-titulo'));
          console.log(`[${vp.name}] tap en tarjeta → modal de card abierto: ${cardModalAbierto}`);
          // cerrar modal de card si abrió (Esc o X)
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(800);
        } catch (e) { console.log(`[${vp.name}] drag test err ${String(e.message).slice(0, 80)}`); }
        const despues = await page.evaluate(() => document.querySelectorAll('.kanban-card').length);
        console.log(`[${vp.name}] cards antes=${antes} despues=${despues} (drag táctil movió: ${antes !== despues ? 'SÍ' : 'NO'})`);
      }
      // ¿selector Lista en el modal de card permite mover? verificar presencia del select
      const selLista = await page.evaluate(() => {
        const ov = document.querySelector('.kanban-card-overlay, [id*="card-overlay"]');
        if (!ov) return null;
        ov.style.display = 'none';
        return null;
      });
      console.log(`[${vp.name}] errs=${errs.length}`, [...new Set(errs)].slice(0, 3));
    }
    await ctx.close();
  }
  await browser.close();
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
