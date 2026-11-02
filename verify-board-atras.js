const { chromium, devices } = require('playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto('http://127.0.0.1:8099/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);

  // Simula el contrato de ClientBoard: tablero como capa 'board' + tarjeta encima.
  await page.evaluate(() => {
    const board = document.createElement('div');
    board.id = 'kanban-modal';
    board.className = 'kanban-modal-overlay';
    board.style.cssText = 'position:fixed;inset:0;display:flex;background:rgba(0,0,0,.7);';
    document.body.appendChild(board);
    window.__boardCerrado = false;
    window.Atras.abrir('board', () => { window.__boardCerrado = true; board.remove(); return true; });

    const card = document.createElement('div');
    card.id = 'kanban-card-overlay';
    card.className = 'kanban-card-overlay';
    card.style.cssText = 'position:fixed;inset:0;display:flex;background:rgba(0,0,0,.8);';
    card.innerHTML = '<button class="kanban-btn-close" id="kcard-cerrar">x</button>';
    document.body.appendChild(card);
    card.querySelector('.kanban-btn-close').addEventListener('click', () => card.remove());
  });
  await page.waitForTimeout(500);
  console.log('pila inicial:', await page.evaluate(() => window.Atras.pila()));

  await page.goBack();
  await page.waitForTimeout(500);
  const t1 = await page.evaluate(() => ({
    card: !!document.getElementById('kanban-card-overlay'),
    board: !!document.getElementById('kanban-modal'),
    pila: window.Atras.pila(),
    cerrado: window.__boardCerrado,
    url: location.pathname
  }));
  console.log((!t1.card && t1.board && !t1.cerrado && t1.pila.length === 1 ? 'PASS' : 'FAIL') + ' atrás cierra SOLO la tarjeta', JSON.stringify(t1));

  await page.goBack();
  await page.waitForTimeout(500);
  const t2 = await page.evaluate(() => ({
    board: !!document.getElementById('kanban-modal'),
    pila: window.Atras.pila(),
    cerrado: window.__boardCerrado,
    url: location.pathname
  }));
  console.log((!t2.board && t2.cerrado && t2.pila.length === 0 && t2.url === '/index.html' ? 'PASS' : 'FAIL') + ' segundo atrás cierra el tablero', JSON.stringify(t2));
  console.log('errores JS:', errs.length ? errs.join(' | ') : 'ninguno');
  await browser.close();
})();
