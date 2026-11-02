// avisos-push.js — AVISOS AL PC / MÓVIL / TABLET (Web Push, gratis)
// ---------------------------------------------------------------------------
// Se carga como archivo suelto (NO se bundlea): <script defer src="/avisos-push.js?v=N">
//   * Añade a la campana del panel una tarjeta "Avisos al teléfono / PC" con
//     Activar / Desactivar / Probar.
//   * Registra el dispositivo (service worker + pushManager + VAPID) y guarda la
//     suscripción con la RPC avisos_guardar_sub.
//   * Re-registro SILENCIOSO al abrir el panel si ya estaba activado.
//   * Mientras la web está abierta muestra el aviso del navegador en primer plano
//     (Notification) para los avisos nuevos, sin depender de la campana.
//   * Si el dispositivo no tiene avisos, el correo de la cuenta recibe el aviso
//     (eso lo hace la Edge Function avisos-push).
//
// La clave pública VAPID es pública por diseño; la privada vive en los secrets.
// Al editar este archivo: subir ?v=N en los HTML que lo cargan.

(function () {
    'use strict';

    var VAPID_PUBLIC_KEY = 'BDPgk-hicFx7kZGvZK2cYvnV8azivt991eLtIJJXG7_MVxYtPMFEtKg7hK-e2IOjNEn2trqnSjgx7iBwCxob_0A';
    var FUNCION_AVISOS = 'https://dfcfimipkfhitlsyixqu.supabase.co/functions/v1/avisos-push';
    var SUPABASE_URL = 'https://dfcfimipkfhitlsyixqu.supabase.co';
    var SUPABASE_ANON_PLACEHOLDER = 'eyJhbG...Ccw0';

    var LS_VISTOS = 'agendapro_avisos_vistos';
    var LS_OFF = 'agendapro_avisos_apagado';   // apagado explícito en ESTE dispositivo
    var POLL_MS = 25000;
    var _pollId = null;
    var _estado = { permiso: '', suscrito: false, dispositivos: 0, email: '' };

    // ── Utilidades ──────────────────────────────────────────────────────────
    function base64ToUint8(base64) {
        var padding = '='.repeat((4 - base64.length % 4) % 4);
        var b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
        var raw = atob(b64);
        var out = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
    }

    function esIOS() {
        return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }

    function esStandalone() {
        return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
            window.navigator.standalone === true;
    }

    function token() {
        try {
            var t = localStorage.getItem('agendapro_access_token');
            if (t) return t;
            if (window.JwtManager && typeof window.JwtManager.getAccessToken === 'function') {
                return window.JwtManager.getAccessToken() || '';
            }
        } catch (e) { /* noop */ }
        return '';
    }

    function anonKey() {
        try {
            if (window.supabaseClient && window.supabaseClient.supabaseKey) return window.supabaseClient.supabaseKey;
            if (window.__APP_CONFIG && window.__APP_CONFIG.supabaseKey) return window.__APP_CONFIG.supabaseKey;
            if (window.supabaseClient && window.supabaseClient.rest && window.supabaseClient.rest.headers) {
                var h = window.supabaseClient.rest.headers;
                if (h.apikey) return h.apikey;
            }
        } catch (e) { /* noop */ }
        return SUPABASE_ANON_PLACEHOLDER;
    }

    /** Llama una RPC con el cliente de Supabase (si está) o con el token del usuario. */
    function rpcRest(nombre, args) {
        var url = SUPABASE_URL + '/rest/v1/rpc/' + nombre;
        return fetch(url, {
            method: 'POST',
            headers: {
                'apikey': anonKey(),
                'Authorization': 'Bearer ' + (token() || anonKey()),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(args || {})
        }).then(function (r) {
            if (!r.ok) return null;
            return r.json().catch(function () { return null; });
        }).catch(function () { return null; });
    }

    function rpc(nombre, args) {
        var c = window.supabaseClient;
        if (c && typeof c.rpc === 'function') {
            return Promise.resolve(c.rpc(nombre, args || {}))
                .then(function (res) {
                    if (res && !res.error) return res.data;
                    return rpcRest(nombre, args);   // sin sesión en el cliente → token explícito
                })
                .catch(function () { return rpcRest(nombre, args); });
        }
        return rpcRest(nombre, args);
    }

    function swRegistro() {
        if (!('serviceWorker' in navigator)) return Promise.resolve(null);
        return navigator.serviceWorker.getRegistration('/').then(function (reg) {
            if (reg) return reg;
            return navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () { return null; });
        }).catch(function () { return null; });
    }

    function suscripcionActual() {
        return swRegistro().then(function (reg) {
            if (!reg || !reg.pushManager) return null;
            return reg.pushManager.getSubscription().catch(function () { return null; });
        });
    }

    /** Crea/actualiza la suscripción del dispositivo y la guarda en la base. */
    function activar() {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            return Promise.resolve({ ok: false, error: 'Este navegador no soporta avisos con la web cerrada' });
        }
        return Notification.requestPermission().then(function (perm) {
            if (perm !== 'granted') {
                return { ok: false, error: perm === 'denied'
                    ? 'El navegador bloqueó los avisos. Actívalos en el candado de la barra de direcciones.'
                    : 'No diste permiso para los avisos' };
            }
            return swRegistro().then(function (reg) {
                if (!reg || !reg.pushManager) return { ok: false, error: 'El service worker no está listo (recarga la página)' };
                return reg.pushManager.getSubscription().then(function (sub) {
                    if (sub) return sub;
                    return reg.pushManager.subscribe({
                        userVisibleOnly: true,
                        applicationServerKey: base64ToUint8(VAPID_PUBLIC_KEY)
                    });
                }).then(function (sub) {
                    var j = sub && sub.toJSON ? sub.toJSON() : null;
                    if (!j || !j.endpoint || !j.keys) return { ok: false, error: 'El navegador no devolvió la suscripción' };
                    return rpc('avisos_guardar_sub', {
                        p_endpoint: j.endpoint,
                        p_p256dh: j.keys.p256dh,
                        p_auth: j.keys.auth,
                        p_agente: navigator.userAgent.slice(0, 180)
                    }).then(function (r) {
                        if (!r || r.ok !== true) return { ok: false, error: (r && r.error) || 'No se pudo guardar en tu cuenta' };
                        try { localStorage.removeItem(LS_OFF); } catch (e) { /* noop */ }
                        return { ok: true, dispositivos: r.dispositivos };
                    });
                });
            });
        }).catch(function (e) {
            return { ok: false, error: (e && e.message) || 'No se pudo activar' };
        });
    }

    /** Apaga los avisos en este dispositivo. */
    function desactivar() {
        return suscripcionActual().then(function (sub) {
            if (!sub) return { ok: true, dispositivos: 0 };
            var endpoint = sub.endpoint;
            return rpc('avisos_borrar_sub', { p_endpoint: endpoint }).then(function () {
                return sub.unsubscribe().catch(function () { /* noop */ });
            }).then(function () {
                try { localStorage.setItem(LS_OFF, '1'); } catch (e) { /* noop */ }
                return rpc('avisos_estado').then(function (r) {
                    return { ok: true, dispositivos: (r && r.dispositivos) || 0 };
                });
            });
        });
    }

    /** Botón "Probar": manda un push real a los dispositivos del espacio. */
    function probar() {
        var t = token();
        if (!t) return Promise.resolve({ ok: false, error: 'Sesión no encontrada (recarga el panel)' });
        return fetch(FUNCION_AVISOS, {
            method: 'POST',
            headers: {
                'apikey': anonKey(),
                'Authorization': 'Bearer ' + t,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ accion: 'prueba', titulo: 'Aviso de prueba 🔔', cuerpo: 'Si ves esto, los avisos funcionan (aunque tengas la web cerrada).' })
        }).then(function (r) { return r.json().catch(function () { return {}; }); })
            .then(function (j) {
                if (!j || j.ok !== true) return { ok: false, error: (j && j.error) || 'No autorizado' };
                if (j.enviados > 0) return { ok: true, texto: 'Enviado a ' + j.enviados + ' dispositivo(s)' };
                if (j.suscripciones > 0) return { ok: false, error: 'Hay ' + j.suscripciones + ' dispositivo(s) pero el envío falló' };
                // Aviso informativo (no es un error rojo: todavía no activaste ningún dispositivo).
                return { ok: false, info: true, error: 'Todavía no hay ningún dispositivo con avisos activados: activalos acá arriba.' };
            }).catch(function () { return { ok: false, error: 'No se pudo contactar el servidor de avisos' }; });
    }

    // ── Tarjeta en la campana del panel ─────────────────────────────────────
    function inyectarEstilos() {
        if (document.getElementById('avisos-push-css')) return;
        var css = document.createElement('style');
        css.id = 'avisos-push-css';
        css.textContent = [
            // Chip junto a la campana (o flotante si no hay campana)
            '.avisos-push-slot{position:relative;display:inline-flex;align-items:center}',
            '.avisos-push-chip{display:inline-flex;align-items:center;gap:7px;height:38px;padding:0 13px;border-radius:999px;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.12);color:#f3eaff;font-family:inherit;font-size:12.5px;font-weight:700;cursor:pointer;line-height:1;backdrop-filter:blur(4px);transition:box-shadow .15s,background .15s,border-color .15s,color .15s}',
            '.avisos-push-chip:hover{background:rgba(255,255,255,.22);border-color:rgba(255,255,255,.42)}',
            '.avisos-push-chip.on{background:rgba(18,183,106,.18);border-color:rgba(18,183,106,.45);color:#c9f7dd}',
            '.avisos-push-chip .avisos-push-dot{width:8px;height:8px;border-radius:50%;background:#c4b5fd;display:inline-block}',
            '.avisos-push-chip.on .avisos-push-dot{background:#12b76a;box-shadow:0 0 0 3px rgba(18,183,106,.16)}',
            '.avisos-push-fixed{position:fixed;top:66px;right:12px;z-index:2400}',
            // Tarjeta
            '.avisos-push-card{position:absolute;top:calc(100% + 10px);right:0;width:min(330px,calc(100vw - 24px));padding:13px 14px;border-radius:16px;background:#fff;border:1px solid #ece7f7;box-shadow:0 18px 44px rgba(31,27,45,.18);z-index:2401;display:none}',
            '.avisos-push-card.abierta{display:block}',
            '.avisos-push-head{display:flex;align-items:center;gap:8px;font-weight:700;font-size:13.5px;color:#3b3355}',
            '.avisos-push-head i{color:#7c3aed}',
            '.avisos-push-estado{margin-left:auto;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:#eef0f4;color:#5b6472;white-space:nowrap}',
            '.avisos-push-estado.on{background:#e7f7ee;color:#127a45}',
            '.avisos-push-txt{margin:8px 0 0;font-size:12.5px;line-height:1.5;color:#5b6472}',
            '.avisos-push-acc{display:flex;gap:8px;margin-top:11px;flex-wrap:wrap}',
            '.avisos-push-btn{flex:1 1 auto;min-height:38px;padding:0 14px;border-radius:10px;border:1px solid #d8dbe2;background:#fff;color:#3b3355;font-family:inherit;font-size:12.5px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;transition:background .15s,border-color .15s,box-shadow .15s}',
            '.avisos-push-btn:hover{background:#f5f6f8;border-color:#c7ccd6}',
            '.avisos-push-btn.pr{background:linear-gradient(135deg,#7c3aed,#a855f7);border:0;color:#fff;box-shadow:0 4px 12px rgba(124,58,237,.28)}',
            '.avisos-push-btn.pr:hover{filter:brightness(1.05);background:linear-gradient(135deg,#7c3aed,#a855f7)}',
            '.avisos-push-btn.off{background:#fff;border-color:#e3b8b8;color:#b42318}',
            '.avisos-push-btn[disabled]{opacity:.6;cursor:progress}',
            '.avisos-push-nota{margin:9px 0 0;font-size:11.5px;line-height:1.45;color:#7b8494}',
            '.avisos-push-nota.bien{color:#127a45}',
            '.avisos-push-nota.mal{color:#b42318}',
            '@media(max-width:600px){.avisos-push-chip{height:36px;padding:0 11px;font-size:12px}.avisos-push-chip .avisos-push-lbl{display:none}.avisos-push-card{width:min(300px,calc(100vw - 20px))}}'
        ].join('\n');
        document.head.appendChild(css);
    }

    function pintar() {
        var estadoEl = document.getElementById('avisos-push-estado');
        var btn = document.getElementById('avisos-push-toggle');
        var chip = document.getElementById('avisos-push-chip');
        var nota = document.getElementById('avisos-push-nota');
        if (!btn) return;

        var activo = !!_estado.suscrito && _estado.permiso === 'granted';

        if (chip) {
            chip.className = 'avisos-push-chip' + (activo ? ' on' : '');
            var lbl = chip.querySelector('.avisos-push-lbl');
            if (lbl) lbl.textContent = activo ? 'Avisos activos' : 'Activar avisos';
            chip.title = activo
                ? 'Avisos activados en este dispositivo (reservas y Ventas Live)'
                : 'Recibir reservas y Ventas Live en este dispositivo';
        }
        if (estadoEl) {
            estadoEl.textContent = activo ? 'Activados' : (_estado.dispositivos > 0 ? _estado.dispositivos + ' dispositivo(s)' : 'Apagados');
            estadoEl.className = 'avisos-push-estado' + (activo ? ' on' : '');
        }
        btn.textContent = activo ? 'Desactivar en este dispositivo' : 'Activar en este dispositivo';
        btn.className = 'avisos-push-btn' + (activo ? ' off' : ' pr');
        btn.disabled = false;

        if (!nota) return;
        if (nota.dataset.fijo === '1') return;   // no pisar mensajes de acción
        if (esIOS() && !esStandalone()) {
            nota.textContent = 'En iPhone/iPad: Compartir → "Añadir a pantalla de inicio" y activa los avisos desde ahí.';
        } else if (_estado.email) {
            nota.textContent = 'Si este dispositivo no tiene los avisos activados, el aviso llega al correo de la cuenta (' + _estado.email + ').';
        } else {
            nota.textContent = 'Llegan aunque tengas la web cerrada.';
        }
    }

    function setNota(texto, tipo) {
        var nota = document.getElementById('avisos-push-nota');
        if (!nota) return;
        nota.textContent = texto;
        nota.className = 'avisos-push-nota' + (tipo ? ' ' + tipo : '');
        nota.dataset.fijo = tipo ? '1' : '';
        if (tipo) {
            setTimeout(function () {
                nota.dataset.fijo = '';
                nota.className = 'avisos-push-nota';
                pintar();
            }, 6000);
        }
    }

    function abrirCard(abrir) {
        var card = document.getElementById('avisos-push-card');
        if (!card) return;
        var debeAbrir = (typeof abrir === 'boolean') ? abrir : !card.classList.contains('abierta');
        card.classList.toggle('abierta', debeAbrir);
    }

    /**
     * El panel RE-RENDERIZA su cabecera por JS y puede borrar el bloque estático
     * de la campana, así que no dependemos de su HTML: buscamos la campana por su
     * onclick (estable) y colgamos ahí el chip + la tarjeta. Si no aparece, el chip
     * queda flotante arriba a la derecha (sigue siendo accesible).
     */
    function construirTarjeta() {
        if (document.getElementById('avisos-push-chip')) return true;
        inyectarEstilos();

        var slot = document.createElement('span');
        slot.className = 'avisos-push-slot';
        slot.id = 'avisos-push-slot';
        slot.innerHTML = '' +
            '<button type="button" id="avisos-push-chip" class="avisos-push-chip">' +
            '<i class="fas fa-bell"></i><span class="avisos-push-lbl">Activar avisos</span><span class="avisos-push-dot"></span>' +
            '</button>' +
            '<div id="avisos-push-card" class="avisos-push-card">' +
            '<div class="avisos-push-head"><i class="fas fa-mobile-screen-button"></i> Avisos al teléfono / PC <span id="avisos-push-estado" class="avisos-push-estado">…</span></div>' +
            '<p class="avisos-push-txt">Recibe las <b>reservas</b> y los avisos de <b>Ventas Live</b> en este dispositivo, aunque tengas la web cerrada. Se activa una sola vez y sirve para los dos proyectos.</p>' +
            '<div class="avisos-push-acc">' +
            '<button type="button" id="avisos-push-toggle" class="avisos-push-btn pr">Activar en este dispositivo</button>' +
            '<button type="button" id="avisos-push-probar" class="avisos-push-btn">Probar</button>' +
            '</div>' +
            '<p class="avisos-push-nota" id="avisos-push-nota"></p>' +
            '</div>';

        // La campana del panel se pinta por JS y NO siempre trae onclick: se busca
        // por su clase real (.notif-bell-btn dentro de .notif-bell-wrapper) y, si
        // no está, por onclick; si nada aparece, queda flotante arriba a la derecha.
        var bell = document.querySelector('.notif-bell-wrapper .notif-bell-btn, .notif-bell-btn, ' +
            '[onclick*="NotifPopover"], [onclick*="toggleNotif"]');
        var wrapper = bell ? (bell.closest('.notif-bell-wrapper') || bell.parentElement) : null;
        if (wrapper) {
            try { if (getComputedStyle(wrapper).position === 'static') wrapper.style.position = 'relative'; } catch (e) { /* noop */ }
            wrapper.appendChild(slot);
        } else {
            slot.classList.add('avisos-push-fixed');
            document.body.appendChild(slot);
        }

        var chip = document.getElementById('avisos-push-chip');
        if (chip) chip.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            abrirCard();
        });
        var card = document.getElementById('avisos-push-card');
        if (card) card.addEventListener('click', function (e) { e.stopPropagation(); });
        document.addEventListener('click', function () { abrirCard(false); });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') abrirCard(false);
        });

        var btn = document.getElementById('avisos-push-toggle');
        var btnProbar = document.getElementById('avisos-push-probar');
        if (btn) btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var activo = _estado.suscrito && _estado.permiso === 'granted';
            btn.disabled = true;
            (activo ? desactivar() : activar()).then(function (r) {
                btn.disabled = false;
                if (r && r.ok) {
                    _estado.suscrito = !activo;
                    _estado.dispositivos = r.dispositivos || 0;
                    _estado.permiso = Notification.permission;
                    setNota(activo ? 'Avisos apagados en este dispositivo.' : '¡Listo! Te avisamos acá aunque cierres la web.', 'bien');
                } else {
                    setNota((r && r.error) || 'No se pudo cambiar', 'mal');
                }
                pintar();
            });
        });
        if (btnProbar) btnProbar.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            btnProbar.disabled = true;
            setNota('Enviando aviso de prueba…', '');
            probar().then(function (r) {
                btnProbar.disabled = false;
                if (r && r.ok) setNota(r.texto, 'bien');
                else setNota((r && r.error) || 'No se pudo probar', r && r.info ? '' : 'mal');
            });
        });
        return true;
    }

    // ── Aviso en PRIMER PLANO (web abierta) ────────────────────────────────
    function vistos() {
        try { return JSON.parse(localStorage.getItem(LS_VISTOS) || '[]') || []; } catch (e) { return []; }
    }

    function guardarVistos(ids) {
        try { localStorage.setItem(LS_VISTOS, JSON.stringify(ids.slice(0, 60))); } catch (e) { /* noop */ }
    }

    function avisarEnPrimeroPlan() {
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        // Si el dispositivo ya recibe el push del servidor, no duplicamos.
        if (_estado.suscrito) return;
        if (document.visibilityState === 'visible' && document.hasFocus()) {
            // Con la pestaña a la vista, la campana ya muestra el aviso: no duplicar.
            return;
        }
        rpc('avisos_ultimos', { p_limite: 15 }).then(function (rows) {
            if (!Array.isArray(rows) || rows.length === 0) return;
            var previos = vistos();
            var nuevos = rows.filter(function (n) { return previos.indexOf(String(n.id)) === -1; });
            // Primera vez en este equipo: marcar todo como visto (evita una ráfaga de avisos viejos).
            if (previos.length === 0) {
                guardarVistos(rows.map(function (n) { return String(n.id); }));
                return;
            }
            nuevos.reverse().forEach(function (n) {
                try {
                    var noti = new Notification(n.titulo || 'Aviso de tu agenda', {
                        body: n.cuerpo || 'Tienes algo que revisar.',
                        icon: '/icons/icon-192.png',
                        badge: '/icons/badge-96.png',
                        tag: 'avisos-' + (n.id || ''),
                        renotify: false
                    });
                    noti.onclick = function () {
                        window.focus();
                        try { window.location.href = '/admin.html'; } catch (e) { /* noop */ }
                        noti.close();
                    };
                } catch (e) { /* noop */ }
            });
            guardarVistos(rows.map(function (n) { return String(n.id); }).concat(previos));
        });
    }

    function iniciarPoll() {
        if (_pollId) return;
        setTimeout(avisarEnPrimeroPlan, 4000);
        _pollId = setInterval(avisarEnPrimeroPlan, POLL_MS);
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'hidden') avisarEnPrimeroPlan();
        });
    }

    // ── Arranque ────────────────────────────────────────────────────────────
    function refrescarEstado() {
        var permiso = (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported';
        return Promise.all([rpc('avisos_estado'), suscripcionActual()]).then(function (res) {
            var est = res[0] || {};
            _estado.permiso = permiso;
            _estado.suscrito = !!res[1];
            _estado.dispositivos = est.dispositivos || 0;
            _estado.email = est.email || '';
            pintar();
            return _estado;
        });
    }

    function init() {
        if (typeof Notification === 'undefined' || !('serviceWorker' in navigator)) {
            return;   // navegador sin soporte: no se muestra nada
        }
        construirTarjeta();   // el panel puede re-renderizar: se reintenta abajo

        refrescarEstado().then(function (est) {
            // Re-registro SILENCIOSO: ya dio permiso en este dispositivo y no lo apagó.
            var apagado = false;
            try { apagado = localStorage.getItem(LS_OFF) === '1'; } catch (e) { /* noop */ }
            if (est.permiso === 'granted' && !est.suscrito && !apagado) {
                activar().then(function () { refrescarEstado(); });
            } else if (est.permiso === 'granted' && est.suscrito) {
                // Renovar la suscripción en la base (por si el endpoint cambió).
                activar().then(function () { /* silencioso */ });
            }
            iniciarPoll();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 1200); });
    } else {
        setTimeout(init, 1200);
    }

    // El panel re-renderiza la cabecera: si el chip desaparece, se vuelve a montar.
    var intentos = 0;
    var espera = setInterval(function () {
        var montado = document.getElementById('avisos-push-chip');
        if (montado && !document.body.contains(montado)) montado = null;   // lo borró el re-render
        if (!montado) {
            if (construirTarjeta()) refrescarEstado();
        }
        if (++intentos > 120) clearInterval(espera);   // ~60 s de vigilancia
    }, 500);

    window.__avisosPush = { activar: activar, desactivar: desactivar, probar: probar, estado: refrescarEstado };
})();
