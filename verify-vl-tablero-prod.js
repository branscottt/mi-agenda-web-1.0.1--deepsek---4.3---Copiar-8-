#!/usr/bin/env node
// verify-vl-tablero-prod.js
// Verificación en PRODUCCIÓN del tablero de Envíos en móvil (390x844), tablet
// (768x1024), PC 1280x720 y 1440x900, con sesión real (demo).
// Comprueba: sin scroll horizontal de página, columnas a la vista, tarjeta
// abierta dentro de la pantalla, acciones principales visibles y 0 errores JS.
// Uso: NODE_PATH="$PWD/node_modules" node verify-vl-tablero-prod.js
//      ALIAS=otro-alias.vercel.app node verify-vl-tablero-prod.js
const { chromium } = require('playwright');
const fs = require('fs');

const SUPABASE = 'https://dfcfimipkfhitlsyixqu.supabase.co';
// anon key: del .env.local del repo (o del archivo temporal que usa prod-mobile-check.js)
const KEY = (() => {
  try {
    const m = fs.readFileSync('.env.local', 'utf8').match(/^SUPABASE_KEY=(.*)$/m);
    if (m && m[1].trim()) return m[1].trim();
  } catch (_) { /* sin .env.local */ }
  return fs.readFileSync('/tmp/agendapro-key-clean.txt', 'utf8').trim();
})();
const ALIAS = process.env.ALIAS || 'agenda-organify.vercel.app';

const VISTAS = [
  { nombre: 'movil', ancho: 390, alto: 844, movil: true,
    ua: 'Mozilla/5.0 (Linux; Android 13; 22111317G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
  { nombre: 'tablet', ancho: 768, alto: 1024, movil: true,
    ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  { nombre: 'pc720', ancho: 1280, alto: 720, movil: false, ua: null },
  { nombre: 'pc1440', ancho: 1440, alto: 900, movil: false, ua: null }
];

let fallos = 0;
function check(nombre, cond, extra) {
  console.log((cond ? '  ✔ ' : '  ✘ ') + nombre + (cond ? '' : '  → ' + JSON.stringify(extra)));
  if (!cond) fallos++;
}

(async () => {
  const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.com', password: 'demo123' })
  });
  const s = await res.json();
  if (!s.access_token) { console.log('NO_LOGIN', JSON.stringify(s).slice(0, 200)); process.exit(1); }
  const u = s.user, meta = u.user_metadata || {};
  const ud = JSON.stringify({ id: u.id, nombre: meta.nombre || 'Admin', email: u.email,
    rol: meta.rol || 'admin', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '' });
  const sess = JSON.stringify({
    access_token: s.access_token, refresh_token: s.refresh_token, expires_in: s.expires_in,
    expires_at: Math.floor(Date.now() / 1000) + (s.expires_in || 3600), token_type: 'bearer', user: u
  });

  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  for (const v of VISTAS) {
    console.log(`\n[${v.nombre}] ${v.ancho}x${v.alto}`);
    const ctx = await browser.newContext({
      viewport: { width: v.ancho, height: v.alto },
      isMobile: v.movil, hasTouch: v.movil, deviceScaleFactor: v.movil ? 2 : 1,
      ...(v.ua ? { userAgent: v.ua } : {})
    });
    await ctx.addInitScript(([at, rt, ud, clave, sesion]) => {
      localStorage.setItem('agendapro_access_token', at);
      localStorage.setItem('agendapro_refresh_token', rt);
      localStorage.setItem('agendapro_user_data', ud);
      localStorage.setItem(clave, sesion);
    }, [s.access_token, s.refresh_token, ud, 'sb-dfcfimipkfhitlsyixqu-auth-token', sess]);

    const page = await ctx.newPage();
    const errores = [];
    page.on('pageerror', e => errores.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errores.push('console: ' + m.text().slice(0, 140)); });

    await page.goto(`https://${ALIAS}/ventas-live.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(6000);
    await page.click('.vl-tab[data-view="envios"]');
    await page.waitForTimeout(4500);

    const board = await page.evaluate(() => {
      const b = document.querySelector('#ve-board');
      const col = document.querySelector('#ve-board .kanban-list');
      const card = document.querySelector('#ve-board .kanban-card');
      const r = (el) => el ? el.getBoundingClientRect() : null;
      return {
        paginaScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        tarjetas: document.querySelectorAll('#ve-board .kanban-card').length,
        columnas: document.querySelectorAll('#ve-board .vl-tcol').length,
        colAncho: col ? Math.round(r(col).width) : 0,
        boardAncho: b ? Math.round(r(b).width) : 0,
        boardScroll: b ? b.scrollWidth : 0,
        cardAlto: card ? Math.round(r(card).height) : 0,
        resumen: (document.querySelector('#ve-resumen') || {}).innerText || '',
        tableroAlto: b ? Math.round(r(b).height) : 0
      };
    });
    console.log('   tablero:', JSON.stringify(board));
    check('sin scroll horizontal en la PÁGINA', board.paginaScrollX <= 1, board.paginaScrollX);
    check('el tablero carga con tarjetas', board.tarjetas > 0, board.tarjetas);
    check('la columna entra en el ancho', board.colAncho <= v.ancho, board);
    check('el resumen resume los pedidos', /pedido/.test(board.resumen), board.resumen);
    if (v.ancho <= 520) {
      check('en móvil la columna ocupa ~82% del ancho', board.colAncho > v.ancho * 0.7, board.colAncho);
    }
    if (v.ancho > 520 && v.ancho <= 900) {
      check('en tablet la columna es 340px (dos a la vista)', board.colAncho >= 320 && board.colAncho <= 380, board.colAncho);
    }
    if (v.ancho <= 900) {
      check('el tablero se desliza en horizontal (hay más columnas)', board.boardScroll > board.boardAncho, board);
    }
    await page.screenshot({ path: `/tmp/prod-vl-${v.nombre}-tablero.png` });

    // ── Tarjeta abierta ──
    await page.click('#ve-board .kanban-card .kanban-card-titulo');
    await page.waitForTimeout(2200);
    const ficha = await page.evaluate(() => {
      const ov = document.querySelector('.vl-card-overlay');
      const m = document.querySelector('.vl-card-modal');
      if (!ov || !m) return { abierta: false };
      const r = m.getBoundingClientRect();
      const acciones = document.querySelector('.vl-card-acciones');
      const ra = acciones ? acciones.getBoundingClientRect() : null;
      const fotos = [...document.querySelectorAll('#vc-fotos .vl-card-foto')].map(f => {
        const fr = f.getBoundingClientRect();
        return { w: Math.round(fr.width), r: Math.round(fr.right) };
      });
      return {
        abierta: true,
        modal: { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) },
        vw: innerWidth, vh: innerHeight,
        scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        modalScrollY: m.scrollHeight > m.clientHeight,
        accionesVisiblesArriba: ra ? ra.top < innerHeight * 0.75 : false,
        botones: [...document.querySelectorAll('.vl-card-acciones .vl-btn')].length,
        fotos,
        inputsDentro: [...document.querySelectorAll('.vl-card-form-campo input')].every(i => {
          const ir = i.getBoundingClientRect();
          return ir.right <= innerWidth && ir.left >= 0;
        }),
        capas: window.__vlCapas ? window.__vlCapas() : null
      };
    });
    console.log('   ficha:', JSON.stringify(ficha));
    check('la tarjeta abre', ficha.abierta, ficha);
    if (ficha.abierta) {
      check('el modal entra en el ancho', ficha.modal.r <= ficha.vw + 1 && ficha.modal.l >= -1, ficha.modal);
      check('el modal entra en el alto', ficha.modal.h <= ficha.vh, ficha.modal);
      check('sin scroll horizontal con la tarjeta abierta', ficha.scrollX <= 1, ficha.scrollX);
      check('las acciones principales se ven sin bajar', ficha.accionesVisiblesArriba, ficha);
      check('los campos de datos no se salen', ficha.inputsDentro, ficha);
      check('las fotos caben en el ancho', (ficha.fotos || []).every(f => f.r <= ficha.vw), ficha.fotos);
    }
    await page.screenshot({ path: `/tmp/prod-vl-${v.nombre}-ficha.png` });

    // Cerrar con Escape y comprobar que vuelve al tablero
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
    const cerrada = await page.evaluate(() => !document.querySelector('.vl-card-overlay'));
    check('Escape cierra la tarjeta', cerrada, cerrada);

    if (errores.length) console.log('   errores:', JSON.stringify(errores.slice(0, 5), null, 1));
    check('sin errores de JavaScript', errores.length === 0, errores.length);

    await ctx.close();
  }

  await browser.close();
  console.log(`\n${fallos ? '✘ ' + fallos + ' fallo(s)' : '✔ todo OK'}`);
  process.exit(fallos ? 1 : 0);
})().catch(e => { console.error('ERROR', e.message); process.exit(2); });
