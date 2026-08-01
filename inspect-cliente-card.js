// inspect-cliente-card.js — estructura de .cliente-card en Mis Clientes
const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const key = fs.readFileSync('/tmp/agendapro-key.txt', 'utf8').trim();
  const res = await fetch('https://dfcfimipkfhitlsyixqu.supabase.co/auth/v1/token?grant_type=password', {
    method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.com', password: 'demo123' }),
  });
  const s = await res.json();
  const meta = (s.user && s.user.user_metadata) || {};
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.addInitScript(({ access, refresh }) => {
    localStorage.setItem('agendapro_access_token', access);
    localStorage.setItem('agendapro_refresh_token', refresh);
    localStorage.setItem('agendapro_user_data', JSON.stringify({ id: s.user.id, nombre: meta.nombre || 'A', email: 'admin@demo.com', rol: meta.rol || 'admin', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '' }));
  }, { access: s.access_token, refresh: s.refresh_token });
  await page.goto('http://localhost:8080/admin.html', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3500);
  await page.evaluate(() => { if (window.navigateTo) window.navigateTo('clientes'); });
  await page.waitForTimeout(2500);

  const r = await page.evaluate(() => {
    const card = document.querySelector('.cliente-card');
    if (!card) {
      return { error: 'sin tarjetas', body: document.body.innerText.slice(0, 200) };
    }
    const cr = card.getBoundingClientRect();
    const children = Array.from(card.children).map((el) => {
      const c = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().slice(0, 45),
        w: Math.round(r.width), h: Math.round(r.height), display: c.display,
        text: (el.textContent || '').trim().slice(0, 55).replace(/\s+/g, ' '),
        html: el.outerHTML.slice(0, 300),
      };
    });
    const grid = document.querySelector('.clientes-grid');
    const gcs = grid ? getComputedStyle(grid) : null;
    return {
      card: { w: Math.round(cr.width), h: Math.round(cr.height) },
      grid: gcs ? { display: gcs.display, grid: gcs.gridTemplateColumns, gap: gcs.gap } : null,
      children,
      total: document.querySelectorAll('.cliente-card').length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  console.log(JSON.stringify(r, null, 1).slice(0, 3500));
  await browser.close();
})();
