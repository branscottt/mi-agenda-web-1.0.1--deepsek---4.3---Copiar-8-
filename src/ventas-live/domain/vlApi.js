// ventas-live/domain/vlApi.js
// Capa de acceso a las RPCs de Ventas Live (SECURITY DEFINER).
// Cada función devuelve { ok: true, data } o { ok: false, error }.
// Los errores controlados del servidor vienen como { ok:false, error }
// dentro del JSONB; los errores de red/RLS se normalizan acá.

import { getSupabase } from '../../shared/infrastructure/supabase.js';

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

// Normaliza el usuario TikTok igual que el servidor (minúsculas, sin @)
export function normalizarTiktok(user) {
    return String(user || '').toLowerCase().replace(/^@+/, '').replace(/\s+/g, '');
}

export const vlApi = {
    // ---- MODO LIVE ----
    agregarItem: (tiktokUser, precio, descripcion = '') =>
        callRpc('vl_agregar_item', { p_tiktok_user: tiktokUser, p_precio: precio, p_descripcion: descripcion }),
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
    marcarEntregado: (procesoId) => callRpc('vl_marcar_entregado', { p_proceso_id: procesoId }),
    liberarItems: (procesoId, itemIds, nota = '') =>
        callRpc('vl_liberar_items', { p_proceso_id: procesoId, p_item_ids: itemIds, p_nota: nota }),

    // ---- Paneles ----
    panelProcesos: () => callRpc('vl_panel_procesos'),
    enviosPendientes: () => callRpc('vl_envios_pendientes'),
    dashboard: () => callRpc('vl_dashboard'),
    finanzasResumen: () => callRpc('vl_finanzas_resumen'),

    // ---- Finanzas / config ----
    agregarGasto: (tipo, concepto, monto, fecha = null) =>
        callRpc('vl_agregar_gasto', { p_tipo: tipo, p_concepto: concepto, p_monto: monto, p_fecha: fecha }),
    eliminarGasto: (gastoId) => callRpc('vl_eliminar_gasto', { p_gasto_id: gastoId }),
    guardarConfig: (params) => callRpc('vl_guardar_config', params)
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
    completado:           { label: '✅ Completado',                grupo: null },
    no_pago_liberado:     { label: '🔴 No pagó / liberada',        grupo: null }
};
