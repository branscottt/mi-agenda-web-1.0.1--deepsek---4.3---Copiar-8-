// ventas-live/ui/vlModales.js
// Modales del espacio Ventas Live.
// Reglas de UX del proyecto:
//   * Cerrar SIEMPRE de forma explícita (botón Cancelar).
//   * Tocar fuera / Escape con un formulario sucio → pregunta antes de
//     descartar (nunca se pierden datos silenciosamente).
//   * Un solo modal a la vez.

let _overlay = null;
let _sucio = false;
let _keyHandler = null;

export function abrirModal({ titulo, sub, html, ancho = '480px', onMount }) {
    cerrarModal(true);
    _sucio = false;

    _overlay = document.createElement('div');
    _overlay.className = 'vl-modal-overlay';
    _overlay.innerHTML = `
        <div class="vl-modal" style="max-width:${ancho};" role="dialog" aria-modal="true">
            <h3>${titulo}</h3>
            ${sub ? `<div class="m-sub">${sub}</div>` : ''}
            ${html}
        </div>`;

    const modal = _overlay.querySelector('.vl-modal');

    function intentarCerrar() {
        if (_sucio && !window.confirm('Hay cambios sin guardar. ¿Descartarlos y cerrar?')) return;
        cerrarModal(true);
    }
    _overlay.addEventListener('mousedown', (e) => {
        if (e.target === _overlay) intentarCerrar();
    });
    _keyHandler = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            intentarCerrar();
        }
    };
    document.addEventListener('keydown', _keyHandler, true);

    document.body.appendChild(_overlay);
    if (onMount) onMount(modal, { marcarSucio: () => { _sucio = true; } });
}

export function cerrarModal(force = false) {
    if (!force && _sucio) {
        if (!window.confirm('Hay cambios sin guardar. ¿Descartarlos y cerrar?')) return false;
    }
    if (_keyHandler) {
        document.removeEventListener('keydown', _keyHandler, true);
        _keyHandler = null;
    }
    if (_overlay) {
        _overlay.remove();
        _overlay = null;
    }
    _sucio = false;
    return true;
}
