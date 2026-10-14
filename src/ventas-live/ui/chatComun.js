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
    // Mensajes que WhatsApp manda y el bot NO procesa (se ven igual en el panel).
    if (t === 'reaccion') return 'Reacción';
    if (t === 'ubicacion') return 'Ubicación';
    if (t === 'contacto') return 'Contacto';
    if (t === 'respuesta') return 'Respuesta';
    if (t === 'pedido') return 'Pedido';
    if (t === 'sistema') return 'Aviso de WhatsApp';
    if (t === 'otro') return 'Mensaje no soportado';
    return t;
}

/** Tipos que NO son archivos: su contenido es texto (se pinta como burbuja). */
const TIPOS_SIN_ARCHIVO = new Set([
    'texto', 'reaccion', 'ubicacion', 'contacto', 'respuesta', 'pedido', 'sistema', 'otro',
]);

/**
 * HTML del archivo que mandó el cliente (foto/audio/video/documento).
 * Las fotos se ven EN el chat: el webhook las guarda en el bucket privado
 * 'vl-media' y acá se pintan con la URL firmada (media_url). Sin firma queda
 * el nombre del tipo, nunca una burbuja vacía.
 */
function mediaHtml(m) {
    const tipo = String(m.tipo || 'texto').toLowerCase();
    if (TIPOS_SIN_ARCHIVO.has(tipo)) return '';
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
    // Cada mensaje puede necesitar DOS firmas: la del archivo propio y la del
    // mensaje que CITA (la miniatura de "respondiendo a…").
    const pendientes = [];
    lista.forEach(m => {
        if (!m) return;
        [m, m.cita].forEach(obj => {
            if (!obj || !obj.media_path || obj.media_url) return;
            const enCache = _cacheMedias.get(obj.media_path);
            if (enCache && enCache.exp > ahora + 60000) obj.media_url = enCache.url;
            else { porFirmar.add(obj.media_path); pendientes.push(obj); }
        });
    });
    const paths = [...porFirmar];
    if (!supabase || !paths.length) return lista;
    try {
        const { data } = await supabase.storage.from('vl-media').createSignedUrls(paths, 3600);
        (data || []).forEach(d => {
            if (!d || !d.path || !d.signedUrl) return;
            _cacheMedias.set(d.path, { url: d.signedUrl, exp: ahora + _MS_FIRMA });
            pendientes.forEach(obj => { if (obj.media_path === d.path) obj.media_url = d.signedUrl; });
        });
    } catch (e) {
        // Sin firma queda el placeholder del tipo de archivo: el chat no se rompe.
        console.warn('[chatComun] No se pudieron firmar los medios:', e && e.message);
    }
    return lista;
}

/**
 * "¿Quién es?" — usuarios posibles para VINCULAR el chat a mano.
 * Se muestra cuando el chat todavía NO está vinculado (el bot no lo reconoció o
 * no entendió lo que escribió). Primero los que el bot sugirió y, sobre todo,
 * los que COMPRARON desde el LIVE y quedaron sin número vinculado.
 * @param {Array} cands [{cliente_id, tiktok_user, nombre_real, motivo, prendas, saldo}]
 */
export function candidatosHtml(cands) {
    const lista = Array.isArray(cands) ? cands : [];
    if (!lista.length) return '';
    return `<div class="vl-cands" id="vl-cands">
        <div class="vl-cands-titulo"><i class="fas fa-user-check"></i> ¿Quién es? Aprieta el correcto y queda vinculado 👇</div>
        <div class="vl-cands-lista">${botonesUsuariosHtml(lista)}</div>
    </div>`;
}

/** Los botones (@ + prendas + saldo + motivo) de una lista de usuarios. */
function botonesUsuariosHtml(lista) {
    return (Array.isArray(lista) ? lista : []).map(u => {
        const saldo = Number(u.saldo || 0);
        const abierto = Number(u.saldo_abierto || 0);
        const nick = u.tiktok_user ? '@' + u.tiktok_user : (u.nombre_real || '(sin @)');
        const dato = [Number(u.prendas || 0) + ' prenda(s)']
            .concat(saldo > 0 ? ['$' + saldo.toLocaleString('es-CL')] : [])
            .concat(abierto > 0 && abierto !== saldo ? ['por cobrar $' + abierto.toLocaleString('es-CL')] : [])
            .join(' · ');
        return `<button class="vl-cand" type="button" data-cliente="${escapeHtml(u.cliente_id)}">`
            + `<span class="vl-cand-nick">${escapeHtml(nick)}</span>`
            + `<span class="vl-cand-dato">${escapeHtml(dato)}</span>`
            + `<span class="vl-cand-motivo">${escapeHtml(u.motivo || '')}</span>`
            + `</button>`;
    }).join('');
}

/**
 * "¿Quién es?" — ASIGNAR el usuario del chat a mano. Va SIEMPRE en el chat (no
 * sólo cuando el bot adivina): al abrirlo muestra la lista de usuarios que
 * compraron (primero los que quedaron SIN vincular) y un buscador para
 * encontrar a cualquiera por @, nombre o número — compre o no.
 * Con el chat ya asignado, sirve para CAMBIARLO si quedó con la persona mal.
 * @param {Object} o {vinculado, clienteActual, usuarios, q}
 */
export function quienEsHtml({ vinculado = false, clienteActual = null, usuarios = [], q = '' } = {}) {
    const la = clienteActual || {};
    const nickActual = la.tiktok_user ? '@' + la.tiktok_user
        : (la.nombre_real || 'este número');
    const titulo = vinculado
        ? `Asignado a ${escapeHtml(nickActual)} — si no es, aprieta el correcto`
        : '¿Quién es? Aprieta el correcto y queda asignado 👇';
    return `<div class="vl-quien${vinculado ? '' : ' abierto'}" id="vl-quien" data-vinculado="${vinculado ? '1' : '0'}">
        <button class="vl-quien-cab" id="vl-quien-cab" type="button" aria-expanded="${vinculado ? 'false' : 'true'}">
            <i class="fas fa-user-check"></i>
            <span class="vl-quien-titulo">${titulo}</span>
            <span class="vl-quien-flecha"><i class="fas fa-chevron-down"></i></span>
        </button>
        <div class="vl-quien-panel" id="vl-quien-panel"${vinculado ? ' hidden' : ''}>
            <div class="vl-quien-busca">
                <i class="fas fa-magnifying-glass"></i>
                <input class="vl-control" id="vl-quien-input" autocomplete="off"
                       placeholder="Escribe el @, el nombre o el número…" value="${escapeHtml(q)}">
            </div>
            <div class="vl-quien-ayuda" id="vl-quien-ayuda">Los que compraron y no están vinculados salen primero. Si no aparece, búscalo por su @.</div>
            <div class="vl-quien-lista" id="vl-quien-lista">${listaUsuariosHtml(usuarios)}</div>
        </div>
    </div>`;
}

/** Lista de botones para el panel "¿Quién es?" (con texto si no hay nadie). */
function listaUsuariosHtml(usuarios) {
    const l = Array.isArray(usuarios) ? usuarios : [];
    if (!l.length) {
        return '<div class="vl-quien-vacio">Nadie con ese texto. Prueba con el @ exacto del live (por ejemplo @su_usuario).</div>';
    }
    return botonesUsuariosHtml(l);
}

/**
 * Engancha el panel "¿Quién es?": abre/cierra, BUSCA (con freno para no
 * disparar una consulta por tecla) y entrega el usuario apretado.
 * @param {HTMLElement} cont contenedor donde se pintó quienEsHtml()
 * @param {Object} cb {onBuscar(texto)->Promise<{usuarios}>, onElegir(clienteId, nick)}
 * @returns {Object} {setLista, setAyuda, abrir, cerrar}
 */
export function bindQuienEs(cont, { onBuscar, onElegir } = {}) {
    const c = cont || (typeof document !== 'undefined' ? document.getElementById('vl-quien') : null);
    const vacio = { setLista() {}, setAyuda() {}, abrir() {}, cerrar() {} };
    if (!c) return vacio;

    const cab = c.querySelector('.vl-quien-cab');
    const panel = c.querySelector('.vl-quien-panel');
    const input = c.querySelector('.vl-quien-busca .vl-control');
    const lista = c.querySelector('.vl-quien-lista');
    const ayuda = c.querySelector('.vl-quien-ayuda');

    const pintar = (usuarios) => { if (lista) lista.innerHTML = listaUsuariosHtml(usuarios); };
    const estaAbierto = () => !!(panel && !panel.hidden);
    const fijar = (abierto) => {
        if (panel) panel.hidden = !abierto;
        c.classList.toggle('abierto', abierto);
        if (cab) cab.setAttribute('aria-expanded', abierto ? 'true' : 'false');
        if (abierto && input) { try { input.focus(); } catch (_) {} }
    };
    const abrir = () => fijar(true);
    const cerrar = () => fijar(false);

    if (cab) cab.addEventListener('click', (e) => { e.preventDefault(); fijar(!estaAbierto()); });

    let freno = null;
    if (input) {
        input.addEventListener('input', () => {
            clearTimeout(freno);
            const texto = input.value.trim();
            const ayudaTx = texto
                ? 'Buscando…'
                : 'Los que compraron y no están vinculados salen primero. Si no aparece, búscalo por su @.';
            const poner = () => { if (ayuda) ayuda.textContent = ayudaTx; };
            poner();
            freno = setTimeout(async () => {
                if (typeof onBuscar !== 'function') return;
                try {
                    const r = await onBuscar(texto);
                    pintar(r && r.usuarios ? r.usuarios : []);
                } catch (_) { pintar([]); }
                if (ayuda) {
                    ayuda.textContent = texto
                        ? 'Si la persona no está, revisa que su ficha tenga ese @.'
                        : 'Los que compraron y no están vinculados salen primero. Si no aparece, búscalo por su @.';
                }
            }, 300);
        });
        input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); } });
    }

    c.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('.vl-cand') : null;
        if (!btn || !c.contains(btn)) return;
        const nick = btn.querySelector('.vl-cand-nick');
        if (typeof onElegir === 'function') onElegir(btn.dataset.cliente, nick ? nick.textContent : 'usuario');
    });

    return { setLista: pintar, setAyuda: (t) => { if (ayuda) ayuda.textContent = t; }, abrir, cerrar };
}

/** Engancha los botones de "¿Quién es?": cb(clienteId, nick). */
export function bindCandidatos(cont, cb) {
    const c = cont || (typeof document !== 'undefined' ? document.getElementById('vl-cands') : null);
    if (!c || typeof cb !== 'function') return;
    c.querySelectorAll('button[data-cliente]').forEach(btn => {
        btn.addEventListener('click', () => {
            const nick = btn.querySelector('.vl-cand-nick');
            cb(btn.dataset.cliente, nick ? nick.textContent : 'cliente');
        });
    });
}

// ── Adjuntar FOTO/VIDEO al chat (computador, celular o tablet) ───────────────
// WhatsApp (Cloud API) solo acepta fotos JPG/PNG (hasta 5 MB) y videos MP4/3GPP
// (hasta 16 MB). Se valida ANTES de subir para no gastar datos al pepe.
export const ADJUNTO_LIMITES = { imagen: 5 * 1024 * 1024, video: 16 * 1024 * 1024 };
export const ADJUNTO_MIMES = {
    imagen: ['image/jpeg', 'image/jpg', 'image/png'],
    video: ['video/mp4', 'video/3gpp']
};

/** 'imagen' | 'video' | '' según el archivo elegido. */
export function tipoDeArchivo(archivo) {
    const mime = String((archivo && archivo.type) || '').toLowerCase();
    if (mime.startsWith('image/')) return 'imagen';
    if (mime.startsWith('video/')) return 'video';
    return '';
}

/** "350 KB" / "2.4 MB" para mostrar en la vista previa. */
export function etiquetaPeso(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
}

/** ¿Se puede mandar? {ok, tipo, error} — el error explica qué hacer. */
export function validarAdjunto(archivo) {
    const tipo = tipoDeArchivo(archivo);
    if (!tipo) {
        return { ok: false, tipo: '', error: 'Solo se pueden mandar fotos o videos.' };
    }
    const mime = String(archivo.type || '').toLowerCase();
    if (!ADJUNTO_MIMES[tipo].includes(mime)) {
        const ext = (String(archivo.name || '').split('.').pop() || '').toUpperCase();
        return {
            ok: false, tipo,
            error: tipo === 'video'
                ? `WhatsApp solo acepta videos MP4${ext && ext !== 'MP4' ? ` (este es ${ext})` : ''}.`
                : `WhatsApp solo acepta fotos JPG o PNG${ext ? ` (esta es ${ext})` : ''}.`
        };
    }
    const limite = ADJUNTO_LIMITES[tipo];
    if (Number(archivo.size) > limite) {
        return {
            ok: false, tipo,
            error: `Pesa ${etiquetaPeso(archivo.size)} y WhatsApp acepta hasta ${Math.round(limite / 1048576)} MB.`
        };
    }
    return { ok: true, tipo, error: '' };
}

/** Vista previa del archivo elegido: miniatura + nombre + peso + quitar. */
export function previaAdjuntoHtml({ nombre = '', tipo = 'imagen', url = '', peso = 0 } = {}) {
    const mini = tipo === 'video'
        ? `<video class="vl-adj-mini" src="${escapeHtml(url)}" muted playsinline preload="metadata"></video>`
        : `<img class="vl-adj-mini" src="${escapeHtml(url)}" alt="">`;
    return `<div class="vl-adj-previa" id="vl-adj-previa">
        ${mini}
        <div class="vl-adj-datos">
            <div class="vl-adj-nombre">${escapeHtml(nombre || (tipo === 'video' ? 'Video' : 'Foto'))}</div>
            <div class="vl-adj-peso">${tipo === 'video' ? '🎬 Video' : '📷 Foto'} · ${escapeHtml(etiquetaPeso(peso))}</div>
        </div>
        <button class="vl-adj-quitar" id="vl-adj-quitar" type="button" title="Quitar el archivo">
            <i class="fas fa-xmark"></i>
        </button>
    </div>`;
}

/**
 * Engancha el adjuntar: el botón abre el selector de archivos (en el celular y
 * la tablet eso da cámara y galería; en el computador, el explorador), valida,
 * muestra la vista previa y deja el archivo listo para mandar.
 * @param {HTMLElement} cont contenedor donde viven el botón/input/previa
 * @param {Object} o {btn, input, previa, alCambiar(archivo|null, error)}
 * @returns {Object} {archivo(), tipo(), tiene(), limpiar()}
 */
export function montarAdjunto(cont, { btn, input, previa, alCambiar } = {}) {
    const raiz = cont || (typeof document !== 'undefined' ? document : null);
    const q = (sel) => {
        if (!sel) return null;
        if (typeof sel !== 'string') return sel;
        return raiz && raiz.querySelector ? raiz.querySelector(sel) : null;
    };
    const b = q(btn);
    const f = q(input);
    const pr = q(previa);
    let archivo = null;
    let tipo = '';
    let urlMini = null;

    const soltarUrl = () => {
        if (urlMini && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
            try { URL.revokeObjectURL(urlMini); } catch (_) { /* nada */ }
        }
        urlMini = null;
    };

    // La miniatura es un lujo: si el navegador no puede crearla, el envío sigue
    // igual (por eso nunca puede cortar el flujo con una excepción).
    const crearUrlMini = (a) => {
        try {
            if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
                return URL.createObjectURL(a) || '';
            }
        } catch (_) { /* sin miniatura */ }
        return '';
    };

    const limpiar = () => {
        soltarUrl();
        archivo = null;
        tipo = '';
        if (pr) { pr.innerHTML = ''; pr.hidden = true; }
        if (f) { try { f.value = ''; } catch (_) { /* nada */ } }
        if (typeof alCambiar === 'function') alCambiar(null, '');
    };

    if (b && f) {
        b.addEventListener('click', (e) => {
            e.preventDefault();
            try { f.click(); } catch (_) { /* nada */ }
        });
    }

    if (f) {
        f.addEventListener('change', () => {
            const nuevo = (f.files && f.files[0]) || null;
            if (!nuevo) return;
            const v = validarAdjunto(nuevo);
            if (!v.ok) {
                limpiar();
                if (typeof alCambiar === 'function') alCambiar(null, v.error);
                return;
            }
            soltarUrl();
            archivo = nuevo;
            tipo = v.tipo;
            urlMini = crearUrlMini(nuevo);
            if (pr) {
                pr.innerHTML = previaAdjuntoHtml({
                    nombre: nuevo.name, tipo, url: urlMini, peso: nuevo.size
                });
                pr.hidden = false;
            }
            if (typeof alCambiar === 'function') alCambiar(nuevo, '');
        });
    }

    if (pr) {
        pr.addEventListener('click', (e) => {
            const x = e.target && e.target.closest ? e.target.closest('.vl-adj-quitar') : null;
            if (!x) return;
            e.preventDefault();
            limpiar();
        });
    }

    return { archivo: () => archivo, tipo: () => tipo, tiene: () => !!archivo, limpiar };
}

/**
 * "Respondiendo a…" — la CITA del mensaje, igual que WhatsApp.
 * El servidor ya resolvió a qué mensaje responde (tipo/body/media_path), así
 * que acá solo se pinta: autor + texto o miniatura de la foto citada.
 */
function citaHtml(m, nombreCliente) {
    const c = m && m.cita;
    if (!c) {
        // Citó algo que no tenemos en el historial (p. ej. anterior a esta
        // función): se dice sin romper la burbuja ni inventar contenido.
        return (m && m.context_wa_id)
            ? '<div class="vl-cita-nota"><i class="fas fa-reply"></i> Responde a un mensaje anterior</div>'
            : '';
    }
    const saliente = c.direction === 'out';
    const autor = saliente
        ? (c.origen === 'humano' ? 'Tú' : 'Bot')
        : escapeHtml(nombreCliente);
    const tipo = String(c.tipo || 'texto').toLowerCase();
    const txt = escapeHtml(String(c.body || '').replace(/\n+/g, ' ').trim()).slice(0, 140);
    const esFoto = !!c.media_url && (tipo === 'imagen' || tipo === 'sticker');
    let cuerpo;
    if (esFoto) {
        cuerpo = `<img class="vl-cita-mini" src="${escapeHtml(c.media_url)}" alt="Imagen citada" loading="lazy">`;
    } else if (tipo === 'texto' || !tipo) {
        cuerpo = `<span class="vl-cita-txt">${txt || 'Mensaje'}</span>`;
    } else {
        cuerpo = `<span class="vl-cita-tipo"><i class="fas fa-paperclip"></i> ${escapeHtml(etiquetaMedia(tipo))}`
            + `${txt ? ' · ' + txt : ''}</span>`;
    }
    const aparte = esFoto && txt ? `<span class="vl-cita-txt">${txt}</span>` : '';
    return `<div class="vl-cita">`
        + `<div class="vl-cita-autor"><i class="fas fa-reply"></i> ${autor}</div>`
        + `<div class="vl-cita-cuerpo">${cuerpo}${aparte}</div>`
        + `</div>`;
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
                    ${citaHtml(m, nombreCliente)}
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
