// verify-login-mobile.js — Verificación visual del login en móvil y desktop
// Carga el login en prod, comprueba el logo (ancho renderizado, blend, overflow) y guarda screenshots.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const results = {};

  for (const vp of [
    { name: 'movil-390', width: 390, height: 844 },
    { name: 'desktop-1440', width: 1440, height: 900 },
  ]) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('https://agenda-organify.vercel.app/login.html', { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(3500);

    const info = await page.evaluate(() => {
      const img = document.querySelector('.login-logo');
      if (!img) return { imgFound: false };
      const r = img.getBoundingClientRect();
      const cs = getComputedStyle(img);
      const panel = document.querySelector('.login-panel').getBoundingClientRect();
      return {
        imgFound: true,
        imgLoaded: img.complete && img.naturalWidth === 1020,
        imgX: Math.round(r.x), imgY: Math.round(r.y),
        imgW: Math.round(r.width), imgH: Math.round(r.height),
        blend: cs.mixBlendMode,
        media480: window.matchMedia('(max-width: 480px)').matches,
        overflowX: document.documentElement.scrollWidth > window.innerWidth,
        panelX: Math.round(panel.x), panelY: Math.round(panel.y), panelW: Math.round(panel.width),
      };
    });
    info.pageErrors = errors;
    results[vp.name] = info;

    await page.screenshot({ path: `responsive-shots/login-${vp.name}.png` });
    // Recorte del logo con margen para analizar el blending
    if (info.imgFound) {
      const clip = {
        x: Math.max(0, info.imgX - 30), y: Math.max(0, info.imgY - 30),
        width: info.imgW + 60, height: info.imgH + 60,
      };
      await page.screenshot({ path: `responsive-shots/login-${vp.name}-logo.png`, clip });
    }
    await page.close();
  }

  await browser.close();
  console.log(JSON.stringify(results, null, 2));
})();
