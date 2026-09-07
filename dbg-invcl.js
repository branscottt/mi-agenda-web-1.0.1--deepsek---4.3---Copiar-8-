// dbg-invcl.js — depura inserción de la réplica del overlay
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
    localStorage.removeItem('agendapro_inv_clientes_' + tenantId);
  }, { access: session.access_token, refresh: session.refresh_token, tenantId: meta.tenant_id });
  page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE ERR:', m.text().slice(0, 200)); });
  await page.goto('http://127.0.0.1:8080/admin.html', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(8000);
  const src = fs.readFileSync('/home/branscott/proyectos/mi-agenda-web 1.0.1 (deepsek) (4.3) (Copiar 13)/src/clients/ui/InvitacionClientes.js', 'utf8');
  const ini = src.indexOf('overlayEl.innerHTML = `') + 'overlayEl.innerHTML = `'.length;
  const fin = src.indexOf('`;', ini);
  let plantilla = src.slice(ini, fin);
  plantilla = plantilla.replace("${nClientes === 1 ? '1 persona ya reservó' : nClientes + ' personas ya reservaron'} y está${nClientes === 1 ? '' : 'n'} en <b>Mis Clientes</b>", '3 personas ya reservaron y están en <b>Mis Clientes</b>');
  console.log('plantilla len:', plantilla.length, '| residuales ${:', (plantilla.match(/\$\{/g) || []).length);
  const r1 = await page.evaluate((html) => {
    const previo = document.getElementById('invcl-replica');
    if (previo) previo.remove();
    const div = document.createElement('div');
    div.id = 'invcl-replica';
    div.innerHTML = html;
    document.body.appendChild(div);
    return { replica: !!document.getElementById('invcl-replica'), cards: document.querySelectorAll('.invcl-card').length, htmlLen: div.innerHTML.length };
  }, plantilla);
  console.log('inserción:', JSON.stringify(r1));
  await page.waitForTimeout(300);
  const r2 = await page.evaluate(() => ({
    cards: document.querySelectorAll('.invcl-card').length,
    overlay: !!document.querySelector('.invcl-overlay'),
    primerClase: document.querySelector('.invcl-overlay') ? document.querySelector('.invcl-overlay').className : null,
    invclDefinido: !!document.querySelector('[class*=invcl]'),
  }));
  console.log('después de 300ms:', JSON.stringify(r2));
  await browser.close();
})();
