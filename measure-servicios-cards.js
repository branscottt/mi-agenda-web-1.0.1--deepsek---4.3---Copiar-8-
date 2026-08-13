// Medición de cards "Mis Servicios" (admin) en desktop y móvil.
// Uso: node measure-servicios-cards.js [--fix]
const { chromium } = require('playwright');

const FILE_URL = 'file://' + __dirname + '/test-servicios-cards.html';
const VIEWPORTS = [
  { name: 'desktop-1280', width: 1280, height: 800, sidebar: false },
  { name: 'desktop-1280-sidebar', width: 1280, height: 800, sidebar: 260 },
  { name: 'desktop-1024', width: 1024, height: 768, sidebar: false },
  { name: 'desktop-1366-sidebar', width: 1366, height: 768, sidebar: 260 },
  { name: 'mobile-390', width: 390, height: 844, sidebar: false },
  { name: 'mobile-360', width: 360, height: 800, sidebar: false },
  { name: 'mobile-320', width: 320, height: 700, sidebar: false },
];

(async () => {
  const browser = await chromium.launch();
  const results = {};
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    await page.goto(FILE_URL, { waitUntil: 'networkidle' });
    // esperar fuentes de iconos
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    const data = await page.evaluate((sidebar) => {
      if (sidebar) {
        const main = document.querySelector('.admin-main');
        main.style.marginLeft = sidebar + 'px';
      }
      const out = [];
      document.querySelectorAll('.service-card-admin').forEach((card, i) => {
        const cr = card.getBoundingClientRect();
        const actions = card.querySelector('.service-card-actions');
        const ar = actions.getBoundingClientRect();
        const cardStyle = getComputedStyle(card);
        const btns = [];
        actions.querySelectorAll('button').forEach((b, j) => {
          const r = b.getBoundingClientRect();
          const cs = getComputedStyle(b);
          const text = b.innerText.replace(/\s+/g, ' ').trim() || '(solo icono)';
          // ¿texto recortado? compara scrollWidth con clientWidth
          const clipped = b.scrollWidth > b.clientWidth + 1;
          btns.push({
            j,
            text,
            w: Math.round(r.width),
            h: Math.round(r.height),
            fontSize: cs.fontSize,
            whiteSpace: cs.whiteSpace,
            clipped,
            scrollW: b.scrollWidth,
            clientW: b.clientWidth,
            fullyInsideCard: r.right <= cr.right + 1 && r.left >= cr.left - 1 && r.bottom <= cr.bottom + 1 && r.top >= cr.top - 1,
          });
        });
        out.push({
          card: i,
          cardW: Math.round(cr.width),
          actionsW: Math.round(ar.width),
          actionsH: Math.round(ar.height),
          actionsWrap: getComputedStyle(actions).flexWrap,
          actionsDisplay: getComputedStyle(actions).display,
          actionsOverflowX: ar.right > cr.right + 1 || ar.left < cr.left - 1,
          actionsOverflowBottom: ar.bottom > cr.bottom + 1,
          cardOverflow: cardStyle.overflow,
          btns,
        });
      });
      return { viewport: window.innerWidth + 'x' + window.innerHeight, cards: out };
    }, vp.sidebar || 0);
    results[vp.name] = data;
    await page.close();
  }
  await browser.close();
  console.log(JSON.stringify(results, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
