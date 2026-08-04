// measure-share.js — Mide la sección "Compartir Trabajadores" en móvil y desktop.
// Uso: node measure-share.js [before|after]
const { chromium } = require('playwright');
const path = require('path');

const BASE = 'file://' + path.resolve(__dirname, 'test-share.html');
const tag = process.argv[2] || 'current';

async function measure(page, label) {
  const data = await page.evaluate(() => {
    const rect = el => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const cards = [...document.querySelectorAll('.worker-share-card')].map(card => {
      const links = card.querySelector('.worker-share-links');
      const input = card.querySelector('.worker-share-input');
      const btns = [...card.querySelectorAll('button')];
      return {
        card: rect(card),
        links: rect(links),
        linksDir: getComputedStyle(links).flexDirection,
        input: rect(input),
        inputOverflow: input.scrollWidth > input.clientWidth + 1, // texto cortado
        inputFont: getComputedStyle(input).fontSize,
        buttons: btns.map(b => ({ rect: rect(b), title: b.title })),
      };
    });
    const panel = document.querySelector('.glass-panel');
    const guide = document.querySelector('.step-guide');
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      docScrollW: document.documentElement.scrollWidth,
      docClientW: document.documentElement.clientWidth,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      panel: rect(panel),
      guide: rect(guide),
      cards,
      totalCardsHeight: cards.reduce((s, c) => s + c.card.h, 0),
    };
  });
  console.log(`\n=== ${label} (${tag}) ===`);
  console.log(JSON.stringify(data, null, 1));
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  // Móvil 390x844 (Redmi Note 12 Pro)
  const ctxMobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true, hasTouch: true,
  });
  const m = await ctxMobile.newPage();
  await m.goto(BASE, { waitUntil: 'load' });
  await m.waitForTimeout(600);
  await measure(m, 'MOVIL 390px');
  await ctxMobile.close();

  // Desktop 1440x900
  const ctxDesktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const d = await ctxDesktop.newPage();
  await d.goto(BASE, { waitUntil: 'load' });
  await d.waitForTimeout(600);
  await measure(d, 'DESKTOP 1440px');
  await ctxDesktop.close();

  await browser.close();
})();
