// ventas-live/ui/ChatsView.js
// Vista Chats: las conversaciones de WhatsApp que atiende el bot, con
// intervención humana. El admin puede leer todo el hilo, responder a mano
// y tomar el control (pausa el bot SOLO en esa conversación) o devolvérselo.
//
// Datos: vl_wa_chats_listar / vl_wa_chat_hilo / vl_wa_chat_modo (RPCs admin).
// Envío manual: Edge Function wa-enviar (valida admin, usa el token del
// espacio server-side). El token nunca llega al navegador.

import { vlApi } from '../domain/vlApi.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { escapeHtml } from '../../shared/infrastructure/formatters.js';
import { ESTADO_CHAT, fmtHora, burbujasHtml, nombreDeCliente, autoScrollAbajo } from './chatComun.js';

const REFRESCO_MS = 15000;

let _built = false;
let _chats = [];
let _chatId = null;
let _chatMeta = null;
let _timer = null;
let _enviando = false;

function $(id) { return document.getElementById(id); }

export function initChats() {
    const cont = $('vl-view-chats');
    if (!cont) return;

    if (!_built) {
        cont.innerHTML = `
            <div class="vl-chats-grid">
                <div class="vl-card vl-chats-lista">
                    <h2><i class="fab fa-whatsapp"></i> Conversaciones</h2>
                    <div class="sub">Los mensajes de tus clientes llegan acá. Puedes responder tú en cualquier momento.</div>
                    <div id="vcch-lista"><div class="vl-empty"><i class="fas fa-spinner fa-spin"></i> Cargando…</div></div>
                </div>
                <div class="vl-card vl-chats-hilo">
                    <div class="vl-empty vl-chat-vacio" id="vcch-vacio"><i class="far fa-comments"></i><br>Elige una conversación</div>
                    <div class="vl-chat-ventana" id="vcch-hilo">
                        <div class="vl-chat-head">
                            <div class="vl-chat-head-info">
                                <div class="vl-chat-avatar" id="vcch-avatar">?</div>
                                <div style="min-width:0;">
                                    <div class="vl-chat-nick" id="vcch-nick">—</div>
                                    <div class="vl-chat-sub" id="vcch-sub">—</div>
                                </div>
                            </div>
                            <button class="vl-btn" id="vcch-modo" type="button"></button>
                        </div>
                        <div class="vl-chat-aviso bot" id="vcch-aviso"></div>
                        <div class="vl-chat-scroll" id="vcch-msgs"></div>
                        <div class="vl-chat-composer">
                            <textarea class="vl-control" id="vcch-input" rows="1" maxlength="1000"
                                placeholder="Escribe tu respuesta… (Enter para enviar)"></textarea>
                            <button class="vl-btn primary" id="vcch-enviar" type="button">
                                <i class="fas fa-paper-plane"></i> Enviar
                            </button>
                        </div>
                    </div>
                </div>
            </div>`;
        _built = true;
        bindEventos();
    }

    cargarLista();
    iniciarRefresco();
}

function bindEventos() {
    const btn = $('vcch-enviar');
    const input = $('vcch-input');
    const modoBtn = $('vcch-modo');

    if (btn) btn.addEventListener('click', enviar);
    if (input) {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                enviar();
            }
        });
    }
    if (modoBtn) modoBtn.addEventListener('click', cambiarModo);
}

// ── Refresco periódico (solo con la pestaña visible) ─────────────────
function iniciarRefresco() {
    if (_timer) clearInterval(_timer);
    _timer = setInterval(() => {
        const cont = $('vl-view-chats');
        if (!cont || !cont.classList.contains('active')) return;
        if (_enviando) return;
        cargarLista({ silencioso: true });
        if (_chatId) cargarHilo(_chatId, { silencioso: true });
    }, REFRESCO_MS);
}

// ── Lista de conversaciones ─────────────────────────────────────────
async function cargarLista({ silencioso = false } = {}) {
    const cont = $('vcch-lista');
    if (!cont) return;
    if (!silencioso) cont.innerHTML = '<div class="vl-empty"><i class="fas fa-spinner fa-spin"></i> Cargando…</div>';

    const res = await vlApi.chatsListar();
    if (!res.ok) {
        cont.innerHTML = `<div class="vl-empty">${escapeHtml(res.error || 'No se pudieron cargar las conversaciones')}</div>`;
        return;
    }
    _chats = (res.data && Array.isArray(res.data.chats)) ? res.data.chats : [];
    renderLista();
}

function renderLista() {
    const cont = $('vcch-lista');
    if (!cont) return;

    if (_chats.length === 0) {
        cont.innerHTML = `<div class="vl-empty">
            <i class="far fa-comments"></i><br>
            Todavía no hay conversaciones.<br>
            <span style="font-size:0.85rem;">Cuando un cliente le escriba al WhatsApp del negocio, aparece acá.</span>
        </div>`;
        return;
    }

    cont.innerHTML = _chats.map(c => {
        const nombre = c.nombre_real || (c.tiktok_user ? '@' + c.tiktok_user : c.wa_id);
        const sub = c.tiktok_user ? '@' + c.tiktok_user : c.wa_id;
        const activo = c.id === _chatId ? ' activo' : '';
        const sinLeer = Number(c.sin_leer) > 0
            ? `<span class="vl-chat-badge">${Number(c.sin_leer)}</span>` : '';
        const humano = c.modo === 'humano'
            ? '<span class="vl-chat-modo humano" title="Atendiendo tú (bot en pausa)">👤 Tú</span>' : '';
        return `
            <button class="vl-chat-item${activo}" data-chat="${escapeHtml(c.id)}" type="button">
                <div class="vl-chat-item-top">
                    <span class="vl-chat-item-nick">${escapeHtml(nombre)}</span>
                    <span class="vl-chat-item-hora">${escapeHtml(fmtHora(c.ultimo_en))}</span>
                </div>
                <div class="vl-chat-item-sub">${escapeHtml(sub)}</div>
                <div class="vl-chat-item-msg">${escapeHtml(c.ultimo_mensaje || '')}</div>
                <div class="vl-chat-item-foot">
                    <span class="vl-chat-estado">${escapeHtml(ESTADO_CHAT[c.estado] || c.estado)}</span>
                    ${humano}${sinLeer}
                </div>
            </button>`;
    }).join('');

    cont.querySelectorAll('.vl-chat-item').forEach(el => {
        el.addEventListener('click', () => abrirChat(el.dataset.chat));
    });
}

// ── Hilo de una conversación ────────────────────────────────────────
async function abrirChat(chatId) {
    _chatId = chatId;
    renderLista();
    await cargarHilo(chatId);
}

async function cargarHilo(chatId, { silencioso = false } = {}) {
    const msgsEl = $('vcch-msgs');
    if (!msgsEl) return;
    if (!silencioso) msgsEl.innerHTML = '<div class="vl-empty"><i class="fas fa-spinner fa-spin"></i> Cargando…</div>';

    const res = await vlApi.chatHilo(chatId);
    if (!res.ok) {
        mostrarToast(res.error || 'No se pudo abrir la conversación', 'error');
        return;
    }
    _chatMeta = res.data && res.data.chat ? res.data.chat : null;
    const mensajes = (res.data && Array.isArray(res.data.mensajes)) ? res.data.mensajes : [];
    if (!_chatMeta) return;

    const vacioEl = $('vcch-vacio');
    const hiloEl = $('vcch-hilo');
    if (vacioEl) vacioEl.style.display = 'none';
    if (hiloEl) hiloEl.classList.add('visible');

    pintarCabecera(_chatMeta);
    renderMensajes(mensajes, { forzarAbajo: !silencioso });
    if (!silencioso) renderLista();
}

function pintarCabecera(chat) {
    const nick = $('vcch-nick');
    const sub = $('vcch-sub');
    const modoBtn = $('vcch-modo');
    const aviso = $('vcch-aviso');
    const avatar = $('vcch-avatar');
    const nombre = chat.nombre_real || (chat.tiktok_user ? '@' + chat.tiktok_user : chat.wa_id);

    if (nick) nick.textContent = nombre;
    if (avatar) {
        const base = (chat.nombre_real || chat.tiktok_user || chat.wa_id || '?').replace(/^@/, '');
        avatar.textContent = (base[0] || '?').toUpperCase();
    }
    if (sub) {
        const partes = [chat.wa_id];
        if (chat.tiktok_user) partes.unshift('@' + chat.tiktok_user);
        partes.push(ESTADO_CHAT[chat.estado] || chat.estado);
        sub.textContent = partes.join(' · ');
    }

    const humano = chat.modo === 'humano';
    if (modoBtn) {
        modoBtn.className = humano ? 'vl-btn success' : 'vl-btn';
        modoBtn.innerHTML = humano
            ? '<i class="fas fa-robot"></i> Devolver al bot'
            : '<i class="fas fa-user"></i> Tomar el control';
        modoBtn.dataset.modo = chat.modo;
    }
    if (aviso) {
        aviso.className = humano ? 'vl-chat-aviso humano' : 'vl-chat-aviso bot';
        aviso.innerHTML = humano
            ? '<i class="fas fa-user"></i> Estás atendiendo tú: el bot está en pausa en esta conversación.'
            : '<i class="fas fa-robot"></i> El bot responde solo. Si escribes, tomas el control.';
    }
}

function renderMensajes(mensajes, { forzarAbajo = false } = {}) {
    const el = $('vcch-msgs');
    if (!el) return;
    el.innerHTML = burbujasHtml(mensajes, { nombreCliente: nombreDeCliente(_chatMeta) });
    autoScrollAbajo(el, { forzar: forzarAbajo });
}

// ── Envío manual ────────────────────────────────────────────────────
async function enviar() {
    if (_enviando) return;
    const input = $('vcch-input');
    const btn = $('vcch-enviar');
    if (!input || !_chatId) {
        mostrarToast('Elige una conversación primero', 'warning');
        return;
    }
    const texto = input.value.trim();
    if (!texto) return;

    _enviando = true;
    if (btn) btn.disabled = true;

    // Si el bot está activo, tomar el control primero: si no, el bot
    // seguiría contestando y el cliente vería dos voces mezcladas.
    let avisoControl = false;
    if (_chatMeta && _chatMeta.modo === 'bot') {
        const r = await vlApi.chatModo(_chatId, 'humano');
        if (r.ok) {
            avisoControl = true;
            _chatMeta.modo = 'humano';
            pintarCabecera(_chatMeta);
            renderLista();
        }
    }

    const res = await vlApi.enviarManual(_chatId, texto);

    _enviando = false;
    if (btn) btn.disabled = false;

    if (!res.ok) {
        mostrarToast(res.error || 'No se pudo enviar el mensaje', 'error');
        return;
    }

    input.value = '';
    if (avisoControl) mostrarToast('Tomaste el control: el bot queda en pausa acá', 'success');
    await cargarHilo(_chatId, { silencioso: true });
}

// ── Bot <-> humano ──────────────────────────────────────────────────
async function cambiarModo() {
    const modoBtn = $('vcch-modo');
    if (!modoBtn || !_chatId) return;
    const actual = modoBtn.dataset.modo || 'bot';
    const nuevo = actual === 'humano' ? 'bot' : 'humano';

    modoBtn.disabled = true;
    const res = await vlApi.chatModo(_chatId, nuevo);
    modoBtn.disabled = false;

    if (!res.ok) {
        mostrarToast(res.error || 'No se pudo cambiar el modo', 'error');
        return;
    }
    if (_chatMeta) _chatMeta.modo = nuevo;
    pintarCabecera(_chatMeta || { modo: nuevo, wa_id: '' });
    mostrarToast(
        nuevo === 'humano' ? 'Bot en pausa: atiendes tú esta conversación' : 'El bot vuelve a responder',
        'success'
    );
    cargarLista({ silencioso: true });
    const input = $('vcch-input');
    if (input && nuevo === 'humano') input.focus();
}
