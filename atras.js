/* atras.js — Botón "atrás" del celular en TODA la web (móvil y tablet).
 *
 * EL PROBLEMA
 * En el móvil/tablet, apretar el botón físico (o el gesto) de "atrás" con un
 * popup, un modal, el menú lateral o una sección interna abierta sacaba de la
 * página: se perdía lo que el usuario estaba haciendo. Lo esperado (como en
 * WhatsApp) es que "atrás" deshaga UN paso: modal → sección anterior → menú
 * cerrado → recién ahí se sale de la página.
 *
 * CÓMO
 * Cada estado "navegable" se registra como una CAPA con su forma natural de
 * cerrarse. Al abrirse se hace pushState con la profundidad. Cuando el
 * navegador dispara "atrás", el popstate trae la profundidad de destino y se
 * cierran (de arriba hacia abajo) las capas que quedaron por encima, cada una
 * con su cierre natural. Si no hay capas, el atrás es el del navegador.
 *
 * REGLA: la UI nunca cierra "a mano" una capa que está en el historial: llama
 * a Atras.consumir(id) DESPUÉS de cerrarla visualmente. Así no quedan entradas
 * huérfanas (atrás "mudo" o que salta dos pasos). Es el mismo patrón que usan
 * ventas-live (vlAtras.js) y el tablero de Mis Clientes (ClientBoard.js).
 *
 * CAPAS AUTOMÁTICAS
 * Además de las capas explícitas (secciones, tablero), un observador detecta
 * los modales/popups/overlays que ya existen en la app (por clase) y los
 * registra solo. Para cerrarlos usa su propio botón de cerrar/cancelar (así
 * se ejecuta la limpieza real de cada pantalla). Si el cierre abre una
 * confirmación ("¿descartar cambios?"), la capa se mantiene: nunca se
 * descartan datos por un "atrás" accidental.
 *
 * ⚠️ CARRERA DEL HISTORIAL
 * history.go(-n) es ASÍNCRONO: mientras hay una travesía propia en vuelo, los
 * pushState se encolan y al aterrizar el historial se re-sincroniza. Así el
 * atrás del usuario nunca se traga ni cierra de más.
 */
(function () {
    'use strict';
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if (window.Atras) return;

    const capas = [];          // [{ id, cerrar }] — la última es la de más arriba
    let instalado = false;
    let enPop = false;         // estamos cerrando por un popstate (no re-consumir)
    let goEnVuelo = 0;         // travesías propias (history.go) que aún no aterrizan
    const pushEnEspera = [];   // profundidades a empujar cuando aterrice la travesía
    let timerGo = null;

    // Sello de ESTA carga de la página: una entrada vieja (recarga, bfcache)
    // no debe confundirse con una capa de esta sesión.
    const SESION = 'ma' + Math.random().toString(36).slice(2) + Date.now().toString(36);

    function instalar() {
        if (instalado) return;
        instalado = true;
        window.addEventListener('popstate', alAtras);
    }

    function profundidad() { return capas.length; }

    function pushEstado(n) {
        try { history.pushState({ maCapa: n, maSesion: SESION }, ''); } catch (_) { /* sin historial */ }
    }

    function replaceEstado(n) {
        try {
            if (n > 0) history.replaceState({ maCapa: n, maSesion: SESION }, '');
            else history.replaceState(null, '');
        } catch (_) { /* sin historial */ }
    }

    function alAtras(e) {
        // Travesía pedida por NOSOTROS (consumir): no cierra nada; deja el
        // historial coherente con la pila real y empuja lo que quedó en cola.
        if (goEnVuelo > 0) {
            goEnVuelo--;
            if (goEnVuelo === 0) sincronizarHistorico();
            return;
        }
        if (!capas.length) return;                    // nada nuestro: navegación normal

        const st = e && e.state;
        // Estado ajeno (otro componente con su propio pushState, ej. el
        // tablero): no tocamos nuestras capas; su dueño decide. El estado
        // null es la entrada base de la página: sí es nuestra.
        const ajena = !!st && typeof st === 'object' &&
            !(st.maSesion === SESION && typeof st.maCapa === 'number');
        if (ajena) return;

        const destino = (st && typeof st.maCapa === 'number') ? Math.max(0, st.maCapa) : 0;
        if (capas.length <= destino) return;          // volvimos a una capa abierta

        enPop = true;
        try {
            while (capas.length > destino) {
                const capa = capas[capas.length - 1];
                let cerro = true;
                try {
                    cerro = capa.cerrar() !== false;
                } catch (err) {
                    console.error('[Atras] no se pudo cerrar la capa', capa.id, err);
                }
                if (!cerro) {
                    // El cierre se canceló (confirmación de cambios, animación
                    // en curso): se devuelve la entrada para el próximo atrás.
                    empujar(profundidad());
                    return;
                }
                capas.pop();
            }
        } finally {
            enPop = false;
        }
        procesarPendientes();
    }

    /**
     * Deja el historial igual a la pila: la entrada donde aterrizó la travesía
     * representa el fondo, y encima se empujan las capas abiertas mientras el
     * go() estaba en vuelo.
     */
    function sincronizarHistorico() {
        const pend = pushEnEspera.splice(0);
        replaceEstado(Math.max(0, capas.length - pend.length));
        pend.forEach((n) => pushEstado(n));
        procesarPendientes();
    }

    function empujar(n) {
        if (goEnVuelo > 0) { pushEnEspera.push(n); return; }
        pushEstado(n);
    }

    /**
     * Registra una capa y deja una entrada propia en el historial.
     * @param {string} id     identificador único ('vista:citas', 'board', …)
     * @param {Function} cerrar  cierre natural; devolver false = no se cerró
     * @returns {boolean} true si se registró (false si ya estaba)
     */
    function abrir(id, cerrar) {
        instalar();
        if (capas.some((c) => c.id === id)) return false;
        capas.push({ id, cerrar });
        empujar(profundidad());
        return true;
    }

    function indice(id) {
        for (let i = 0; i < capas.length; i++) {
            if (capas[i].id === id) return i;
        }
        return -1;
    }

    function hay(id) { return indice(id) >= 0; }

    function irAtras(n) {
        goEnVuelo++;
        try {
            history.go(-n);
        } catch (_) {
            goEnVuelo = Math.max(0, goEnVuelo - 1);
            sincronizarHistorico();
            return false;
        }
        // Red de seguridad: si el popstate no llega (navegador raro), el
        // historial se re-sincroniza igual en vez de quedar bloqueado.
        if (timerGo) clearTimeout(timerGo);
        timerGo = setTimeout(() => {
            if (goEnVuelo > 0) { goEnVuelo = 0; sincronizarHistorico(); }
        }, 900);
        return true;
    }

    /**
     * Consume la entrada de historial de una capa (y las que estén por encima)
     * DESPUÉS de haberla cerrado visualmente. Se usa desde los botones/gestos
     * propios (X, ←, Cancelar, Escape) para que el próximo atrás no quede mudo.
     */
    function consumir(id) {
        if (enPop) return false;                   // ya venimos de un atrás
        const i = indice(id);
        if (i < 0) return false;
        const n = capas.length - i;                // esta capa + las de arriba
        capas.length = i;
        return irAtras(n);
    }

    /**
     * Capa de "vista/sección" (dashboard, citas, clientes…). No apila si ya es
     * la de arriba ni durante un popstate (el cierre ya está navegando).
     */
    function vista(id, cerrar) {
        if (enPop) return false;
        const lid = 'vista:' + id;
        const top = capas[capas.length - 1];
        if (top && top.id === lid) { top.cerrar = cerrar; return false; }
        return abrir(lid, cerrar);
    }

    /* ───────────────────────── Capas automáticas ───────────────────────── */

    // Overlays reales de la app. Se EXCLUYEN a propósito:
    //  - .kanban-modal-overlay (el tablero tiene su propia capa explícita)
    //  - .tour-overlay (tour guiado con su propio flujo)
    //  - #whatsapp-modal (completar WhatsApp es obligatorio)
    const SELECTOR = [
        '.modal-overlay',
        '.modal',
        '.cv-modal-overlay',
        '.preview-modal-overlay',
        '.hub-modal-overlay',
        '.directorio-modal-overlay',
        '.uso-overlay',
        '.cfg-vitrina-overlay',
        '.cfgmo-overlay',
        '.pcc-overlay',
        '.mfa-overlay',
        '.invcl-overlay',
        '.mcguia-overlay',
        '.sw-overlay',
        '.kanban-card-overlay',
        '.popup-reserva',
        '#notif-popover',
        '.sidebar-nav.open'
    ].join(',');

    const BOTON_CERRAR = [
        '[data-cv-accion="cerrar"]',
        '[data-ws-accion="cerrar"]',
        '.popup-close',
        '.modal-close',
        '.preview-modal-close',
        '.cv-modal-x',
        '.kanban-btn-close',
        '.directorio-modal-close',
        '.notif-popover-close',
        '.btn-cerrar-resumen',
        '.sidebar-close',
        '#popup-cerrar',
        '#close-servicio-detalle',
        '#close-servicio-cliente',
        '#hub-modal-cancel',
        '#cancel-sub-modal',
        '#cancel-modal',
        '#pd-cerrar'
    ].join(',');

    const TEXTO_CERRAR = /^(cancelar|cerrar|volver|atr[aá]s|ahora no|m[aá]s tarde|omitir)$/i;

    const autoReg = new Map();  // id -> { el, capaId, registrada }
    let autoSeq = 0;
    let escaneando = false;
    let timerScan = null;
    const pendientes = new Set(); // capas auto ocultas que aún no son la de arriba

    function visible(el) {
        if (!el || !el.isConnected) return false;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        // Fuera de pantalla (menú móvil cerrado, cajones off-canvas) no cuenta.
        return r.width > 2 && r.height > 2 && r.right > 0 && r.left < window.innerWidth &&
            r.bottom > 0 && r.top < window.innerHeight;
    }

    function contarOverlaysVisibles() {
        let n = 0;
        document.querySelectorAll(SELECTOR).forEach((el) => { if (visible(el)) n++; });
        return n;
    }

    function idDe(el) {
        if (!el.dataset.maAtras) el.dataset.maAtras = 'a' + (++autoSeq);
        return el.dataset.maAtras;
    }

    function buscarCerrar(el) {
        let btn = null;
        try { btn = el.querySelector(BOTON_CERRAR); } catch (_) { btn = null; }
        if (btn) return btn;
        // Botón de texto (Cancelar / Cerrar / Volver…) o X con aria-label.
        const cands = el.querySelectorAll('button, a, [role="button"]');
        for (let i = 0; i < cands.length; i++) {
            const c = cands[i];
            const txt = (c.textContent || '').trim();
            const aria = (c.getAttribute('aria-label') || '').trim();
            if (TEXTO_CERRAR.test(txt) || /^(cerrar|close)$/i.test(aria)) return c;
            if ((txt === '×' || txt === '✕') && c.offsetParent !== null) return c;
        }
        return null;
    }

    function ocultar(el) {
        try { el.style.display = 'none'; } catch (_) { /* nada */ }
        el.classList.remove('visible', 'open', 'show', 'active');
        if (el.id === 'popup-reserva' && typeof window.cerrarPopupReserva === 'function') {
            try { window.cerrarPopupReserva(); } catch (_) { /* nada */ }
        }
        if (document.body && document.body.style.overflow === 'hidden') {
            document.body.style.overflow = '';
        }
    }

    /**
     * Cierre natural de un overlay detectado: usa su propio botón (ejecuta la
     * limpieza real de la pantalla). Si el botón no cierra en el acto puede
     * ser una confirmación de datos: se devuelve false y la capa se conserva.
     */
    function cerrarElemento(el) {
        if (!visible(el)) return true;
        const btn = buscarCerrar(el);
        if (!btn) { ocultar(el); return !visible(el); }
        const antes = contarOverlaysVisibles();
        try { btn.click(); } catch (_) { /* nada */ }
        if (!visible(el)) return true;
        // Si al pulsar cerrar apareció OTRA capa (confirmación "¿descartar
        // cambios?"), se conserva todo: decide el usuario, no el atrás.
        if (contarOverlaysVisibles() > antes) return false;
        // El botón no tenía handler (plan/flujo que no lo conectó): se cierra
        // igual, porque no hay nada que confirmar ni guardar.
        ocultar(el);
        return !visible(el);
    }

    function consumirAuto(capaId) {
        if (enPop) return;
        const i = indice(capaId);
        if (i < 0) return;
        if (i !== capas.length - 1) { pendientes.add(capaId); return; }
        consumir(capaId);
    }

    function procesarPendientes() {
        if (enPop || goEnVuelo > 0) return;
        // Limpiar pendientes de capas que ya no existen.
        pendientes.forEach((id) => { if (indice(id) < 0) pendientes.delete(id); });
        const top = capas[capas.length - 1];
        if (top && pendientes.has(top.id)) {
            pendientes.delete(top.id);
            consumir(top.id);
        }
    }

    function escanear() {
        if (escaneando) return;
        escaneando = true;
        try {
            // 1) Capas auto que se cerraron por su propio botón/gesto.
            autoReg.forEach((rec) => {
                if (rec.registrada && !visible(rec.el)) {
                    rec.registrada = false;
                    consumirAuto(rec.capaId);
                }
            });
            // 2) Overlays visibles que aún no tienen capa.
            const els = document.querySelectorAll(SELECTOR);
            for (let i = 0; i < els.length; i++) {
                const el = els[i];
                if (!visible(el)) continue;
                const id = idDe(el);
                let rec = autoReg.get(id);
                if (!rec) {
                    rec = { el, capaId: 'auto:' + id, registrada: false };
                    autoReg.set(id, rec);
                }
                if (!rec.registrada) {
                    rec.registrada = true;
                    abrir(rec.capaId, () => cerrarElemento(el));
                }
            }
        } finally {
            escaneando = false;
        }
    }

    function agendarEscaneo() {
        if (timerScan) return;
        timerScan = setTimeout(() => { timerScan = null; escanear(); }, 160);
    }

    function vigilar() {
        escanear();
        if (window.MutationObserver) {
            try {
                new MutationObserver(agendarEscaneo).observe(document.documentElement, {
                    subtree: true,
                    childList: true,
                    attributes: true,
                    attributeFilter: ['style', 'class', 'hidden']
                });
            } catch (_) { /* sin observer */ }
        }
        // Volver desde bfcache (Safari iOS) no dispara load: re-escaneamos.
        window.addEventListener('pageshow', agendarEscaneo);
        window.addEventListener('focus', agendarEscaneo);
    }

    /* ───────────────────────────── API pública ───────────────────────────── */

    const API = {
        abrir,
        consumir,
        hay,
        vista,
        pila: () => capas.map((c) => c.id),
        goEnVuelo: () => goEnVuelo,
        sesion: () => SESION,
        escanear
    };

    window.Atras = API;
    // Puente de diagnóstico NO enumerable (misma convención que __vlCapas).
    try {
        Object.defineProperty(window, '__maAtras', {
            value: { pila: API.pila, goEnVuelo: API.goEnVuelo, sesion: API.sesion },
            enumerable: false,
            configurable: true
        });
    } catch (_) { /* sin window */ }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', vigilar, { once: true });
    } else {
        vigilar();
    }
})();
