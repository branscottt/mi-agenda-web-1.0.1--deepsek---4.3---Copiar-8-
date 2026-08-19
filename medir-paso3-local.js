#!/usr/bin/env node
/**
 * medir-paso3-local.js — Abre test-paso3-mobile.html a viewports móviles,
 * genera módulos y captura el report de overflow + screenshots.
 */
const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const widths = process.argv.slice(2).map(Number).filter(Boolean);
  const VPWS = widths.length ? widths : [393, 360, 412];
  fs.mkdirSync('responsive-shots/paso3', { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  for (const VP_W of VPWS) {
    const ctx = await browser.newContext({
      viewport: { width: VP_W, height: 852 },
      isMobile: VP_W < 768, hasTouch: VP_W < 768, deviceScaleFactor: VP_W < 768 ? 2 : 1,
      userAgent: VP_W < 768
        ? 'Mozilla/5.0 (Linux; Android 13; 22111317G Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
        : 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await ctx.newPage();
    await page.goto('http://localhost:8899/test-paso3-mobile.html', { waitUntil: 'load' });
    await page.waitForTimeout(800);

    // Estado INICIAL (sin módulos)
    const estadoInicial = await page.evaluate(() => document.getElementById('report').innerText);

    // Generar módulos
    await page.click('#generate-modules-btn');
    await page.waitForTimeout(2000);

    const report = await page.evaluate(() => document.getElementById('report').innerText);
    console.log('═══════════ VIEWPORT ' + VP_W + 'px — CON MÓDULOS ═══════════');
    console.log(report);
    console.log('── INICIAL ──');
    console.log(estadoInicial);
    await page.screenshot({ path: 'responsive-shots/paso3/paso3-local-' + VP_W + '.png', fullPage: false });
    await ctx.close();
  }
  await browser.close();
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
