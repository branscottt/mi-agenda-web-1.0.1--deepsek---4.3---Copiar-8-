// ventas-live/ui/chatComun.js
// Piezas compartidas para pintar conversaciones de WhatsApp: las usa la
// vista Chats y el panel de chat dentro de MODO LIVE. Así el formato de
// las burbujas y las etiquetas de autor son idénticos en ambos lados.

import { escapeHtml } from '../../shared/infrastructure/formatters.js';

export const ESTADO_CHAT = {
    nuevo: 'Nuevo',
    esperando_tiktok: 'Esperando @TikTok',
    esperando_confirmar_usuario: 'Confirmando usuario',
    esperando_tipo_entrega: 'Eligiendo entrega',
    esperando_datos_envio: 'Esperando datos de envío',
    esperando_forma_pago: 'Presencial: cómo paga',
    habitual: 'Cliente habitual',
    listo: 'Listo'
};

// Avisos que el bot dejó para que los revise una persona.
//   label  = nombre corto (chip del chat)
//   accion = QUÉ HAY QUE HACER (se muestra en el banner del chat y en la
//            notificación del navegador; el "qué pasó" es el detalle, que
//            lo escribe el cerebro y es distinto en cada caso)
export const AVISO_INFO = {
    comprobante: {
        label: 'Comprobante',
        accion: 'Revisa la foto, comprueba el pago en tu cuenta y, si está, aprieta "Confirmar pago" acá en el chat.'
    },
    pago: {
        label: 'Dijo que pagó',
        accion: 'Comprueba la transferencia en tu cuenta y respóndele confirmando.'
    },
    sin_cliente: {
        label: 'Revisar chat',
        accion: 'Abre el chat, pregúntale de nuevo su usuario de TikTok y respóndele tú.'
    },
    sin_courier: {
        label: 'Elegir courier',
        accion: 'Elige el courier (blue o paket) y respóndele para cerrar la entrega.'
    },
    no_entendido: {
        label: 'No se entendió',
        accion: 'Lee el chat y respóndele tú lo que necesita.'
    },
    usuario_no_encontrado: {
        label: 'Usuario no encontrado',
        accion: 'Busca al cliente a mano y respóndele tú por acá.'
    },
    usuario_no_confirmado: {
        label: 'Usuario no confirmado',
        accion: 'Pregúntale su usuario correcto y respóndele tú.'
    },
    entrega_presencial: {
        label: 'Entrega presencial',
        accion: 'Coordina la entrega con el cliente (el bloque de Entregas te dice la fecha que él mismo escribió).'
    },
    entrega_paket: {
        label: 'Envío por Paket',
        accion: 'Pide el envío en Paket ANTES de las 23:59 del día anterior (solo Santiago, +$3.500).'
    },
    entrega_blue: {
        label: 'Envío por Blue',
        accion: 'Crea el pedido en Blue Express: el envío lo paga el cliente al recibir.'
    },
    paket_region: {
        label: 'Paket fuera de Santiago',
        accion: 'Paket solo cubre la RM: elige Blue o coordina el envío a mano y respóndele al cliente.'
    },
    sin_pedido: {
        label: 'Sin pedido cargado',
        accion: 'Mira lo que mandó en el chat, revísalo en la web y escríbele tú (el bot no responde eso solo).'
    },
    prenda: {
        label: 'Foto de prenda',
        accion: 'Fíjate que la prenda del pantallazo esté cargada en su pedido y con el monto correcto.'
    },
    foto_dudosa: {
        label: 'Foto para revisar',
        accion: 'No sé si es una prenda o un comprobante: mira el chat y respóndele tú.'
    },
    esperando_comprobante: {
        label: 'Esperando comprobante',
        accion: 'No mandes nada: el cliente te manda el pantallazo del pago o te pide los datos. Si no llega, escríbele tú.'
    },
    soltar_prenda: {
        label: 'Posible soltar prenda',
        accion: 'Debe plata y no escribe hace 3+ días. Decides tú: escríbele, o entra a Procesos → Diagrama para liberar la prenda o bloquear y borrar sus datos.'
    },
    otro_numero: {
        label: 'Escribió desde otro número',
        accion: 'Se identificó con su @ desde un teléfono distinto al guardado: la ficha NO se cambió. Revisa el chat y, si corresponde, actualiza su WhatsApp en la ficha.'
    },
    vinculado_usuario: {
        label: 'Vinculado solo',
        accion: 'El cliente escribió su @ y el chat quedó vinculado automáticamente. Revisa que sea él antes de seguir.'
    },
    usuario_sugerido: {
        label: '¿Es este cliente?',
        accion: 'Lo que escribió se parece a un cliente conocido: abre el chat, confirma quién es y atiéndelo con esa ficha.'
    },
    usuario_corregido: {
        label: 'Usuario corregido',
        accion: 'El cliente escribió su @ real (más completo que el anotado) y actualicé su ficha. Revisa que sea la persona correcta.'
    },
    no_puede_pagar: {
        label: 'No puede pagar ahora',
        accion: 'Dice que no puede pagar por ahora. Decide: darle plazo, liberar la prenda o escribirle tú.'
    },
    cliente_acumula: {
        label: 'Quiere juntar más',
        accion: 'El cliente quiere seguir juntando prendas. Cuando pague, usa Procesos → Decidir entrega → Acumular.'
    },
    fecha_coordinacion: {
        label: 'Fecha por coordinar',
        accion: 'El cliente propuso un día (o una hora) para la entrega. Confírmale tú si te queda bien —o propón otra— y ajusta la fecha en Entregas.'
    }
};

export function avisoLabel(tipo) {
    return (AVISO_INFO[tipo] && AVISO_INFO[tipo].label) || tipo || '';
}

export function avisoAccion(tipo) {
    return (AVISO_INFO[tipo] && AVISO_INFO[tipo].accion) || '';
}

// El texto que manda el bot a veces arranca repitiendo la etiqueta
// ("No se entendió — No se entendió si quiere envío o entrega presencial: …").
// Acá se quita esa repetición para que la alerta se lea una sola vez.
export function avisoDetalle(tipo, detalle) {
    const d = (detalle || '').trim();
    if (!d) return '';
    const lab = (AVISO_INFO[tipo] && AVISO_INFO[tipo].label) || '';
    if (lab && d.toLowerCase().startsWith(lab.toLowerCase())) {
        const resto = d.slice(lab.length).replace(/^[\s—:–-]+/, '');
        return resto.charAt(0).toUpperCase() + resto.slice(1);
    }
    return d;
}

// Avisos que SÍ requieren que conteste una persona: el bot no los resolvió.
export const AVISOS_RESPUESTA = [
    'no_entendido', 'usuario_no_encontrado', 'usuario_no_confirmado', 'sin_cliente',
    'comprobante', 'pago', 'foto_dudosa', 'sin_pedido', 'soltar_prenda', 'usuario_sugerido',
    'no_puede_pagar', 'fecha_coordinacion'
];

// Quién tiene que mover este chat (se ve en la lista, sin abrirlo):
//   humano → nos toca contestar (el bot no pudo)      [se marca con brillo suave]
//   tarea  → hay algo operativo del pedido que hacer
//   espera → el cliente habló último y el bot no respondió (a veces es a propósito)
//   bot    → el bot lo tiene / contestó él / contestaste tú
export function quienContesta(chat) {
    const t = chat && chat.aviso_tipo;
    if (t && AVISOS_RESPUESTA.indexOf(t) >= 0) {
        return {
            tipo: 'humano', label: '✋ Contesta tú',
            detalle: avisoLabel(t) + (avisoAccion(t) ? ' — ' + avisoAccion(t) : '')
        };
    }
    if (chat && chat.modo === 'humano') {
        return {
            tipo: 'humano', label: '✋ Contesta tú',
            detalle: 'Tomaste el control de este chat: el bot está en pausa.'
        };
    }
    if (t) {
        return { tipo: 'tarea', label: '📌 Tarea del pedido', detalle: avisoAccion(t) || avisoLabel(t) };
    }
    if (chat && chat.ultimo_dir === 'in') {
        return {
            tipo: 'espera', label: '⏳ El cliente habló último',
            detalle: 'El cliente escribió y el bot no respondió (puede ser a propósito: mira el chat).'
        };
    }
    if (chat && chat.ultimo_dir === 'out' && chat.ultimo_origen === 'humano') {
        return { tipo: 'bot', label: '👤 Contestaste tú', detalle: 'El último mensaje lo mandaste tú.' };
    }
    if (chat && chat.ultimo_dir === 'out') {
        return { tipo: 'bot', label: '🤖 Contestó el bot', detalle: 'El último mensaje lo mandó el bot.' };
    }
    return { tipo: 'bot', label: '🤖 Bot', detalle: '' };
}

// Puntos del proceso en formato compacto para la LISTA de chats: se ve de un
// golpe qué está definido (verde) y qué falta (gris), sin abrir el chat.
const ORDEN_PUNTOS_CHIP = ['region', 'entrega', 'courier', 'pago', 'fecha'];
const PUNTO_CORTO = {
    region: 'Región', entrega: 'Entrega', courier: 'Courier', pago: 'Pago', fecha: 'Fecha'
};
const PUNTO_VAL = {
    santiago: 'Santiago', region: 'Región', envio: 'Envío', presencial: 'Presencial',
    blue: 'Blue', paket: 'Paket', pagado: 'Pagado', parcial: 'Parcial',
    sin_pagar: 'Sin pagar', sin_pedido: 'Sin pedido'
};

export function procesoChips(proc, escape) {
    const esc = escape || (s => s);
    if (!proc) {
        return '<div class="vl-conv-proc"><span class="p">Sin pedido abierto</span></div>';
    }
    const pts = proc.puntos || {};
    const saldo = Number(proc.saldo || 0);
    const items = ORDEN_PUNTOS_CHIP.map(k => {
        const v = pts[k] && pts[k].valor;
        let txt = v ? (PUNTO_VAL[v] || v) : '—';
        if (k === 'fecha' && v) {
            const p = String(v).slice(0, 10).split('-');
            txt = p.length === 3 ? (p[2] + '/' + p[1]) : v;
        }
        const cls = v ? 'p ok' : 'p';
        return `<span class="${cls}"><b>${PUNTO_CORTO[k]}</b> ${esc(txt)}</span>`;
    }).join('');
    const deuda = saldo > 0
        ? `<span class="p debe"><b>Debe</b> ${esc('$' + Number(saldo).toLocaleString('es-CL'))}</span>`
        : '<span class="p ok"><b>Pagado</b></span>';
    return `<div class="vl-conv-proc">${items}${deuda}</div>`;
}

/** Hora del mensaje: solo hora si es de hoy, si no fecha + hora. */
export function fmtHora(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const mismoDia = d.toDateString() === new Date().toDateString();
    return mismoDia
        ? d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit' }) + ' ' +
          d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Nombre legible de un medio entrante (mientras no hay URL firmada).
 */
export function etiquetaMedia(tipo) {
    const t = String(tipo || '').toLowerCase();
    if (t === 'imagen') return 'Foto';
    if (t === 'audio') return 'Audio';
    if (t === 'video') return 'Video';
    if (t === 'documento') return 'Archivo';
    if (t === 'sticker') return 'Sticker';
    return t;
}

/**
 * HTML del archivo que mandó el cliente (foto/audio/video/documento).
 * Las fotos se ven EN el chat: el webhook las guarda en el bucket privado
 * 'vl-media' y acá se pintan con la URL firmada (media_url). Sin firma queda
 * el nombre del tipo, nunca una burbuja vacía.
 */
function mediaHtml(m) {
    const tipo = String(m.tipo || 'texto').toLowerCase();
    if (tipo === 'texto') return '';
    const url = m.media_url || '';
    const nombre = escapeHtml(etiquetaMedia(tipo));
    if (!url) {
        return `<span class="vl-media-falta"><i class="fas fa-paperclip"></i> ${nombre} (sin vista previa)</span>`;
    }
    const u = escapeHtml(url);
    if (tipo === 'sticker') {
        // Un sticker no es una foto: se muestra chico, como en WhatsApp.
        return `<img class="vl-burbuja-sticker" src="${u}" alt="Sticker que mandó el cliente" loading="lazy">`;
    }
    if (tipo === 'imagen') {
        return `<a class="vl-media-link" href="${u}" target="_blank" rel="noopener">`
            + `<img class="vl-burbuja-img" src="${u}" alt="Foto que mandó el cliente" loading="lazy"></a>`;
    }
    if (tipo === 'video') {
        return `<video class="vl-burbuja-video" src="${u}" controls preload="metadata"></video>`;
    }
    if (tipo === 'audio') {
        return `<audio class="vl-burbuja-audio" src="${u}" controls preload="metadata"></audio>`;
    }
    return `<a class="vl-media-link archivo" href="${u}" target="_blank" rel="noopener">`
        + `<i class="fas fa-paperclip"></i> Abrir ${nombre}</a>`;
}

// Firmas vigentes por ruta (el chat se refresca cada pocos segundos: no tiene
// sentido volver a firmar lo mismo en cada refresco).
const _cacheMedias = new Map();
const _MS_FIRMA = 3600000;   // 1 h (el mismo vencimiento que se pide a Storage)

/**
 * Firma las URLs de los medios del hilo (bucket privado 'vl-media').
 * Se hace ANTES de pintar: createSignedUrl exige la sesión del admin, así que
 * las fotos no pueden ir en una URL pública.
 * @param {Array} mensajes  mensajes del hilo (se les agrega `media_url`)
 * @param {object} supabase cliente de Supabase con la sesión del usuario
 */
export async function firmarMedias(mensajes, supabase) {
    const lista = mensajes || [];
    const ahora = Date.now();
    const porFirmar = new Set();
    lista.forEach(m => {
        if (!m || !m.media_path || m.media_url) return;
        const enCache = _cacheMedias.get(m.media_path);
        if (enCache && enCache.exp > ahora + 60000) m.media_url = enCache.url;
        else porFirmar.add(m.media_path);
    });
    const paths = [...porFirmar];
    if (!supabase || !paths.length) return lista;
    try {
        const { data } = await supabase.storage.from('vl-media').createSignedUrls(paths, 3600);
        (data || []).forEach(d => {
            if (!d || !d.path || !d.signedUrl) return;
            _cacheMedias.set(d.path, { url: d.signedUrl, exp: ahora + _MS_FIRMA });
            lista.forEach(m => { if (m && m.media_path === d.path) m.media_url = d.signedUrl; });
        });
    } catch (e) {
        // Sin firma queda el placeholder del tipo de archivo: el chat no se rompe.
        console.warn('[chatComun] No se pudieron firmar los medios:', e && e.message);
    }
    return lista;
}

/**
 * HTML del hilo completo. Cada mensaje lleva arriba el autor:
 * el nombre del cliente (entrante), "Bot" o "Tú" (saliente).
 */
export function burbujasHtml(mensajes, { nombreCliente = 'Cliente' } = {}) {
    if (!mensajes || mensajes.length === 0) {
        return '<div class="vl-empty">Sin mensajes todavía.</div>';
    }
    return mensajes.map(m => {
        const saliente = m.direction === 'out';
        const cuerpo = escapeHtml(m.body || '').replace(/\n/g, '<br>');
        const media = mediaHtml(m);
        // Un AUDIO que se pudo transcribir trae su texto en body: se rotula para
        // que se entienda que ese texto lo dijo él en el audio.
        const esAudioConTexto = String(m.tipo || '').toLowerCase() === 'audio'
            && !!(m.body || '').trim();
        const rotuloTranscripcion = esAudioConTexto
            ? '<div class="vl-transcripcion-label"><i class="fas fa-quote-left"></i> Transcripción</div>'
            : '';
        const autor = saliente
            ? (m.origen === 'humano' ? 'Tú' : 'Bot')
            : escapeHtml(nombreCliente);
        return `
            <div class="vl-fila-msg ${saliente ? 'out' : 'in'}">
                <div class="vl-msg-autor">${autor}</div>
                <div class="vl-burbuja ${saliente ? 'out' : 'in'}">
                    ${media ? `<div class="vl-burbuja-medio">${media}</div>` : ''}
                    ${rotuloTranscripcion}
                    ${cuerpo ? `<div class="vl-burbuja-txt">${cuerpo}</div>` : ''}
                    <div class="vl-burbuja-hora">${escapeHtml(fmtHora(m.creado_en))}</div>
                </div>
            </div>`;
    }).join('');
}

/** Nombre con el que se etiqueta al cliente en el hilo. */
export function nombreDeCliente(chat) {
    if (!chat) return 'Cliente';
    return chat.nombre_real || (chat.tiktok_user ? '@' + chat.tiktok_user : 'Cliente');
}

/**
 * Baja el scroll al final del contenedor, salvo que el usuario esté
 * leyendo hacia arriba (no le movemos la vista).
 */
export function autoScrollAbajo(el, { forzar = false } = {}) {
    if (!el) return;
    const cercaDelFinal = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (forzar || cercaDelFinal) el.scrollTop = el.scrollHeight;
}
