// Medición con admin.html REAL (layout completo: sidebar + admin-main grid).
// Fuerza #section-mis-servicios visible e inyecta 2 cards iguales al legacy.
const { chromium } = require('playwright');
const path = require('path');

const CARDS = `
<div class="service-card-admin " data-service-id="svc-1">
  <div class="service-card-header">
    <div class="service-card-image service-image-fallback" style="background:linear-gradient(135deg, #667eea 0%, #764ba2 100%);display:flex;align-items:center;justify-content:center;">
      <span class="service-fallback-inicial">C</span>
    </div>
    <div class="service-card-featured"><i class="fas fa-star"></i> Destacado</div>
    <div class="service-status active">Activo</div>
  </div>
  <div class="service-card-body">
    <div class="service-card-title"><h4>Corte de cabello premium + barba</h4><div class="service-card-price">$45.000</div></div>
    <p class="service-card-desc">Corte con navaja, lavado y styling. Incluye asesoría de imagen y productos de fijación.</p>
    <div class="service-dates-info-card"><i class="fas fa-calendar-alt"></i><div class="dates-list"><strong>5 fecha(s):</strong><span class="fechas-text">20 ago, 21 ago, 22 ago...</span></div></div>
    <div class="service-hours-info-card"><i class="fas fa-clock"></i><div class="hours-list"><strong>8 horario(s):</strong><span class="hours-text">09:00, 10:00...</span></div></div>
    <div class="service-card-meta">
      <span title="Duración por turno"><i class="fas fa-hourglass-half"></i> 45 min</span>
      <span><i class="fas fa-users"></i> 3 por turno</span>
      <span class="fechas-count" title="20 ago&#10;21 ago&#10;22 ago"><i class="fas fa-calendar-check"></i> 5 días</span>
      <span class="hours-count" title="20 ago 09:00 - 3 cupos"><i class="fas fa-clock"></i> 8 turnos</span>
    </div>
    <div class="service-card-actions">
      <button class="btn-secondary btn-small" data-srv-action="editar" data-id="svc-1"><i class="fas fa-edit"></i> Editar</button>
      <button class="btn-small" data-srv-action="duplicar" data-id="svc-1" title="Duplicar servicio"><i class="fas fa-copy"></i></button>
      <button class="btn-small danger" data-srv-action="eliminar" data-id="svc-1"><i class="fas fa-trash"></i> Eliminar</button>
      <button class="btn-grad btn-small" data-srv-action="toggle" data-id="svc-1"><i class="fas fa-eye"></i> Ocultar</button>
    </div>
  </div>
</div>
<div class="service-card-admin service-no-dates" data-service-id="svc-2">
  <div class="service-card-header">
    <div class="service-card-image service-image-fallback" style="background:linear-gradient(135deg, #f093fb 0%, #f5576c 100%);display:flex;align-items:center;justify-content:center;">
      <span class="service-fallback-inicial">M</span>
    </div>
    <div class="service-status inactive">Inactivo</div>
    <span class="service-urgent-badge expirado"><i class="fas fa-hourglass-end"></i> Sin fechas</span>
  </div>
  <div class="service-card-body">
    <div class="service-card-title"><h4>Masaje relajante cuerpo completo</h4><div class="service-card-price">$60.000</div></div>
    <p class="service-card-desc">Masaje descontracturante de 60 minutos con aceites esenciales.</p>
    <div class="service-card-meta">
      <span title="Duración por turno"><i class="fas fa-hourglass-half"></i> 60 min</span>
      <span><i class="fas fa-users"></i> 1 por turno</span>
    </div>
    <div class="service-card-actions">
      <button class="btn-secondary btn-small" data-srv-action="editar" data-id="svc-2"><i class="fas fa-edit"></i> Editar</button>
      <button class="btn-small" data-srv-action="duplicar" data-id="svc-2" title="Duplicar servicio"><i class="fas fa-copy"></i></button>
      <button class="btn-small danger" data-srv-action="eliminar" data-id="svc-2"><i class="fas fa-trash"></i> Eliminar</button>
      <button class="btn-grad btn-small" data-srv-action="toggle" data-id="svc-2"><i class="fas fa-eye-slash"></i> Mostrar</button>
    </div>
  </div>
</div>`;

const VIEWPORTS = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'desktop-1366', width: 1366, height: 768 },
  { name: 'desktop-1280', width: 1280, height: 800 },
  { name: 'desktop-1024', width: 1024, height: 768 },
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'mobile-360', width: 360, height: 800 },
  { name: 'mobile-320', width: 320, height: 700 },
];

(async () => {
  const browser = await chromium.launch();
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 120)));
    await page.goto('file://' + path.resolve('admin.html'), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1200);
    await page.evaluate((cardsHtml) => {
      const sec = document.getElementById('section-mis-servicios');
      if (!sec) return;
      sec.style.display = 'block';
      const cont = document.getElementById('services-cards');
      if (cont) cont.innerHTML = cardsHtml;
    }, CARDS);
    await page.evaluate(() => document.fonts.ready).catch(() => {});
    await page.waitForTimeout(400);
    const d = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.service-card-admin')];
      if (!cards.length) return { error: 'no cards' };
      const out = [];
      for (const card of cards) {
        const cr = card.getBoundingClientRect();
        const actions = card.querySelector('.service-card-actions');
        const ar = actions.getBoundingClientRect();
        const btns = [...actions.querySelectorAll('button')].map(b => {
          const r = b.getBoundingClientRect();
          const cs = getComputedStyle(b);
          return { t: b.innerText.trim() || '(icono)', w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y), fs: cs.fontSize, inside: r.right <= cr.right + 1 && r.left >= cr.left - 1 && r.bottom <= cr.bottom + 1 && r.top >= cr.top - 1, clipped: b.scrollWidth > b.clientWidth + 1 };
        });
        const rows = {};
        btns.forEach(b => { const k = b.y; (rows[k] = rows[k] || []).push(b.t + '(' + b.w + 'px)'); });
        out.push({ cardW: Math.round(cr.width), cardH: Math.round(cr.height), rows: Object.values(rows).map(r => '[' + r.join(' + ') + ']'), allInside: btns.every(b => b.inside), noneClipped: btns.every(b => !b.clipped), labelsVisible: btns.every(b => b.fs !== '0px' || b.t === '(icono)') });
      }
      const main = document.querySelector('.admin-main');
      const mainR = main ? main.getBoundingClientRect() : null;
      return { mainW: mainR ? Math.round(mainR.width) : null, cards: out };
    }).catch(e => ({ error: String(e) }));
    const card0 = d.cards && d.cards[0];
    const st = (card0 && card0.allInside && card0.noneClipped && card0.labelsVisible) ? 'PASS' : 'FAIL';
    console.log(st + ' | ' + vp.name.padEnd(16) + ' main=' + (d.mainW || '?') + 'px card=' + (card0 ? card0.cardW + 'x' + card0.cardH : d.error || d.cards) + ' | ' + (card0 ? card0.rows.join(' ') : ''));
    if (errors.length) console.log('   console errors: ' + errors.join(' ;; '));
    await page.close();
  }
  await browser.close();
})();
