// verify-pwa-install.js — Verifica la tarjeta "Instalar app" (móvil/tablet)
// Uso: node verify-pwa-install.js [BASE_URL]
// Requiere el sitio servido (por defecto http://127.0.0.1:8099).
const { chromium, devices } = require('playwright');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:8099';
const OUT = 'e2e-shots/pwa-install';
fs.mkdirSync(OUT, { recursive: true });

// [ruta, ¿debe mostrarse?]
const CASOS = [
    ['/', true],              // portada: aparece al bajar
    ['/admin.html', false],   // sin sesión redirige a login → no aparece
    ['/cliente.html', true],
    ['/directorio.html', true],
    ['/login.html', false]    // login: NO (taparía el captcha)
];

async function revisar(browser, etiqueta, device, esDesktop) {
    const ctx = await browser.newContext({ ...device, locale: 'es-ES' });
    const page = await ctx.newPage();
    const errores = [];
    page.on('pageerror', (e) => errores.push(e.message));

    let ok = 0, fail = 0;
    const casos = esDesktop ? [['/', false]] : CASOS;
    for (const [ruta, esperado] of casos) {
        await page.goto(BASE + '/manifest.webmanifest'); // mismo origen: limpiar sesión
        await page.evaluate(() => { try { sessionStorage.clear(); } catch (e) {} });
        await page.goto(BASE + ruta, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        if (ruta === '/' && !esDesktop) {
            await page.evaluate(() => window.scrollTo(0, 600)); // la portada pide scroll
            await page.waitForTimeout(700);
        }
        const card = await page.$('#oia-card');
        const visible = !!card && await card.isVisible();
        const info = await page.evaluate(() => {
            const c = document.getElementById('oia-card');
            if (!c) return null;
            const r = c.getBoundingClientRect();
            const btn = c.querySelector('.oia-install');
            const br = btn ? btn.getBoundingClientRect() : null;
            return {
                texto: c.querySelector('.oia-txt strong').textContent.trim(),
                dentroViewport: r.top >= 0 && r.bottom <= window.innerHeight + 1 && r.left >= 0 && r.right <= window.innerWidth + 1,
                alto: Math.round(r.height), botonAlto: br ? Math.round(br.height) : 0,
                z: getComputedStyle(c).zIndex
            };
        });

        const pasa = visible === esperado;
        if (pasa) ok++; else fail++;
        console.log(`[${etiqueta}] ${ruta} → tarjeta=${visible ? 'SÍ' : 'no'} (esperado ${esperado ? 'SÍ' : 'no'}) ${pasa ? 'OK' : 'FALLA'}` +
            (info ? ` · "${info.texto}" · alto ${info.alto}px · botón ${info.botonAlto}px · dentro=${info.dentroViewport} · z=${info.z}` : ''));

        if (ruta === '/') {
            await page.screenshot({ path: `${OUT}/${etiqueta}-portada.png` });
            if (visible) {
                await page.click('#oia-card .oia-install');
                await page.waitForTimeout(500);
                const hoja = await page.$('#oia-hoja');
                console.log(`   hoja de pasos: ${hoja ? 'SÍ' : 'no'} · ${hoja ? (await page.textContent('#oia-hoja h3')).trim() : ''}`);
                await page.screenshot({ path: `${OUT}/${etiqueta}-pasos.png` });
                if (hoja) {
                    await page.click('#oia-hoja .oia-ok');
                    await page.waitForTimeout(300);
                    const cerrada = !(await page.$('#oia-hoja'));
                    if (!cerrada) fail++;
                    console.log(`   hoja cerrada con "Entendido": ${cerrada ? 'SÍ' : 'NO'}`);
                }
            }
        }
        if (ruta === '/admin.html') await page.screenshot({ path: `${OUT}/${etiqueta}-admin.png` });
    }

    // "Ahora no" / X oculta en la sesión (también tras recargar)
    if (!esDesktop) {
        await page.goto(BASE + '/manifest.webmanifest');
        await page.evaluate(() => { try { sessionStorage.clear(); } catch (e) {} });
        await page.goto(BASE + '/directorio.html', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        if (await page.$('#oia-card')) {
            const laterVisible = await page.isVisible('#oia-card .oia-later');
            await page.click(laterVisible ? '#oia-card .oia-later' : '#oia-card .oia-x');
            await page.waitForTimeout(300);
            const trasClic = !(await page.$('#oia-card'));
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(1500);
            const trasRecarga = !(await page.$('#oia-card'));
            const bien = trasClic && trasRecarga;
            if (!bien) fail++;
            console.log(`[${etiqueta}] cerrar aviso: oculta al tocar=${trasClic ? 'SÍ' : 'no'} · sigue oculta al recargar=${trasRecarga ? 'SÍ' : 'no'} ${bien ? 'OK' : 'FALLA'}`);
        }
    }

    // Formulario: al enfocar un campo, la tarjeta se aparta
    if (!esDesktop) {
        await page.goto(BASE + '/manifest.webmanifest');
        await page.evaluate(() => { try { sessionStorage.clear(); } catch (e) {} });
        await page.goto(BASE + '/cliente.html', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        const hay0 = !!(await page.$('#oia-card'));
        const campo = await page.$('input:visible, select:visible, textarea:visible');
        let seAparta = 'n/a';
        if (hay0 && campo) {
            await campo.click({ force: true }).catch(() => {});
            await page.waitForTimeout(300);
            seAparta = !(await page.$('#oia-card')) ? 'SÍ' : 'NO';
            if (seAparta !== 'SÍ') fail++;
        }
        console.log(`[${etiqueta}] al enfocar un campo se aparta: ${seAparta}`);
    }

    if (errores.length) console.log(`[${etiqueta}] errores JS de la página:`, [...new Set(errores)].slice(0, 3));
    console.log(`[${etiqueta}] RESULTADO: ${ok} OK / ${fail} FALLAS`);
    await ctx.close();
    return fail === 0;
}

(async () => {
    const browser = await chromium.launch();
    const res = [];
    res.push(await revisar(browser, 'iphone', devices['iPhone 13'], false));
    res.push(await revisar(browser, 'android', devices['Pixel 5'], false));
    res.push(await revisar(browser, 'tablet', devices['iPad (gen 7)'], false));
    res.push(await revisar(browser, 'desktop', { viewport: { width: 1440, height: 900 } }, true));
    await browser.close();
    console.log('\nTOTAL:', res.every(Boolean) ? 'TODO OK' : 'HAY FALLAS');
    process.exit(res.every(Boolean) ? 0 : 1);
})();
