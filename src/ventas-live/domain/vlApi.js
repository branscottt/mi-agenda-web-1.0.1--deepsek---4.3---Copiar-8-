// ventas-live/domain/vlApi.js
// Capa de acceso a las RPCs de Ventas Live (SECURITY DEFINER).
// Cada función devuelve { ok: true, data } o { ok: false, error }.
// Los errores controlados del servidor vienen como { ok:false, error }
// dentro del JSONB; los errores de red/RLS se normalizan acá.

import { getSupabase } from '../../shared/infrastructure/supabase.js';
import { getAppConfig } from '../../shared/infrastructure/config.js';

// Token JWT actual (mismo criterio que el cliente de Mercado Pago):
// 1) JwtManager moderno, 2) sesión de Supabase, 3) localStorage legacy.
function getAuthToken() {
    if (window.JwtManager && typeof window.JwtManager.getAccessToken === 'function') {
        const t = window.JwtManager.getAccessToken();
        if (t) return t;
    }
    if (window.__session && window.__session.access_token) return window.__session.access_token;
    try {
        const stored = localStorage.getItem('supabase.auth.token');
        if (stored) {
            const parsed = JSON.parse(stored);
            return (parsed && parsed.currentSession && parsed.currentSession.access_token) || null;
        }
    } catch (_) { /* sin token */ }
    return null;
}

// Envío manual de WhatsApp: pasa por la Edge Function (el token del tenant
// vive server-side y nunca llega al navegador).
async function enviarMensajeManual(chatId, texto) {
    try {
        const cfg = getAppConfig();
        const base = (cfg.edgeFunctionsUrl ||
            ((cfg.supabaseUrl || '').replace(/\/+$/, '') + '/functions/v1'));
        const token = getAuthToken();
        if (!token) return { ok: false, error: 'Sesión no disponible' };

        const resp = await fetch(`${base}/wa-enviar`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ chat_id: chatId, texto })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data || data.ok !== true) {
            return { ok: false, error: (data && data.error) || `Error HTTP ${resp.status}` };
        }
        return { ok: true, data: data.mensaje };
    } catch (e) {
        return { ok: false, error: e.message || 'Error inesperado' };
    }
}

// Envío manual de FOTO/VIDEO con comentario. Dos pasos:
//   1. El archivo se sube al bucket privado 'vl-media' en la carpeta del negocio
//      ({tenant}/{chat}/{uuid}.ext) — la política de storage lo permite.
//   2. La Edge Function wa-enviar lo baja con service_role, lo sube a Meta y lo
//      manda por WhatsApp con el comentario como caption.
// Si el envío falla, se borra lo subido (no queda basura en el bucket).
function extensionDeArchivo(archivo, tipo) {
    const mime = String((archivo && archivo.type) || '').toLowerCase();
    const porMime = {
        'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
        'video/mp4': 'mp4', 'video/3gpp': '3gp'
    };
    if (porMime[mime]) return porMime[mime];
    const ext = String((archivo && archivo.name) || '').split('.').pop().toLowerCase();
    if (/^[a-z0-9]{2,5}$/.test(ext)) return ext;
    return tipo === 'video' ? 'mp4' : 'jpg';
}

async function enviarMediaManual(chatId, { archivo, tipo, comentario = '' } = {}) {
    try {
        const cfg = getAppConfig();
        const base = (cfg.edgeFunctionsUrl ||
            ((cfg.supabaseUrl || '').replace(/\/+$/, '') + '/functions/v1'));
        const token = getAuthToken();
        const supabase = getSupabase();
        if (!token || !supabase) return { ok: false, error: 'Sesión no disponible' };

        const ten = await callRpc('get_vl_tenant_id');
        const tenantId = (ten && ten.ok && typeof ten.data === 'string') ? ten.data : '';
        if (!tenantId) return { ok: false, error: 'No se pudo identificar tu negocio' };

        const ruta = `${tenantId}/${chatId}/${crypto.randomUUID()}.${extensionDeArchivo(archivo, tipo)}`;
        const up = await supabase.storage.from('vl-media').upload(ruta, archivo, {
            contentType: archivo.type || (tipo === 'video' ? 'video/mp4' : 'image/jpeg'),
            upsert: false
        });
        if (up && up.error) {
            return { ok: false, error: up.error.message || 'No se pudo subir el archivo' };
        }

        const resp = await fetch(`${base}/wa-enviar`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                chat_id: chatId,
                texto: comentario || null,
                media_path: ruta,
                media_tipo: tipo,
                media_mime: archivo.type || ''
            })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data || data.ok !== true) {
            try { await supabase.storage.from('vl-media').remove([ruta]); } catch (_) { /* sin permiso: se deja */ }
            return { ok: false, error: (data && data.error) || `Error HTTP ${resp.status}` };
        }
        return { ok: true, data: data.mensaje };
    } catch (e) {
        return { ok: false, error: e.message || 'Error inesperado' };
    }
}

async function callRpc(nombre, params = {}) {
    const supabase = getSupabase();
    if (!supabase) return { ok: false, error: 'Sesión no disponible' };
    try {
        const { data, error } = await supabase.rpc(nombre, params);
        if (error) {
            return { ok: false, error: error.message || 'Error de conexión' };
        }
        if (data && typeof data === 'object' && data.ok === false) {
            return { ok: false, error: data.error || 'Operación rechazada' };
        }
        return { ok: true, data };
    } catch (e) {
        return { ok: false, error: e.message || 'Error inesperado' };
    }
}

// Normaliza el usuario TikTok igual que el servidor (minúsculas, sin @).
// Acepta lo que se pueda COPIAR del LIVE de TikTok, sea cual sea el formato:
//   * enlace del perfil: https://www.tiktok.com/@usuario  (o .../@usuario/live,
//     con ?lang=…, sin esquema, móvil m.)  → se queda con el @ del enlace;
//   * una @mención suelta ("@usuario hola") → se queda con la mención;
//   * el nombre a secas ("usuario")         → tal cual, en minúsculas.
// Motivo: en el LIVE TikTok NO deja copiar solo el nombre, así que el vendedor
// pega lo que puede y aquí queda exacto. Igual que vl_normalizar_tiktok (SQL).
export function normalizarTiktok(user) {
    let s = String(user || '').trim();
    const url = s.match(/tiktok\.com\/@?([A-Za-z0-9._]+)/i);
    if (url) {
        s = url[1];
    } else {
        const men = s.match(/@([A-Za-z0-9._]{2,30})/);
        if (men) s = men[1];
    }
    return s
        .toLowerCase()
        .replace(/^@+/, '')
        .replace(/^\.+|\.+$/g, '')
        .replace(/\s+/g, '');
}

export const vlApi = {
    // ---- MODO LIVE ----
    // confirmarParecido=true → el servidor avisa si lo escrito empieza igual que
    // un cliente existente (devuelve requiere_confirmacion SIN crear nada).
    // Volver a llamar con false crea la ficha nueva (el usuario ya confirmó).
    agregarItem: (tiktokUser, precio, descripcion = '', confirmarParecido = true) =>
        callRpc('vl_agregar_item', {
            p_tiktok_user: tiktokUser, p_precio: precio, p_descripcion: descripcion,
            p_confirmar_parecido: confirmarParecido
        }),
    liveActual: () => callRpc('vl_live_actual'),
    abrirLive: (etiqueta = '') => callRpc('vl_abrir_live', { p_etiqueta: etiqueta }),
    cerrarLive: (liveId) => callRpc('vl_cerrar_live', { p_live_id: liveId }),
    eliminarItem: (itemId) => callRpc('vl_eliminar_item', { p_item_id: itemId }),

    // ---- Búsqueda / ficha ----
    buscarClientes: (q = '', limit = 50) => callRpc('vl_buscar_clientes', { p_q: q, p_limit: limit }),
    fichaCliente: (clienteId) => callRpc('vl_ficha_cliente', { p_cliente_id: clienteId }),

    // ---- Acciones de proceso ----
    actualizarCliente: (params) => callRpc('vl_actualizar_cliente', params),
    marcarEsperandoPago: (procesoId) => callRpc('vl_marcar_esperando_pago', { p_proceso_id: procesoId }),
    marcarPagaraPresencial: (procesoId) => callRpc('vl_marcar_pagara_presencial', { p_proceso_id: procesoId }),
    confirmarPago: (procesoId, monto, metodo = 'transferencia', nota = '') =>
        callRpc('vl_confirmar_pago', { p_proceso_id: procesoId, p_monto: monto, p_metodo: metodo, p_nota: nota }),
    decidirEntrega: (procesoId, opcion, fecha = null, tipo = 'envio') =>
        callRpc('vl_decidir_entrega', { p_proceso_id: procesoId, p_opcion: opcion, p_fecha: fecha, p_tipo: tipo }),
    crearEnvio: (procesoId, empresa = '', tracking = '') =>
        callRpc('vl_crear_envio', { p_proceso_id: procesoId, p_empresa: empresa, p_tracking: tracking }),
    // p_pagado = false -> se entrega sin pago confirmado: el pedido queda
    // "entregado por cobrar" (abierto, con la deuda registrada).
    marcarEntregado: (procesoId, pagado = true) =>
        callRpc('vl_marcar_entregado', { p_proceso_id: procesoId, p_pagado: pagado }),
    promoverEntrega: (clienteId) => callRpc('vl_wa_promover_entrega', { p_cliente_id: clienteId }),
    liberarItems: (procesoId, itemIds, nota = '') =>
        callRpc('vl_liberar_items', { p_proceso_id: procesoId, p_item_ids: itemIds, p_nota: nota }),
    // Pagar prendas puntuales (una o todas): registra el pago y lo imputa a ESAS
    // prendas (no FIFO), para poder cobrar "solo alguna".
    pagarItems: (procesoId, itemIds, metodo = 'transferencia', nota = '') =>
        callRpc('vl_pagar_items', {
            p_proceso_id: procesoId, p_item_ids: itemIds, p_metodo: metodo, p_nota: nota
        }),

    // ---- Paneles ----
    panelProcesos: () => callRpc('vl_panel_procesos'),
    enviosPendientes: () => callRpc('vl_envios_pendientes'),
    configFaltantes: () => callRpc('vl_config_faltantes'),
    dashboard: () => callRpc('vl_dashboard'),
    finanzasResumen: () => callRpc('vl_finanzas_resumen'),

    // ---- Finanzas / config ----
    agregarGasto: (tipo, concepto, monto, fecha = null) =>
        callRpc('vl_agregar_gasto', { p_tipo: tipo, p_concepto: concepto, p_monto: monto, p_fecha: fecha }),
    eliminarGasto: (gastoId) => callRpc('vl_eliminar_gasto', { p_gasto_id: gastoId }),
    guardarConfig: (params) => callRpc('vl_guardar_config', params),

    // ---- Config del workspace (nombre y WhatsApp propios del proyecto) ----
    workspaceInfo: () => callRpc('vl_workspace_info'),
    actualizarWorkspace: (nombre, whatsapp, horarioEntrega) =>
        callRpc('vl_actualizar_workspace', {
            p_nombre_negocio: nombre,
            p_whatsapp: whatsapp,
            p_horario_entrega: horarioEntrega
        }),

    // ---- Conexión WhatsApp (bot Cloud API) ----
    guardarConfigWa: (params) => callRpc('vl_guardar_config_wa', params),
    waConexionInfo: () => callRpc('vl_wa_conexion_info'),

    // ---- Configurador de respuestas del bot (sin programar) ----
    // El guion base lo ven todos; los overrides son por tenant. Dejar una
    // respuesta en blanco => el bot calla y deja aviso al negocio.
    respuestasListar: () => callRpc('vl_wa_respuestas_listar'),
    respuestaGuardar: (clave, cuerpo, activo = true) =>
        callRpc('vl_wa_respuesta_guardar', { p_clave: clave, p_cuerpo: cuerpo, p_activo: activo }),
    respuestaRestaurar: (clave) => callRpc('vl_wa_respuesta_restaurar', { p_clave: clave }),
    respuestaCrear: (gatillos, cuerpo) =>
        callRpc('vl_wa_respuesta_crear', { p_gatillos: gatillos, p_cuerpo: cuerpo }),
    respuestaReglaEliminar: (id) => callRpc('vl_wa_respuesta_regla_eliminar', { p_id: id }),
    respuestasReset: () => callRpc('vl_wa_respuestas_reset'),
    // Modo por momento ('aleatorio' rota variantes | 'fijo' manda la opción activa)
    respuestaModo: (clave, modo) => callRpc('vl_wa_respuesta_modo', { p_clave: clave, p_modo: modo }),
    // Opciones etiquetadas (burbujas) de un momento — incluye la clave 'datos_pago'
    opcionesListar: (clave) => callRpc('vl_wa_opciones_listar', { p_clave: clave }),
    opcionGuardar: (clave, etiqueta, texto, activa = false, id = null) =>
        callRpc('vl_wa_opcion_guardar', { p_clave: clave, p_etiqueta: etiqueta, p_texto: texto, p_activa: activa, p_id: id }),
    opcionActivar: (id) => callRpc('vl_wa_opcion_activar', { p_id: id }),
    opcionEliminar: (id) => callRpc('vl_wa_opcion_eliminar', { p_id: id }),

    // ---- Chats de WhatsApp (intervención humana) ----
    chatsListar: () => callRpc('vl_wa_chats_listar'),
    chatHilo: (chatId) => callRpc('vl_wa_chat_hilo', { p_chat_id: chatId }),
    chatModo: (chatId, modo) => callRpc('vl_wa_chat_modo', { p_chat_id: chatId, p_modo: modo }),
    chatPorCliente: (clienteId) => callRpc('vl_wa_chat_por_cliente', { p_cliente_id: clienteId }),
    candidatosChat: (chatId) => callRpc('vl_wa_candidatos_chat', { p_chat_id: chatId }),
    // Lista para ASIGNAR el usuario del chat a mano (siempre disponible): los que
    // compraron (primero los que quedaron sin vincular) y búsqueda por @/nombre.
    usuariosParaChat: (chatId, texto) => callRpc('vl_wa_usuarios_para_chat', {
        p_chat_id: chatId, p_texto: (texto && texto.trim()) ? texto.trim() : null
    }),
    vincularChatCliente: (chatId, clienteId) => callRpc('vl_wa_vincular_chat', {
        p_chat_id: chatId, p_cliente_id: clienteId
    }),
    chatProceso: (chatId) => callRpc('vl_wa_chat_proceso', { p_chat_id: chatId }),
    chatOcultar: (chatId, oculto = true) => callRpc('vl_wa_chat_ocultar', { p_chat_id: chatId, p_oculto: oculto }),

    // ---- Notificaciones PUSH (llegan con la app CERRADA; Web Push, gratis) ----
    guardarPushSub: (endpoint, p256dh, auth) =>
        callRpc('vl_push_guardar', { p_endpoint: endpoint, p_p256dh: p256dh, p_auth: auth }),
    borrarPushSub: (endpoint) => callRpc('vl_push_borrar', { p_endpoint: endpoint }),
    enviarManual: (chatId, texto) => enviarMensajeManual(chatId, texto),
    // Foto o video con comentario (desde computador, celular o tablet).
    enviarMediaManual: (chatId, opciones) => enviarMediaManual(chatId, opciones),

    // ---- Diagrama de procesos (todos de una, con puntos presionables) ----
    diagramaProcesos: () => callRpc('vl_procesos_diagrama'),
    procesoPuntoSet: (procesoId, punto, valor, fecha = null) =>
        callRpc('vl_proceso_punto_set', {
            p_proceso_id: procesoId, p_punto: punto, p_valor: valor, p_fecha: fecha
        }),

    // ---- Bloqueo + borrado de datos del cliente (destructivo) ----
    clienteBloquearBorrar: (clienteId) => callRpc('vl_cliente_bloquear_borrar', { p_cliente_id: clienteId }),
    eliminarCompra: (procesoId) => callRpc('vl_eliminar_compra', { p_proceso_id: procesoId })
};

export const CATEGORIA_INFO = {
    nuevo:        { label: 'Cliente nuevo',              clase: 'nuevo' },
    confiable:    { label: 'Cliente confiable',          clase: 'confiable' },
    problematico: { label: '⚠️ Posible problemático',    clase: 'problematico' },
    bloqueado:    { label: '🚫 Bloqueado',               clase: 'bloqueado' }
};

export const ESTADO_INFO = {
    esperando_whatsapp:   { label: '🟡 Esperando WhatsApp',        grupo: 'esperando_whatsapp' },
    identificando_cliente:{ label: '🔵 Identificando cliente',     grupo: 'esperando_whatsapp' },
    esperando_pago:       { label: '🟠 Esperando pago',            grupo: 'esperando_pago' },
    pago_parcial:         { label: '🟣 Pago parcial',              grupo: 'pago_parcial' },
    pagara_presencial:    { label: '🔵 Pagará presencialmente',    grupo: 'pagara_presencial' },
    pagado:               { label: '🟢 Pagado',                    grupo: 'pagado_sin_decision' },
    acumulando:           { label: '🛍️ Acumulando prendas',        grupo: 'acumulando' },
    listo_preparar:       { label: '📦 Listo para preparar',       grupo: 'listo_preparar' },
    envio_programado:     { label: '📅 Envío programado',          grupo: 'envio_programado' },
    envio_proceso:        { label: '🚚 Envío en proceso',          grupo: 'envio_proceso' },
    entrega_presencial:   { label: '🤝 Entrega presencial',        grupo: 'entrega_presencial' },
    entregado_por_cobrar: { label: '💸 Entregado, falta cobrar',   grupo: 'por_cobrar' },
    completado:           { label: '✅ Completado',                grupo: null },
    no_pago_liberado:     { label: '🔴 No pagó / liberada',        grupo: null }
};
