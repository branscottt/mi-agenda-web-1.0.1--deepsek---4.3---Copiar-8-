// ventas-live/ui/LiveView.js
// MODO LIVE: pantalla de máxima velocidad para el TikTok LIVE.
// Flujo: @usuario + $precio → [AGREGAR PRENDA] → resetea y enfoca.
// El RPC vl_agregar_item hace todo lo demás (cliente/proceso/live/saldo).
// Spec: «DURANTE EL LIVE LOS VENDEDORES DEBEN INGRESAR LA MENOR CANTIDAD
// POSIBLE DE INFORMACIÓN.»

import { vlApi, normalizarTiktok, CATEGORIA_INFO } from '../domain/vlApi.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { formatearDinero, escapeHtml } from '../../shared/infrastructure/formatters.js';

let _built = false;
let _guardando = false;
let _debounce = null;
let _ultima = null; // { itemId, nick, precio }
let _live = null;   // { id, etiqueta } | null

function $(id) { return document.getElementById(id); }

function buildDOM() {
    const cont = $('vl-view-live');
    cont.innerHTML = `
        <div class="vl-live-grid">
            <div>
                <div class="vl-card">
                    <h2><i class="fas fa-bolt"></i> Registrar venta</h2>
                    <div class="sub">Escribe el usuario de TikTok y el precio. Enter = siguiente campo.</div>
                    <div class="vl-field">
                        <label for="lv-usuario">Usuario TikTok</label>
                        <div class="vl-input-wrap">
                            <span class="vl-input-prefix">@</span>
                            <input class="vl-input" id="lv-usuario" inputmode="text" autocomplete="off"
                                   placeholder="cliente123" enterkeyhint="next" autofocus>
                        </div>
                    </div>
                    <div class="vl-field">
                        <label for="lv-precio">Precio de la prenda</label>
                        <div class="vl-input-wrap">
                            <span class="vl-input-prefix">$</span>
                            <input class="vl-input" id="lv-precio" inputmode="numeric" autocomplete="off"
                                   placeholder="8000" enterkeyhint="go">
                        </div>
                    </div>
                    <button class="vl-submit" id="lv-agregar" type="button">
                        <i class="fas fa-plus-circle"></i> AGREGAR PRENDA
                    </button>
                    <div class="vl-session" id="lv-session"></div>
                    <div class="vl-ultima" id="lv-ultima" style="display:none;"></div>
                </div>
            </div>
            <div>
                <div class="vl-card">
                    <h2><i class="fas fa-user"></i> Cliente</h2>
                    <div class="sub">Se muestra al escribir un usuario conocido.</div>
                    <div class="vl-client-mini" id="lv-client-mini">
                        <div class="vl-client-head">
                            <span class="nick" id="lv-nick">@—</span>
                            <span class="vl-badge" id="lv-badge"></span>
                        </div>
                        <div class="vl-client-stats" id="lv-client-stats">
                            <div class="vl-cstat"><div class="k">Prendas actuales</div><div class="v" id="lv-prendas">—</div></div>
                            <div class="vl-cstat"><div class="k">Saldo pendiente</div><div class="v" id="lv-saldo">—</div></div>
                        </div>
                        <div class="vl-alert" id="lv-alerta"></div>
                    </div>
                </div>
                <div class="vl-card" style="margin-top:16px;">
                    <h2><i class="fas fa-store"></i> Hoy</h2>
                    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:12px;">
                        <div class="vl-stat-big"><div class="v" id="lv-hoy-ventas">$0</div><div class="k">Ventas</div></div>
                        <div class="vl-stat-big"><div class="v" id="lv-hoy-recibido">$0</div><div class="k">Recibido</div></div>
                        <div class="vl-stat-big"><div class="v" id="lv-pendiente-total">$0</div><div class="k">Por cobrar</div></div>
                    </div>
                </div>
            </div>
        </div>`;

    $('lv-usuario').addEventListener('input', onUsuarioInput);
    $('lv-usuario').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); $('lv-precio').focus(); }
    });
    $('lv-precio').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); guardar(); }
    });
    $('lv-agregar').addEventListener('click', guardar);
}

export function initLiveView() {
    if (!_built) {
        buildDOM();
        _built = true;
    }
    refrescarTodo();
}

// Se llama cada vez que se activa la pestaña LIVE
export function activarLiveView() {
    if (!_built) return;
    refrescarTodo();
}

async function refrescarTodo() {
    const res = await vlApi.dashboard();
    if (!res.ok) {
        pintarSession(null, 0, 0);
        return;
    }
    const d = res.data || {};
    const live = (d.live_actual && d.live_actual.live_id) ? d.live_actual : null;
    _live = live ? { id: live.live_id, etiqueta: live.etiqueta } : null;
    pintarSession(_live, live ? Number(live.ventas || 0) : 0, live ? Number(live.prendas || 0) : 0);
    const hoy = d.ventas || {};
    const pagos = d.pagos || {};
    $('lv-hoy-ventas').textContent = formatearDinero(hoy.hoy);
    $('lv-hoy-recibido').textContent = formatearDinero(pagos.hoy);
    $('lv-pendiente-total').textContent = formatearDinero(d.pendiente_total);
}

function pintarSession(live, ventasLive, prendasLive) {
    const el = $('lv-session');
    if (!live) {
        el.innerHTML = `
            <span class="live-tag"><span class="dot"></span> Sin LIVE activo</span>
            <span class="live-meta">Las ventas se guardarán igual; puedes abrir un LIVE para agruparlas.</span>
            <button class="vl-btn-ghost" id="lv-abrir-live" type="button"><i class="fas fa-circle-play"></i> Abrir LIVE</button>`;
        const btn = $('lv-abrir-live');
        if (btn) btn.addEventListener('click', abrirLive);
        return;
    }
    el.innerHTML = `
        <span class="live-tag"><span class="dot"></span> ${escapeHtml(live.etiqueta)}</span>
        <span class="live-meta">${formatearDinero(ventasLive)} · ${prendasLive} prenda(s)</span>
        <button class="vl-btn-ghost" id="lv-cerrar-live" type="button"><i class="fas fa-stop"></i> Cerrar LIVE</button>`;
    const btn = $('lv-cerrar-live');
    if (btn) btn.addEventListener('click', cerrarLive);
}

async function abrirLive() {
    const res = await vlApi.abrirLive();
    if (!res.ok) { mostrarToast(res.error, 'error'); return; }
    mostrarToast('LIVE abierto', 'success');
    refrescarTodo();
}

async function cerrarLive() {
    if (!_live) return;
    const res = await vlApi.cerrarLive(_live.id);
    if (!res.ok) { mostrarToast(res.error, 'error'); return; }
    mostrarToast('LIVE cerrado', 'success');
    _live = null;
    refrescarTodo();
}

// ---- Preview del cliente mientras se escribe ----
function onUsuarioInput() {
    clearTimeout(_debounce);
    const norm = normalizarTiktok($('lv-usuario').value);
    if (!norm) { ocultarResumen(); return; }
    _debounce = setTimeout(() => buscarCliente(norm), 300);
}

async function buscarCliente(norm) {
    const res = await vlApi.buscarClientes(norm, 20);
    if (!res.ok) return;
    const match = (res.data.clientes || []).find(c => c.tiktok_user === norm);
    if (!match) { ocultarResumen(); return; }
    mostrarResumen(match);
}

function ocultarResumen() {
    const mini = $('lv-client-mini');
    if (mini) mini.classList.remove('visible');
}

function mostrarResumen(c) {
    const mini = $('lv-client-mini');
    mini.classList.add('visible');
    $('lv-nick').textContent = '@' + c.tiktok_user;
    const info = CATEGORIA_INFO[c.categoria] || CATEGORIA_INFO.nuevo;
    const badge = $('lv-badge');
    badge.textContent = info.label;
    badge.className = 'vl-badge ' + info.clase;

    const pa = c.proceso_activo;
    const stats = $('lv-client-stats');
    const alerta = $('lv-alerta');
    alerta.className = 'vl-alert';
    if (pa) {
        stats.style.display = '';
        $('lv-prendas').textContent = pa.prendas + ' prenda(s)';
        $('lv-saldo').textContent = formatearDinero(pa.saldo);
    } else {
        stats.style.display = 'none';
    }
    if (c.categoria === 'problematico' || c.categoria === 'bloqueado') {
        const texto = c.categoria === 'bloqueado'
            ? '🚫 Cliente marcado como BLOQUEADO. Revisa su historial antes de venderle.'
            : '⚠️ ATENCIÓN: este cliente tiene historial de reservas sin concretar.';
        alerta.textContent = texto;
        alerta.classList.add(c.categoria === 'bloqueado' ? 'danger' : 'warning');
        alerta.classList.add('visible');
    } else {
        alerta.classList.remove('visible');
    }
}

// ---- Guardar venta ----
function parsePrecio(raw) {
    const n = Number(String(raw || '').replace(/[^\d]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
}

async function guardar() {
    if (_guardando) return;
    const usuario = $('lv-usuario').value;
    const norm = normalizarTiktok(usuario);
    if (!norm) { mostrarToast('Escribe el usuario de TikTok', 'warning'); $('lv-usuario').focus(); return; }
    const precio = parsePrecio($('lv-precio').value);
    if (!precio) { mostrarToast('Escribe un precio válido', 'warning'); $('lv-precio').focus(); return; }

    _guardando = true;
    const btn = $('lv-agregar');
    btn.disabled = true;
    try {
        const res = await vlApi.agregarItem(norm, precio);
        if (!res.ok) {
            mostrarToast(res.error || 'No se pudo registrar la venta', 'error');
            return;
        }
        const d = res.data;
        const nick = d.cliente ? d.cliente.tiktok_user : norm;
        const esNuevo = d.cliente && d.cliente.es_nuevo;
        mostrarToast('@' + nick + ' · ' + formatearDinero(precio) + (esNuevo ? ' · cliente nuevo' : ''), 'success');

        // Alerta de comportamiento post-guardado (spec §12)
        if (d.alerta) {
            const a = $('lv-alerta');
            const nConcretadas = Number(d.alerta.concretadas || 0);
            const nReservas = Number(d.alerta.reservas || 0);
            a.textContent = '⚠️ ATENCIÓN: este cliente tiene ' + (nReservas - nConcretadas) +
                ' reserva(s) anterior(es) sin concretar (de ' + nReservas + ').';
            a.className = 'vl-alert danger visible';
        }

        // Última venta + deshacer
        _ultima = { itemId: d.item && d.item.id, nick, precio };
        pintarUltima();

        // Reset rápido para la siguiente venta
        $('lv-precio').value = '';
        $('lv-usuario').value = '';
        ocultarResumen();
        refrescarTodo();
        $('lv-usuario').focus();
    } finally {
        _guardando = false;
        btn.disabled = false;
    }
}

function pintarUltima() {
    const el = $('lv-ultima');
    if (!_ultima) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    el.innerHTML = `
        <span><i class="fas fa-check-circle" style="color:#2dd4a7;"></i> Última: <b>@${escapeHtml(_ultima.nick)}</b> · ${formatearDinero(_ultima.precio)}</span>
        <button class="vl-btn-ghost" id="lv-undo" type="button" style="color:#ff9f9f;"><i class="fas fa-undo"></i> Deshacer</button>`;
    const undo = $('lv-undo');
    if (undo) undo.addEventListener('click', deshacerUltima);
}

async function deshacerUltima() {
    if (!_ultima) return;
    const res = await vlApi.eliminarItem(_ultima.itemId);
    if (!res.ok) { mostrarToast(res.error || 'No se pudo eliminar', 'error'); return; }
    mostrarToast('Venta eliminada', 'success');
    _ultima = null;
    pintarUltima();
    refrescarTodo();
}
