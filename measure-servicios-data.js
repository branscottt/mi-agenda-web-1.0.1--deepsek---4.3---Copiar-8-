// Auditoría de datos "Mis Servicios" contra admin.html REAL con datos simulados.
// El guard de auth redirige a login.html sin sesión → interceptamos esa navegación
// y servimos el propio admin.html (pathname login.html = permitido, sin loop).
// Stubea ServiciosManager (window.ServiciosManager = misma referencia interna) y
// ejercita: render, urgencias, modal detalle, editar, duplicar, toggle, filtros,
// casos borde y la rama latente de `modulos`.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ADMIN_HTML = fs.readFileSync(path.resolve('admin.html'), 'utf-8');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + String(e).slice(0, 220)));
  page.on('console', m => {
    if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 220));
  });
  page.on('dialog', d => d.accept());
  await page.route('**/login.html*', r => r.fulfill({ contentType: 'text/html', body: ADMIN_HTML }));
  await page.goto('file://' + path.resolve('admin.html'), { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2500);

  const ready = await page.evaluate(() => ({
    url: location.pathname.split('/').pop(),
    hasServiciosManager: typeof window.ServiciosManager !== 'undefined',
    hasCargar: typeof window.cargarServiciosExistentes !== 'undefined',
    hasSec: !!document.getElementById('section-mis-servicios'),
  }));
  console.log('estado página: ' + JSON.stringify(ready));
  if (!ready.hasServiciosManager) {
    console.log('FAIL setup: legacy no expuso ServiciosManager');
    await browser.close();
    return;
  }

  const dataset = `
  (() => {
    const d = (days) => { const x = new Date(); x.setDate(x.getDate()+days); return x.toISOString().slice(0,10); };
    const hp = (mins) => { const x = new Date(Date.now()+mins*60000); return String(x.getHours()).padStart(2,'0')+':'+String(x.getMinutes()).padStart(2,'0'); };
    const dp = (mins) => { const x = new Date(Date.now()+mins*60000); return x.toISOString().slice(0,10); };
    return [
      { id: 'S1', nombre: 'Corte premium', precio: 45000, duracion: 45, descripcion: 'Corte con navaja y styling',
        destacado: true, activo: true,
        fechas: [d(3), d(4), d(5)],
        disponibilidad: { [d(3)]: [{ hora: '10:00', cupos: 4, duration: 45 }] } },
      { id: 'S2', nombre: 'Urgente ya', precio: 20000, duracion: 30, descripcion: 'Urgencia menor a 2h',
        destacado: false, activo: true,
        fechas: [dp(0)],
        disponibilidad: { [dp(0)]: [{ hora: hp(30), cupos: 1, duration: 30 }] } },
      { id: 'S3', nombre: 'Proximo turno', precio: 30000, duracion: 60, descripcion: 'Entre 2 y 24 horas',
        destacado: false, activo: true,
        fechas: [dp(0)],
        disponibilidad: { [dp(0)]: [{ hora: hp(180), cupos: 3, duration: 60 }] } },
      { id: 'S4', nombre: 'Inactivo viejo', precio: 15000, duracion: 20, descripcion: 'Inactivo sin fechas futuras',
        destacado: false, activo: false,
        fechas: [d(-1)],
        disponibilidad: { [d(-1)]: [{ hora: '10:00', cupos: 5, duration: 20 }] } },
      { id: 'S5', nombre: 'Sin disponibilidad', precio: 5000, duracion: 15, descripcion: '',
        destacado: false, activo: true, fechas: [], disponibilidad: {} },
      { id: 'S6', nombre: 'Datos sucios ' + 'x'.repeat(60), precio: null, duracion: 60,
        descripcion: 'd '.repeat(100),
        destacado: false, activo: true, fechas: ['fecha-mala'],
        disponibilidad: { 'fecha-mala': [{ hora: '99:99', cupos: 0, duration: 60 }], [d(3)]: [{ hora: '10:00', cupos: 0, duration: 60 }] } },
      { id: 'S7', nombre: 'Modo antiguo modulos', precio: 10000, duracion: 30, descripcion: 'Solo modulos (rama latente)',
        destacado: false, activo: true, fechas: [d(3)], disponibilidad: {},
        modulos: [{ hora: '10:00', cupos: 2, duration: 30 }] }
    ];
  })()
  `;

  const setup = await page.evaluate((ds) => {
    const data = eval(ds);
    if (!window.ServiciosManager) return { ok: false, reason: 'ServiciosManager no expuesto' };
    window.__toggleCalls = [];
    window.ServiciosManager.getAll = async () => data;
    window.ServiciosManager.toggleActivo = async (id, activo) => { window.__toggleCalls.push({ id, activo }); return true; };
    window.ServiciosManager.delete = async () => true;
    if (window.VentasManager) window.VentasManager.getMes = async () => [];
    return { ok: true, n: data.length };
  }, dataset);
  if (!setup.ok) { console.log('FAIL setup: ' + setup.reason); await browser.close(); return; }

  const render = await page.evaluate(async () => {
    let crashed = false, error = '';
    try { await window.cargarServiciosExistentes(); } catch (e) { crashed = true; error = String(e); }
    const cards = [...document.querySelectorAll('.service-card-admin')];
    return {
      crashed, error,
      count: cards.length,
      cards: cards.map(c => ({
        id: c.dataset.serviceId,
        urgencia: c.dataset.urgencia,
        classes: c.className,
        badges: [...c.querySelectorAll('.service-status, .service-urgent-badge, .service-card-featured')].map(b => b.textContent.trim()),
        title: c.querySelector('.service-card-title h4')?.textContent.trim() || '',
        price: c.querySelector('.service-card-price')?.textContent.trim() || '',
        fechas: c.querySelector('.fechas-text')?.textContent.trim() || '',
        horas: c.querySelector('.hours-text')?.textContent.trim() || '',
        meta: [...c.querySelectorAll('.service-card-meta span')].map(s => s.textContent.trim()).join(' | '),
        buttons: [...c.querySelectorAll('.service-card-actions button')].map(b => b.innerText.replace(/\s+/g, ' ').trim() || '(icono)'),
      })),
    };
  });
  console.log('═══ 1. RENDER (7 variantes) ═══');
  console.log(JSON.stringify(render, null, 1));

  const safe = async (fn) => { try { return await fn(); } catch (e) { return { error: String(e).slice(0, 200) }; } };

  const modal = await safe(() => page.evaluate(async () => {
    document.querySelector('[data-service-id="S1"] .service-card-title h4').click();
    await new Promise(r => setTimeout(r, 600));
    const ov = document.getElementById('modal-servicio-detalle');
    return {
      visible: ov ? ov.style.display : 'no-modal',
      nombre: document.getElementById('detalle-nombre')?.textContent || '',
      precio: document.getElementById('detalle-precio')?.textContent || '',
      duracion: document.getElementById('detalle-duracion')?.textContent || '',
      cupos: document.getElementById('detalle-cupos-resumen')?.textContent.replace(/\s+/g, ' ').trim() || '',
    };
  }));
  console.log('═══ 2. MODAL DETALLE (S1) ═══');
  console.log(JSON.stringify(modal, null, 1));
  await page.evaluate(() => { const ov = document.getElementById('modal-servicio-detalle'); if (ov) ov.style.display = 'none'; }).catch(() => {});

  const dup = await safe(() => page.evaluate(async () => {
    document.querySelector('[data-service-id="S1"] [data-srv-action="duplicar"]').click();
    await new Promise(r => setTimeout(r, 400));
    return { name: document.getElementById('srv-name')?.value || '', price: document.getElementById('srv-price')?.value || '' };
  }));
  console.log('═══ 3. DUPLICAR (S1) ═══');
  console.log(JSON.stringify(dup, null, 1));

  const edit = await safe(() => page.evaluate(async () => {
    document.querySelector('[data-service-id="S1"] [data-srv-action="editar"]').click();
    await new Promise(r => setTimeout(r, 400));
    return { name: document.getElementById('srv-name')?.value || '', price: document.getElementById('srv-price')?.value || '' };
  }));
  console.log('═══ 4. EDITAR (S1) ═══');
  console.log(JSON.stringify(edit, null, 1));

  const tog = await safe(() => page.evaluate(async () => {
    const before = window.__toggleCalls.length;
    document.querySelector('[data-service-id="S4"] [data-srv-action="toggle"]').click();
    await new Promise(r => setTimeout(r, 600));
    const calls = window.__toggleCalls.slice(before);
    const s4 = document.querySelector('[data-service-id="S4"]');
    return { calls, s4Button: s4 ? s4.querySelector('[data-srv-action="toggle"]')?.innerText.replace(/\s+/g, ' ').trim() : 'no-card' };
  }));
  console.log('═══ 5. TOGGLE (S4 inactivo → activar) ═══');
  console.log(JSON.stringify(tog, null, 1));

  const filt = await safe(() => page.evaluate(async () => {
    const out = {};
    const setF = (estado, urgencia) => {
      const e = document.getElementById('filter-status'); if (e) e.value = estado;
      const u = document.getElementById('filter-urgency'); if (u) u.value = urgencia;
    };
    const visible = () => [...document.querySelectorAll('.service-card-admin')].filter(c => c.style.display !== 'none').map(c => c.dataset.serviceId);
    setF('inactive', 'all'); await window.aplicarFiltros(); out.inactive = visible();
    setF('all', 'urgent-now'); await window.aplicarFiltros(); out.urgentNow = visible();
    setF('all', 'urgent-soon'); await window.aplicarFiltros(); out.urgentSoon = visible();
    setF('all', 'all'); await window.aplicarFiltros(); out.all = visible();
    return out;
  }));
  console.log('═══ 6. FILTROS ═══');
  console.log(JSON.stringify(filt, null, 1));

  await page.evaluate(async () => { await window.cargarServiciosExistentes(); }).catch(e => errors.push('RENDER-EVAL: ' + String(e)));
  await page.waitForTimeout(600);

  console.log('═══ 7. ERRORES ═══');
  console.log('total: ' + errors.length);
  const interesting = errors.filter(e => !/(supabase|Turnstile|challenges|Sentry|ERR_|net::|400|favicon|posthog|mercadopago|CitasManager|VentasManager|notificaciones|getMes|getAll|Session|sesión|JwtManager|initSupabase|Uncaught.*promise|Google Maps|mapbox|fonts\.google|gstatic)/i.test(e));
  console.log('relevantes: ' + JSON.stringify(interesting, null, 1));
  console.log('errores totalTurnos/ReferenceError: ' + JSON.stringify(errors.filter(e => e.includes('totalTurnos') || e.includes('ReferenceError')), null, 1));

  await browser.close();
})();
