// audit-cliente.js — auditoría profunda de cliente.html @393 (y superadmin/trabajador)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'responsive-shots', 'm393');

async function login(cfg, email, password) {
  const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return res.ok ? await res.json() : null;
}

async function audit(page, label, file, rol, email) {
  await page.goto(`http://localhost:8080/${file}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3500);
  const data = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const issues = [];
    document.querySelectorAll('body *').forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.overflowX === 'hidden' && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.width < vw) {
          issues.push({ tipo: 'TEXTO CORTADO', tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 55), id: el.id || '', w: Math.round(el.clientWidth), sw: el.scrollWidth });
        }
      }
    });
    document.querySelectorAll('button, .btn-grad, .btn-secondary, .btn-small, .btn-icon').forEach((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width > 0 && r.height > 0 && r.height < 34 && cs.display !== 'none' && el.offsetParent !== null) {
        issues.push({ tipo: 'BOTÓN PEQUEÑO', tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 55), id: el.id || '', h: Math.round(r.height), w: Math.round(r.width) });
      }
    });
    // grids de servicios: ancho de tarjetas
    const cards = [];
    document.querySelectorAll('.service-card, .services-grid > *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0) cards.push({ cls: (el.className || '').toString().slice(0, 40), w: Math.round(r.width) });
    });
    const unique = {};
    cards.forEach((c) => { unique[c.cls] = c.w; });
    return { vw, issues, cards: Object.entries(unique).slice(0, 6), scrollHeight: document.documentElement.scrollHeight };
  });
  await page.screenshot({ path: path.join(OUT, `${label}.png`), fullPage: true });
  console.log(`\n=== ${label} (${file}) @393 ===`);
  console.log(`  altura: ${data.scrollHeight}px | tarjetas: ${data.cards.map(([c, w]) => `${c.split(' ')[0]}→${w}px`).join(' | ')}`);
  const byType = {};
  for (const i of data.issues) {
    byType[i.tipo] = byType[i.tipo] || [];
    byType[i.tipo].push(i);
  }
  for (const [tipo, list] of Object.entries(byType)) {
    console.log(`  [${tipo}] ${list.length}`);
    for (const i of list.slice(0, 10)) {
      console.log(`    ${i.tag}.${i.cls}${i.id ? '#' + i.id : ''} ${i.w ? 'w=' + i.w : ''}${i.sw ? 'sw=' + i.sw : ''}${i.h ? 'h=' + i.h : ''}`);
    }
  }
}

(async () => {
  const key = fs.readFileSync('/tmp/agendapro-key.txt', 'utf8').trim();
  const cfg = { url: 'https://dfcfimipkfhitlsyixqu.supabase.co', key };
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; 22111317G Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  });

  // Cliente
  const sCliente = await login(cfg, 'cliente@demo.com', 'demo123');
  if (sCliente) {
    const meta = (sCliente.user && sCliente.user.user_metadata) || {};
    const page = await context.newPage();
    await page.addInitScript(({ access, refresh }) => {
      localStorage.setItem('agendapro_access_token', access);
      localStorage.setItem('agendapro_refresh_token', refresh);
      localStorage.setItem('agendapro_user_data', JSON.stringify({ id: sCliente.user.id, nombre: meta.nombre || 'Cliente', email: 'cliente@demo.com', rol: meta.rol || 'cliente', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '' }));
    }, { access: sCliente.access_token, refresh: sCliente.refresh_token });
    await audit(page, 'cliente-detalle', 'cliente.html', 'cliente', 'cliente@demo.com');
    await page.close();
  }

  // Superadmin (rol super_admin — probamos con admin por si acaso, si no, se reporta)
  const sAdmin = await login(cfg, 'admin@demo.com', 'demo123');
  if (sAdmin) {
    const meta = (sAdmin.user && sAdmin.user.user_metadata) || {};
    const page = await context.newPage();
    await page.addInitScript(({ access, refresh }) => {
      localStorage.setItem('agendapro_access_token', access);
      localStorage.setItem('agendapro_refresh_token', refresh);
      localStorage.setItem('agendapro_user_data', JSON.stringify({ id: sAdmin.user.id, nombre: meta.nombre || 'Admin', email: 'admin@demo.com', rol: meta.rol || 'admin', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '' }));
    }, { access: sAdmin.access_token, refresh: sAdmin.refresh_token });
    await audit(page, 'superadmin', 'superadmin.html', 'admin', 'admin@demo.com');
    await audit(page, 'trabajador', 'trabajador.html', 'admin', 'admin@demo.com');
    await page.close();
  }

  await browser.close();
})();
