// ventas-live/ui/FinanzasView.js
// Finanzas (spec §24): ingresos (ventas/recibido/pendiente),
// inversión, gastos y resultado. Diferencia explícita entre
// ganancia ESTIMADA (sin costo unitario por prenda) y flujo de caja.
// Alta y eliminación de inversiones/gastos.

import { vlApi } from '../domain/vlApi.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { formatearDinero, escapeHtml } from '../../shared/infrastructure/formatters.js';
import { abrirModal, cerrarModal } from './vlModales.js';

let _built = false;

function $(id) { return document.getElementById(id); }

export function initFinanzas() {
    const cont = $('vl-view-finanzas');
    if (!_built) {
        cont.innerHTML = `
            <div id="vf-resumen"></div>
            <div class="vl-card" style="margin-top:16px;">
                <h2><i class="fas fa-plus-circle"></i> Registrar inversión o gasto</h2>
                <div class="sub">Inversión = compra de mercadería. Gasto = transporte, materiales, envíos asumidos, etc.</div>
                <div style="display:grid;grid-template-columns:130px 1fr 140px 150px 200px auto;gap:10px;align-items:end;" class="vf-form-grid">
                    <div class="vl-form-row" style="margin:0;">
                        <label for="vf2-tipo">Tipo</label>
                        <select class="vl-control" id="vf2-tipo">
                            <option value="inversion">Inversión</option>
                            <option value="gasto">Gasto</option>
                        </select>
                    </div>
                    <div class="vl-form-row" style="margin:0;">
                        <label for="vf2-concepto">Concepto</label>
                        <input class="vl-control" id="vf2-concepto" placeholder="Ej: compra de ropa lote 8">
                    </div>
                    <div class="vl-form-row" style="margin:0;">
                        <label for="vf2-monto">Monto ($)</label>
                        <input class="vl-control" id="vf2-monto" inputmode="numeric" placeholder="0">
                    </div>
                    <div class="vl-form-row" style="margin:0;">
                        <label for="vf2-fecha">Fecha</label>
                        <input class="vl-control" id="vf2-fecha" type="date">
                    </div>
                    <div class="vl-form-row" style="margin:0;">
                        <label for="vf2-live">¿A qué LIVE?</label>
                        <select class="vl-control" id="vf2-live">
                            <option value="">Sin LIVE (general)</option>
                        </select>
                    </div>
                    <button class="vl-btn primary" id="vf2-agregar" type="button" style="margin-bottom:2px;"><i class="fas fa-plus"></i> Agregar</button>
                </div>
                <div style="font-size:0.72rem;color:var(--muted,#adb5bd);margin-top:8px;">
                    Formato del monto flexible: escribe 15000 o 15.000. Si eliges un LIVE,
                    esa inversión/gasto se descuenta solo de ESE live (así ves si dejó plata).
                </div>
            </div>
            <div id="vf-por-live"></div>
            <div id="vf-lista"></div>`;
        _built = true;
        const hoy = new Date().toISOString().slice(0, 10);
        $('vf2-fecha').value = hoy;
        $('vf2-agregar').addEventListener('click', agregarGasto);
        $('vf2-concepto').addEventListener('keydown', (e) => { if (e.key === 'Enter') agregarGasto(); });
        $('vf2-monto').addEventListener('keydown', (e) => { if (e.key === 'Enter') agregarGasto(); });
    }
    refrescarFinanzas();
}

async function refrescarFinanzas() {
    const res = await vlApi.finanzasResumen();
    if (!res.ok) {
        $('vf-resumen').innerHTML = '<div class="vl-empty">No se pudo cargar: ' + escapeHtml(res.error || 'error') + '</div>';
        return;
    }
    pintarResumen(res.data);
    pintarSelectorLives(res.data.lives_disponibles || []);
    pintarPorLive(res.data);
    pintarLista(res.data.ultimos_gastos || []);
}

function cardFin(k, v, cls = '', nota = '') {
    return `
        <div class="vl-cstat2" style="grid-column:span 1;">
            <div class="vl-fin-k">${k}</div>
            <div class="vl-fin-v ${cls}">${v}</div>
            ${nota ? `<div class="vl-nota">${nota}</div>` : ''}
        </div>`;
}

function pintarResumen(d) {
    const ing = d.ingresos || {};
    const inv = d.inversiones || {};
    const gas = d.gastos || {};
    const res = d.resultado || {};
    const ganancia = Number(res.ganancia_estimada || 0);
    const flujo = Number(res.flujo_caja || 0);

    $('vf-resumen').innerHTML = `
        <div class="vl-grid-fin">
            <div class="vl-card" style="margin:0;">
                <h2><i class="fas fa-dollar-sign"></i> Ingresos</h2>
                ${cardFin('Ventas (total)', formatearDinero(ing.ventas_total))}
                ${cardFin('Ventas del mes', formatearDinero(ing.ventas_mes))}
                ${cardFin('Dinero recibido', formatearDinero(ing.recibido_total), 'pos')}
                ${cardFin('Pendiente de cobro', formatearDinero(ing.pendiente))}
            </div>
            <div class="vl-card" style="margin:0;">
                <h2><i class="fas fa-box"></i> Inversión</h2>
                ${cardFin('Total invertido', formatearDinero(inv.total), 'neg')}
                ${cardFin('Del mes', formatearDinero(inv.mes))}
                <h2 style="margin-top:18px;"><i class="fas fa-receipt"></i> Gastos</h2>
                ${cardFin('Total gastos', formatearDinero(gas.total), 'neg')}
                ${cardFin('Del mes', formatearDinero(gas.mes))}
            </div>
            <div class="vl-card" style="margin:0;">
                <h2><i class="fas fa-chart-line"></i> Resultado</h2>
                ${cardFin('Ganancia estimada', formatearDinero(ganancia), ganancia >= 0 ? 'pos' : 'neg',
                    'Recibido − inversión − gastos. Es ESTIMADA: sin costo unitario por prenda no existe ganancia exacta.')}
                ${cardFin('Flujo de caja', formatearDinero(flujo), flujo >= 0 ? 'pos' : 'neg',
                    'Recibido − gastos. El dinero real que queda en caja (la inversión ya salió).')}
            </div>
        </div>`;
}

// ── Ganancias por LIVE (Ciclo 2) ─────────────────────────────
// Cada fila es un LIVE: prendas vendidas, cobrado (suma de abonos de sus
// prendas), inversión y gastos asignados a ese LIVE, y la ganancia real.
// "Sin LIVE" agrupa lo que no tiene LIVE asignado, para que el total cuadre.
function pintarSelectorLives(lives) {
    const sel = $('vf2-live');
    if (!sel) return;
    const actual = sel.value;
    sel.innerHTML = '<option value="">Sin LIVE (general)</option>' + (lives || []).map(l =>
        `<option value="${l.live_id}">${escapeHtml(l.etiqueta)}${l.abierto ? ' · abierto' : ' · ' + escapeHtml(l.fecha || '')}</option>`
    ).join('');
    if (actual) sel.value = actual;
}

function pintarPorLive(d) {
    const el = $('vf-por-live');
    if (!el) return;
    const lives = d.lives || [];
    const sl = d.sin_live || {};
    const slVentas = Number(sl.ventas || 0);
    const slCobrado = Number(sl.cobrado || 0);
    const slInv = Number(sl.invertido || 0);
    const slGas = Number(sl.gastos || 0);
    const haySinLive = Number(sl.prendas || 0) > 0 || slInv > 0 || slGas > 0;

    if (!lives.length && !haySinLive) {
        el.innerHTML = '';
        return;
    }

    const fila = (nombre, fecha, prendas, ventas, cobrado, invertido, gastos, ganancia, extra = '') => `
        <tr${extra}>
            <td>${nombre}${fecha ? `<div class="vl-nota">${escapeHtml(fecha)}</div>` : ''}</td>
            <td>${prendas}</td>
            <td>${formatearDinero(ventas)}</td>
            <td>${formatearDinero(cobrado)}</td>
            <td>${formatearDinero(invertido)}</td>
            <td>${formatearDinero(gastos)}</td>
            <td style="font-weight:800;color:${Number(ganancia) >= 0 ? '#8ce99a' : '#ff9f9f'};">${formatearDinero(ganancia)}</td>
        </tr>`;

    const filas = lives.map(l => fila(
        escapeHtml(l.etiqueta) + (l.abierto ? ' <span style="color:#c77dff;font-size:.7rem;">● abierto</span>' : ''),
        (String(l.etiqueta || '').includes(String(l.fecha || '---')) ? '' : (l.fecha || '')),
        l.prendas || 0, l.ventas || 0, l.cobrado || 0,
        l.invertido || 0, l.gastos || 0, l.ganancia || 0
    )).join('');

    const filaSin = haySinLive
        ? fila('<span style="opacity:.85;">Sin LIVE (general)</span>', '', sl.prendas || 0, slVentas, slCobrado, slInv, slGas,
            slCobrado - slInv - slGas, ' style="opacity:.85;"')
        : '';

    const totVentas = lives.reduce((a, l) => a + Number(l.ventas || 0), 0) + slVentas;
    const totCobrado = lives.reduce((a, l) => a + Number(l.cobrado || 0), 0) + slCobrado;
    const totInv = lives.reduce((a, l) => a + Number(l.invertido || 0), 0) + slInv;
    const totGas = lives.reduce((a, l) => a + Number(l.gastos || 0), 0) + slGas;
    const totPrendas = lives.reduce((a, l) => a + Number(l.prendas || 0), 0) + Number(sl.prendas || 0);

    el.innerHTML = `
        <div class="vl-grupo-titulo" style="margin-top:18px;"><span>💜 Ganancias por LIVE</span><span class="cnt">${lives.length}</span></div>
        <div class="vl-card" style="padding:10px 16px;">
            <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;">
            <table class="vl-tabla vf-tabla-live" style="min-width:620px;">
                <thead><tr>
                    <th>LIVE</th><th>Prendas</th><th>Ventas</th><th>Cobrado</th><th>Inversión</th><th>Gastos</th><th>Ganancia</th>
                </tr></thead>
                <tbody>
                    ${filas}${filaSin}
                    <tr style="border-top:1px solid rgba(255,255,255,.18);">
                        <td style="font-weight:800;">TOTAL</td>
                        <td style="font-weight:800;">${totPrendas}</td>
                        <td style="font-weight:800;">${formatearDinero(totVentas)}</td>
                        <td style="font-weight:800;">${formatearDinero(totCobrado)}</td>
                        <td style="font-weight:800;">${formatearDinero(totInv)}</td>
                        <td style="font-weight:800;">${formatearDinero(totGas)}</td>
                        <td style="font-weight:800;color:${(totCobrado - totInv - totGas) >= 0 ? '#8ce99a' : '#ff9f9f'};">${formatearDinero(totCobrado - totInv - totGas)}</td>
                    </tr>
                </tbody>
            </table>
            </div>
            <div class="vl-nota" style="margin-top:10px;">
                Cobrado = abonos de las prendas de ese LIVE. Ganancia = cobrado − inversión − gastos de ese LIVE.
                Lo que no tiene LIVE asignado queda en "Sin LIVE" para que el total cuadre.
            </div>
        </div>`;
}

function pintarLista(gastos) {
    const lista = $('vf-lista');
    if (!gastos.length) {
        lista.innerHTML = '';
        return;
    }
    lista.innerHTML = `
        <div class="vl-grupo-titulo"><span>📋 Últimos movimientos</span><span class="cnt">${gastos.length}</span></div>
        <div class="vl-card" style="padding:10px 16px;">
            <table class="vl-tabla">
                <thead><tr><th>Fecha</th><th>Tipo</th><th>Concepto</th><th>Monto</th><th></th></tr></thead>
                <tbody>
                    ${gastos.map(g => `
                        <tr>
                            <td>${escapeHtml(g.fecha || '')}</td>
                            <td>${g.tipo === 'inversion' ? '<span style="color:#ffa94d;">Inversión</span>' : '<span style="color:#ff9f9f;">Gasto</span>'}</td>
                            <td>${escapeHtml(g.concepto)}${g.live_etiqueta ? `<div class="vl-nota">LIVE: ${escapeHtml(g.live_etiqueta)}</div>` : ''}</td>
                            <td style="font-weight:700;">${formatearDinero(g.monto)}</td>
                            <td style="text-align:right;">
                                <button class="vl-btn danger" data-gasto="${g.gasto_id}" data-concepto="${encodeURIComponent(g.concepto)}" type="button" style="padding:5px 10px;"><i class="fas fa-trash"></i></button>
                            </td>
                        </tr>`).join('')}
                </tbody>
            </table>
        </div>`;

    lista.querySelectorAll('button[data-gasto]').forEach(btn => {
        btn.addEventListener('click', () => eliminarGasto(btn.dataset.gasto, decodeURIComponent(btn.dataset.concepto)));
    });
}

function parseMonto(raw) {
    const n = Number(String(raw || '').replace(/[^\d]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
}

async function agregarGasto() {
    const tipo = $('vf2-tipo').value;
    const concepto = $('vf2-concepto').value.trim();
    const monto = parseMonto($('vf2-monto').value);
    const fecha = $('vf2-fecha').value || null;
    if (!concepto) { mostrarToast('Escribe el concepto', 'warning'); return; }
    if (!monto) { mostrarToast('Monto inválido', 'warning'); return; }
    const liveId = ($('vf2-live') || {}).value || null;
    const res = await vlApi.agregarGasto(tipo, concepto, monto, fecha, liveId);
    if (!res.ok) { mostrarToast(res.error || 'No se pudo registrar', 'error'); return; }
    mostrarToast((tipo === 'inversion' ? 'Inversión' : 'Gasto') + ' registrado', 'success');
    $('vf2-concepto').value = '';
    $('vf2-monto').value = '';
    refrescarFinanzas();
}

function eliminarGasto(gastoId, concepto) {
    abrirModal({
        titulo: '🗑️ Eliminar movimiento',
        sub: '¿Eliminar "' + escapeHtml(concepto.slice(0, 60)) + '"? Esta acción no se puede deshacer.',
        html: `
            <div class="vl-modal-actions">
                <button class="vl-btn" id="vg2-cancelar" type="button">Cancelar</button>
                <button class="vl-btn danger" id="vg2-ok" type="button"><i class="fas fa-trash"></i> Eliminar</button>
            </div>`,
        onMount: (modal) => {
            modal.querySelector('#vg2-cancelar').addEventListener('click', () => cerrarModal(true));
            modal.querySelector('#vg2-ok').addEventListener('click', async () => {
                const btn = modal.querySelector('#vg2-ok');
                btn.disabled = true;
                const res = await vlApi.eliminarGasto(gastoId);
                btn.disabled = false;
                if (!res.ok) { mostrarToast(res.error || 'No se pudo eliminar', 'error'); return; }
                cerrarModal(true);
                mostrarToast('Movimiento eliminado', 'success');
                refrescarFinanzas();
            });
        }
    });
}
