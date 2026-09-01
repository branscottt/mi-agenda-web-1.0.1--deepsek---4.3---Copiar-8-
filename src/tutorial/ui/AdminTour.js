// ============================================================
// TOUR DE BIENVENIDA — onboarding interactivo del panel admin
// (admin.html)
//
// ¿Qué hace?
//  - La primera vez que un admin entra a su cuenta (por tenant),
//    pregunta si quiere un recorrido guiado por el panel.
//  - Si omite o completa, NO vuelve a preguntar (localStorage
//    por tenant: 'agendapro_tour_<tenantId>' = 'visto'|'omitido').
//  - Botón "Ver tutorial" en el footer del sidebar para volver
//    a recorrerlo cuando quiera.
//
// Mecánica: overlay oscuro + spotlight (recuadro que enmarca el
// elemento objetivo) + tarjeta con descripción y botones
// Volver / Omitir / Siguiente. Navega de sección en sección del
// menú y, dentro de "Datos de Admin", enmarca cada campo
// individual (nombre del negocio, temas, colores, logo, etc.).
//
// Reglas de convivencia con el resto de la app:
//  - Sin onclick inline ni <style> dinámico (CSP: script-src por
//    hashes; style-src permite unsafe-inline en style.css estático).
//  - z-index: overlay 10000, spotlight 10001, tarjeta 10002
//    (por encima de sidebar 1000 y modales 9999/10000).
//  - Usa window.navigateTo / window.toggleSidebar (legacy) solo
//    si existen; si no, enmarca sin navegar.
//  - No toca datos: solo localStorage propio.
// ============================================================

import { getCurrentTenantId } from '../../shared/domain/session.js';

const STORAGE_PREFIX = 'agendapro_tour_';

const PASOS = [
    // ── 1. NOTIFICACIONES (campanita) — la más importante ─────
    {
        selector: '#notif-bell-btn',
        abrirSidebar: false,
        icono: 'fa-bell',
        titulo: 'Campanita de notificaciones',
        descripcion: 'Es la <strong>secci\u00f3n m\u00e1s importante del panel</strong>: ac\u00e1 recib\u00eds los avisos de tus clientes.<br><br>\u2022 <strong>Morada \u2014 Confirmaci\u00f3n de reserva:</strong> cada vez que un cliente reserva, aparece para que confirmes: presion\u00e1 "Correo" y se abre el mensaje ya escrito, solo dale enviar.<br>\u2022 <strong>Verde \u2014 Recordatorio:</strong> cuando falta 1 d\u00eda para la cita, aparece un recordatorio por WhatsApp ya armado para avisarle al cliente.<br><br>Revisala todos los d\u00edas: <strong>cada aviso es un cliente que espera tu confirmaci\u00f3n</strong>. Sin notificaciones pendientes = reservas al d\u00eda.'
    },
    // ── 2. DASHBOARD ──────────────────────────────────────────
    {
        section: 'dashboard',
        selector: '.sidebar-item[data-section="dashboard"]',
        abrirSidebar: true,
        icono: 'fa-chart-line',
        titulo: 'Dashboard Financiero',
        descripcion: 'Es el resumen econ\u00f3mico de tu negocio: las ventas de <strong>HOY</strong>, esta semana y este mes; la tendencia en un gr\u00e1fico; tus servicios m\u00e1s vendidos y KPIs como ticket promedio o d\u00eda pico.<br><br>Todos los montos salen solos de las citas registradas. Tambi\u00e9n pod\u00e9s filtrar por fechas y <strong>exportar tus ventas a CSV</strong>. Sirve para ver de un vistazo c\u00f3mo va tu negocio sin hacer cuentas.'
    },
    // ── 2. CREAR SERVICIO (detallado) ─────────────────────────
    {
        section: 'crear-servicio',
        selector: '.sidebar-item[data-section="crear-servicio"]',
        abrirSidebar: true,
        icono: 'fa-plus-circle',
        titulo: 'Crear Servicio',
        descripcion: 'Ac\u00e1 cre\u00e1s los servicios que ofrecer\u00e1s, paso a paso:<br>\u2022 <strong>Nombre y precio</strong>: ej. "Corte de cabello" $12.000.<br>\u2022 <strong>Duraci\u00f3n</strong>: cu\u00e1ntos minutos dura cada sesi\u00f3n.<br>\u2022 <strong>Imagen y descripci\u00f3n</strong> (opcional): para que el servicio se vea m\u00e1s atractivo.<br>\u2022 <strong>Fechas y cupos</strong>: eleg\u00eds qu\u00e9 d\u00edas est\u00e1 disponible (por rango de fechas o marcando d\u00edas en el calendario: lun, mar, mi\u00e9\u2026).<br>\u2022 <strong>Horarios</strong>: cu\u00e1ntas veces por d\u00eda tiene disponibilidad (ej. 10:00, 11:00, 12:00) y los cupos por horario.<br><br>Al final marc\u00e1s si va <strong>destacado en el cat\u00e1logo</strong> y si est\u00e1 <strong>activo</strong> para que los clientes puedan reservarlo.'
    },
    // ── 3. MIS SERVICIOS ──────────────────────────────────────
    {
        section: 'mis-servicios',
        selector: '.sidebar-item[data-section="mis-servicios"]',
        abrirSidebar: true,
        icono: 'fa-boxes',
        titulo: 'Mis Servicios',
        descripcion: 'Ac\u00e1 ves todos los servicios que creaste con su estado de disponibilidad: el color de cada tarjeta te avisa si hay cupos pronto (<strong>morado</strong> = pr\u00f3ximas 24 h), <strong>urgente</strong> (rojo = menos de 2 h) o <strong>expirado</strong> (gris = sin fechas).<br><br>Desde cada tarjeta pod\u00e9s <strong>editar</strong>, <strong>duplicar</strong>, <strong>ocultar</strong> o <strong>eliminar</strong> el servicio, y filtrar por estado o urgencia. Abajo ves totales, activos, destacados, cupos e <strong>ingresos proyectados</strong>.'
    },
    // ── 4. CITAS ──────────────────────────────────────────────
    {
        section: 'citas',
        selector: '.sidebar-item[data-section="citas"]',
        abrirSidebar: true,
        icono: 'fa-calendar-check',
        titulo: 'Citas Programadas',
        descripcion: 'Ac\u00e1 est\u00e1n todas las reservas de tus clientes, ordenadas por fecha. Para cada cita pod\u00e9s: <strong>contactar por WhatsApp</strong>, <strong>editar</strong> fecha/hora, marcar que <strong>asisti\u00f3</strong> o que <strong>no asistió</strong>.<br><br>La campana de notificaciones te avisa las reservas nuevas (morado) y los recordatorios de 24 h (verde). Es el coraz\u00f3n de tu agenda diaria.'
    },
    // ── 5. CLIENTES (detallado) ───────────────────────────────
    {
        section: 'clientes',
        selector: '.sidebar-item[data-section="clientes"]',
        abrirSidebar: true,
        icono: 'fa-users',
        titulo: 'Mis Clientes',
        descripcion: 'Ac\u00e1 est\u00e1n tus clientes: los que reservaron en tu web (por su email) y los que agreg\u00e1s a mano.<br><br>Toc\u00e1 <strong>"Informaci\u00f3n"</strong> en un cliente para abrir su ficha: ah\u00ed pod\u00e9s guardar sus datos, escribir notas e informaci\u00f3n importante, y <strong>subir archivos de manera individual</strong> (documentos, fotos, comprobantes) para tener todo ordenado y documentado por cliente. Ideal para llevar el historial de cada persona.'
    },
    // ── 6. MI EQUIPO ──────────────────────────────────────────
    {
        section: 'equipo',
        selector: '.sidebar-item[data-section="equipo"]',
        abrirSidebar: true,
        icono: 'fa-user-friends',
        titulo: 'Mi Equipo',
        descripcion: 'Si trabaj\u00e1s con m\u00e1s personas, ac\u00e1 las agreg\u00e1s: nombre, servicio que realizan y WhatsApp. Cada trabajador puede tener <strong>su propio horario y su propia agenda</strong>, y los clientes podr\u00e1n elegir con qui\u00e9n reservar.'
    },
    // ── 7. HORARIOS ───────────────────────────────────────────
    {
        section: 'horarios',
        selector: '.sidebar-item[data-section="horarios"]',
        abrirSidebar: true,
        icono: 'fa-clock',
        titulo: 'Horarios',
        descripcion: 'Ac\u00e1 defin\u00eds los <strong>horarios de atenci\u00f3n</strong>: por d\u00eda de la semana y por trabajador. Por ejemplo, lunes a viernes de 9:00 a 18:00 y s\u00e1bados solo ma\u00f1ana. Los cupos de tus servicios respetan estos horarios autom\u00e1ticamente.'
    },
    // ── 8. COMPARTIR TRABAJADORES ─────────────────────────────
    {
        section: 'compartir-trabajadores',
        selector: '.sidebar-item[data-section="compartir-trabajadores"]',
        abrirSidebar: true,
        icono: 'fa-user-share',
        titulo: 'Compartir Trabajadores',
        descripcion: 'Gener\u00e1 un <strong>enlace para cada trabajador</strong>: al abrirlo ve solo su propia agenda (sus citas y horarios) sin entrar a tu panel. \u00datil para que cada uno gestione sus turnos.'
    },
    // ── 9. DATOS DE ADMIN (sub-pasos por campo) ───────────────
    {
        section: 'personalizar',
        selector: '.sidebar-item[data-section="personalizar"]',
        abrirSidebar: true,
        icono: 'fa-palette',
        titulo: 'Datos de Admin',
        descripcion: 'Ac\u00e1 personaliz\u00e1s todo lo que ven tus clientes: el nombre de tu negocio, los colores, el logo y m\u00e1s. Te lo mostramos campo por campo.'
    },
    {
        section: 'personalizar',
        selector: '#cfg-nombre-negocio',
        abrirSidebar: false,
        icono: 'fa-store',
        titulo: 'Nombre del negocio',
        descripcion: 'Es el nombre que ven tus clientes arriba en tu p\u00e1gina y en el <strong>Directorio P\u00fablico</strong>. Si te registraste con Google, ac\u00e1 lo correg\u00eds (el nombre autom\u00e1tico es el prefijo de tu email). Pod\u00e9s cambiarlo <strong>una vez cada 14 d\u00edas</strong> para evitar abusos.'
    },
    {
        section: 'personalizar',
        selector: '#temas-grid',
        abrirSidebar: false,
        icono: 'fa-paint-roller',
        titulo: 'Temas r\u00e1pidos',
        descripcion: 'Un clic y toda tu p\u00e1gina cambia de colores al instante: el panel y la vista de tus clientes. Eleg\u00ed el tema que m\u00e1s represente tu negocio y despu\u00e9s ajust\u00e1 los detalles con los colores.'
    },
    {
        section: 'personalizar',
        selector: '#cfg-primary',
        abrirSidebar: false,
        icono: 'fa-fill-drip',
        titulo: 'Colores',
        descripcion: 'Ajust\u00e1 los colores principales uno por uno: <strong>Primario</strong> (botones y acentos), <strong>Secundario</strong> (gradientes y detalles), <strong>Fondo</strong>, <strong>Tarjetas</strong>, <strong>Texto</strong> y <strong>Bordes</strong>. Cada uno indica su funci\u00f3n: as\u00ed logr\u00e1s una identidad visual a tu medida.'
    },
    {
        section: 'personalizar',
        selector: '#cfg-logo',
        abrirSidebar: false,
        icono: 'fa-image',
        titulo: 'Logo',
        descripcion: 'Sub\u00ed el <strong>logo de tu negocio</strong>: aparece en la parte superior de la vista de tus clientes. Si todav\u00eda no ten\u00e9s logo, pod\u00e9s dejar tu inicial o usar los temas r\u00e1pidos.'
    },
    {
        section: 'personalizar',
        selector: '#cfg-cover',
        abrirSidebar: false,
        icono: 'fa-panorama',
        titulo: 'Portada / Banner',
        descripcion: 'La <strong>imagen de portada</strong> que se muestra arriba de tu perfil (formato panor\u00e1mico). Hace que tu p\u00e1gina se vea m\u00e1s profesional y le da identidad a tu espacio.'
    },
    {
        section: 'personalizar',
        selector: '#cfg-instagram',
        abrirSidebar: false,
        icono: 'fa-share-alt',
        titulo: 'Redes sociales',
        descripcion: 'Peg\u00e1 los enlaces de tu <strong>Instagram y TikTok</strong>: tus clientes los ver\u00e1n en su secci\u00f3n "Mis Reservas" y podr\u00e1n ver tus trabajos y seguirte.'
    },
    {
        section: 'personalizar',
        selector: '.ubicacion-opciones',
        abrirSidebar: false,
        icono: 'fa-map-marker-alt',
        titulo: 'Ubicaci\u00f3n de tu negocio',
        descripcion: 'Eleg\u00ed c\u00f3mo funciona tu negocio: si tus clientes vienen a tu <strong>local</strong>, escrib\u00eds tu direcci\u00f3n y se muestra con un <strong>mapa</strong> y bot\u00f3n "C\u00f3mo llegar"; si <strong>vos</strong> vas al domicilio del cliente, \u00e9l escribe su direcci\u00f3n al reservar y la ves en la cita.'
    },
    {
        section: 'personalizar',
        selector: 'label.directorio-switch:has(#cfg-directorio-activo)',
        abrirSidebar: false,
        icono: 'fa-store',
        titulo: 'Directorio P\u00fablico y rese\u00f1as',
        descripcion: 'Activ\u00e1 esta opci\u00f3n para <strong>aparecer en el Directorio P\u00fablico</strong> de la p\u00e1gina de inicio: nuevos clientes te descubren, ven tus fotos y te dejan <strong>rese\u00f1as</strong> con estrellas y comentarios (vos los moder\u00e1s antes de que se publiquen). Disponible en planes Pro, Premium Anual y Freemium.'
    },
    {
        section: 'personalizar',
        selector: '.config-section.finalizar',
        abrirSidebar: false,
        icono: 'fa-check-circle',
        titulo: 'Finalizar',
        descripcion: 'Cuando est\u00e9s conforme con todo, presion\u00e1 <strong>"Guardar Cambios"</strong> para aplicar. Si te arrepent\u00eds, <strong>"Restablecer Valores"</strong> vuelve a la configuraci\u00f3n original.'
    },
    // ── 10. COMPARTIR CON CLIENTES ────────────────────────────
    {
        section: 'compartir',
        selector: '.sidebar-item[data-section="compartir"]',
        abrirSidebar: true,
        icono: 'fa-share-alt',
        titulo: 'Compartir con Clientes',
        descripcion: 'Ac\u00e1 est\u00e1 el <strong>enlace de tu espacio de clientes</strong>: compartilo por WhatsApp, copi\u00e1 el enlace o gener\u00e1 un <strong>c\u00f3digo QR</strong> para imprimir y poner en tu local. Tus clientes entran, ven tu cat\u00e1logo y reservan solos.'
    },
    // ── 11. MI SUSCRIPCI\u00d3N ──────────────────────────────────
    {
        section: 'suscripcion',
        selector: '.sidebar-item[data-section="suscripcion"]',
        abrirSidebar: true,
        icono: 'fa-crown',
        titulo: 'Mi Suscripci\u00f3n',
        descripcion: 'Ac\u00e1 ves tu <strong>plan actual</strong>, su vigencia y estado. Pod\u00e9s <strong>cambiar de plan</strong> cuando quieras para acceder a m\u00e1s funciones y, si no lo necesit\u00e1s m\u00e1s, <strong>cancelar la suscripci\u00f3n</strong>: tus datos se conservan por si volv\u00e9s despu\u00e9s.'
    },
    // ── CIERRE ────────────────────────────────────────────────
    {
        selector: null,
        abrirSidebar: false,
        icono: 'fa-rocket',
        titulo: '\u00a1Listo!',
        descripcion: 'Ya conoc\u00e9s el panel. Si en alg\u00fan momento te perd\u00e9s, toc\u00e1 <strong>"Ver tutorial"</strong> en el men\u00fa para recorrerlo de nuevo. \u00a1\u00c9xitos con tu negocio! \ud83d\ude80'
    }
];

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
// MODAL DE BIENVENIDA (pregunta inicial)
// ─────────────────────────────────────────────
function mostrarBienvenida() {
    if (welcomeEl) return;
    welcomeEl = document.createElement('div');
    welcomeEl.id = 'tour-welcome-overlay';
    welcomeEl.className = 'tour-overlay';
    welcomeEl.innerHTML = `
        <div class="tour-welcome-card">
            <div class="tour-welcome-icon"><i class="fas fa-graduation-cap"></i></div>
            <h3 class="tour-welcome-title">\u00bfQuer\u00e9s un recorrido r\u00e1pido?</h3>
            <p class="tour-welcome-text">Te mostramos cada secci\u00f3n del panel con una explicaci\u00f3n breve y ejemplos, para que aproveches todo desde el primer d\u00eda. Toma menos de un minuto.</p>
            <div class="tour-welcome-actions">
                <button type="button" class="tour-btn tour-btn-primario" id="tour-welcome-si"><i class="fas fa-play"></i> S\u00ed, comenzar</button>
                <button type="button" class="tour-btn tour-btn-secundario" id="tour-welcome-no">Ahora no</button>
            </div>
        </div>
    `;
    document.body.appendChild(welcomeEl);

    welcomeEl.querySelector('#tour-welcome-si').addEventListener('click', () => {
        localStorage.setItem(STORAGE_PREFIX + tenantId, 'visto');
        cerrarBienvenida();
        iniciarTour();
    });
    welcomeEl.querySelector('#tour-welcome-no').addEventListener('click', () => {
        localStorage.setItem(STORAGE_PREFIX + tenantId, 'omitido');
        cerrarBienvenida();
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

function iniciarTour() {
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
    pasoIdx = -1;
    irAPaso(0);
}

function cerrarTour() {
    if (!tourActivo) return;
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
        // 2b. Pasos de campo (p. ej. dentro de "Datos de Admin"):
        // cerrar el sidebar para que la sección quede visible y el
        // spotlight ilumine el campo real (no el sidebar superpuesto).
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
            cerrarTour();
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
    cardEl.innerHTML = `
        <div class="tour-card-header">
            <span class="tour-icon"><i class="fas ${paso.icono}"></i></span>
            <h4 class="tour-card-title">${paso.titulo}</h4>
            <span class="tour-card-count">${pasoIdx + 1} / ${PASOS.length}</span>
        </div>
        <div class="tour-card-body">${paso.descripcion}</div>
        <div class="tour-card-footer">
            ${pasoIdx > 0 ? '<button type="button" class="tour-btn tour-btn-volver" data-accion="volver"><i class="fas fa-arrow-left"></i> Volver</button>' : ''}
            <span class="tour-card-spacer"></span>
            <button type="button" class="tour-btn tour-btn-secundario" data-accion="omitir">Omitir</button>
            ${pasoIdx < PASOS.length - 1
                ? '<button type="button" class="tour-btn tour-btn-primario" data-accion="siguiente">Siguiente <i class="fas fa-arrow-right"></i></button>'
                : '<button type="button" class="tour-btn tour-btn-primario" data-accion="finalizar"><i class="fas fa-check"></i> Finalizar</button>'}
        </div>
    `;
    cardEl.querySelectorAll('[data-accion]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const accion = btn.dataset.accion;
            if (accion === 'siguiente') siguiente();
            else if (accion === 'volver') volver();
            else if (accion === 'omitir') cerrarTour();
            else if (accion === 'finalizar') {
                cerrarTour();
                const { mostrarToast } = window.__toast || {};
                if (typeof mostrarToast === 'function') mostrarToast('\u00a1Recorrido finalizado! Pod\u00e9s volver a verlo desde el men\u00fa.', 'success');
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
        iniciarTour();
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
