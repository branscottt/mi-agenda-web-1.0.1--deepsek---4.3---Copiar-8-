/* ============================================================
   pwa-install.js — Opción de instalar la app SIEMPRE visible
   ------------------------------------------------------------
   - En móvil y tablet muestra una tarjeta "Instalar Organify"
     en cada visita (se puede ocultar solo durante esa sesión).
   - Usa el prompt nativo de Chrome/Android cuando el navegador
     lo ofrece (beforeinstallprompt) y, si no, muestra los pasos
     reales del navegador (iOS Safari, menú de Android, navegador
     interno de WhatsApp/Instagram).
   - No aparece si la app ya está instalada (standalone).
   - Registra el service worker (requisito de instalabilidad).
   Sin dependencias. Se carga con <script defer src="/pwa-install.js?v=1">.
   ============================================================ */
(function () {
    'use strict';

    var DISMISS_KEY = 'organify_instalar_oculto';   // sessionStorage: solo esta sesión
    var INSTALLED_KEY = 'organify_app_instalada';   // localStorage: no volver a molestar
    var START_DELAY = 1200;                          // ms antes de mostrar la tarjeta

    /* ---------- ¿Ya está instalada? ---------- */
    function yaInstalada() {
        try {
            if (localStorage.getItem(INSTALLED_KEY) === '1') return true;
        } catch (e) { /* modo privado */ }
        if (window.navigator.standalone === true) return true;
        var mq = window.matchMedia ? window.matchMedia('(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)') : null;
        return !!(mq && mq.matches);
    }

    /* ---------- ¿Es móvil o tablet? ---------- */
    function esMovilOTablet() {
        var ua = navigator.userAgent || '';
        if (/Android|iPhone|iPad|iPod|Mobile|Tablet|Silk|Kindle/i.test(ua)) return true;
        // iPadOS 13+ se presenta como Mac: se detecta por puntos táctiles
        if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
        var tactil = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || navigator.maxTouchPoints > 0;
        var angosto = window.innerWidth <= 1024;
        return tactil && angosto;
    }

    /* ---------- Tipo de navegador (para los pasos correctos) ---------- */
    function tipoNavegador() {
        var ua = navigator.userAgent || '';
        var iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        // Navegadores internos: no permiten instalar, hay que salir a Chrome/Safari
        var inApp = '';
        if (/Instagram/i.test(ua)) inApp = 'Instagram';
        else if (/FBAN|FBAV|FB_IAB/i.test(ua)) inApp = 'Facebook';
        else if (/WhatsApp/i.test(ua)) inApp = 'WhatsApp';
        else if (/TikTok|musical_ly|BytedanceWebview/i.test(ua)) inApp = 'TikTok';
        else if (/Line\//i.test(ua)) inApp = 'LINE';
        else if (/Twitter/i.test(ua)) inApp = 'X';
        var android = /Android/i.test(ua);
        var safari = iOS && /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);
        return { iOS: iOS, android: android, safari: safari, inApp: inApp };
    }

    /* ---------- Estilos (una sola vez) ---------- */
    function inyectarEstilos() {
        if (document.getElementById('oia-estilos')) return;
        var css = [
            '.oia-card{position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));',
            'z-index:2400;max-width:470px;margin:0 auto;display:flex;align-items:center;gap:12px;',
            'padding:12px 14px;border-radius:16px;border:1px solid rgba(255,255,255,.14);',
            'background:linear-gradient(180deg,rgba(28,26,40,.98),rgba(16,15,24,.98));',
            'box-shadow:0 14px 40px rgba(0,0,0,.55),0 0 0 1px rgba(157,78,221,.12);',
            'color:#f8f9fa;font-family:"Segoe UI",system-ui,-apple-system,sans-serif;',
            'animation:oia-subir .26s ease-out both;}',
            '@keyframes oia-subir{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}',
            '@media (prefers-reduced-motion:reduce){.oia-card{animation:none}}',
            '.oia-icon{width:44px;height:44px;border-radius:11px;flex:0 0 auto;object-fit:cover;background:#0a0a0f;}',
            '.oia-txt{flex:1 1 auto;min-width:0;line-height:1.35;}',
            '.oia-txt strong{display:block;font-size:.95rem;font-weight:700;letter-spacing:-.2px;}',
            '.oia-txt span{display:block;font-size:.79rem;color:#adb5bd;margin-top:2px;}',
            '.oia-acts{display:flex;flex-direction:column;align-items:stretch;gap:6px;flex:0 0 auto;}',
            '.oia-btn{font:inherit;font-size:.82rem;font-weight:600;border-radius:10px;cursor:pointer;',
            'padding:8px 14px;border:1px solid transparent;white-space:nowrap;transition:background .15s,border-color .15s;}',
            '.oia-btn:focus-visible{outline:2px solid #c77dff;outline-offset:2px;}',
            '.oia-install{color:#fff;background:linear-gradient(135deg,#9d4edd,#7b2cbf);box-shadow:0 6px 16px rgba(157,78,221,.35);}',
            '.oia-install:hover{background:linear-gradient(135deg,#a95ff0,#8a37d8);}',
            '.oia-later{color:#adb5bd;background:transparent;border-color:rgba(255,255,255,.14);}',
            '.oia-later:hover{color:#f8f9fa;border-color:rgba(255,255,255,.3);}',
            '.oia-x{position:absolute;top:6px;right:8px;width:26px;height:26px;border:0;background:transparent;',
            'color:#8b8fa3;font-size:18px;line-height:1;cursor:pointer;border-radius:50%;}',
            '.oia-x:hover{color:#f8f9fa;background:rgba(255,255,255,.08);}',
            '@media (max-width:430px){.oia-card{gap:10px;padding:10px 12px;align-items:center}',
            '.oia-icon{width:40px;height:40px;border-radius:10px}',
            '.oia-txt strong{font-size:.9rem}.oia-txt span{font-size:.75rem;display:-webkit-box;',
            '-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
            '.oia-acts{flex-direction:row}.oia-later{display:none}',
            '.oia-btn{padding:9px 13px;font-size:.8rem}.oia-x{top:2px;right:4px}}',
            /* Hoja de pasos (iOS / navegador interno) */
            '.oia-fondo{position:fixed;inset:0;background:rgba(5,5,8,.72);z-index:2440;',
            'animation:oia-fade .2s ease-out both;}',
            '@keyframes oia-fade{from{opacity:0}to{opacity:1}}',
            '.oia-hoja{position:fixed;left:0;right:0;bottom:0;z-index:2450;max-width:520px;margin:0 auto;',
            'background:#14131d;border:1px solid rgba(255,255,255,.12);border-bottom:0;',
            'border-radius:20px 20px 0 0;padding:20px 20px calc(22px + env(safe-area-inset-bottom,0px));',
            'color:#f8f9fa;font-family:"Segoe UI",system-ui,-apple-system,sans-serif;',
            'box-shadow:0 -12px 40px rgba(0,0,0,.5);animation:oia-subir .26s ease-out both;}',
            '.oia-hoja h3{font-size:1.02rem;font-weight:700;margin:0 0 4px;letter-spacing:-.2px;}',
            '.oia-hoja .oia-sub{font-size:.82rem;color:#adb5bd;margin:0 0 16px;}',
            '.oia-pasos{list-style:none;margin:0 0 18px;padding:0;counter-reset:oia;}',
            '.oia-pasos li{position:relative;padding:0 0 12px 34px;font-size:.88rem;color:#e9ecef;line-height:1.45;}',
            '.oia-pasos li::before{counter-increment:oia;content:counter(oia);position:absolute;left:0;top:0;',
            'width:22px;height:22px;border-radius:50%;background:rgba(157,78,221,.22);color:#c77dff;',
            'font-size:.72rem;font-weight:700;display:flex;align-items:center;justify-content:center;}',
            '.oia-pasos b{color:#fff;font-weight:600;}',
            '.oia-ok{width:100%;font:inherit;font-size:.88rem;font-weight:600;padding:12px;border-radius:12px;',
            'border:0;cursor:pointer;color:#fff;background:linear-gradient(135deg,#9d4edd,#7b2cbf);}',
            '.oia-ok:hover{background:linear-gradient(135deg,#a95ff0,#8a37d8);}'
        ].join('');
        var st = document.createElement('style');
        st.id = 'oia-estilos';
        st.textContent = css;
        document.head.appendChild(st);
    }

    /* ---------- Estado ---------- */
    var promptDiferido = null;
    var tarjeta = null;
    var hojaAbierta = false;

    function cerrarTarjeta() {
        if (tarjeta && tarjeta.parentNode) tarjeta.parentNode.removeChild(tarjeta);
        tarjeta = null;
    }

    function ocultarSesion() {
        try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch (e) { /* noop */ }
    }

    function yaOcultoEnSesion() {
        try { return sessionStorage.getItem(DISMISS_KEY) === '1'; } catch (e) { return false; }
    }

    function marcarInstalada() {
        try { localStorage.setItem(INSTALLED_KEY, '1'); } catch (e) { /* noop */ }
        cerrarTarjeta();
        cerrarHoja();
    }

    /* ---------- Hoja de pasos ---------- */
    function iconoCompartiriOS() {
        return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
            ' stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M12 3v12"/>' +
            '<path d="M8 7l4-4 4 4"/><path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/></svg>';
    }

    function cerrarHoja() {
        var f = document.getElementById('oia-fondo');
        var h = document.getElementById('oia-hoja');
        if (f && f.parentNode) f.parentNode.removeChild(f);
        if (h && h.parentNode) h.parentNode.removeChild(h);
        hojaAbierta = false;
    }

    function mostrarHoja() {
        if (hojaAbierta) return;
        inyectarEstilos();
        var nav = tipoNavegador();
        var titulo, subtitulo, pasos;

        if (nav.inApp) {
            titulo = 'Ábrela en tu navegador para instalarla';
            subtitulo = 'Estás viendo esta página dentro de ' + nav.inApp + ', y desde aquí no se puede instalar.';
            pasos = [
                'Toca el menú <b>⋯</b> (arriba a la derecha).',
                'Elige <b>Abrir en el navegador</b>' + (nav.iOS ? ' (Safari).' : ' (Chrome).'),
                'En la página abierta, toca <b>Instalar</b> de nuevo.'
            ];
        } else if (nav.iOS) {
            titulo = 'Añádela a tu pantalla de inicio';
            subtitulo = nav.safari
                ? 'Safari no muestra un botón de instalar: son 3 toques.'
                : 'En iPhone y iPad solo Safari puede instalarla. Abre esta página en Safari.';
            pasos = nav.safari ? [
                'Toca <b>Compartir</b> ' + iconoCompartiriOS() + ' en la barra de abajo.',
                'Desliza y elige <b>Añadir a pantalla de inicio</b>.',
                'Toca <b>Añadir</b> arriba a la derecha. Listo.'
            ] : [
                'Copia la dirección de esta página.',
                'Ábrela en <b>Safari</b>.',
                'Toca <b>Compartir</b> ' + iconoCompartiriOS() + ' → <b>Añadir a pantalla de inicio</b>.'
            ];
        } else {
            titulo = 'Instálala en tu pantalla de inicio';
            subtitulo = 'Tu navegador no mostró el aviso automático, pero se puede hacer a mano.';
            pasos = [
                'Toca el menú <b>⋮</b> (arriba a la derecha).',
                'Elige <b>Instalar aplicación</b> o <b>Añadir a pantalla de inicio</b>.',
                'Confirma con <b>Instalar</b>.'
            ];
        }

        var fondo = document.createElement('div');
        fondo.className = 'oia-fondo';
        fondo.id = 'oia-fondo';
        fondo.addEventListener('click', cerrarHoja);

        var hoja = document.createElement('div');
        hoja.className = 'oia-hoja';
        hoja.id = 'oia-hoja';
        hoja.setAttribute('role', 'dialog');
        hoja.setAttribute('aria-modal', 'true');
        hoja.setAttribute('aria-labelledby', 'oia-hoja-titulo');
        hoja.innerHTML =
            '<h3 id="oia-hoja-titulo">' + titulo + '</h3>' +
            '<p class="oia-sub">' + subtitulo + '</p>' +
            '<ol class="oia-pasos">' + pasos.map(function (p) { return '<li>' + p + '</li>'; }).join('') + '</ol>' +
            '<button type="button" class="oia-ok">Entendido</button>';

        document.body.appendChild(fondo);
        document.body.appendChild(hoja);
        hojaAbierta = true;
        ocultarSesion();
        cerrarTarjeta();
        var ok = hoja.querySelector('.oia-ok');
        if (ok) {
            ok.addEventListener('click', cerrarHoja);
            ok.focus();
        }
    }

    /* ---------- Tarjeta principal ---------- */
    function mostrarTarjeta() {
        if (tarjeta || hojaAbierta || yaInstalada() || yaOcultoEnSesion()) return;
        if (esPaginaDeAcceso()) return; // login se dibuja después: se revisa aquí también
        if (!document.body) return;
        inyectarEstilos();

        var card = document.createElement('div');
        card.className = 'oia-card';
        card.id = 'oia-card';
        card.setAttribute('role', 'region');
        card.setAttribute('aria-label', 'Instalar Organify como aplicación');
        card.innerHTML =
            '<img class="oia-icon" src="/icons/icon-96.png" alt="" width="44" height="44">' +
            '<div class="oia-txt">' +
            '<strong>Instala Organify</strong>' +
            '<span>Tenla a mano en tu pantalla de inicio, como una app.</span>' +
            '</div>' +
            '<div class="oia-acts">' +
            '<button type="button" class="oia-btn oia-install">Instalar</button>' +
            '<button type="button" class="oia-btn oia-later">Ahora no</button>' +
            '</div>' +
            '<button type="button" class="oia-x" aria-label="Cerrar aviso de instalación">&times;</button>';

        card.querySelector('.oia-later').addEventListener('click', function () {
            ocultarSesion();
            cerrarTarjeta();
        });
        card.querySelector('.oia-x').addEventListener('click', function () {
            ocultarSesion();
            cerrarTarjeta();
        });
        card.querySelector('.oia-install').addEventListener('click', function () {
            if (promptDiferido) {
                var p = promptDiferido;
                promptDiferido = null;
                p.prompt();
                if (p.userChoice && p.userChoice.then) {
                    p.userChoice.then(function (r) {
                        if (r && r.outcome === 'accepted') marcarInstalada();
                        else { ocultarSesion(); cerrarTarjeta(); }
                    }).catch(function () {});
                }
            } else {
                mostrarHoja();
            }
        });

        document.body.appendChild(card);
        tarjeta = card;
    }

    /* ---------- Arranque ---------- */
    function esPaginaDeAcceso() {
        // Login / recuperar contraseña: el aviso taparía el captcha de Cloudflare.
        if (/^\/(login|reset-pass)(\.html)?$/i.test(location.pathname)) return true;
        // Algunas vistas dibujan el login dentro de otra página (admin sin sesión).
        var login = document.querySelector('.login-screen');
        if (login) {
            var r = login.getBoundingClientRect();
            var cs = window.getComputedStyle(login);
            if (r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden') return true;
        }
        return false;
    }

    function esPortada() {
        return location.pathname === '/' || /^\/index(\.html)?$/i.test(location.pathname);
    }

    function iniciar() {
        if (yaInstalada() || !esMovilOTablet() || esPaginaDeAcceso()) return;

        // Service worker: requisito para que el navegador permita instalar.
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {});
        }

        window.addEventListener('beforeinstallprompt', function (e) {
            e.preventDefault();
            promptDiferido = e;
            // No se muestra aquí: lo dispara el temporizador/scroll de abajo.
        });

        window.addEventListener('appinstalled', marcarInstalada);

        // Si la persona empieza a escribir en un formulario (reserva, registro),
        // se aparta para no tapar campos ni el captcha. Vuelve en la próxima visita.
        document.addEventListener('focusin', function (e) {
            var t = e.target;
            if (!t || !t.tagName) return;
            var tag = t.tagName.toUpperCase();
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) {
                cerrarTarjeta();
            }
        });

        if (esPortada()) {
            // En la portada se espera a que la persona empiece a bajar, para no
            // tapar el botón principal ("Probar gratis") en la primera pantalla.
            var mostrado = false;
            var mostrarUnaVez = function () {
                if (mostrado) return;
                mostrado = true;
                mostrarTarjeta();
            };
            window.addEventListener('scroll', function () {
                if (window.scrollY > 120) mostrarUnaVez();
            }, { passive: true });
            setTimeout(mostrarUnaVez, 4500);
        } else {
            // iOS y navegadores sin prompt nativo: la opción se ofrece igual.
            setTimeout(mostrarTarjeta, START_DELAY);
        }

        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            if (hojaAbierta) { cerrarHoja(); return; }
            if (tarjeta) { ocultarSesion(); cerrarTarjeta(); }
        });

        // Si el usuario ya la tiene instalada y abre la web en el navegador,
        // al pasar a standalone (app abierta) se oculta.
        if (window.matchMedia) {
            var mq = window.matchMedia('(display-mode: standalone)');
            var alCambiar = function (ev) { if (ev.matches) marcarInstalada(); };
            if (mq.addEventListener) mq.addEventListener('change', alCambiar);
            else if (mq.addListener) mq.addListener(alCambiar);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', iniciar);
    } else {
        iniciar();
    }
})();
