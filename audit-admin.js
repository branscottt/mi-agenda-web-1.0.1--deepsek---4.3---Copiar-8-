// audit-admin.js — auditoría profunda de admin @393: recorre las vistas del sidebar,
// captura screenshots por vista y mide problemas reales (texto desbordado, botones
// pequeños, grids estrechos, elementos superpuestos).
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

async function auditView(page, label) {
  await page.waitForTimeout(1800);
  const data = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const issues = [];

    // 1. Texto desbordando contenedores (scrollWidth > clientWidth con overflow hidden/auto)
    document.querySelectorAll('body *').forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.overflowX === 'hidden' && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.width < vw) {
          issues.push({
            tipo: 'TEXTO CORTADO', tag: el.tagName.toLowerCase(),
            cls: (el.className || '').toString().slice(0, 50), id: el.id || '',
            w: Math.round(el.clientWidth), sw: el.scrollWidth,
          });
        }
      }
    });

    // 2. Botones pequeños (< 36px de alto)
    document.querySelectorAll('button, .btn-grad, .btn-secondary, .btn-small, .btn-icon').forEach((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width > 0 && r.height > 0 && r.height < 34 && cs.display !== 'none' && cs.visibility !== 'hidden') {
        const visible = el.offsetParent !== null;
        if (visible) {
          issues.push({
            tipo: 'BOTÓN PEQUEÑO', tag: el.tagName.toLowerCase(),
            cls: (el.className || '').toString().slice(0, 50), id: el.id || '',
            h: Math.round(r.height), w: Math.round(r.width),
          });
        }
      }
    });

    // 3. Elementos que se salen del viewport
    document.querySelectorAll('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && el.offsetParent !== null && (r.right > vw + 1 || r.left < -1)) {
        // ignorar sidebar oculto y decoración
        const cls = (el.className || '').toString();
        if (cls.includes('sidebar') || cls.includes('bg-circle')) return;
        issues.push({
          tipo: 'FUERA DE PANTALLA', tag: el.tagName.toLowerCase(),
          cls: cls.slice(0, 50), id: el.id || '',
          L: Math.round(r.left), R: Math.round(r.right), W: Math.round(r.width),
        });
      }
    });

    // 4. Stats: ancho de tarjetas
    const stats = [];
    document.querySelectorAll('.stat-box').forEach((el) => {
      const r = el.getBoundingClientRect();
      stats.push({ w: Math.round(r.width), h2: (el.querySelector('h2') || {}).textContent || '', span: (el.querySelector('span') || {}).textContent || '' });
    });

    return { vw, issues, stats, scrollHeight: document.documentElement.scrollHeight };
  });

  await page.screenshot({ path: path.join(OUT, `admin-${label}.png`), fullPage: true });
  console.log(`\n=== VISTA: ${label} ===`);
  console.log(`  altura página: ${data.scrollHeight}px | stats: ${data.stats.map(s => `${s.w}px(${s.h2})`).join(' | ')}`);
  const byType = {};
  for (const i of data.issues) {
    byType[i.tipo] = byType[i.tipo] || [];
    byType[i.tipo].push(i);
  }
  for (const [tipo, list] of Object.entries(byType)) {
    console.log(`  [${tipo}] ${list.length}`);
    for (const i of list.slice(0, 8)) {
      console.log(`    ${i.tag}.${i.cls}${i.id ? '#' + i.id : ''} ${i.w ? 'w=' + i.w : ''}${i.sw ? 'sw=' + i.sw : ''}${i.h ? 'h=' + i.h : ''}${i.L !== undefined ? 'L=' + i.L + ' R=' + i.R : ''}`);
    }
  }
  return data;
}

(async () => {
  const key = fs.readFileSync('/tmp/agendapro-key-clean.txt', 'utf8').trim();
  const cfg = { url: 'https://dfcfimipkfhitlsyixqu.supabase.co', key };
  const session = await login(cfg, 'admin@demo.com', 'demo123');
  if (!session) { console.log('login falló'); process.exit(1); }
  const meta = (session.user && session.user.user_metadata) || {};

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
    localStorage.setItem('agendapro_user_data', JSON.stringify({
      id: session.user.id, nombre: meta.nombre || 'Admin', email: 'admin@demo.com',
      rol: meta.rol || 'admin', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '',
    }));
  }, { access: session.access_token, refresh: session.refresh_token });

  await page.goto('http://localhost:8080/admin.html', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);

  // Vista inicial (dashboard)
  await auditView(page, 'dashboard');

  // Abrir sidebar (off-canvas en móvil)
  try {
    await page.click('.sidebar-toggle, .menu-toggle, #sidebar-toggle, .hamburger', { timeout: 3000 });
    await page.waitForTimeout(600);
  } catch {
    console.log('(sidebar toggle no encontrado, intento force click en items)');
  }

  // Recorrer el sidebar: click en cada item y auditar
  const items = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.sidebar-item')).map((a, i) => ({
      i, text: (a.textContent || '').trim().slice(0, 30), href: a.getAttribute('href') || a.dataset.view || '',
    }));
  });
  console.log('\nItems del sidebar:', items.map(x => `${x.i}:${x.text}`).join(' | '));

  for (const it of items) {
    const label = it.text.replace(/[^a-z0-9]/gi, '_').slice(0, 20);
    try {
      // Click vía JS (evita verificación de viewport de playwright)
      await page.evaluate((i) => {
        const el = document.querySelectorAll('.sidebar-item')[i];
        if (el) el.click();
      }, it.i);
      await auditView(page, label || `vista${it.i}`);
      // si navegó a otra página (href), volver a admin
      if (!page.url().includes('admin.html')) {
        await page.goto('http://localhost:8080/admin.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(2500);
        try {
          await page.click('.sidebar-toggle, .menu-toggle, #sidebar-toggle, .hamburger', { timeout: 3000 });
          await page.waitForTimeout(500);
        } catch {}
      }
    } catch (e) {
      console.log(`\n=== VISTA: ${label} — no navegable (${e.message.slice(0, 60)}) ===`);
    }
  }

  await browser.close();
})();
