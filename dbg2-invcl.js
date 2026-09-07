// dbg2-invcl.js — qué muestra realmente la sección clientes del tenant demo
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const key = fs.readFileSync('/tmp/agendapro-key-clean.txt', 'utf8').trim();
  const res = await fetch('https://dfcfimipkfhitlsyixqu.supabase.co/auth/v1/token?grant_type=password', {
    method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.com', password: 'demo123' }),
  });
  const session = await res.json();
  const meta = (session.user && session.user.user_metadata) || {};
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.addInitScript(({ access, refresh, tenantId }) => {
    localStorage.setItem('agendapro_access_token', access);
    localStorage.setItem('agendapro_refresh_token', refresh);
    localStorage.setItem('agendapro_user_data', JSON.stringify({ id: 'x', nombre: 'Admin Demo', email: 'admin@demo.com', rol: 'admin', tenant_id: tenantId, whatsapp: '' }));
    localStorage.setItem('agendapro_tour_' + tenantId, 'omitido');
  }, { access: session.access_token, refresh: session.refresh_token, tenantId: meta.tenant_id });
  await page.goto('http://127.0.0.1:8080/admin.html', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(9000);
  await page.evaluate(() => { const el = document.querySelector('.sidebar-item[data-section="clientes"]'); if (el) el.click(); });
  for (const t of [4000, 8000, 12000]) {
    await page.waitForTimeout(t === 4000 ? 4000 : t === 8000 ? 4000 : 4000);
    const estado = await page.evaluate(() => {
      const c = document.getElementById('clientes-list-container');
      return { txt: (c ? c.innerText : '(sin contenedor)').replace(/\s+/g, ' ').slice(0, 140), cards: document.querySelectorAll('.cliente-card').length };
    });
    console.log(`t+${t}s:`, JSON.stringify(estado));
  }
  await browser.close();
})();
