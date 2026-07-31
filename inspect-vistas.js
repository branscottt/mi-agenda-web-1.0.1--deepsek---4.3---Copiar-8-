// inspect-vistas.js — extrae estructura DOM + estilos de las vistas a mejorar
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

async function snapshot(page, label) {
  const r = await page.evaluate(() => {
    const out = { label: '', sections: [] };
    const grab = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        cls: sel,
        w: Math.round(rect.width), h: Math.round(rect.height),
        display: cs.display, flexDir: cs.flexDirection, gap: cs.gap,
        padding: cs.padding, bg: cs.backgroundColor, radius: cs.borderRadius,
        fontSize: cs.fontSize, fontWeight: cs.fontWeight,
        color: cs.color, border: cs.borderColor + ' ' + cs.borderWidth,
        html: el.outerHTML.slice(0, 500),
      };
    };
    return {
      header: grab('.admin-header'),
      h1: grab('.admin-header .header-left h1'),
      btnCliente: grab('.admin-header .header-right > .btn-grad'),
      bell: grab('.notif-bell-btn'),
      sidebar: grab('.sidebar-nav'),
      sidebarHeader: grab('.sidebar-header'),
      sidebarItems: Array.from(document.querySelectorAll('.sidebar-item')).slice(0, 3).map((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          text: (el.textContent || '').trim().slice(0, 30),
          w: Math.round(r.width), h: Math.round(r.height),
          display: cs.display, gap: cs.gap, padding: cs.padding, bg: cs.backgroundColor, radius: cs.borderRadius, active: el.className.includes('active'),
          html: el.outerHTML.slice(0, 300),
        };
      }),
      main: grab('.admin-main'),
    };
  });
  console.log(`\n█████ ${label} █████`);
  console.log(JSON.stringify(r, null, 1).slice(0, 3500));
}

(async () => {
  const key = fs.readFileSync('/tmp/agendapro-key.txt', 'utf8').trim();
  const cfg = { url: 'https://dfcfimipkfhitlsyixqu.supabase.co', key };
  const s = await login(cfg, 'admin@demo.com', 'demo123');
  if (!s) { console.log('login falló'); process.exit(1); }
  const meta = (s.user && s.user.user_metadata) || {};

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; 22111317G Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  });
  const page = await context.newPage();
  await page.addInitScript(({ access, refresh }) => {
    localStorage.setItem('agendapro_access_token', access);
    localStorage.setItem('agendapro_refresh_token', refresh);
    localStorage.setItem('agendapro_user_data', JSON.stringify({ id: s.user.id, nombre: meta.nombre || 'A', email: 'admin@demo.com', rol: meta.rol || 'admin', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '' }));
  }, { access: s.access_token, refresh: s.refresh_token });

  await page.goto('http://localhost:8080/admin.html', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);
  await snapshot(page, 'HEADER+SIDEBAR (dashboard)');

  const go = async (section) => {
    await page.evaluate((s) => { if (window.navigateTo) window.navigateTo(s); }, section);
    await page.waitForTimeout(2000);
  };

  await go('horarios');
  const hor = await page.evaluate(() => {
    const main = document.querySelector('.admin-main') || document.body;
    return {
      title: (main.querySelector('h2, h3') || {}).textContent || '',
      sections: Array.from(main.querySelectorAll('.glass-panel, .section-content > div')).slice(0, 6).map((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return { cls: (el.className || '').toString().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height), padding: cs.padding, display: cs.display, grid: cs.gridTemplateColumns, html: el.outerHTML.slice(0, 400) };
      }),
    };
  });
  console.log('\n█████ VISTA HORARIOS █████');
  console.log(JSON.stringify(hor, null, 1).slice(0, 3000));

  await go('compartir-trabajadores');
  const comp = await page.evaluate(() => {
    const main = document.querySelector('.admin-main') || document.body;
    return {
      title: (main.querySelector('h2, h3') || {}).textContent || '',
      sections: Array.from(main.querySelectorAll('.glass-panel, .share-panel, .section-content > div')).slice(0, 6).map((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return { cls: (el.className || '').toString().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height), padding: cs.padding, display: cs.display, html: el.outerHTML.slice(0, 400) };
      }),
    };
  });
  console.log('\n█████ VISTA COMPARTIR TRABAJADORES █████');
  console.log(JSON.stringify(comp, null, 1).slice(0, 3000));

  await go('suscripcion');
  const sub = await page.evaluate(() => {
    const main = document.querySelector('.admin-main') || document.body;
    return {
      title: (main.querySelector('h2, h3') || {}).textContent || '',
      sections: Array.from(main.querySelectorAll('.glass-panel, .subscription-info, .section-content > div')).slice(0, 6).map((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return { cls: (el.className || '').toString().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height), padding: cs.padding, display: cs.display, html: el.outerHTML.slice(0, 400) };
      }),
    };
  });
  console.log('\n█████ VISTA MI SUSCRIPCIÓN █████');
  console.log(JSON.stringify(sub, null, 1).slice(0, 3000));

  await browser.close();
})();
