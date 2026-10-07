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

import { vlApi, ESTADO_INFO } from '../domain/vlApi.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { escapeHtml, formatearDinero } from '../../shared/infrastructure/formatters.js';
import { getSupabase } from '../../shared/infrastructure/supabase.js';
import {
    ESTADO_CHAT, avisoLabel, avisoAccion, avisoDetalle, AVISOS_RESPUESTA,
    fmtHora, burbujasHtml, nombreDeCliente, autoScrollAbajo,
    quienContesta, procesoChips, firmarMedias
} from './chatComun.js';
import {
    PUNTO_LABEL, PUNTO_VALOR_LABEL,
    accionesChatHtml, bindAccionesChat, procesoParaModales
} from './accionesProceso.js';

// Refresco: el dueño reportó que "tarda en verse cuando llegó el mensaje".
// 5 s con el chat abierto, 8 s el contador de la lista; además Realtime avisa
// al instante cuando la conexión funciona (esto queda como respaldo).
const REFRESCO_ABIERTO_MS = 5000;
const REFRESCO_BADGE_MS = 8000;
const NOTIF_KEY = 'vl_notif_avisos';

let _built = false;
let _abierto = false;
let _chatId = null;
let _chatMeta = null;
let _chats = [];
let _enviando = false;
let _onBadge = null;
let _timerAbierto = null;
let _timerBadge = null;
let _notifActivas = false;   // avisos del navegador (los activa el usuario)
let _avisosVistos = null;    // null = primera carga: no notificar lo ya existente
let _sinLeerPrev = 0;
let _verOcultos = false;     // mostrar también los chats ocultos (no-venta)
let _canalRt = null;         // canal Realtime (mensajes al instante)
let _visibilidad = null;     // listener de "volviste a la pestaña"
let _audioCtx = null;        // WebAudio para el pitido de alarma
let _chatProc = null;        // proceso abierto del chat que se está viendo

function $(id) { return document.getElementById(id); }

/**
 * Construye el cajón y arranca el contador de no leídos.
 * @param {{onBadge?: (n:number)=>void}} opts
 */
export function initConversacionesDrawer({ onBadge } = {}) {
    _onBadge = onBadge || null;

    try { _notifActivas = localStorage.getItem(NOTIF_KEY) === '1'; } catch (e) { _notifActivas = false; }

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
                <button class="vld-icon" id="vld-ocultos" type="button" title="Ver chats ocultos" style="display:none;">
                    <i class="fas fa-eye"></i>
                </button>
                <button class="vl-btn" id="vld-ocultar" type="button" style="display:none;"></button>
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
        $('vld-ocultos').addEventListener('click', toggleOcultos);
        $('vld-ocultar').addEventListener('click', ocultarChatActual);
        $('vld-enviar').addEventListener('click', enviar);
        $('vld-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); enviar(); }
        });

        _built = true;
    }

    iniciarContadorBadge();
    iniciarRealtime();
}

/** Refresca el contador de no leídos (lo llama el LIVE al activarse). */
export function refrescarContador() {
    cargarChats({ silencioso: true });
}

export function estaAbierto() { return _abierto; }

// Abre el cajón de Conversaciones en el chat de un cliente (por su @ de TikTok).
// Lo usa el bloque de entregas para "confirmar en el chat" antes de actuar.
export async function abrirChatDeUsuario(tiktokUser) {
    const user = btrimLower(tiktokUser);
    if (!user) return false;
    abrirConversaciones();
    await cargarChats({ silencioso: true });
    const chat = _chats.find(c => btrimLower(c.tiktok_user) === user);
    if (!chat) return false;
    await abrirChat(chat.id);
    return true;
}

function btrimLower(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

export function toggleConversaciones() {
    if (_abierto) cerrarConversaciones();
    else abrirConversaciones();
}

export function abrirConversaciones() {
    if (!_built) return;
    _abierto = true;
    limpiarTituloPendiente();   // al abrir, el aviso del título ya cumplió su función
    const el = $('vl-drawer');
    if (el) {
        // Panel flotante: deja el mismo margen con los bordes que la CSS
        // (14px en web/tablet, 10px en móvil) para que el chat no quede
        // pegado al canto de la pantalla.
        const MARGEN = window.matchMedia('(max-width: 860px)').matches ? 10 : 14;
        // Arranca justo debajo de la barra superior para no tapar
        // "Mis proyectos" / "Cerrar sesión". Se recalcula al abrir (si la
        // página está scrolleada, la barra ya salió de vista → arranca arriba).
        const tb = document.querySelector('.vl-topbar');
        const bordeBarra = tb ? Math.round(tb.getBoundingClientRect().bottom) : 0;
        const top = Math.max(MARGEN, bordeBarra + 8);
        el.style.top = top + 'px';
        el.style.height = `calc(100vh - ${top}px - ${MARGEN}px)`;
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
        // ANTES esto solo corría con la pestaña LIVE a la vista: si estabas en
        // Clientes o en Procesos no te enterabas de los mensajes. Ahora corre
        // siempre que el panel esté abierto (salvo pestaña del navegador oculta).
        if (document.hidden) return;
        if (_built && !_abierto) cargarChats({ silencioso: true });
    }, REFRESCO_BADGE_MS);

    // Al volver a la pestaña, refrescar enseguida (sin esperar el turno del timer).
    if (!_visibilidad) {
        _visibilidad = () => {
            if (document.hidden) return;
            if (_abierto && _chatId) cargarHilo(_chatId, { silencioso: true });
            else cargarChats({ silencioso: true });
        };
        document.addEventListener('visibilitychange', _visibilidad);
    }
}

// ── Realtime: los mensajes llegan al instante ───────────────────────
// El sondeo de 5 s queda como RESPALDO: si Realtime no conecta (navegador que lo
// bloquea, red mala), el panel sigue funcionando igual.
function iniciarRealtime() {
    if (_canalRt) return;
    const sb = getSupabase();
    if (!sb || typeof sb.channel !== 'function') return;
    try {
        _canalRt = sb
            .channel('vl-wa-live')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'vl_wa_mensajes' }, (payload) => {
                const row = (payload && payload.new) || {};
                if (_abierto && _chatId && row.chat_id === _chatId && !_enviando) {
                    cargarHilo(_chatId, { silencioso: true });
                }
                cargarChats({ silencioso: true });
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'vl_wa_avisos' }, () => {
                cargarChats({ silencioso: true });
            })
            .subscribe();
    } catch (_) {
        _canalRt = null;   // sin Realtime: sigue el sondeo de 5 s
    }
}

// ── Avisos del navegador ────────────────────────────────────────────
/** Estado actual de los avisos de escritorio. */
export function notificacionesEstado() {
    const soportado = typeof Notification !== 'undefined';
    return {
        soportado,
        permiso: soportado ? Notification.permission : 'unsupported',
        activas: _notifActivas && soportado && Notification.permission === 'granted'
    };
}

/** Pide permiso al navegador (necesita un clic del usuario). */
export async function activarNotificaciones() {
    if (typeof Notification === 'undefined') {
        return { ok: false, error: 'Este navegador no soporta avisos de escritorio' };
    }
    let permiso = Notification.permission;
    if (permiso === 'default') {
        try { permiso = await Notification.requestPermission(); } catch (e) { permiso = 'denied'; }
    }
    if (permiso !== 'granted') {
        return { ok: false, error: 'No diste permiso. Actívalos desde el candado de la barra de direcciones.' };
    }
    _notifActivas = true;
    if (_avisosVistos === null) _avisosVistos = new Set();
    try { localStorage.setItem(NOTIF_KEY, '1'); } catch (e) { /* modo privado */ }
    return { ok: true };
}

/** Apaga los avisos de escritorio (el permiso del navegador se mantiene). */
export function desactivarNotificaciones() {
    _notifActivas = false;
    try { localStorage.setItem(NOTIF_KEY, '0'); } catch (e) { /* modo privado */ }
}

/** Aviso abierto del chat (para el banner del hilo). */
function avisoDelChat(chatId) {
    const c = _chats.find(x => x.id === chatId);
    if (!c || !c.tiene_aviso || !c.aviso_tipo) return null;
    return { tipo: c.aviso_tipo, detalle: c.aviso_detalle || '' };
}

/**
 * Compara los avisos de esta carga con los de la anterior y lanza la
 * notificación de escritorio de los NUEVOS (dice qué pasó y qué hacer).
 */
function revisarAvisosNuevos() {
    const claves = new Set();
    _chats.forEach(c => { if (c.tiene_aviso && c.aviso_tipo) claves.add(c.id + '|' + c.aviso_tipo); });

    // Primera carga: se registra lo que ya había sin avisar (no spamear al abrir)
    if (_avisosVistos === null) {
        _avisosVistos = claves;
        return;
    }

    const nuevos = _chats.filter(c => c.tiene_aviso && c.aviso_tipo && !_avisosVistos.has(c.id + '|' + c.aviso_tipo));
    _avisosVistos = claves;

    // OJO: acá estaba el corte que impedía avisar cuando el permiso de escritorio
    // estaba apagado. La alarma (sonido/vibración/título) va SIEMPRE: es justamente
    // el "avísame cuando llegue un mensaje" que pidió el dueño.
    if (nuevos.length > 0) {
        notificar(nuevos[0], true);
        return;
    }
    // Sin avisos nuevos: si llegaron mensajes sin leer, avisa igual
    const totalSinLeer = _chats.reduce((a, c) => a + (Number(c.sin_leer) || 0), 0);
    if (totalSinLeer > _sinLeerPrev) {
        const conMensajes = _chats.find(c => Number(c.sin_leer) > 0);
        if (conMensajes) notificar(conMensajes, false);
    }
    // Todo visto: se limpia el "● (n)" del título.
    if (totalSinLeer === 0 && !_chats.some(c => c.tiene_aviso)) limpiarTituloPendiente();
}

// ── Alarma: sonido + vibración + título de la pestaña ───────────────
// El dueño pidió "algo que alarme" cuando llega un mensaje: el aviso de
// escritorio puede estar bloqueado o pasar desapercibido, así que además suena,
// vibra (Android) y el título de la pestaña queda con "● (n)" hasta que revises.
function sonarAlarma() {
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        _audioCtx = _audioCtx || new Ctx();
        const ctx = _audioCtx;
        if (ctx.state === 'suspended') ctx.resume();
        const t0 = ctx.currentTime;
        [0, 0.18].forEach((off, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = i === 0 ? 880 : 1180;
            gain.gain.setValueAtTime(0.0001, t0 + off);
            gain.gain.exponentialRampToValueAtTime(0.22, t0 + off + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.16);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(t0 + off);
            osc.stop(t0 + off + 0.17);
        });
    } catch (_) { /* sin audio: sigue el aviso visual */ }
}

function vibrarAlarma() {
    try { if (navigator.vibrate) navigator.vibrate([180, 90, 180]); } catch (_) { /* iOS no soporta */ }
}

function tituloBase() {
    return String(document.title || 'Ventas Live').replace(/^● \(\d+\)\s*/, '');
}

function tituloPendiente(n) {
    if (n > 0) document.title = '● (' + n + ') ' + tituloBase();
}

function limpiarTituloPendiente() {
    const t = String(document.title || '');
    if (t.indexOf('● (') === 0) document.title = tituloBase();
}

function notificar(chat, esAviso) {
    const quien = chat.tiktok_user ? '@' + chat.tiktok_user : (chat.nombre_real || chat.wa_id || 'Cliente');
    let titulo;
    let cuerpo;
    if (esAviso) {
        // Los avisos que necesitan que conteste una PERSONA (el bot no supo
        // responder, no encontró al cliente, llegó un comprobante…) se anuncian
        // distinto: el dueño pidió "una alerta para revisar la web, sobre todo
        // cuando el bot no sabe responder".
        const necesitaHumano = AVISOS_RESPUESTA.indexOf(chat.aviso_tipo) >= 0;
        titulo = (necesitaHumano ? '✋ CONTESTA TÚ — ' : '⚠️ ')
               + avisoLabel(chat.aviso_tipo) + ' — ' + quien;
        cuerpo = (avisoDetalle(chat.aviso_tipo, chat.aviso_detalle) || '') +
                 (avisoAccion(chat.aviso_tipo) ? '\nQué hacer: ' + avisoAccion(chat.aviso_tipo) : '');
    } else {
        titulo = '💬 ' + quien + ' te escribió';
        cuerpo = chat.ultimo_mensaje || '';
    }

    // Si ya estás leyendo ESE chat con la pestaña visible, no se alarma (molestaría).
    const leyendo = !document.hidden && _abierto && _chatId === chat.id;
    const pendientes = _chats.reduce((a, c) => a + (Number(c.sin_leer) || 0), 0);

    if (!leyendo) {
        sonarAlarma();
        vibrarAlarma();
        tituloPendiente(pendientes);
    }

    if (!_notifActivas || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

    try {
        const n = new Notification(titulo, {
            body: cuerpo,
            tag: 'vl-' + chat.id + '-' + (esAviso ? chat.aviso_tipo : 'msg'),
            renotify: true
        });
        n.onclick = () => {
            try { window.focus(); } catch (e) { /* ignore */ }
            abrirConversaciones();
            abrirChat(chat.id);
            n.close();
        };
    } catch (e) { /* el navegador puede bloquear el constructor */ }
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

    // El badge cuenta solo lo VISIBLE (los chats ocultos no-venta no alertan).
    const visibles = chatsVisibles();
    const sinLeer = visibles.reduce((a, c) => a + (Number(c.sin_leer) || 0), 0);
    // Avisos abiertos: aunque el chat esté leído, sigue habiendo algo que revisar
    const porRevisar = visibles.reduce((a, c) => a + (c.tiene_aviso ? 1 : 0), 0);
    if (_onBadge) _onBadge(sinLeer + porRevisar, { sinLeer, porRevisar });

    // Avisos nuevos -> notificación de escritorio (qué pasó + qué hacer)
    revisarAvisosNuevos();
    _sinLeerPrev = sinLeer;

    if (_abierto && !_chatId) renderLista();
}

// Chats que se muestran: los ocultos (no-venta) solo si el ojo está activo.
function chatsVisibles() {
    return _chats.filter(c => _verOcultos || !c.oculto);
}

// Proceso (puntos del pedido) del chat abierto: lo devuelve chats_listar.
function procDelChat(chatId) {
    const c = _chats.find(x => String(x.id) === String(chatId));
    return (c && c.proceso) || null;
}

function renderLista() {
    const body = $('vld-body');
    if (!body) return;

    // Botón del ojo (ver/no ver chats ocultos) — solo en la lista
    const ojo = $('vld-ocultos');
    const ocuBtn = $('vld-ocultar');
    if (ojo) {
        ojo.style.display = 'inline-flex';
        ojo.classList.toggle('activo', _verOcultos);
        ojo.title = _verOcultos ? 'Ocultar los chats no-venta' : 'Ver chats ocultos';
    }
    if (ocuBtn) ocuBtn.style.display = 'none';

    const lista = chatsVisibles();
    if (lista.length === 0) {
        body.innerHTML = `<div class="vl-empty">
            <i class="far fa-comments"></i><br>
            Todavía no hay conversaciones.<br>
            <span style="font-size:0.85rem;">Cuando un cliente escriba al WhatsApp del negocio, aparece acá.</span>
        </div>`;
        return;
    }

    body.innerHTML = lista.map(c => {
        const nombre = c.nombre_real || (c.tiktok_user ? '@' + c.tiktok_user : c.wa_id);
        const sub = c.tiktok_user ? '@' + c.tiktok_user : c.wa_id;
        const nuevo = Number(c.sin_leer) > 0;
        const modo = c.modo === 'humano'
            ? '<span class="vl-conv-chip humano">👤 Tú</span>'
            : '<span class="vl-conv-chip bot">🤖 Bot</span>';
        const noLeido = nuevo ? `<span class="vl-conv-noleido">${Number(c.sin_leer)}</span>` : '';
        // Aviso que dejó el bot: qué hay que revisar en este chat
        const aviso = c.aviso_tipo
            ? `<span class="vl-conv-chip aviso" title="${escapeHtml(avisoLabel(c.aviso_tipo) + ' — ' + avisoDetalle(c.aviso_tipo, c.aviso_detalle) + (avisoAccion(c.aviso_tipo) ? ' | Qué hacer: ' + avisoAccion(c.aviso_tipo) : ''))}">⚠️ ${escapeHtml(avisoLabel(c.aviso_tipo))}</span>`
            : '';
        // Quién tiene que mover este chat: se ve sin abrirlo. Cuando nos toca a
        // nosotros, el chip late suave (nunca rojo: es informativo).
        const qc = quienContesta(c);
        const quien = `<div class="vl-conv-quien ${qc.tipo}" title="${escapeHtml(qc.detalle || '')}">${escapeHtml(qc.label)}</div>`;
        const tuTurno = qc.tipo === 'humano' ? ' tu-turno' : '';

        return `
            <button class="vl-conv-item${nuevo ? ' activo' : ''}${c.aviso_tipo ? ' con-aviso' : ''}${c.oculto ? ' oculto' : ''}${tuTurno}" data-chat="${escapeHtml(c.id)}" type="button">
                <div class="vl-conv-top">
                    <span class="vl-conv-nombre">${escapeHtml(nombre)}</span>
                    <span class="vl-conv-hora">${escapeHtml(fmtHora(c.ultimo_en))}</span>
                </div>
                <div class="vl-conv-num">${escapeHtml(sub)}</div>
                <div class="vl-conv-msg">${escapeHtml(c.ultimo_mensaje || '')}</div>
                ${quien}
                ${procesoChips(c.proceso, escapeHtml)}
                <div class="vl-conv-foot">
                    ${aviso}<span class="vl-conv-chip">${escapeHtml(ESTADO_CHAT[c.estado] || c.estado)}</span>
                    ${c.oculto ? '<span class="vl-conv-chip oculto">🙈 Oculto</span>' : ''}
                    ${modo}${noLeido}
                </div>
            </button>`;
    }).join('');

    body.querySelectorAll('.vl-conv-item').forEach(b => {
        b.addEventListener('click', () => abrirChat(b.dataset.chat));
    });
}

// ── Etiquetas del PROCESO dentro del chat ───────────────────────────
// Muestra, sin salir del chat, qué se hizo y qué quedó definido
// (región, entrega, courier, pago, fecha) para no tener que abrir el
// diagrama. Lo que aún no está, sale en gris.
const ORDEN_PUNTOS_CHAT = ['region', 'entrega', 'courier', 'pago', 'fecha'];

function fmtFechaCorta(iso) {
    const p = String(iso || '').slice(0, 10).split('-');
    return p.length === 3 ? (p[2] + '/' + p[1]) : iso;
}

function procesoChipsHtml(proc) {
    if (!proc) {
        return `<div class="vl-chat-proceso vacio">
            <span class="vl-cp-titulo">Proceso</span>
            <span style="color:var(--muted,#adb5bd);">Sin pedido abierto con este contacto.</span>
        </div>`;
    }
    const etiqueta = (ESTADO_INFO[proc.estado] || {}).label || proc.estado;
    const pts = proc.puntos || {};
    const saldo = Number(proc.saldo || 0);

    const chips = ORDEN_PUNTOS_CHAT.map(k => {
        const v = pts[k] && pts[k].valor;
        const txt = (k === 'fecha')
            ? (v ? fmtFechaCorta(v) : 'Sin fecha')
            : (PUNTO_VALOR_LABEL[v] || '—');
        return `<span class="vl-cp-item${v ? ' ok' : ''}" title="${escapeHtml(PUNTO_LABEL[k])}: ${escapeHtml(txt)}">
                    <b>${escapeHtml(PUNTO_LABEL[k])}</b> ${escapeHtml(txt)}
                </span>`;
    }).join('');

    return `<div class="vl-chat-proceso">
        <span class="vl-cp-titulo">Proceso</span>
        <span class="vl-cp-estado">${escapeHtml(etiqueta)}</span>
        ${chips}
        <span class="vl-cp-saldo ${saldo > 0 ? 'debe' : 'ok'}">${saldo > 0 ? 'Debe ' + formatearDinero(saldo) : 'Pagado'}</span>
    </div>`;
}

// ── Conversación abierta ────────────────────────────────────────────
async function abrirChat(chatId) {
    _chatId = chatId;
    _chatMeta = null;
    const body = $('vld-body');
    if (body) body.innerHTML = '<div class="vl-empty"><i class="fas fa-spinner fa-spin"></i> Cargando…</div>';
    // Asegura el aviso del chat antes de pintar el hilo (banner de qué hacer)
    if (_chats.length === 0) await cargarChats({ silencioso: true });
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

    // Firmar las URLs de las fotos/archivos (bucket privado 'vl-media').
    await firmarMedias(mensajes, getSupabase());

    const av = avisoDelChat(chatId);
    const banner = av
        ? `<div class="vl-aviso-banner">
               <div class="vl-aviso-titulo">⚠️ ${escapeHtml(avisoLabel(av.tipo))}${avisoDetalle(av.tipo, av.detalle) ? ' — ' + escapeHtml(avisoDetalle(av.tipo, av.detalle)) : ''}</div>
               ${avisoAccion(av.tipo) ? `<div class="vl-aviso-accion"><b>Qué hacer:</b> ${escapeHtml(avisoAccion(av.tipo))}</div>` : ''}
           </div>`
        : '';

    // Proceso abierto del chat: hace falta el proceso_id para poder cerrar la
    // entrega DESDE ACÁ (el listado de chats no lo trae). Los botones reusan los
    // modales de siempre, así se hace lo mismo desde el chat o desde el diagrama.
    try {
        const pr = await vlApi.chatProceso(chatId);
        _chatProc = (pr && pr.ok && pr.data) ? (pr.data.proceso || null) : null;
        if (pr && pr.ok && pr.data && pr.data.tiktok_user && !_chatMeta.tiktok_user) {
            _chatMeta.tiktok_user = pr.data.tiktok_user;
        }
    } catch (_) { _chatProc = null; }

    const procChat = _chatProc || procDelChat(chatId);
    // El bloque de PROCESO (chips + botones) queda ANCLADO arriba (sticky dentro
    // del hilo): así se aprieta "Confirmar pago / Prenda entregada / Liberar"
    // sin tener que subir el chat. Lo último hablado se sigue viendo abajo.
    body.innerHTML = `<div class="vld-fijo">`
        + procesoChipsHtml(procChat) + accionesChatHtml(_chatProc)
        + `</div>`
        + banner
        + `<div class="vld-hilo" id="vld-hilo">${burbujasHtml(mensajes, { nombreCliente: nombreDeCliente(_chatMeta) })}</div>`;

    // El scroll REAL del chat es el contenedor .vld-body (el .vld-hilo de adentro
    // no scrollea). Antes se llamaba con #vld-hilo y el panel quedaba mostrando lo
    // PRIMERO conversado; ahora baja a lo ÚLTIMO, como en WhatsApp.
    autoScrollAbajo(body, { forzar: !silencioso });
    // Respaldo: baja otra vez apenas el navegador pinte las burbujas (fuentes/imágenes).
    if (!silencioso) requestAnimationFrame(() => autoScrollAbajo($('vld-body'), { forzar: true }));

    bindAccionesChat(procesoParaModales(_chatProc, _chatMeta.tiktok_user), () => {
        cargarHilo(chatId, { silencioso: true });
        cargarChats({ silencioso: true });
    });

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

    // Ocultar / mostrar ESTE chat (los no-venta no aparecen en la lista)
    const ojoLista = $('vld-ocultos');
    const ocuBtn = $('vld-ocultar');
    if (ojoLista) ojoLista.style.display = 'none';
    if (ocuBtn) {
        const c = _chats.find(x => String(x.id) === String(_chatId));
        const estaOculto = !!(c && c.oculto);
        ocuBtn.style.display = 'inline-flex';
        ocuBtn.className = 'vl-btn';
        ocuBtn.innerHTML = estaOculto
            ? '<i class="fas fa-eye"></i> Mostrar'
            : '<i class="fas fa-eye-slash"></i> Ocultar';
    }
    if (foot) foot.style.display = 'flex';
}

// Oculta / vuelve a mostrar el chat abierto.
async function ocultarChatActual() {
    if (!_chatId) return;
    const c = _chats.find(x => String(x.id) === String(_chatId));
    const nuevo = !(c && c.oculto);
    const btn = $('vld-ocultar');
    if (btn) btn.disabled = true;
    const res = await vlApi.chatOcultar(_chatId, nuevo);
    if (btn) btn.disabled = false;
    if (!res.ok) { mostrarToast(res.error || 'No se pudo actualizar', 'error'); return; }
    if (c) c.oculto = nuevo;
    mostrarToast(nuevo ? 'Chat oculto: no aparece en la lista' : 'Chat visible de nuevo', 'success');
    pintarModoChat();
    cargarChats({ silencioso: true });
}

// Muestra / esconde los chats ocultos (no-venta) en la lista.
function toggleOcultos() {
    _verOcultos = !_verOcultos;
    renderLista();
    mostrarToast(_verOcultos ? 'Mostrando también los chats ocultos' : 'Chats no-venta ocultos', 'success');
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

    // El modo vuelve a 'bot' pero el CEREBRO cede el turno al dueño: mientras el
    // último mensaje saliente sea tuyo y tenga menos de 15 min, el bot no contesta
    // (retoma solo cuando dejas de escribir).
    if (tomoControl) {
        const rb = await vlApi.chatModo(_chatId, 'bot');
        if (rb.ok) { _chatMeta.modo = 'bot'; pintarModoChat(); }
    }

    _enviando = false;
    if (btn) btn.disabled = false;

    if (!res.ok) {
        mostrarToast(res.error || 'No se pudo enviar el mensaje', 'error');
        return;
    }
    input.value = '';
    if (tomoControl) mostrarToast('Enviado · el bot espera tu turno', 'success');
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
