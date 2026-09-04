// ============================================================
// TUTORIAL EN VIDEO — Notificaciones (popover de la campana, admin)
// Botón "Ver tutorial" en el header del popover de notificaciones;
// al presionar play el video se fija en la parte superior (móvil)
// o flota como panel lateral arrastrable (PC) y queda visible
// mientras se revisan y responden las notificaciones.
// Mismo patrón que initTutorialServicio (ServiceForm.js) y
// initTutorialCompartir (ShareTutorial.js).
// El video se sirve desde Supabase Storage (bucket público
// 'tutoriales'). CSP: media-src incluye el origen de Supabase
// (vercel.json + server.py) — sin cambios necesarios.
// ============================================================
const VIDEO_TUTORIAL_NOTIF_URL = 'https://dfcfimipkfhitlsyixqu.supabase.co/storage/v1/object/public/tutoriales/tutorial-notificaciones-hd.mp4?v=2';

// El reproductor dentro del popover debe ser compacto (el popover mide
// 340px × ~60vh). Al quedar FIJO (reparentado a <body>) rigen las reglas
// globales de .tutorial-video-wrap.tutorial-fixed (style.css).
const ESTILOS_NOTIF = `
#notif-popover .tutorial-video-wrap { margin: 8px 12px 10px; }
#notif-popover .tutorial-video-wrap video { max-height: 30vh; }
#notif-popover .tutorial-btn { padding: 6px 12px; font-size: .8rem; }
@media (max-width: 768px) {
    #notif-popover .tutorial-btn { padding: 5px 10px; font-size: .75rem; }
    #notif-popover .tutorial-video-wrap video { max-height: 26vh; }
}
`;

export function initTutorialNotificaciones() {
    const popover = document.getElementById('notif-popover');
    if (!popover) return;
    const header = popover.querySelector('.notif-popover-header');
    if (!header) return;
    const h4 = header.querySelector('h4');
    if (!h4) return;

    // Estilos propios del reproductor dentro del popover (style-src permite
    // 'unsafe-inline' en el CSP del proyecto; id único evita duplicados).
    if (!document.getElementById('tutorial-notif-styles')) {
        const s = document.createElement('style');
        s.id = 'tutorial-notif-styles';
        s.textContent = ESTILOS_NOTIF;
        document.head.appendChild(s);
    }

    // ---- Contenedor del reproductor (dentro del popover, tras el header) ----
    const wrap = document.createElement('div');
    wrap.className = 'tutorial-video-wrap';
    wrap.id = 'tutorial-video-wrap-notif';
    wrap.innerHTML = `
        <div class="tutorial-drag-bar" id="tutorial-drag-bar-notif" title="Arrastra para mover"><i class="fas fa-grip-vertical"></i> <span>Arrastra el video para moverlo</span></div>
        <div class="tutorial-bar">
            <video id="tutorial-video-notif" controls playsinline preload="metadata"></video>
        </div>
        <p class="tutorial-fixed-hint"><i class="fas fa-arrow-down"></i> Usa los botones de aquí abajo — el tutorial sigue arriba</p>
        <button type="button" class="tutorial-close-btn" id="tutorial-close-btn-notif" title="Cerrar tutorial" aria-label="Cerrar tutorial"><i class="fas fa-times"></i></button>
        <button type="button" class="tutorial-zoom-btn" id="tutorial-zoom-btn-notif" title="Agrandar video" aria-label="Agrandar video"><i class="fas fa-expand"></i></button>
        <div class="tutorial-msg" id="tutorial-msg-notif"></div>
    `;
    header.parentNode.insertBefore(wrap, header.nextSibling);

    const video = wrap.querySelector('video');
    const closeBtn = wrap.querySelector('.tutorial-close-btn');
    const zoomBtn = wrap.querySelector('.tutorial-zoom-btn');
    const dragBar = wrap.querySelector('.tutorial-drag-bar');
    const msg = wrap.querySelector('.tutorial-msg');

    // El PiP nativo del navegador queda DETRÁS de la web (no se controla desde
    // la página). Se deshabilita: el modo flotante propio (fijo + agrandar)
    // garantiza que el video SIEMPRE quede por encima al scrollear.
    video.disablePictureInPicture = true;

    // ---- Botón "Ver tutorial" en el header del popover (junto al título) ----
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'btn-ver-tutorial-notif';
    btn.className = 'tutorial-btn';
    btn.innerHTML = '<i class="fas fa-play-circle"></i> Ver tutorial';
    btn.title = 'Ver tutorial de notificaciones';

    // Agrupar h4 + botón a la izquierda (el header es flex space-between y el
    // botón de cerrar × debe seguir pegado a la derecha).
    const grupo = document.createElement('div');
    grupo.style.cssText = 'display:flex;align-items:center;gap:10px;min-width:0;';
    header.insertBefore(grupo, h4);
    grupo.appendChild(h4);
    grupo.appendChild(btn);

    let fijo = false;
    // Posición original del wrap (para restaurarlo al cerrar)
    let wrapParent = null;
    let wrapNext = null;

    function esMovil() {
        return window.matchMedia('(max-width: 768px)').matches;
    }

    // Móvil: al quedar el video fijo arriba, empujar el popover hacia abajo
    // para que las notificaciones (y sus botones) sigan visibles bajo el video.
    // PC: el video flota a un lado (arrastrable) → sin compensación.
    function ajustarEspacioPopover() {
        if (!popover) return;
        if (fijo && esMovil()) {
            const barra = wrap.offsetHeight || 0;
            const topPopover = parseInt(getComputedStyle(popover).top, 10) || 50;
            popover.style.marginTop = (barra + 16) + 'px';
            popover.style.maxHeight = 'calc(100vh - ' + (topPopover + barra + 16 + 8) + 'px)';
        } else {
            popover.style.marginTop = '';
            popover.style.maxHeight = '';
        }
    }

    function abrirTutorial() {
        if (!video.src) video.src = VIDEO_TUTORIAL_NOTIF_URL;
        wrap.classList.add('tutorial-open');
        btn.innerHTML = '<i class="fas fa-times-circle"></i> Cerrar tutorial';
        btn.classList.add('tutorial-btn-activo');
    }

    function cerrarTutorial() {
        video.pause();
        wrap.classList.remove('tutorial-open', 'tutorial-fixed', 'tutorial-zoomed');
        zoomBtn.innerHTML = '<i class="fas fa-expand"></i>';
        zoomBtn.title = 'Agrandar video';
        // Restaurar el wrap a su lugar original (dentro del popover, tras el header)
        if (wrapParent) {
            if (wrapNext) wrapParent.insertBefore(wrap, wrapNext);
            else wrapParent.appendChild(wrap);
            wrapParent = null;
            wrapNext = null;
        }
        fijo = false;
        // Con fijo=false la compensación se limpia (móvil) en vez de re-aplicarse
        ajustarEspacioPopover();
        btn.innerHTML = '<i class="fas fa-play-circle"></i> Ver tutorial';
        btn.classList.remove('tutorial-btn-activo');
    }

    function activarFijo() {
        if (fijo) return;
        fijo = true;
        // ⚠️ .notif-popover tiene backdrop-filter, que crea un containing block
        // y rompe position:fixed → mover el reproductor a <body> mientras esté fijo
        wrapParent = wrap.parentNode;
        wrapNext = wrap.nextSibling;
        document.body.appendChild(wrap);
        wrap.classList.add('tutorial-fixed');
        ajustarEspacioPopover();
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
            if (esMovil()) ajustarEspacioPopover();
            else clampPosicionFlotante();
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

    // Si el popover se oculta (botón ×, toggle de la campana o clic fuera) →
    // cerrar el tutorial: evita audio fantasma de un video fijo con el popover
    // en display:none.
    if (typeof MutationObserver !== 'undefined') {
        const obs = new MutationObserver(() => {
            if (popover.style.display === 'none' || popover.style.display === '') cerrarTutorial();
        });
        obs.observe(popover, { attributes: true, attributeFilter: ['style'] });
    }

    // Al navegar a otra sección del admin → cerrar el tutorial (evita audio
    // fantasma: el clic-fuera legacy solo cierra si display === 'block', pero
    // el popover abre con 'flex', así que la navegación no lo cierra).
    document.addEventListener('click', (e) => {
        const item = e.target.closest('.sidebar-item');
        if (item && item.dataset.section) cerrarTutorial();
    });

    // Recalcular espacio/posición si cambia el tamaño de pantalla (rotación / resize)
    window.addEventListener('resize', () => {
        if (!fijo) return;
        if (esMovil()) ajustarEspacioPopover();
        else clampPosicionFlotante();
    });
}
