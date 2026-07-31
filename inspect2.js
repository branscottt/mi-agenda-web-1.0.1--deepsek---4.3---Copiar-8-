// inspect2.js — texto plano de las vistas visibles
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

  const views = [
    ['horarios', 'HORARIOS'],
    ['compartir-trabajadores', 'COMPARTIR TRABAJADORES'],
    ['suscripcion', 'MI SUSCRIPCION'],
  ];
  for (const [section, label] of views) {
    await page.evaluate((s2) => { if (window.navigateTo) window.navigateTo(s2); }, section);
    await page.waitForTimeout(2000);
    const info = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('.admin-main > *, .admin-main .glass-panel, .admin-main .section-content > *').forEach((el) => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || el.getBoundingClientRect().width === 0) return;
        const r = el.getBoundingClientRect();
        const t = el.querySelector('h2, h3');
        const title = t ? t.textContent.trim().slice(0, 50) : '';
        out.push({
          cls: (el.className || '').toString().slice(0, 45),
          w: Math.round(r.width), h: Math.round(r.height),
          pad: cs.padding, display: cs.display,
          title,
          btns: Array.from(el.querySelectorAll('button, .btn-grad, .btn-secondary, .btn-small')).slice(0, 6).map((b) => {
            const br = b.getBoundingClientRect();
            return { t: (b.textContent || '').trim().slice(0, 25), w: Math.round(br.width), h: Math.round(br.height), cls: (b.className || '').toString().slice(0, 25) };
          }),
          inputs: Array.from(el.querySelectorAll('input, select, textarea')).slice(0, 4).map((i) => {
            const ir = i.getBoundingClientRect();
            return { ph: (i.placeholder || i.name || i.id || '').slice(0, 30), w: Math.round(ir.width), h: Math.round(ir.height) };
          }),
        });
      });
      return out;
    });
    console.log(`\n█████ ${label} █████`);
    for (const sec of info) {
      console.log(`[${sec.cls}] ${sec.w}x${sec.h} pad=${sec.pad} | ${sec.title}`);
      if (sec.btns.length) console.log('   botones:', sec.btns.map(b => `${b.t}(${b.w}x${b.h})`).join(' | '));
      if (sec.inputs.length) console.log('   inputs:', sec.inputs.map(i => `${i.ph}(${i.w}x${i.h})`).join(' | '));
    }
  }
  await browser.close();
})();
