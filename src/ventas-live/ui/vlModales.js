// ventas-live/ui/vlModales.js
// Modales del espacio Ventas Live.
// Reglas de UX del proyecto:
//   * Cerrar SIEMPRE de forma explícita (botón Cancelar).
//   * Tocar fuera / Escape con un formulario sucio → pregunta antes de
//     descartar (nunca se pierden datos silenciosamente).
//   * Un solo modal a la vez.
//   * Botón "atrás" del celular: cierra el modal (no se va de la página).

import { abrirCapa, consumirCapa } from './vlAtras.js';

let _overlay = null;
let _sucio = false;
let _keyHandler = null;
let _intentarCerrar = null;   // cierre "suave" (pregunta si hay cambios)
let _reemplazando = false;    // abrirModal cerrando el anterior: no tocar el historial

export function abrirModal({ titulo, sub, html, ancho = '480px', onMount }) {
    // Un solo modal a la vez. El cierre del anterior NO consume su entrada del
    // historial: la capa es la misma ('vl-modal') y se reutiliza.
    _reemplazando = true;
    cerrarModal(true);
    _reemplazando = false;
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

    _intentarCerrar = () => {
        if (_sucio && !window.confirm('Hay cambios sin guardar. ¿Descartarlos y cerrar?')) return false;
        cerrarModal(true);
        return true;
    };
    _overlay.addEventListener('mousedown', (e) => {
        if (e.target === _overlay) _intentarCerrar();
    });
    _keyHandler = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            _intentarCerrar();
        }
    };
    document.addEventListener('keydown', _keyHandler, true);

    document.body.appendChild(_overlay);
    // Capa del historial: "atrás" en el celular cierra ESTE modal.
    abrirCapa('vl-modal', () => (_intentarCerrar ? _intentarCerrar() : true));
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
    _intentarCerrar = null;
    // Cierre por la UI (Cancelar / Guardar / X / Escape): consume la entrada
    // que dejó abrirCapa para que el próximo "atrás" no quede mudo.
    if (!_reemplazando) consumirCapa('vl-modal');
    return true;
}
