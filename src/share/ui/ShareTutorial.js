// ============================================================
// TUTORIAL EN VIDEO — sección Compartir con Clientes (admin)
// Botón "Ver tutorial" junto al título; al presionar play el
// video se fija en la parte superior (móvil) o flota como panel
// lateral arrastrable (PC) y queda visible mientras se scrollea
// y se usan los botones de la sección.
// Mismo patrón que initTutorialServicio (ServiceForm.js).
// El video se sirve desde Supabase Storage (bucket público
// 'tutoriales'). CSP: media-src incluye el origen de Supabase
// (vercel.json + server.py).
// ============================================================
const VIDEO_TUTORIAL_SHARE_URL = 'https://dfcfimipkfhitlsyixqu.supabase.co/storage/v1/object/public/tutoriales/tutorial-compartir-clientes.mp4?v=1';

export function initTutorialCompartir() {
    const section = document.getElementById('section-compartir');
    if (!section) return;
    const header = section.querySelector('.glass-panel h3');
    if (!header) return;

    // ---- Contenedor del reproductor (entre el título y el contenido) ----
    const wrap = document.createElement('div');
    wrap.className = 'tutorial-video-wrap';
    wrap.id = 'tutorial-video-wrap-share';
    wrap.innerHTML = `
        <div class="tutorial-drag-bar" id="tutorial-drag-bar-share" title="Arrastrá para mover"><i class="fas fa-grip-vertical"></i> <span>Arrastrá el video para moverlo</span></div>
        <div class="tutorial-bar">
            <video id="tutorial-video-share" controls playsinline preload="metadata"></video>
        </div>
        <p class="tutorial-fixed-hint"><i class="fas fa-arrow-down"></i> Usá los botones de acá abajo — el tutorial sigue arriba</p>
        <button type="button" class="tutorial-close-btn" id="tutorial-close-btn-share" title="Cerrar tutorial" aria-label="Cerrar tutorial"><i class="fas fa-times"></i></button>
        <button type="button" class="tutorial-zoom-btn" id="tutorial-zoom-btn-share" title="Agrandar video" aria-label="Agrandar video"><i class="fas fa-expand"></i></button>
        <div class="tutorial-msg" id="tutorial-msg-share"></div>
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

    // ---- Botón "Ver tutorial" junto al título (wrapper flex) ----
    const headerFlex = document.createElement('div');
    headerFlex.className = 'section-header-flex';
    header.parentNode.insertBefore(headerFlex, header);
    headerFlex.appendChild(header);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'btn-ver-tutorial-share';
    btn.className = 'tutorial-btn';
    btn.innerHTML = '<i class="fas fa-play-circle"></i> Ver tutorial';
    headerFlex.appendChild(btn);

    let fijo = false;
    // Posición original del wrap (para restaurarlo al cerrar)
    let wrapParent = null;
    let wrapNext = null;

    function abrirTutorial() {
        if (!video.src) video.src = VIDEO_TUTORIAL_SHARE_URL;
        wrap.classList.add('tutorial-open');
        btn.innerHTML = '<i class="fas fa-times-circle"></i> Cerrar tutorial';
        btn.classList.add('tutorial-btn-activo');
    }

    function cerrarTutorial() {
        video.pause();
        wrap.classList.remove('tutorial-open', 'tutorial-fixed', 'tutorial-zoomed');
        zoomBtn.innerHTML = '<i class="fas fa-expand"></i>';
        zoomBtn.title = 'Agrandar video';
        // Restaurar el wrap a su lugar original (entre el título y el contenido)
        if (wrapParent) {
            if (wrapNext) wrapParent.insertBefore(wrap, wrapNext);
            else wrapParent.appendChild(wrap);
            wrapParent = null;
            wrapNext = null;
        }
        if (section) section.style.paddingTop = '';
        fijo = false;
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
    }

    function esMovil() {
        return window.matchMedia('(max-width: 768px)').matches;
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
        msg.textContent = '⚠️ Tutorial aún no disponible. Subí el video al bucket "tutoriales" de Supabase (pasos en el chat) y recargá la página.';
        msg.style.display = 'block';
    });
    video.addEventListener('canplay', () => { msg.style.display = 'none'; });

    // Al navegar a otra sección del admin → cerrar el tutorial (evita audio fantasma)
    document.addEventListener('click', (e) => {
        const item = e.target.closest('.sidebar-item');
        if (item && item.dataset.section && item.dataset.section !== 'compartir') {
            cerrarTutorial();
        }
    });

    // Recalcular espacio/posición si cambia el tamaño de pantalla (rotación / resize)
    window.addEventListener('resize', () => {
        if (!fijo) return;
        if (esMovil()) {
            if (section) section.style.paddingTop = (wrap.offsetHeight + 16) + 'px';
        } else {
            clampPosicionFlotante();
        }
    });
}
