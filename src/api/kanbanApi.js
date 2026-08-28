// src/api/kanbanApi.js
// ÚNICA capa de acceso a datos del tablero de información por cliente.
// Tablas: kanban_boards, kanban_lists, kanban_cards,
//         kanban_checklists, kanban_checklist_items, kanban_attachments.
// Adjuntos: metadata en kanban_attachments, binario en Storage
// (bucket privado 'kanban-adjuntos', carpeta raíz = tenant_id).
// SIN caché: el admin espera que "apenas se guarde" se vea.
import { getSupabase } from '../shared/infrastructure/supabase.js';

// ========== BOARDS ==========

/**
 * Devuelve el board del cliente o lo crea (UNIQUE tenant_id+email).
 */
export async function getOrCreateBoard(tenantId, clienteEmail, clienteNombre) {
    const supabase = getSupabase();
    const email = String(clienteEmail || '').trim().toLowerCase();
    if (!tenantId || !email) throw new Error('Faltan tenant_id o email del cliente');

    const { data: existente } = await supabase
        .from('kanban_boards')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('cliente_email', email)
        .maybeSingle();
    if (existente) return existente;

    const { data: creado, error } = await supabase
        .from('kanban_boards')
        .insert({ tenant_id: tenantId, cliente_email: email, cliente_nombre: clienteNombre || '' })
        .select()
        .single();
    if (error) throw error;
    return creado;
}

// ========== DATOS COMPLETOS ==========

/**
 * Carga lists + cards + checklists + adjuntos del board y los
 * devuelve anidados:
 * { lists: [{ id, titulo, posicion, cards: [{ id, titulo, descripcion,
 *   posicion, etiquetas, cita_id, checklists: [{ id, titulo, items: [] }],
 *   adjuntos: [] }] }] }
 */
export async function getBoardData(boardId) {
    const supabase = getSupabase();
    const { data: lists, error: errLists } = await supabase
        .from('kanban_lists')
        .select('*')
        .eq('board_id', boardId)
        .order('posicion', { ascending: true });
    if (errLists) throw errLists;
    if (!lists || !lists.length) return { lists: [] };

    const listIds = lists.map(l => l.id);
    const { data: cards, error: errCards } = await supabase
        .from('kanban_cards')
        .select('*')
        .in('list_id', listIds)
        .order('posicion', { ascending: true });
    if (errCards) throw errCards;

    const cardsList = cards || [];
    const cardIds = cardsList.map(c => c.id);
    const [checklistsRes, itemsRes, adjuntosRes] = await Promise.all([
        cardIds.length
            ? supabase.from('kanban_checklists').select('*').in('card_id', cardIds).order('posicion', { ascending: true })
            : Promise.resolve({ data: [], error: null }),
        cardIds.length
            ? supabase.from('kanban_checklist_items').select('*').in('card_id', cardIds).order('posicion', { ascending: true })
            : Promise.resolve({ data: [], error: null }),
        cardIds.length
            ? supabase.from('kanban_attachments').select('*').in('card_id', cardIds).order('created_at', { ascending: false })
            : Promise.resolve({ data: [], error: null })
    ]);
    if (checklistsRes.error) throw checklistsRes.error;
    if (itemsRes.error) throw itemsRes.error;
    if (adjuntosRes.error) throw adjuntosRes.error;

    const checklists = checklistsRes.data || [];
    const items = itemsRes.data || [];
    const adjuntos = adjuntosRes.data || [];

    const itemsPorChecklist = {};
    items.forEach(it => {
        if (!itemsPorChecklist[it.checklist_id]) itemsPorChecklist[it.checklist_id] = [];
        itemsPorChecklist[it.checklist_id].push(it);
    });
    const checklistsPorCard = {};
    checklists.forEach(ch => {
        if (!checklistsPorCard[ch.card_id]) checklistsPorCard[ch.card_id] = [];
        checklistsPorCard[ch.card_id].push({
            ...ch,
            items: itemsPorChecklist[ch.id] || []
        });
    });
    const adjuntosPorCard = {};
    adjuntos.forEach(a => {
        if (!adjuntosPorCard[a.card_id]) adjuntosPorCard[a.card_id] = [];
        adjuntosPorCard[a.card_id].push(a);
    });

    return {
        lists: lists.map(l => ({
            ...l,
            cards: cardsList
                .filter(c => c.list_id === l.id)
                .map(c => ({
                    ...c,
                    checklists: checklistsPorCard[c.id] || [],
                    adjuntos: adjuntosPorCard[c.id] || []
                }))
        }))
    };
}

// ========== LISTS ==========

export async function createList(boardId, titulo, posicion) {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from('kanban_lists')
        .insert({ board_id: boardId, titulo, posicion })
        .select()
        .single();
    if (error) throw error;
    return data;
}

export async function updateList(id, updates) {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from('kanban_lists')
        .update(updates)
        .eq('id', id)
        .select()
        .single();
    if (error) throw error;
    return data;
}

export async function deleteList(id) {
    const supabase = getSupabase();
    const { error } = await supabase.from('kanban_lists').delete().eq('id', id);
    if (error) throw error;
    return true;
}

// ========== CARDS ==========

export async function createCard(listId, { titulo, descripcion = '', posicion = 0, cita_id = null, etiquetas = [] }) {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from('kanban_cards')
        .insert({ list_id: listId, titulo, descripcion, posicion, cita_id, etiquetas })
        .select()
        .single();
    if (error) throw error;
    return data;
}

export async function updateCard(id, updates) {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from('kanban_cards')
        .update(updates)
        .eq('id', id)
        .select()
        .single();
    if (error) throw error;
    return data;
}

export async function deleteCard(id) {
    const supabase = getSupabase();
    const { error } = await supabase.from('kanban_cards').delete().eq('id', id);
    if (error) throw error;
    return true;
}

/** Reordena/traslada varias tarjetas a la vez (Drag & Drop). */
export async function reordenarCards(updates) {
    const supabase = getSupabase();
    for (const u of updates) {
        const { error } = await supabase
            .from('kanban_cards')
            .update({ list_id: u.list_id, posicion: u.posicion })
            .eq('id', u.id);
        if (error) throw error;
    }
    return true;
}

// ========== ESTILOS DE LISTAS (plantillas por tenant) ==========

/** Guarda la estructura de listas actual como plantilla reutilizable. */
export async function saveEstilo(tenantId, nombre, listas) {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from('kanban_estilos')
        .insert({ tenant_id: tenantId, nombre, listas })
        .select()
        .single();
    if (error) throw error;
    return data;
}

export async function listEstilos(tenantId) {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from('kanban_estilos')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

export async function deleteEstilo(id) {
    const supabase = getSupabase();
    const { error } = await supabase.from('kanban_estilos').delete().eq('id', id);
    if (error) throw error;
    return true;
}

// ========== CHECKLISTS (múltiples por tarjeta, estilo Trello) ==========

export async function createChecklist(cardId, titulo = 'Checklist', posicion = 0) {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from('kanban_checklists')
        .insert({ card_id: cardId, titulo, posicion })
        .select()
        .single();
    if (error) throw error;
    return { ...data, items: [] };
}

export async function updateChecklist(id, updates) {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from('kanban_checklists')
        .update(updates)
        .eq('id', id)
        .select()
        .single();
    if (error) throw error;
    return data;
}

export async function deleteChecklist(id) {
    const supabase = getSupabase();
    const { error } = await supabase.from('kanban_checklists').delete().eq('id', id);
    if (error) throw error;
    return true;
}

export async function addChecklistItem(checklistId, cardId, texto, posicion) {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from('kanban_checklist_items')
        .insert({ checklist_id: checklistId, card_id: cardId, texto, posicion })
        .select()
        .single();
    if (error) throw error;
    return data;
}

export async function updateChecklistItem(id, updates) {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from('kanban_checklist_items')
        .update(updates)
        .eq('id', id)
        .select()
        .single();
    if (error) throw error;
    return data;
}

export async function deleteChecklistItem(id) {
    const supabase = getSupabase();
    const { error } = await supabase.from('kanban_checklist_items').delete().eq('id', id);
    if (error) throw error;
    return true;
}

// ========== ATTACHMENTS (metadata + storage) ==========

export async function addAttachment(cardId, { nombre, tipo_mime, tamano, storage_path }) {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from('kanban_attachments')
        .insert({ card_id: cardId, nombre, tipo_mime, tamano, storage_path })
        .select()
        .single();
    if (error) throw error;
    return data;
}

export async function deleteAttachment(id, storagePath) {
    const supabase = getSupabase();
    // Borrar metadata y objeto de storage (best effort: si el objeto ya
    // no existe, el error de storage no debe romper el borrado lógico).
    if (storagePath) {
        await supabase.storage.from('kanban-adjuntos').remove([storagePath]).catch(() => {});
    }
    const { error } = await supabase.from('kanban_attachments').delete().eq('id', id);
    if (error) throw error;
    return true;
}

/** URL firmada (1h) para ver/descargar un adjunto del bucket privado. */
export async function getAttachmentUrl(storagePath) {
    const supabase = getSupabase();
    const { data, error } = await supabase.storage
        .from('kanban-adjuntos')
        .createSignedUrl(storagePath, 3600);
    if (error) throw error;
    return data?.signedUrl || null;
}

/**
 * Sube el binario al bucket privado con PROGRESO REAL (XHR).
 * Devuelve el storage_path. onProgress({loaded, total}) se llama
 * durante la subida (total = bytes del archivo).
 */
export async function uploadAttachment(file, boardId, cardId, onProgress) {
    const supabase = getSupabase();
    const tenantId = await getTenantCanonico();
    const nombreLimpio = (file.name || 'archivo')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    const storagePath = `${tenantId}/boards/${boardId}/${cardId}/${Date.now()}-${nombreLimpio}`;

    // Sesión para el token (XHR no pasa por el cliente, necesita headers manuales)
    let token = null;
    try {
        const { data } = await supabase.auth.getSession();
        token = data?.session?.access_token || null;
    } catch (e) {
        console.warn('[kanbanApi] No se pudo leer la sesión para el upload:', e);
    }

    const url = `${supabase.supabaseUrl}/storage/v1/object/kanban-adjuntos/${storagePath}`;
    const key = supabase.supabaseKey;

    const resultado = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        if (key) xhr.setRequestHeader('apikey', key);
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        xhr.setRequestHeader('x-upsert', 'false');

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && typeof onProgress === 'function') {
                onProgress({ loaded: e.loaded, total: e.total });
            }
        };
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(storagePath);
            } else {
                let msg = `Error ${xhr.status}`;
                try {
                    const body = JSON.parse(xhr.responseText);
                    if (body?.message) msg = body.message;
                } catch (e) { /* body no JSON */ }
                reject(new Error(msg));
            }
        };
        xhr.onerror = () => reject(new Error('Error de red al subir el archivo'));
        xhr.send(file);
    });

    return resultado;
}

async function getTenantCanonico() {
    try {
        const supabase = getSupabase();
        if (supabase) {
            const { data } = await supabase.rpc('get_user_tenant_id');
            if (data) return data;
        }
    } catch (e) { /* fallback abajo */ }
    // Fallback: JWT (misma estrategia que ConfigEditor)
    const { getCurrentTenantId } = await import('../shared/infrastructure/router.js');
    const tid = await getCurrentTenantId();
    if (tid) return tid;
    return 'public';
}
