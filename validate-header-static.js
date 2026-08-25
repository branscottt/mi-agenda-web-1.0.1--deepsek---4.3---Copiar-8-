#!/usr/bin/env node
/**
 * validate-header-static.js — valida test-header.html (markup real +
 * estilos reales del tenant) en desktop y móvil, con y sin portada.
 * Captura viewport + métricas DOM. NO requiere auth.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
const OUT = path.join(__dirname, 'responsive-shots', 'verify');
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, isMobile: false, dsf: 1 },
  { name: 'm393', width: 393, height: 852, isMobile: true, dsf: 2 },
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const report = [];

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.dsf,
      isMobile: vp.isMobile, hasTouch: vp.isMobile,
      userAgent: vp.isMobile
        ? 'Mozilla/5.0 (Linux; Android 13; 22111317G Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
        : undefined,
    });
    const page = await context.newPage();
    await page.goto(`${BASE}/test-header.html`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(800);

    for (const mode of ['sin-portada', 'con-portada']) {
      if (mode === 'con-portada') {
        await page.evaluate(() => {
          document.querySelectorAll('.cover-banner-container').forEach(c => { c.style.display = 'block'; });
          document.querySelectorAll('.profile-header').forEach(el => el.classList.add('has-cover'));
          // portada simulada: degradado morado (sin imagen externa)
          document.querySelectorAll('.cover-banner-container').forEach(c => {
            c.style.background = 'linear-gradient(135deg, #4a1d6e, #9d4edd 60%, #2a1a4a)';
          });
        });
        await page.waitForTimeout(300);
      }
      const metrics = await page.evaluate(() => {
        const doc = document.documentElement;
        const vw = doc.clientWidth;
        const sw = Math.max(doc.scrollWidth, document.body.scrollWidth);
        const q = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return {
            top: Math.round(r.top), left: Math.round(r.left),
            right: Math.round(r.right), bottom: Math.round(r.bottom),
            width: Math.round(r.width), height: Math.round(r.height),
            bg: cs.backgroundImage !== 'none' ? cs.backgroundImage.slice(0, 50) : cs.backgroundColor,
            margin: cs.margin, radius: cs.borderRadius,
          };
        };
        const out = { scrollY: Math.round(window.scrollY), overflowX: sw - vw };
        for (const [k, sel] of Object.entries({
          profileAdmin: '.admin-screen .profile-header',
          headerAdmin: '.admin-screen .admin-header',
          coverAdmin: '.admin-screen .cover-banner-container',
          logoAdmin: '.admin-screen #tenant-logo',
          profileClient: '.client-screen .profile-header',
          headerClient: '.client-screen .client-header',
          coverClient: '.client-screen .cover-banner-container',
        })) out[k] = q(sel);
        // ¿La banda toca el borde derecho del viewport?
        out.bandRightGap = Math.round(vw - document.querySelector('.admin-screen .profile-header').getBoundingClientRect().right);
        return out;
      });
      const shotPath = path.join(OUT, `static-${vp.name}-${mode}.png`);
      await page.screenshot({ path: shotPath });
      report.push({ vp: vp.name, mode, shot: shotPath, ...metrics });
    }
    await context.close();
  }
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
