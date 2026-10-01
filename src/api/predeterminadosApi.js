// src/api/predeterminadosApi.js
// "PREDETERMINADOS" del tablero del cliente (Mis Clientes → Información).
//
// Para qué: la información que se le pide a TODOS los clientes (anamnesis,
// sesión base de ejercicios, datos importantes del alumno…). El negocio la
// arma UNA vez en un tablero, la guarda como predeterminada, y la web la pone
// sola en el tablero de cada cliente —nuevo o existente— en blanco, lista
// para rellenar. Si a alguien no le sirve, la borra de SU tablero y no afecta
// al resto.
//
// Estructura guardada (jsonb):
//   { listas: [ { titulo, compartida, tarjetas: [ { titulo, descripcion,
//                checklist: ["pregunta 1", ...] } ] } ] }
//
// Todo idempotente: aplicar dos veces NO duplica (se saltea por título).
import { getSupabase } from '../shared/infrastructure/supabase.js';
import { createList, createCard, createChecklist, addChecklistItem, getOrCreateBoard } from './kanbanApi.js';

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Predeterminados del negocio (o null si todavía no guardó ninguno). */
export async function getPredeterminados(tenantId) {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from('kanban_predeterminados')
        .select('*')
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (error) { console.warn('[predeterminados] no se pudieron leer:', error.message); return null; }
    return data || null;
}

/** Arma la estructura desde un tablero real (listas + tarjetas + checklists). */
export async function snapshotBoard(boardId) {
    const supabase = getSupabase();
    const { data: listas } = await supabase
        .from('kanban_lists').select('id, titulo, posicion, compartida')
        .eq('board_id', boardId).order('posicion', { ascending: true });
    const listIds = (listas || []).map(l => l.id);
    const { data: tarjetas } = listIds.length
        ? await supabase.from('kanban_cards').select('id, list_id, titulo, descripcion, posicion').in('list_id', listIds).order('posicion', { ascending: true })
        : { data: [] };
    const cardIds = (tarjetas || []).map(c => c.id);
    const { data: checklists } = cardIds.length
        ? await supabase.from('kanban_checklists').select('id, card_id, titulo, posicion').in('card_id', cardIds).order('posicion', { ascending: true })
        : { data: [] };
    const chkIds = (checklists || []).map(k => k.id);
    const { data: items } = chkIds.length
        ? await supabase.from('kanban_checklist_items').select('id, checklist_id, texto, posicion').in('checklist_id', chkIds).order('posicion', { ascending: true })
        : { data: [] };

    return {
        listas: (listas || []).map(l => ({
            titulo: l.titulo,
            compartida: l.compartida === true,
            tarjetas: (tarjetas || [])
                .filter(t => t.list_id === l.id)
                .map(t => ({
                    titulo: t.titulo,
                    descripcion: t.descripcion || '',
                    checklist: (checklists || [])
                        .filter(k => k.card_id === t.id)
                        .flatMap(k => (items || []).filter(i => i.checklist_id === k.id).map(i => i.texto))
                }))
        }))
    };
}

/** Guarda (o reemplaza) los predeterminados del negocio con lo que hay en el tablero. */
export async function guardarDesdeBoard(tenantId, boardId, nombre) {
    const supabase = getSupabase();
    const contenido = await snapshotBoard(boardId);
    const existente = await getPredeterminados(tenantId);
    const fila = {
        tenant_id: tenantId,
        nombre: (nombre || 'Predeterminados').slice(0, 80),
        contenido
    };
    if (existente) {
        const { error } = await supabase.from('kanban_predeterminados').update(fila).eq('id', existente.id);
        if (error) throw error;
    } else {
        const { error } = await supabase.from('kanban_predeterminados').insert(fila);
        if (error) throw error;
    }
    return contenido;
}

export async function borrarPredeterminados(tenantId) {
    const supabase = getSupabase();
    const { error } = await supabase.from('kanban_predeterminados').delete().eq('tenant_id', tenantId);
    if (error) throw error;
    return true;
}

export async function setAutoAplicar(tenantId, valor) {
    const supabase = getSupabase();
    const { error } = await supabase
        .from('kanban_predeterminados')
        .update({ auto_aplicar: valor === true })
        .eq('tenant_id', tenantId);
    if (error) throw error;
    return valor === true;
}

/**
 * Aplica los predeterminados a UN tablero. Idempotente: no duplica listas ni
 * tarjetas con el mismo título.
 * @returns {Promise<{listas_creadas:number, listas_omitidas:number, tarjetas_creadas:number, items_creados:number}>}
 */
export async function aplicarABoard(boardId, contenido) {
    const supabase = getSupabase();
    const listas = (contenido && Array.isArray(contenido.listas)) ? contenido.listas : [];
    const res = { listas_creadas: 0, listas_omitidas: 0, tarjetas_creadas: 0, items_creados: 0 };
    if (!listas.length) return res;

    const { data: existentes } = await supabase
        .from('kanban_lists').select('id, titulo').eq('board_id', boardId);
    const porTitulo = new Map((existentes || []).map(l => [norm(l.titulo), l.id]));
    let pos = (existentes || []).length;

    for (const l of listas) {
        const clave = norm(l.titulo);
        let listId = porTitulo.get(clave);
        if (listId) {
            res.listas_omitidas++;
        } else {
            const nueva = await createList(boardId, l.titulo, pos++);
            listId = nueva.id;
            porTitulo.set(clave, listId);
            res.listas_creadas++;
        }

        const { data: cardsEx } = await supabase
            .from('kanban_cards').select('id, titulo').eq('list_id', listId);
        const yaTarjetas = new Set((cardsEx || []).map(c => norm(c.titulo)));
        let cpos = (cardsEx || []).length;

        for (const t of (l.tarjetas || [])) {
            if (yaTarjetas.has(norm(t.titulo))) continue;
            const card = await createCard(listId, {
                titulo: t.titulo,
                descripcion: t.descripcion || '',
                posicion: cpos++
            });
            res.tarjetas_creadas++;
            const items = Array.isArray(t.checklist) ? t.checklist : [];
            if (items.length) {
                const chk = await createChecklist(card.id, 'Checklist', 0);
                let i = 0;
                for (const texto of items) {
                    await addChecklistItem(chk.id, card.id, texto, i++);
                    res.items_creados++;
                }
            }
        }
    }
    return res;
}

/**
 * Aplica los predeterminados a TODOS los tableros del negocio (los que ya
 * existen y los que se crean al vuelo para clientes sin tablero).
 * @param {string} tenantId
 * @param {Function} [onProgreso] (hechos, total, nombreCliente)
 */
export async function aplicarATodos(tenantId, onProgreso) {
    const supabase = getSupabase();
    const pre = await getPredeterminados(tenantId);
    if (!pre || !pre.contenido || !Array.isArray(pre.contenido.listas) || !pre.contenido.listas.length) {
        return { ok: false, error: 'sin_predeterminados' };
    }

    const { data: boards, error } = await supabase
        .from('kanban_boards').select('id, cliente_email, cliente_nombre').eq('tenant_id', tenantId);
    if (error) throw error;

    const total = (boards || []).length;
    const acum = { tableros: 0, listas_creadas: 0, tarjetas_creadas: 0, items_creados: 0, listas_omitidas: 0 };
    let hechos = 0;
    for (const b of (boards || [])) {
        try {
            const r = await aplicarABoard(b.id, pre.contenido);
            acum.tableros++;
            acum.listas_creadas += r.listas_creadas;
            acum.tarjetas_creadas += r.tarjetas_creadas;
            acum.items_creados += r.items_creados;
            acum.listas_omitidas += r.listas_omitidas;
        } catch (e) {
            console.warn('[predeterminados] no se pudo aplicar a', b.cliente_email, e);
        }
        hechos++;
        if (typeof onProgreso === 'function') onProgreso(hechos, total, b.cliente_nombre || b.cliente_email);
    }

    await supabase.from('kanban_predeterminados')
        .update({ aplicado_en: new Date().toISOString(), aplicado_a: acum.tableros })
        .eq('tenant_id', tenantId);

    return { ok: true, ...acum };
}

/**
 * Aplica los predeterminados a TODOS los clientes del negocio, creando el
 * tablero de quien todavía no lo tenga. Es lo que hace el botón
 * "Ponerlos a TODOS mis clientes".
 * @param {string} tenantId
 * @param {Array<{email:string, nombre:string}>} clientes
 * @param {Function} [onProgreso] (hechos, total, nombreCliente)
 */
export async function aplicarAClientes(tenantId, clientes, onProgreso) {
    const listas = Array.isArray(clientes) ? clientes.filter(c => c && c.email) : [];
    const pre = await getPredeterminados(tenantId);
    if (!pre || !pre.contenido || !Array.isArray(pre.contenido.listas) || !pre.contenido.listas.length) {
        return { ok: false, error: 'sin_predeterminados' };
    }

    // 1) Tableros existentes (por si algún cliente no viene en la lista de la vista)
    const acum = { tableros: 0, listas_creadas: 0, tarjetas_creadas: 0, items_creados: 0, listas_omitidas: 0 };
    const vistos = new Set();
    const total = listas.length;

    for (let i = 0; i < listas.length; i++) {
        const c = listas[i];
        const email = String(c.email || '').trim().toLowerCase();
        if (!email || vistos.has(email)) continue;
        vistos.add(email);
        try {
            const b = await getOrCreateBoard(tenantId, email, c.nombre || '');
            const r = await aplicarABoard(b.id, pre.contenido);
            acum.tableros++;
            acum.listas_creadas += r.listas_creadas;
            acum.tarjetas_creadas += r.tarjetas_creadas;
            acum.items_creados += r.items_creados;
            acum.listas_omitidas += r.listas_omitidas;
        } catch (e) {
            console.warn('[predeterminados] no se pudo aplicar a', email, e);
        }
        if (typeof onProgreso === 'function') onProgreso(i + 1, total, c.nombre || email);
    }

    await getSupabase().from('kanban_predeterminados')
        .update({ aplicado_en: new Date().toISOString(), aplicado_a: acum.tableros })
        .eq('tenant_id', tenantId);

    return { ok: true, ...acum };
}

/**
 * Auto-aplicado: se llama al crear un tablero nuevo. Solo actúa si el negocio
 * tiene predeterminados con auto_aplicar = true y el tablero está vacío.
 */
export async function aplicarAutomatico(tenantId, boardId) {
    try {
        const pre = await getPredeterminados(tenantId);
        if (!pre || pre.auto_aplicar !== true) return { ok: false, motivo: 'sin_auto' };
        const listas = (pre.contenido && pre.contenido.listas) || [];
        if (!listas.length) return { ok: false, motivo: 'vacio' };

        const supabase = getSupabase();
        const { data: existentes } = await supabase
            .from('kanban_lists').select('id').eq('board_id', boardId).limit(1);
        if (existentes && existentes.length) return { ok: false, motivo: 'ya_tiene_listas' };

        const r = await aplicarABoard(boardId, pre.contenido);
        return { ok: true, ...r };
    } catch (e) {
        console.warn('[predeterminados] auto-aplicar falló:', e);
        return { ok: false, motivo: 'error' };
    }
}
