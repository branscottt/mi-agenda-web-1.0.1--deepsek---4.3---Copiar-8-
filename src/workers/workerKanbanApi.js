// src/workers/workerKanbanApi.js
// Adaptador worker-scoped del tablero kanban: implementa la MISMA
// interfaz que src/api/kanbanApi.js (que usa el admin en
// ClientBoard.js) pero llamando a los RPCs SECURITY DEFINER del
// portal del trabajador. Así el portal reutiliza ClientBoard.js
// tal cual (mismo tablero, mismas opciones) sin acceso directo a
// las tablas kanban (RLS admin-only).
// Límite de seguridad: adjuntos solo lectura (metadata) — el bucket
// kanban-adjuntos es privado y firmar URLs requiere sesión admin.

let _tenantId = null;
let _workerId = null;
let _emailActual = null;
let _lastBoard = null; // último board cargado (caché de títulos para toggle)

export function configurarWorkerKanban(tenantId, workerId) {
    _tenantId = tenantId;
    _workerId = workerId;
}

function supabase() {
    if (!window.supabaseClient) throw new Error('Cliente Supabase no disponible');
    return window.supabaseClient;
}

async function _rpc(nombre, params) {
    const { data, error } = await supabase().rpc(nombre, params);
    if (error) throw error;
    if (data && typeof data === 'object' && data.error) {
        const err = new Error(data.error);
        err.workerError = data.error;
        throw err;
    }
    return data;
}

function _tituloDeCaché(cardId) {
    if (!_lastBoard || !_lastBoard.lists) return null;
    for (const l of _lastBoard.lists) {
        const c = (l.cards || []).find(x => String(x.id) === String(cardId));
        if (c) return c.titulo;
    }
    return null;
}

// ========== BOARDS ==========

/** worker_get_board crea el board si no existe (tras validar acceso). */
export async function getOrCreateBoard(tenantId, clienteEmail, clienteNombre) {
    _emailActual = String(clienteEmail || '').trim().toLowerCase();
    const data = await _rpc('worker_get_board', {
        p_tenant_id: tenantId,
        p_worker_id: _workerId,
        p_cliente_email: _emailActual
    });
    _lastBoard = data;
    return data.board;
}

export async function getBoardData(boardId) {
    const data = await _rpc('worker_get_board', {
        p_tenant_id: _tenantId,
        p_worker_id: _workerId,
        p_cliente_email: _emailActual
    });
    _lastBoard = data;
    return { lists: data.lists || [] };
}

// ========== LISTS ==========

export async function createList(boardId, titulo, posicion) {
    const data = await _rpc('worker_add_list', {
        p_tenant_id: _tenantId,
        p_worker_id: _workerId,
        p_cliente_email: _emailActual,
        p_titulo: titulo
    });
    return { id: data.list_id, titulo, posicion };
}

export async function updateList(id, updates) {
    const data = await _rpc('worker_renombrar_lista', {
        p_tenant_id: _tenantId,
        p_worker_id: _workerId,
        p_lista_id: id,
        p_titulo: updates.titulo
    });
    return { id, titulo: data.titulo };
}

export async function deleteList(id) {
    await _rpc('worker_eliminar_lista', {
        p_tenant_id: _tenantId,
        p_worker_id: _workerId,
        p_lista_id: id
    });
    return true;
}

// ========== CARDS ==========

export async function createCard(listId, { titulo, descripcion = '', posicion = 0, cita_id = null, etiquetas = [] }) {
    const data = await _rpc('worker_guardar_tarjeta', {
        p_tenant_id: _tenantId,
        p_worker_id: _workerId,
        p_card_id: null,
        p_list_id: listId,
        p_titulo: titulo,
        p_descripcion: descripcion,
        p_etiquetas: etiquetas,
        p_cita_id: cita_id,
        p_posicion: posicion,
        p_completado: false
    });
    return { id: data.card_id, titulo, descripcion, posicion, cita_id, etiquetas, completado: false };
}

export async function updateCard(id, updates) {
    // El toggle "hecha" solo envía { completado } → el título se
    // toma del último board cargado (el RPC exige título).
    const titulo = updates.titulo != null ? updates.titulo : _tituloDeCaché(id);
    if (!titulo) throw new Error('No se pudo resolver la tarjeta');
    const data = await _rpc('worker_guardar_tarjeta', {
        p_tenant_id: _tenantId,
        p_worker_id: _workerId,
        p_card_id: id,
        p_list_id: updates.list_id != null ? updates.list_id : null,
        p_titulo: titulo,
        p_descripcion: updates.descripcion != null ? updates.descripcion : '',
        p_etiquetas: updates.etiquetas != null ? updates.etiquetas : [],
        p_cita_id: updates.cita_id !== undefined ? updates.cita_id : null,
        p_posicion: updates.posicion != null ? updates.posicion : null,
        p_completado: updates.completado != null ? updates.completado : null
    });
    return { id, ...updates };
}

export async function deleteCard(id) {
    await _rpc('worker_eliminar_tarjeta', {
        p_tenant_id: _tenantId,
        p_worker_id: _workerId,
        p_card_id: id
    });
    return true;
}

/** Reordena/traslada varias tarjetas a la vez (Drag & Drop). */
export async function reordenarCards(updates) {
    await _rpc('worker_reordenar_tarjetas', {
        p_tenant_id: _tenantId,
        p_worker_id: _workerId,
        p_updates: updates
    });
    return true;
}

// ========== ESTILOS DE LISTAS (plantillas del tenant) ==========

export async function saveEstilo(tenantId, nombre, listas) {
    const data = await _rpc('worker_guardar_estilo', {
        p_tenant_id: tenantId,
        p_worker_id: _workerId,
        p_nombre: nombre,
        p_listas: listas
    });
    return { id: data.estilo_id, nombre, listas };
}

export async function listEstilos(tenantId) {
    const data = await _rpc('worker_listar_estilos', {
        p_tenant_id: tenantId,
        p_worker_id: _workerId
    });
    return data.estilos || [];
}

export async function deleteEstilo(id) {
    await _rpc('worker_eliminar_estilo', {
        p_tenant_id: _tenantId,
        p_worker_id: _workerId,
        p_estilo_id: id
    });
    return true;
}

// ========== CHECKLISTS ==========

export async function createChecklist(cardId, titulo = 'Checklist', posicion = 0) {
    const data = await _rpc('worker_add_checklist', {
        p_tenant_id: _tenantId,
        p_worker_id: _workerId,
        p_card_id: cardId,
        p_titulo: titulo
    });
    return { id: data.checklist_id, titulo, posicion, items: [] };
}

export async function updateChecklist(id, updates) {
    const data = await _rpc('worker_renombrar_checklist', {
        p_tenant_id: _tenantId,
        p_worker_id: _workerId,
        p_checklist_id: id,
        p_titulo: updates.titulo
    });
    return { id, titulo: data.titulo };
}

export async function deleteChecklist(id) {
    await _rpc('worker_eliminar_checklist', {
        p_tenant_id: _tenantId,
        p_worker_id: _workerId,
        p_checklist_id: id
    });
    return true;
}

export async function addChecklistItem(checklistId, cardId, texto, posicion) {
    const data = await _rpc('worker_add_checklist_item', {
        p_tenant_id: _tenantId,
        p_worker_id: _workerId,
        p_card_id: cardId,
        p_checklist_id: checklistId,
        p_texto: texto
    });
    return { id: data.item_id, checklist_id: checklistId, texto, completado: false, posicion };
}

export async function updateChecklistItem(id, updates) {
    await _rpc('worker_toggle_checklist_item', {
        p_tenant_id: _tenantId,
        p_worker_id: _workerId,
        p_item_id: id,
        p_completado: updates.completado === true
    });
    return { id, completado: updates.completado === true };
}

export async function deleteChecklistItem(id) {
    await _rpc('worker_eliminar_item_checklist', {
        p_tenant_id: _tenantId,
        p_worker_id: _workerId,
        p_item_id: id
    });
    return true;
}

// ========== ATTACHMENTS (solo lectura en el portal) ==========

export async function addAttachment() {
    throw new Error('Los documentos son solo lectura desde el portal del trabajador');
}

export async function deleteAttachment() {
    throw new Error('Los documentos son solo lectura desde el portal del trabajador');
}

export async function getAttachmentUrl() {
    throw new Error('Los documentos son solo lectura desde el portal del trabajador');
}

export async function uploadAttachment() {
    throw new Error('Los documentos son solo lectura desde el portal del trabajador');
}
