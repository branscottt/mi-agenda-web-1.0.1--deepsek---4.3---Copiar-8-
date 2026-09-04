// ============================================================
// TUTORIAL EN VIDEO — sección Mi Equipo (admin)
// Botón "Ver tutorial" junto al título; al presionar play el
// video se fija en la parte superior (móvil) o flota como panel
// lateral arrastrable (PC) y queda visible mientras se scrollea
// y se usan los botones de la sección.
// Mismo patrón que initTutorialServicio (ServiceForm.js),
// initTutorialCompartir (ShareTutorial.js), initTutorialCitas
// (CitasTutorial.js) e initTutorialNotificaciones.
// El video se sirve desde Supabase Storage (bucket público
// 'tutoriales'). CSP: media-src incluye el origen de Supabase
// (vercel.json + server.py).
// Adaptación estructural: #section-equipo es un contenedor
// estático cuyo contenido renderiza WorkersListView.js
// (renderWorkersList) — el h3 es DINÁMICO y TODO el contenido
// se re-renderiza en cada alta/edición/baja. Por eso:
//  - El BOTÓN se re-inyecta junto al h3 tras cada render
//    (MutationObserver sobre #workers-list-container).
//  - El WRAP del reproductor vive anclado en .workers-panel
//    (estático, nunca se borra); pre-play está display:none.
//  - El modal de trabajador (#worker-form-overlay) se empuja
//    hacia abajo en móvil mientras el video está fijo (mismo
//    patrón que el popover de notificaciones).
// ============================================================
const VIDEO_TUTORIAL_EQUIPO_URL = 'https://dfcfimipkfhitlsyixqu.supabase.co/storage/v1/object/public/tutoriales/tutorial-mi-equipo.mp4?v=1';

export function initTutorialEquipo() {
    const section = document.getElementById('section-equipo');
    if (!section) return;
    const panel = section.querySelector('.workers-panel');
    if (!panel) return;
    const container = document.getElementById('workers-list-container');
    if (!container) return;

    // ---- Contenedor del reproductor (ancla estática: .workers-panel) ----
    const wrap = document.createElement('div');
    wrap.className = 'tutorial-video-wrap';
    wrap.id = 'tutorial-video-wrap-equipo';
    wrap.innerHTML = `
        <div class="tutorial-drag-bar" id="tutorial-drag-bar-equipo" title="Arrastra para mover"><i class="fas fa-grip-vertical"></i> <span>Arrastra el video para moverlo</span></div>
        <div class="tutorial-bar">
            <video id="tutorial-video-equipo" controls playsinline preload="metadata"></video>
        </div>
        <p class="tutorial-fixed-hint"><i class="fas fa-arrow-down"></i> Usa los botones de aquí abajo — el tutorial sigue arriba</p>
        <button type="button" class="tutorial-close-btn" id="tutorial-close-btn-equipo" title="Cerrar tutorial" aria-label="Cerrar tutorial"><i class="fas fa-times"></i></button>
        <button type="button" class="tutorial-zoom-btn" id="tutorial-zoom-btn-equipo" title="Agrandar video" aria-label="Agrandar video"><i class="fas fa-expand"></i></button>
        <div class="tutorial-msg" id="tutorial-msg-equipo"></div>
    `;
    panel.appendChild(wrap);

    // ---- Botón "Ver tutorial" (se crea una vez; el observer lo re-inserta) ----
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'btn-ver-tutorial-equipo';
    btn.className = 'tutorial-btn';
    btn.innerHTML = '<i class="fas fa-play-circle"></i> Ver tutorial';

    const video = wrap.querySelector('video');
    const closeBtn = wrap.querySelector('.tutorial-close-btn');
    const zoomBtn = wrap.querySelector('.tutorial-zoom-btn');
    const dragBar = wrap.querySelector('.tutorial-drag-bar');
    const msg = wrap.querySelector('.tutorial-msg');

    // El PiP nativo del navegador queda DETRÁS de la web (no se controla desde
    // la página). Se deshabilita: el modo flotante propio (fijo + agrandar)
    // garantiza que el video SIEMPRE quede por encima al scrollear.
    video.disablePictureInPicture = true;

    let fijo = false;
    // Posición original del wrap (para restaurarlo al cerrar)
    let wrapParent = null;
    let wrapNext = null;

    function esMovil() {
        return window.matchMedia('(max-width: 768px)').matches;
    }

    function abrirTutorial() {
        if (!video.src) video.src = VIDEO_TUTORIAL_EQUIPO_URL;
        wrap.classList.add('tutorial-open');
        btn.innerHTML = '<i class="fas fa-times-circle"></i> Cerrar tutorial';
        btn.classList.add('tutorial-btn-activo');
    }

    function cerrarTutorial() {
        video.pause();
        wrap.classList.remove('tutorial-open', 'tutorial-fixed', 'tutorial-zoomed');
        zoomBtn.innerHTML = '<i class="fas fa-expand"></i>';
        zoomBtn.title = 'Agrandar video';
        // Restaurar el wrap a su lugar original. Si el contenedor se re-renderizó
        // mientras estaba fijo, el padre guardado quedó desconectado → caer al
        // ancla estática (.workers-panel); el observer lo recoloca en el próximo render.
        if (wrapParent && wrapParent.isConnected) {
            if (wrapNext) wrapParent.insertBefore(wrap, wrapNext);
            else wrapParent.appendChild(wrap);
        } else {
            panel.appendChild(wrap);
        }
        wrapParent = null;
        wrapNext = null;
        if (section) section.style.paddingTop = '';
        fijo = false;
        ajustarModal();
        btn.innerHTML = '<i class="fas fa-play-circle"></i> Ver tutorial';
        btn.classList.remove('tutorial-btn-activo');
    }

    function activarFijo() {
        if (fijo) return;
        fijo = true;
        // ⚠️ .glass-panel tiene backdrop-filter, que crea un containing block
        // y rompe position:fixed → mover el reproductor a <body> mientras esté fijo
        wrapParent = wrap.parentNode;
        wrapNext = wrap.nextSibling;
        document.body.appendChild(wrap);
        wrap.classList.add('tutorial-fixed');
        // Móvil: el video queda arriba → dejar espacio bajo él para el contenido.
        // PC: el video flota a un lado (arrastrable) → sin padding, la web se ve completa.
        if (esMovil() && section) {
            section.style.paddingTop = (wrap.offsetHeight + 16) + 'px';
        }
        ajustarModal();
    }

    // Móvil: el modal de trabajador (creado por WorkersListView) se abre a nivel
    // body con z-index 9999, por debajo del video fijo (10000). Empujarlo hacia
    // abajo para que el formulario quede usable bajo el video (patrón popover).
    function ajustarModal() {
        const overlay = document.getElementById('worker-form-overlay');
        if (!overlay) return;
        if (fijo && esMovil()) {
            const barra = wrap.offsetHeight || 0;
            overlay.style.marginTop = (barra + 16) + 'px';
            overlay.style.maxHeight = 'calc(100vh - ' + (barra + 16 + 8) + 'px)';
        } else {
            overlay.style.marginTop = '';
            overlay.style.maxHeight = '';
        }
    }

    // Mantener el video flotante dentro de la pantalla (PC, al arrastrar o agrandar)
    function clampPosicionFlotante() {
        if (!fijo || esMovil()) return;
        if (!wrap.style.left || wrap.style.left === 'auto') return;
        const vw = window.innerWidth, vh = window.innerHeight;
        const w = wrap.offsetWidth, h = wrap.offsetHeight;
        let x = parseInt(wrap.style.left, 10) || 0;
        let y = parseInt(wrap.style.top, 10) || 0;
        x = Math.max(8, Math.min(x, vw - w - 8));
        y = Math.max(8, Math.min(y, vh - h - 8));
        wrap.style.left = x + 'px';
        wrap.style.top = y + 'px';
    }

    // PC: arrastrar el video flotante desde la barra superior (grip)
    if (dragBar) {
        dragBar.addEventListener('pointerdown', (e) => {
            if (!fijo || esMovil()) return;
            e.preventDefault();
            const rect = wrap.getBoundingClientRect();
            const offsetX = e.clientX - rect.left;
            const offsetY = e.clientY - rect.top;
            wrap.style.left = rect.left + 'px';
            wrap.style.top = rect.top + 'px';
            wrap.style.right = 'auto';
            wrap.style.bottom = 'auto';
            wrap.classList.add('tutorial-dragging');
            const mover = (ev) => {
                const vw = window.innerWidth, vh = window.innerHeight;
                const w = wrap.offsetWidth, h = wrap.offsetHeight;
                let x = ev.clientX - offsetX;
                let y = ev.clientY - offsetY;
                x = Math.max(8, Math.min(x, vw - w - 8));
                y = Math.max(8, Math.min(y, vh - h - 8));
                wrap.style.left = x + 'px';
                wrap.style.top = y + 'px';
            };
            const soltar = () => {
                wrap.classList.remove('tutorial-dragging');
                window.removeEventListener('pointermove', mover);
                window.removeEventListener('pointerup', soltar);
            };
            window.addEventListener('pointermove', mover);
            window.addEventListener('pointerup', soltar);
        });
    }

    btn.addEventListener('click', () => {
        if (wrap.classList.contains('tutorial-open')) cerrarTutorial();
        else abrirTutorial();
    });
    closeBtn.addEventListener('click', cerrarTutorial);

    // ⛶ Agrandar/reducir el video flotante (siempre por encima de la web)
    zoomBtn.addEventListener('click', () => {
        const zoomed = wrap.classList.toggle('tutorial-zoomed');
        zoomBtn.innerHTML = zoomed ? '<i class="fas fa-compress"></i>' : '<i class="fas fa-expand"></i>';
        zoomBtn.title = zoomed ? 'Reducir video' : 'Agrandar video';
        if (fijo) {
            // Móvil: recalcular el espacio bajo el video; PC: re-clampar posición si está arrastrado
            if (esMovil()) {
                if (section) section.style.paddingTop = (wrap.offsetHeight + 16) + 'px';
                ajustarModal();
            } else {
                clampPosicionFlotante();
            }
        }
    });

    // Defensa: si algún navegador activa el PiP nativo igualmente (p. ej. Safari
    // con gesto propio), salir del PiP y activar nuestro modo grande — el video
    // flotante propio queda SIEMPRE encima de la web.
    video.addEventListener('enterpictureinpicture', () => {
        if (document.exitPictureInPicture) {
            document.exitPictureInPicture().catch(() => {});
        }
        if (!wrap.classList.contains('tutorial-zoomed')) zoomBtn.click();
    });

    // Al presionar play → el video se fija arriba y queda visible mientras se scrollea
    video.addEventListener('play', activarFijo);

    // Si el video aún no está subido a Supabase → mensaje visible (nada silencioso)
    video.addEventListener('error', () => {
        msg.textContent = '⚠️ Tutorial aún no disponible. Sube el video al bucket "tutoriales" de Supabase (pasos en el chat) y recarga la página.';
        msg.style.display = 'block';
    });
    video.addEventListener('canplay', () => { msg.style.display = 'none'; });

    // Al navegar a otra sección del admin → cerrar el tutorial (evita audio fantasma)
    document.addEventListener('click', (e) => {
        const item = e.target.closest('.sidebar-item');
        if (item && item.dataset.section && item.dataset.section !== 'equipo') {
            cerrarTutorial();
        }
    });

    // Recalcular espacio/posición si cambia el tamaño de pantalla (rotación / resize)
    window.addEventListener('resize', () => {
        if (!fijo) return;
        if (esMovil()) {
            if (section) section.style.paddingTop = (wrap.offsetHeight + 16) + 'px';
            ajustarModal();
        } else {
            clampPosicionFlotante();
        }
    });

    // ─── RE-INYECCIÓN TRAS RE-RENDERS DE WorkersListView ───
    // El contenido de #workers-list-container se re-renderiza completo en cada
    // CRUD (target.innerHTML). Este observer vuelve a colocar el botón junto al
    // h3 (o arriba del glass-panel en estado vacío) y recoloca el wrap en la
    // posición correcta cuando no está fijo. Idempotente: no muta si ya está bien.
    function reinyectar() {
        const h3 = container.querySelector('.glass-panel h3');
        if (h3) {
            // Estado lista: [h3 + botón] en grupo flex dentro de la fila del header
            if (!btn.isConnected) {
                const headerRow = h3.parentNode;
                const grupo = document.createElement('div');
                grupo.style.cssText = 'display:flex;align-items:center;gap:10px;min-width:0;';
                headerRow.insertBefore(grupo, h3);
                grupo.appendChild(h3);
                grupo.appendChild(btn);
            }
            // Wrap: tras la fila del header, dentro del glass-panel.
            // ⚠️ NO comparar nextSibling contra headerRow.nextSibling: al insertar
            // el wrap justo después de la fila, el nextSibling cambia y la condición
            // nunca se estabiliza → loop infinito del observer (página congelada).
            // Comparar solo parentNode es estable.
            if (!wrap.classList.contains('tutorial-fixed')) {
                const fila = h3.parentNode.parentNode;   // fila flex (grupo > h3 > fila)
                const glassPanel = fila.parentNode;
                if (wrap.parentNode !== glassPanel) {
                    glassPanel.insertBefore(wrap, fila.nextSibling);
                }
            }
        } else {
            // Estado vacío: botón arriba del glass-panel, wrap al final
            const glassPanel = container.querySelector('.glass-panel');
            if (!glassPanel) return;
            if (!btn.isConnected) {
                const fila = document.createElement('div');
                fila.style.cssText = 'display:flex;margin-bottom:14px;';
                fila.appendChild(btn);
                glassPanel.insertBefore(fila, glassPanel.firstChild);
            }
            if (!wrap.classList.contains('tutorial-fixed') && wrap.parentNode !== glassPanel) {
                glassPanel.appendChild(wrap);
            }
        }
    }

    const observer = new MutationObserver(reinyectar);
    observer.observe(container, { childList: true, subtree: true });

    // Si el modal de trabajador se abre mientras el video está fijo → ajustarlo
    const observerModal = new MutationObserver(() => ajustarModal());
    observerModal.observe(document.body, { childList: true });

    // Primer render (si el container ya tiene contenido al cargar la página)
    reinyectar();
}
