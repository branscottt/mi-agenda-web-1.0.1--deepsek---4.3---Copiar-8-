// Re-chequeo PC: esperar a que LoginPage termine de inicializar antes de clickear el ojito
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'https://agenda-organify.vercel.app';
const SEL = '.toggle-password[data-target="login-password"]';

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/login.html`, { waitUntil: 'load', timeout: 40000 });
  await p.waitForFunction(() => window._loginInitialized === true, { timeout: 30000 });
  await p.waitForTimeout(800);
  const out = { inicializado: true };
  out.tipoInicial = await p.getAttribute('#login-password', 'type');
  await p.fill('#login-password', 'ClaveVisible123');
  await p.click(SEL);
  await p.waitForTimeout(300);
  out.tipoTrasOjo = await p.getAttribute('#login-password', 'type');
  out.icono = await p.getAttribute(`${SEL} i`, 'class');
  out.ariaPressed = await p.getAttribute(SEL, 'aria-pressed');
  out.tooltip = await p.getAttribute(SEL, 'title');
  out.foco = await p.evaluate(() => document.activeElement && document.activeElement.id);
  await p.screenshot({ path: '/tmp/fix-login-pc-1440.png' });
  await p.click(SEL);
  out.tipoTrasSegundoClic = await p.getAttribute('#login-password', 'type');
  out.valorSeConserva = await p.inputValue('#login-password');
  await b.close();
  console.log(JSON.stringify(out, null, 2));
})();
