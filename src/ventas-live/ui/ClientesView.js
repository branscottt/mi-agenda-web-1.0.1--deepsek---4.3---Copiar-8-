// ventas-live/ui/ClientesView.js
// Vista Clientes: búsqueda + ficha completa del cliente (spec §20):
// perfil editable, contadores de comportamiento, proceso activo con
// prendas/pagos/acciones, historial de procesos cerrados.

import { vlApi, CATEGORIA_INFO, ESTADO_INFO } from '../domain/vlApi.js';
import { abrirModal, cerrarModal } from './vlModales.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { formatearDinero, escapeHtml } from '../../shared/infrastructure/formatters.js';
import {
    modalConfirmarPago, modalPagaraPresencial, modalDecisionEntrega,
    modalCrearEnvio, modalMarcarEntregado, modalLiberarItems
} from './accionesProceso.js';

let _built = false;
let _modo = 'lista';      // 'lista' | 'ficha'
let _clienteId = null;
let _ficha = null;
let _debounce = null;

function $(id) { return document.getElementById(id); }

export function initClientes() {
    const cont = $('vl-view-clientes');
    if (!_built) {
        cont.innerHTML = `
            <div class="vl-card">
                <h2><i class="fas fa-users"></i> Clientes</h2>
                <div class="sub">Busca por usuario de TikTok, nombre o WhatsApp.</div>
                <div class="vl-buscar">
                    <input class="vl-control" id="vc-q" placeholder="Buscar cliente… (ej: @maria123)">
                </div>
                <div id="vc-lista"></div>
            </div>
            <div id="vc-ficha" style="display:none;"></div>`;
        _built = true;
        const q = $('vc-q');
        q.addEventListener('input', () => {
            clearTimeout(_debounce);
            _debounce = setTimeout(buscar, 300);
        });
        q.addEventListener('keydown', (e) => { if (e.key === 'Enter') buscar(); });
    }
    if (_modo === 'ficha' && _clienteId) {
        abrirFicha(_clienteId);
    } else {
        _modo = 'lista';
        mostrarLista();
    }
}

// Usado por ProcesosView (window.__vlIrAFicha)
export function abrirFicha(clienteId) {
    _modo = 'ficha';
    _clienteId = clienteId;
    if (!_built) return; // la pestaña se inicializa antes de llamar
    $('vc-lista').closest('.vl-card').style.display = 'none';
    $('vc-ficha').style.display = 'block';
    $('vc-ficha').innerHTML = '<div class="vl-empty"><i class="fas fa-spinner fa-spin"></i> Cargando ficha…</div>';
    cargarFicha(clienteId);
}

function volverLista() {
    _modo = 'lista';
    _clienteId = null;
    $('vc-ficha').style.display = 'none';
    $('vc-ficha').innerHTML = '';
    $('vc-lista').closest('.vl-card').style.display = '';
    mostrarLista();
}

async function buscar() {
    const q = $('vc-q').value;
    const res = await vlApi.buscarClientes(q, 200);
    if (!res.ok) { mostrarToast(res.error || 'Error de búsqueda', 'error'); return; }
    pintarLista(res.data.clientes || []);
}

async function mostrarLista() {
    const res = await vlApi.buscarClientes('', 200);
    if (!res.ok) { mostrarToast(res.error || 'Error', 'error'); return; }
    pintarLista(res.data.clientes || []);
}

function pintarLista(clientes) {
    const lista = $('vc-lista');
    if (!clientes.length) {
        lista.innerHTML = '<div class="vl-empty">Sin clientes todavía. Los clientes se crean solos al registrar ventas en el MODO LIVE.</div>';
        return;
    }
    lista.innerHTML = clientes.map(c => {
        const info = CATEGORIA_INFO[c.categoria] || CATEGORIA_INFO.nuevo;
        const pa = c.proceso_activo;
        const estadoTxt = pa ? ((ESTADO_INFO[pa.estado] || {}).label || pa.estado) : 'sin proceso activo';
        return `
            <div class="vl-fila clickeable" data-c="${c.cliente_id}">
                <div style="min-width:170px;">
                    <div class="f-nick">@${escapeHtml(c.tiktok_user)}</div>
                    <div class="f-sub">
                        ${escapeHtml(c.nombre_real || '')} ${c.ciudad ? '· ' + escapeHtml(c.ciudad) : ''}
                        ${c.whatsapp ? '· ' + escapeHtml(c.whatsapp) : ''}
                    </div>
                </div>
                <div class="f-der">
                    <span class="vl-badge ${info.clase}">${info.label}</span>
                    <div class="f-datos">
                        ${pa ? `<span>${estadoTxt}</span>
                                <span>Prendas <b>${pa.prendas}</b></span>
                                <span>Debe <b>${formatearDinero(pa.saldo)}</b></span>`
                             : `<span style="color:var(--muted,#adb5bd);">${estadoTxt}</span>`}
                    </div>
                </div>
            </div>`;
    }).join('');
    lista.querySelectorAll('.vl-fila').forEach(row => {
        row.addEventListener('click', () => abrirFicha(row.dataset.c));
    });
}

// ---------------- Ficha ----------------
async function cargarFicha(clienteId) {
    const res = await vlApi.fichaCliente(clienteId);
    if (!res.ok) {
        $('vc-ficha').innerHTML = '<div class="vl-empty">No se pudo cargar: ' + escapeHtml(res.error || 'error') + '</div>';
        return;
    }
    _ficha = res.data;
    pintarFicha();
}

function pintarFicha() {
    const c = _ficha.cliente;
    const info = CATEGORIA_INFO[c.categoria] || CATEGORIA_INFO.nuevo;
    const cont = $('vc-ficha');
    const pa = _ficha.proceso_activo;
    const hist = _ficha.historial || [];
    const cnt = _ficha.contadores || {};

    cont.innerHTML = `
        <div class="vl-card">
            <div class="vl-client-head" style="margin-bottom:6px;">
                <span class="nick" style="font-size:1.35rem;">@${escapeHtml(c.tiktok_user)}</span>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                    <span class="vl-badge ${info.clase}">${info.label}</span>
                    <button class="vl-btn" id="vf-editar" type="button"><i class="fas fa-pen"></i> Editar perfil</button>
                    <button class="vl-btn" id="vf-volver" type="button"><i class="fas fa-arrow-left"></i> Volver</button>
                </div>
            </div>
            <div class="f-sub" style="font-size:0.88rem;">
                ${[c.nombre_real, c.whatsapp, [c.ciudad, c.comuna].filter(Boolean).join(', '), c.direccion].filter(Boolean).map(escapeHtml).join(' · ') || 'Sin datos de contacto todavía'}
            </div>

            <div class="vl-grid-contadores">
                <div class="vl-cstat2"><div class="k">Reservas</div><div class="v">${cnt.reservas || 0}</div></div>
                <div class="vl-cstat2"><div class="k">Concretadas</div><div class="v" style="color:#7ff5d8;">${cnt.concretadas || 0}</div></div>
                <div class="vl-cstat2"><div class="k">Sin concretar</div><div class="v" style="color:#ffb3b3;">${cnt.no_concretadas || 0}</div></div>
                <div class="vl-cstat2"><div class="k">Comprado total</div><div class="v">${formatearDinero(cnt.comprado_total)}</div></div>
                <div class="vl-cstat2"><div class="k">Pagado total</div><div class="v" style="color:#7ff5d8;">${formatearDinero(cnt.pagado_total)}</div></div>
            </div>

            ${pa ? fichaProcesoHTML(c, pa) : `
                <div class="vl-ficha-sec">
                    <h4>Proceso actual</h4>
                    <div class="vl-empty" style="padding:14px;">No tiene proceso activo.</div>
                </div>`}

            <div class="vl-ficha-sec">
                <h4>Historial (${hist.length})</h4>
                ${hist.length ? hist.map(h => `
                    <div class="vl-hist-item" style="font-size:0.85rem;color:#ced4da;">
                        <span>${(ESTADO_INFO[h.estado] || {}).label || h.estado}</span>
                        <span style="color:var(--muted,#adb5bd);"> · ${h.cerrado_en ? new Date(h.cerrado_en).toLocaleDateString('es-CL') : ''}
                        · ${h.prendas} prenda(s) · comprado ${formatearDinero(h.total_comprado)} · pagado ${formatearDinero(h.total_pagado)}</span>
                    </div>`).join('') : '<div class="vl-empty" style="padding:10px;">Sin procesos anteriores.</div>'}
            </div>
        </div>`;

    $('vf-volver').addEventListener('click', volverLista);
    $('vf-editar').addEventListener('click', () => modalEditarPerfil(c, async () => {
        await cargarFicha(_clienteId);
    }));

    if (pa) bindAccionesProceso(pa, c);
}

function fichaProcesoHTML(c, pa) {
    const estadoInfo = ESTADO_INFO[pa.estado] || { label: pa.estado };
    const items = pa.items || [];
    const pagos = pa.pagos || [];
    const envio = pa.envio;
    const pagadas = items.filter(i => i.estado === 'pagada' || i.estado === 'entregada').length;
    const pendPago = items.filter(i => i.estado === 'adjudicada').length;
    return `
        <div class="vl-ficha-sec">
            <h4>Proceso actual · <span style="text-transform:none;color:#f8f9fa;">${estadoInfo.label}</span></h4>
            <div class="f-datos" style="margin-bottom:8px;">
                <span>Prendas en bolsa <b>${pa.prendas}</b></span>
                <span>Saldo pendiente <b>${formatearDinero(pa.saldo)}</b></span>
                ${envio ? `<span>${envio.tipo === 'presencial' ? '🤝 Entrega presencial' : '🚚 Envío'} ${envio.fecha_programada ? '· ' + envio.fecha_programada : ''} ${envio.tracking ? '· #' + envio.tracking : ''}</span>` : ''}
            </div>
            <table class="vl-tabla">
                <thead><tr><th>Prenda</th><th>Precio</th><th>Abonado</th><th>Estado</th></tr></thead>
                <tbody>
                    ${items.map(i => `
                        <tr>
                            <td>${escapeHtml(i.descripcion || 'Prenda')}</td>
                            <td>${formatearDinero(i.precio)}</td>
                            <td>${formatearDinero(i.abonado)}</td>
                            <td>${estadoItem(i.estado)}</td>
                        </tr>`).join('')}
                </tbody>
            </table>
            ${pagos.length ? `
                <div style="font-size:0.8rem;color:var(--muted,#adb5bd);margin-top:8px;">
                    Pagos: ${pagos.map(pg => `${formatearDinero(pg.monto)} (${pg.metodo})${pg.nota ? ' · ' + escapeHtml(pg.nota) : ''}`).join(' — ')}
                </div>` : ''}
            <div class="vl-acciones" id="vf-acciones" style="margin-top:12px;"></div>
        </div>`;
}

function estadoItem(estado) {
    const map = {
        adjudicada: '<span style="color:#ffa94d;">adjudicada</span>',
        pagada: '<span style="color:#7ff5d8;">pagada</span>',
        liberada: '<span style="color:#ff9f9f;">liberada</span>',
        entregada: '<span style="color:#74c0fc;">entregada</span>'
    };
    return map[estado] || escapeHtml(estado);
}

function bindAccionesProceso(pa, c) {
    const cont = $('vf-acciones');
    if (!cont) return;
    const proc = {
        proceso_id: pa.proceso_id,
        estado: pa.estado,
        saldo: pa.saldo,
        prendas: pa.prendas,
        envio: pa.envio || null,
        cliente: { cliente_id: c.cliente_id, tiktok_user: c.tiktok_user }
    };
    const onDone = () => cargarFicha(_clienteId);
    const btns = [];
    const e = pa.estado;
    const saldo = Number(pa.saldo || 0);

    const mk = (clase, icono, texto, accion) => {
        const b = document.createElement('button');
        b.className = 'vl-btn ' + clase;
        b.type = 'button';
        b.innerHTML = `<i class="fas ${icono}"></i> ${texto}`;
        b.addEventListener('click', accion);
        cont.appendChild(b);
    };

    if (e === 'esperando_whatsapp' || e === 'identificando_cliente') {
        mk('primary', 'fa-clock', 'Marcar esperando pago', async () => {
            const r = await vlApi.marcarEsperandoPago(pa.proceso_id);
            if (!r.ok) { mostrarToast(r.error, 'error'); return; }
            mostrarToast('En espera de pago', 'success'); onDone();
        });
        mk('danger', 'fa-unlock', 'Liberar prendas', () => modalLiberarItems(proc, onDone));
    }
    if (e === 'esperando_pago' || e === 'pago_parcial') {
        mk('success', 'fa-hand-holding-dollar', 'Confirmar pago', () => modalConfirmarPago(proc, onDone));
        mk('', 'fa-handshake', 'Pagará presencial', () => modalPagaraPresencial(proc, onDone));
        mk('danger', 'fa-unlock', 'Liberar', () => modalLiberarItems(proc, onDone));
    }
    if (e === 'pagara_presencial') {
        mk('success', 'fa-hand-holding-dollar', 'Confirmar pago (al recibir)', () => modalConfirmarPago(proc, onDone));
        mk('danger', 'fa-unlock', 'Liberar', () => modalLiberarItems(proc, onDone));
    }
    if ((e === 'pagado' || e === 'acumulando') && saldo === 0) {
        mk('primary', 'fa-box-open', 'Decidir entrega', () => modalDecisionEntrega(proc, onDone));
    }
    if ((e === 'pagado' || e === 'acumulando') && saldo > 0) {
        mk('success', 'fa-hand-holding-dollar', 'Confirmar pago', () => modalConfirmarPago(proc, onDone));
    }
    if (e === 'listo_preparar' || e === 'envio_programado') {
        mk('success', 'fa-truck-fast', 'Marcar ENVÍO CREADO', () => modalCrearEnvio(proc, onDone));
    }
    if (e === 'envio_proceso' || e === 'entrega_presencial') {
        mk('success', 'fa-check-circle', 'Marcar entregado', () => modalMarcarEntregado(proc, onDone));
    }
}

// ---------------- Editar perfil ----------------
function modalEditarPerfil(c, onDone) {
    abrirModal({
        titulo: '✏️ Editar perfil — @' + escapeHtml(c.tiktok_user),
        sub: 'La categoría la decides tú: el sistema nunca bloquea ni etiqueta solo.',
        html: `
            <div class="vl-form-row"><label for="vf-tiktok">Usuario TikTok</label>
                <input class="vl-control" id="vf-tiktok" value="${escapeHtml(c.tiktok_user)}"></div>
            <div class="vl-form-row"><label for="vf-nombre">Nombre real</label>
                <input class="vl-control" id="vf-nombre" value="${escapeHtml(c.nombre_real || '')}"></div>
            <div class="vl-form-row"><label for="vf-whatsapp">WhatsApp</label>
                <input class="vl-control" id="vf-whatsapp" value="${escapeHtml(c.whatsapp || '')}" placeholder="+56 9 …"></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                <div class="vl-form-row"><label for="vf-ciudad">Ciudad</label>
                    <input class="vl-control" id="vf-ciudad" value="${escapeHtml(c.ciudad || '')}"></div>
                <div class="vl-form-row"><label for="vf-comuna">Comuna</label>
                    <input class="vl-control" id="vf-comuna" value="${escapeHtml(c.comuna || '')}"></div>
            </div>
            <div class="vl-form-row"><label for="vf-direccion">Dirección</label>
                <input class="vl-control" id="vf-direccion" value="${escapeHtml(c.direccion || '')}"></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                <div class="vl-form-row"><label for="vf-entrega">Entrega preferida</label>
                    <select class="vl-control" id="vf-entrega">
                        <option value="">Sin definir</option>
                        <option value="envio">Envío</option>
                        <option value="presencial">Presencial</option>
                    </select></div>
                <div class="vl-form-row"><label for="vf-categoria">Categoría</label>
                    <select class="vl-control" id="vf-categoria">
                        ${Object.entries(CATEGORIA_INFO).map(([k, v]) => `<option value="${k}">${v.label.replace(/[⚠️🚫]/g, '').trim()}</option>`).join('')}
                    </select></div>
            </div>
            <div class="vl-form-row"><label for="vf-notas">Notas</label>
                <textarea class="vl-control" id="vf-notas" rows="3">${escapeHtml(c.notas || '')}</textarea></div>
            <div class="vl-modal-actions">
                <button class="vl-btn" id="vf-cancelar" type="button">Cancelar</button>
                <button class="vl-btn primary" id="vf-ok" type="button"><i class="fas fa-save"></i> Guardar</button>
            </div>`,
        onMount: (modal, { marcarSucio }) => {
            modal.querySelector('#vf-entrega').value = c.entrega_preferida || '';
            modal.querySelector('#vf-categoria').value = c.categoria || 'nuevo';
            modal.querySelectorAll('.vl-control').forEach(el => el.addEventListener('input', marcarSucio));
            modal.querySelector('#vf-cancelar').addEventListener('click', () => cerrarModal(true));
            modal.querySelector('#vf-ok').addEventListener('click', guardar);
            async function guardar() {
                const btn = modal.querySelector('#vf-ok');
                btn.disabled = true;
                const res = await vlApi.actualizarCliente({
                    p_cliente_id: c.cliente_id,
                    p_tiktok_user: modal.querySelector('#vf-tiktok').value.trim(),
                    p_nombre_real: modal.querySelector('#vf-nombre').value,
                    p_whatsapp: modal.querySelector('#vf-whatsapp').value,
                    p_ciudad: modal.querySelector('#vf-ciudad').value,
                    p_comuna: modal.querySelector('#vf-comuna').value,
                    p_direccion: modal.querySelector('#vf-direccion').value,
                    p_entrega_preferida: modal.querySelector('#vf-entrega').value,
                    p_categoria: modal.querySelector('#vf-categoria').value,
                    p_notas: modal.querySelector('#vf-notas').value
                });
                btn.disabled = false;
                if (!res.ok) { mostrarToast(res.error || 'No se pudo guardar', 'error'); return; }
                cerrarModal(true);
                mostrarToast('Perfil actualizado', 'success');
                onDone();
            }
        }
    });
}
