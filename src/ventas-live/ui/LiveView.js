// ventas-live/ui/LiveView.js
// MODO LIVE: pantalla de máxima velocidad para el TikTok LIVE.
// Flujo: @usuario + $precio → [AGREGAR PRENDA] → resetea y enfoca.
// El RPC vl_agregar_item hace todo lo demás (cliente/proceso/live/saldo).
// Spec: «DURANTE EL LIVE LOS VENDEDORES DEBEN INGRESAR LA MENOR CANTIDAD
// POSIBLE DE INFORMACIÓN.»

import { vlApi, normalizarTiktok, CATEGORIA_INFO } from '../domain/vlApi.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { formatearDinero, escapeHtml } from '../../shared/infrastructure/formatters.js';
import { burbujasHtml, nombreDeCliente, autoScrollAbajo } from './chatComun.js';

let _built = false;
let _guardando = false;
let _debounce = null;
let _ultima = null; // { itemId, nick, precio }
let _live = null;   // { id, etiqueta } | null

// Chat del cliente mostrado al lado (para cargar el pedido viendo la
// conversación). _chatClienteId evita recargar si es el mismo cliente.
let _chatClienteId = null;
let _chatId = null;
let _chatModo = 'bot';
let _chatPoll = null;
let _chatEnviando = false;

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
                <div class="vl-card" style="margin-top:16px;" id="lv-chat-card">
                    <div class="vl-chat-mini-head">
                        <h2 style="margin:0;"><i class="fab fa-whatsapp"></i> Chat del cliente</h2>
                        <button class="vl-btn" id="lv-chat-modo" type="button" style="display:none;"></button>
                    </div>
                    <div class="sub" id="lv-chat-sub">Escribe un @usuario conocido para ver su conversación acá.</div>
                    <div class="vl-chat-mini-scroll" id="lv-chat-msgs"></div>
                    <div class="vl-chat-mini-composer" id="lv-chat-composer" style="display:none;">
                        <input class="vl-control" id="lv-chat-input" maxlength="1000"
                               placeholder="Responder por WhatsApp…" autocomplete="off">
                        <button class="vl-btn primary" id="lv-chat-enviar" type="button" title="Enviar">
                            <i class="fas fa-paper-plane"></i>
                        </button>
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

    // Chat del cliente (panel lateral del LIVE)
    $('lv-chat-enviar').addEventListener('click', enviarChat);
    $('lv-chat-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); enviarChat(); }
    });
    $('lv-chat-modo').addEventListener('click', cambiarModoChat);
}

export function initLiveView() {
    if (!_built) {
        buildDOM();
        _built = true;
    }
    refrescarTodo();
    iniciarPollChat();
}

// Se llama cada vez que se activa la pestaña LIVE
export function activarLiveView() {
    if (!_built) return;
    refrescarTodo();
    iniciarPollChat();
}

// Refresca el chat del cliente visible cada 15 s (solo con LIVE a la vista).
function iniciarPollChat() {
    if (_chatPoll) clearInterval(_chatPoll);
    _chatPoll = setInterval(() => {
        const vista = $('vl-view-live');
        if (!vista || !vista.classList.contains('active')) return;
        if (!_chatId || _chatEnviando) return;
        cargarHiloChat({ silencioso: true });
    }, 15000);
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
    limpiarChat();
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

    // Trae la conversación de WhatsApp de este cliente (si existe).
    cargarChatCliente(c);
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

        // Reset rápido para la siguiente venta (el panel del cliente y su
        // chat se mantienen a la vista: se suele cargar más de una prenda
        // al mismo cliente y conviene seguir leyendo la conversación).
        $('lv-precio').value = '';
        $('lv-usuario').value = '';
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

// ============================================================
// Chat del cliente dentro del LIVE
// Permite cargar el pedido viendo la conversación y responder sin
// salir del MODO LIVE (mismo circuito que la pestaña Chats).
// ============================================================
function limpiarChat() {
    _chatClienteId = null;
    _chatId = null;
    _chatModo = 'bot';
    const msgs = $('lv-chat-msgs');
    const sub = $('lv-chat-sub');
    const comp = $('lv-chat-composer');
    const modoBtn = $('lv-chat-modo');
    const input = $('lv-chat-input');
    if (msgs) msgs.innerHTML = '';
    if (input) input.value = '';
    if (sub) sub.textContent = 'Escribe un @usuario conocido para ver su conversación acá.';
    if (comp) comp.style.display = 'none';
    if (modoBtn) modoBtn.style.display = 'none';
}

async function cargarChatCliente(c) {
    const clienteId = c && c.cliente_id;
    if (!clienteId) { limpiarChat(); return; }
    if (clienteId === _chatClienteId) return; // ya está a la vista

    _chatClienteId = clienteId;
    _chatId = null;
    _chatModo = 'bot';

    const msgs = $('lv-chat-msgs');
    const sub = $('lv-chat-sub');
    const comp = $('lv-chat-composer');
    const modoBtn = $('lv-chat-modo');
    if (sub) sub.textContent = 'Buscando su conversación…';
    if (msgs) msgs.innerHTML = '<div class="vl-chat-mini-vacio"><i class="fas fa-spinner fa-spin"></i></div>';
    if (comp) comp.style.display = 'none';
    if (modoBtn) modoBtn.style.display = 'none';

    const res = await vlApi.chatPorCliente(clienteId);
    if (!res.ok) {
        if (msgs) msgs.innerHTML = '<div class="vl-chat-mini-vacio">No se pudo cargar la conversación.</div>';
        if (sub) sub.textContent = '';
        return;
    }

    const chatId = res.data && res.data.chat_id;
    if (!chatId) {
        if (msgs) msgs.innerHTML = '<div class="vl-chat-mini-vacio">Este cliente todavía no escribió por WhatsApp 💬</div>';
        if (sub) sub.textContent = 'Cuando escriba, la conversación aparece acá.';
        return;
    }

    _chatId = chatId;
    _chatModo = (res.data && res.data.modo) || 'bot';
    if (comp) comp.style.display = 'flex';
    pintarCabeceraChat();
    await cargarHiloChat({ forzarAbajo: true });
}

async function cargarHiloChat({ silencioso = false, forzarAbajo = false } = {}) {
    if (!_chatId) return;
    const msgs = $('lv-chat-msgs');
    if (!msgs) return;

    const res = await vlApi.chatHilo(_chatId);
    if (!res.ok) return;

    const chat = (res.data && res.data.chat) || {};
    if (chat.modo) _chatModo = chat.modo;
    const mensajes = (res.data && Array.isArray(res.data.mensajes)) ? res.data.mensajes : [];
    msgs.innerHTML = burbujasHtml(mensajes, { nombreCliente: nombreDeCliente(chat) });
    autoScrollAbajo(msgs, { forzar: forzarAbajo || !silencioso });
    pintarCabeceraChat();
}

function pintarCabeceraChat() {
    const sub = $('lv-chat-sub');
    const modoBtn = $('lv-chat-modo');
    const humano = _chatModo === 'humano';
    if (sub) {
        sub.innerHTML = humano
            ? '<i class="fas fa-user"></i> Estás atendiendo tú: el bot está en pausa.'
            : '<i class="fas fa-robot"></i> El bot responde solo. Si escribes, tomas el control.';
    }
    if (modoBtn) {
        modoBtn.style.display = 'inline-flex';
        modoBtn.className = humano ? 'vl-btn success' : 'vl-btn';
        modoBtn.innerHTML = humano
            ? '<i class="fas fa-robot"></i> Devolver al bot'
            : '<i class="fas fa-user"></i> Tomar el control';
    }
}

async function enviarChat() {
    if (_chatEnviando) return;
    const input = $('lv-chat-input');
    const btn = $('lv-chat-enviar');
    if (!input || !_chatId) return;
    const texto = input.value.trim();
    if (!texto) return;

    _chatEnviando = true;
    if (btn) btn.disabled = true;

    // Si el bot está activo, tomar el control antes de escribir.
    let tomoControl = false;
    if (_chatModo === 'bot') {
        const r = await vlApi.chatModo(_chatId, 'humano');
        if (r.ok) { _chatModo = 'humano'; tomoControl = true; pintarCabeceraChat(); }
    }

    const res = await vlApi.enviarManual(_chatId, texto);

    _chatEnviando = false;
    if (btn) btn.disabled = false;

    if (!res.ok) { mostrarToast(res.error || 'No se pudo enviar el mensaje', 'error'); return; }
    input.value = '';
    if (tomoControl) mostrarToast('Tomaste el control de esta conversación', 'success');
    cargarHiloChat({ forzarAbajo: true });
}

async function cambiarModoChat() {
    if (!_chatId) return;
    const btn = $('lv-chat-modo');
    const nuevo = _chatModo === 'humano' ? 'bot' : 'humano';
    if (btn) btn.disabled = true;
    const res = await vlApi.chatModo(_chatId, nuevo);
    if (btn) btn.disabled = false;
    if (!res.ok) { mostrarToast(res.error || 'No se pudo cambiar el modo', 'error'); return; }
    _chatModo = nuevo;
    pintarCabeceraChat();
    mostrarToast(nuevo === 'humano' ? 'Bot en pausa en esta conversación' : 'El bot vuelve a responder', 'success');
}
