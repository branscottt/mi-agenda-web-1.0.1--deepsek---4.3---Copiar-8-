// inspect-notif.js — mide el popover de notificaciones en m393 y desktop
const { chromium } = require('playwright');
const fs = require('fs');

async function login(cfg, email, password) {
  const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return res.ok ? await res.json() : null;
}

async function inspect(vpName, vp, s, meta) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dsf, isMobile: vp.mobile, hasTouch: vp.mobile });
  const page = await context.newPage();
  await page.addInitScript(({ access, refresh }) => {
    localStorage.setItem('agendapro_access_token', access);
    localStorage.setItem('agendapro_refresh_token', refresh);
    localStorage.setItem('agendapro_user_data', JSON.stringify({ id: s.user.id, nombre: meta.nombre || 'A', email: 'admin@demo.com', rol: meta.rol || 'admin', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '' }));
  }, { access: s.access_token, refresh: s.refresh_token });
  await page.goto('http://localhost:8080/admin.html', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3500);

  // abrir el popover
  try {
    await page.click('.notif-bell-btn', { timeout: 3000 });
  } catch {
    await page.evaluate(() => {
      const b = document.querySelector('.notif-bell-btn');
      if (b) b.click();
    });
  }
  await page.waitForTimeout(1200);

  const r = await page.evaluate(() => {
    const pop = document.querySelector('.notif-popover');
    if (!pop) return { found: false };
    const cs = getComputedStyle(pop);
    const pr = pop.getBoundingClientRect();
    const out = {
      found: true,
      popover: { w: Math.round(pr.width), h: Math.round(pr.height), top: Math.round(pr.top), left: Math.round(pr.left), right: Math.round(pr.right), position: cs.position, maxH: cs.maxHeight, overflowY: cs.overflowY, bg: cs.backgroundColor, radius: cs.borderRadius, shadow: cs.boxShadow },
      children: Array.from(pop.children).map((el) => {
        const c = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return { cls: (el.className || '').toString().slice(0, 35), w: Math.round(r.width), h: Math.round(r.height), display: c.display, padding: c.padding, fontSize: c.fontSize };
      }),
      items: Array.from(pop.querySelectorAll('.notificacion-item, .notification-item')).slice(0, 3).map((el) => {
        const c = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), padding: c.padding, gap: c.gap, fontSize: c.fontSize, display: c.display, html: el.outerHTML.slice(0, 350) };
      }),
      tabs: Array.from(pop.querySelectorAll('.tab-btn')).map((el) => {
        const r = el.getBoundingClientRect();
        return { t: (el.textContent || '').trim().slice(0, 15), w: Math.round(r.width), h: Math.round(r.height) };
      }),
      header: (() => {
        const h = pop.querySelector('.notif-popover-header');
        if (!h) return null;
        const r = h.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), padding: getComputedStyle(h).padding };
      })(),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyText: pop.innerText.slice(0, 200),
    };
    return out;
  });
  await page.screenshot({ path: `responsive-shots/${vpName}/notif-popover.png` });
  console.log(`\n█████ NOTIF ${vpName} (${vp.width}x${vp.height}) █████`);
  console.log(JSON.stringify(r, null, 1).slice(0, 3000));
  await browser.close();
}

(async () => {
  const key = fs.readFileSync('/tmp/agendapro-key.txt', 'utf8').trim();
  const cfg = { url: 'https://dfcfimipkfhitlsyixqu.supabase.co', key };
  const s = await login(cfg, 'admin@demo.com', 'demo123');
  const meta = (s.user && s.user.user_metadata) || {};
  await inspect('m393', { width: 393, height: 852, dsf: 2, mobile: true }, s, meta);
  await inspect('desktop', { width: 1440, height: 900, dsf: 1, mobile: false }, s, meta);
})();
