#!/usr/bin/env node
// probe-book2.js — flujo profundo de reserva en tablet (800/1024) hasta antes de confirmar.
const { chromium } = require('playwright');
const ROOT = '/home/branscott/proyectos/mi-agenda-web 1.0.1 (deepsek) (4.3) (Copiar 13)';
const BASE = 'https://agenda-organify.vercel.app';
const URL = BASE + '/p/miu-street-workout-training';

const centro = () => {
  const r = (el) => { const x = el.getBoundingClientRect(); return { x: Math.round(x.x + x.width / 2), y: Math.round(x.y + x.height / 2), w: Math.round(x.width), h: Math.round(x.height), txt: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50) }; };
  return r;
};

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const vp of [{ name: '800', width: 800, height: 1280 }, { name: '1024', width: 1024, height: 1366 }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4500);
    console.log(`\n===== ${vp.name} =====`);
    // Tocar el botón Reservar del primer servicio (o tarjeta de servicio)
    const btn = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('button, a')).find(b => /reservar|elegir|agendar/i.test((b.textContent || '').trim()) && b.offsetParent !== null);
      if (!el) return null;
      const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), tag: el.tagName, cls: (el.className || '').toString().slice(0, 40) };
    });
    console.log(`btnReservar: ${JSON.stringify(btn)}`);
    if (btn) {
      await page.touchscreen.tap(btn.x, btn.y).catch(() => page.mouse.click(btn.x, btn.y));
      await page.waitForTimeout(2500);
    }
    const paso1 = await page.evaluate(() => {
      const chips = Array.from(document.querySelectorAll('button, [role="button"], .fecha-chip, .day-chip, [class*="fecha"], [class*="day"], [class*="slot"], [class*="hora"], [class*="cupo"]'))
        .filter(el => el.offsetParent !== null && el.getBoundingClientRect().width > 20);
      return { total: chips.length, muestra: chips.slice(0, 12).map(c => { const r = c.getBoundingClientRect(); return { cls: (c.className || '').toString().slice(0, 30), t: (c.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24), w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x) }; }) };
    });
    console.log('chips visibles:', JSON.stringify(paso1, null, 1).slice(0, 1200));

    // Tap a la PRIMERA fecha
    const fecha = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('button, [role="button"], [class*="fecha"], [class*="day"], [class*="dia"]'))
        .find(c => c.offsetParent !== null && /\d{1,2}\s*(sept|oct|nov|sep|ago|de )?/i.test((c.textContent || '').slice(0, 12)) && c.getBoundingClientRect().height >= 20 && c.getBoundingClientRect().height <= 90);
      if (!el) return null;
      const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), txt: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30), cls: (el.className || '').toString().slice(0, 40) };
    });
    console.log('fecha candidata:', JSON.stringify(fecha));
    if (fecha) {
      await page.touchscreen.tap(fecha.x, fecha.y).catch(() => page.mouse.click(fecha.x, fecha.y));
      await page.waitForTimeout(2200);
      const horas = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('button, [role="button"], [class*="hora"], [class*="slot"], [class*="cupo"], [class*="time"]'))
          .filter(el => el.offsetParent !== null && /\d{1,2}:\d{2}/.test(el.textContent || ''));
        return els.slice(0, 10).map(c => { const r = c.getBoundingClientRect(); return { cls: (c.className || '').toString().slice(0, 30), txt: (c.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 20), w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), disabled: c.disabled === true }; });
      });
      console.log('horarios tras tap fecha:', JSON.stringify(horas, null, 1).slice(0, 1100));
      if (horas.length) {
        // tap a la primera hora disponible
        await page.touchscreen.tap(horas[0].x + 5, horas[0].y + 5).catch(() => {});
        await page.waitForTimeout(2200);
        const paso = await page.evaluate(() => {
          const sel = document.querySelector('[class*="seleccionado"], [class*="selected"], [class*="active"]');
          const summary = (document.body.innerText || '').match(/(resumen|confirmar|confirmación|datos|nombre|teléfono|continuar|siguiente)[^\n]{0,60}/gi) || [];
          return { seleccion: sel ? (sel.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) : null, summary: summary.slice(0, 4), overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        });
        console.log('tras tap hora:', JSON.stringify(paso, null, 1).slice(0, 700));
      }
    }
    await page.screenshot({ path: `e2e-shots/tablet/${vp.name}-booking.png` }).catch(() => {});
    await ctx.close();
  }
  await browser.close();
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
