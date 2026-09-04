// ============================================================
// TOUR DE BIENVENIDA — onboarding exprés del panel admin
// (admin.html)
//
// ¿Qué hace?
//  - La primera vez que un admin entra a su cuenta (por tenant),
//    muestra un MAPA del panel: todas las secciones agrupadas
//    por zonas, con ícono + micro-etiqueta. Tocar una sección
//    navega directo (aprender haciendo). Desde el mapa se puede
//    lanzar el RECORRIDO GUIADO (30 s).
//  - El recorrido guiado enmarca 13 puntos en 4 grupos con
//    micro-copy (una idea = una línea, chips o mini-maquetas
//    visuales; cero párrafos y cero videos intercalados).
//    Los videos tutoriales siguen existiendo DENTRO de cada
//    sección ("Ver tutorial"), fuera de este módulo.
//  - Si omite o completa, NO vuelve a preguntar (localStorage
//    por tenant: 'agendapro_tour_<tenantId>' = 'visto'|'omitido').
//  - Si se cierra a mitad, guarda el progreso y al reabrir
//    desde "Ver tutorial" (footer del sidebar) continúa donde
//    quedó.
//
// Mecánica: overlay oscuro + spotlight (recuadro que enmarca el
// elemento objetivo) + tarjeta con título/descripción/contador
// por grupo y botones Volver / Omitir / Siguiente. Navega de
// grupo en grupo por el menú (una parada por sección).
//
// Reglas de convivencia con el resto de la app:
//  - Sin onclick inline ni <style> dinámico (CSP: script-src por
//    hashes; style-src permite unsafe-inline en style.css estático).
//  - z-index: overlay 10000, spotlight 10001, tarjeta 10002
//    (por encima de sidebar 1000 y modales 9999/10000).
//  - Usa window.navigateTo / window.toggleSidebar / window.toggleNotifPopover
//    (legacy) solo si existen; si no, enmarca sin navegar.
//  - No toca datos: solo localStorage propio.
// ============================================================

import { getCurrentTenantId } from '../../shared/domain/session.js';

const STORAGE_PREFIX = 'agendapro_tour_';

// ─────────────────────────────────────────────
// MINI-MAQUETAS VISUALES (ejemplos estáticos)
// Reemplazan a los videos: se leen en 1 segundo.
// Colores fijos (resisten tenant-custom-styles
// porque viven dentro de la tarjeta del tour).
// ─────────────────────────────────────────────
const MOCKS = {
    // Ficha de cliente con badges de lo que guarda
    ficha: `
        <div class="tour-mock tour-mock-ficha">
            <div class="tour-mock-ficha-avatar">M</div>
            <div class="tour-mock-ficha-main">
                <div class="tour-mock-ficha-nombre">María González</div>
                <div class="tour-mock-ficha-meta">12 turnos · su favorito: Calistenia</div>
                <div class="tour-mock-ficha-badges">
                    <span class="tour-badge"><i class="fas fa-paperclip"></i> 2 archivos</span>
                    <span class="tour-badge"><i class="fas fa-image"></i> 1 foto</span>
                    <span class="tour-badge"><i class="fas fa-paper-plane"></i> 3 env\u00edos</span>
                </div>
            </div>
        </div>`,
    // Celular: el link que recibe el cliente para reservar
    'wa-link': `
        <div class="tour-mock tour-mock-phone">
            <div class="tour-mock-wa-head"><i class="fab fa-whatsapp"></i> WhatsApp · Cliente</div>
            <div class="tour-mock-wa-msg">
                <p>Hola \ud83d\udc4b Reserva tu hora aqu\u00ed:</p>
                <div class="tour-mock-wa-card"><i class="fas fa-calendar-check"></i> agenda-pro.red/tu-negocio<span class="tour-mock-wa-btn">Reservar</span></div>
                <span class="tour-mock-wa-hora">10:24</span>
            </div>
        </div>`,
    // Celular: agenda semanal que recibe cada trabajador
    'wa-agenda': `
        <div class="tour-mock tour-mock-phone">
            <div class="tour-mock-wa-head"><i class="fab fa-whatsapp"></i> WhatsApp · Trabajador</div>
            <div class="tour-mock-wa-msg">
                <p>Tu agenda de la semana:</p>
                <ul class="tour-mock-wa-lista">
                    <li>lun 10:00 \u00b7 Corte de cabello</li>
                    <li>lun 12:00 \u00b7 Tinte</li>
                    <li>mar 09:30 \u00b7 Corte infantil</li>
                </ul>
                <span class="tour-mock-wa-hora">09:02</span>
            </div>
        </div>`,
    // Dos horarios lado a lado (trabajadores)
    equipo: `
        <div class="tour-mock tour-mock-equipo">
            <div class="tour-mock-equipo-card"><i class="fas fa-user"></i><strong>Ana</strong><span>Lun a Vie \u00b7 9:00-13:00</span></div>
            <div class="tour-mock-equipo-card"><i class="fas fa-user"></i><strong>Luis</strong><span>Lun a Vie \u00b7 15:00-20:00</span></div>
        </div>`,
    // Chips fantasma: lo que se rellena en Datos de Admin
    ghosts: `
        <div class="tour-mock tour-mock-ghosts">
            <span class="tour-ghost"><i class="fas fa-store"></i> Nombre</span>
            <span class="tour-ghost"><i class="fas fa-image"></i> Logo</span>
            <span class="tour-ghost"><i class="fas fa-fill-drip"></i> Colores</span>
            <span class="tour-ghost"><i class="fas fa-share-alt"></i> Redes</span>
            <span class="tour-ghost"><i class="fas fa-map-marker-alt"></i> Mapa</span>
            <span class="tour-ghost"><i class="fas fa-store-alt"></i> Directorio</span>
        </div>`
};

// ─────────────────────────────────────────────
// RECORRIDO GUIADO EXPRÉS (13 paradas, 4 grupos)
// Regla de copy: si el nombre ya dice lo que hace,
// no se explica (chips de contenido). Una idea = una
// línea. Lo abstracto se muestra con una maqueta.
// ─────────────────────────────────────────────
const PASOS = [
    // ── GRUPO 1: TU DÍA A DÍA ──────────────────
    {
        selector: '#notif-bell-btn',
        abrirSidebar: false,
        icono: 'fa-bell',
        grupo: 'Tu d\u00eda a d\u00eda',
        titulo: 'Notificaciones',
        descripcion: 'Aqu\u00ed llegan las reservas de tus clientes: t\u00fa confirmas y la web avisa sola.',
        chips: ['Reserva nueva: confirmar', 'Recordatorio 24 h antes']
    },
    {
        section: 'dashboard',
        selector: '.sidebar-item[data-section="dashboard"]',
        abrirSidebar: true,
        icono: 'fa-chart-line',
        grupo: 'Tu d\u00eda a d\u00eda',
        titulo: 'Dashboard Financiero',
        descripcion: 'Tus n\u00fameros, sin hacer cuentas.',
        chips: ['Ventas de HOY', 'Exportar a CSV']
    },
    {
        section: 'citas',
        selector: '.sidebar-item[data-section="citas"]',
        abrirSidebar: true,
        icono: 'fa-calendar-check',
        grupo: 'Tu d\u00eda a d\u00eda',
        titulo: 'Citas Programadas',
        descripcion: 'Tus reservas: confirma, mueve la fecha o marca si asist\u00f3.'
    },
    // ── GRUPO 2: LO QUE OFRECES (solo existe) ──
    {
        section: 'crear-servicio',
        selector: '.sidebar-item[data-section="crear-servicio"]',
        abrirSidebar: true,
        icono: 'fa-plus-circle',
        grupo: 'Lo que ofreces',
        titulo: 'Crear Servicio',
        descripcion: '',
        chips: ['Nombre', 'Precio', 'Horarios', 'Cupos']
    },
    {
        section: 'mis-servicios',
        selector: '.sidebar-item[data-section="mis-servicios"]',
        abrirSidebar: true,
        icono: 'fa-boxes',
        grupo: 'Lo que ofreces',
        titulo: 'Mis Servicios',
        descripcion: '',
        chips: ['Editar', 'Duplicar', 'Activar']
    },
    // ── GRUPO 3: CLIENTES Y EQUIPO ─────────────
    {
        section: 'clientes',
        selector: '.sidebar-item[data-section="clientes"]',
        abrirSidebar: true,
        icono: 'fa-users',
        grupo: 'Clientes y equipo',
        titulo: 'Mis Clientes',
        mock: 'ficha',
        descripcion: 'Toca un cliente y abre su ficha: datos, notas, fotos y archivos en un solo lugar.'
    },
    {
        section: 'compartir',
        selector: '.sidebar-item[data-section="compartir"]',
        abrirSidebar: true,
        icono: 'fa-share-alt',
        grupo: 'Clientes y equipo',
        titulo: 'Compartir con Clientes',
        mock: 'wa-link',
        descripcion: 'Tu link y tu QR: tus clientes entran, ven tu cat\u00e1logo y reservan solos.'
    },
    {
        section: 'equipo',
        selector: '.sidebar-item[data-section="equipo"]',
        abrirSidebar: true,
        icono: 'fa-user-friends',
        grupo: 'Clientes y equipo',
        titulo: 'Mi Equipo',
        mock: 'equipo',
        descripcion: 'Solo si trabajas con m\u00e1s personas: cada uno con su servicio, su horario y su propia agenda.'
    },
    {
        section: 'horarios',
        selector: '.sidebar-item[data-section="horarios"]',
        abrirSidebar: true,
        icono: 'fa-clock',
        grupo: 'Clientes y equipo',
        titulo: 'Horarios',
        descripcion: 'Cu\u00e1ndo atiendes: por d\u00eda de la semana y por trabajador.'
    },
    {
        section: 'compartir-trabajadores',
        selector: '.sidebar-item[data-section="compartir-trabajadores"]',
        abrirSidebar: true,
        icono: 'fa-user-share',
        grupo: 'Clientes y equipo',
        titulo: 'Compartir Trabajadores',
        mock: 'wa-agenda',
        descripcion: 'Cada trabajador con su propio enlace: ve solo su agenda, sin entrar a tu panel.'
    },
    // ── GRUPO 4: TU WEB ────────────────────────
    {
        section: 'personalizar',
        selector: '.sidebar-item[data-section="personalizar"]',
        abrirSidebar: true,
        icono: 'fa-palette',
        grupo: 'Tu web',
        titulo: 'Datos de Admin',
        mock: 'ghosts',
        descripcion: 'Todo lo que ve tu cliente: dale la cara a tu web. Compl\u00e9talo cuando quieras.'
    },
    {
        section: 'suscripcion',
        selector: '.sidebar-item[data-section="suscripcion"]',
        abrirSidebar: true,
        icono: 'fa-crown',
        grupo: 'Tu web',
        titulo: 'Mi Suscripci\u00f3n',
        descripcion: 'Tu plan y tus facturas.'
    },
    // ── CIERRE (sin selector: tarjeta centrada) ─
    {
        selector: null,
        abrirSidebar: false,
        icono: 'fa-rocket',
        titulo: '\u00a1Listo! \ud83d\ude80',
        descripcion: 'Misi\u00f3n: crea tu primer servicio y comparte tu link con alguien. P\u00eddele que reserve\u2026 \u00a1y ver\u00e1s la magia! \u2728'
    }
];

// ─────────────────────────────────────────────
// MAPA DEL PANEL (bienvenida de una sola vista)
// Todas las secciones agrupadas por zona. Tocar
// una navega directo a usarla; el recorrido
// guiado queda como acción opcional.
// ─────────────────────────────────────────────
const MAPA_ZONAS = [
    {
        zona: 'Tu d\u00eda a d\u00eda',
        items: [
            { section: '__notif__', icono: 'fa-bell', nombre: 'Notificaciones', tag: 'Avisos y confirmaciones' },
            { section: 'dashboard', icono: 'fa-chart-line', nombre: 'Dashboard Financiero', tag: 'Tus n\u00fameros' },
            { section: 'citas', icono: 'fa-calendar-check', nombre: 'Citas Programadas', tag: 'Confirma y mueve' }
        ]
    },
    {
        zona: 'Lo que ofreces',
        items: [
            { section: 'crear-servicio', icono: 'fa-plus-circle', nombre: 'Crear Servicio', tag: 'Precio, horarios y cupos' },
            { section: 'mis-servicios', icono: 'fa-boxes', nombre: 'Mis Servicios', tag: 'Edita, duplica, activa' }
        ]
    },
    {
        zona: 'Tus clientes',
        items: [
            { section: 'clientes', icono: 'fa-users', nombre: 'Mis Clientes', tag: 'Fichas con archivos' },
            { section: 'compartir', icono: 'fa-share-alt', nombre: 'Compartir con Clientes', tag: 'Tu link y QR' }
        ]
    },
    {
        zona: 'Tu equipo',
        items: [
            { section: 'equipo', icono: 'fa-user-friends', nombre: 'Mi Equipo', tag: 'Solo con empleados' },
            { section: 'horarios', icono: 'fa-clock', nombre: 'Horarios', tag: 'Cu\u00e1ndo atiendes' },
            { section: 'compartir-trabajadores', icono: 'fa-user-share', nombre: 'Compartir Trabajadores', tag: 'Agenda de cada uno' }
        ]
    },
    {
        zona: 'Tu web',
        items: [
            { section: 'personalizar', icono: 'fa-palette', nombre: 'Datos de Admin', tag: 'La cara de tu web' },
            { section: 'suscripcion', icono: 'fa-crown', nombre: 'Mi Suscripci\u00f3n', tag: 'Tu plan' }
        ]
    }
];

function construirMapaHTML() {
    return MAPA_ZONAS.map((zona) => `
        <div class="tour-map-zona">
            <div class="tour-map-zona-titulo">${zona.zona}</div>
            <div class="tour-map-grid">
                ${zona.items.map((it) => `
                    <button type="button" class="tour-map-item" data-section="${it.section}">
                        <i class="fas ${it.icono}"></i>
                        <span class="tour-map-item-nombre">${it.nombre}</span>
                        <span class="tour-map-item-tag">${it.tag}</span>
                    </button>`).join('')}
            </div>
        </div>`).join('');
}

// Estado del tour
let tenantId = null;
let tourActivo = false;
let pasoIdx = 0;
let sidebarAbiertoAlIniciar = false;
let timerReposicion = null;
let overlayEl = null;
let spotlightEl = null;
let cardEl = null;
let welcomeEl = null;

function esMovil() {
    return window.matchMedia('(max-width: 768px)').matches;
}

function esperar(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Espera hasta que el selector exista en el DOM (polling ligero)
function esperarSelector(selector, timeoutMs) {
    return new Promise((resolve) => {
        const el = document.querySelector(selector);
        if (el) return resolve(el);
        const inicio = Date.now();
        const iv = setInterval(() => {
            const found = document.querySelector(selector);
            if (found) {
                clearInterval(iv);
                resolve(found);
            } else if (Date.now() - inicio > timeoutMs) {
                clearInterval(iv);
                resolve(null);
            }
        }, 100);
    });
}

// ─────────────────────────────────────────────
// PROGRESO DEL RECORRIDO (localStorage propio)
// ─────────────────────────────────────────────
function claveProgreso() {
    return STORAGE_PREFIX + tenantId + '_prog';
}

function guardarProgreso(i) {
    try {
        localStorage.setItem(claveProgreso(), String(i));
    } catch (e) { /* sin almacenamiento: no pasa nada */ }
}

function limpiarProgreso() {
    try {
        localStorage.removeItem(claveProgreso());
    } catch (e) { /* ignore */ }
}

// Devuelve el paso guardado si es retomable (no el último),
// o null si no hay progreso / quedó completo.
function leerProgreso() {
    try {
        const v = parseInt(localStorage.getItem(claveProgreso()), 10);
        if (Number.isFinite(v) && v >= 0 && v < PASOS.length - 1) return v;
    } catch (e) { /* ignore */ }
    return null;
}

// Posición dentro del grupo actual: {nombre, pos, tot}
function infoGrupo(idx) {
    const g = PASOS[idx] && PASOS[idx].grupo;
    if (!g) return null;
    let ini = idx;
    let fin = idx;
    while (ini > 0 && PASOS[ini - 1].grupo === g) ini--;
    while (fin < PASOS.length - 1 && PASOS[fin + 1].grupo === g) fin++;
    return { nombre: g, pos: idx - ini + 1, tot: fin - ini + 1 };
}

// ─────────────────────────────────────────────
// BIENVENIDA = MAPA DEL PANEL (una sola vista)
// ─────────────────────────────────────────────
function mostrarBienvenida() {
    if (welcomeEl) return;
    welcomeEl = document.createElement('div');
    welcomeEl.id = 'tour-welcome-overlay';
    welcomeEl.className = 'tour-overlay';
    welcomeEl.innerHTML = `
        <div class="tour-welcome-card tour-welcome-mapa">
            <div class="tour-welcome-icon"><i class="fas fa-map-signs"></i></div>
            <h3 class="tour-welcome-title">Conoce tu panel</h3>
            <p class="tour-welcome-text">Toca lo que te llame la atenci\u00f3n para entrar, o recorre todo en 30 segundos.</p>
            <div class="tour-map">${construirMapaHTML()}</div>
            <div class="tour-welcome-actions">
                <button type="button" class="tour-btn tour-btn-primario" id="tour-welcome-si"><i class="fas fa-play"></i> Recorrido guiado (30 s)</button>
                <button type="button" class="tour-btn tour-btn-secundario" id="tour-welcome-no">Ahora no</button>
            </div>
        </div>
    `;
    document.body.appendChild(welcomeEl);

    welcomeEl.querySelector('#tour-welcome-si').addEventListener('click', () => {
        localStorage.setItem(STORAGE_PREFIX + tenantId, 'visto');
        cerrarBienvenida();
        iniciarTour(0);
    });
    welcomeEl.querySelector('#tour-welcome-no').addEventListener('click', () => {
        localStorage.setItem(STORAGE_PREFIX + tenantId, 'omitido');
        cerrarBienvenida();
    });
    // Mapa: tocar una sección navega directo (aprender haciendo)
    welcomeEl.querySelectorAll('.tour-map-item').forEach((btn) => {
        btn.addEventListener('click', () => {
            const section = btn.dataset.section;
            localStorage.setItem(STORAGE_PREFIX + tenantId, 'visto');
            cerrarBienvenida();
            if (section === '__notif__') {
                if (typeof window.toggleNotifPopover === 'function') {
                    window.toggleNotifPopover();
                } else if (typeof window.navigateTo === 'function') {
                    window.navigateTo('dashboard');
                }
                return;
            }
            if (typeof window.navigateTo === 'function') {
                try {
                    window.navigateTo(section);
                } catch (e) { /* sección ya visible o sin navegación: cerrar basta */ }
            }
        });
    });
}

function cerrarBienvenida() {
    if (welcomeEl) {
        welcomeEl.remove();
        welcomeEl = null;
    }
}

// ─────────────────────────────────────────────
// TOUR (overlay + spotlight + tarjeta)
// ─────────────────────────────────────────────
function crearElementosTour() {
    if (overlayEl) return;

    overlayEl = document.createElement('div');
    overlayEl.id = 'tour-overlay';
    overlayEl.className = 'tour-overlay';

    spotlightEl = document.createElement('div');
    spotlightEl.id = 'tour-spotlight';
    spotlightEl.className = 'tour-spotlight';
    spotlightEl.style.display = 'none';

    cardEl = document.createElement('div');
    cardEl.id = 'tour-card';
    cardEl.className = 'tour-card';
    cardEl.setAttribute('role', 'dialog');
    cardEl.setAttribute('aria-live', 'polite');

    document.body.appendChild(overlayEl);
    document.body.appendChild(spotlightEl);
    document.body.appendChild(cardEl);
}

// desde: paso por el que arranca (0 = inicio, o progreso guardado)
function iniciarTour(desde) {
    if (tourActivo) return;
    tourActivo = true;
    crearElementosTour();
    const sidebar = document.getElementById('sidebar');
    sidebarAbiertoAlIniciar = !!(sidebar && sidebar.classList.contains('open'));
    // Reposicionar periódicamente: imágenes/logo del tenant y renders async
    // pueden mover el layout SIN disparar scroll/resize (p. ej. el header).
    if (!timerReposicion) {
        timerReposicion = setInterval(() => reposicionar(), 400);
    }
    const inicio = Number.isFinite(desde) ? Math.min(Math.max(desde, 0), PASOS.length - 1) : 0;
    pasoIdx = inicio - 1;
    irAPaso(inicio);
}

// opts.completo: el usuario terminó (finalizó la misión) → limpiar progreso.
// opts.abortar: falló la navegación (selector no encontrado) → no retomar.
function cerrarTour(opts) {
    if (!tourActivo) return;
    const o = opts || {};
    const ultimoPaso = pasoIdx >= PASOS.length - 1;
    tourActivo = false;
    if (timerReposicion) {
        clearInterval(timerReposicion);
        timerReposicion = null;
    }
    if (overlayEl) overlayEl.remove();
    if (spotlightEl) spotlightEl.remove();
    if (cardEl) cardEl.remove();
    overlayEl = spotlightEl = cardEl = null;
    // Restaurar el sidebar al estado previo al tour
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
        const abierto = sidebar.classList.contains('open');
        if (abierto && !sidebarAbiertoAlIniciar) {
            if (typeof window.toggleSidebar === 'function') window.toggleSidebar();
        }
    }
    if (o.abortar || o.completo || ultimoPaso) {
        limpiarProgreso();
    } else {
        guardarProgreso(pasoIdx);
    }
    window.removeEventListener('scroll', reposicionar, true);
    window.removeEventListener('resize', reposicionar);
    document.removeEventListener('keydown', manejarTeclado);
}

function manejarTeclado(e) {
    if (!tourActivo) return;
    if (e.key === 'Escape') {
        cerrarTour();
    } else if (e.key === 'ArrowRight') {
        siguiente();
    } else if (e.key === 'ArrowLeft') {
        volver();
    }
}

// Navega + espera que el objetivo exista y esté visible
async function irAPaso(i) {
    if (!tourActivo) return;
    if (i < 0 || i >= PASOS.length) return; // clamp de seguridad (ráfagas extremas de teclado)
    pasoIdx = i;
    const paso = PASOS[i];
    if (!paso) return;

    // 1. Navegar a la sección del menú (si corresponde y no está visible)
    if (paso.section) {
        const sec = document.getElementById('section-' + paso.section);
        const visible = sec && sec.style.display !== 'none';
        if (!visible && typeof window.navigateTo === 'function') {
            window.navigateTo(paso.section);
            await esperar(400); // deja correr el render de la sección
            if (pasoIdx !== i) return; // otro paso ganó la carrera (teclado/clicks rápidos)
        }
    }

    // 2. Pasos de menú: abrir el sidebar para enmarcar el item
    if (paso.abrirSidebar) {
        const sidebar = document.getElementById('sidebar');
        if (sidebar && !sidebar.classList.contains('open') && typeof window.toggleSidebar === 'function') {
            window.toggleSidebar();
            await esperar(380); // transición 0.3s
            if (pasoIdx !== i) return; // otro paso ganó la carrera
        }
    } else {
        // 2b. Pasos que no son del menú (campanita, cierre): cerrar el
        // sidebar si está abierto para que el spotlight ilumine el objetivo.
        const sidebar = document.getElementById('sidebar');
        if (sidebar && sidebar.classList.contains('open') && typeof window.toggleSidebar === 'function') {
            window.toggleSidebar();
            await esperar(380); // transición 0.3s
            if (pasoIdx !== i) return; // otro paso ganó la carrera
        }
    }

    // 3. Esperar el elemento objetivo
    let target = null;
    if (paso.selector) {
        target = await esperarSelector(paso.selector, 5000);
        if (pasoIdx !== i) return; // otro paso ganó la carrera
        if (!target) {
            // Elemento no encontrado: cerrar el tour silenciosamente
            // (abortar = no guardar progreso para no retomar un paso roto)
            cerrarTour({ abortar: true });
            return;
        }
        // Scroll al objetivo (centrado) — los items del sidebar son fixed, no se mueven
        try {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch (e) { /* ignore */ }
        await esperar(120);
        if (pasoIdx !== i) return; // otro paso ganó la carrera
    }

    // 4. Pintar tarjeta
    pintarCard(paso);

    // 5. Posicionar spotlight + tarjeta
    if (paso.selector) {
        spotlightEl.style.display = 'block';
    } else {
        spotlightEl.style.display = 'none';
    }
    reposicionar();

    // Listener permanente mientras el tour esté activo (scroll suave incluido)
    window.addEventListener('scroll', reposicionar, true);
    window.addEventListener('resize', reposicionar);
    document.addEventListener('keydown', manejarTeclado);
}

function pintarCard(paso) {
    const esUltimo = pasoIdx >= PASOS.length - 1;
    const grupo = infoGrupo(pasoIdx);
    const pct = Math.round((pasoIdx / (PASOS.length - 1)) * 100);
    const mockHTML = paso.mock ? (MOCKS[paso.mock] || '') : '';
    const chipsHTML = (paso.chips && paso.chips.length)
        ? `<div class="tour-chips">${paso.chips.map((c) => `<span class="tour-chip">${c}</span>`).join('')}</div>`
        : '';

    cardEl.innerHTML = `
        <div class="tour-card-header">
            <span class="tour-icon"><i class="fas ${paso.icono}"></i></span>
            <h4 class="tour-card-title">${paso.titulo}</h4>
            ${grupo ? `<span class="tour-card-count">${grupo.pos} de ${grupo.tot}</span>` : ''}
        </div>
        <div class="tour-progress"><div class="tour-progress-fill" style="width:${pct}%"></div></div>
        <div class="tour-card-body">
            ${grupo ? `<div class="tour-grupo"><i class="fas fa-layer-group"></i> ${grupo.nombre}</div>` : ''}
            ${mockHTML}
            ${paso.descripcion ? `<p class="tour-desc">${paso.descripcion}</p>` : ''}
            ${chipsHTML}
        </div>
        <div class="tour-card-footer">
            ${pasoIdx > 0 ? '<button type="button" class="tour-btn tour-btn-volver" data-accion="volver"><i class="fas fa-arrow-left"></i> Volver</button>' : ''}
            <span class="tour-card-spacer"></span>
            <button type="button" class="tour-btn tour-btn-secundario" data-accion="omitir">Omitir</button>
            ${esUltimo
                ? '<button type="button" class="tour-btn tour-btn-primario" data-accion="mision"><i class="fas fa-rocket"></i> Crear mi primer servicio</button>'
                : '<button type="button" class="tour-btn tour-btn-primario" data-accion="siguiente">Siguiente <i class="fas fa-arrow-right"></i></button>'}
        </div>
    `;
    cardEl.querySelectorAll('[data-accion]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const accion = btn.dataset.accion;
            if (accion === 'siguiente') siguiente();
            else if (accion === 'volver') volver();
            else if (accion === 'omitir') cerrarTour();
            else if (accion === 'mision') {
                cerrarTour({ completo: true });
                const { mostrarToast } = window.__toast || {};
                if (typeof mostrarToast === 'function') mostrarToast('\u00a1Manos a la obra! Crea tu primer servicio y comparte tu link.', 'success');
                if (typeof window.navigateTo === 'function') {
                    try {
                        window.navigateTo('crear-servicio');
                    } catch (e) { /* ignore */ }
                }
            }
        });
    });
}

function siguiente() {
    if (pasoIdx < PASOS.length - 1) irAPaso(pasoIdx + 1);
}

function volver() {
    if (pasoIdx > 0) irAPaso(pasoIdx - 1);
}

// Reposiciona spotlight + tarjeta según el rect actual del objetivo
function reposicionar() {
    if (!tourActivo || !overlayEl || !cardEl) return;
    const paso = PASOS[pasoIdx];
    if (!paso) return;

    if (!paso.selector) {
        // Paso final: tarjeta centrada (o abajo en móvil)
        spotlightEl.style.display = 'none';
        cardEl.classList.add('tour-card-centrada');
        return;
    }

    const target = document.querySelector(paso.selector);
    if (!target) return;
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const pad = 6;
    spotlightEl.style.display = 'block';
    spotlightEl.style.left = (rect.left - pad) + 'px';
    spotlightEl.style.top = (rect.top - pad) + 'px';
    spotlightEl.style.width = (rect.width + pad * 2) + 'px';
    spotlightEl.style.height = (rect.height + pad * 2) + 'px';

    cardEl.classList.remove('tour-card-centrada');
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cardW = Math.min(380, vw - 24);
    const cardH = cardEl.offsetHeight || 200;

    if (esMovil()) {
        // Móvil: tarjeta fija abajo
        cardEl.style.left = '12px';
        cardEl.style.right = '12px';
        cardEl.style.width = 'auto';
        cardEl.style.top = 'auto';
        cardEl.style.bottom = '12px';
        return;
    }

    // Desktop: debajo del spotlight si hay espacio, si no arriba
    let top = rect.bottom + 14;
    if (top + cardH > vh - 10) {
        top = rect.top - cardH - 14;
    }
    if (top < 10) top = Math.max(10, Math.min(top, vh - cardH - 10));
    let left = rect.left - 8;
    left = Math.max(12, Math.min(left, vw - cardW - 12));
    cardEl.style.left = left + 'px';
    cardEl.style.top = top + 'px';
    cardEl.style.right = 'auto';
    cardEl.style.bottom = 'auto';
    cardEl.style.width = cardW + 'px';
}

// ─────────────────────────────────────────────
// BOTÓN "VER TUTORIAL" (footer del sidebar)
// Reabre el mapa; si hay un recorrido a mitad,
// el botón del mapa ofrece continuarlo.
// ─────────────────────────────────────────────
function inyectarBotonReactivar() {
    const footer = document.querySelector('.sidebar-footer');
    if (!footer || document.getElementById('btn-tour-reactivar')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'btn-tour-reactivar';
    btn.className = 'btn-small tour-reactivar-btn';
    btn.innerHTML = '<i class="fas fa-question-circle"></i> Ver tutorial';
    btn.title = 'Volver a ver el recorrido guiado por el panel';
    btn.addEventListener('click', () => {
        localStorage.setItem(STORAGE_PREFIX + tenantId, 'visto');
        const prog = leerProgreso();
        // Si venía a mitad, continúa donde quedó; si no, arranca del mapa.
        if (prog !== null && prog > 0) {
            iniciarTour(prog);
        } else {
            mostrarBienvenida();
        }
    });
    footer.appendChild(btn);
}

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────
export async function initAdminTour() {
    try {
        // Solo en el panel admin
        if (!document.querySelector('.admin-screen')) return;

        tenantId = await getCurrentTenantId();
        if (!tenantId) return;

        // El botón de reactivar siempre está disponible
        inyectarBotonReactivar();

        // ¿Ya se mostró para este tenant? (localStorage por tenant)
        const estado = localStorage.getItem(STORAGE_PREFIX + tenantId);
        if (estado === 'visto' || estado === 'omitido') return;

        // Pequeña espera para que la página pinte antes de la pregunta
        setTimeout(() => {
            if (document.readyState === 'complete' || document.readyState === 'interactive') {
                mostrarBienvenida();
            } else {
                window.addEventListener('DOMContentLoaded', mostrarBienvenida, { once: true });
            }
        }, 1200);
    } catch (e) {
        console.warn('[AdminTour] No disponible:', e.message);
    }
}
