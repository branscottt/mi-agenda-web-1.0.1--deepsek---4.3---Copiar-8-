#!/usr/bin/env node
/* medir-clientes-movil.js — antes/después del fix v12 sobre harness local (393px). */
const { chromium } = require('playwright');
const path = require('path');
const URL = 'http://127.0.0.1:8712/test-clientes-movil.html';

const METRICAS = `(() => {
  const cs = getComputedStyle.bind(window);
  const out = { overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth, desbordes: [] };
  // botones con texto fuera de su caja (scrollW > clientW + 2)
  document.querySelectorAll('.cliente-card *').forEach(b => {
    if (b.scrollWidth > b.clientWidth + 2 && (b.textContent || '').trim() && b.offsetParent !== null) {
      const r = b.getBoundingClientRect();
      out.desbordes.push({ cls: (b.className || '').toString().slice(0, 42), txt: b.textContent.trim().slice(0, 16), w: Math.round(r.width), scrollW: b.scrollWidth });
    }
  });
  out.toolbar = (() => {
    const h = document.querySelector('.clientes-header-actions').getBoundingClientRect();
    const fila = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { y: Math.round(r.top - h.top), x: Math.round(r.left - h.left), w: Math.round(r.width), h: Math.round(r.height), scrollW: el.scrollWidth };
    };
    return { altoTotal: Math.round(h.height), buscar: fila('.search-box'), agregar: fila('#agregar-cliente-btn'), exportar: fila('#export-clientes-csv'), etiquetas: fila('#toggle-permiso-etiquetas') };
  })();
  out.ayudaAlto = Math.round(document.querySelector('.clientes-help').getBoundingClientRect().height);
  out.card1 = (() => {
    const card = document.querySelector('.cliente-card');
    const row = card.querySelector('.cliente-actions-row');
    const rr = row.getBoundingClientRect();
    const btns = Array.from(row.querySelectorAll('.btn-small')).map(b => {
      const r = b.getBoundingClientRect();
      let spill = 0;
      const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        if (!n.nodeValue.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const tr = range.getBoundingClientRect();
        if (tr.width > 0) spill = Math.max(spill, Math.max(0, r.left - tr.left), Math.max(0, tr.right - r.right));
      }
      return { cls: (b.className || '').toString().replace('btn-small ', '').slice(0, 34), y: Math.round(r.top - rr.top), x: Math.round(r.left - rr.left), w: Math.round(r.width), h: Math.round(r.height), spill: Math.round(spill) };
    });
    return { cardH: Math.round(card.getBoundingClientRect().height), rowH: Math.round(rr.height), btns };
  })();
  return out;
})()`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();

  // PASO 1 — estado ANTES: quitar el bloque v12 (última @media 768 que contiene .btn-enviar-info-cliente)
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    const sheet = document.styleSheets[0];
    for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
      const r = sheet.cssRules[i];
      if (r.conditionText && r.conditionText.includes('768') && r.cssText.includes('btn-enviar-info-cliente')) {
        sheet.deleteRule(i);
        break;
      }
    }
  });
  const antes = await page.evaluate(METRICAS);

  // PASO 2 — estado DESPUÉS: recarga con style.css completo (v12 activo)
  await page.reload({ waitUntil: 'networkidle' });
  const despues = await page.evaluate(METRICAS);

  const res = { antes, despues };
  console.log(JSON.stringify(res, null, 1));

  // Aserciones
  const a = despues;
  const ok = [];
  const fail = [];
  const ev = a.card1.btns.find(b => b.cls.includes('btn-enviar-info-cliente'));
  const info = a.card1.btns.find(b => b.cls.includes('btn-info-cliente'));
  const hist = a.card1.btns.find(b => b.cls.includes('btn-ver-historial'));
  const iconos = a.card1.btns.filter(b => !b.cls.includes('btn-enviar') && !b.cls.includes('btn-copiar') && !b.cls.includes('btn-info') && !b.cls.includes('btn-ver-historial'));
  (ev && ev.spill === 0 && ev.w > 200 ? ok : fail).push('Enviar info full-width sin derrame (w=' + (ev && ev.w) + ' spill=' + (ev && ev.spill) + ')');
  (info && info.spill === 0 && info.w > 200 ? ok : fail).push('Información full-width sin derrame');
  (hist && hist.spill === 0 && hist.w > 200 ? ok : fail).push('Historial full-width sin derrame');
  (iconos.length === 3 && iconos.every(i => i.w === 34 && i.spill === 0) ? ok : fail).push('Iconos de contacto siguen 34px sin derrame');
  (a.desbordes.length === 0 ? ok : fail).push('Sin elementos con texto fuera de caja (desbordes=' + a.desbordes.length + ')');
  (a.overflowX === 0 ? ok : fail).push('Sin overflow horizontal (overflowX=' + a.overflowX + ')');
  const t = a.toolbar;
  (t.agregar && t.exportar && t.agregar.y === t.exportar.y ? ok : fail).push('Agregar y Exportar en la MISMA fila (y=' + t.agregar.y + '/' + t.exportar.y + ')');
  (t.agregar.w > 150 && t.exportar.w > 150 ? ok : fail).push('Agregar/Exportar parejos (w=' + t.agregar.w + '/' + t.exportar.w + ')');
  (t.etiquetas.w > 300 ? ok : fail).push('Etiquetas full-width (w=' + t.etiquetas.w + ')');
  console.log('\n=== RESULTADO ===');
  ok.forEach(m => console.log('PASS | ' + m));
  fail.forEach(m => console.log('FAIL | ' + m));
  await browser.close();
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
