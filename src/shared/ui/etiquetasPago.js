// src/shared/ui/etiquetasPago.js
// Etiquetas de pago a nivel CLIENTE — compartidas entre
// "Mis Clientes" (admin) y el portal del trabajador.
// Las tarjetas kanban YA NO manejan etiquetas: el estado de pago
// se pone en el cliente y se refleja en Citas Programadas
// (citas.estado_pago).

export const ETIQUETAS_PAGO = [
    { clave: 'pagado', nombre: 'Pagado', color: '#2ecc71' },
    { clave: 'abonado', nombre: 'Abonado', color: '#3498db' },
    { clave: 'parcial', nombre: 'Se pagó algo', color: '#f1c40f' },
    { clave: 'no_pagado', nombre: 'No pagado', color: '#e74c3c' }
];

export function etiquetaPorClave(clave) {
    return ETIQUETAS_PAGO.find(e => e.clave === clave) || null;
}

/**
 * HTML de un chip de etiqueta de pago.
 * @param {string|null} clave 'pagado'|'abonado'|'parcial'|'no_pagado'|null
 * @param {object} opts { clickeable, vacioTexto }
 */
export function renderChipEtiqueta(clave, opts = {}) {
    const et = etiquetaPorClave(clave);
    const rol = opts.clickeable ? ' role="button" tabindex="0"' : '';
    if (!et) {
        return `<span class="etiqueta-pago-chip etiqueta-vacia"${rol}>${opts.vacioTexto || 'Pago'}</span>`;
    }
    return `<span class="etiqueta-pago-chip" data-estado="${et.clave}"${rol}>${et.nombre}</span>`;
}

/**
 * Menú flotante para elegir la etiqueta de pago de un cliente.
 * @param {string|null} estadoActual clave actual (o null)
 * @param {(clave: string|null) => void} onElegir  null = sin etiqueta
 */
export function abrirMenuEtiquetas(estadoActual, onElegir) {
    const overlay = document.createElement('div');
    overlay.className = 'kanban-card-overlay';
    overlay.style.zIndex = '2300';
    overlay.innerHTML = `
        <div class="etiquetas-menu">
            <header class="etiquetas-menu-header">
                <h4><i class="fas fa-tags"></i> Estado de pago del cliente</h4>
                <button class="kanban-btn-close" id="etiquetas-menu-cerrar" title="Cerrar">&times;</button>
            </header>
            <div class="etiquetas-menu-body">
                ${ETIQUETAS_PAGO.map(et => `
                    <button type="button" class="etiquetas-menu-opcion ${estadoActual === et.clave ? 'activa' : ''}" data-clave="${et.clave}">
                        <span class="etiquetas-menu-dot" style="background:${et.color}"></span> ${et.nombre}
                        ${estadoActual === et.clave ? '<i class="fas fa-check"></i>' : ''}
                    </button>
                `).join('')}
                <button type="button" class="etiquetas-menu-opcion sin-etiqueta ${!estadoActual ? 'activa' : ''}" data-clave="">
                    <i class="fas fa-ban"></i> Sin etiqueta
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    const cerrar = () => overlay.remove();
    document.getElementById('etiquetas-menu-cerrar').addEventListener('click', cerrar);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) cerrar(); });
    const escHandler = (e) => { if (e.key === 'Escape') { cerrar(); document.removeEventListener('keydown', escHandler); } };
    document.addEventListener('keydown', escHandler);
    overlay.querySelectorAll('.etiquetas-menu-opcion').forEach(btn => {
        btn.addEventListener('click', () => {
            const clave = btn.dataset.clave || null;
            cerrar();
            document.removeEventListener('keydown', escHandler);
            onElegir(clave);
        });
    });
}
