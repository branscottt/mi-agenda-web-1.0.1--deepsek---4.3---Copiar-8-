// clients/ui/ClientBoard.js
// "Información del cliente": tablero estilo Trello por cliente.
// - Modal full-screen con listas (columnas) y tarjetas.
// - Drag & Drop nativo HTML5 (sin dependencias; CSP no permite
//   scripts externos sin hash). En móvil (sin DnD táctil) la
//   tarjeta se mueve desde su modal (selector "Lista").
// - Modal de tarjeta: título, descripción, etiqueta de pago
//   (Pagado/Abonado/Se pagó algo/No pagado — excluyentes),
//   vínculo a cita programada (sincroniza citas.estado_pago),
//   múltiples checklists con nombre (estilo Trello) y documentos
//   adjuntos (upload, preview en pantalla + descarga).
import * as kanbanApi from '../../api/kanbanApi.js';
import { updateCita } from '../../api/appointmentsApi.js';
import { getCurrentTenantId } from '../../shared/infrastructure/router.js';
import { getSupabase } from '../../shared/infrastructure/supabase.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { formatFechaCorta, formatTimeDisplay } from '../../shared/infrastructure/formatters.js';
import { renderChipEtiqueta } from '../../shared/ui/etiquetasPago.js';

// ========== DEPENDENCIAS INYECTABLES ==========
// Por defecto usa la capa de datos admin (kanbanApi + updateCita +
// router). El portal del trabajador inyecta una capa worker-scoped
// (RPCs SECURITY DEFINER) vía configurarClientBoard() — así se
// reutiliza EXACTAMENTE este tablero en ambas vistas sin duplicarlo.
let deps = {
    kanbanApi,
    updateCita,
    getCurrentTenantId,
    adjuntosSoloLectura: false,  // true = portal del trabajador (bucket privado)
    onEditarContacto: null,      // callback opcional → botón "Editar contacto"
    onCerrarBoard: null          // callback opcional al cerrar el modal
};

export function configurarClientBoard(opts) {
    if (!opts) return;
    if (opts.kanbanApi) deps.kanbanApi = opts.kanbanApi;
    if (opts.updateCita) deps.updateCita = opts.updateCita;
    if (opts.getCurrentTenantId) deps.getCurrentTenantId = opts.getCurrentTenantId;
    if (typeof opts.adjuntosSoloLectura === 'boolean') deps.adjuntosSoloLectura = opts.adjuntosSoloLectura;
    if (typeof opts.onEditarContacto === 'function') deps.onEditarContacto = opts.onEditarContacto;
    if (typeof opts.onCerrarBoard === 'function') deps.onCerrarBoard = opts.onCerrarBoard;
}

// ========== CONSTANTES ==========

const ACCEPT_ADJUNTOS = [
    'image/*',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/rtf',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.presentation',
    'text/plain', 'text/csv', 'text/markdown', 'application/json',
    'application/zip',
    'video/*', 'audio/*'
].join(',');

const MAX_ADJUNTO_BYTES = 100 * 1024 * 1024; // 100 MB (mismo límite del bucket)

const ICONOS_MIME = {
    pdf: 'fa-file-pdf',
    word: 'fa-file-word',
    excel: 'fa-file-excel',
    power: 'fa-file-powerpoint',
    image: 'fa-file-image',
    video: 'fa-file-video',
    audio: 'fa-file-audio',
    text: 'fa-file-alt',
    zip: 'fa-file-archive',
    default: 'fa-file'
};

// ========== ESTADO ==========

let board = null;          // board actual
let lists = [];            // [{ id, titulo, posicion, cards: [...] }]
let citasCliente = [];     // [{ id, fecha, hora, servicio, precio }]
let clienteActual = null;
let clientesDelTenant = []; // [{ nombre, email, ... }] para aplicar estilos a todos
let cardModalAbierto = false;
let cardModalCard = null;  // card cuyo modal está abierto (para refrescar badges al cerrar)
let dragCardId = null;

// ========== APERTURA ==========

/**
 * Abre el modal full-screen de información del cliente.
 * @param {object} cliente  { nombre, email, telefono, ... } (shape de ClientListView)
 * @param {Array}  citas    citas del cliente enriquecidas con nombre de servicio
 * @param {Array}  clientes lista de clientes del tenant (para aplicar estilos a todos)
 */
export async function abrirInformacionCliente(cliente, citas, clientes) {
    if (!cliente || !cliente.email) {
        mostrarToast('El cliente no tiene email para abrir su información', 'warning');
        return;
    }
    const tenantId = await deps.getCurrentTenantId();
    if (!tenantId) {
        mostrarToast('No se pudo identificar el negocio', 'error');
        return;
    }

    clienteActual = cliente;
    citasCliente = Array.isArray(citas) ? citas : [];
    clientesDelTenant = Array.isArray(clientes) ? clientes : [];
    board = await deps.kanbanApi.getOrCreateBoard(tenantId, cliente.email, cliente.nombre || '');
    const datos = await deps.kanbanApi.getBoardData(board.id);
    lists = datos.lists || [];

    renderBoardModal();
}

// ========== RENDER BOARD ==========

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderBoardModal() {
    cerrarCardModal();
    const existente = document.getElementById('kanban-modal');
    if (existente) existente.remove();

    const overlay = document.createElement('div');
    overlay.id = 'kanban-modal';
    overlay.className = 'kanban-modal-overlay';
    overlay.innerHTML = `
        <div class="kanban-modal">
            <header class="kanban-modal-header">
                <div class="kanban-cliente-avatar"><i class="fas fa-user"></i></div>
                <div class="kanban-cliente-info">
                    <h3><i class="fas fa-id-card"></i> Información de ${escapeHtml(clienteActual.nombre || 'Cliente')}</h3>
                    <span class="kanban-cliente-meta">
                        ${escapeHtml(clienteActual.email || '')}
                        ${clienteActual.telefono ? ` · <i class="fas fa-phone"></i> ${escapeHtml(clienteActual.telefono)}` : ''}
                        ${clienteActual.direccion ? `<br><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(clienteActual.direccion)}" target="_blank" rel="noopener noreferrer" style="color:inherit;" title="Ver dirección en Google Maps / Cómo llegar"><i class="fas fa-map-marker-alt"></i> ${escapeHtml(clienteActual.direccion)}</a>` : ''}
                    </span>
                    ${clienteActual.estadoPago ? `<div style="margin-top:4px;">${renderChipEtiqueta(clienteActual.estadoPago)}</div>` : ''}
                </div>
                <div class="kanban-estilos-actions">
                    ${deps.onEditarContacto ? `
                    <button class="kanban-estilos-btn" id="kanban-editar-contacto" title="Editar nombre, teléfono o email del cliente">
                        <i class="fas fa-address-book"></i><span class="kanban-estilos-txt"> Editar contacto</span>
                    </button>` : ''}
                    <button class="kanban-estilos-btn" id="kanban-guardar-estilo" title="Guardar estas listas como estilo reutilizable en otros clientes">
                        <i class="fas fa-save"></i><span class="kanban-estilos-txt"> Guardar estilo</span>
                    </button>
                    <button class="kanban-estilos-btn" id="kanban-usar-estilo" title="Aplicar un estilo de listas guardado">
                        <i class="fas fa-layer-group"></i><span class="kanban-estilos-txt"> Usar estilo</span>
                    </button>
                    ${!deps.adjuntosSoloLectura ? `
                    <button class="kanban-estilos-btn" id="kanban-eliminar-cliente" style="color:#ff6b6b;" title="Eliminar este cliente de Mis Clientes: borra sus citas, historial de ventas y tablero (no se puede deshacer)">
                        <i class="fas fa-trash"></i><span class="kanban-estilos-txt"> Eliminar cliente</span>
                    </button>` : ''}
                </div>
                <button class="kanban-btn-close" id="kanban-cerrar" title="Cerrar"><i class="fas fa-times"></i></button>
            </header>
            <div class="kanban-board" id="kanban-board">
                ${renderListasHtml()}
                <div class="kanban-add-list" id="kanban-add-list">
                    <i class="fas fa-plus"></i> Añadir lista
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('kanban-cerrar').addEventListener('click', cerrarModal);
    overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) cerrarModal();
    });
    document.addEventListener('keydown', kanbanEscHandler);

    bindAddLista();
    bindListas();
    bindDnD();
    bindEstilos();
    bindEliminarCliente();
    const editarContactoBtn = document.getElementById('kanban-editar-contacto');
    if (editarContactoBtn && deps.onEditarContacto) editarContactoBtn.addEventListener('click', deps.onEditarContacto);
}

// ========== ELIMINAR CLIENTE (solo admin) ==========

/**
 * "Eliminar cliente" (botón rojo del header, solo visible en la vista
 * admin): borra TODO el rastro del cliente del tenant vía el RPC
 * admin_eliminar_cliente (citas + ventas archivadas + tablero kanban).
 * Doble confirmación: es una acción destructiva e irreversible.
 */
function bindEliminarCliente() {
    const btn = document.getElementById('kanban-eliminar-cliente');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        if (!clienteActual || !clienteActual.email) return;
        const nombre = clienteActual.nombre || 'Este cliente';
        const nCitas = (citasCliente || []).length;
        if (!window.confirm(
            `¿Eliminar a "${nombre}" de Mis Clientes?\n\n` +
            `Se borrarán ${nCitas} cita(s), su historial de ventas y su tablero (listas, tarjetas, archivos). ` +
            'Esta acción no se puede deshacer.'
        )) return;
        if (!window.confirm(`Última confirmación: ¿ELIMINAR DEFINITIVAMENTE a "${nombre}"?`)) return;

        try {
            const tenantId = await deps.getCurrentTenantId();
            const { data, error } = await getSupabase().rpc('admin_eliminar_cliente', {
                p_tenant_id: tenantId,
                p_cliente_email: clienteActual.email
            });
            if (error || !data || data.ok !== true) {
                mostrarToast((data && data.error) || 'No se pudo eliminar el cliente', 'error');
                return;
            }
            const email = clienteActual.email;
            cerrarModal();
            // Refresca la lista de Mis Clientes (expuesta por main.js en admin).
            if (typeof window.renderClientListView === 'function') {
                try { window.renderClientListView(); } catch (e) { console.warn('[ClientBoard] Error refrescando Mis Clientes:', e); }
            }
            mostrarToast(
                `Cliente "${email}" eliminado (${data.citas_eliminadas || 0} cita(s), ${data.ventas_eliminadas || 0} venta(s), ${data.tableros_eliminados || 0} tablero(s))`,
                'success'
            );
        } catch (err) {
            console.error('[ClientBoard] Error eliminando cliente:', err);
            mostrarToast('No se pudo eliminar el cliente', 'error');
        }
    });
}

// ========== ESTILOS DE LISTAS (plantillas reutilizables) ==========

function bindEstilos() {
    const guardarBtn = document.getElementById('kanban-guardar-estilo');
    const usarBtn = document.getElementById('kanban-usar-estilo');
    if (guardarBtn) guardarBtn.addEventListener('click', abrirModalGuardarEstilo);
    if (usarBtn) usarBtn.addEventListener('click', abrirPanelUsarEstilo);
}

/** Modal chico para ponerle nombre al estilo antes de guardarlo. */
async function abrirModalGuardarEstilo() {
    if (!lists.length) {
        mostrarToast('No hay listas para guardar. Creá algunas primero.', 'warning');
        return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'kanban-card-overlay';
    overlay.innerHTML = `
        <div class="kanban-estilos-modal">
            <header class="kanban-card-modal-header">
                <h4><i class="fas fa-save"></i> Guardar estilo de listas</h4>
                <button class="kanban-btn-close" id="kestilo-cerrar"><i class="fas fa-times"></i></button>
            </header>
            <div class="kanban-card-form">
                <p class="kanban-hint">Guardá la estructura de estas <strong>${lists.length} lista${lists.length !== 1 ? 's' : ''}</strong> como plantilla para reutilizarla en otros clientes con un clic.</p>
                <label class="kanban-seccion-label"><i class="fas fa-heading"></i> Nombre del estilo</label>
                <input type="text" id="kestilo-nombre" placeholder="Ej: Ficha de nuevo cliente, Seguimiento de pagos..." maxlength="80" autofocus>
                <div class="kanban-card-actions">
                    <button class="btn-secondary" id="kestilo-cancelar">Cancelar</button>
                    <button class="btn-primary" id="kestilo-guardar"><i class="fas fa-save"></i> Guardar estilo</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    const cerrar = () => overlay.remove();
    document.getElementById('kestilo-cerrar').addEventListener('click', cerrar);
    document.getElementById('kestilo-cancelar').addEventListener('click', cerrar);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) cerrar(); });

    const input = document.getElementById('kestilo-nombre');
    const confirmar = async () => {
        const nombre = input.value.trim();
        if (!nombre) { mostrarToast('Poné un nombre al estilo', 'warning'); return; }
        try {
            const tenantId = await deps.getCurrentTenantId();
            const listasPlantilla = lists.map(l => ({
                titulo: l.titulo,
                posicion: l.posicion,
                tarjetas: (l.cards || []).map(c => ({ titulo: c.titulo, descripcion: c.descripcion || '' }))
            }));
            await deps.kanbanApi.saveEstilo(tenantId, nombre, listasPlantilla);
            overlay.remove();
            mostrarToast(`Estilo "${nombre}" guardado`, 'success');
        } catch (err) {
            console.error('[ClientBoard] Error guardando estilo:', err);
            mostrarToast('No se pudo guardar el estilo', 'error');
        }
    };
    document.getElementById('kestilo-guardar').addEventListener('click', confirmar);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmar(); });
    input.focus();
}

/** Panel con los estilos guardados del tenant para aplicar a este cliente y/o a todos. */
async function abrirPanelUsarEstilo() {
    const tenantId = await deps.getCurrentTenantId();
    let estilos = [];
    try {
        estilos = await deps.kanbanApi.listEstilos(tenantId);
    } catch (err) {
        console.error('[ClientBoard] Error listando estilos:', err);
        mostrarToast('No se pudieron cargar los estilos', 'error');
        return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'kanban-card-overlay';
    overlay.innerHTML = `
        <div class="kanban-estilos-modal kanban-estilos-modal-lg">
            <header class="kanban-card-modal-header">
                <h4><i class="fas fa-layer-group"></i> Usar estilo de listas</h4>
                <button class="kanban-btn-close" id="kestilo-usar-cerrar"><i class="fas fa-times"></i></button>
            </header>
            <div class="kanban-card-form">
                ${estilos.length === 0 ? `
                    <div class="kanban-estilos-vacio">
                        <i class="fas fa-layer-group"></i>
                        <h4>Todavía no hay estilos guardados</h4>
                        <p>En cualquier cliente podés armar las listas y tocar <strong>"Guardar estilo"</strong> arriba para reutilizarlas después en otros clientes con un clic.</p>
                    </div>
                ` : `
                    <p class="kanban-hint">Elegí un estilo guardado para aplicarlo a <strong>${escapeHtml(clienteActual.nombre || 'este cliente')}</strong>${clientesDelTenant.length ? ' y/o a todos tus clientes' : ''}.</p>
                    <div class="kanban-estilos-lista">
                        ${estilos.map(est => {
                            const nListas = (est.listas || []).length;
                            const nTarjetas = (est.listas || []).reduce((acc, l) => acc + (l.tarjetas || []).length, 0);
                            const fecha = new Date(est.created_at).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
                            return `
                                <div class="kanban-estilo-item" data-estilo-id="${est.id}">
                                    <div class="kanban-estilo-info">
                                        <strong>${escapeHtml(est.nombre)}</strong>
                                        <span>${nListas} lista${nListas !== 1 ? 's' : ''} · ${nTarjetas} tarjeta${nTarjetas !== 1 ? 's' : ''} de ejemplo · guardado el ${fecha}</span>
                                    </div>
                                    <div class="kanban-estilo-acciones">
                                        <button class="btn-small kanban-estilo-aplicar" data-estilo-id="${est.id}" title="Aplicar a este cliente"><i class="fas fa-arrow-right"></i> Aplicar</button>
                                        ${clientesDelTenant.length > 1 ? `<button class="btn-small kanban-estilo-todos" data-estilo-id="${est.id}" title="Aplicar a este cliente y a todos los demás"><i class="fas fa-users"></i> A todos</button>` : ''}
                                        <button class="btn-small kanban-estilo-del" data-estilo-id="${est.id}" title="Eliminar estilo"><i class="fas fa-trash"></i></button>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                `}
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    const cerrar = () => overlay.remove();
    document.getElementById('kestilo-usar-cerrar').addEventListener('click', cerrar);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) cerrar(); });

    if (estilos.length) {
        overlay.querySelectorAll('.kanban-estilo-aplicar').forEach(btn => {
            btn.addEventListener('click', async () => {
                const est = estilos.find(x => x.id === btn.dataset.estiloId);
                if (!est) return;
                overlay.remove();
                await aplicarEstilo(est, false);
            });
        });
        overlay.querySelectorAll('.kanban-estilo-todos').forEach(btn => {
            btn.addEventListener('click', async () => {
                const est = estilos.find(x => x.id === btn.dataset.estiloId);
                if (!est) return;
                const otros = clientesDelTenant.filter(c => c.email !== clienteActual.email).length;
                if (!window.confirm(`¿Aplicar el estilo "${est.nombre}" a este cliente y a los otros ${otros} cliente${otros !== 1 ? 's' : ''}? Solo se aplicará a clientes que todavía no tienen listas.`)) return;
                overlay.remove();
                await aplicarEstilo(est, true);
            });
        });
        overlay.querySelectorAll('.kanban-estilo-del').forEach(btn => {
            btn.addEventListener('click', async () => {
                const est = estilos.find(x => x.id === btn.dataset.estiloId);
                if (!est) return;
                if (!window.confirm(`¿Eliminar el estilo "${est.nombre}"?`)) return;
                try {
                    await deps.kanbanApi.deleteEstilo(est.id);
                    mostrarToast('Estilo eliminado', 'success');
                    overlay.remove();
                    abrirPanelUsarEstilo();
                } catch (err) {
                    console.error('[ClientBoard] Error eliminando estilo:', err);
                    mostrarToast('No se pudo eliminar el estilo', 'error');
                }
            });
        });
    }
}

/** Crea las listas (y tarjetas de ejemplo) de la plantilla en el board. */
async function crearListasDePlantilla(boardId, listasPlantilla) {
    const creadas = [];
    for (const l of (listasPlantilla || [])) {
        const nueva = await deps.kanbanApi.createList(boardId, l.titulo, l.posicion);
        const tarjetas = l.tarjetas || [];
        for (let i = 0; i < tarjetas.length; i++) {
            await deps.kanbanApi.createCard(nueva.id, { titulo: tarjetas[i].titulo, descripcion: tarjetas[i].descripcion || '', posicion: i });
        }
        creadas.push(nueva);
    }
    return creadas;
}

async function aplicarEstilo(estilo, aTodos) {
    const tenantId = await deps.getCurrentTenantId();
    try {
        let aplicados = 0;
        // 1. Cliente actual
        const actuales = await deps.kanbanApi.getBoardData(board.id);
        if (!actuales.lists.length) {
            await crearListasDePlantilla(board.id, estilo.listas);
            aplicados++;
        } else {
            mostrarToast('Este cliente ya tiene listas — no se aplicó para no duplicar', 'warning');
        }

        // 2. (Opcional) Todos los demás clientes sin listas todavía
        if (aTodos && tenantId) {
            for (const cl of clientesDelTenant) {
                if (!cl.email || cl.email === clienteActual.email) continue;
                try {
                    const b = await deps.kanbanApi.getOrCreateBoard(tenantId, cl.email, cl.nombre || '');
                    const datos = await deps.kanbanApi.getBoardData(b.id);
                    if (datos.lists.length) continue; // no tocar clientes ya trabajados
                    await crearListasDePlantilla(b.id, estilo.listas);
                    aplicados++;
                } catch (e) {
                    console.warn('[ClientBoard] No se pudo aplicar a', cl.email, e);
                }
            }
        }

        // Recargar board actual
        const datos = await deps.kanbanApi.getBoardData(board.id);
        lists = datos.lists || [];
        renderBoardModal();
        mostrarToast(aTodos
            ? `Estilo "${estilo.nombre}" aplicado a ${aplicados} cliente${aplicados !== 1 ? 's' : ''}`
            : `Estilo "${estilo.nombre}" aplicado`, 'success');
    } catch (err) {
        console.error('[ClientBoard] Error aplicando estilo:', err);
        mostrarToast('No se pudo aplicar el estilo', 'error');
    }
}

function renderListasHtml() {
    if (!lists.length) {
        return `
            <div class="kanban-empty">
                <i class="fas fa-folder-open"></i>
                <h4>Sin secciones todavía</h4>
                <p>Organizá la información de este cliente creando listas (ej: "Pendientes", "Pagos", "Documentos") y tarjetas dentro de ellas.</p>
            </div>
        `;
    }
    return lists.map(lista => {
        const cardsHtml = lista.cards.map(card => renderCardHtml(card)).join('');
        return `
            <div class="kanban-list" data-list-id="${lista.id}">
                <div class="kanban-list-header">
                    <span class="kanban-list-titulo" title="Clic para editar el nombre">${escapeHtml(lista.titulo)}</span>
                    <span class="kanban-list-count" title="Tarjetas">${lista.cards.length}</span>
                    <button class="kanban-list-del" data-list-id="${lista.id}" title="Eliminar lista"><i class="fas fa-trash"></i></button>
                </div>
                <div class="kanban-list-cards" data-list-id="${lista.id}">
                    ${cardsHtml}
                    <div class="kanban-add-card" data-list-id="${lista.id}">
                        <i class="fas fa-plus"></i> Añadir tarjeta
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function renderCardHtml(card) {
    let badges = '';
    const totalCheck = (card.checklists || []).reduce((acc, ch) => acc + (ch.items || []).length, 0);
    const hechosCheck = (card.checklists || []).reduce((acc, ch) => acc + (ch.items || []).filter(i => i.completado).length, 0);
    if (totalCheck > 0) {
        badges += `<span class="kanban-card-badge" title="Checklists"><i class="fas fa-tasks"></i> ${hechosCheck}/${totalCheck}</span>`;
    }
    if (card.adjuntos && card.adjuntos.length) {
        badges += `<span class="kanban-card-badge" title="Documentos adjuntos"><i class="fas fa-paperclip"></i> ${card.adjuntos.length}</span>`;
    }
    if (card.cita_id) {
        badges += `<span class="kanban-card-badge" title="Vinculada a cita programada"><i class="fas fa-calendar-alt"></i></span>`;
    }

    return `
        <div class="kanban-card ${card.completado ? 'done' : ''}" draggable="true" data-card-id="${card.id}">
            <button type="button" class="kanban-card-check ${card.completado ? 'checked' : ''}"
                    data-card-id="${card.id}" title="${card.completado ? 'Marcar como pendiente' : 'Marcar como hecha'}">
                <i class="fas fa-check"></i>
            </button>
            <div class="kanban-card-body">
                <div class="kanban-card-titulo">${escapeHtml(card.titulo)}</div>
                ${badges ? `<div class="kanban-card-badges">${badges}</div>` : ''}
            </div>
        </div>
    `;
}

// ========== CIERRE ==========

function kanbanEscHandler(e) {
    if (e.key === 'Escape') {
        if (cardModalAbierto) {
            if (cardModalCard) actualizarCardEnBoard(cardModalCard);
            cerrarCardModal();
        } else {
            cerrarModal();
        }
    }
}

function cerrarModal() {
    document.removeEventListener('keydown', kanbanEscHandler);
    const overlay = document.getElementById('kanban-modal');
    if (overlay) overlay.remove();
    board = null;
    lists = [];
    clienteActual = null;
    citasCliente = [];
    if (deps.onCerrarBoard) deps.onCerrarBoard();
}

function cerrarCardModal() {
    cardModalAbierto = false;
    cardModalCard = null;
    const overlay = document.getElementById('kanban-card-overlay');
    if (overlay) overlay.remove();
}

/**
 * Refresca el HTML de la card en el board (chips, badges de
 * checklist/adjuntos/cita) tras editar su modal, sin re-renderizar
 * todo el board (conserva el scroll).
 */
function actualizarCardEnBoard(card) {
    if (!card) return;
    const cardEl = document.querySelector(`.kanban-card[data-card-id="${card.id}"]`);
    if (!cardEl) return;
    const nuevoHtml = document.createElement('div');
    nuevoHtml.innerHTML = renderCardHtml(card).trim();
    const nuevo = nuevoHtml.firstElementChild;
    if (!nuevo) return;
    cardEl.replaceWith(nuevo);
    nuevo.addEventListener('click', () => abrirCardModal(card.id));
    bindCheckTarjeta(nuevo);
}

// ========== LISTAS: crear / editar / eliminar ==========

function bindAddLista() {
    const addBtn = document.getElementById('kanban-add-list');
    if (!addBtn) return;
    addBtn.addEventListener('click', () => {
        addBtn.innerHTML = `
            <input type="text" id="kanban-nueva-lista-input" placeholder="Nombre de la lista..." maxlength="60" autofocus>
            <div class="kanban-inline-actions">
                <button class="btn-primary btn-small" id="kanban-lista-ok"><i class="fas fa-check"></i></button>
                <button class="btn-secondary btn-small" id="kanban-lista-cancel"><i class="fas fa-times"></i></button>
            </div>
        `;
        const input = document.getElementById('kanban-nueva-lista-input');
        const ok = document.getElementById('kanban-lista-ok');
        const cancel = document.getElementById('kanban-lista-cancel');

        const confirmar = async () => {
            const titulo = input.value.trim();
            if (!titulo) return;
            try {
                const nueva = await deps.kanbanApi.createList(board.id, titulo, lists.length);
                lists.push({ ...nueva, cards: [] });
                renderBoardModal();
            } catch (e) {
                console.error('[ClientBoard] Error creando lista:', e);
                mostrarToast('No se pudo crear la lista', 'error');
            }
        };
        ok.addEventListener('click', confirmar);
        cancel.addEventListener('click', renderBoardModal);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') confirmar();
            if (e.key === 'Escape') renderBoardModal();
        });
        input.focus();
    });
}

function bindListas() {
    // Editar título (click en el nombre)
    document.querySelectorAll('.kanban-list-titulo').forEach(el => {
        el.addEventListener('click', async () => {
            const listaId = el.closest('.kanban-list').dataset.listId;
            const lista = lists.find(l => l.id === listaId);
            if (!lista) return;
            const input = document.createElement('input');
            input.type = 'text';
            input.value = lista.titulo;
            input.maxLength = 60;
            input.className = 'kanban-list-titulo-input';
            el.replaceWith(input);
            input.focus();
            input.select();

            const guardar = async () => {
                const titulo = input.value.trim();
                if (!titulo) return;
                try {
                    const actualizada = await deps.kanbanApi.updateList(listaId, { titulo });
                    lista.titulo = actualizada.titulo;
                } catch (e) {
                    console.error('[ClientBoard] Error renombrando lista:', e);
                    mostrarToast('No se pudo renombrar la lista', 'error');
                }
                renderBoardModal();
            };
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') guardar();
                if (e.key === 'Escape') renderBoardModal();
            });
            input.addEventListener('blur', guardar);
        });
    });

    // Eliminar lista (con confirmación)
    document.querySelectorAll('.kanban-list-del').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const listaId = btn.dataset.listId;
            const lista = lists.find(l => l.id === listaId);
            if (!lista) return;
            const nCards = lista.cards.length;
            const msg = nCards
                ? `¿Eliminar la lista "${lista.titulo}" y sus ${nCards} tarjeta${nCards !== 1 ? 's' : ''}?`
                : `¿Eliminar la lista "${lista.titulo}"?`;
            if (!window.confirm(msg)) return;
            try {
                await deps.kanbanApi.deleteList(listaId);
                lists = lists.filter(l => l.id !== listaId);
                renderBoardModal();
                mostrarToast('Lista eliminada', 'success');
            } catch (err) {
                console.error('[ClientBoard] Error eliminando lista:', err);
                mostrarToast('No se pudo eliminar la lista', 'error');
            }
        });
    });

    // Añadir tarjeta (con pegado multilínea estilo Trello)
    document.querySelectorAll('.kanban-add-card').forEach(btn => {
        btn.addEventListener('click', () => {
            const listaId = btn.dataset.listId;
            btn.innerHTML = `
                <textarea class="kanban-nueva-card-input" placeholder="Nombre de la tarjeta..." maxlength="300" rows="1" autofocus></textarea>
                <div class="kanban-multi-hint" id="kanban-multi-hint" style="display:none;"></div>
            `;
            const input = btn.querySelector('textarea');
            const hint = btn.querySelector('.kanban-multi-hint');
            let modoMulti = 'multiples'; // 'multiples' | 'una'

            // Auto-resize del textarea (una línea = alto normal)
            const autoResize = () => {
                input.style.height = 'auto';
                input.style.height = Math.min(input.scrollHeight, 140) + 'px';
            };

            const actualizarHint = () => {
                const lineas = input.value.split('\n').map(l => l.trim()).filter(Boolean);
                if (lineas.length > 1) {
                    hint.style.display = 'flex';
                    hint.innerHTML = `
                        <span class="kanban-multi-info"><i class="fas fa-clone"></i> ${lineas.length} líneas detectadas</span>
                        <div class="kanban-multi-opciones">
                            <button type="button" class="kanban-multi-btn ${modoMulti === 'multiples' ? 'activo' : ''}" data-modo="multiples">Crear ${lineas.length} tarjetas</button>
                            <button type="button" class="kanban-multi-btn ${modoMulti === 'una' ? 'activo' : ''}" data-modo="una">Una sola tarjeta</button>
                        </div>
                    `;
                    hint.querySelectorAll('.kanban-multi-btn').forEach(b => {
                        b.addEventListener('click', () => {
                            modoMulti = b.dataset.modo;
                            hint.querySelectorAll('.kanban-multi-btn').forEach(x => x.classList.toggle('activo', x === b));
                        });
                    });
                } else {
                    hint.style.display = 'none';
                    hint.innerHTML = '';
                    modoMulti = 'multiples';
                }
            };
            input.addEventListener('paste', () => setTimeout(actualizarHint, 0));
            input.addEventListener('input', () => { actualizarHint(); autoResize(); });

            const confirmar = async () => {
                const lineas = input.value.split('\n').map(l => l.trim()).filter(Boolean);
                if (!lineas.length) return;
                const lista = lists.find(l => l.id === listaId);
                if (!lista) return;
                try {
                    if (lineas.length > 1 && modoMulti === 'multiples') {
                        // Trello-style: una tarjeta por línea
                        for (let i = 0; i < lineas.length; i++) {
                            const nueva = await deps.kanbanApi.createCard(listaId, { titulo: lineas[i], posicion: lista.cards.length + i });
                            lista.cards.push({ ...nueva, etiquetas: [], checklists: [], adjuntos: [] });
                        }
                        renderBoardModal();
                        mostrarToast(`${lineas.length} tarjetas creadas`, 'success');
                    } else {
                        // Una tarjeta: primera línea = título, resto = descripción
                        const titulo = lineas[0];
                        const descripcion = lineas.slice(1).join('\n');
                        const nueva = await deps.kanbanApi.createCard(listaId, { titulo, descripcion, posicion: lista.cards.length });
                        lista.cards.push({ ...nueva, etiquetas: nueva.etiquetas || [], checklists: [], adjuntos: [] });
                        renderBoardModal();
                        abrirCardModal(nueva.id);
                    }
                } catch (e) {
                    console.error('[ClientBoard] Error creando tarjeta:', e);
                    mostrarToast('No se pudo crear la tarjeta', 'error');
                    renderBoardModal();
                }
            };
            input.addEventListener('keydown', (e) => {
                // Enter sin Shift crea; Shift+Enter permite salto de línea (paste manual)
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirmar(); }
                if (e.key === 'Escape') renderBoardModal();
            });
            input.addEventListener('blur', () => {
                if (!input.value.trim()) renderBoardModal();
            });
            input.focus();
        });
    });

    // Click en tarjeta → modal de tarjeta (el checkbox de "hecha" no abre)
    document.querySelectorAll('.kanban-card').forEach(cardEl => {
        cardEl.addEventListener('click', (e) => {
            if (e.target.closest('.kanban-card-check')) return;
            abrirCardModal(cardEl.dataset.cardId);
        });
        bindCheckTarjeta(cardEl);
    });
}

/**
 * Bind del checkbox "hecha" de una tarjeta. Se usa tanto en
 * renderBoardModal como en actualizarCardEnBoard (fix: el elemento
 * reemplazado perdía el listener y no se podía desmarcar sin
 * recargar el board).
 */
function bindCheckTarjeta(cardEl) {
    const checkBtn = cardEl.querySelector('.kanban-card-check');
    if (!checkBtn) return;
    checkBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const cardId = checkBtn.dataset.cardId;
        const found = buscarCard(cardId);
        if (!found) return;
        const card = found.card;
        card.completado = !card.completado;
        try {
            await deps.kanbanApi.updateCard(cardId, { completado: card.completado });
            actualizarCardEnBoard(card);
        } catch (err) {
            card.completado = !card.completado;
            console.error('[ClientBoard] Error marcando tarjeta:', err);
            mostrarToast('No se pudo actualizar la tarjeta', 'error');
        }
    });
}

// ========== DRAG & DROP (nativo HTML5) ==========

function bindDnD() {
    document.querySelectorAll('.kanban-card').forEach(cardEl => {
        cardEl.addEventListener('dragstart', (e) => {
            dragCardId = cardEl.dataset.cardId;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', dragCardId);
            cardEl.classList.add('kanban-dragging');
        });
        cardEl.addEventListener('dragend', () => {
            dragCardId = null;
            cardEl.classList.remove('kanban-dragging');
            document.querySelectorAll('.kanban-list-cards').forEach(c => c.classList.remove('kanban-drag-over'));
        });
    });

    document.querySelectorAll('.kanban-list-cards').forEach(cont => {
        const listaId = cont.dataset.listId;

        cont.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            cont.classList.add('kanban-drag-over');

            // Indicador de posición: insertar antes de la card más cercana
            const dragging = document.querySelector('.kanban-card.kanban-dragging');
            if (!dragging) return;
            const cards = [...cont.querySelectorAll('.kanban-card:not(.kanban-dragging)')];
            const y = e.clientY;
            let antes = null;
            for (const card of cards) {
                const rect = card.getBoundingClientRect();
                if (y < rect.top + rect.height / 2) { antes = card; break; }
            }
            if (antes) cont.insertBefore(dragging, antes);
            else cont.appendChild(dragging);
        });

        cont.addEventListener('dragleave', (e) => {
            if (!cont.contains(e.relatedTarget)) cont.classList.remove('kanban-drag-over');
        });

        cont.addEventListener('drop', async (e) => {
            e.preventDefault();
            cont.classList.remove('kanban-drag-over');
            const cardId = e.dataTransfer.getData('text/plain') || dragCardId;
            if (!cardId) return;

            const listaOrigen = lists.find(l => l.cards.some(c => c.id === cardId));
            const card = listaOrigen?.cards.find(c => c.id === cardId);
            if (!card) return;

            try {
                await persistirOrden(listaId);
                if (listaOrigen && listaOrigen.id !== listaId) {
                    await persistirOrden(listaOrigen.id);
                }
            } catch (err) {
                console.error('[ClientBoard] Error guardando orden:', err);
                mostrarToast('No se pudo guardar el movimiento', 'error');
            }
            // Re-sincronizar estado local con el DOM
            syncStateDesdeDOM();
        });
    });
}

async function persistirOrden(listaId) {
    const cont = document.querySelector(`.kanban-list[data-list-id="${listaId}"] .kanban-list-cards`);
    if (!cont) return;
    const els = [...cont.querySelectorAll('.kanban-card')];
    const updates = els.map((el, i) => ({ id: el.dataset.cardId, list_id: listaId, posicion: i }));
    if (updates.length) await deps.kanbanApi.reordenarCards(updates);
}

function syncStateDesdeDOM() {
    document.querySelectorAll('.kanban-list').forEach(listEl => {
        const listaId = listEl.dataset.listId;
        const lista = lists.find(l => l.id === listaId);
        if (!lista) return;
        const cardEls = [...listEl.querySelectorAll('.kanban-card')];
        const idsEnDom = new Set(cardEls.map(el => el.dataset.cardId));
        cardEls.forEach((el, i) => {
            const card = lists.flatMap(l => l.cards).find(c => c.id === el.dataset.cardId);
            if (card) { card.list_id = listaId; card.posicion = i; }
        });
        // Quitar de otras listas las que ahora están en esta
        lists.forEach(other => {
            if (other.id !== listaId) {
                other.cards = other.cards.filter(c => !idsEnDom.has(c.id));
            }
        });
    });
}

// ========== MODAL DE TARJETA ==========

function buscarCard(cardId) {
    for (const l of lists) {
        const c = l.cards.find(x => x.id === cardId);
        if (c) return { lista: l, card: c };
    }
    return null;
}

function abrirCardModal(cardId) {
    const found = buscarCard(cardId);
    if (!found) return;
    const { lista, card } = found;

    // Opciones de citas del cliente
    const citaOptions = citasCliente
        .map(c => {
            const label = `${formatFechaCorta(c.fecha)} ${formatTimeDisplay(c.hora)} — ${c.servicio || 'Servicio'}`;
            return `<option value="${c.id}" ${card.cita_id === c.id ? 'selected' : ''}>${escapeHtml(label)}</option>`;
        })
        .join('');
    const citaSelect = `
        <select id="kcard-cita">
            <option value="">— Sin cita vinculada —</option>
            ${citaOptions}
        </select>
    `;

    // Opciones de lista (para mover en móvil / reordenar)
    const listaOptions = lists
        .map(l => `<option value="${l.id}" ${l.id === lista.id ? 'selected' : ''}>${escapeHtml(l.titulo)}</option>`)
        .join('');

    const soloLectura = deps.adjuntosSoloLectura === true;
    const adjuntosHtml = card.adjuntos.length
        ? card.adjuntos.map(a => renderAdjuntoHtml(a, soloLectura)).join('')
        : `<p class="kanban-adjuntos-vacio">Sin documentos${soloLectura ? '' : '. Podés subir imágenes, PDF, Word, Excel, PowerPoint, etc.'}</p>`;

    const overlay = document.createElement('div');
    overlay.id = 'kanban-card-overlay';
    overlay.className = 'kanban-card-overlay';
    overlay.innerHTML = `
        <div class="kanban-card-modal">
            <header class="kanban-card-modal-header">
                <h4><i class="fas fa-sticky-note"></i> Tarjeta</h4>
                <button class="kanban-btn-close" id="kcard-cerrar" title="Cerrar"><i class="fas fa-times"></i></button>
            </header>
            <div class="kanban-card-form">
                <label class="kanban-seccion-label"><i class="fas fa-heading"></i> Título</label>
                <input type="text" id="kcard-titulo" value="${escapeHtml(card.titulo)}" maxlength="120" placeholder="Título de la tarjeta">

                <label class="kanban-seccion-label"><i class="fas fa-align-left"></i> Descripción</label>
                <textarea id="kcard-descripcion" rows="3" placeholder="Notas, detalles, seguimiento...">${escapeHtml(card.descripcion || '')}</textarea>

                <div class="kanban-form-row">
                    <div>
                        <label class="kanban-seccion-label"><i class="fas fa-columns"></i> Lista</label>
                        <select id="kcard-lista">${listaOptions}</select>
                    </div>
                    <div>
                        <label class="kanban-seccion-label"><i class="fas fa-calendar-alt"></i> Vincular a cita programada</label>
                        ${citaSelect}
                    </div>
                </div>
                <p class="kanban-hint"><i class="fas fa-info-circle"></i> Vinculá una cita programada para relacionar esta tarjeta con la reserva del cliente.</p>

                <div class="kanban-seccion">
                    <div class="kanban-seccion-header">
                        <label class="kanban-seccion-label"><i class="fas fa-tasks"></i> Checklists</label>
                        <button class="btn-small kanban-add-checklist-btn" id="kcheck-nuevo"><i class="fas fa-plus"></i> Añadir checklist</button>
                    </div>
                    <div class="kanban-checklists" id="kanban-checklists">
                        ${renderChecklistsHtml(card)}
                    </div>
                </div>

                <div class="kanban-seccion">
                    <label class="kanban-seccion-label"><i class="fas fa-paperclip"></i> Documentos adjuntos</label>
                    <div class="kanban-adjuntos">
                        <div class="kanban-adjuntos-list" id="kadjuntos-list">${adjuntosHtml}</div>
                        ${soloLectura ? `
                        <p class="kanban-hint"><i class="fas fa-info-circle"></i> Solo lectura desde este portal: los documentos los gestiona el administrador.</p>` : `
                        <label class="kanban-upload-btn">
                            <i class="fas fa-cloud-upload-alt"></i> Subir archivo
                            <input type="file" id="kadjuntos-file" multiple accept="${ACCEPT_ADJUNTOS}">
                        </label>
                        <p class="kanban-upload-limit"><i class="fas fa-info-circle"></i> Máximo 100 MB por archivo. Formatos: imágenes, PDF, Word, Excel, PowerPoint, texto, ZIP, video y audio.</p>`}
                    </div>
                </div>

                <div class="kanban-card-actions">
                    <button class="btn-danger" id="kcard-eliminar"><i class="fas fa-trash"></i> Eliminar tarjeta</button>
                    <button class="btn-primary" id="kcard-guardar"><i class="fas fa-save"></i> Guardar</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    cardModalAbierto = true;
    cardModalCard = card;

    // Cerrar (refresca los badges de la card en el board)
    const cerrarCon = () => { actualizarCardEnBoard(card); cerrarCardModal(); };
    document.getElementById('kcard-cerrar').addEventListener('click', cerrarCon);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) cerrarCon(); });

    // Checklists
    bindChecklistsUI(overlay, card);

    // Nuevo checklist
    document.getElementById('kcheck-nuevo').addEventListener('click', async () => {
        try {
            const nuevo = await deps.kanbanApi.createChecklist(card.id, 'Checklist', card.checklists.length);
            card.checklists.push(nuevo);
            renderChecklistsSection(overlay, card);
            bindChecklistsUI(overlay, card);
        } catch (err) {
            console.error('[ClientBoard] Error creando checklist:', err);
            mostrarToast('No se pudo crear el checklist', 'error');
        }
    });

    // Adjuntos: ver / descargar / eliminar / subir (solo admin;
    // en el portal del trabajador son solo lectura)
    if (!soloLectura) {
        overlay.querySelectorAll('.kanban-adjunto-ver').forEach(btn => {
            btn.addEventListener('click', () => verAdjunto(btn.closest('.kanban-adjunto-item')));
        });
        overlay.querySelectorAll('.kanban-adjunto-descargar').forEach(btn => {
            btn.addEventListener('click', () => descargarAdjunto(btn.closest('.kanban-adjunto-item')));
        });
        overlay.querySelectorAll('.kanban-adjunto-del').forEach(btn => {
            btn.addEventListener('click', () => eliminarAdjunto(btn.closest('.kanban-adjunto-item'), card));
        });
        document.getElementById('kadjuntos-file').addEventListener('change', (e) => {
            subirAdjuntos(e.target.files, card);
            e.target.value = '';
        });
    }

    // Eliminar tarjeta
    document.getElementById('kcard-eliminar').addEventListener('click', async () => {
        if (!window.confirm(`¿Eliminar la tarjeta "${card.titulo}"?`)) return;
        try {
            await deps.kanbanApi.deleteCard(card.id);
            lista.cards = lista.cards.filter(c => c.id !== card.id);
            cerrarCardModal();
            renderBoardModal();
            mostrarToast('Tarjeta eliminada', 'success');
        } catch (err) {
            console.error('[ClientBoard] Error eliminando tarjeta:', err);
            mostrarToast('No se pudo eliminar la tarjeta', 'error');
        }
    });

    // Guardar
    document.getElementById('kcard-guardar').addEventListener('click', () => guardarCard(card, lista, overlay));
}

// ========== CHECKLISTS (múltiples, estilo Trello) ==========

function renderChecklistsHtml(card) {
    if (!card.checklists || !card.checklists.length) {
        return '<p class="kanban-checklist-vacio">Sin checklists. Añadí uno para llevar el seguimiento paso a paso.</p>';
    }
    return card.checklists.map(ch => renderChecklistHtml(ch)).join('');
}

function renderChecklistHtml(ch) {
    const total = ch.items.length;
    const hechos = ch.items.filter(i => i.completado).length;
    const pct = total ? Math.round((hechos / total) * 100) : 0;
    const itemsHtml = ch.items.map(it => `
        <div class="kanban-checklist-item" data-item-id="${it.id}">
            <label class="kanban-check-custom ${it.completado ? 'checked' : ''}">
                <input type="checkbox" class="kcheck-item" ${it.completado ? 'checked' : ''}>
                <span class="kanban-check-box"><i class="fas fa-check"></i></span>
            </label>
            <span class="kanban-item-texto ${it.completado ? 'hecho' : ''}">${escapeHtml(it.texto)}</span>
            <button class="kcheck-del" title="Eliminar elemento"><i class="fas fa-times"></i></button>
        </div>
    `).join('');

    return `
        <div class="kanban-checklist" data-checklist-id="${ch.id}">
            <div class="kanban-checklist-header">
                <span class="kanban-checklist-titulo" title="Clic para renombrar">${escapeHtml(ch.titulo)}</span>
                <span class="kanban-checklist-count">${hechos}/${total}</span>
                <button class="kanban-checklist-del" title="Eliminar checklist"><i class="fas fa-trash"></i></button>
            </div>
            <div class="kanban-checklist-progress">
                <div class="kanban-checklist-bar"><div class="kanban-checklist-fill" style="width:${pct}%"></div></div>
            </div>
            <div class="kanban-checklist-items">${itemsHtml}</div>
            <div class="kanban-checklist-add">
                <input type="text" class="kcheck-input" placeholder="Añadir un elemento..." maxlength="200">
                <button class="btn-small btn-primary kcheck-add"><i class="fas fa-plus"></i></button>
            </div>
        </div>
    `;
}

function renderChecklistsSection(overlay, card) {
    const cont = document.getElementById('kanban-checklists');
    if (cont) cont.innerHTML = renderChecklistsHtml(card);
}

function bindChecklistsUI(overlay, card) {
    overlay.querySelectorAll('.kanban-checklist').forEach(chEl => {
        const checklistId = chEl.dataset.checklistId;
        const checklist = card.checklists.find(c => c.id === checklistId);
        if (!checklist) return;

        // Renombrar (click en el título)
        const tituloEl = chEl.querySelector('.kanban-checklist-titulo');
        tituloEl.addEventListener('click', async () => {
            const input = document.createElement('input');
            input.type = 'text';
            input.value = checklist.titulo;
            input.maxLength = 60;
            input.className = 'kanban-checklist-titulo-input';
            tituloEl.replaceWith(input);
            input.focus();
            input.select();
            const guardar = async () => {
                const titulo = input.value.trim();
                if (!titulo) return;
                try {
                    const actualizado = await deps.kanbanApi.updateChecklist(checklistId, { titulo });
                    checklist.titulo = actualizado.titulo;
                } catch (e) {
                    console.error('[ClientBoard] Error renombrando checklist:', e);
                    mostrarToast('No se pudo renombrar el checklist', 'error');
                }
                renderChecklistsSection(overlay, card);
                bindChecklistsUI(overlay, card);
            };
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') guardar();
                if (e.key === 'Escape') { renderChecklistsSection(overlay, card); bindChecklistsUI(overlay, card); }
            });
            input.addEventListener('blur', guardar);
        });

        // Eliminar checklist
        chEl.querySelector('.kanban-checklist-del').addEventListener('click', async () => {
            if (!window.confirm(`¿Eliminar el checklist "${checklist.titulo}" y sus ${checklist.items.length} elemento${checklist.items.length !== 1 ? 's' : ''}?`)) return;
            try {
                await deps.kanbanApi.deleteChecklist(checklistId);
                card.checklists = card.checklists.filter(c => c.id !== checklistId);
                renderChecklistsSection(overlay, card);
                bindChecklistsUI(overlay, card);
            } catch (err) {
                console.error('[ClientBoard] Error eliminando checklist:', err);
                mostrarToast('No se pudo eliminar el checklist', 'error');
            }
        });

        // Toggle item
        chEl.querySelectorAll('.kcheck-item').forEach(cb => {
            cb.addEventListener('change', async () => {
                const itemEl = cb.closest('.kanban-checklist-item');
                const itemId = itemEl.dataset.itemId;
                const item = checklist.items.find(i => i.id === itemId);
                if (!item) return;
                item.completado = cb.checked;
                itemEl.querySelector('.kanban-check-custom').classList.toggle('checked', cb.checked);
                itemEl.querySelector('.kanban-item-texto').classList.toggle('hecho', cb.checked);
                actualizarProgresoChecklist(chEl);
                try {
                    await deps.kanbanApi.updateChecklistItem(itemId, { completado: cb.checked });
                } catch (err) {
                    console.error('[ClientBoard] Error actualizando checklist:', err);
                    mostrarToast('No se pudo actualizar el elemento', 'error');
                }
            });
        });

        // Eliminar item
        chEl.querySelectorAll('.kcheck-del').forEach(btn => {
            btn.addEventListener('click', async () => {
                const itemEl = btn.closest('.kanban-checklist-item');
                const itemId = itemEl.dataset.itemId;
                try {
                    await deps.kanbanApi.deleteChecklistItem(itemId);
                    checklist.items = checklist.items.filter(i => i.id !== itemId);
                    itemEl.remove();
                    actualizarProgresoChecklist(chEl);
                    actualizarContadorChecklist(chEl, checklist);
                } catch (err) {
                    console.error('[ClientBoard] Error eliminando elemento:', err);
                    mostrarToast('No se pudo eliminar el elemento', 'error');
                }
            });
        });

        // Añadir item
        const addBtn = chEl.querySelector('.kcheck-add');
        const input = chEl.querySelector('.kcheck-input');
        const agregar = async () => {
            const texto = input.value.trim();
            if (!texto) return;
            try {
                const nuevo = await deps.kanbanApi.addChecklistItem(checklistId, card.id, texto, checklist.items.length);
                checklist.items.push(nuevo);
                input.value = '';
                renderChecklistsSection(overlay, card);
                bindChecklistsUI(overlay, card);
            } catch (err) {
                console.error('[ClientBoard] Error agregando elemento:', err);
                mostrarToast('No se pudo agregar el elemento', 'error');
            }
        };
        addBtn.addEventListener('click', agregar);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') agregar();
        });
    });
}

function actualizarProgresoChecklist(chEl) {
    const items = [...chEl.querySelectorAll('.kanban-checklist-item')];
    const total = items.length;
    const hechos = items.filter(el => el.querySelector('.kcheck-item').checked).length;
    const fill = chEl.querySelector('.kanban-checklist-fill');
    if (fill) fill.style.width = total ? `${Math.round((hechos / total) * 100)}%` : '0%';
    const count = chEl.querySelector('.kanban-checklist-count');
    if (count) count.textContent = `${hechos}/${total}`;
}

function actualizarContadorChecklist(chEl, checklist) {
    const hechos = checklist.items.filter(i => i.completado).length;
    const count = chEl.querySelector('.kanban-checklist-count');
    if (count) count.textContent = `${hechos}/${checklist.items.length}`;
}

// ========== GUARDAR TARJETA ==========

async function guardarCard(card, lista, overlay) {
    const titulo = document.getElementById('kcard-titulo').value.trim();
    if (!titulo) {
        mostrarToast('El título es obligatorio', 'warning');
        return;
    }
    const descripcion = document.getElementById('kcard-descripcion').value;
    const nuevaListaId = document.getElementById('kcard-lista').value;
    const citaId = document.getElementById('kcard-cita').value || null;

    try {
        let posicion = card.posicion;
        if (nuevaListaId && nuevaListaId !== lista.id) {
            const destino = lists.find(l => l.id === nuevaListaId);
            posicion = destino ? destino.cards.length : 0;
        }
        await deps.kanbanApi.updateCard(card.id, { titulo, descripcion, cita_id: citaId, posicion });

        // Actualizar estado local
        card.titulo = titulo;
        card.descripcion = descripcion;
        card.cita_id = citaId;
        card.posicion = posicion;
        if (nuevaListaId && nuevaListaId !== lista.id) {
            const destino = lists.find(l => l.id === nuevaListaId);
            if (destino) {
                lista.cards = lista.cards.filter(c => c.id !== card.id);
                destino.cards.push(card);
                card.list_id = nuevaListaId;
            }
        }

        cerrarCardModal();
        renderBoardModal();
        mostrarToast('Tarjeta guardada', 'success');
    } catch (err) {
        console.error('[ClientBoard] Error guardando tarjeta:', err);
        mostrarToast('No se pudo guardar la tarjeta: ' + (err.message || 'error'), 'error');
    }
}

// ========== ADJUNTOS ==========

function renderAdjuntoHtml(a, soloLectura) {
    const acciones = soloLectura ? '' : `
            <button class="btn-small kanban-adjunto-ver" title="Ver en pantalla"><i class="fas fa-eye"></i> <span class="kanban-btn-texto">Ver</span></button>
            <button class="btn-small kanban-adjunto-descargar" title="Descargar"><i class="fas fa-download"></i> <span class="kanban-btn-texto">Descargar</span></button>
            <button class="btn-small kanban-adjunto-del" title="Eliminar"><i class="fas fa-trash"></i> <span class="kanban-btn-texto">Eliminar</span></button>`;
    return `
        <div class="kanban-adjunto-item" data-adjunto-id="${a.id}">
            <span class="kanban-adjunto-icono ${claseIconoMime(a.tipo_mime)}"><i class="fas ${iconoParaMime(a.tipo_mime)}"></i></span>
            <div class="kanban-adjunto-info">
                <strong>${escapeHtml(a.nombre)}</strong>
                <span>${formatTamano(a.tamano)}</span>
            </div>
            ${acciones}
        </div>
    `;
}

function claseIconoMime(mime) {
    const m = (mime || '').toLowerCase();
    if (m.includes('pdf')) return 'tipo-pdf';
    if (m.includes('word') || m.includes('msword') || m.includes('rtf') || m.includes('opendocument.text')) return 'tipo-word';
    if (m.includes('excel') || m.includes('sheet') || m.includes('csv')) return 'tipo-excel';
    if (m.includes('powerpoint') || m.includes('presentation')) return 'tipo-power';
    if (m.includes('image')) return 'tipo-image';
    if (m.includes('video')) return 'tipo-video';
    if (m.includes('audio')) return 'tipo-audio';
    if (m.includes('zip') || m.includes('compressed') || m.includes('7z')) return 'tipo-zip';
    if (m.includes('text') || m.includes('json') || m.includes('xml')) return 'tipo-text';
    return 'tipo-default';
}

function iconoParaMime(mime) {
    const m = (mime || '').toLowerCase();
    if (m.includes('pdf')) return ICONOS_MIME.pdf;
    if (m.includes('word') || m.includes('msword') || m.includes('rtf') || m.includes('opendocument.text')) return ICONOS_MIME.word;
    if (m.includes('excel') || m.includes('sheet') || m.includes('csv')) return ICONOS_MIME.excel;
    if (m.includes('powerpoint') || m.includes('presentation')) return ICONOS_MIME.power;
    if (m.includes('image')) return ICONOS_MIME.image;
    if (m.includes('video')) return ICONOS_MIME.video;
    if (m.includes('audio')) return ICONOS_MIME.audio;
    if (m.includes('zip') || m.includes('compressed') || m.includes('7z')) return ICONOS_MIME.zip;
    if (m.includes('text') || m.includes('json') || m.includes('xml')) return ICONOS_MIME.text;
    return ICONOS_MIME.default;
}

function formatTamano(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function subirAdjuntos(files, card) {
    const list = document.getElementById('kadjuntos-list');
    const vacio = list ? list.querySelector('.kanban-adjuntos-vacio') : null;

    for (const file of files) {
        // Validación de tamaño ANTES de subir (aviso inmediato, sin esperar)
        if (file.size > MAX_ADJUNTO_BYTES) {
            mostrarToast(`"${file.name}" supera el límite de 100 MB`, 'error');
            continue;
        }

        // Fila temporal con progreso visible desde el primer instante
        const filaId = 'subida-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        let filaEl = null;
        if (list) {
            if (vacio) vacio.remove();
            list.insertAdjacentHTML('beforeend', `
                <div class="kanban-adjunto-item kanban-subiendo" id="${filaId}">
                    <span class="kanban-subiendo-spinner"><i class="fas fa-spinner fa-spin"></i></span>
                    <div class="kanban-adjunto-info">
                        <strong>${escapeHtml(file.name)}</strong>
                        <span class="kanban-subiendo-estado"><i class="fas fa-cloud-upload-alt"></i> Subiendo... 0%</span>
                    </div>
                    <div class="kanban-subiendo-bar"><div class="kanban-subiendo-fill" style="width:0%"></div></div>
                    <span class="kanban-subiendo-pct">0%</span>
                </div>
            `);
            filaEl = document.getElementById(filaId);
        }

        const tiempoInicio = Date.now();
        let ultimaActualizacion = 0;
        let ultimoLoaded = 0;

        try {
            const storagePath = await deps.kanbanApi.uploadAttachment(file, board.id, card.id, (p) => {
                if (!filaEl) return;
                const ahora = Date.now();
                if (ahora - ultimaActualizacion < 120) return; // throttle UI
                ultimaActualizacion = ahora;
                const pct = Math.min(100, Math.round((p.loaded / p.total) * 100));

                // Velocidad + tiempo restante estimado
                const velocidad = p.loaded / Math.max(1, (ahora - tiempoInicio) / 1000);
                let textoRestante = '';
                if (p.loaded > 0 && velocidad > 0 && pct < 100) {
                    const segundos = Math.max(1, Math.round((p.total - p.loaded) / velocidad));
                    textoRestante = segundos < 60
                        ? ` · faltan ~${segundos}s`
                        : ` · faltan ~${Math.round(segundos / 60)}min`;
                }
                ultimoLoaded = p.loaded;
                const estado = filaEl.querySelector('.kanban-subiendo-estado');
                const fill = filaEl.querySelector('.kanban-subiendo-fill');
                const pctEl = filaEl.querySelector('.kanban-subiendo-pct');
                if (estado) estado.innerHTML = `<i class="fas fa-cloud-upload-alt"></i> Subiendo... ${pct}%${textoRestante}`;
                if (fill) fill.style.width = pct + '%';
                if (pctEl) pctEl.textContent = pct + '%';
            });

            const meta = await deps.kanbanApi.addAttachment(card.id, {
                nombre: file.name,
                tipo_mime: file.type || 'application/octet-stream',
                tamano: file.size,
                storage_path: storagePath
            });
            card.adjuntos.push(meta);

            // Reemplazar fila temporal por el adjunto real
            if (filaEl) {
                filaEl.outerHTML = renderAdjuntoHtml(meta);
                const nuevoEl = document.getElementById(filaId);
                if (nuevoEl) {
                    nuevoEl.id = '';
                    nuevoEl.querySelector('.kanban-adjunto-ver').addEventListener('click', () => verAdjunto(nuevoEl));
                    nuevoEl.querySelector('.kanban-adjunto-descargar').addEventListener('click', () => descargarAdjunto(nuevoEl));
                    nuevoEl.querySelector('.kanban-adjunto-del').addEventListener('click', () => eliminarAdjunto(nuevoEl, card));
                }
            }
            mostrarToast(`"${file.name}" subido`, 'success');
        } catch (err) {
            console.error('[ClientBoard] Error subiendo adjunto:', err);
            // Mostrar el error EN la fila con opción de reintentar
            if (filaEl) {
                filaEl.classList.remove('kanban-subiendo');
                filaEl.classList.add('kanban-subiendo-error');
                const estado = filaEl.querySelector('.kanban-subiendo-estado');
                if (estado) estado.innerHTML = `<i class="fas fa-exclamation-circle"></i> Error: ${escapeHtml(err.message || 'no se pudo subir')}`;
                const bar = filaEl.querySelector('.kanban-subiendo-bar');
                if (bar) bar.remove();
                const pct = filaEl.querySelector('.kanban-subiendo-pct');
                if (pct) pct.remove();
                const spinner = filaEl.querySelector('.kanban-subiendo-spinner');
                if (spinner) spinner.innerHTML = '<i class="fas fa-times-circle"></i>';
                const reintentar = document.createElement('button');
                reintentar.className = 'btn-small kanban-subiendo-retry';
                reintentar.innerHTML = '<i class="fas fa-redo"></i> Reintentar';
                reintentar.addEventListener('click', () => {
                    filaEl.remove();
                    subirAdjuntos([file], card);
                });
                filaEl.appendChild(reintentar);
                const quitar = document.createElement('button');
                quitar.className = 'btn-small kanban-subiendo-quitar';
                quitar.innerHTML = '<i class="fas fa-times"></i> Quitar';
                quitar.addEventListener('click', () => filaEl.remove());
                filaEl.appendChild(quitar);
            } else {
                mostrarToast(`No se pudo subir "${file.name}": ${err.message || 'error'}`, 'error');
            }
        }
    }
}

async function obtenerAdjunto(el) {
    const adjuntoId = el.dataset.adjuntoId;
    for (const l of lists) {
        for (const c of l.cards) {
            const a = c.adjuntos.find(x => x.id === adjuntoId);
            if (a) return a;
        }
    }
    return null;
}

/**
 * "Al presionar una vez se pueda ver en la pantalla":
 * imágenes → preview inline con botón descargar;
 * PDF/otros → se abre en pestaña nueva (visor nativo, que ya
 * incluye su propia opción de descarga) + botón descargar directo.
 */
async function verAdjunto(el) {
    const adjunto = await obtenerAdjunto(el);
    if (!adjunto) return;
    try {
        const url = await deps.kanbanApi.getAttachmentUrl(adjunto.storage_path);
        if (!url) throw new Error('URL no disponible');
        const esImagen = (adjunto.tipo_mime || '').includes('image');

        if (esImagen) {
            const overlay = document.createElement('div');
            overlay.className = 'kanban-card-overlay';
            overlay.innerHTML = `
                <div class="kanban-preview-modal">
                    <header class="kanban-card-modal-header">
                        <h4><i class="fas fa-image"></i> ${escapeHtml(adjunto.nombre)}</h4>
                        <div>
                            <button class="btn-small btn-primary" id="kprev-descargar"><i class="fas fa-download"></i> Descargar</button>
                            <button class="kanban-btn-close" id="kprev-cerrar"><i class="fas fa-times"></i></button>
                        </div>
                    </header>
                    <div class="kanban-preview-body">
                        <img src="${url}" alt="${escapeHtml(adjunto.nombre)}">
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
            document.getElementById('kprev-cerrar').addEventListener('click', () => overlay.remove());
            overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
            const a = document.getElementById('kprev-descargar');
            a.addEventListener('click', () => {
                const link = document.createElement('a');
                link.href = url;
                link.download = adjunto.nombre;
                link.target = '_blank';
                link.rel = 'noopener';
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            });
        } else {
            window.open(url, '_blank', 'noopener');
        }
    } catch (err) {
        console.error('[ClientBoard] Error abriendo adjunto:', err);
        mostrarToast('No se pudo abrir el documento', 'error');
    }
}

async function descargarAdjunto(el) {
    const adjunto = await obtenerAdjunto(el);
    if (!adjunto) return;
    try {
        const url = await deps.kanbanApi.getAttachmentUrl(adjunto.storage_path);
        if (!url) throw new Error('URL no disponible');
        const link = document.createElement('a');
        link.href = url;
        link.download = adjunto.nombre;
        link.target = '_blank';
        link.rel = 'noopener';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    } catch (err) {
        console.error('[ClientBoard] Error descargando adjunto:', err);
        mostrarToast('No se pudo descargar el documento', 'error');
    }
}

async function eliminarAdjunto(el, card) {
    const adjunto = await obtenerAdjunto(el);
    if (!adjunto) return;
    if (!window.confirm(`¿Eliminar "${adjunto.nombre}"?`)) return;
    try {
        await deps.kanbanApi.deleteAttachment(adjunto.id, adjunto.storage_path);
        card.adjuntos = card.adjuntos.filter(a => a.id !== adjunto.id);
        el.remove();
        mostrarToast('Documento eliminado', 'success');
    } catch (err) {
        console.error('[ClientBoard] Error eliminando adjunto:', err);
        mostrarToast('No se pudo eliminar el documento', 'error');
    }
}
