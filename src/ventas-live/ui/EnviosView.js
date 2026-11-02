// ventas-live/ui/EnviosView.js
// ENVÍOS COMO TABLERO (estilo Trello, igual que el de reservas de clientes).
//
// Cada pedido es una TARJETA en la columna de cómo se entrega:
//   Blue Express · Paket · Presencial · Sin definir · Otros couriers · Listos
// La columna la calcula el servidor (vl_envios_pendientes v3) a partir del
// estado REAL del pedido: acá no se adivina nada.
//
// La información la sigue leyendo el bot del chat (prendas, precios, contacto,
// dirección, fotos). Lo que se puede tocar a mano:
//   * mover la tarjeta (arrastrar)  -> decisión real del pedido
//   * datos de contacto             -> vl_actualizar_cliente (con confirmación)
//   * descripción/precio de prenda  -> vl_item_editar (sin pagos registrados)
//   * borrar una foto del chat      -> vl_wa_mensaje_media_borrar
//   * etiquetas libres + nota       -> vl_tablero_tarjeta
// Todo lo destructivo o que cambia lo que leyó el bot pide DOS toques
// (botón + confirmación), nunca se guarda solo.

import { vlApi } from '../domain/vlApi.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { escapeHtml, formatearDinero } from '../../shared/infrastructure/formatters.js';
import { getSupabase } from '../../shared/infrastructure/supabase.js';
import { firmarMedias } from './chatComun.js';
import { abrirCapa, consumirCapa } from './vlAtras.js';
import {
    modalCrearEnvio, modalMarcarEntregado, modalConfirmarPago,
    modalPagarItems, modalLiberarItems, modalEliminarCompra, modalCorregirEntrega
} from './accionesProceso.js';
import { abrirChatDeUsuario } from './ConversacionesDrawer.js';

const EMPRESA_SITIOS = {
    blue_express: 'https://www.bluex.cl',
    paket: 'https://www.paketexpress.cl',
    chilexpress: 'https://www.chilexpress.cl',
    starken: 'https://www.starken.cl'
};

const EMPRESA_LABEL = {
    blue_express: 'Blue Express', paket: 'Paket', chilexpress: 'Chilexpress',
    starken: 'Starken', otra: 'Otra'
};

// Columnas del tablero. El id es el que devuelve la RPC (`columna`).
const COLUMNAS = [
    { id: 'blue',        titulo: 'Blue Express',     icono: 'fa-truck-fast',     color: '#4dabf7', ayuda: 'Envío por Blue Express' },
    { id: 'paket',       titulo: 'Paket',            icono: 'fa-box',            color: '#ffd43b', ayuda: 'Pedir antes de las 23:59' },
    { id: 'presencial',  titulo: 'Presencial',       icono: 'fa-handshake',      color: '#e599f7', ayuda: 'Entrega en mano' },
    { id: 'sin_definir', titulo: 'Sin definir',      icono: 'fa-circle-question', color: '#adb5bd', ayuda: 'Falta saber cómo lo quiere' },
    { id: 'otros',       titulo: 'Otros couriers',   icono: 'fa-truck',          color: '#94d82d', ayuda: 'Chilexpress, Starken u otra' },
    { id: 'listo',       titulo: 'Listos / Entregados', icono: 'fa-circle-check', color: '#69db7c', ayuda: 'Ya se entregaron' }
];

const ETIQUETAS = [
    { t: 'urgente', c: '#e8590c' },
    { t: 'regalo', c: '#d6336c' },
    { t: 'retiro', c: '#0ca678' },
    { t: 'revisar', c: '#fab005' },
    { t: 'pagar antes', c: '#7048e8' },
    { t: 'mayorista', c: '#1c7ed6' }
];

const LARGO_COLUMNA = 200;

let _tarjetas = [];
let _busqueda = '';
let _fichaAbierta = null;      // proceso_id de la tarjeta abierta
let _fichaSucio = false;
let _dragId = null;
let _dragEl = null;
let _toque = null;

function $(id) { return document.getElementById(id); }

export function initEnvios() {
    const cont = $('vl-view-envios');
    cont.innerHTML = `
        <div class="vl-tablero-cab">
            <div class="vl-tablero-resumen" id="ve-resumen"></div>
            <div class="vl-tablero-herramientas">
                <div class="vl-tablero-buscar">
                    <i class="fas fa-search"></i>
                    <input type="search" id="ve-buscar" placeholder="Buscar clienta, @, dirección…" autocomplete="off">
                </div>
                <button class="vl-btn" id="ve-refrescar" type="button" title="Volver a leer el chat">
                    <i class="fas fa-rotate"></i> Actualizar
                </button>
            </div>
        </div>
        <div class="vl-config-aviso" id="ve-config"></div>
        <div class="vl-tablero" id="ve-board">
            <div class="vl-empty" style="padding:50px;"><i class="fas fa-spinner fa-spin"></i> Leyendo los pedidos…</div>
        </div>`;

    $('ve-refrescar').addEventListener('click', () => refrescarEnvios());
    const inp = $('ve-buscar');
    inp.addEventListener('input', () => {
        _busqueda = inp.value.trim().toLowerCase();
        pintarTablero();
    });
    refrescarEnvios();
}

// ── Carga ────────────────────────────────────────────────────────────────

async function refrescarEnvios() {
    const board = $('ve-board');
    if (!board) return;

    const [res, cfg] = await Promise.all([vlApi.enviosPendientes(), vlApi.configFaltantes()]);
    pintarAvisoConfig(cfg);

    if (!res.ok) {
        board.innerHTML = `<div class="vl-empty">No se pudo cargar: ${escapeHtml(res.error || 'error')}</div>`;
        return;
    }

    _tarjetas = Array.isArray(res.data.tarjetas) ? res.data.tarjetas : [];

    // Firmar las fotos ANTES de pintar (bucket privado: exige la sesión).
    const supabase = getSupabase();
    const fotos = [];
    _tarjetas.forEach(t => (t.fotos || []).forEach(f => fotos.push(f)));
    if (supabase && fotos.length) {
        try { await firmarMedias(fotos, supabase); } catch (_) { /* sin vista previa */ }
    }

    pintarTablero();
    if (_fichaAbierta) abrirFicha(_fichaAbierta, true);
}

function pintarAvisoConfig(cfg) {
    const cont = $('ve-config');
    if (!cont) return;
    cont.innerHTML = '';
    if (!cfg || !cfg.ok || !cfg.data) return;
    const faltan = Array.isArray(cfg.data.faltantes) ? cfg.data.faltantes : [];
    if (!faltan.length) return;
    cont.innerHTML = `<div class="vl-config-banner">
        <b>⚠️ Falta configurar el bot antes de usarlo en un LIVE</b>
        <ul>${faltan.map(f => `<li>${escapeHtml(f.mensaje)}</li>`).join('')}</ul>
    </div>`;
}

// ── Tablero ──────────────────────────────────────────────────────────────

function pintarTablero() {
    const board = $('ve-board');
    if (!board) return;

    if (!_tarjetas.length) {
        $('ve-resumen').innerHTML = '';
        board.innerHTML = '<div class="vl-empty" style="padding:50px;">Sin pedidos abiertos: no hay nada que entregar ni cobrar 🎉</div>';
        return;
    }

    const abiertas = _tarjetas.filter(t => !t.cerrado);
    const porCobrar = abiertas.reduce((a, t) => a + Math.max(0, Number(t.saldo) || 0), 0);
    const entregadas = _tarjetas.filter(t => t.cerrado || t.columna === 'listo').length;
    $('ve-resumen').innerHTML = `
        <span><b>${abiertas.length}</b> pedido(s) en curso</span>
        <span class="${porCobrar > 0 ? 'vl-res-ambar' : ''}">${porCobrar > 0 ? 'Falta cobrar ' + formatearDinero(porCobrar) : 'Todo cobrado ✔'}</span>
        <span class="vl-res-tenue">${entregadas} entregado(s) esta semana</span>`;

    const visibles = _tarjetas.filter(coincideBusqueda);
    board.innerHTML = COLUMNAS.map(col => columnaHTML(col, visibles)).join('');

    // Bind de tarjetas + columnas
    board.querySelectorAll('.kanban-card').forEach(el => {
        const t = _tarjetas.find(x => x.proceso_id === el.dataset.proceso);
        if (!t) return;
        el.addEventListener('click', (e) => {
            if (el.dataset.suprimirClick === '1') { el.dataset.suprimirClick = ''; return; }
            if (e.target.closest('button')) return;
            abrirFicha(t.proceso_id);
        });
        bindCardDnD(el);
    });
    bindColumnas();
}

function coincideBusqueda(t) {
    if (!_busqueda) return true;
    const c = t.cliente || {};
    const txt = [
        c.tiktok_user, c.nombre_real, c.whatsapp, c.correo,
        c.direccion, c.comuna, c.ciudad, t.nota_interna
    ].filter(Boolean).join(' ').toLowerCase();
    return txt.includes(_busqueda);
}

function columnaHTML(col, tarjetas) {
    // "Otros couriers" solo aparece si hay alguno: no se muestra una columna
    // vacía que nunca se usa.
    if (col.id === 'otros' && !tarjetas.some(t => t.columna === 'otros')) return '';
    const lista = tarjetas.filter(t => t.columna === col.id);
    return `
        <div class="kanban-list vl-tcol" data-col="${col.id}" style="--vl-col:${col.color};">
            <div class="kanban-list-header vl-tcol-head">
                <span class="vl-tcol-icono"><i class="fas ${col.icono}"></i></span>
                <span class="kanban-list-titulo" title="${escapeHtml(col.ayuda)}">${escapeHtml(col.titulo)}</span>
                <span class="kanban-list-count">${lista.length}</span>
            </div>
            <div class="kanban-list-cards" data-col="${col.id}">
                ${lista.map(tarjetaHTML).join('') || '<div class="vl-tcol-vacia">—</div>'}
            </div>
        </div>`;
}

function tarjetaHTML(t) {
    const c = t.cliente || {};
    const bloqueada = t.cerrado || t.columna === 'listo';
    const pago = etiquetaPago(t);
    const chips = [];
    // En la columna Listos lo que importa es "entregado" (y si quedó debiendo),
    // no repetir "sin pagar" en una tarjeta que ya se entregó.
    if (t.columna !== 'listo') {
        chips.push(`<span class="kanban-chip" style="background:${pago.color};">${escapeHtml(pago.label)}</span>`);
    }
    (t.etiquetas || []).forEach(et => {
        const def = ETIQUETAS.find(e => e.t === et);
        chips.push(`<span class="kanban-chip" style="background:${def ? def.c : '#495057'};">${escapeHtml(et)}</span>`);
    });
    if (t.columna === 'listo' && Number(t.saldo) > 0) {
        chips.push(`<span class="kanban-chip" style="background:#e8590c;">falta cobrar ${formatearDinero(t.saldo)}</span>`);
    } else if (t.columna === 'listo') {
        chips.push('<span class="kanban-chip" style="background:#2b8a3e;">entregado</span>');
    }
    if (t.envio_estado === 'en_proceso' && !bloqueada) {
        chips.push('<span class="kanban-chip" style="background:#7048e8;">en camino</span>');
    }
    if (t.columna === 'sin_definir' && t.tipo === 'envio') {
        chips.push('<span class="kanban-chip" style="background:#868e96;">falta courier</span>');
    }
    if (t.posible_soltar) {
        chips.push('<span class="kanban-chip" style="background:#b8860b;" title="Presencial sin fecha y sin pago: decide si liberas la prenda">posible soltar</span>');
    }

    const fotos = (t.fotos || []).slice(0, 3);
    const totalFotos = (t.fotos || []).length;
    const fecha = chipFecha(t);

    return `
        <div class="kanban-card vl-tcard ${bloqueada ? 'vl-tcard-bloqueada' : ''}"
             draggable="${bloqueada ? 'false' : 'true'}"
             data-proceso="${t.proceso_id}"
             data-col="${t.columna}"
             data-bloqueada="${bloqueada ? '1' : '0'}">
            <div class="kanban-card-chips">${chips.join('')}</div>
            <div class="kanban-card-titulo">@${escapeHtml(c.tiktok_user || '?')}${c.nombre_real ? ' · ' + escapeHtml(c.nombre_real) : ''}</div>
            <div class="vl-tcard-linea">
                <span><i class="fas fa-shirt"></i> ${Number(t.prendas) || 0} prenda(s)</span>
                <span class="vl-tcard-monto">${formatearDinero(t.total)}</span>
            </div>
            ${fecha ? `<div class="vl-tcard-linea vl-tcard-fecha">${fecha}</div>` : ''}
            ${fotos.length ? `
                <div class="vl-tcard-fotos">
                    ${fotos.map(f => f.media_url
                        ? `<img src="${escapeHtml(f.media_url)}" alt="Foto que mandó la clienta" loading="lazy">`
                        : '<span class="vl-tcard-foto-vacia"><i class="fas fa-image"></i></span>').join('')}
                    ${totalFotos > fotos.length ? `<span class="vl-tcard-fotos-mas">+${totalFotos - fotos.length}</span>` : ''}
                </div>` : ''}
            ${t.nota_interna ? `<div class="vl-tcard-nota"><i class="fas fa-note-sticky"></i> ${escapeHtml(t.nota_interna)}</div>` : ''}
        </div>`;
}

function etiquetaPago(t) {
    const total = Number(t.total) || 0;
    const saldo = Number(t.saldo) || 0;
    if (total <= 0) return { label: 'sin prendas', color: '#868e96' };
    if (saldo <= 0) return { label: 'pagado', color: '#2b8a3e' };
    if (saldo >= total) return { label: 'sin pagar', color: '#e8590c' };
    return { label: 'pago parcial', color: '#7048e8' };
}

function chipFecha(t) {
    if (t.fecha_programada) {
        return `<i class="fas fa-calendar-day"></i> ${escapeHtml(String(t.fecha_programada))}`;
    }
    if (t.notas) {
        return `<i class="fas fa-comment-dots"></i> dijo: ${escapeHtml(String(t.notas).slice(0, 60))}${String(t.notas).length > 60 ? '…' : ''}`;
    }
    if (t.tipo === 'presencial') return '<span class="vl-tenue"><i class="fas fa-comment-slash"></i> sin fecha todavía</span>';
    if (t.tipo === 'envio') return '<span class="vl-tenue"><i class="fas fa-box"></i> solo envío</span>';
    return '';
}

// ── Arrastrar y soltar (mouse + dedo) ────────────────────────────────────

function bindCardDnD(el) {
    el.addEventListener('dragstart', (e) => {
        if (el.dataset.bloqueada === '1') { e.preventDefault(); return; }
        _dragId = el.dataset.proceso;
        _dragEl = el;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', _dragId);
        el.classList.add('kanban-dragging');
    });
    el.addEventListener('dragend', () => {
        _dragId = null;
        _dragEl = null;
        el.classList.remove('kanban-dragging');
        document.querySelectorAll('.kanban-list-cards').forEach(c => c.classList.remove('kanban-drag-over'));
    });
    bindTouch(el);
}

// En tablet/móvil no existe el drag & drop de HTML5: long-press + deslizar.
function bindTouch(el) {
    el.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
        if (el.dataset.bloqueada === '1') return;
        if (e.target.closest('button, a, input, select, textarea')) return;
        if (_toque) return;
        _toque = {
            el, id: el.dataset.proceso, x0: e.clientX, y0: e.clientY,
            activo: false, vivo: true,
            timer: setTimeout(() => activarToque(e.clientX, e.clientY), 300)
        };
        window.addEventListener('pointermove', onToqueMove, { passive: false });
        window.addEventListener('pointerup', onToqueUp);
        window.addEventListener('pointercancel', onToqueUp);
    });
    el.addEventListener('contextmenu', (e) => { if (_toque && _toque.activo) e.preventDefault(); });
}

function activarToque(x, y) {
    if (!_toque || !_toque.vivo || _toque.activo) return;
    if (Math.hypot(x - _toque.x0, y - _toque.y0) > 14) { cancelarToque(); return; }
    _toque.activo = true;
    _toque.el.classList.add('kanban-dragging');
    _dragId = _toque.id;
    _dragEl = _toque.el;
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) { /* noop */ } }
    window.addEventListener('touchmove', bloquearScroll, { passive: false });
}

function bloquearScroll(e) { if (_toque && _toque.activo) e.preventDefault(); }

function onToqueMove(e) {
    if (!_toque || !_toque.vivo) return;
    const t = _toque;
    if (!t.activo) {
        if (Math.hypot(e.clientX - t.x0, e.clientY - t.y0) > 14) { cancelarToque(); }
        return;
    }
    e.preventDefault();
    const cont = document.elementFromPoint(e.clientX, e.clientY)?.closest('.kanban-list-cards');
    document.querySelectorAll('.kanban-list-cards').forEach(c => c.classList.remove('kanban-drag-over'));
    if (!cont) return;
    cont.classList.add('kanban-drag-over');
    const cards = [...cont.querySelectorAll('.kanban-card:not(.kanban-dragging)')];
    let antes = null;
    for (const card of cards) {
        const r = card.getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) { antes = card; break; }
    }
    if (antes) cont.insertBefore(t.el, antes);
    else cont.appendChild(t.el);
}

function onToqueUp(e) {
    if (!_toque || !_toque.vivo) return;
    const t = _toque;
    clearTimeout(t.timer);
    const fueArrastre = t.activo;
    t.el.classList.remove('kanban-dragging');
    if (fueArrastre) {
        t.el.dataset.suprimirClick = '1';
        const cont = document.elementFromPoint(e.clientX, e.clientY)?.closest('.kanban-list-cards');
        limpiarToque();
        if (cont) soltarEn(t.id, cont.dataset.col, t.el);
        else refrescarEnvios();
        return;
    }
    limpiarToque();
}

function cancelarToque() {
    if (!_toque) return;
    clearTimeout(_toque.timer);
    _toque.vivo = false;
    limpiarToque();
}

function limpiarToque() {
    window.removeEventListener('pointermove', onToqueMove);
    window.removeEventListener('pointerup', onToqueUp);
    window.removeEventListener('pointercancel', onToqueUp);
    window.removeEventListener('touchmove', bloquearScroll);
    _toque = null;
}

function bindColumnas() {
    document.querySelectorAll('#ve-board .kanban-list-cards').forEach(cont => {
        cont.addEventListener('dragover', (e) => {
            if (!_dragId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            document.querySelectorAll('.kanban-list-cards').forEach(c => c.classList.remove('kanban-drag-over'));
            cont.classList.add('kanban-drag-over');
            if (_dragEl) {
                const cards = [...cont.querySelectorAll('.kanban-card:not(.kanban-dragging)')];
                let antes = null;
                for (const card of cards) {
                    const r = card.getBoundingClientRect();
                    if (e.clientY < r.top + r.height / 2) { antes = card; break; }
                }
                if (antes) cont.insertBefore(_dragEl, antes);
                else cont.appendChild(_dragEl);
            }
        });
        cont.addEventListener('dragleave', (e) => {
            if (!cont.contains(e.relatedTarget)) cont.classList.remove('kanban-drag-over');
        });
        cont.addEventListener('drop', (e) => {
            if (!_dragId) return;
            e.preventDefault();
            cont.classList.remove('kanban-drag-over');
            const id = _dragId;
            const el = _dragEl;
            _dragId = null;
            _dragEl = null;
            soltarEn(id, cont.dataset.col, el);
        });
    });
}

async function soltarEn(procesoId, colDestino, el) {
    const t = _tarjetas.find(x => x.proceso_id === procesoId);
    if (!t || !colDestino) { refrescarEnvios(); return; }

    // Mismo lugar: solo se guarda el orden de esa columna.
    if (t.columna === colDestino) {
        const ids = [...el.parentElement.querySelectorAll('.kanban-card')].map(c => c.dataset.proceso);
        const res = await vlApi.tableroOrden(ids);
        if (!res.ok) mostrarToast(res.error || 'No se pudo guardar el orden', 'error');
        return;
    }

    const col = COLUMNAS.find(c => c.id === colDestino);
    if (!col) { refrescarEnvios(); return; }

    // A LISTOS se entra marcando la entrega (el modal ya pide pagado/sin pagar).
    if (colDestino === 'listo') {
        modalMarcarEntregado(procesoParaModales(t), refrescarEnvios);
        return;
    }

    const ok = await confirmar2({
        titulo: `Mover a ${col.titulo}`,
        html: textoMover(t, colDestino),
        boton: 'Sí, mover',
        peligro: colDestino === 'sin_definir'
    });
    if (!ok) { refrescarEnvios(); return; }

    const res = await vlApi.tableroMover(procesoId, colDestino);
    if (!res.ok) {
        mostrarToast(res.error || 'No se pudo mover la tarjeta', 'error');
        refrescarEnvios();
        return;
    }
    mostrarToast(`Movido a ${col.titulo} ✔`, 'success');
    refrescarEnvios();
}

function textoMover(t, destino) {
    const c = t.cliente || {};
    const nick = '@' + escapeHtml(c.tiktok_user || '');
    if (destino === 'presencial') {
        return `<p><b>${nick}</b> queda como <b>entrega presencial</b>. Se quita el courier (solo si el envío no salió todavía).</p>`;
    }
    if (destino === 'sin_definir') {
        return `<p><b>${nick}</b> queda <b>sin forma de entrega</b>. El bot volverá a preguntar cómo lo quiere.</p>
                <p class="vl-tenue">Si el envío ya está en camino, esto no se puede hacer.</p>`;
    }
    if (destino === 'paket') {
        return `<p><b>${nick}</b> se enviará por <b>Paket</b>. Recuerda pedirlo antes de las 23:59 del día anterior.</p>
                <p class="vl-tenue">Esto no marca el envío como creado: eso se hace en la tarjeta.</p>`;
    }
    return `<p><b>${nick}</b> se enviará por <b>Blue Express</b> (se paga al recibir).</p>
            <p class="vl-tenue">Esto no marca el envío como creado: eso se hace en la tarjeta.</p>`;
}

// ── Tarjeta abierta (modal) ──────────────────────────────────────────────

function abrirFicha(procesoId, silencioso = false) {
    const t = _tarjetas.find(x => x.proceso_id === procesoId);
    if (!t) { cerrarFicha(true); return; }

    _fichaAbierta = procesoId;

    let ov = document.querySelector('.vl-card-overlay');
    const primeraVez = !ov;
    if (primeraVez) {
        ov = document.createElement('div');
        ov.className = 'kanban-card-overlay vl-card-overlay';
        document.body.appendChild(ov);
    }
    _fichaSucio = false;

    const c = t.cliente || {};
    const pago = etiquetaPago(t);
    const bloqueada = t.cerrado || t.columna === 'listo';
    const items = Array.isArray(t.items) ? t.items : [];
    const fotos = Array.isArray(t.fotos) ? t.fotos : [];

    ov.innerHTML = `
        <div class="kanban-card-modal vl-card-modal" role="dialog" aria-modal="true">
            <header class="kanban-card-modal-header">
                <div class="vl-card-cab">
                    <div class="vl-card-avatar"><i class="fas fa-user"></i></div>
                    <div class="vl-card-cab-txt">
                        <h4>@${escapeHtml(c.tiktok_user || '?')}${c.nombre_real ? ' · ' + escapeHtml(c.nombre_real) : ''}</h4>
                        <div class="vl-card-cab-sub">
                            ${Number(t.prendas) || 0} prenda(s) · ${formatearDinero(t.total)}
                            ${Number(t.saldo) > 0 ? ' · debe ' + formatearDinero(t.saldo) : ''}
                        </div>
                    </div>
                </div>
                <button class="kanban-btn-close" id="vc-cerrar" type="button" title="Cerrar"><i class="fas fa-times"></i></button>
            </header>

            <div class="kanban-card-form">
                <div class="vl-card-chips">
                    ${t.columna === 'listo'
                        ? `<span class="kanban-chip" style="background:#2b8a3e;">entregado</span>`
                        : `<span class="kanban-chip" style="background:${pago.color};">${escapeHtml(pago.label)}</span>`}
                    ${t.columna === 'listo' && Number(t.saldo) > 0
                        ? `<span class="kanban-chip" style="background:#e8590c;">falta cobrar ${formatearDinero(t.saldo)}</span>` : ''}
                    <span class="kanban-chip" style="background:#495057;">${escapeHtml(nombreColumna(t.columna))}</span>
                    ${t.envio_estado === 'en_proceso' ? '<span class="kanban-chip" style="background:#7048e8;">en camino</span>' : ''}
                    ${(t.etiquetas || []).map(et => `<span class="kanban-chip" style="background:${(ETIQUETAS.find(e => e.t === et) || {}).c || '#495057'};">${escapeHtml(et)}</span>`).join('')}
                </div>

                <div class="vl-card-acciones">
                    <button class="vl-btn" id="vc-chat" type="button"><i class="fas fa-comments"></i> Ver chat</button>
                    <button class="vl-btn" data-copiar="${encodeURIComponent(datosEnvioTexto(t))}" type="button" title="Nombre, teléfono, correo y dirección para pegar en el courier"><i class="fas fa-clipboard-list"></i> Copiar datos</button>
                    ${t.empresa && EMPRESA_SITIOS[t.empresa]
                        ? `<button class="vl-btn" data-abrir="${EMPRESA_SITIOS[t.empresa]}" type="button"><i class="fas fa-external-link-alt"></i> ${escapeHtml(EMPRESA_LABEL[t.empresa])}</button>` : ''}
                    ${accionesRealesHTML(t)}
                </div>

                <div class="vl-card-grid">
                    <section class="vl-card-seccion">
                        <label class="kanban-seccion-label"><i class="fas fa-bag-shopping"></i> El pedido</label>
                        <div class="vl-card-items" id="vc-items">
                            ${items.length ? items.map(itemHTML).join('') : '<p class="vl-tenue">Sin prendas en este pedido.</p>'}
                        </div>
                        <div class="vl-card-totales">
                            <span>Total <b>${formatearDinero(t.total)}</b></span>
                            <span>Pagado <b>${formatearDinero(Number(t.total) - Number(t.saldo))}</b></span>
                            <span class="${Number(t.saldo) > 0 ? 'vl-res-ambar' : ''}">Saldo <b>${formatearDinero(t.saldo)}</b></span>
                        </div>
                        <div class="vl-card-datos-auto">
                            <div><i class="fas fa-truck-fast"></i> ${escapeHtml(nombreColumna(t.columna))}${t.courier && t.courier !== 'otros' ? ' · ' + escapeHtml(t.courier === 'blue' ? 'Blue' : 'Paket') : ''}</div>
                            ${t.fecha_programada ? `<div><i class="fas fa-calendar-day"></i> ${escapeHtml(String(t.fecha_programada))}</div>` : ''}
                            ${t.notas ? `<div><i class="fas fa-comment-dots"></i> dijo: ${escapeHtml(String(t.notas))}</div>` : ''}
                            ${!t.fecha_programada && !t.notas && t.tipo === 'envio' ? '<div><i class="fas fa-box"></i> solo envío (no dijo fecha)</div>' : ''}
                            ${!t.fecha_programada && !t.notas && t.tipo === 'presencial' ? '<div><i class="fas fa-comment-slash"></i> sin fecha todavía</div>' : ''}
                            ${t.tracking ? `<div><i class="fas fa-barcode"></i> ${escapeHtml(t.tracking)}</div>` : ''}
                            ${c.datos_envio ? `<div><i class="fas fa-clipboard"></i> escribió: ${escapeHtml(String(c.datos_envio))}</div>` : ''}
                        </div>
                    </section>

                    <section class="vl-card-seccion">
                        <label class="kanban-seccion-label"><i class="fas fa-address-card"></i> Datos (los leyó el chat)</label>
                        <div class="vl-card-form-campo"><span>Nombre</span><input id="vc-nombre" type="text" value="${escapeHtml(c.nombre_real || '')}" placeholder="Sin nombre"></div>
                        <div class="vl-card-form-campo"><span>WhatsApp</span><input id="vc-whatsapp" type="tel" value="${escapeHtml(c.whatsapp || '')}" placeholder="Sin número"></div>
                        <div class="vl-card-form-campo"><span>Correo</span><input id="vc-correo" type="email" value="${escapeHtml(c.correo || '')}" placeholder="Sin correo"></div>
                        <div class="vl-card-form-campo"><span>Dirección</span><input id="vc-direccion" type="text" value="${escapeHtml(c.direccion || '')}" placeholder="Sin dirección"></div>
                        <div class="vl-card-form-fila">
                            <div class="vl-card-form-campo"><span>Comuna</span><input id="vc-comuna" type="text" value="${escapeHtml(c.comuna || '')}"></div>
                            <div class="vl-card-form-campo"><span>Ciudad</span><input id="vc-ciudad" type="text" value="${escapeHtml(c.ciudad || '')}"></div>
                        </div>
                        <button class="vl-btn success vl-card-guardar-datos" id="vc-guardar-datos" type="button">
                            <i class="fas fa-floppy-disk"></i> Guardar datos
                        </button>
                        <p class="kanban-hint"><i class="fas fa-circle-info"></i> Si el bot leyó algo mal, se corrige acá. Te va a pedir confirmación.</p>
                    </section>
                </div>

                <section class="vl-card-seccion">
                    <label class="kanban-seccion-label"><i class="fas fa-images"></i> Fotos que mandó (${fotos.length})</label>
                    ${fotos.length ? `
                        <div class="vl-card-fotos" id="vc-fotos">
                            ${fotos.map(f => `
                                <div class="vl-card-foto" data-mensaje="${f.mensaje_id}">
                                    ${f.media_url
                                        ? `<a href="${escapeHtml(f.media_url)}" target="_blank" rel="noopener"><img src="${escapeHtml(f.media_url)}" alt="Foto que mandó la clienta" loading="lazy"></a>`
                                        : '<span class="vl-card-foto-vacia"><i class="fas fa-image"></i></span>'}
                                    <button class="vl-card-foto-del" type="button" title="Borrar esta foto" data-mensaje="${f.mensaje_id}"><i class="fas fa-xmark"></i></button>
                                </div>`).join('')}
                        </div>`
                        : '<p class="vl-tenue">No mandó fotos por WhatsApp (o ya se borraron).</p>'}
                </section>

                <section class="vl-card-seccion">
                    <label class="kanban-seccion-label"><i class="fas fa-tags"></i> Etiquetas</label>
                    <div class="vl-card-etiquetas" id="vc-etiquetas">
                        ${ETIQUETAS.map(e => `
                            <button class="vl-etq ${(t.etiquetas || []).includes(e.t) ? 'activa' : ''}"
                                    type="button" data-etq="${escapeHtml(e.t)}" style="--etq:${e.c};">
                                ${escapeHtml(e.t)}
                            </button>`).join('')}
                    </div>
                    <label class="kanban-seccion-label vl-card-nota-label"><i class="fas fa-note-sticky"></i> Nota interna</label>
                    <textarea id="vc-nota" rows="3" placeholder="Algo que quieras recordar de esta clienta…">${escapeHtml(t.nota_interna || '')}</textarea>
                    <button class="vl-btn success vl-card-guardar-nota" id="vc-guardar-nota" type="button">
                        <i class="fas fa-floppy-disk"></i> Guardar etiquetas y nota
                    </button>
                </section>

                <div class="kanban-card-actions">
                    <button class="btn-danger" id="vc-eliminar" type="button"><i class="fas fa-trash"></i> Eliminar compra</button>
                    <button class="btn-primary" id="vc-cerrar2" type="button"><i class="fas fa-check"></i> Listo</button>
                </div>
            </div>
        </div>`;

    // Capa propia ('vl-card'): los modales de acciones usan 'vl-modal' y así
    // el atrás va cerrando uno por uno, de arriba hacia abajo.
    if (primeraVez) abrirCapa('vl-card', () => cerrarFicha());

    // Cerrar (con guardia de cambios sin guardar)
    ov.querySelector('#vc-cerrar').addEventListener('click', () => cerrarFicha());
    ov.querySelector('#vc-cerrar2').addEventListener('click', () => cerrarFicha());
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) cerrarFicha(); });

    // Datos leídos del chat: guardar con confirmación (2 toques)
    ov.querySelector('#vc-guardar-datos').addEventListener('click', () => guardarDatos(t));
    ['vc-nombre', 'vc-whatsapp', 'vc-correo', 'vc-direccion', 'vc-comuna', 'vc-ciudad', 'vc-nota']
        .forEach(id => ov.querySelector('#' + id)?.addEventListener('input', () => { _fichaSucio = true; }));

    // Etiquetas
    ov.querySelectorAll('.vl-etq').forEach(btn => {
        btn.addEventListener('click', () => { btn.classList.toggle('activa'); _fichaSucio = true; });
    });
    ov.querySelector('#vc-guardar-nota').addEventListener('click', () => guardarEtiquetas(t));

    // Fotos: borrar con doble confirmación
    ov.querySelectorAll('.vl-card-foto-del').forEach(btn => {
        btn.addEventListener('click', () => borrarFoto(btn.dataset.mensaje));
    });

    // Prendas: editar descripción/precio (sin pagos)
    ov.querySelectorAll('.vl-item-editar').forEach(btn => {
        btn.addEventListener('click', () => editarItem(t, btn.dataset.item));
    });

    // Acciones reales
    ov.querySelector('#vc-chat').addEventListener('click', async () => {
        cerrarFicha(true);
        const ok = await abrirChatDeUsuario((t.cliente || {}).tiktok_user);
        if (!ok) mostrarToast('No encontré ese chat', 'warning');
    });
    ov.querySelectorAll('button[data-copiar]').forEach(btn => {
        btn.addEventListener('click', () => copiar(btn.dataset.copiar));
    });
    ov.querySelectorAll('button[data-abrir]').forEach(btn => {
        btn.addEventListener('click', () => window.open(btn.dataset.abrir, '_blank', 'noopener'));
    });
    ov.querySelectorAll('button[data-acc]').forEach(btn => {
        btn.addEventListener('click', () => accionReal(t, btn));
    });
    ov.querySelector('#vc-eliminar').addEventListener('click', () => accionReal(t, ov.querySelector('[data-acc="eliminar"]') || { dataset: { acc: 'eliminar' } }));
}

function nombreColumna(id) {
    return (COLUMNAS.find(c => c.id === id) || {}).titulo || 'Sin definir';
}

function itemHTML(i) {
    const estado = i.estado === 'pagada' ? 'pagada' : i.estado === 'entregada' ? 'entregada' : 'sin pagar';
    return `<div class="vl-item">
        <div class="vl-item-txt">
            <div class="vl-item-desc">${escapeHtml(i.descripcion || 'Prenda')}</div>
            <div class="vl-item-sub">${estado}${Number(i.abonado) > 0 ? ' · abonado ' + formatearDinero(i.abonado) : ''}</div>
        </div>
        <div class="vl-item-precio">${formatearDinero(i.precio)}</div>
        ${Number(i.abonado) === 0 && i.estado === 'adjudicada'
            ? `<button class="vl-item-editar" type="button" data-item="${i.id}" title="Corregir prenda"><i class="fas fa-pen"></i></button>`
            : ''}
    </div>`;
}

function datosEnvioTexto(t) {
    const c = t.cliente || {};
    return [
        (c.nombre_real || ('@' + (c.tiktok_user || ''))),
        '@' + (c.tiktok_user || ''),
        c.whatsapp || c.contacto || '',
        c.correo || '',
        [c.direccion, c.comuna, c.ciudad].filter(Boolean).join(', '),
        (t.empresa ? 'Courier: ' + (EMPRESA_LABEL[t.empresa] || t.empresa) : '')
    ].filter(Boolean).join('\n');
}

function procesoParaModales(t) {
    return {
        proceso_id: t.proceso_id,
        estado: t.proceso_estado,
        saldo: t.saldo,
        prendas: t.prendas,
        envio: t,
        cliente: { cliente_id: t.cliente_id, tiktok_user: (t.cliente || {}).tiktok_user }
    };
}

function accionesRealesHTML(t) {
    const saldo = Number(t.saldo || 0);
    const bloqueada = t.cerrado || t.columna === 'listo';
    let html = '';
    if (bloqueada) return html;
    if (t.accion === 'entregado') {
        html += `<button class="vl-btn success" data-acc="entregado" type="button"><i class="fas fa-check-circle"></i> ${t.tipo === 'presencial' ? 'Ya lo entregué' : 'Ya lo envié / entregué'}</button>`;
    } else if (t.accion === 'crear_envio') {
        html += '<button class="vl-btn success" data-acc="crear-envio" type="button"><i class="fas fa-truck-fast"></i> Envío creado</button>';
    } else if (t.accion === 'pagar') {
        const porCobrar = t.proceso_estado === 'entregado_por_cobrar';
        html += `<button class="vl-btn success" data-acc="pagar" type="button"><i class="fas fa-hand-holding-dollar"></i> ${porCobrar ? 'Cobrar saldo' : 'Registrar pago'}</button>`;
    }
    if (t.tipo && t.tipo !== '' && t.accion !== 'decidir_entrega') {
        const destino = t.tipo === 'presencial' ? 'envio' : 'presencial';
        html += `<button class="vl-btn" data-acc="corregir" data-tipo="${destino}" type="button" title="Corregir el tipo de entrega si el bot se equivocó"><i class="fas fa-right-left"></i> ${destino === 'envio' ? 'Es envío' : 'Es presencial'}</button>`;
    }
    if (saldo > 0) {
        html += '<button class="vl-btn success" data-acc="pagar-items" type="button"><i class="fas fa-money-bill-wave"></i> Pagar prendas</button>';
        html += '<button class="vl-btn danger" data-acc="liberar" type="button"><i class="fas fa-unlock"></i> Liberar prenda</button>';
    }
    return html;
}

function accionReal(t, btn) {
    const acc = btn.dataset.acc;
    const proceso = procesoParaModales(t);
    const alCerrar = () => { cerrarFicha(true); refrescarEnvios(); };
    if (acc === 'crear-envio') { modalCrearEnvio(proceso, alCerrar); return; }
    if (acc === 'entregado') { modalMarcarEntregado(proceso, alCerrar); return; }
    if (acc === 'pagar') { modalConfirmarPago(proceso, alCerrar); return; }
    if (acc === 'pagar-items') { modalPagarItems(proceso, alCerrar); return; }
    if (acc === 'liberar') { modalLiberarItems(proceso, alCerrar); return; }
    if (acc === 'eliminar') { modalEliminarCompra(proceso, alCerrar); return; }
    if (acc === 'corregir') { modalCorregirEntrega(proceso, btn.dataset.tipo, alCerrar); return; }
}

async function guardarDatos(t) {
    const ov = document.querySelector('.vl-card-overlay');
    if (!ov) return;
    const val = (id) => (ov.querySelector('#' + id)?.value || '').trim();
    const c = t.cliente || {};
    const datos = {
        p_cliente_id: t.cliente_id,
        p_nombre_real: val('vc-nombre'),
        p_whatsapp: val('vc-whatsapp'),
        p_correo: val('vc-correo'),
        p_direccion: val('vc-direccion'),
        p_comuna: val('vc-comuna'),
        p_ciudad: val('vc-ciudad')
    };
    const igual = datos.p_nombre_real === (c.nombre_real || '')
        && datos.p_whatsapp === (c.whatsapp || '')
        && datos.p_correo === (c.correo || '')
        && datos.p_direccion === (c.direccion || '')
        && datos.p_comuna === (c.comuna || '')
        && datos.p_ciudad === (c.ciudad || '');
    if (igual) { mostrarToast('No cambiaste ningún dato', 'warning'); return; }

    const ok = await confirmar2({
        titulo: 'Cambiar datos de la clienta',
        html: `<p>Estos datos los leyó el bot del chat. Si los corriges, el bot usará los nuevos para la entrega y el courier.</p>
               <p class="vl-tenue">Se guarda en la ficha de la clienta, no se le escribe nada.</p>`,
        boton: 'Sí, guardar'
    });
    if (!ok) return;

    const res = await vlApi.actualizarCliente(datos);
    if (!res.ok) { mostrarToast(res.error || 'No se pudo guardar', 'error'); return; }
    mostrarToast('Datos guardados ✔', 'success');
    _fichaSucio = false;
    await refrescarEnvios();
}

async function guardarEtiquetas(t) {
    const ov = document.querySelector('.vl-card-overlay');
    if (!ov) return;
    const etiquetas = [...ov.querySelectorAll('.vl-etq.activa')].map(b => b.dataset.etq);
    const nota = (ov.querySelector('#vc-nota')?.value || '').trim();
    const igual = JSON.stringify(etiquetas) === JSON.stringify(t.etiquetas || []) && nota === (t.nota_interna || '');
    if (igual) { mostrarToast('No cambiaste nada', 'warning'); return; }

    const res = await vlApi.tableroTarjeta(t.proceso_id, etiquetas, nota);
    if (!res.ok) { mostrarToast(res.error || 'No se pudo guardar', 'error'); return; }
    mostrarToast('Tarjeta guardada ✔', 'success');
    _fichaSucio = false;
    await refrescarEnvios();
}

async function borrarFoto(mensajeId) {
    const ok = await confirmar2({
        titulo: 'Borrar esta foto',
        html: `<p>La foto se quita del chat y de la tarjeta. <b>No se puede deshacer.</b></p>
               <p class="vl-tenue">El mensaje de WhatsApp queda en el historial solo si tenía texto.</p>`,
        boton: 'Sí, borrar foto',
        peligro: true
    });
    if (!ok) return;

    const res = await vlApi.borrarMediaMensaje(mensajeId);
    if (!res.ok) { mostrarToast(res.error || 'No se pudo borrar', 'error'); return; }

    // Borrar también el archivo (mejor esfuerzo: si falla, queda invisible).
    const path = res.data && res.data.media_path;
    const supabase = getSupabase();
    if (path && supabase) {
        try { await supabase.storage.from('vl-media').remove([path]); } catch (_) { /* sin permiso: se deja */ }
    }
    mostrarToast('Foto borrada ✔', 'success');
    _fichaSucio = false;
    await refrescarEnvios();
}

async function editarItem(t, itemId) {
    const ov = document.querySelector('.vl-card-overlay');
    const item = (t.items || []).find(i => i.id === itemId);
    if (!ov || !item) return;
    const fila = ov.querySelector(`.vl-item-editar[data-item="${itemId}"]`)?.closest('.vl-item');
    if (!fila) return;

    fila.innerHTML = `
        <div class="vl-item-edit">
            <input class="vl-item-edit-desc" type="text" value="${escapeHtml(item.descripcion || '')}" placeholder="Qué es la prenda">
            <input class="vl-item-edit-precio" type="number" min="1" step="1" value="${Number(item.precio) || ''}" placeholder="Precio">
            <div class="vl-item-edit-acc">
                <button class="vl-btn" data-cancelar="1" type="button">Cancelar</button>
                <button class="vl-btn success" data-ok="1" type="button">Guardar</button>
            </div>
        </div>`;
    fila.querySelector('[data-cancelar]').addEventListener('click', () => abrirFicha(t.proceso_id, true));
    fila.querySelector('[data-ok]').addEventListener('click', async () => {
        const desc = fila.querySelector('.vl-item-edit-desc').value.trim();
        const precio = Number(fila.querySelector('.vl-item-edit-precio').value);
        if (!desc || !(precio > 0)) { mostrarToast('Escribe la prenda y un precio válido', 'warning'); return; }
        const ok = await confirmar2({
            titulo: 'Corregir la prenda',
            html: `<p><b>${escapeHtml(desc)}</b> · ${formatearDinero(precio)}</p>
                   <p class="vl-tenue">Cambia el total del pedido (y lo que falta cobrar). Solo se puede si todavía no hay pagos registrados.</p>`,
            boton: 'Sí, corregir'
        });
        if (!ok) return;
        const res = await vlApi.itemEditar(itemId, desc, precio);
        if (!res.ok) { mostrarToast(res.error || 'No se pudo corregir', 'error'); return; }
        mostrarToast('Prenda corregida ✔', 'success');
        _fichaSucio = false;
        await refrescarEnvios();
    });
}

// ── Cerrar la tarjeta ────────────────────────────────────────────────────

function cerrarFicha(forzar = false) {
    const ov = document.querySelector('.vl-card-overlay');
    if (!ov) { _fichaAbierta = null; return true; }
    if (!forzar && _fichaSucio) {
        confirmar2({
            titulo: 'Hay cambios sin guardar',
            html: '<p>¿Cerrar la tarjeta y descartar lo que escribiste?</p>',
            boton: 'Sí, descartar',
            peligro: true
        }).then(ok => { if (ok) cerrarFicha(true); });
        return false;
    }
    ov.remove();
    _fichaAbierta = null;
    _fichaSucio = false;
    consumirCapa('vl-card');
    return true;
}

// Escape cierra la tarjeta (los modales de acciones tienen prioridad: usan
// captura y frenan la propagación).
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!document.querySelector('.vl-card-overlay')) return;
    if (document.querySelector('.vl-modal-overlay')) return;
    e.preventDefault();
    cerrarFicha();
});

// ── Confirmación en dos toques ──────────────────────────────────────────

function confirmar2({ titulo, html, boton = 'Sí, continuar', peligro = false }) {
    return new Promise(resolve => {
        const ov = document.createElement('div');
        ov.className = 'vl-confirm-overlay';
        ov.innerHTML = `
            <div class="vl-confirm" role="alertdialog" aria-modal="true">
                <h4>${escapeHtml(titulo)}</h4>
                ${html || ''}
                <div class="vl-confirm-acciones">
                    <button class="vl-btn" data-r="0" type="button">Cancelar</button>
                    <button class="vl-btn ${peligro ? 'danger' : 'success'}" data-r="1" type="button">${escapeHtml(boton)}</button>
                </div>
            </div>`;
        const cerrar = (v) => {
            ov.remove();
            document.removeEventListener('keydown', key, true);
            resolve(v);
        };
        const key = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cerrar(false); }
        };
        ov.addEventListener('click', (e) => {
            if (e.target === ov) return cerrar(false);
            const b = e.target.closest('button[data-r]');
            if (b) cerrar(b.dataset.r === '1');
        });
        document.addEventListener('keydown', key, true);
        document.body.appendChild(ov);
    });
}

// ── Utilidades ──────────────────────────────────────────────────────────

async function copiar(texto) {
    const valor = decodeURIComponent(texto);
    if (!valor) { mostrarToast('No hay dato para copiar', 'warning'); return; }
    try {
        await navigator.clipboard.writeText(valor);
        mostrarToast('Copiado ✔', 'success');
    } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = valor;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); mostrarToast('Copiado ✔', 'success'); }
        catch (err) { mostrarToast('No se pudo copiar', 'error'); }
        ta.remove();
    }
}
