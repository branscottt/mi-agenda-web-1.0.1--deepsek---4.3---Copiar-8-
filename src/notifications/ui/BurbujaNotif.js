// notifications/ui/BurbujaNotif.js
// ============================================================
// "La web te habla": burbuja junto a la campana que anuncia los
// pendientes de notificaciones (verificación / recordatorio /
// cambio / servicio expirado) cuando llegan. No invasiva:
// desaparece al abrir la campana, al quedar en 0 o a los 15s.
// Reaparece solo cuando llega algo nuevo (conteo cambia).
// ============================================================

const AUTO_OCULTAR_MS = 15000;
const POLL_MS = 60000;
const RETARDO_INICIAL_MS = 6000; // espera al render legacy del boot

let _burbuja = null;
let _bell = null;
let _popover = null;
let _lista = null;
let _badge = null;
let _timer = null;
let _ultimoConteo = -1;
let _mostradoCon = -1;
let _refrescando = false;
let _debounceEval = null;

const TIPOS = [
    { sel: '.new-reservation', clave: 'verif',  strong: 'Verificación pendiente',    texto: 'Tienes una reserva nueva: tócala y envíale su confirmación.' },
    { sel: '.upcoming',        clave: 'record', strong: 'Recordatorio por enviar',     texto: 'Un cliente tiene su cita muy pronto: mándale el aviso por WhatsApp.' },
    { sel: '.admin-change',    clave: 'cambio', strong: 'Cambio de fecha',             texto: 'Reprogramaste una cita: avísale al cliente del nuevo horario.' }
];

function leerConteo() {
    if (!_badge) return 0;
    if (_badge.style.display === 'none') return 0;
    const n = parseInt(_badge.textContent, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

function popoverAbierto() {
    return !!_popover && _popover.style.display !== 'none';
}

function leerTipoPendiente() {
    if (!_lista) return null;
    const items = _lista.querySelectorAll('.notification-item');
    for (const it of items) {
        // Servicio expirado: usa clase admin-change + botón editar-servicio
        if (it.matches('.admin-change') && it.querySelector('[data-accion="editar-servicio"]')) {
            return { clave: 'expirado', strong: 'Servicio expirado', texto: 'Un servicio se quedó sin fechas: agrega más para reactivarlo.' };
        }
    }
    for (const t of TIPOS) {
        const it = _lista.querySelector(t.sel);
        if (it) return t;
    }
    return { clave: 'generico', strong: 'Notificaciones nuevas', texto: 'Abre la campana para ver qué tienes pendiente.' };
}

function ocultar() {
    if (_timer) { clearTimeout(_timer); _timer = null; }
    if (_burbuja) {
        _burbuja.classList.remove('visible');
        _burbuja.classList.remove('notif-habla-verif', 'notif-habla-record', 'notif-habla-cambio', 'notif-habla-expirado', 'notif-habla-generico');
    }
}

function tocarCampana() {
    if (_bell) _bell.click();
}

function posicionar() {
    // Pegada bajo la campana si es visible; si no (página scrolleada), aviso
    // discreto arriba-derecha. position:fixed → visible siempre.
    if (!_burbuja) return;
    const b = _bell ? _bell.getBoundingClientRect() : null;
    const visible = b && b.width > 0 && b.top > -60 && b.top < window.innerHeight - 40;
    if (visible) {
        _burbuja.style.top = Math.round(b.bottom + 10) + 'px';
        _burbuja.style.right = Math.max(8, Math.round(window.innerWidth - b.right)) + 'px';
    } else {
        _burbuja.style.top = '12px';
        _burbuja.style.right = '12px';
    }
}

function mostrar(info) {
    if (!_burbuja) return;
    if (_timer) { clearTimeout(_timer); _timer = null; }
    _burbuja.classList.remove('notif-habla-verif', 'notif-habla-record', 'notif-habla-cambio', 'notif-habla-expirado', 'notif-habla-generico');
    _burbuja.classList.add('notif-habla-' + (info.clave || 'generico'));
    const strong = _burbuja.querySelector('.notif-habla-txt strong');
    const span = _burbuja.querySelector('.notif-habla-txt span');
    if (strong) strong.textContent = info.strong;
    if (span) span.textContent = info.texto;
    posicionar();
    _burbuja.classList.add('visible');
    // "Ring" sutil de la campana
    if (_bell) {
        _bell.classList.remove('notif-ring');
        void _bell.offsetWidth; // reinicia la animación
        _bell.classList.add('notif-ring');
        setTimeout(() => _bell && _bell.classList.remove('notif-ring'), 1200);
    }
    _timer = setTimeout(ocultar, AUTO_OCULTAR_MS);
}

function evaluar() {
    if (_refrescando) return;
    const count = leerConteo();
    const abierto = popoverAbierto();
    if (abierto || document.visibilityState !== 'visible') {
        if (abierto) { ocultar(); _mostradoCon = count; }
        _ultimoConteo = count;
        return;
    }
    if (count <= 0) {
        ocultar();
        _ultimoConteo = 0;
        _mostradoCon = -1;
        return;
    }
    // Aparece solo cuando el conteo cambia (llegó algo nuevo), incluido 0→N del boot
    if (count !== _mostradoCon) {
        mostrar(leerTipoPendiente() || { clave: 'generico', strong: 'Notificaciones nuevas', texto: 'Abre la campana para ver qué tienes pendiente.' });
        _mostradoCon = count;
    }
    _ultimoConteo = count;
}

function evaluarDebounced() {
    if (_debounceEval) clearTimeout(_debounceEval);
    _debounceEval = setTimeout(evaluar, 300);
}

async function refrescarYEvaluar() {
    if (_refrescando || popoverAbierto() || document.visibilityState !== 'visible') return;
    _refrescando = true;
    try {
        if (typeof window.generarNotificaciones === 'function') {
            await window.generarNotificaciones();
        }
    } catch (e) {
        // silencioso: el siguiente ciclo reintenta
    } finally {
        _refrescando = false;
        evaluar();
    }
}

export function initBurbujaNotif() {
    const wrapper = document.querySelector('.notif-bell-wrapper');
    const bell = document.getElementById('notif-bell-btn');
    const popover = document.getElementById('notif-popover');
    if (!wrapper || !bell || !popover) return;
    if (document.getElementById('notif-habla')) return;

    _bell = bell;
    _popover = popover;
    _lista = popover.querySelector('#notif-popover-list');
    _badge = document.getElementById('notif-badge-count');
    if (!_lista || !_badge) return;

    _burbuja = document.createElement('div');
    _burbuja.id = 'notif-habla';
    _burbuja.className = 'notif-habla';
    _burbuja.setAttribute('role', 'status');
    _burbuja.innerHTML = `
        <span class="notif-habla-dot"></span>
        <div class="notif-habla-txt"><strong></strong><span></span></div>
        <i class="fas fa-chevron-right notif-habla-flecha"></i>
    `;
    wrapper.appendChild(_burbuja);

    _burbuja.addEventListener('click', (e) => {
        e.stopPropagation();
        ocultar();
        _mostradoCon = leerConteo();
        tocarCampana();
    });

    // Abrir la campana (botón o por fuera) oculta la burbuja hasta que llegue algo nuevo
    bell.addEventListener('click', () => {
        ocultar();
        _mostradoCon = leerConteo();
    }, true);

    // Si el popover se abre por otra vía, mismo comportamiento
    const obsPop = new MutationObserver(() => {
        if (popoverAbierto()) {
            ocultar();
            _mostradoCon = leerConteo();
        }
    });
    obsPop.observe(popover, { attributes: true, attributeFilter: ['style'] });

    // Cambios del badge (refrescos legacy en la misma página) → re-evaluar al toque
    const obsBadge = new MutationObserver(evaluarDebounced);
    obsBadge.observe(_badge, { attributes: true, childList: true, characterData: true, subtree: true });

    // Si el usuario scrollea con la burbuja visible, se re-posiciona (sigue a la
    // campana o pasa a modo aviso arriba-derecha si la campana salió del viewport)
    window.addEventListener('scroll', () => {
        if (_burbuja && _burbuja.classList.contains('visible')) posicionar();
    }, { passive: true });
    window.addEventListener('resize', () => {
        if (_burbuja && _burbuja.classList.contains('visible')) posicionar();
    });

    // Estado inicial tras el render legacy del boot + refresco periódico ligero
    setTimeout(evaluar, RETARDO_INICIAL_MS);
    setInterval(refrescarYEvaluar, POLL_MS);
}
