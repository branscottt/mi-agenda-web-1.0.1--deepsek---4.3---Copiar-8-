// src/workers/ui/WorkerPortal.js
// Página pública del trabajador — sin login, solo con ?id=XXX
// Usa la RPC get_worker_portal_data (SECURITY DEFINER) para leer
// datos sin exponer RLS de citas/trabajadores a anon.
// Al hacer clic en una reserva abre la información del cliente con
// el MISMO tablero de "Mis Clientes" (ClientBoard.js reutilizado
// vía workerKanbanApi — RPCs worker-scoped): listas, tarjetas con
// drag & drop, checklists, guardar/usar estilo, etiquetas de pago
// sincronizadas con Citas Programadas y contacto editable.
// Adjuntos: solo lectura (metadata) — bucket privado, RLS admin.

import { getCurrentTenantId } from '../../shared/infrastructure/router.js';
import { getSemanaISO, getHorarioParaSemana } from '../../workers/domain/horarioValidation.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { abrirInformacionCliente, configurarClientBoard } from '../../clients/ui/ClientBoard.js';
import * as workerKanbanApi from '../workerKanbanApi.js';
import { abrirMenuEtiquetas, renderChipEtiqueta } from '../../shared/ui/etiquetasPago.js';

// ========== ESTADO ==========

let _wpTenantId = null;
let _wpWorkerId = null;
let _citasDelTrabajador = [];   // [{ cita_id, fecha, hora, servicio, cliente, contacto, estado_pago }]
let _clienteActual = null;      // { email, nombre, telefono }
let _permisoEtiquetas = false;  // ¿el admin permite al trabajador poner etiquetas de pago?

export async function initWorkerPortal() {
    const params = new URLSearchParams(window.location.search);
    const workerId = params.get('id');
    const tenantId = params.get('tenant') || await getCurrentTenantId();

    _wpTenantId = tenantId;
    _wpWorkerId = workerId;

    if (!workerId || !tenantId) {
        const nameEl = document.getElementById('wp-nombre');
        if (nameEl) nameEl.textContent = 'Enlace inválido';
        const reservationsEl = document.getElementById('wp-reservas');
        if (reservationsEl) reservationsEl.innerHTML = '<p>Falta información del trabajador.</p>';
        return;
    }

    // Capa de datos worker-scoped para el tablero (misma interfaz que kanbanApi)
    workerKanbanApi.configurarWorkerKanban(tenantId, workerId);

    // Reutiliza ClientBoard.js tal cual: el RPC worker_guardar_tarjeta ya
    // sincroniza citas.estado_pago, así que updateCita es no-op aquí.
    configurarClientBoard({
        kanbanApi: workerKanbanApi,
        updateCita: async () => {},
        getCurrentTenantId: async () => tenantId,
        adjuntosSoloLectura: true,
        onEditarContacto: () => abrirModalEditarContacto(),
        onCerrarBoard: () => { cargarDatosPortal(); }
    });

    await cargarDatosPortal();
}

async function cargarDatosPortal() {
    const nameEl = document.getElementById('wp-nombre');
    const skillsEl = document.getElementById('wp-habilidades');
    const scheduleEl = document.getElementById('wp-horario');
    const reservationsEl = document.getElementById('wp-reservas');
    const avatarEl = document.getElementById('wp-avatar-inner');
    const inicialEl = document.getElementById('wp-inicial');

    if (!window.supabaseClient) {
        if (reservationsEl) reservationsEl.innerHTML = '<p>Error de conexión.</p>';
        return;
    }

    try {
        const { data, error } = await window.supabaseClient.rpc('get_worker_portal_data', {
            p_tenant_id: String(_wpTenantId).trim(),
            p_worker_id: _wpWorkerId
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
        _permisoEtiquetas = data.permiso_etiquetas === true;

        _citasDelTrabajador = [...citas.map(c => ({ ...c, fecha: '' })), ...citasProximas];

        // Mostrar info del trabajador
        if (nameEl) nameEl.textContent = worker.nombre;
        if (skillsEl) skillsEl.textContent = worker.habilidades || 'Sin habilidades registradas';
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
            renderReservas(reservationsEl, citas, citasProximas);
        }
    } catch (e) {
        console.error('[WorkerPortal] Error:', e);
        const reservationsEl = document.getElementById('wp-reservas');
        if (reservationsEl) reservationsEl.innerHTML = '<p>Error al cargar datos.</p>';
    }
}

function renderReservas(container, citas, citasProximas) {
    const hoyStr = fechaLocalStr(new Date());
    const proximas = citasProximas.filter(c => String(c.fecha) !== hoyStr);

    const h3 = container.closest('.wp-section')?.querySelector('h3');
    if (h3) h3.textContent = 'Reservas';

    const tarjeta = (c) => {
        // Etiqueta de pago del cliente "encima del cliente"; clickeable solo con permiso del admin
        const etiqueta = c.estado_pago
            ? renderChipEtiqueta(c.estado_pago, { clickeable: _permisoEtiquetas })
            : (_permisoEtiquetas ? renderChipEtiqueta(null, { clickeable: true, vacioTexto: 'Marcar pago' }) : '');
        return `
            <div class="worker-cita-card" role="button" tabindex="0"
                 data-cita-id="${escapeAttr(c.cita_id || '')}"
                 data-email="${escapeAttr((c.contacto && c.contacto.email) || '')}"
                 title="Ver información del cliente">
                ${etiqueta ? `<div class="cita-etiqueta" data-email-etiqueta="${escapeAttr((c.contacto && c.contacto.email) || '')}">${etiqueta}</div>` : ''}
                <span class="cita-hora">${formatTime(c.hora)}</span>
                <div class="cita-info">
                    <strong>${escapeHtml(c.servicio || 'Servicio')}</strong>
                    <span>${escapeHtml(c.cliente || 'Cliente')}</span>
                </div>
                <span class="cita-ver"><i class="fas fa-chevron-right"></i></span>
            </div>
        `;
    };

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

    container.innerHTML = html;

    // Clic en una reserva → información del cliente (mismo tablero que Mis Clientes)
    container.querySelectorAll('.worker-cita-card').forEach(card => {
        const abrir = () => {
            const email = card.dataset.email;
            const cita = _citasDelTrabajador.find(c => String(c.cita_id || '') === String(card.dataset.citaId));
            abrirModalCliente(email, cita || {});
        };
        card.addEventListener('click', abrir);
        card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir(); } });

        // Etiqueta de pago (si el admin lo permitió) — no abre la información
        card.querySelectorAll('.cita-etiqueta .etiqueta-pago-chip[role="button"]').forEach(chip => {
            const abrirEtiqueta = (e) => {
                e.stopPropagation();
                const email = chip.closest('.cita-etiqueta').dataset.emailEtiqueta;
                const cita = _citasDelTrabajador.find(c => String(c.cita_id || '') === String(card.dataset.citaId));
                cambiarEtiquetaReserva(email, (cita && cita.estado_pago) || null);
            };
            chip.addEventListener('click', abrirEtiqueta);
            chip.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); abrirEtiqueta(e); }
            });
        });
    });
}

/** Cambia la etiqueta de pago del cliente desde la reserva (RPC worker, requiere permiso). */
function cambiarEtiquetaReserva(email, estadoActual) {
    if (!_permisoEtiquetas) return;
    abrirMenuEtiquetas(estadoActual, async (clave) => {
        try {
            const { data, error } = await window.supabaseClient.rpc('worker_set_estado_pago_cliente', {
                p_tenant_id: _wpTenantId,
                p_worker_id: _wpWorkerId,
                p_cliente_email: email,
                p_estado: clave || ''
            });
            if (error || !data || data.ok !== true) {
                mostrarToast((data && data.error) || 'No se pudo actualizar el estado de pago', 'error');
                return;
            }
            mostrarToast(`Estado de pago actualizado (${data.citas_actualizadas || 0} reserva(s))`, 'success');
            cargarDatosPortal();
        } catch (err) {
            console.error('[WorkerPortal] Error actualizando etiqueta:', err);
            mostrarToast('No se pudo actualizar el estado de pago', 'error');
        }
    });
}

// ========== MODAL CLIENTE ==========
// Abre el MISMO tablero de "Mis Clientes" (ClientBoard.js) con la
// capa de datos worker-scoped. El botón "Editar contacto" del
// header lo gestiona este portal (worker_editar_contacto_cliente).

async function abrirModalCliente(email, cita) {
    const emailLimpio = String(email || '').trim().toLowerCase();
    if (!emailLimpio) {
        mostrarToast('El cliente no tiene email registrado', 'warning');
        return;
    }

    const contacto = (cita && cita.contacto) || {};
    _clienteActual = {
        email: emailLimpio,
        nombre: (cita && cita.cliente) || contacto.nombre || '',
        telefono: contacto.telefono || '',
        estadoPago: (cita && cita.estado_pago) || null
    };

    // Citas del cliente (selector "Vincular a cita programada" del tablero)
    const citasCliente = _citasDelTrabajador
        .filter(c => String((c.contacto && c.contacto.email) || '').trim().toLowerCase() === emailLimpio)
        .map(c => ({ id: c.cita_id, fecha: c.fecha, hora: c.hora, servicio: c.servicio }));

    // Clientes del trabajador (para "Usar estilo → A todos" solo sobre SUS clientes)
    const clientesUnicos = [];
    _citasDelTrabajador.forEach(c => {
        const em = String((c.contacto && c.contacto.email) || '').trim().toLowerCase();
        if (!em) return;
        if (!clientesUnicos.some(x => x.email === em)) {
            clientesUnicos.push({ nombre: (c.contacto && c.contacto.nombre) || c.cliente || '', email: em });
        }
    });

    abrirInformacionCliente(_clienteActual, citasCliente, clientesUnicos);
}

// ========== EDITAR CONTACTO (solo portal; se refleja en Mis Clientes y Citas) ==========

function abrirModalEditarContacto() {
    if (!_clienteActual) return;
    const overlay = document.createElement('div');
    overlay.id = 'worker-contacto-modal';
    overlay.className = 'kanban-card-overlay';
    overlay.style.zIndex = '2200';
    overlay.innerHTML = `
        <div class="kanban-card-modal" style="max-width:480px;width:94%;">
            <header class="kanban-card-modal-header">
                <h4><i class="fas fa-address-book"></i> Editar contacto</h4>
                <button class="kanban-btn-close" id="wcl-cerrar" title="Cerrar">&times;</button>
            </header>
            <div class="kanban-card-form">
                <p class="kanban-hint"><i class="fas fa-info-circle"></i> Los cambios se guardan y se reflejan en <strong>Mis Clientes</strong> y <strong>Citas Programadas</strong>.</p>
                <label class="kanban-seccion-label"><i class="fas fa-user"></i> Nombre completo</label>
                <input type="text" id="wcl-nombre" maxlength="120" value="${escapeAttr(_clienteActual.nombre || '')}" placeholder="Nombre completo">
                <label class="kanban-seccion-label"><i class="fas fa-phone"></i> Teléfono</label>
                <input type="tel" id="wcl-telefono" maxlength="40" value="${escapeAttr(_clienteActual.telefono || '')}" placeholder="Teléfono">
                <label class="kanban-seccion-label"><i class="fas fa-envelope"></i> Email</label>
                <input type="email" id="wcl-email" maxlength="160" value="${escapeAttr(_clienteActual.email)}">
                <p class="kanban-hint" style="margin-top:6px;"><i class="fas fa-info-circle"></i> Si cambias el email, el cliente quedará bajo el nuevo correo en Mis Clientes.</p>
                <div class="kanban-card-actions">
                    <button class="btn-secondary" id="wcl-cancelar">Cancelar</button>
                    <button class="btn-primary" id="wcl-guardar"><i class="fas fa-save"></i> Guardar contacto</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const cerrar = () => overlay.remove();
    document.getElementById('wcl-cerrar').addEventListener('click', cerrar);
    document.getElementById('wcl-cancelar').addEventListener('click', cerrar);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) cerrar(); });
    document.getElementById('wcl-guardar').addEventListener('click', async () => {
        const nombre = document.getElementById('wcl-nombre').value.trim();
        const telefono = document.getElementById('wcl-telefono').value.trim();
        const emailNuevo = document.getElementById('wcl-email').value.trim().toLowerCase();
        if (!nombre || !emailNuevo) {
            mostrarToast('Nombre y email son obligatorios', 'warning');
            return;
        }
        const btn = document.getElementById('wcl-guardar');
        btn.disabled = true;
        const { data, error } = await window.supabaseClient.rpc('worker_editar_contacto_cliente', {
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
        cerrar();
        mostrarToast(`Contacto actualizado (${data.citas_actualizadas || 0} reserva(s))`, 'success');
        // Cerrar el tablero y recargar el portal para reflejar el cambio
        const cerrarBoard = document.getElementById('kanban-cerrar');
        if (cerrarBoard) cerrarBoard.click();
        else cargarDatosPortal();
    });
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
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/\"/g, '&quot;').replace(/'/g, '&#39;');
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
