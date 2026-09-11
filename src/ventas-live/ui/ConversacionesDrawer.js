// ventas-live/ui/ConversacionesDrawer.js
// Cajón lateral de conversaciones para MODO LIVE.
//
// Se abre como un panel SOBREPUESTO en el borde derecho: la columna
// izquierda del LIVE ("Registrar venta") queda siempre visible y usable,
// así se puede cargar un pedido mientras se lee el chat.
//
// Dos vistas dentro del mismo cajón:
//   1. Lista: quién escribió, último mensaje, hora, sin leer y modo.
//   2. Chat: al presionar a alguien se abre su conversación para leer y
//      responder (mismo circuito que el chat del cliente del LIVE).
//
// Datos: vl_wa_chats_listar / vl_wa_chat_hilo / vl_wa_chat_modo (RPCs admin)
// y la Edge Function wa-enviar para los mensajes salientes.

import { vlApi } from '../domain/vlApi.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { escapeHtml } from '../../shared/infrastructure/formatters.js';
import { ESTADO_CHAT, AVISO_CHAT, fmtHora, burbujasHtml, nombreDeCliente, autoScrollAbajo } from './chatComun.js';

const REFRESCO_ABIERTO_MS = 15000;
const REFRESCO_BADGE_MS = 30000;

let _built = false;
let _abierto = false;
let _chatId = null;
let _chatMeta = null;
let _chats = [];
let _enviando = false;
let _onBadge = null;
let _timerAbierto = null;
let _timerBadge = null;

function $(id) { return document.getElementById(id); }

/**
 * Construye el cajón y arranca el contador de no leídos.
 * @param {{onBadge?: (n:number)=>void}} opts
 */
export function initConversacionesDrawer({ onBadge } = {}) {
    _onBadge = onBadge || null;

    if (!_built) {
        const el = document.createElement('div');
        el.className = 'vl-drawer';
        el.id = 'vl-drawer';
        el.setAttribute('aria-hidden', 'true');
        el.innerHTML = `
            <div class="vl-drawer-head">
                <button class="vld-icon" id="vld-volver" type="button" title="Volver a la lista" style="display:none;">
                    <i class="fas fa-arrow-left"></i>
                </button>
                <div class="vld-titulo" id="vld-titulo">Conversaciones</div>
                <button class="vl-btn" id="vld-modo" type="button" style="display:none;"></button>
                <button class="vld-icon" id="vld-cerrar" type="button" title="Cerrar">
                    <i class="fas fa-xmark"></i>
                </button>
            </div>
            <div class="vld-sub" id="vld-sub">Quién te escribió por WhatsApp</div>
            <div class="vld-body" id="vld-body"></div>
            <div class="vld-foot" id="vld-foot" style="display:none;">
                <input class="vl-control" id="vld-input" maxlength="1000"
                       placeholder="Responder por WhatsApp…" autocomplete="off">
                <button class="vl-btn primary" id="vld-enviar" type="button" title="Enviar">
                    <i class="fas fa-paper-plane"></i>
                </button>
            </div>`;
        document.body.appendChild(el);

        $('vld-cerrar').addEventListener('click', cerrarConversaciones);
        $('vld-volver').addEventListener('click', volverALista);
        $('vld-modo').addEventListener('click', cambiarModo);
        $('vld-enviar').addEventListener('click', enviar);
        $('vld-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); enviar(); }
        });

        _built = true;
    }

    iniciarContadorBadge();
}

/** Refresca el contador de no leídos (lo llama el LIVE al activarse). */
export function refrescarContador() {
    cargarChats({ silencioso: true });
}

export function estaAbierto() { return _abierto; }

export function toggleConversaciones() {
    if (_abierto) cerrarConversaciones();
    else abrirConversaciones();
}

export function abrirConversaciones() {
    if (!_built) return;
    _abierto = true;
    const el = $('vl-drawer');
    if (el) {
        // Arranca justo debajo de la barra superior para no tapar
        // "Mis proyectos" / "Cerrar sesión". Se recalcula al abrir (si la
        // página está scrolleada, la barra ya salió de vista → arranca arriba).
        const tb = document.querySelector('.vl-topbar');
        const top = tb ? Math.max(0, Math.round(tb.getBoundingClientRect().bottom)) : 0;
        el.style.top = top + 'px';
        el.style.height = `calc(100vh - ${top}px)`;
        el.classList.add('abierto');
        el.setAttribute('aria-hidden', 'false');
    }
    volverALista();
    if (_timerAbierto) clearInterval(_timerAbierto);
    _timerAbierto = setInterval(() => {
        if (!_abierto) return;
        if (_enviando) return;
        if (_chatId) cargarHilo(_chatId, { silencioso: true });
        else cargarChats({ silencioso: true });
    }, REFRESCO_ABIERTO_MS);
}

export function cerrarConversaciones() {
    _abierto = false;
    const el = $('vl-drawer');
    if (el) { el.classList.remove('abierto'); el.setAttribute('aria-hidden', 'true'); }
    if (_timerAbierto) { clearInterval(_timerAbierto); _timerAbierto = null; }
}

function iniciarContadorBadge() {
    if (_timerBadge) clearInterval(_timerBadge);
    _timerBadge = setInterval(() => {
        const vista = $('vl-view-live');
        if (!vista || !vista.classList.contains('active')) return;
        if (_built && !_abierto) cargarChats({ silencioso: true });
    }, REFRESCO_BADGE_MS);
}

// ── Lista de conversaciones ─────────────────────────────────────────
async function cargarChats({ silencioso = false } = {}) {
    const body = $('vld-body');
    if (!body) return;
    if (!silencioso && !_chatId) body.innerHTML = '<div class="vl-empty"><i class="fas fa-spinner fa-spin"></i> Cargando…</div>';

    const res = await vlApi.chatsListar();
    if (!res.ok) {
        if (!_chatId) body.innerHTML = `<div class="vl-empty">${escapeHtml(res.error || 'No se pudieron cargar las conversaciones')}</div>`;
        return;
    }
    _chats = (res.data && Array.isArray(res.data.chats)) ? res.data.chats : [];

    const sinLeer = _chats.reduce((a, c) => a + (Number(c.sin_leer) || 0), 0);
    if (_onBadge) _onBadge(sinLeer);

    if (_abierto && !_chatId) renderLista();
}

function renderLista() {
    const body = $('vld-body');
    if (!body) return;
    if (_chats.length === 0) {
        body.innerHTML = `<div class="vl-empty">
            <i class="far fa-comments"></i><br>
            Todavía no hay conversaciones.<br>
            <span style="font-size:0.85rem;">Cuando un cliente escriba al WhatsApp del negocio, aparece acá.</span>
        </div>`;
        return;
    }

    body.innerHTML = _chats.map(c => {
        const nombre = c.nombre_real || (c.tiktok_user ? '@' + c.tiktok_user : c.wa_id);
        const sub = c.tiktok_user ? '@' + c.tiktok_user : c.wa_id;
        const nuevo = Number(c.sin_leer) > 0;
        const modo = c.modo === 'humano'
            ? '<span class="vl-conv-chip humano">👤 Tú</span>'
            : '<span class="vl-conv-chip bot">🤖 Bot</span>';
        const noLeido = nuevo ? `<span class="vl-conv-noleido">${Number(c.sin_leer)}</span>` : '';
        // Aviso que dejó el bot: qué hay que revisar en este chat
        const aviso = c.aviso_tipo
            ? `<span class="vl-conv-chip aviso" title="${escapeHtml(c.aviso_detalle || '')}">⚠️ ${escapeHtml(AVISO_CHAT[c.aviso_tipo] || c.aviso_tipo)}</span>`
            : '';
        return `
            <button class="vl-conv-item${nuevo ? ' activo' : ''}${c.aviso_tipo ? ' con-aviso' : ''}" data-chat="${escapeHtml(c.id)}" type="button">
                <div class="vl-conv-top">
                    <span class="vl-conv-nombre">${escapeHtml(nombre)}</span>
                    <span class="vl-conv-hora">${escapeHtml(fmtHora(c.ultimo_en))}</span>
                </div>
                <div class="vl-conv-num">${escapeHtml(sub)}</div>
                <div class="vl-conv-msg">${escapeHtml(c.ultimo_mensaje || '')}</div>
                <div class="vl-conv-foot">
                    ${aviso}<span class="vl-conv-chip">${escapeHtml(ESTADO_CHAT[c.estado] || c.estado)}</span>
                    ${modo}${noLeido}
                </div>
            </button>`;
    }).join('');

    body.querySelectorAll('.vl-conv-item').forEach(b => {
        b.addEventListener('click', () => abrirChat(b.dataset.chat));
    });
}

// ── Conversación abierta ────────────────────────────────────────────
async function abrirChat(chatId) {
    _chatId = chatId;
    _chatMeta = null;
    const body = $('vld-body');
    if (body) body.innerHTML = '<div class="vl-empty"><i class="fas fa-spinner fa-spin"></i> Cargando…</div>';
    await cargarHilo(chatId);
}

async function cargarHilo(chatId, { silencioso = false } = {}) {
    const body = $('vld-body');
    if (!body) return;

    const res = await vlApi.chatHilo(chatId);
    if (!res.ok) {
        mostrarToast(res.error || 'No se pudo abrir la conversación', 'error');
        volverALista();
        return;
    }
    _chatMeta = (res.data && res.data.chat) || null;
    const mensajes = (res.data && Array.isArray(res.data.mensajes)) ? res.data.mensajes : [];
    if (!_chatMeta) { volverALista(); return; }

    body.innerHTML = `<div class="vld-hilo" id="vld-hilo">${burbujasHtml(mensajes, { nombreCliente: nombreDeCliente(_chatMeta) })}</div>`;
    autoScrollAbajo($('vld-hilo'), { forzar: !silencioso });

    pintarModoChat();
    if (!silencioso) cargarChats({ silencioso: true });
}

function pintarModoChat() {
    const titulo = $('vld-titulo');
    const sub = $('vld-sub');
    const volver = $('vld-volver');
    const modoBtn = $('vld-modo');
    const foot = $('vld-foot');
    const humano = _chatMeta && _chatMeta.modo === 'humano';

    if (titulo) titulo.textContent = nombreDeCliente(_chatMeta);
    if (volver) volver.style.display = 'inline-block';
    if (sub) {
        const partes = [];
        if (_chatMeta && _chatMeta.wa_id) partes.push(_chatMeta.wa_id);
        if (_chatMeta && _chatMeta.estado) partes.push(ESTADO_CHAT[_chatMeta.estado] || _chatMeta.estado);
        partes.push(humano ? 'Atiendes tú (bot en pausa)' : 'Responde el bot');
        sub.textContent = partes.join(' · ');
    }
    if (modoBtn) {
        modoBtn.style.display = 'inline-flex';
        modoBtn.className = humano ? 'vl-btn success' : 'vl-btn';
        modoBtn.innerHTML = humano
            ? '<i class="fas fa-robot"></i> Devolver al bot'
            : '<i class="fas fa-user"></i> Tomar el control';
        modoBtn.dataset.modo = humano ? 'humano' : 'bot';
    }
    if (foot) foot.style.display = 'flex';
}

function volverALista() {
    _chatId = null;
    _chatMeta = null;
    _enviando = false;

    const titulo = $('vld-titulo');
    const sub = $('vld-sub');
    const volver = $('vld-volver');
    const modoBtn = $('vld-modo');
    const foot = $('vld-foot');
    const input = $('vld-input');

    if (titulo) titulo.textContent = 'Conversaciones';
    if (sub) sub.textContent = 'Quién te escribió por WhatsApp';
    if (volver) volver.style.display = 'none';
    if (modoBtn) modoBtn.style.display = 'none';
    if (foot) foot.style.display = 'none';
    if (input) input.value = '';
    renderLista();
}

// ── Enviar / modo ───────────────────────────────────────────────────
async function enviar() {
    if (_enviando || !_chatId) return;
    const input = $('vld-input');
    const btn = $('vld-enviar');
    const texto = input ? input.value.trim() : '';
    if (!texto) return;

    _enviando = true;
    if (btn) btn.disabled = true;

    let tomoControl = false;
    if (_chatMeta && _chatMeta.modo === 'bot') {
        const r = await vlApi.chatModo(_chatId, 'humano');
        if (r.ok) { _chatMeta.modo = 'humano'; tomoControl = true; pintarModoChat(); }
    }

    const res = await vlApi.enviarManual(_chatId, texto);

    _enviando = false;
    if (btn) btn.disabled = false;

    if (!res.ok) {
        mostrarToast(res.error || 'No se pudo enviar el mensaje', 'error');
        return;
    }
    input.value = '';
    if (tomoControl) mostrarToast('Tomaste el control: el bot queda en pausa acá', 'success');
    await cargarHilo(_chatId, { silencioso: true });
}

async function cambiarModo() {
    if (!_chatId || !_chatMeta) return;
    const btn = $('vld-modo');
    const nuevo = _chatMeta.modo === 'humano' ? 'bot' : 'humano';
    if (btn) btn.disabled = true;
    const res = await vlApi.chatModo(_chatId, nuevo);
    if (btn) btn.disabled = false;
    if (!res.ok) {
        mostrarToast(res.error || 'No se pudo cambiar el modo', 'error');
        return;
    }
    _chatMeta.modo = nuevo;
    pintarModoChat();
    mostrarToast(nuevo === 'humano' ? 'Bot en pausa: atiendes tú' : 'El bot vuelve a responder', 'success');
}
