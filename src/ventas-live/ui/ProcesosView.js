// ventas-live/ui/ProcesosView.js
// Panel de procesos activos (spec §18): grupos por estado con conteos
// y acciones directas por fila. El agrupado derivado (pagado/acumulando
// con saldo > 0 → esperando pago, etc.) lo resuelve el servidor en
// vl_panel_procesos.

import { vlApi, ESTADO_INFO } from '../domain/vlApi.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { formatearDinero, escapeHtml } from '../../shared/infrastructure/formatters.js';
import {
    modalConfirmarPago, modalPagaraPresencial, modalDecisionEntrega,
    modalCrearEnvio, modalMarcarEntregado, modalLiberarItems
} from './accionesProceso.js';

// Orden y etiquetas de los grupos del panel
const GRUPOS = [
    { g: 'esperando_whatsapp',  l: '🟡 Esperando WhatsApp', color: '#ffd43b' },
    { g: 'esperando_pago',      l: '🟠 Esperando pago', color: '#ffa94d' },
    { g: 'pago_parcial',        l: '🟣 Pago parcial', color: '#da77f2' },
    { g: 'pagara_presencial',   l: '🔵 Pagará presencial', color: '#74c0fc' },
    { g: 'pagado_sin_decision', l: '🟢 Pagado · falta decidir', color: '#69db7c' },
    { g: 'acumulando',          l: '🛍️ Acumulando', color: '#38d9a9' },
    { g: 'listo_preparar',      l: '📦 Listo para preparar', color: '#4dabf7' },
    { g: 'envio_programado',    l: '📅 Envío programado', color: '#748ffc' },
    { g: 'envio_proceso',       l: '🚚 Envío en proceso', color: '#9775fa' },
    { g: 'entrega_presencial',  l: '🤝 Entrega presencial', color: '#e599f7' }
];

let _built = false;
let _conteos = {};
let _procesos = [];
let _grupoSel = null;

function $(id) { return document.getElementById(id); }

export function initProcesos() {
    const cont = $('vl-view-procesos');
    if (!_built) {
        cont.innerHTML = `
            <div class="vl-chips" id="vp-chips"></div>
            <div id="vp-lista"></div>`;
        _built = true;
    }
    refrescarProcesos();
}

async function refrescarProcesos() {
    const cont = $('vl-view-procesos');
    const res = await vlApi.panelProcesos();
    if (!res.ok) {
        cont.innerHTML = '<div class="vl-empty">No se pudo cargar el panel: ' + escapeHtml(res.error || 'error') + '</div>';
        return;
    }
    _conteos = res.data.conteos || {};
    _procesos = res.data.procesos || [];

    // Grupo seleccionado: conserva el actual si sigue existiendo; si no,
    // el primero con procesos.
    const conProcesos = GRUPOS.filter(g => (_conteos[g.g] || 0) > 0);
    if (!_grupoSel || !conProcesos.some(g => g.g === _grupoSel)) {
        _grupoSel = conProcesos.length ? conProcesos[0].g : null;
    }
    pintarChips();
    pintarLista();
}

function pintarChips() {
    const chips = $('vp-chips');
    if (!chips) return;
    const conProcesos = GRUPOS.filter(g => (_conteos[g.g] || 0) > 0);
    if (!conProcesos.length) {
        chips.innerHTML = '<div class="vl-empty" style="padding:10px;">Sin procesos activos 🎉 Todo al día.</div>';
        return;
    }
    chips.innerHTML = conProcesos.map(g => `
        <button class="vl-chip ${g.g === _grupoSel ? 'active' : ''}" data-g="${g.g}" type="button">
            <span>${g.l}</span><span class="n">${_conteos[g.g]}</span>
        </button>`).join('');
    chips.querySelectorAll('.vl-chip').forEach(c => {
        c.addEventListener('click', () => {
            _grupoSel = c.dataset.g;
            pintarChips();
            pintarLista();
        });
    });
}

function pintarLista() {
    const lista = $('vp-lista');
    if (!lista) return;
    const filas = _procesos.filter(p => p.grupo === _grupoSel);
    if (!filas.length) {
        lista.innerHTML = '<div class="vl-empty">No hay procesos en este grupo.</div>';
        return;
    }
    lista.innerHTML = filas.map(p => filaHTML(p)).join('');
    filas.forEach(p => {
        const row = lista.querySelector(`[data-proceso="${p.proceso_id}"]`);
        if (!row) return;
        bindAcciones(row, p);
    });
}

function filaHTML(p) {
    const c = p.cliente || {};
    const info = ESTADO_INFO[p.estado] || { label: p.estado };
    const color = (GRUPOS.find(g => g.g === p.grupo) || {}).color || '#adb5bd';
    const edad = Number(p.dias_espera || 0);
    const warn = p.grupo === 'esperando_whatsapp' && edad >= 3;
    const envio = p.envio || {};
    const detalle = [
        envio.fecha_programada ? '📅 ' + envio.fecha_programada : null,
        envio.empresa ? '🚚 ' + envio.empresa : null,
        envio.tracking ? '#' + envio.tracking : null
    ].filter(Boolean).join(' · ');

    return `
        <div class="vl-fila" data-proceso="${p.proceso_id}">
            <div style="min-width:170px;">
                <div class="f-nick">@${escapeHtml(c.tiktok_user || '?')}</div>
                <div class="f-sub">
                    <span style="color:${color};">${info.label}</span>
                    ${c.nombre_real ? ' · ' + escapeHtml(c.nombre_real) : ''}
                    ${c.whatsapp ? ' · ' + escapeHtml(c.whatsapp) : ''}
                </div>
                <div class="f-sub" style="margin-top:3px;">
                    ${p.grupo === 'esperando_whatsapp'
                        ? (warn
                            ? `<span class="vl-edad-warn">⚠️ sin contacto hace ${edad} día(s)</span>`
                            : `<span>sin contacto hace ${edad} día(s)</span>`)
                        : (detalle || '')}
                </div>
            </div>
            <div class="f-der">
                <div class="f-datos">
                    <span>Prendas <b>${p.prendas}</b></span>
                    <span>Debe <b>${formatearDinero(p.saldo)}</b></span>
                </div>
                <div class="vl-acciones">${accionesHTML(p)}</div>
            </div>
        </div>`;
}

function accionesHTML(p) {
    const g = p.grupo;
    const fichar = `<button class="vl-btn" data-acc="ficha" type="button"><i class="fas fa-id-card"></i> Ficha</button>`;
    if (g === 'esperando_whatsapp') {
        return `
            <button class="vl-btn primary" data-acc="espera-pago" type="button">Marcar esperando pago</button>
            <button class="vl-btn danger" data-acc="liberar" type="button">Liberar</button>
            ${fichar}`;
    }
    if (g === 'esperando_pago' || g === 'pago_parcial' || g === 'pagara_presencial') {
        return `
            <button class="vl-btn success" data-acc="pago" type="button"><i class="fas fa-hand-holding-dollar"></i> Confirmar pago</button>
            ${g !== 'pagara_presencial' ? `<button class="vl-btn" data-acc="presencial" type="button">Pagará presencial</button>` : ''}
            <button class="vl-btn danger" data-acc="liberar" type="button">Liberar</button>
            ${fichar}`;
    }
    if (g === 'pagado_sin_decision' || g === 'acumulando') {
        return `
            <button class="vl-btn primary" data-acc="decision" type="button"><i class="fas fa-box-open"></i> Decidir entrega</button>
            ${fichar}`;
    }
    if (g === 'listo_preparar' || g === 'envio_programado') {
        return `
            <button class="vl-btn success" data-acc="crear-envio" type="button"><i class="fas fa-truck-fast"></i> ENVÍO CREADO</button>
            ${fichar}`;
    }
    if (g === 'envio_proceso' || g === 'entrega_presencial') {
        return `
            <button class="vl-btn success" data-acc="entregado" type="button"><i class="fas fa-check-circle"></i> Marcar entregado</button>
            ${fichar}`;
    }
    return fichar;
}

function bindAcciones(row, p) {
    row.querySelectorAll('button[data-acc]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const acc = btn.dataset.acc;
            if (acc === 'ficha') { irAFicha(p.cliente.cliente_id); return; }
            if (acc === 'espera-pago') marcarEsperandoPago(p);
            if (acc === 'pago') modalConfirmarPago(p, refrescarProcesos);
            if (acc === 'presencial') modalPagaraPresencial(p, refrescarProcesos);
            if (acc === 'liberar') modalLiberarItems(p, refrescarProcesos);
            if (acc === 'decision') modalDecisionEntrega(p, refrescarProcesos);
            if (acc === 'crear-envio') modalCrearEnvio(p, refrescarProcesos);
            if (acc === 'entregado') modalMarcarEntregado(p, refrescarProcesos);
        });
    });
}

async function marcarEsperandoPago(p) {
    const res = await vlApi.marcarEsperandoPago(p.proceso_id);
    if (!res.ok) { mostrarToast(res.error || 'No se pudo actualizar', 'error'); return; }
    mostrarToast('Cliente en espera de pago', 'success');
    refrescarProcesos();
}

function irAFicha(clienteId) {
    if (typeof window.__vlIrAFicha === 'function') {
        window.__vlIrAFicha(clienteId);
    }
}
