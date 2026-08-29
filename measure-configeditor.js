// Validación ConfigEditor: sección "Datos del Negocio" + límite 14 días (vía HTTP local)
const { chromium } = require('playwright');

const BASE = 'http://localhost:8899';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + String(e).slice(0, 200)));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('supabase') && !m.text().includes('Sentry') && !m.text().includes('Turnstile')) errors.push('CONSOLE: ' + m.text().slice(0, 200)); });
  await page.route('**/supabase.co/**', r => r.fulfill({ contentType: 'application/json', body: '{}' }));
  await page.goto(BASE + '/admin.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2000);

  const render = await page.evaluate(async () => {
    window.__clientTenantId = 'c897a148-cd22-4266-8080-28ad2bafebfc';
    window.currentTenantId = window.__clientTenantId;
    window.supabaseClient = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'c897a148-cd22-4266-8080-28ad2bafebfc', nombre_negocio: 'brandoncatalanmura', configuracion: {} } }) }) }),
        update: () => ({ eq: () => ({ error: null }) }),
      }),
    };
    const chunk = await import('/dist/chunks/ConfigEditor-BUH3KYQ4.js').catch(e => ({ err: String(e) }));
    if (chunk.err) return { err: String(chunk.err) };
    const init = chunk.initConfigEditor;
    if (!init) return { noInit: true, keys: Object.keys(chunk) };
    await init('customization-form');
    return {
      nombreInput: !!document.getElementById('cfg-nombre-negocio'),
      nombreValor: document.getElementById('cfg-nombre-negocio')?.value || '',
      guardarBtn: !!document.getElementById('cfg-guardar-nombre-btn'),
      titulos: [...document.querySelectorAll('.config-section h4')].map(h => h.textContent.trim()),
    };
  });
  console.log('render ConfigEditor:', JSON.stringify(render, null, 1));
  console.log('errores:', JSON.stringify(errors.slice(0, 5), null, 1));

  await browser.close();
})();
