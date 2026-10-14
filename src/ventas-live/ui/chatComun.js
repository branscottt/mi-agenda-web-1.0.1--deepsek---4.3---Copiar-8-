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
        // Ya reconocido (tiene número o ya está en otra conversación): se puede
        // elegir —el dueño manda— pero NO en silencio: se avisa con una etiqueta
        // ámbar (aviso informativo, nunca rojo ni parpadeo) para no pisar una
        // asignación buena por error.
        const ya = u.ya_reconocido === true;
        const motivo = ya
            ? ((u.motivo || '') + ' · ya tiene número o está en otra conversación').trim()
            : (u.motivo || '');
        const aviso = ya
            ? '<span class="vl-cand-aviso" title="Esta persona ya está reconocida: tiene número guardado o una conversación vinculada. Si la asignas acá, quedará en las dos.">'
                + '<i class="fas fa-circle-check"></i> ya reconocido</span>'
            : '';
        return `<button class="vl-cand${ya ? ' ya' : ''}" type="button" data-cliente="${escapeHtml(u.cliente_id)}">`
            + `<span class="vl-cand-nick">${escapeHtml(nick)}</span>`
            + `<span class="vl-cand-dato">${escapeHtml(dato)}</span>`
            + `<span class="vl-cand-motivo">${escapeHtml(motivo)}</span>`
            + aviso
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
            <div class="vl-quien-ayuda" id="vl-quien-ayuda">Solo salen ventas ACTIVAS sin usuario reconocido. Si no aparece, búscalo por su @.</div>
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
                : 'Solo salen ventas ACTIVAS sin usuario reconocido. Si no aparece, búscalo por su @.';
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
                        ? 'Deliberado: acá sale cualquiera. Si ya está reconocido, te lo aviso antes.'
                        : 'Solo salen ventas ACTIVAS sin usuario reconocido. Si no aparece, búscalo por su @.';
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

// ── Adjuntar FOTO/VIDEO/ARCHIVO/AUDIO al chat (computador, celular o tablet) ──
// WhatsApp (Cloud API) acepta fotos JPG/PNG (5 MB), videos MP4/3GPP (16 MB),
// documentos PDF/Word/Excel/PPT/TXT/ZIP (100 MB) y audios MP3/M4A/AAC/AMR/OGG
// (16 MB). Se valida ANTES de subir para no gastar datos al pepe.
export const ADJUNTO_LIMITES = {
    imagen: 5 * 1024 * 1024,
    video: 16 * 1024 * 1024,
    documento: 100 * 1024 * 1024,
    audio: 16 * 1024 * 1024
};
export const ADJUNTO_MIMES = {
    imagen: ['image/jpeg', 'image/jpg', 'image/png'],
    video: ['video/mp4', 'video/3gpp'],
    documento: [
        'application/pdf', 'text/plain', 'application/zip', 'text/csv',
        'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    ],
    audio: ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg', 'audio/x-m4a', 'audio/wav']
};

// Extensiones aceptadas por si el navegador NO dice el tipo (pasa en el celular).
const ADJUNTO_EXT = {
    imagen: ['jpg', 'jpeg', 'png'],
    video: ['mp4', '3gp', '3gpp'],
    documento: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'zip', 'csv'],
    audio: ['mp3', 'm4a', 'aac', 'amr', 'ogg', 'opus', 'wav']
};

/** Extensión en minúsculas del archivo elegido ('' si no tiene). */
function extensionDe(archivo) {
    const partes = String((archivo && archivo.name) || '').toLowerCase().split('.');
    return partes.length > 1 ? partes.pop() : '';
}

/** 'imagen' | 'video' | 'documento' | 'audio' | '' según el archivo elegido. */
export function tipoDeArchivo(archivo) {
    const mime = String((archivo && archivo.type) || '').toLowerCase();
    const ext = extensionDe(archivo);
    const porMime = mime.startsWith('image/') ? 'imagen'
        : mime.startsWith('video/') ? 'video'
        : mime.startsWith('audio/') ? 'audio'
        : mime === 'application/pdf' || mime === 'application/zip' || mime === 'text/plain'
            || mime === 'text/csv' || mime.startsWith('application/vnd') ? 'documento'
        : '';
    if (porMime) return porMime;
    // Sin tipo declarado: se decide por la extensión (celulares viejos).
    for (const t of ['imagen', 'video', 'documento', 'audio']) {
        if (ADJUNTO_EXT[t].includes(ext)) return t;
    }
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
        return {
            ok: false, tipo: '',
            error: 'Solo se pueden mandar fotos, videos, archivos (PDF, Word, Excel…) o audios.'
        };
    }
    const mime = String(archivo.type || '').toLowerCase();
    const ext = extensionDe(archivo);
    // Vale el tipo declarado O la extensión: hay celulares que suben el archivo
    // sin tipo ("application/octet-stream") y no hay por qué rechazarlo.
    const mimeOk = mime ? ADJUNTO_MIMES[tipo].includes(mime) : false;
    const extOk = ADJUNTO_EXT[tipo].includes(ext);
    if (!mimeOk && !extOk) {
        const muestra = (ext ? ext.toUpperCase() : (mime.split('/').pop() || '').toUpperCase()) || 'desconocido';
        const error = tipo === 'imagen' ? `WhatsApp solo acepta fotos JPG o PNG (esta es ${muestra}).`
            : tipo === 'video' ? `WhatsApp solo acepta videos MP4 (este es ${muestra}).`
            : tipo === 'audio' ? `WhatsApp solo acepta audios MP3, M4A, AAC, AMR u OGG (este es ${muestra}).`
            : `WhatsApp no acepta archivos ${muestra} (sí PDF, Word, Excel, PPT, TXT o ZIP).`;
        return { ok: false, tipo, error };
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
        : tipo === 'imagen'
            ? `<img class="vl-adj-mini" src="${escapeHtml(url)}" alt="">`
            // Un archivo o un audio no tienen miniatura: va el icono, igual que
            // el clip de WhatsApp.
            : `<div class="vl-adj-icon" aria-hidden="true"><i class="fas ${
                tipo === 'audio' ? 'fa-microphone' : 'fa-file-lines'}"></i></div>`;
    const rotulo = tipo === 'video' ? '🎬 Video'
        : tipo === 'audio' ? '🎤 Audio'
        : tipo === 'documento' ? '📄 Archivo'
        : '📷 Foto';
    const porDefecto = tipo === 'video' ? 'Video'
        : tipo === 'audio' ? 'Audio'
        : tipo === 'documento' ? 'Archivo'
        : 'Foto';
    return `<div class="vl-adj-previa" id="vl-adj-previa">
        ${mini}
        <div class="vl-adj-datos">
            <div class="vl-adj-nombre">${escapeHtml(nombre || porDefecto)}</div>
            <div class="vl-adj-peso">${rotulo} · ${escapeHtml(etiquetaPeso(peso))}</div>
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
        // Citó algo que NO tenemos (típico: un mensaje enviado antes de que el
        // sistema guardara los wamid). Se avisa y se deja elegirlo A MANO entre
        // los mensajes de la propia conversación.
        if (!m || !m.context_wa_id) return '';
        // El cliente respondió A ALGO, pero el mensaje citado no está en el historial
        // (es anterior a que guardáramos los wamid). Se avisa y nada más: cuál era
        // solo lo sabe el cliente, así que conviene preguntarle.
        return '<div class="vl-cita-nota" title="El cliente respondió a un mensaje, pero no tenemos'
            + ' su ficha (es anterior al sistema). Pregúntale cuál era.">'
            + '<i class="fas fa-reply"></i> Responde a un mensaje anterior</div>';
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

    // Apretable, igual que WhatsApp: lleva AL mensaje citado dentro del chat.
    const destino = c.id ? ` data-cita-id="${escapeHtml(c.id)}"` : '';
    return `<div class="vl-cita"${destino} role="button" tabindex="0"`
        + ` title="Ir al mensaje citado">`
        + `<div class="vl-cita-autor"><i class="fas fa-reply"></i> ${autor}`
        + `<span class="vl-cita-ir" aria-hidden="true"><i class="fas fa-arrow-up"></i></span></div>`
        + `<div class="vl-cita-cuerpo">${cuerpo}${aparte}</div>`
        + `</div>`;
}

/** Ticks de entrega de un mensaje NUESTRO (✓ enviado, ✓✓ entregado, ✓✓ azul leído). */
function ticksHtml(m) {
    if (String(m.direction || '') !== 'out') return '';
    const e = String(m.estado_wa || '').toLowerCase();
    if (!e) return '';   // sin acuse de WhatsApp todavía: no se inventa nada
    if (e === 'enviado') {
        return '<span class="vl-tick" title="Enviado a WhatsApp"><i class="fas fa-check"></i></span>';
    }
    if (e === 'entregado') {
        return '<span class="vl-tick" title="Entregado al teléfono del cliente"><i class="fas fa-check-double"></i></span>';
    }
    if (e === 'leido') {
        return '<span class="vl-tick leido" title="Leído por el cliente"><i class="fas fa-check-double"></i></span>';
    }
    if (e === 'fallido') {
        const det = m.error_wa ? ': ' + escapeHtml(String(m.error_wa)).slice(0, 160) : '';
        return `<span class="vl-tick fallido" title="No se pudo entregar${det}"><i class="fas fa-exclamation-triangle"></i></span>`;
    }
    return '';
}

/** Botón "responder citando" de una burbuja (solo si Meta ya nos dio su wamid). */
function responderBtnHtml(m) {
    if (!m.wa_message_id) return '';
    return '<button class="vl-msg-responder" type="button" title="Responder citando este mensaje"'
        + ' aria-label="Responder citando este mensaje"><i class="fas fa-reply"></i></button>';
}

/** Emojis que se ofrecen para reaccionar (los mismos de WhatsApp). */
export const EMOJIS_REACCION = ['❤️', '👍', '😂', '😮', '😢', '🔥', '🙏'];

/** Botón "reaccionar" de una burbuja (solo si el mensaje tiene wamid). */
function reaccionBtnHtml(m) {
    if (!m.wa_message_id) return '';
    return '<button class="vl-msg-reaccionar" type="button" title="Reaccionar a este mensaje"'
        + ' aria-label="Reaccionar a este mensaje"><i class="far fa-face-smile"></i></button>';
}

/**
 * Las reacciones puestas sobre un mensaje, pegadas a la burbuja como en WhatsApp:
 * la del cliente abajo a la izquierda y la nuestra abajo a la derecha.
 * @param {Object} r {in?: emoji, out?: emoji}
 */
function reaccionesHtml(r) {
    if (!r) return '';
    const suya = String(r.in || '').trim();
    const mia = String(r.out || '').trim();
    if (!suya && !mia) return '';
    const chip = (emoji, clase, quien) =>
        `<span class="vl-reaccion ${clase}" title="${quien}">${escapeHtml(emoji)}</span>`;
    return (suya ? chip(suya, 'in', 'Reacción del cliente') : '')
        + (mia ? chip(mia, 'out', 'Tu reacción') : '');
}

/** "Reenviado" / "Reenviado muchas veces" — Meta lo dice (context.forwarded). */
function reenvioHtml(m) {
    const g = Number(m.reenviado || 0);
    if (g < 1) return '';
    const txt = g >= 2 ? 'Reenviado muchas veces' : 'Reenviado';
    return `<div class="vl-reenvio"><i class="fas fa-share"></i> ${txt}</div>`;
}

/**
 * HTML del hilo completo. Cada mensaje lleva arriba el autor:
 * el nombre del cliente (entrante), "Bot" o "Tú" (saliente).
 * Las REACCIONES no son burbujas: se pintan como emoji ENCIMA del mensaje al que
 * reaccionaron (igual que WhatsApp), para eso se arma un mapa por wamid.
 */
export function burbujasHtml(mensajes, { nombreCliente = 'Cliente' } = {}) {
    const lista = (mensajes || []).filter(Boolean);
    if (lista.length === 0) {
        return '<div class="vl-empty">Sin mensajes todavía.</div>';
    }
    // wamid → {in: emoji del cliente, out: emoji nuestro}
    const reacciones = {};
    lista.forEach(m => {
        if (String(m.tipo || '').toLowerCase() !== 'reaccion') return;
        const destino = m.context_wa_id;
        if (!destino) return;
        const emoji = String(m.body || '').trim();
        if (!emoji) return;
        const lado = m.direction === 'out' ? 'out' : 'in';
        reacciones[destino] = reacciones[destino] || {};
        reacciones[destino][lado] = emoji;
    });

    return lista
        // Una reacción no es un mensaje: no lleva burbuja propia.
        .filter(m => String(m.tipo || '').toLowerCase() !== 'reaccion')
        .map(m => {
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
            // Lo que necesita el "responder citando" para armar la vista previa.
            const attr = (v) => escapeHtml(String(v == null ? '' : v));
            return `
            <div class="vl-fila-msg ${saliente ? 'out' : 'in'}"
                 data-id="${attr(m.id)}"
                 data-wamid="${attr(m.wa_message_id)}"
                 data-dir="${saliente ? 'out' : 'in'}"
                 data-autor="${attr(autor)}"
                 data-tipo="${attr(m.tipo || 'texto')}"
                 data-body="${attr(String(m.body || '').slice(0, 160))}"
                 data-media="${attr(m.media_url || '')}">
                <div class="vl-msg-autor">${autor}</div>
                <div class="vl-burbuja ${saliente ? 'out' : 'in'}">
                    ${citaHtml(m, nombreCliente)}
                    ${reenvioHtml(m)}
                    ${media ? `<div class="vl-burbuja-medio">${media}</div>` : ''}
                    ${rotuloTranscripcion}
                    ${cuerpo ? `<div class="vl-burbuja-txt">${cuerpo}</div>` : ''}
                    <div class="vl-burbuja-hora">${responderBtnHtml(m)}${reaccionBtnHtml(m)}${escapeHtml(fmtHora(m.creado_en))}${ticksHtml(m)}</div>
                    ${reaccionesHtml(reacciones[m.wa_message_id])}
                </div>
            </div>`;
        }).join('');
}

/**
 * "Responder citando" (como en WhatsApp): deja apretable el botón de cada
 * burbuja del hilo y mantiene la cita elegida hasta que se manda el mensaje.
 * `contenedor` debe ser un elemento ESTABLE (el hilo se repinta en cada refresco,
 * así que el listener va al padre que no se reemplaza).
 * Devuelve { cita, limpiar } — `cita()` da el wamid a citar (o null).
 */
export function montarResponder({ contenedor, previa, input, onCambio } = {}) {
    let elegida = null;

    function pintar() {
        if (!previa) return;
        if (!elegida) {
            previa.hidden = true;
            previa.innerHTML = '';
            return;
        }
        const c = elegida;
        const txt = escapeHtml(String(c.body || '').replace(/\n+/g, ' ').trim()).slice(0, 120);
        const esFoto = !!c.media_url && (c.tipo === 'imagen' || c.tipo === 'sticker');
        const cuerpo = esFoto
            ? `<img class="vl-cita-mini" src="${escapeHtml(c.media_url)}" alt="Imagen citada">`
                + (txt ? `<span class="vl-cita-txt">${txt}</span>` : '')
            : `<span class="vl-cita-txt">${txt || escapeHtml(etiquetaMedia(c.tipo) || 'Mensaje')}</span>`;
        previa.innerHTML = `<div class="vl-cita-previa-top">`
            + `<span><i class="fas fa-reply"></i> Respondiendo a ${escapeHtml(c.autor)}</span>`
            + `<button type="button" class="vl-cita-previa-x" title="Quitar la cita"`
            + ` aria-label="Quitar la cita"><i class="fas fa-times"></i></button></div>`
            + `<div class="vl-cita-cuerpo">${cuerpo}</div>`;
        previa.hidden = false;
    }

    function limpiar() {
        elegida = null;
        pintar();
        if (typeof onCambio === 'function') onCambio(null);
    }

    if (contenedor && !contenedor.__responderMontado) {
        contenedor.__responderMontado = true;
        contenedor.addEventListener('click', (e) => {
            const btn = e.target && e.target.closest ? e.target.closest('.vl-msg-responder') : null;
            if (!btn) return;
            e.preventDefault();
            e.stopPropagation();
            const fila = btn.closest('.vl-fila-msg');
            const wamid = fila && fila.dataset ? (fila.dataset.wamid || '') : '';
            if (!wamid) return;
            elegida = {
                wamid,
                autor: fila.dataset.autor || 'Cliente',
                tipo: fila.dataset.tipo || 'texto',
                body: fila.dataset.body || '',
                media_url: fila.dataset.media || '',
            };
            pintar();
            if (input && typeof input.focus === 'function') input.focus();
            if (typeof onCambio === 'function') onCambio(elegida);
        });
    }

    if (previa) {
        previa.addEventListener('click', (e) => {
            const x = e.target && e.target.closest ? e.target.closest('.vl-cita-previa-x') : null;
            if (!x) return;
            e.preventDefault();
            limpiar();
        });
    }

    return { cita: () => elegida, limpiar, pintar };
}

let _pickerReaccion = null;

/**
 * "Reaccionar" (como en WhatsApp): la carita de una burbuja abre los emojis y
 * elegir uno manda la reacción a ESE mensaje. Elegir el mismo que ya estaba
 * puesto la QUITA (igual que WhatsApp).
 * El listener va al contenedor del hilo, que NO se reemplaza en cada refresco.
 * El panel va pegado a <body> con posición fija: así no lo recorta el scroll del
 * hilo ni se sale de la pantalla en el celular.
 * @param {Object} o {contenedor, onReaccionar(wamid, emoji, emojiPuesto)}
 * @returns {Object|null} {cerrar}
 */
export function montarReaccion({ contenedor, onReaccionar } = {}) {
    if (!contenedor || contenedor.__reaccionMontado) return null;
    contenedor.__reaccionMontado = true;

    const cerrar = () => {
        if (_pickerReaccion) {
            try { _pickerReaccion.remove(); } catch (_) { /* ya no está */ }
            _pickerReaccion = null;
        }
    };

    /** Emoji que YA tenemos puesto en ese mensaje (chip de la derecha). */
    const mioPuesto = (burbuja) => {
        const chip = burbuja ? burbuja.querySelector('.vl-reaccion.out') : null;
        return chip ? String(chip.textContent || '').trim() : '';
    };

    const ANCHO_PANEL = 7 * 34 + 14;

    const abrir = (fila) => {
        const burbuja = fila ? fila.querySelector('.vl-burbuja') : null;
        if (!burbuja) return;
        cerrar();
        const mio = mioPuesto(burbuja);
        const esSaliente = String(fila.dataset.dir || '') === 'out';
        const panel = document.createElement('div');
        panel.className = 'vl-reaccion-picker';
        panel.setAttribute('role', 'menu');
        panel.innerHTML = EMOJIS_REACCION.map(e =>
            `<button type="button" class="vl-reaccion-op${e === mio ? ' puesta' : ''}" data-emoji="${escapeHtml(e)}"`
            + ` title="${e === mio ? 'Quitar tu reacción' : 'Reaccionar con ' + escapeHtml(e)}">${escapeHtml(e)}</button>`
        ).join('');
        document.body.appendChild(panel);

        // Pegado a la burbuja: arriba suyo; si no cabe (mensaje al tope del
        // chat), va abajo. Siempre dentro de la pantalla.
        const r = burbuja.getBoundingClientRect();
        const alto = panel.offsetHeight || 40;
        const ancho = panel.offsetWidth || ANCHO_PANEL;
        let left = esSaliente ? r.right - ancho : r.left;
        left = Math.max(8, Math.min(left, (window.innerWidth || 0) - ancho - 8));
        let top = r.top - alto - 8;
        if (top < 8) top = r.bottom + 8;
        panel.style.left = Math.round(left) + 'px';
        panel.style.top = Math.round(top) + 'px';
        _pickerReaccion = panel;
    };

    document.addEventListener('click', (e) => {
        const t = e.target;
        if (!t || !t.closest) { cerrar(); return; }

        // Elegir un emoji (el panel vive fuera del hilo: se atiende PRIMERO).
        const op = t.closest('.vl-reaccion-op');
        if (op && _pickerReaccion && _pickerReaccion.contains(op)) {
            e.preventDefault();
            e.stopPropagation();
            const emoji = String(op.dataset.emoji || '');
            const mio = String(_pickerReaccion.__mio || '');
            const wamid = String(_pickerReaccion.__wamid || '');
            cerrar();
            if (typeof onReaccionar === 'function' && wamid) {
                // El mismo emoji = quitarla (WhatsApp).
                onReaccionar(wamid, emoji === mio ? '' : emoji, mio);
            }
            return;
        }

        if (!contenedor.contains(t)) { cerrar(); return; }

        // Abrir/cerrar el panel desde la carita de la burbuja.
        const btn = t.closest('.vl-msg-reaccionar');
        if (btn) {
            e.preventDefault();
            e.stopPropagation();
            const fila = btn.closest('.vl-fila-msg');
            if (!fila || !fila.dataset.wamid) return;
            const panelAbierto = _pickerReaccion;
            if (panelAbierto && panelAbierto.__fila === fila) { cerrar(); return; }
            abrir(fila);
            if (_pickerReaccion) {
                _pickerReaccion.__fila = fila;
                _pickerReaccion.__wamid = fila.dataset.wamid || '';
                _pickerReaccion.__mio = mioPuesto(fila.querySelector('.vl-burbuja'));
            }
            return;
        }

        cerrar();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && _pickerReaccion) { e.stopPropagation(); cerrar(); }
    });

    // Si el chat se mueve (scroll del hilo, teclado del celular, rotar la
    // pantalla), el panel pegado a la burbuja quedaría descolocado: se cierra.
    contenedor.addEventListener('scroll', cerrar, { passive: true });
    if (typeof window !== 'undefined') window.addEventListener('resize', cerrar);

    return { cerrar };
}

let _timerSaltoCita = null;

/**
 * Ir al mensaje citado: apretar el bloque "respondiendo a…" lleva a la burbuja
 * original dentro del chat y la marca un instante (como WhatsApp), para que se
 * entienda a QUÉ se refería el cliente.
 */
export function montarSaltoCita({ contenedor } = {}) {
    if (!contenedor || contenedor.__saltoCitaMontado) return null;
    contenedor.__saltoCitaMontado = true;

    contenedor.addEventListener('click', (e) => {
        const t = e.target;
        if (!t || !t.closest) return;
        const bloque = t.closest('.vl-cita');
        if (!bloque || !contenedor.contains(bloque)) return;
        const id = bloque.dataset ? (bloque.dataset.citaId || '') : '';
        if (!id) return;              // no hay a dónde ir
        const destino = contenedor.querySelector(`.vl-fila-msg[data-id="${id}"]`);
        if (!destino) return;         // el mensaje citado no está en esta vista
        e.preventDefault();
        e.stopPropagation();
        destino.scrollIntoView({ behavior: 'smooth', block: 'center' });
        destino.classList.add('vl-msg-hallada');
        if (_timerSaltoCita) clearTimeout(_timerSaltoCita);
        _timerSaltoCita = setTimeout(() => {
            contenedor.querySelectorAll('.vl-msg-hallada')
                .forEach((el) => el.classList.remove('vl-msg-hallada'));
        }, 1800);
    });

    // Accesible con teclado (Enter/Espacio) sobre el bloque de la cita.
    contenedor.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const bloque = e.target && e.target.closest ? e.target.closest('.vl-cita') : null;
        if (!bloque) return;
        e.preventDefault();
        bloque.click();
    });

    return {};
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
