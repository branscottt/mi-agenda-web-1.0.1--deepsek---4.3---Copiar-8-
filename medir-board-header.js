#!/usr/bin/env node
/* medir-board-header.js — antes/después del header del board con nombre largo (360/393/700px). */
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const medidas = async (page) => page.evaluate(() => {
    const cs = getComputedStyle.bind(window);
    const r = (el) => { const x = el.getBoundingClientRect(); return { t: x.top, b: x.bottom, l: x.left, r: x.right, w: Math.round(x.width), h: Math.round(x.height) }; };
    const header = document.querySelector('.kanban-modal-header');
    const info = document.querySelector('.kanban-cliente-info');
    const h3 = info.querySelector('h3');
    const actions = document.querySelector('.kanban-estilos-actions');
    const close = document.querySelector('.kanban-btn-close');
    const hr = r(header), ir = r(info), ar = actions ? r(actions) : null, cr = r(close);
    // colisión: ¿se intersectan info y (actions|close)?
    const inter = (a, b) => !(a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t);
    const colisionInfoActions = ar ? inter(ir, ar) : false;
    const colisionInfoClose = inter(ir, cr);
    // ¿el h3 (texto del nombre) pinta fuera de su caja sobre otra cosa? scrollWidth
    const h3desb = h3.scrollWidth - h3.clientWidth;
    // hit-test botones
    const hit = (el) => {
      const x = el.getBoundingClientRect();
      const top = document.elementFromPoint(Math.min(x.left + x.width / 2, innerWidth - 1), x.top + x.height / 2);
      return !!(top === el || el.contains(top));
    };
    const btns = Array.from(document.querySelectorAll('.kanban-estilos-btn'));
    return {
      vw: innerWidth,
      headerH: Math.round(hr.h),
      info: { l: Math.round(ir.l), r: Math.round(ir.r), w: Math.round(ir.w) },
      actions: ar ? { l: Math.round(ar.l), r: Math.round(ar.r), w: Math.round(ar.w) } : null,
      close: { l: Math.round(cr.l), w: Math.round(cr.w) },
      colisionInfoActions, colisionInfoClose,
      h3desb: Math.round(h3desb),
      h3lineas: Math.round(hr.h / (parseFloat(cs(h3).lineHeight) || 20)),
      btnsOk: btns.every(hit),
      labelsVisibles: btns.some(b => { const s = cs(b.querySelector('.kanban-estilos-txt')); return s && s.display !== 'none'; }),
    };
  });

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const out = [];
  for (const w of [360, 393, 700]) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.goto('http://127.0.0.1:8712/test-board-header.html', { waitUntil: 'networkidle' });
    // ANTES: quitar bloque v12.1 si existe (regla #kanban-modal .kanban-estilos-actions)
    await page.evaluate(() => {
      const sheet = document.styleSheets[0];
      if (!sheet) return;
      for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
        const rule = sheet.cssRules[i];
        if (rule.conditionText && rule.cssText.includes('kanban-estilos-actions')) {
          try { sheet.deleteRule(i); } catch (e) {}
          break;
        }
      }
    });
    const antes = await medidas(page);
    await page.reload({ waitUntil: 'networkidle' });
    const despues = await medidas(page);
    out.push({ antes, despues });
  }
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
