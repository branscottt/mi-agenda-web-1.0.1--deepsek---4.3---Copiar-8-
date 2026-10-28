#!/usr/bin/env node
// Verifica en LOCAL lo nuevo del LIVE: vendido (solo pagadas) + aviso sin contacto.
const { chromium } = require('playwright');
const fs = require('fs');
const SUPABASE_URL = 'https://dfcfimipkfhitlsyixqu.supabase.co';
const KEY = fs.readFileSync('/tmp/agendapro-key-clean.txt', 'utf8').trim();
const BASE = process.env.BASE || 'http://localhost:8099/ventas-live.html';

const VISTAS = [
  { nombre: 'movil', width: 393, height: 852, isMobile: true, hasTouch: true },
  { nombre: 'tablet', width: 820, height: 1180, isMobile: true, hasTouch: true },
  { nombre: 'pc', width: 1280, height: 720, isMobile: false, hasTouch: false },
];

(async () => {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.com', password: 'demo123' }),
  });
  const s = await r.json();
  if (!s.access_token) { console.log('LOGIN FAIL'); process.exit(1); }
  const u = s.user, meta = u.user_metadata || {};
  const ud = JSON.stringify({ id: u.id, nombre: meta.nombre || 'Admin', email: u.email, rol: meta.rol || 'admin', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '' });
  const sbTok = JSON.stringify({ access_token: s.access_token, refresh_token: s.refresh_token, expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user: u });

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const v of VISTAS) {
    const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: 2, isMobile: v.isMobile, hasTouch: v.hasTouch });
    await ctx.addInitScript(([at, rt, ud, sb]) => {
      localStorage.setItem('agendapro_access_token', at);
      localStorage.setItem('agendapro_refresh_token', rt);
      localStorage.setItem('agendapro_user_data', ud);
      localStorage.setItem('sb-dfcfimipkfhitlsyixqu-auth-token', sb);
    }, [s.access_token, s.refresh_token, ud, sbTok]);
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 160)));
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6500);

    const info = await page.evaluate(() => {
      const t = id => { const e = document.getElementById(id); return e ? e.innerText.replace(/\s+/g, ' ').trim() : null; };
      const cardV = document.getElementById('lv-card-vendido');
      const cardL = document.getElementById('lv-card-liberar');
      const rv = cardV ? cardV.getBoundingClientRect() : null;
      const rl = cardL ? cardL.getBoundingClientRect() : null;
      return {
        session: t('lv-session'),
        vendidoVisible: !!(cardV && !cardV.hidden),
        vendidoTot: t('lv-vendido-tot'),
        vendidoFilas: cardV ? cardV.querySelectorAll('.vl-vendido-fila').length : 0,
        vendidoNota: t('lv-vendido-nota'),
        liberarVisible: !!(cardL && !cardL.hidden),
        liberarFilas: cardL ? cardL.querySelectorAll('.vl-liberar-fila').length : 0,
        liberarTexto: cardL && !cardL.hidden ? cardL.innerText.replace(/\s+/g, ' ').slice(0, 300) : null,
        posVendido: rv ? { top: Math.round(rv.top + scrollY), h: Math.round(rv.height), w: Math.round(rv.width) } : null,
        posLiberar: rl ? { top: Math.round(rl.top + scrollY), h: Math.round(rl.height), w: Math.round(rl.width) } : null,
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      };
    });

    // Abrir el modal de liberar de la 1ª fila y cancelarlo (no se toca nada).
    let modal = null;
    if (info.liberarFilas > 0) {
      const btn = page.locator('.vl-liberar-fila [data-acc="liberar"]').first();
      await btn.click();
      await page.waitForTimeout(1200);
      modal = await page.evaluate(() => {
        const m = document.querySelector('.vl-modal, .modal, [class*="modal"]');
        const txt = m ? m.innerText.replace(/\s+/g, ' ').slice(0, 160) : null;
        const btnCancel = [...document.querySelectorAll('button')].find(b => /cancelar/i.test(b.textContent));
        if (btnCancel) btnCancel.click();
        return { abierto: !!m, texto: txt };
      });
      await page.waitForTimeout(500);
    }

    await page.screenshot({ path: `e2e-shots/vl-vendido-${v.nombre}.png`, fullPage: true });
    console.log(JSON.stringify({ vista: v.nombre, ...info, modal, errores: errs }, null, 1));
    await ctx.close();
  }
  await browser.close();
})();
