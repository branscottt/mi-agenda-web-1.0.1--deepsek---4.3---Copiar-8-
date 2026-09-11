// clients/ui/MisClientesGuia.js
// "Cómo funciona Mis Clientes" — mini-guía INTERACTIVA y corta (4 pasos)
// con ejemplos visuales de lo que se puede guardar en la ficha de un cliente.
//
// Por qué existe: el poder de la sección estaba escondido (nadie sabe que al
// tocar un cliente hay notas, archivos, fotos, checklists y formas de
// compartir). Esta guía lo muestra con ejemplos en <30 segundos, sin manuales.
//
// Se abre desde:
//   - el botón "Ver cómo funciona" de la bienvenida de Mis Clientes,
//   - el "¿Cómo funciona?" de la invitación de descubrimiento,
//   - el estado vacío de la lista.
//
// Reglas de la casa:
//   - Sin onclick inline ni <style> dinámico (CSP por hashes) → clases en style.css.
//   - z-index 9900 (sobre la app; bajo el tour de bienvenida 10000+).
//   - Escape capturado + stopImmediatePropagation: si hay un tablero
//     (ClientBoard) detrás, no lo cierra por accidente (pitfall conhecido).
//   - Omitible: "Ahora no" y ×.

export const GUIA_KEY_PREFIJO = 'agendapro_mc_guia_';

// Cada paso: icono grande, título, mensaje corto, y un "ejemplo" opcional
// (tarjeta de muestra / bullets) que hace ver de qué se habla.
const PASOS = [
    {
        icono: 'fa-user-check',
        color: '#2ee6a8',
        titulo: 'Tus clientes se guardan solos',
        texto: 'Cuando alguien reserva en tu web (o compra sin turno), aparece aquí con su historial. No tienes que cargar nada a mano.',
        ejemplo: { tipo: 'tarjeta', nombre: 'María González', meta: '3 visitas · $45.000 · Próxima: jue 10:30' }
    },
    {
        icono: 'fa-id-card',
        color: '#9d4edd',
        titulo: 'Toca un cliente: su ficha lo guarda todo',
        texto: 'Se abre su tablero. Ahí puedes escribir notas, armar listas (ej. "Historia clínica", "Seguimiento"), crear checklists, subir archivos y fotos, y marcar su estado de pago.',
        ejemplo: {
            tipo: 'chips',
            items: [
                { i: 'fa-image', t: '1 foto' },
                { i: 'fa-paperclip', t: '2 archivos' },
                { i: 'fa-sticky-note', t: '1 nota' },
                { i: 'fa-tasks', t: 'Checklist 2/4' }
            ]
        }
    },
    {
        icono: 'fa-eye',
        color: '#ffd166',
        titulo: 'Comparte solo lo que quieras',
        texto: 'Activa el ojo en las listas que quieras que vea el cliente y toca "Enviar info": le llega por WhatsApp un enlace con eso, siempre actualizado.',
        ejemplo: {
            tipo: 'chips',
            items: [
                { i: 'fa-brands fa-whatsapp', t: 'Enviar por WhatsApp' },
                { i: 'fa-link', t: 'Enlace que se actualiza solo' },
                { i: 'fa-lock', t: 'El resto queda privado' }
            ]
        }
    },
    {
        icono: 'fa-truck-moving',
        color: '#c084fc',
        titulo: '¿Ya tenías todo en Excel o Drive?',
        texto: 'Trae tus clientes en montón: pega tu planilla y sube sus archivos juntos. La web los reparte solos a la carpeta de cada cliente.',
        ejemplo: {
            tipo: 'chips',
            items: [
                { i: 'fa-file-excel', t: 'Pega tu Excel/CSV' },
                { i: 'fa-boxes-stacked', t: 'Sube archivos en montón' },
                { i: 'fa-wand-magic-sparkles', t: 'Se reparten solos' }
            ]
        }
    }
];

let overlayEl = null;
let pasoActual = 0;
let onIrCb = null;
let onImportarCb = null;

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function ejemploHtml(ej) {
    if (!ej) return '';
    if (ej.tipo === 'tarjeta') {
        const inicial = esc((ej.nombre || '?').trim().charAt(0).toUpperCase());
        return `
            <div class="mcguia-ejemplo">
                <div class="mcguia-ej-avatar">${inicial}</div>
                <div class="mcguia-ej-main">
                    <div class="mcguia-ej-nombre">${esc(ej.nombre)}</div>
                    <div class="mcguia-ej-meta">${esc(ej.meta)}</div>
                </div>
            </div>`;
    }
    if (ej.tipo === 'chips') {
        return `
            <div class="mcguia-ejemplo-chips">
                ${(ej.items || []).map(it => `<span class="mcguia-ej-chip"><i class="${esc(it.i)}"></i> ${esc(it.t)}</span>`).join('')}
            </div>`;
    }
    return '';
}

function pintarPaso() {
    if (!overlayEl) return;
    const total = PASOS.length;
    const p = PASOS[pasoActual];
    const body = overlayEl.querySelector('#mcguia-body');
    if (!body) return;
    body.innerHTML = `
        <div class="mcguia-paso-icono" style="background:${p.color}22;color:${p.color};border-color:${p.color}55;">
            <i class="fas ${esc(p.icono)}"></i>
        </div>
        <h4 class="mcguia-paso-titulo">${esc(p.titulo)}</h4>
        <p class="mcguia-paso-texto">${esc(p.texto)}</p>
        ${ejemploHtml(p.ejemplo)}
    `;
    const dots = overlayEl.querySelector('#mcguia-dots');
    if (dots) {
        dots.innerHTML = PASOS.map((_, i) => `<span class="mcguia-dot${i === pasoActual ? ' activo' : ''}"></span>`).join('');
    }
    const atras = overlayEl.querySelector('#mcguia-atras');
    const next = overlayEl.querySelector('#mcguia-next');
    if (atras) atras.style.visibility = pasoActual === 0 ? 'hidden' : 'visible';
    if (next) {
        const ultimo = pasoActual === total - 1;
        next.innerHTML = ultimo
            ? '<i class="fas fa-check"></i> Entendido'
            : 'Siguiente <i class="fas fa-arrow-right"></i>';
    }
    const contador = overlayEl.querySelector('#mcguia-contador');
    if (contador) contador.textContent = `Paso ${pasoActual + 1} de ${total}`;
}

function irA(n) {
    pasoActual = Math.max(0, Math.min(PASOS.length - 1, n));
    pintarPaso();
}

function cerrar() {
    if (!overlayEl) return;
    overlayEl.remove();
    overlayEl = null;
    document.removeEventListener('keydown', manejarTeclado, true);
}

function manejarTeclado(e) {
    if (!overlayEl) return;
    if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        cerrar();
    } else if (e.key === 'ArrowRight') {
        e.stopImmediatePropagation();
        irA(pasoActual + 1);
    } else if (e.key === 'ArrowLeft') {
        e.stopImmediatePropagation();
        irA(pasoActual - 1);
    }
}

/**
 * Abre la mini-guía interactiva.
 * @param {{paso?:number, onIr?:Function, onImportar?:Function}} opts
 *   onIr       → se llama en el último paso (ej. navegar a Mis Clientes)
 *   onImportar → abre el Centro de Mudanza desde el último paso
 */
export function abrirMisClientesGuia(opts = {}) {
    if (overlayEl) return;
    onIrCb = typeof opts.onIr === 'function' ? opts.onIr : null;
    onImportarCb = typeof opts.onImportar === 'function' ? opts.onImportar : null;
    pasoActual = Number.isFinite(opts.paso) ? Math.max(0, Math.min(PASOS.length - 1, opts.paso)) : 0;

    overlayEl = document.createElement('div');
    overlayEl.className = 'mcguia-overlay';
    overlayEl.innerHTML = `
        <div class="mcguia-card" role="dialog" aria-modal="true" aria-labelledby="mcguia-titulo">
            <header class="mcguia-head">
                <div class="mcguia-avatar"><i class="fas fa-graduation-cap"></i></div>
                <div class="mcguia-head-txt">
                    <strong id="mcguia-titulo">Cómo funciona Mis Clientes</strong>
                    <span id="mcguia-contador">Paso 1 de ${PASOS.length}</span>
                </div>
                <button type="button" class="mcguia-x" id="mcguia-cerrar" title="Cerrar" aria-label="Cerrar">&times;</button>
            </header>
            <div class="mcguia-body" id="mcguia-body"></div>
            <div class="mcguia-dots" id="mcguia-dots"></div>
            <footer class="mcguia-foot">
                <button type="button" class="mcguia-btn mcguia-btn-sec" id="mcguia-atras"><i class="fas fa-arrow-left"></i> Anterior</button>
                <button type="button" class="mcguia-btn mcguia-btn-prim" id="mcguia-next">Siguiente <i class="fas fa-arrow-right"></i></button>
            </footer>
            <div class="mcguia-extra">
                <button type="button" class="mcguia-btn mcguia-btn-ghost" id="mcguia-importar"><i class="fas fa-truck-moving"></i> Traer mis clientes</button>
                <button type="button" class="mcguia-btn mcguia-btn-ghost" id="mcguia-ver"><i class="fas fa-users"></i> Ver Mis Clientes</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlayEl);

    overlayEl.querySelector('#mcguia-cerrar').addEventListener('click', cerrar);
    overlayEl.addEventListener('mousedown', (e) => { if (e.target === overlayEl) cerrar(); });
    overlayEl.querySelector('#mcguia-atras').addEventListener('click', () => irA(pasoActual - 1));
    overlayEl.querySelector('#mcguia-next').addEventListener('click', () => {
        if (pasoActual >= PASOS.length - 1) { cerrar(); return; }
        irA(pasoActual + 1);
    });
    overlayEl.querySelector('#mcguia-importar').addEventListener('click', () => {
        cerrar();
        try { if (onImportarCb) onImportarCb(); } catch (e) { /* sin destino */ }
    });
    overlayEl.querySelector('#mcguia-ver').addEventListener('click', () => {
        cerrar();
        try {
            if (onIrCb) onIrCb();
            else if (typeof window.navigateTo === 'function') window.navigateTo('clientes');
        } catch (e) { /* sección ya visible */ }
    });

    // CAPTURE + stopImmediatePropagation: no cerrar un tablero (ClientBoard) detrás.
    document.addEventListener('keydown', manejarTeclado, true);
    pintarPaso();
}
