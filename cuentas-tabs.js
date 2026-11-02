// cuentas-tabs.js — DOS CUENTAS EN EL MISMO NAVEGADOR, UNA POR PESTAÑA
// ---------------------------------------------------------------------------
// Se carga como archivo suelto (NO se bundlea) en login.html:
//   <script defer src="/cuentas-tabs.js?v=1"></script>
//
// El navegador guarda UNA sola sesión por sitio (localStorage), así que al
// entrar con otra cuenta se pisa la anterior. Este script ofrece el modo
// "cuenta independiente en esta pestaña":
//   · marca la PESTAÑA (sessionStorage.agendapro_tab_scoped = '1')
//   · desde ahí los tokens viven en sessionStorage (solo esa pestaña)
//   · la cuenta principal del navegador (localStorage) queda intacta
// Con eso podés tener la cuenta A en una pestaña y la cuenta B en otra.
//
// Si se edita este archivo: subir ?v=N en login.html.

(function () {
    'use strict';

    var LS_SCOPED = 'agendapro_tab_scoped';
    var LS_KEYS = [
        'agendapro_access_token',
        'agendapro_refresh_token',
        'agendapro_user_data',
        'sb-agendapro-pestana-auth'
    ];

    function estaScoped() {
        try { return sessionStorage.getItem(LS_SCOPED) === '1'; } catch (e) { return false; }
    }

    function limpiarPestana() {
        try {
            for (var i = 0; i < LS_KEYS.length; i++) sessionStorage.removeItem(LS_KEYS[i]);
        } catch (e) { /* noop */ }
    }

    function cuentaPrincipal() {
        try {
            var raw = localStorage.getItem('agendapro_user_data');
            return raw ? (JSON.parse(raw).email || '') : '';
        } catch (e) { return ''; }
    }

    function inyectarEstilos() {
        if (document.getElementById('cuentas-tabs-css')) return;
        var css = document.createElement('style');
        css.id = 'cuentas-tabs-css';
        css.textContent = [
            '.ct-wrap{position:fixed;left:50%;transform:translateX(-50%);bottom:14px;z-index:2400;display:flex;align-items:center;gap:10px;padding:9px 14px;border-radius:999px;background:rgba(23,19,38,.92);border:1px solid rgba(255,255,255,.14);box-shadow:0 10px 30px rgba(0,0,0,.28);font-family:Inter,system-ui,sans-serif;font-size:12.5px;color:#e9e3f7;backdrop-filter:blur(6px);max-width:calc(100vw - 20px)}',
            '.ct-wrap .ct-txt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '.ct-wrap b{color:#fff}',
            '.ct-btn{border:0;background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;font:inherit;font-weight:700;padding:7px 12px;border-radius:999px;cursor:pointer;white-space:nowrap}',
            '.ct-btn:hover{filter:brightness(1.08)}',
            '.ct-btn.ghost{background:transparent;border:1px solid rgba(255,255,255,.28);color:#e9e3f7;font-weight:600}',
            '.ct-btn.ghost:hover{background:rgba(255,255,255,.12)}',
            '@media(max-width:600px){.ct-wrap{bottom:10px;padding:8px 11px;font-size:11.5px;gap:8px}.ct-btn{padding:6px 10px}}'
        ].join('\n');
        document.head.appendChild(css);
    }

    function pintar() {
        if (document.getElementById('ct-wrap')) return;
        inyectarEstilos();

        var scoped = estaScoped();
        var principal = cuentaPrincipal();
        var wrap = document.createElement('div');
        wrap.className = 'ct-wrap';
        wrap.id = 'ct-wrap';

        if (scoped) {
            wrap.innerHTML = '<span class="ct-txt">Pestaña con <b>cuenta independiente</b></span>' +
                '<button type="button" class="ct-btn ghost" id="ct-volver">Usar la cuenta principal</button>';
            wrap.querySelector('#ct-volver').addEventListener('click', function () {
                try { sessionStorage.removeItem(LS_SCOPED); } catch (e) { /* noop */ }
                limpiarPestana();
                location.reload();
            });
        } else {
            wrap.innerHTML = '<span class="ct-txt">' +
                (principal ? 'Acá estás con <b>' + principal + '</b>' : '¿Tenés otra cuenta?') +
                '</span>' +
                '<button type="button" class="ct-btn" id="ct-otra">Usar otra cuenta en esta pestaña</button>';
            wrap.querySelector('#ct-otra').addEventListener('click', function () {
                try { sessionStorage.setItem(LS_SCOPED, '1'); } catch (e) { /* noop */ }
                limpiarPestana();
                location.reload();
            });
        }
        document.body.appendChild(wrap);
    }

    function init() {
        // Solo en la pantalla de login (no en el panel ni en la portada):
        // se detecta por el campo de contraseña, sin depender de la URL.
        if (!document.querySelector('input[type="password"], .login-screen, #login-form')) return;
        pintar();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 600); });
    } else {
        setTimeout(init, 600);
    }

    window.__cuentasTabs = {
        scoped: estaScoped,
        activar: function () { try { sessionStorage.setItem(LS_SCOPED, '1'); } catch (e) {} limpiarPestana(); location.reload(); },
        desactivar: function () { try { sessionStorage.removeItem(LS_SCOPED); } catch (e) {} limpiarPestana(); location.reload(); }
    };
})();
