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
    quienContesta, procesoChips, firmarMedias, quienEsHtml, bindQuienEs, montarResponder, montarSaltoCita,
    montarAdjunto, montarReaccion, pintarHilo, olvidarHilo,
    barraEmojisHtml, montarEmojis, resaltarBusqueda, limpiarBusqueda, montarGrabadora
} from './chatComun.js';
import {
    PUNTO_LABEL, PUNTO_VALOR_LABEL,
    accionesChatHtml, bindAccionesChat, procesoParaModales
} from './accionesProceso.js';
// Modal del proyecto para "＋ Prenda" (cierre explícito, nunca pierde datos).
import { abrirModal, cerrarModal } from './vlModales.js';

// Refresco: el dueño reportó que "tarda en verse cuando llegó el mensaje".
// 5 s con el chat abierto, 8 s el contador de la lista; además Realtime avisa
// al instante cuando la conexión funciona (esto queda como respaldo).
const REFRESCO_ABIERTO_MS = 5000;
const REFRESCO_BADGE_MS = 8000;
const NOTIF_KEY = 'vl_notif_avisos';

// Clave pública VAPID para Web Push (es pública por diseño; la privada vive en
// los secrets de la Edge Function wa-push y NUNCA llega al navegador).
const VAPID_PUBLIC_KEY = 'BDPgk-hicFx7kZGvZK2cYvnV8azivt991eLtIJJXG7_MVxYtPMFEtKg7hK-e2IOjNEn2trqnSjgx7iBwCxob_0A';

let _built = false;
let _abierto = false;
let _chatId = null;
let _chatMeta = null;
let _chats = [];
// COLA DE ENVÍO (como WhatsApp: puedes seguir escribiendo mientras sale el
// anterior). Antes había un solo envío a la vez: mientras estaba en vuelo (~2 s)
// el botón quedaba bloqueado y un Enter se IGNORABA en silencio.
let _enviosPendientes = [];
let _drenandoEnvios = false;
let _onBadge = null;
let _timerAbierto = null;
let _timerBadge = null;
// Adjuntar foto/video: archivo elegido (si hay) y a qué chat pertenece.
let _adjunto = null;
let _adjuntoChatId = null;
let _responder = null;        // "responder citando" del chat abierto
let _leidoWamid = '';         // último entrante ya marcado como leído (✓✓ azul)
// Buscador de la conversación (la lupa de WhatsApp).
let _busq = { texto: '', i: 0, n: 0, chat: null };
let _fijoPintado = null;      // bloque de proceso/aviso ya pintado (para no repintar de más)
let _notifActivas = false;   // avisos del navegador (los activa el usuario)
let _avisosVistos = null;    // null = primera carga: no notificar lo ya existente
let _sinLeerPrev = 0;
let _verOcultos = false;     // mostrar también los chats ocultos (no-venta)
let _verArchivados = false;  // mostrar también los chats archivados
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

    // Si el dueño ya había activado los avisos, se re-registra la suscripción push
    // en silencio (por si reinstaló o el navegador la perdió). Sin pedir permiso.
    if (_notifActivas && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        suscribirPush();
    }

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
                <button class="vld-icon" id="vld-ocultos" type="button" title="Ver chats ocultos" style="display:none;">
                    <i class="fas fa-eye"></i>
                </button>
                <button class="vld-icon" id="vld-archivados" type="button" title="Ver chats archivados" style="display:none;">
                    <i class="fas fa-box-archive"></i>
                </button>
                <!-- Estos tres botones ya NO se ven: su acción vive en el menú ⋯.
                     Se dejan en el DOM (ocultos) porque el código de la lista y de
                     "volver" los referencia; así no se rompe nada. -->
                <button class="vld-icon" id="vld-buscar-btn" type="button" title="Buscar en la conversación" style="display:none;">
                    <i class="fas fa-magnifying-glass"></i>
                </button>
                <button class="vl-btn" id="vld-modo" type="button" style="display:none;"></button>
                <button class="vl-btn" id="vld-ocultar" type="button" style="display:none;"></button>
                <button class="vld-icon" id="vld-menu-btn" type="button" title="Opciones de esta conversación" style="display:none;">
                    <i class="fas fa-ellipsis-vertical"></i>
                </button>
                <button class="vld-icon" id="vld-cerrar" type="button" title="Cerrar">
                    <i class="fas fa-xmark"></i>
                </button>
            </div>
            <div class="vld-sub" id="vld-sub">Quién te escribió por WhatsApp</div>
            <div id="vld-quien"></div>
            <div class="vl-chat-menu" id="vld-menu" hidden>
                <button type="button" class="vl-menu-item" id="vld-menu-quien"><i class="fas fa-user-tag"></i> <span>¿Quién es? (asignar usuario)</span></button>
                <button type="button" class="vl-menu-item" id="vld-menu-prenda"><i class="fas fa-plus"></i> <span>Agregar prenda al pedido</span></button>
                <button type="button" class="vl-menu-item" id="vld-menu-buscar"><i class="fas fa-magnifying-glass"></i> <span>Buscar en la conversación</span></button>
                <button type="button" class="vl-menu-item" id="vld-menu-modo"><i class="fas fa-user"></i> <span id="vld-menu-modo-t">Tomar el control</span></button>
                <button type="button" class="vl-menu-item" id="vld-menu-ocultar"><i class="fas fa-eye-slash"></i> <span id="vld-menu-ocultar-t">Ocultar de la lista</span></button>
                <div class="vl-menu-sep"></div>
                <button type="button" class="vl-menu-item" data-pref="fijado"><i class="fas fa-thumbtack"></i> <span id="vld-menu-fijado-t">Fijar</span></button>
                <button type="button" class="vl-menu-item" data-pref="silenciado"><i class="fas fa-bell-slash"></i> <span id="vld-menu-silenciado-t">Silenciar</span></button>
                <button type="button" class="vl-menu-item" data-pref="archivado"><i class="fas fa-box-archive"></i> <span id="vld-menu-archivado-t">Archivar</span></button>
            </div>
            <div class="vld-hoja" id="vld-hoja" hidden>
                <div class="vld-hoja-cabeza">
                    <span id="vld-hoja-titulo">¿Quién es?</span>
                    <button class="vld-icon" id="vld-hoja-x" type="button" title="Cerrar"><i class="fas fa-xmark"></i></button>
                </div>
                <div class="vld-hoja-cuerpo" id="vld-hoja-cuerpo"></div>
            </div>
            <div class="vl-busq-barra" id="vld-busq" hidden>
                <i class="fas fa-magnifying-glass"></i>
                <input id="vld-busq-inp" placeholder="Buscar en la conversación…" autocomplete="off">
                <span class="vl-busq-n" id="vld-busq-n">0 de 0</span>
                <button class="vl-busq-salto" id="vld-busq-prev" type="button" title="Anterior"><i class="fas fa-chevron-up"></i></button>
                <button class="vl-busq-salto" id="vld-busq-next" type="button" title="Siguiente"><i class="fas fa-chevron-down"></i></button>
                <button class="vl-busq-salto" id="vld-busq-x" type="button" title="Cerrar la búsqueda"><i class="fas fa-xmark"></i></button>
            </div>
            <div class="vld-body" id="vld-body"></div>
            <div class="vl-chat-previa" id="vld-previa" hidden></div>
            <div class="vl-cita-previa" id="vld-cita" hidden></div>
            <div class="vld-foot" id="vld-foot" style="display:none;">
                ${barraEmojisHtml()}
                <button class="vl-btn vl-adj-btn" id="vld-emoji" type="button" title="Emojis">
                    <i class="fas fa-face-smile"></i>
                </button>
                <button class="vl-btn vl-adj-btn" id="vld-mic" type="button" title="Grabar nota de voz">
                    <i class="fas fa-microphone"></i>
                </button>
                <button class="vl-btn vl-adj-btn" id="vld-mic-x" type="button" title="Cancelar la grabación" hidden>
                    <i class="fas fa-xmark"></i>
                </button>
                <button class="vl-btn vl-adj-btn" id="vld-adj" type="button" title="Mandar foto, video, archivo o audio">
                    <i class="fas fa-paperclip"></i>
                </button>
                <input type="file" class="vl-adj-input" id="vld-file" multiple
                       accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip,.csv"
                       style="display:none">
                <input class="vl-control" id="vld-input" maxlength="1000"
                       placeholder="Responde por WhatsApp…" autocomplete="off">
                <button class="vl-btn primary" id="vld-enviar" type="button" title="Enviar">
                    <i class="fas fa-paper-plane"></i>
                </button>
            </div>`;
        document.body.appendChild(el);

        $('vld-cerrar').addEventListener('click', cerrarConversaciones);
        $('vld-volver').addEventListener('click', volverALista);
        $('vld-ocultos').addEventListener('click', toggleOcultos);
        $('vld-archivados').addEventListener('click', toggleArchivados);
        $('vld-enviar').addEventListener('click', enviar);

        // ── Menú ⋯ (arriba a la derecha): lo de esta conversación en un solo lugar
        // para que el chat se vea limpio (pedido del dueño 2026-10-14). Antes el
        // header tenía 3 botones más ("Tomar el control", "Ocultar", la lupa) y el
        // bloque "¿Quién es?" ocupaba el tope del hilo.
        $('vld-menu-quien').addEventListener('click', abrirHojaQuien);
        $('vld-menu-prenda').addEventListener('click', () => { $('vld-menu').hidden = true; abrirPrendaModal(null); });
        $('vld-menu-buscar').addEventListener('click', () => { $('vld-menu').hidden = true; abrirBusqueda(true); });
        $('vld-menu-modo').addEventListener('click', () => { $('vld-menu').hidden = true; cambiarModo(); });
        $('vld-menu-ocultar').addEventListener('click', () => { $('vld-menu').hidden = true; ocultarChatActual(); });
        $('vld-hoja-x').addEventListener('click', cerrarHojaQuien);

        // Buscar dentro de la conversación + selector de emojis.
        $('vld-busq-inp').addEventListener('input', (e) => buscarEnChat(e.target.value));
        $('vld-busq-inp').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); irABusqueda(1); }
            if (e.key === 'Escape') { e.preventDefault(); abrirBusqueda(false); }
        });
        $('vld-busq-prev').addEventListener('click', () => irABusqueda(-1));
        $('vld-busq-next').addEventListener('click', () => irABusqueda(1));
        $('vld-busq-x').addEventListener('click', () => abrirBusqueda(false));
        montarEmojis({ contenedor: $('vld-foot'), btn: $('vld-emoji'), input: $('vld-input') });
        // Menú ⋮ del chat: fijar / silenciar / archivar (como WhatsApp).
        $('vld-menu-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            const m = $('vld-menu');
            m.hidden = !m.hidden;
            if (!m.hidden) refrescarMenuChat();
        });
        document.addEventListener('click', (e) => {
            const m = $('vld-menu');
            if (!m || m.hidden) return;
            if (m.contains(e.target) || $('vld-menu-btn').contains(e.target)) return;
            m.hidden = true;
        });
        document.querySelectorAll('#vld-menu .vl-menu-item').forEach((b) => {
            b.addEventListener('click', async () => {
                const campo = b.dataset.pref;
                const c = _chats.find((x) => String(x.id) === String(_chatId));
                const nuevo = !(c && c[campo]);
                const r = await vlApi.chatPreferencia(_chatId, campo, nuevo);
                if (!r || !r.ok) { mostrarToast((r && r.error) || 'No se pudo guardar', 'error'); return; }
                if (c) c[campo] = nuevo;
                $('vld-menu').hidden = true;
                refrescarMenuChat();
                await cargarChats({ silencioso: true });
                const dicho = campo === 'fijado' ? (nuevo ? 'Fijada arriba' : 'Ya no queda fija')
                    : campo === 'silenciado' ? (nuevo ? 'Silenciada: no suena ni avisa' : 'Avisos activados')
                    : (nuevo ? 'Archivada: sale de la lista' : 'Desarchivada');
                mostrarToast(dicho, 'success');
                if (campo === 'archivado' && nuevo) volverALista();
            });
        });

        montarGrabadora({
            btn: $('vld-mic'),
            btnCancelar: $('vld-mic-x'),
            onGrabado: (archivo) => encolarAudioGrabado(archivo),
            onError: (m) => mostrarToast(m, 'warning'),
            onEstado: (grabando, seg) => pintarGrabando(grabando, seg),
        });
        // "Responder citando": el listener va a #vld-body (el hilo de adentro se
        // repinta en cada refresco; ese contenedor sí es estable).
        if (!_responder) {
            _responder = montarResponder({
                contenedor: $('vld-body'),
                previa: $('vld-cita'),
                input: $('vld-input'),
            });
        }
        // Apretar la cita lleva al mensaje citado (y lo marca un instante).
        montarSaltoCita({ contenedor: $('vld-body') });
        // Reaccionar a un mensaje con un emoji (😍👍🔥…), como en WhatsApp.
        montarReaccion({
            contenedor: $('vld-body'),
            onReaccionar: (wamid, emoji) => reaccionarA(wamid, emoji),
        });
        // Mandar FOTO/VIDEO/ARCHIVO/AUDIO con comentario: en celular y tablet el
        // selector ofrece cámara y galería; en computador, el explorador.
        if (!_adjunto) {
            _adjunto = montarAdjunto(document, {
                btn: '#vld-adj',
                input: '#vld-file',
                previa: '#vld-previa',
                alCambiar: (items, error) => {
                    if (error) mostrarToast(error, 'error');
                    const n = Array.isArray(items) ? items.length : 0;
                    const inp = $('vld-input');
                    if (inp) {
                        inp.placeholder = n === 0 ? 'Responde por WhatsApp…'
                            : n === 1 ? 'Escribe un comentario…'
                            : `Comentario (va con la primera)…`;
                    }
                }
            });
        }
        $('vld-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); enviar(); }
        });
        // Al enfocar el cuadro de escribir (móvil/tablet) el teclado sube: se
        // recalcula el alto DESPUÉS de la animación para que no quede tapado.
        $('vld-input').addEventListener('focus', () => setTimeout(ajustarAltoDrawer, 320));

        _built = true;
    }

    iniciarContadorBadge();
    iniciarRealtime();

    // Móvil/tablet: al abrir/cerrar el teclado cambia el alto VISIBLE. Se
    // recalcula el cajón para que el cuadro de escribir quede siempre a la vista.
    if (window.visualViewport) {
        const onVv = () => { if (_abierto) ajustarAltoDrawer(); };
        window.visualViewport.addEventListener('resize', onVv);
        window.visualViewport.addEventListener('scroll', onVv);
    }
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
        el.classList.add('abierto');
        el.setAttribute('aria-hidden', 'false');
        ajustarAltoDrawer();   // alto = viewport VISIBLE (con teclado en móvil/tablet)
    }
    volverALista();
    if (_timerAbierto) clearInterval(_timerAbierto);
    _timerAbierto = setInterval(() => {
        if (!_abierto) return;
        if (_drenandoEnvios) return;
        if (_chatId) cargarHilo(_chatId, { silencioso: true });
        else cargarChats({ silencioso: true });
    }, REFRESCO_ABIERTO_MS);
}

// Alto del cajón = ALTO VISIBLE real del navegador. En móvil/tablet, cuando
// aparece el teclado, `100vh` NO se encoge y el cuadro de escribir quedaba
// TAPADO (no se veía lo escrito ni el botón enviar). Con visualViewport.height,
// que SÍ descuenta el teclado, el cajón se achica y el composer queda a la vista.
// Panel flotante: deja el mismo margen que la CSS (14px web/tablet, 10px móvil)
// y arranca debajo de la barra superior para no tapar "Mis proyectos".
function ajustarAltoDrawer() {
    const el = $('vl-drawer');
    if (!el || !_abierto) return;
    const MARGEN = window.matchMedia('(max-width: 860px)').matches ? 10 : 14;
    const tb = document.querySelector('.vl-topbar');
    const bordeBarra = tb ? Math.round(tb.getBoundingClientRect().bottom) : 0;
    const top = Math.max(MARGEN, bordeBarra + 8);
    const vv = window.visualViewport;
    const vH = vv ? vv.height : window.innerHeight;
    const vTop = vv ? vv.offsetTop : 0;
    const ocupadoArriba = Math.max(0, top - vTop);
    el.style.top = top + 'px';
    el.style.height = Math.max(220, Math.round(vH - ocupadoArriba - MARGEN)) + 'px';
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
                if (_abierto && _chatId && row.chat_id === _chatId && !_drenandoEnvios) {
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

/** Convierte la clave pública VAPID (base64url) al Uint8Array que pide el navegador. */
function urlBase64ToUint8Array(base64) {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
}

/**
 * Registra la suscripción PUSH del dispositivo para recibir avisos con la web
 * CERRADA (Web Push, gratis). Si el navegador no la da, no pasa nada: queda la
 * notificación normal mientras la página esté abierta. Devuelve true si quedó.
 */
async function suscribirPush() {
    try {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
        const reg = await navigator.serviceWorker.ready;
        if (!reg || !reg.pushManager) return false;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
            sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
            });
        }
        const j = sub.toJSON ? sub.toJSON() : null;
        if (!j || !j.endpoint || !j.keys || !j.keys.p256dh || !j.keys.auth) return false;
        const r = await vlApi.guardarPushSub(j.endpoint, j.keys.p256dh, j.keys.auth);
        return !!(r && r.ok);
    } catch (e) {
        return false;
    }
}

/** Quita la suscripción push del dispositivo (al apagar los avisos). */
async function desuscribirPush() {
    try {
        const reg = await navigator.serviceWorker.ready;
        const sub = (reg && reg.pushManager) ? await reg.pushManager.getSubscription() : null;
        if (sub) {
            await vlApi.borrarPushSub(sub.endpoint);
            await sub.unsubscribe();
        }
    } catch (_) { /* da igual */ }
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
    await suscribirPush();   // ademas del permiso: push para avisos con la app cerrada
    return { ok: true };
}

/** Apaga los avisos de escritorio (el permiso del navegador se mantiene). */
export function desactivarNotificaciones() {
    _notifActivas = false;
    try { localStorage.setItem(NOTIF_KEY, '0'); } catch (e) { /* modo privado */ }
    desuscribirPush();   // también deja de llegar el push
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

    // Chat SILENCIADO: no suena, no vibra y no aparece el aviso del navegador.
    // El contador de pendientes SÍ se actualiza (igual que en WhatsApp).
    if (chat.silenciado) {
        tituloPendiente(pendientes);
        return;
    }

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
    return _chats.filter(c => (_verOcultos || !c.oculto) && (_verArchivados || !c.archivado));
}

/** Cuántos chats archivados hay (para el botón "Ver archivados"). */
function cuantosArchivados() {
    return _chats.filter(c => c.archivado && (_verOcultos || !c.oculto)).length;
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
    // Botón "Ver archivados": aparece solo si hay alguno, con cuántos hay.
    const archBtn = $('vld-archivados');
    if (archBtn) {
        const n = cuantosArchivados();
        archBtn.style.display = n > 0 ? 'inline-flex' : 'none';
        archBtn.title = _verArchivados ? 'Ocultar los archivados' : `Ver archivados (${n})`;
        archBtn.innerHTML = _verArchivados
            ? '<i class="fas fa-box-archive"></i> <span style="font-size:0.72rem;">ocultar</span>'
            : `<i class="fas fa-box-archive"></i> <span style="font-size:0.72rem;">${n}</span>`;
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

        // Fijada / silenciada / archivada: se ve de un vistazo en la lista.
        const marcas = [
            c.fijado ? '<span class="vl-conv-marca" title="Fijada: queda arriba">📌</span>' : '',
            c.silenciado ? '<span class="vl-conv-marca" title="Silenciada: no suena ni avisa">🔇</span>' : '',
            c.archivado ? '<span class="vl-conv-marca" title="Archivada">📦</span>' : '',
        ].join('');

        return `
            <button class="vl-conv-item${nuevo ? ' activo' : ''}${c.aviso_tipo ? ' con-aviso' : ''}${c.oculto ? ' oculto' : ''}${c.fijado ? ' fijada' : ''}${tuTurno}" data-chat="${escapeHtml(c.id)}" type="button">
                <div class="vl-conv-top">
                    <span class="vl-conv-nombre">${marcas}${escapeHtml(nombre)}</span>
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
    // Cambió de conversación: la cita elegida era del chat anterior (una cita
    // cruzada mandaría el mensaje equivocado).
    if (_responder && _chatId !== chatId) _responder.limpiar();
    // Otro chat: el "ya marcado como leído" arranca de cero y el bloque fijo se
    // vuelve a pintar (las burbujas del chat anterior no sirven).
    if (_chatId !== chatId) { _leidoWamid = ''; _fijoPintado = null; }
    _chatId = chatId;
    _chatMeta = null;
    const body = $('vld-body');
    if (body) body.innerHTML = '<div class="vl-empty"><i class="fas fa-spinner fa-spin"></i> Cargando…</div>';
    // Asegura el aviso del chat antes de pintar el hilo (banner de qué hacer)
    if (_chats.length === 0) await cargarChats({ silencioso: true });
    await cargarHilo(chatId);
}

/**
 * Reaccionar a un mensaje del chat abierto con un emoji (emoji '' = quitarla).
 * Lo manda wa-enviar (WhatsApp + historial) y se repinta el hilo.
 */
async function reaccionarA(wamid, emoji) {
    if (!_chatId || !wamid) return;
    const r = await vlApi.reaccionar(_chatId, wamid, emoji);
    if (!r.ok) {
        mostrarToast(r.error || 'No se pudo reaccionar', 'error');
        return;
    }
    cargarHilo(_chatId, { silencioso: true });
}

async function cargarHilo(chatId, { silencioso = false } = {}) {
    const body = $('vld-body');
    if (!body) return;

    // Se cambió de conversación: el archivo que quedó elegido era de la otra.
    if (_adjuntoChatId !== chatId) {
        if (_adjunto) _adjunto.limpiar();
        _adjuntoChatId = chatId;
    }

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
    const fijoHtml = `<div class="vld-fijo">`
        + procesoChipsHtml(procChat) + accionesChatHtml(_chatProc)
        + `</div>` + banner;
    // FLUIDEZ (como WhatsApp): si el bloque de proceso/aviso no cambió, NO se
    // rehace el hilo completo — se actualiza de a poco (mensajes nuevos se
    // agregan, ticks/reacciones se corrigen en el lugar, y si nada cambió no se
    // toca el DOM). Antes se repintaba TODO cada 5 s y el chat parpadeaba.
    if ($('vld-hilo') && _fijoPintado === fijoHtml) {
        const modo = pintarHilo($('vld-hilo'), mensajes, { nombreCliente: nombreDeCliente(_chatMeta) });
        aplicarBusqueda();
        if (modo === 'igual' && silencioso) { autoScrollAbajo(body); return; }
    } else {
        body.innerHTML = fijoHtml + `<div class="vld-hilo" id="vld-hilo"></div>`;
        pintarHilo($('vld-hilo'), mensajes, { nombreCliente: nombreDeCliente(_chatMeta) });
        aplicarBusqueda();
        _fijoPintado = fijoHtml;
    }

    // El scroll REAL del chat es el contenedor .vld-body (el .vld-hilo de adentro
    // no scrollea). Antes se llamaba con #vld-hilo y el panel quedaba mostrando lo
    // PRIMERO conversado; ahora baja a lo ÚLTIMO, como en WhatsApp.
    autoScrollAbajo(body, { forzar: !silencioso });
    // Respaldo: baja otra vez apenas el navegador pinte las burbujas (fuentes/imágenes).
    if (!silencioso) requestAnimationFrame(() => autoScrollAbajo($('vld-body'), { forzar: true }));

    // ✓✓ AZUL al cliente: se marca el chat como leído al abrirlo y cada vez que
    // llega algo nuevo mientras lo tienes abierto (igual que WhatsApp). Se pide
    // una sola vez por mensaje y sin bloquear el pintado.
    const ultimoEntrante = [...mensajes].reverse().find(m => m
        && m.direction === 'in' && m.wa_message_id
        && String(m.tipo || '').toLowerCase() !== 'reaccion');
    const wamidEnt = ultimoEntrante ? String(ultimoEntrante.wa_message_id) : '';
    if (wamidEnt && wamidEnt !== _leidoWamid) {
        _leidoWamid = wamidEnt;
        vlApi.marcarLeido(chatId);
    }

    // El hilo se carga con await: si mientras tanto el dueño volvió a la lista (o
    // archivó el chat, que también vuelve a la lista), _chatMeta ya es null. Antes
    // eso reventaba con "Cannot read properties of null (reading 'tiktok_user')";
    // ahora simplemente se corta y no se pinta nada en una vista que ya no está.
    if (!_chatMeta || String(_chatId) !== String(chatId)) return;
    bindAccionesChat(procesoParaModales(_chatProc, _chatMeta.tiktok_user), () => {
        cargarHilo(chatId, { silencioso: true });
        cargarChats({ silencioso: true });
    });

    // "¿Quién es?" ya NO ocupa el tope del hilo: vive en el menú ⋯ y se abre como
    // una hoja que tapa el cajón. Arriba solo queda UN aviso de una sola línea
    // cuando la conversación todavía no está asignada a ningún cliente, así el
    // chat se ve limpio pero la opción no se pierde.
    const recargar = () => {
        cargarHilo(chatId, { silencioso: true });
        cargarChats({ silencioso: true });
    };
    pintarChipQuien();
    if (hojaQuienAbierta()) {
        await pintarQuienEs($('vld-hoja-cuerpo'), chatId, () => { cerrarHojaQuien(); recargar(); });
    }
    // "＋ Prenda" en las fotos del chat: cargar la prenda al pedido sin salir de acá.
    marcarFilasConPrenda();

    pintarModoChat();
    if (!silencioso) cargarChats({ silencioso: true });
}

/**
 * Pinta el bloque "¿Quién es?" (asignar el usuario del chat a mano) y lo deja
 * enganchado: buscar + apretar el correcto.
 */
async function pintarQuienEs(host, chatId, onVinculado) {
    if (!host) return null;
    let data = null;
    try {
        const cr = await vlApi.usuariosParaChat(chatId, null);
        if (cr && cr.ok && cr.data) data = cr.data;
    } catch (_) { /* sin lista: el chat se ve igual */ }
    if (!data) { host.innerHTML = ''; delete host.dataset.quienClave; return null; }

    // El chat se refresca solo cada 5 s: si el bloque YA está pintado para este
    // chat y este estado, NO se repinta (si no, se borraría lo que el dueño
    // alcanzó a escribir en el buscador).
    const clave = String(chatId) + '|' + (data.vinculado ? '1' : '0') + '|'
        + ((data.cliente_actual && data.cliente_actual.cliente_id) || '');
    if (host.dataset.quienClave === clave) return null;

    host.innerHTML = quienEsHtml({
        vinculado: !!data.vinculado,
        clienteActual: data.cliente_actual || null,
        usuarios: data.usuarios || []
    });
    host.dataset.quienClave = clave;

    return bindQuienEs(host, {
        onBuscar: async (texto) => {
            const r = await vlApi.usuariosParaChat(chatId, texto);
            return (r && r.ok && r.data) ? r.data : { usuarios: [] };
        },
        onElegir: async (clienteId, nick) => {
            if (!window.confirm('¿Asignar esta conversación de WhatsApp a ' + nick + '?\n\n'
                + 'Se guarda su número en la ficha, así el bot lo reconoce solo la próxima vez.')) return;
            const r = await vlApi.vincularChatCliente(chatId, clienteId);
            if (!r || !r.ok) { mostrarToast((r && r.error) || 'No se pudo asignar', 'error'); return; }
            const d = r.data || {};
            mostrarToast('Asignado a ' + nick + (d.guardó_whatsapp ? ' · guardé su número' : ''), 'success');
            if (d.otro_chat_abierto) mostrarToast('Ojo: ese usuario ya tenía otra conversación abierta', 'warning');
            if (typeof onVinculado === 'function') onVinculado();
        }
    });
}

function pintarModoChat() {
    const titulo = $('vld-titulo');
    const sub = $('vld-sub');
    const volver = $('vld-volver');
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
    // El modo (tomar el control / devolver al bot), la lupa y "ocultar de la lista"
    // viven ahora en el menú ⋯ (arriba a la derecha). El título, el subtítulo que
    // dice quién responde y el pie quedan igual.
    const menuBtn = $('vld-menu-btn');
    if (menuBtn) menuBtn.style.display = 'inline-flex';
    refrescarMenuChat();

    // El ojo de "chats ocultos" lo maneja la lista, no la conversación.
    const ojoLista = $('vld-ocultos');
    if (ojoLista) ojoLista.style.display = 'none';
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
function toggleArchivados() {
    _verArchivados = !_verArchivados;
    renderLista();
    mostrarToast(_verArchivados ? 'Mostrando también los archivados' : 'Archivados ocultos', 'success');
}

function toggleOcultos() {
    _verOcultos = !_verOcultos;
    renderLista();
    mostrarToast(_verOcultos ? 'Mostrando también los chats ocultos' : 'Chats no-venta ocultos', 'success');
}

/**
 * Las etiquetas del menú ⋮ dicen qué va a pasar (no el estado actual): si ya está
 * fijada, el botón dice "Dejar de fijar". Así nunca hay que adivinar.
 */
function refrescarMenuChat() {
    const c = _chats.find((x) => String(x.id) === String(_chatId)) || {};
    const poner = (id, texto) => { const el = $(id); if (el) el.textContent = texto; };
    poner('vld-menu-fijado-t', c.fijado ? 'Dejar de fijar' : 'Fijar arriba');
    poner('vld-menu-silenciado-t', c.silenciado ? 'Activar avisos' : 'Silenciar');
    poner('vld-menu-archivado-t', c.archivado ? 'Desarchivar' : 'Archivar');
    // Modo y visibilidad: la etiqueta dice QUÉ VA A PASAR si la aprietas (nunca
    // hay que adivinar en qué estado está).
    const humano = !!(_chatMeta && _chatMeta.modo === 'humano');
    poner('vld-menu-modo-t', humano ? 'Devolver el mando al bot' : 'Tomar el control (pausar el bot)');
    poner('vld-menu-ocultar-t', c.oculto ? 'Mostrar en la lista' : 'Ocultar de la lista');
}

// ── "¿Quién es?" dentro del menú ⋯ (hoja) + aviso de una línea ────────────────
// Antes el bloque completo (elegir usuario + buscador) vivía anclado arriba del
// hilo y saturaba la vista. Ahora: la hoja se abre desde el menú ⋯ y arriba solo
// queda una línea cuando la conversación NO está asignada a ningún cliente.
function pintarChipQuien() {
    const host = $('vld-quien');
    if (!host) return;
    const asignado = !!(_chatMeta && _chatMeta.cliente_id);
    if (asignado) {
        if (host.dataset.chip) { host.innerHTML = ''; delete host.dataset.chip; }
        return;
    }
    if (host.dataset.chip === 'sin-asignar') return;   // ya está pintado
    host.dataset.chip = 'sin-asignar';
    host.innerHTML = `<button type="button" class="vl-chip-quien" id="vld-chip-quien">
            <i class="fas fa-user-tag"></i> Sin usuario asignado — aprieta acá
        </button>`;
    const b = $('vld-chip-quien');
    if (b) b.addEventListener('click', abrirHojaQuien);
}

function hojaQuienAbierta() {
    const h = $('vld-hoja');
    return !!h && !h.hidden;
}

async function abrirHojaQuien() {
    const hoja = $('vld-hoja');
    if (!hoja || !_chatId) return;
    const menu = $('vld-menu');
    if (menu) menu.hidden = true;
    hoja.hidden = false;
    // Si todavía no está vinculado, la hoja arranca con el buscador a la vista.
    await pintarQuienEs($('vld-hoja-cuerpo'), _chatId, () => {
        cerrarHojaQuien();
        cargarHilo(_chatId, { silencioso: true });
        cargarChats({ silencioso: true });
    });
}

function cerrarHojaQuien() {
    const h = $('vld-hoja');
    if (h) h.hidden = true;
}

// ── "＋ Prenda": cargar al pedido la prenda que el cliente confirmó ────────────
// Se aprieta SOBRE la foto (no se cargan todas las fotos sugeridas: solo la que
// el cliente eligió). El precio se precarga si la leyenda lo dice ("Este peluche
// en 5mil", "Cinturón a 6mil", "4mil", "a 10") y siempre se puede corregir.
function marcarFilasConPrenda() {
    const cont = $('vld-hilo');
    if (!cont) return;
    cont.querySelectorAll('.vl-fila-msg[data-tipo="imagen"]').forEach((fila) => {
        if (fila.dataset.prendaChip === '1') return;
        const burbuja = fila.querySelector('.vl-burbuja');
        if (!burbuja) return;
        fila.dataset.prendaChip = '1';
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'vl-prenda-chip';
        b.title = 'Cargar esta prenda al pedido del chat';
        b.innerHTML = '<i class="fas fa-plus"></i><span class="vl-prenda-txt">Prenda</span>';
        b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); abrirPrendaModal(fila); });
        // El distintivo va SOBRE LA FOTO (esquina inferior derecha del medio), nunca
        // encima de la leyenda escrita. Si la fila no tiene medio, se cuelga de la
        // burbuja pero por encima de la hora.
        const medio = fila.querySelector('.vl-burbuja-medio');
        if (medio) {
            medio.appendChild(b);
        } else {
            b.style.bottom = '30px';
            burbuja.appendChild(b);
        }
    });
}

/** Precio que se puede leer de una leyenda del chat (convención chilena: "10" = 10 mil). */
function parsePrecioLeyenda(texto) {
    const t = String(texto || '').toLowerCase();
    if (!t.trim()) return null;
    let m = t.match(/\$\s*([\d.]{3,9})/);
    if (m) {
        const v = Number(m[1].replace(/\./g, ''));
        if (v >= 1000 && v <= 9999999) return { valor: v, fuente: m[0].trim() };
    }
    m = t.match(/(\d{1,3})\s*(mil|k)\b/);
    if (m) return { valor: Number(m[1]) * 1000, fuente: m[0].trim() };
    m = t.match(/\b(?:a|en|est[ae]|vale|por|son)\s+(\d{1,3})\b/);
    if (m) return { valor: Number(m[1]) * 1000, fuente: m[0].trim() };
    m = t.match(/\b(\d{4,7})\b/);
    if (m) return { valor: Number(m[1]), fuente: m[0] };
    return null;
}

function abrirPrendaModal(fila) {
    const nick = (_chatMeta && _chatMeta.tiktok_user) || '';
    if (!nick) {
        mostrarToast('Primero asigna el usuario del chat (menú ⋯ → ¿Quién es?)', 'warning');
        return;
    }
    // Si se apretó desde el menú (sin foto), se toma la última foto del hilo.
    let f = fila;
    if (!f) {
        const filas = document.querySelectorAll('#vld-hilo .vl-fila-msg[data-tipo="imagen"]');
        f = filas.length ? filas[filas.length - 1] : null;
    }
    const leyenda = f ? String(f.dataset.body || '') : '';
    const p = parsePrecioLeyenda(leyenda);
    abrirModal({
        titulo: '🛍️ Agregar prenda — @' + escapeHtml(nick),
        sub: 'Se suma al pedido abierto de esta conversación (el bot ya sabrá decirle el total).',
        html: `
            <div class="vl-form-row">
                <label for="vpr-precio">Precio</label>
                <input class="vl-control vl-monto-grande" id="vpr-precio" inputmode="numeric" value="${p ? p.valor : ''}">
                <div style="font-size:0.75rem;color:#adb5bd;margin-top:5px;">
                    ${p ? 'Leído de la leyenda: “' + escapeHtml(p.fuente) + '” (corrígelo si no es así)'
                        : 'No pude leer un precio en la leyenda: escríbelo tú.'}
                </div>
            </div>
            <div class="vl-form-row">
                <label for="vpr-desc">Descripción (opcional)</label>
                <input class="vl-control" id="vpr-desc" maxlength="120" value="${escapeHtml(leyenda.slice(0, 120))}">
            </div>
            <div class="vl-modal-actions">
                <button class="vl-btn" id="vpr-cancelar" type="button">Cancelar</button>
                <button class="vl-btn primary" id="vpr-ok" type="button"><i class="fas fa-plus"></i> Agregar al pedido</button>
            </div>`,
        onMount: (modal, { marcarSucio }) => {
            const inpPrecio = modal.querySelector('#vpr-precio');
            const inpDesc = modal.querySelector('#vpr-desc');
            [inpPrecio, inpDesc].forEach((i) => { if (i) i.addEventListener('input', marcarSucio); });
            modal.querySelector('#vpr-cancelar').addEventListener('click', () => cerrarModal(true));
            modal.querySelector('#vpr-ok').addEventListener('click', async () => {
                const val = Number(String(inpPrecio.value || '').replace(/[^\d]/g, ''));
                if (!val || val <= 0) {
                    mostrarToast('Escribe el precio (solo números)', 'warning');
                    inpPrecio.focus();
                    return;
                }
                const btn = modal.querySelector('#vpr-ok');
                btn.disabled = true;
                const r = await vlApi.agregarItem(nick, val, String(inpDesc.value || '').trim(), false);
                btn.disabled = false;
                if (!r || !r.ok) {
                    mostrarToast((r && r.error) || 'No se pudo agregar la prenda', 'error');
                    return;
                }
                const d = (r && r.data) || {};
                const saldo = (d.saldo_pendiente != null) ? formatearDinero(d.saldo_pendiente) : '';
                cerrarModal(true);
                mostrarToast('Prenda agregada a @' + nick + (saldo ? ' · saldo del pedido: ' + saldo : ''), 'success');
                cargarHilo(_chatId, { silencioso: true });
                cargarChats({ silencioso: true });
            });
        }
    });
}

// ── Nota de voz ─────────────────────────────────────────────────────────────
/** El botón del micrófono muestra el tiempo grabando (o la forma normal). */
function pintarGrabando(grabando, segundos) {
    const btn = $('vld-mic');
    const x = $('vld-mic-x');
    if (!btn) return;
    btn.classList.toggle('grabando', !!grabando);
    btn.innerHTML = grabando
        ? `<i class="fas fa-stop"></i> ${String(Math.floor(segundos / 60)).padStart(2, '0')}:${String(segundos % 60).padStart(2, '0')}`
        : '<i class="fas fa-microphone"></i>';
    btn.title = grabando ? 'Toca para terminar y enviar' : 'Grabar nota de voz';
    if (x) x.hidden = !grabando;
}

/** La nota de voz recién grabada entra por la MISMA cola que todo lo demás. */
function encolarAudioGrabado(archivo) {
    if (!_chatId) return;
    const tmpId = 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    pintarBurbujaPendiente(tmpId, '🎤 Enviando nota de voz…');
    _enviosPendientes.push({
        tmpId, chatId: _chatId, texto: '',
        adjuntos: [{ archivo, tipo: 'audio' }], citaWamid: '',
    });
    drenarEnvios();
}

// ── Buscar dentro de la conversación (la lupa) ──────────────────────────────
function aplicarBusqueda() {
    const hilo = $('vld-hilo');
    const barra = $('vld-busq');
    const inp = $('vld-busq-inp');
    const nEl = $('vld-busq-n');
    if (!hilo || !barra || !inp) return;
    if (_busq.chat && _busq.chat !== _chatId) {
        _busq = { texto: '', i: 0, n: 0, chat: _chatId };
        inp.value = '';
    }
    _busq.chat = _chatId;
    if (barra.hidden || !_busq.texto) return;
    _busq.n = resaltarBusqueda(hilo, _busq.texto, _busq.i);
    if (nEl) {
        nEl.textContent = _busq.n
            ? `${((_busq.i % _busq.n) + _busq.n) % _busq.n + 1} de ${_busq.n}` : 'sin resultados';
    }
}

function buscarEnChat(texto) {
    _busq.texto = String(texto || '');
    _busq.i = 0;
    aplicarBusqueda();
}

function irABusqueda(delta) {
    if (!_busq.n) return;
    _busq.i = ((_busq.i + delta) % _busq.n + _busq.n) % _busq.n;
    aplicarBusqueda();
}

function abrirBusqueda(abrir) {
    const barra = $('vld-busq');
    if (!barra) return;
    barra.hidden = !abrir;
    const inp = $('vld-busq-inp');
    const nEl = $('vld-busq-n');
    if (abrir) {
        if (inp) inp.focus();
        aplicarBusqueda();
        return;
    }
    _busq = { texto: '', i: 0, n: 0, chat: _chatId };
    if (inp) inp.value = '';
    if (nEl) nEl.textContent = '0 de 0';
    limpiarBusqueda($('vld-hilo'));
}

function volverALista() {
    abrirBusqueda(false);
    const lupa = $('vld-buscar-btn');
    if (lupa) lupa.style.display = 'none';
    const menuBtn = $('vld-menu-btn');
    if (menuBtn) menuBtn.style.display = 'none';
    const menu = $('vld-menu');
    if (menu) menu.hidden = true;
    if (_responder) _responder.limpiar();
    _chatId = null;
    _chatMeta = null;
    // La cola de envíos NO se toca: los mensajes ya encolados terminan de salir
    // para SU conversación (cada envío guarda su chatId).
    _adjuntoChatId = null;
    if (_adjunto) _adjunto.limpiar();

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
// ENVIAR: encola y devuelve el control AL INSTANTE (la burbuja ya está). El
// envío real lo hace drenarEnvios(), uno por uno y en orden, sin bloquear el
// campo ni el botón: igual que WhatsApp.
function enviar() {
    if (!_chatId) return;
    const input = $('vld-input');
    const texto = input ? input.value.trim() : '';
    // Se pueden mandar VARIAS fotos/archivos de una vez (como WhatsApp).
    const adjuntos = (_adjunto && _adjunto.tiene()) ? _adjunto.items() : [];
    if (!texto && !adjuntos.length) return;

    // La cita y los adjuntos se toman AHORA (después el panel los limpia).
    const citaWamid = _responder && _responder.cita() ? _responder.cita().wamid : '';
    const tmpId = 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const nAdj = adjuntos.length;
    const etq = (t) => t === 'video' ? '🎬 Enviando video…'
        : t === 'documento' ? '📄 Enviando archivo…'
        : t === 'audio' ? '🎤 Enviando audio…' : '📷 Enviando foto…';
    const etiquetaAdj = nAdj > 1 ? `📷 Enviando ${nAdj} archivos…` : (nAdj ? etq(adjuntos[0].tipo) : '');
    pintarBurbujaPendiente(tmpId, nAdj
        ? (texto ? etiquetaAdj + ' ' + texto : etiquetaAdj)
        : texto);
    if (input) input.value = '';
    if (nAdj && _adjunto) _adjunto.limpiar();
    if (citaWamid && _responder) _responder.limpiar();

    _enviosPendientes.push({ tmpId, chatId: _chatId, texto, adjuntos, citaWamid });
    drenarEnvios();
}

/** Manda los pendientes uno por uno, en orden, sin bloquear la pantalla. */
async function drenarEnvios() {
    if (_drenandoEnvios) return;
    _drenandoEnvios = true;
    try {
        while (_enviosPendientes.length) await mandarUno(_enviosPendientes.shift());
    } finally {
        _drenandoEnvios = false;
    }
}

/** Un envío concreto (texto, o archivos con comentario opcional). */
async function mandarUno(it) {
    const chatId = it.chatId;
    const nAdj = it.adjuntos.length;
    const texto = it.texto;

    let tomoControl = false;
    const pModo = (_chatMeta && _chatMeta.modo === 'bot') ? vlApi.chatModo(chatId, 'humano') : null;

    // Foto/video con comentario, o mensaje de texto. La cita viaja como wamid:
    // al cliente le llega el mensaje citado, como en WhatsApp.
    const res = nAdj
        ? await vlApi.enviarMediaManual(chatId, {
            archivos: it.adjuntos.map((x) => x.archivo),
            tipos: it.adjuntos.map((x) => x.tipo),
            comentario: texto, contexto: it.citaWamid,
            onProgreso: (i, t) => { if (t > 1) actualizarPendiente(it.tmpId, `Enviando ${i}/${t}…` + (texto ? ' ' + texto : '')); }
        })
        : await vlApi.enviarManual(chatId, texto, it.citaWamid);

    // El cambio de modo se lanzó junto con el envío (no antes): a esta altura
    // ya terminó, así que confirmarlo no cuesta espera.
    if (pModo) {
        const rm = await pModo.catch(() => ({ ok: false }));
        if (rm && rm.ok) {
            tomoControl = true;
            if (chatId === _chatId && _chatMeta) { _chatMeta.modo = 'humano'; pintarModoChat(); }
        }
    }

    // El modo vuelve a 'bot' pero el CEREBRO cede el turno al dueño: mientras el
    // último mensaje saliente sea tuyo y tenga menos de 15 min, el bot no contesta
    // (retoma solo cuando dejas de escribir). NO se espera esta llamada.
    if (tomoControl) {
        vlApi.chatModo(chatId, 'bot').then((rb) => {
            if (rb && rb.ok && chatId === _chatId && _chatMeta) { _chatMeta.modo = 'bot'; pintarModoChat(); }
        });
    }

    if (!res.ok) {
        // Sin rojo ni parpadeo: ESA burbuja queda con un ⚠ salmón y el motivo en
        // el tooltip. No se devuelve el texto al campo: con la cola, el campo
        // puede tener ya otro mensaje escrito.
        marcarPendienteFallido(it.tmpId, res.error || 'No se pudo enviar');
        // El texto no se pierde: si no había archivos y el campo quedó libre,
        // vuelve ahí para reintentar de un toque.
        const campo = $('vld-input');
        if (!nAdj && campo && !campo.value) campo.value = texto;
        mostrarToast(res.error || 'No se pudo enviar el mensaje', 'error');
        return;
    }
    if (res.data && res.data.total > 1 && res.data.error) {
        mostrarToast(`Se mandaron ${res.data.enviados} de ${res.data.total}: ${res.data.error}`, 'error');
    } else if (nAdj > 1) {
        mostrarToast(`${res.data ? res.data.enviados : nAdj} archivos enviados`, 'success');
    } else if (tomoControl) {
        mostrarToast('Enviado · el bot espera tu turno', 'success');
    }
    if (chatId === _chatId) cargarHilo(chatId, { silencioso: true });   // sin await: la burbuja ya está
}

// Burbuja del mensaje recién enviado, ANTES de que WhatsApp confirme (optimista).
function pintarBurbujaPendiente(tmpId, texto) {
    const hilo = $('vld-hilo');
    if (!hilo) return;
    hilo.insertAdjacentHTML('beforeend', burbujasHtml([{
        id: tmpId, body: texto, direction: 'out', origen: 'humano',
        tipo: 'texto', creado_en: new Date().toISOString()
    }], { nombreCliente: nombreDeCliente(_chatMeta) }));
    const nueva = hilo.lastElementChild;
    if (nueva) {
        nueva.dataset.pendiente = tmpId;
        nueva.style.opacity = '0.62';
        const hora = nueva.querySelector('.vl-burbuja-hora');
        if (hora) hora.textContent = 'enviando…';
    }
    const body = $('vld-body');
    if (body) body.scrollTop = body.scrollHeight;
}

/** Cambia el texto de la burbuja provisoria (avance del envío múltiple). */
function actualizarPendiente(tmpId, texto) {
    const el = document.querySelector(`#vld-body [data-pendiente="${tmpId}"] .vl-burbuja-txt`);
    if (el) el.textContent = texto;
}

/**
 * Marca una burbuja pendiente como NO enviada. Sin rojo fuerte ni parpadeo: un
 * ⚠ salmón y el motivo completo en el tooltip (para que se entienda qué pasó).
 */
function marcarPendienteFallido(tmpId, motivo) {
    const el = document.querySelector(`#vld-hilo [data-pendiente="${tmpId}"]`);
    if (!el) return;
    el.style.opacity = '1';
    el.classList.add('vl-fallida');
    el.title = 'No se pudo enviar: ' + motivo;
    // Deja de ser "pendiente": así un repintado del hilo no la borra como si
    // fuera un envío todavía en curso.
    delete el.dataset.pendiente;
    const hora = el.querySelector('.vl-burbuja-hora');
    if (hora) hora.innerHTML = '<span class="vl-fallo-marca"><i class="fas fa-exclamation-triangle"></i> no enviado</span>';
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
