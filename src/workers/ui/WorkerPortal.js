// src/workers/ui/WorkerPortal.js
// Página pública del trabajador — sin login, solo con ?id=XXX
// Usa la RPC get_worker_portal_data (SECURITY DEFINER) para leer
// datos sin exponer RLS de citas/trabajadores a anon.
// Al hacer clic en una reserva abre la información del cliente
// (contacto editable + tablero tipo trello) vía RPCs worker-scoped:
// los cambios se reflejan en Mis Clientes y Citas Programadas.

import { getCurrentTenantId } from '../../shared/infrastructure/router.js';
import { getSemanaISO, getHorarioParaSemana } from '../../workers/domain/horarioValidation.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';

const ETIQUETAS_PAGO = [
    { clave: 'pagado', nombre: 'Pagado', color: '#2ecc71' },
    { clave: 'abonado', nombre: 'Abonado', color: '#3498db' },
    { clave: 'parcial', nombre: 'Se pagó algo', color: '#f1c40f' },
    { clave: 'no_pagado', nombre: 'No pagado', color: '#e74c3c' }
];

// ========== ESTADO ==========

let _wpTenantId = null;
let _wpWorkerId = null;
let _citasDelTrabajador = [];   // [{ cita_id, fecha, hora, servicio, cliente, contacto }]
let _clienteActual = null;      // { email, nombre, telefono, citas: [...] }
let _boardData = null;          // { board, lists: [...] }

export async function initWorkerPortal() {
    const params = new URLSearchParams(window.location.search);
    const workerId = params.get('id');
    const tenantId = params.get('tenant') || await getCurrentTenantId();

    _wpTenantId = tenantId;
    _wpWorkerId = workerId;

    const nameEl = document.getElementById('wp-nombre');
    const skillsEl = document.getElementById('wp-habilidades');
    const scheduleEl = document.getElementById('wp-horario');
    const reservationsEl = document.getElementById('wp-reservas');
    const avatarEl = document.getElementById('wp-avatar-inner');
    const inicialEl = document.getElementById('wp-inicial');

    if (!workerId || !tenantId) {
        if (nameEl) nameEl.textContent = 'Enlace inválido';
        if (reservationsEl) reservationsEl.innerHTML = '<p>Falta información del trabajador.</p>';
        return;
    }

    try {
        const supabase = window.supabaseClient;
        if (!supabase) {
            if (reservationsEl) reservationsEl.innerHTML = '<p>Error de conexión.</p>';
            return;
        }

        const { data, error } = await supabase.rpc('get_worker_portal_data', {
            p_tenant_id: String(tenantId).trim(),
            p_worker_id: workerId
        });

        if (error) throw error;

        if (!data || data.error === 'not_found') {
            if (nameEl) nameEl.textContent = 'Trabajador no encontrado';
            if (reservationsEl) reservationsEl.innerHTML = '<p>El trabajador no existe o fue desactivado.</p>';
            return;
        }

        const worker = data.worker;
        const citas = data.citas_hoy || [];
        const citasProximas = data.citas_proximas || [];

        _citasDelTrabajador = [...citas.map(c => ({ ...c, fecha: '' })), ...citasProximas];

        // Mostrar info del trabajador
        if (nameEl) nameEl.textContent = worker.nombre;
        if (skillsEl) {
            skillsEl.textContent = worker.habilidades || 'Sin habilidades registradas';
        }
        if (avatarEl && worker.color) avatarEl.style.background = worker.color;
        if (inicialEl && worker.nombre) inicialEl.textContent = worker.nombre.charAt(0).toUpperCase();

        // Horario semanal desde datos reales (resolviendo plantilla vs excepción)
        if (scheduleEl) {
            const weekKey = getSemanaISO(new Date());
            const hrInfo = getHorarioParaSemana(worker, weekKey);
            const horario = hrInfo.horario;
            const diasNombres = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
            const tieneHorario = Object.values(horario).some(d => d && d.activo);

            if (!tieneHorario) {
                scheduleEl.innerHTML = '<p style="text-align:center;color:rgba(255,255,255,0.3);">Horario no definido — consulta con tu administrador</p>';
            } else {
                scheduleEl.innerHTML = `
                    <div style="text-align:center;margin-bottom:8px;">
                        <span class="week-type-badge ${hrInfo.esExcepcion ? 'week-type-custom' : 'week-type-template'}" style="font-size:0.65rem;">
                            ${hrInfo.esExcepcion ? '✏️ Horario de esta semana' : '📋 Horario habitual'}
                        </span>
                    </div>
                    <div class="worker-schedule-grid">
                        ${diasNombres.map((d, i) => {
                            const diaKey = String(i + 1);
                            const dia = horario[diaKey] || { activo: false };
                            return `
                                <div class="schedule-day-slot ${dia.activo ? 'laboral' : 'descanso'}">
                                    <span class="day-name">${d}</span>
                                    <span class="day-hours">${dia.activo ? (dia.inicio || '—') + ' - ' + (dia.fin || '—') : '—'}</span>
                                </div>
                            `;
                        }).join('')}
                    </div>
                `;
            }
        }

        // Reservas: HOY + próximas (14 días, devueltas por la RPC)
        if (reservationsEl) {
            const hoyStr = fechaLocalStr(new Date());
            const proximas = citasProximas.filter(c => String(c.fecha) !== hoyStr);

            const h3 = reservationsEl.closest('.wp-section')?.querySelector('h3');
            if (h3) h3.textContent = 'Reservas';

            const tarjeta = (c) => `
                <div class="worker-cita-card" role="button" tabindex="0"
                     data-cita-id="${escapeAttr(c.cita_id || '')}"
                     data-email="${escapeAttr((c.contacto && c.contacto.email) || '')}"
                     title="Ver información del cliente">
                    <span class="cita-hora">${formatTime(c.hora)}</span>
                    <div class="cita-info">
                        <strong>${escapeHtml(c.servicio || 'Servicio')}</strong>
                        <span>${escapeHtml(c.cliente || 'Cliente')}</span>
                    </div>
                </div>
            `;

            let html = '';

            // Reservas de hoy
            if (citas.length) {
                html += `<div class="worker-citas-list">${citas.map(tarjeta).join('')}</div>`;
            }

            // Próximas reservas (excluyendo hoy para no duplicar)
            if (proximas.length) {
                const grupos = {};
                proximas.forEach(c => {
                    const f = String(c.fecha);
                    if (!grupos[f]) grupos[f] = [];
                    grupos[f].push(c);
                });
                html += '<div style="margin-top:16px;">';
                html += '<h4 style="font-size:0.9rem;margin:0 0 4px;color:rgba(255,255,255,0.75);"><i class="fas fa-calendar-alt"></i> Próximas reservas</h4>';
                Object.keys(grupos).sort().forEach(f => {
                    html += `<div style="margin-top:10px;">`;
                    html += `<div style="font-size:0.72rem;font-weight:600;color:#ffd700;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.4px;">${formatFechaReserva(f)}</div>`;
                    html += `<div class="worker-citas-list">${grupos[f].map(tarjeta).join('')}</div>`;
                    html += '</div>';
                });
                html += '</div>';
            }

            if (!citas.length && !proximas.length) {
                html = `
                    <div class="empty-state" style="padding:20px;">
                        <i class="fas fa-calendar-check" style="font-size:1.5rem;opacity:0.3;"></i>
                        <p style="margin-top:8px;">No tienes reservas próximas</p>
                    </div>
                `;
            }

            reservationsEl.innerHTML = html;

            // Clic en una reserva → información del cliente (tipo trello)
            reservationsEl.querySelectorAll('.worker-cita-card').forEach(card => {
                const abrir = () => {
                    const email = card.dataset.email;
                    const cita = _citasDelTrabajador.find(c => String(c.cita_id || '') === String(card.dataset.citaId));
                    abrirModalCliente(email, cita || {});
                };
                card.addEventListener('click', abrir);
                card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir(); } });
            });
        }

    } catch (e) {
        console.error('[WorkerPortal] Error:', e);
        const reservationsEl = document.getElementById('wp-reservas');
        if (reservationsEl) reservationsEl.innerHTML = '<p>Error al cargar datos.</p>';
    }
}

// ========== MODAL CLIENTE (contacto + tablero trello) ==========

async function abrirModalCliente(email, cita) {
    const emailLimpio = String(email || '').trim().toLowerCase();
    if (!emailLimpio) {
        mostrarToast('El cliente no tiene email registrado', 'warning');
        return;
    }
    const supabase = window.supabaseClient;
    if (!supabase || !_wpTenantId || !_wpWorkerId) return;

    const contacto = (cita && cita.contacto) || {};
    _clienteActual = {
        email: emailLimpio,
        nombre: (cita && cita.cliente) || contacto.nombre || '',
        telefono: contacto.telefono || '',
        citas: _citasDelTrabajador.filter(c => String((c.contacto && c.contacto.email) || '').trim().toLowerCase() === emailLimpio)
    };

    const { data, error } = await supabase.rpc('worker_get_board', {
        p_tenant_id: _wpTenantId,
        p_worker_id: _wpWorkerId,
        p_cliente_email: emailLimpio
    });
    if (error || (data && data.error)) {
        mostrarToast('No puedes ver la información de este cliente', 'error');
        return;
    }
    _boardData = data || { board: null, lists: [] };
    renderModalCliente();
}

function renderModalCliente() {
    cerrarModalTarjeta();
    const existente = document.getElementById('worker-cliente-modal');
    if (existente) existente.remove();

    const overlay = document.createElement('div');
    overlay.id = 'worker-cliente-modal';
    overlay.className = 'kanban-modal-overlay';
    overlay.style.zIndex = '2000';
    overlay.innerHTML = `
        <div class="kanban-modal" style="max-width:1100px;width:96%;max-height:92vh;display:flex;flex-direction:column;">
            <header class="kanban-modal-header">
                <div class="kanban-cliente-avatar"><i class="fas fa-user"></i></div>
                <div class="kanban-cliente-info">
                    <h3><i class="fas fa-id-card"></i> Información del cliente</h3>
                    <p style="opacity:0.6;font-size:0.8rem;">Los cambios se guardan y se reflejan en Mis Clientes y Citas Programadas.</p>
                </div>
                <button class="kanban-btn-close" id="worker-modal-cerrar" title="Cerrar">&times;</button>
            </header>

            <div style="overflow-y:auto;padding:16px;">
                <div class="kanban-seccion">
                    <div class="kanban-seccion-header">
                        <span class="kanban-seccion-label"><i class="fas fa-address-book"></i> Contacto</span>
                    </div>
                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-top:10px;">
                        <input id="wcl-nombre" class="kanban-nueva-card-input" placeholder="Nombre completo" value="${escapeAttr(_clienteActual.nombre || '')}">
                        <input id="wcl-telefono" class="kanban-nueva-card-input" placeholder="Teléfono" value="${escapeAttr(_clienteActual.telefono || '')}">
                        <input id="wcl-email" class="kanban-nueva-card-input" placeholder="Email" type="email" value="${escapeAttr(_clienteActual.email)}">
                        <button class="btn-primary" id="wcl-guardar" style="padding:8px 14px;">
                            <i class="fas fa-save"></i> Guardar contacto
                        </button>
                    </div>
                </div>

                <div class="kanban-seccion" style="margin-top:18px;">
                    <div class="kanban-seccion-header">
                        <span class="kanban-seccion-label"><i class="fab fa-trello"></i> Tablero del cliente</span>
                        <button class="btn-secondary btn-sm" id="wcl-add-list" type="button">
                            <i class="fas fa-plus"></i> Nueva lista
                        </button>
                    </div>
                    <div class="kanban-board" id="worker-board" style="margin-top:10px;"></div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('worker-modal-cerrar').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    document.getElementById('wcl-guardar').addEventListener('click', guardarContactoCliente);
    document.getElementById('wcl-add-list').addEventListener('click', agregarLista);
    document.getElementById('wcl-email').addEventListener('change', () => {
        mostrarToast('Si cambias el email, el cliente quedará bajo el nuevo correo en Mis Clientes', 'warning');
    });

    renderBoard();
}

async function guardarContactoCliente() {
    const supabase = window.supabaseClient;
    if (!supabase || !_clienteActual) return;
    const nombre = document.getElementById('wcl-nombre').value.trim();
    const telefono = document.getElementById('wcl-telefono').value.trim();
    const emailNuevo = document.getElementById('wcl-email').value.trim().toLowerCase();
    if (!nombre || !emailNuevo) {
        mostrarToast('Nombre y email son obligatorios', 'warning');
        return;
    }
    const btn = document.getElementById('wcl-guardar');
    btn.disabled = true;
    const { data, error } = await supabase.rpc('worker_editar_contacto_cliente', {
        p_tenant_id: _wpTenantId,
        p_worker_id: _wpWorkerId,
        p_email_actual: _clienteActual.email,
        p_nombre: nombre,
        p_telefono: telefono,
        p_email_nuevo: emailNuevo
    });
    btn.disabled = false;
    if (error || !data || data.ok !== true) {
        mostrarToast((data && data.error) || 'No se pudo guardar el contacto', 'error');
        return;
    }
    _clienteActual.nombre = nombre;
    _clienteActual.telefono = telefono;
    _clienteActual.email = emailNuevo;
    mostrarToast(`Contacto actualizado (${data.citas_actualizadas || 0} reserva(s))`, 'success');
}

async function agregarLista() {
    const titulo = window.prompt('Nombre de la nueva lista:');
    if (!titulo || !titulo.trim()) return;
    const supabase = window.supabaseClient;
    const { data, error } = await supabase.rpc('worker_add_list', {
        p_tenant_id: _wpTenantId,
        p_worker_id: _wpWorkerId,
        p_cliente_email: _clienteActual.email,
        p_titulo: titulo.trim()
    });
    if (error || !data || data.ok !== true) {
        mostrarToast((data && data.error) || 'No se pudo crear la lista', 'error');
        return;
    }
    await recargarBoard();
}

function renderBoard() {
    const boardEl = document.getElementById('worker-board');
    if (!boardEl) return;

    const lists = (_boardData && _boardData.lists) || [];
    if (!lists.length) {
        boardEl.innerHTML = `
            <div class="empty-state" style="padding:24px;">
                <i class="fab fa-trello" style="font-size:1.6rem;opacity:0.3;"></i>
                <p style="margin-top:8px;">Aún no hay tablero para este cliente. Crea la primera lista con el botón "Nueva lista".</p>
            </div>
        `;
        return;
    }

    boardEl.innerHTML = `
        <div style="display:flex;gap:12px;overflow-x:auto;padding-bottom:8px;align-items:flex-start;">
            ${lists.map(l => `
                <div class="kanban-list" style="min-width:250px;max-width:280px;flex:0 0 auto;">
                    <div class="kanban-list-header">
                        <strong>${escapeHtml(l.titulo)}</strong>
                        <span style="opacity:0.5;font-size:0.75rem;">${(l.cards || []).length}</span>
                    </div>
                    <div class="kanban-list-cards">
                        ${(l.cards || []).map(c => `
                            <div class="kanban-card" role="button" tabindex="0" data-card-id="${c.id}" title="Editar tarjeta">
                                <div class="kanban-card-titulo">${escapeHtml(c.titulo || 'Sin título')}</div>
                                ${(c.etiquetas && c.etiquetas.length) ? `<div class="kanban-card-chips">${c.etiquetas.map(et => `<span class="kanban-card-badge" style="background:${et.color || '#9d4edd'}">${escapeHtml(et.nombre || et.clave || '')}</span>`).join('')}</div>` : ''}
                                ${(c.checklists && c.checklists.length) ? `<div style="opacity:0.6;font-size:0.72rem;margin-top:4px;"><i class="fas fa-list-check"></i> ${c.checklists.reduce((n, ch) => n + (ch.items || []).length, 0)} ítems</div>` : ''}
                            </div>
                        `).join('')}
                        <button class="kanban-add-card" data-list-id="${l.id}" type="button">
                            <i class="fas fa-plus"></i> Agregar tarjeta
                        </button>
                    </div>
                </div>
            `).join('')}
        </div>
    `;

    boardEl.querySelectorAll('.kanban-card').forEach(card => {
        const abrir = () => abrirModalTarjeta(card.dataset.cardId);
        card.addEventListener('click', abrir);
        card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir(); } });
    });
    boardEl.querySelectorAll('.kanban-add-card').forEach(btn => {
        btn.addEventListener('click', () => crearTarjeta(btn.dataset.listId));
    });
}

async function crearTarjeta(listId) {
    const titulo = window.prompt('Título de la nueva tarjeta:');
    if (!titulo || !titulo.trim()) return;
    const supabase = window.supabaseClient;
    const { data, error } = await supabase.rpc('worker_guardar_tarjeta', {
        p_tenant_id: _wpTenantId,
        p_worker_id: _wpWorkerId,
        p_card_id: null,
        p_list_id: listId,
        p_titulo: titulo.trim(),
        p_descripcion: '',
        p_etiquetas: [],
        p_cita_id: null
    });
    if (error || !data || data.ok !== true) {
        mostrarToast((data && data.error) || 'No se pudo crear la tarjeta', 'error');
        return;
    }
    await recargarBoard();
}

async function recargarBoard() {
    const supabase = window.supabaseClient;
    const { data, error } = await supabase.rpc('worker_get_board', {
        p_tenant_id: _wpTenantId,
        p_worker_id: _wpWorkerId,
        p_cliente_email: _clienteActual.email
    });
    if (!error && data && !data.error) {
        _boardData = data;
        renderBoard();
    }
}

// ========== MODAL TARJETA ==========

let _tarjetaActual = null;

async function abrirModalTarjeta(cardId) {
    const supabase = window.supabaseClient;
    const lists = (_boardData && _boardData.lists) || [];
    let card = null;
    lists.forEach(l => {
        const c = (l.cards || []).find(x => String(x.id) === String(cardId));
        if (c) card = { ...c, listaId: l.id, listaTitulo: l.titulo };
    });
    if (!card) return;
    _tarjetaActual = card;

    const existente = document.getElementById('worker-card-modal');
    if (existente) existente.remove();

    const etiquetaActual = (card.etiquetas && card.etiquetas[0]) || null;

    const overlay = document.createElement('div');
    overlay.id = 'worker-card-modal';
    overlay.className = 'kanban-card-overlay';
    overlay.style.zIndex = '2100';
    overlay.innerHTML = `
        <div class="kanban-card-modal" style="max-width:560px;width:94%;max-height:90vh;overflow-y:auto;">
            <header class="kanban-card-modal-header">
                <h4><i class="fas fa-sticky-note"></i> Tarjeta</h4>
                <button class="kanban-btn-close" id="wcm-cerrar" title="Cerrar">&times;</button>
            </header>
            <div class="kanban-card-body">
                <label class="kanban-seccion-label">Título</label>
                <input id="wcm-titulo" class="kanban-nueva-card-input" value="${escapeAttr(card.titulo || '')}" placeholder="Título">

                <label class="kanban-seccion-label" style="margin-top:10px;">Descripción</label>
                <textarea id="wcm-descripcion" class="kanban-nueva-card-input" rows="3" placeholder="Descripción...">${escapeHtml(card.descripcion || '')}</textarea>

                <label class="kanban-seccion-label" style="margin-top:10px;">Estado de pago</label>
                <div class="kanban-etiquetas" id="wcm-etiquetas">
                    <button type="button" class="kanban-chip-btn ${!etiquetaActual ? 'activa' : ''}" data-clave="" style="--chip-color:#888;">
                        <span class="kanban-chip-dot" style="background:#888;"></span> Sin etiqueta
                    </button>
                    ${ETIQUETAS_PAGO.map(et => `
                        <button type="button" class="kanban-chip-btn ${etiquetaActual && etiquetaActual.clave === et.clave ? 'activa' : ''}" data-clave="${et.clave}" style="--chip-color:${et.color}">
                            <span class="kanban-chip-dot" style="background:${et.color}"></span> ${et.nombre}
                        </button>
                    `).join('')}
                </div>

                <label class="kanban-seccion-label" style="margin-top:10px;">Mover a lista</label>
                <select id="wcm-lista" class="kanban-nueva-card-input">
                    ${lists.map(l => `<option value="${l.id}" ${String(l.id) === String(card.listaId) ? 'selected' : ''}>${escapeHtml(l.titulo)}</option>`).join('')}
                </select>

                <label class="kanban-seccion-label" style="margin-top:10px;">Vincular a mi reserva (sincroniza el estado de pago en Citas Programadas)</label>
                <select id="wcm-cita" class="kanban-nueva-card-input">
                    <option value="">— Sin vincular —</option>
                    ${(_clienteActual.citas || []).map(c => `
                        <option value="${escapeAttr(c.cita_id || '')}" ${String(card.cita_id || '') === String(c.cita_id || '') ? 'selected' : ''}>
                            ${c.fecha ? c.fecha + ' ' : ''}${c.hora || ''} — ${escapeHtml(c.servicio || '')}
                        </option>
                    `).join('')}
                </select>

                <label class="kanban-seccion-label" style="margin-top:12px;">Checklists</label>
                <div class="kanban-checklists" id="wcm-checklists"></div>
                <button class="kanban-add-checklist-btn" id="wcm-add-checklist" type="button">
                    <i class="fas fa-plus"></i> Agregar checklist
                </button>

                <div style="display:flex;gap:8px;margin-top:14px;">
                    <button class="btn-primary" id="wcm-guardar" style="flex:1;padding:10px;">
                        <i class="fas fa-save"></i> Guardar cambios
                    </button>
                    <button class="btn-secondary" id="wcm-cancelar" type="button" style="padding:10px 16px;">Cancelar</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('wcm-cerrar').addEventListener('click', cerrarModalTarjeta);
    document.getElementById('wcm-cancelar').addEventListener('click', cerrarModalTarjeta);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cerrarModalTarjeta(); });

    // Etiquetas (excluyentes)
    overlay.querySelectorAll('#wcm-etiquetas .kanban-chip-btn').forEach(chip => {
        chip.addEventListener('click', () => {
            overlay.querySelectorAll('#wcm-etiquetas .kanban-chip-btn').forEach(c => c.classList.remove('activa'));
            chip.classList.add('activa');
        });
    });

    document.getElementById('wcm-add-checklist').addEventListener('click', agregarChecklistTarjeta);
    document.getElementById('wcm-guardar').addEventListener('click', guardarTarjeta);

    renderChecklistsTarjeta(card);
}

function renderChecklistsTarjeta(card) {
    const cont = document.getElementById('wcm-checklists');
    if (!cont) return;
    const checklists = card.checklists || [];
    if (!checklists.length) {
        cont.innerHTML = '<p style="opacity:0.4;font-size:0.8rem;">Sin checklists aún.</p>';
        return;
    }
    cont.innerHTML = checklists.map(ch => `
        <div class="kanban-checklist" style="margin-top:8px;">
            <div class="kanban-checklist-header">
                <strong style="font-size:0.85rem;">${escapeHtml(ch.titulo || 'Checklist')}</strong>
            </div>
            <div class="kanban-checklist-items">
                ${(ch.items || []).map(it => `
                    <label class="kanban-checklist-item" style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                        <input type="checkbox" data-item-id="${it.id}" ${it.completado ? 'checked' : ''} style="accent-color:#9d4edd;">
                        <span style="${it.completado ? 'text-decoration:line-through;opacity:0.5;' : ''}">${escapeHtml(it.texto)}</span>
                    </label>
                `).join('')}
            </div>
            <div style="display:flex;gap:6px;margin-top:6px;">
                <input class="kanban-nueva-card-input" data-add-item="${ch.id}" placeholder="Agregar ítem..." style="font-size:0.8rem;">
                <button class="btn-secondary btn-sm" data-add-item-btn="${ch.id}" type="button"><i class="fas fa-plus"></i></button>
            </div>
        </div>
    `).join('');

    cont.querySelectorAll('input[type="checkbox"][data-item-id]').forEach(cb => {
        cb.addEventListener('change', async () => {
            const supabase = window.supabaseClient;
            const { data, error } = await supabase.rpc('worker_toggle_checklist_item', {
                p_tenant_id: _wpTenantId,
                p_worker_id: _wpWorkerId,
                p_item_id: cb.dataset.itemId,
                p_completado: cb.checked
            });
            if (error || !data || data.ok !== true) {
                mostrarToast((data && data.error) || 'No se pudo actualizar el ítem', 'error');
                cb.checked = !cb.checked;
            } else {
                cb.closest('label').querySelector('span').style.textDecoration = cb.checked ? 'line-through' : 'none';
                cb.closest('label').querySelector('span').style.opacity = cb.checked ? '0.5' : '1';
            }
        });
    });

    cont.querySelectorAll('[data-add-item-btn]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const chId = btn.dataset.addItemBtn;
            const input = cont.querySelector(`[data-add-item="${chId}"]`);
            const texto = (input.value || '').trim();
            if (!texto) return;
            const supabase = window.supabaseClient;
            const { data, error } = await supabase.rpc('worker_add_checklist_item', {
                p_tenant_id: _wpTenantId,
                p_worker_id: _wpWorkerId,
                p_card_id: _tarjetaActual.id,
                p_checklist_id: chId,
                p_texto: texto
            });
            if (error || !data || data.ok !== true) {
                mostrarToast((data && data.error) || 'No se pudo agregar el ítem', 'error');
                return;
            }
            input.value = '';
            _tarjetaActual = await recargarTarjetaActual();
            renderChecklistsTarjeta(_tarjetaActual);
        });
    });
}

async function agregarChecklistTarjeta() {
    const titulo = window.prompt('Nombre del checklist:') || 'Checklist';
    const supabase = window.supabaseClient;
    const { data, error } = await supabase.rpc('worker_add_checklist', {
        p_tenant_id: _wpTenantId,
        p_worker_id: _wpWorkerId,
        p_card_id: _tarjetaActual.id,
        p_titulo: titulo.trim()
    });
    if (error || !data || data.ok !== true) {
        mostrarToast((data && data.error) || 'No se pudo crear el checklist', 'error');
        return;
    }
    _tarjetaActual = await recargarTarjetaActual();
    renderChecklistsTarjeta(_tarjetaActual);
}

async function recargarTarjetaActual() {
    const supabase = window.supabaseClient;
    const { data, error } = await supabase.rpc('worker_get_board', {
        p_tenant_id: _wpTenantId,
        p_worker_id: _wpWorkerId,
        p_cliente_email: _clienteActual.email
    });
    if (error || !data || data.error) return _tarjetaActual;
    _boardData = data;
    const lists = data.lists || [];
    let card = null;
    lists.forEach(l => {
        const c = (l.cards || []).find(x => String(x.id) === String(_tarjetaActual.id));
        if (c) card = { ...c, listaId: l.id, listaTitulo: l.titulo };
    });
    return card || _tarjetaActual;
}

async function guardarTarjeta() {
    const supabase = window.supabaseClient;
    const titulo = document.getElementById('wcm-titulo').value.trim();
    const descripcion = document.getElementById('wcm-descripcion').value.trim();
    const listaId = document.getElementById('wcm-lista').value;
    const citaId = document.getElementById('wcm-cita').value;

    const chipActiva = document.querySelector('#wcm-etiquetas .kanban-chip-btn.activa');
    const clave = chipActiva ? chipActiva.dataset.clave : '';
    const etiqueta = ETIQUETAS_PAGO.find(e => e.clave === clave);
    const etiquetas = etiqueta ? [etiqueta] : [];

    if (!titulo) {
        mostrarToast('El título es obligatorio', 'warning');
        return;
    }

    const btn = document.getElementById('wcm-guardar');
    btn.disabled = true;

    // Si cambió de lista, mover primero
    if (String(listaId) !== String(_tarjetaActual.listaId)) {
        await supabase.rpc('worker_mover_tarjeta', {
            p_tenant_id: _wpTenantId,
            p_worker_id: _wpWorkerId,
            p_card_id: _tarjetaActual.id,
            p_list_id: listaId,
            p_posicion: 0
        });
    }

    const { data, error } = await supabase.rpc('worker_guardar_tarjeta', {
        p_tenant_id: _wpTenantId,
        p_worker_id: _wpWorkerId,
        p_card_id: _tarjetaActual.id,
        p_list_id: listaId,
        p_titulo: titulo,
        p_descripcion: descripcion,
        p_etiquetas: etiquetas,
        p_cita_id: citaId || null
    });
    btn.disabled = false;

    if (error || !data || data.ok !== true) {
        mostrarToast((data && data.error) || 'No se pudo guardar la tarjeta', 'error');
        return;
    }

    _tarjetaActual = null;
    cerrarModalTarjeta();
    await recargarBoard();
    mostrarToast('Tarjeta guardada', 'success');
}

function cerrarModalTarjeta() {
    const m = document.getElementById('worker-card-modal');
    if (m) m.remove();
}

// ========== HELPERS ==========

function formatTime(hora) {
    if (!hora) return '--:--';
    const partes = hora.split(':');
    if (partes.length < 2) return hora;
    return `${partes[0]}:${partes[1]}`;
}

// Local: trabajador.html NO carga legacy.js, así que escapeHtml no existe
// como global aquí (evita ReferenceError al renderizar citas).
function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fechaLocalStr(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function formatFechaReserva(fechaStr) {
    const hoy = new Date();
    const hoyStr = fechaLocalStr(hoy);
    const manana = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + 1);
    const mananaStr = fechaLocalStr(manana);
    if (fechaStr === hoyStr) return 'Hoy';
    if (fechaStr === mananaStr) return 'Mañana';
    const d = new Date(fechaStr + 'T12:00:00');
    return d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
}
