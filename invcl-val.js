// invcl-val.js — Validación de la invitación "Tus clientes ya se guardan solos"
// (InvitacionClientes.js). FASE 1: camino real en tenant demo (condición de datos
// con fichas con contenido => NO debe aparecer; sin errores JS del módulo).
// FASE 2: render visual del overlay con la plantilla REAL del módulo (mismo
// innerHTML + CSS real de dist/style.css) en PC/tablet/móvil + capturas.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = '/home/branscott/proyectos/mi-agenda-web 1.0.1 (deepsek) (4.3) (Copiar 13)';
const BASE = 'http://127.0.0.1:8080/admin.html';
const OUT = '/tmp/invcl-shots';
const REF = 'dfcfimipkfhitlsyixqu'; // subdominio supabase
const SB_KEY = `sb-${REF}-auth-token`;

async function login(cfg, email, password, intentos = 4) {
  for (let i = 1; i <= intentos; i++) {
    try {
      const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) return await res.json();
      console.log(`  login intento ${i} -> HTTP ${res.status}; reintento en ${6 + i * 4}s`);
    } catch (e) {
      console.log(`  login intento ${i} -> error red; reintento en ${6 + i * 4}s`);
    }
    await new Promise(r => setTimeout(r, (6 + i * 4) * 1000));
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const key = fs.readFileSync('/tmp/agendapro-key-clean.txt', 'utf8').trim();
  const cfg = { url: 'https://dfcfimipkfhitlsyixqu.supabase.co', key };

  console.log('=== FASE 1: login demo ===');
  const session = await login(cfg, 'admin@demo.com', 'demo123');
  if (!session) { console.log('login falló'); process.exit(1); }
  const meta = (session.user && session.user.user_metadata) || {};
  const tenantId = meta.tenant_id;
  console.log('tenant demo:', tenantId);

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errores = [];
  page.on('console', m => { if (m.type() === 'error') errores.push(m.text().slice(0, 220)); });
  page.on('pageerror', e => errores.push('PAGEERROR: ' + String(e).slice(0, 220)));

  await page.addInitScript(({ access, refresh, tenantId }) => {
    localStorage.setItem('agendapro_access_token', access);
    localStorage.setItem('agendapro_refresh_token', refresh);
    localStorage.setItem('agendapro_user_data', JSON.stringify({
      id: 'demo', nombre: 'Admin Demo', email: 'admin@demo.com',
      rol: 'admin', tenant_id: tenantId, whatsapp: '',
    }));
    // Tour resuelto (omitido) y clave de la invitación limpia: la decisión corre real.
    localStorage.setItem('agendapro_tour_' + tenantId, 'omitido');
    localStorage.removeItem('agendapro_inv_clientes_' + tenantId);
    localStorage.removeItem('mis_clientes_help_visible');
    localStorage.removeItem('mis_clientes_hint_ficha_visto');
  }, { access: session.access_token, refresh: session.refresh_token, tenantId });

  console.log('=== FASE 1: carga admin (camino real) ===');
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
  // Boot real: esperar dashboard + stats
  try { await page.waitForSelector('#stats-container .stat-box', { timeout: 30000 }); } catch (e) { console.log('  (stats no llegaron a tiempo)'); }
  try { await page.waitForSelector('#customization-form', { timeout: 25000 }); } catch (e) { /* puede tardar */ }
  await sleep(9000); // ventana de decisión de la invitación (600ms + lecturas + margen)

  const overlayReal = await page.evaluate(() => !!document.querySelector('.invcl-overlay'));
  console.log('overlay presente (debe ser false en tenant demo con fichas con contenido):', overlayReal);

  // Probar que el módulo se cargó y su chunk existe en el bundle
  const chunkCargado = await page.evaluate(async () => {
    try {
      const keys = await import('/chunks/InvitacionClientes-5RFU4ZL4.js');
      return typeof keys.initInvitacionClientes === 'function';
    } catch (e) { return 'error: ' + e.message; }
  });
  console.log('chunk InvitacionClientes importable con init:', chunkCargado);

  // Evidencia de la condición de datos del tenant demo: ir a Mis Clientes y ver
  // si hay clientes y si alguno tiene badges (contenido guardado).
  await page.evaluate(() => { const el = document.querySelector('.sidebar-item[data-section="clientes"]'); if (el) el.click(); });
  await sleep(7000);
  const dataClientes = await page.evaluate(() => {
    const cards = document.querySelectorAll('.cliente-card');
    const badges = document.querySelectorAll('.cliente-ficha-badge');
    return { clientes: cards.length, conContenido: badges.length > 0, badgeCount: badges.length };
  });
  console.log('Mis Clientes (tenant demo):', JSON.stringify(dataClientes));
  const esperado = (!overlayReal && dataClientes.clientes > 0 && dataClientes.conContenido)
    ? 'OK: hay clientes con contenido => la invitación correctamente NO aparece'
    : (overlayReal ? 'FALLO: overlay apareció con fichas con contenido' : 'REVISAR: condiciones de datos distintas a las esperadas');
  console.log('FASE 1 ->', esperado);

  const errInvcl = errores.filter(e => /InvitacionClientes|invcl/i.test(e));
  console.log('errores JS del módulo:', errInvcl.length ? errInvcl : 'ninguno');

  // ============ FASE 2: render visual con la plantilla real del módulo ============
  console.log('\n=== FASE 2: render visual (plantilla real) ===');
  const src = fs.readFileSync(path.join(REPO, 'src/clients/ui/InvitacionClientes.js'), 'utf8');
  const ini = src.indexOf('overlayEl.innerHTML = `') + 'overlayEl.innerHTML = `'.length;
  const fin = src.indexOf('`;', ini);
  let plantilla = src.slice(ini, fin);
  // Reemplazar las interpolaciones del contador con n=3 (mismo cálculo del módulo)
  plantilla = plantilla.replace("${nClientes === 1 ? '1 persona ya reservó' : nClientes + ' personas ya reservaron'} y está${nClientes === 1 ? '' : 'n'} en <b>Mis Clientes</b>",
    '3 personas ya reservaron y están en <b>Mis Clientes</b>');
  if (plantilla.includes('${')) {
    console.log('ATENCION: quedan interpolaciones sin resolver en la réplica:', plantilla.match(/\$\{[^}]*\}/g));
  }

  for (const vp of [{ w: 1440, h: 900, tag: 'pc' }, { w: 820, h: 1180, tag: 'tablet' }, { w: 393, h: 852, tag: 'movil' }]) {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    // Ir al dashboard para un fondo neutro
    await page.evaluate(() => { const el = document.querySelector('.sidebar-item[data-section="dashboard"]'); if (el) el.click(); });
    await sleep(1500);
    await page.evaluate((html) => {
      const previo = document.getElementById('invcl-replica');
      if (previo) previo.remove();
      const div = document.createElement('div');
      div.id = 'invcl-replica';
      div.className = 'invcl-overlay';
      div.style.position = 'fixed';
      div.innerHTML = html;
      document.body.appendChild(div);
    }, plantilla);
    await sleep(400);
    const geo = await page.evaluate(() => {
      const overlay = document.querySelector('.invcl-overlay');
      const card = document.querySelector('.invcl-card');
      const r = card.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const overflowH = card.scrollWidth > card.clientWidth + 2;
      const guia = document.getElementById('invcl-guia');
      guia.style.display = 'block';
      const scrollOk = guia.scrollHeight > 0;
      const btns = Array.from(document.querySelectorAll('.invcl-btn')).map(b => b.textContent.trim().slice(0, 24));
      return { vw, cardW: Math.round(r.width), cardH: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), overflowH, scrollOk, btns, z: getComputedStyle(overlay).zIndex };
    });
    await page.screenshot({ path: path.join(OUT, `${vp.tag}-overlay.png`) });
    console.log(`${vp.tag} ${vp.w}px -> card ${geo.cardW}x${geo.cardH} (L${geo.left} R${geo.right}) overflowH:${geo.overflowH} botones:${geo.btns.join(' | ')} z:${geo.z}`);
    // Guía abierta + captura extra en móvil
    if (vp.tag === 'movil') {
      const card = await page.evaluate(() => {
        const el = document.querySelector('.invcl-card');
        return { ch: el.clientHeight, sh: el.scrollHeight, oy: getComputedStyle(el).overflowY };
      });
      console.log('  móvil con guía abierta: card clientHeight', card.ch, 'scrollHeight', card.sh, 'overflowY', card.oy);
      await page.screenshot({ path: path.join(OUT, 'movil-overlay-guia.png') });
    }
  }

  await browser.close();
  console.log('\nCapturas en', OUT);
  console.log('errores JS totales (filtrados de ruido conocido):', errores.filter(e => !/42501|OTS|WebGL|favicon|net::|ERR_|Failed to load resource.*401/i.test(e)).slice(0, 10));
})();
