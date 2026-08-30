// clients/ui/AgregarClienteModal.js
// Modal "Agregar cliente" (Mis Clientes → admin):
// - Datos de contacto: nombre, teléfono, correo. La dirección solo
//   se pide cuando el negocio atiende a domicilio
//   (tenant_config.ubicacion_tipo === 'domicilio' — misma regla que
//   la reserva del cliente, script.js abrirModalReserva).
// - Sección opcional "Asignar reserva": servicio, fecha (con día de la
//   semana y fechas agotadas deshabilitadas, igual que la reserva del
//   cliente), hora (con cupos) y trabajador opcional. La cita se crea
//   con el RPC reservar_cita (valida cupos y trabajador, descuenta y
//   notifica al admin — mismo flujo que el catálogo del cliente).
// - El cliente se guarda con el RPC admin_agregar_cliente (upsert por
//   email del tenant, SECURITY DEFINER). Los clientes manuales quedan
//   SIEMPRE visibles hasta que el admin los borre (exentos del filtro
//   de 3 meses sin reservar, que solo aplica a clientes derivados).
// - PROTECCIÓN DE DATOS: la información ingresada solo se descarta si
//   el usuario cancela explícitamente (botón Cancelar / ×) o si el
//   cliente se crea. Tocar fuera (o Escape) con datos sin guardar pide
//   confirmación antes de cerrar; sin datos, cierra directo.

import { getCurrentTenantId } from '../../shared/infrastructure/router.js';
import { getSupabase } from '../../shared/infrastructure/supabase.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { getVisualConfig } from '../../visual-config/application/VisualConfigService.js';
import { getAllServicios } from '../../api/serviciosApi.js';
import { getFechasDisponibles, getHorariosDisponibles } from '../../catalog/application/CatalogService.js';
import { formatearDinero, formatTimeDisplay } from '../../shared/infrastructure/formatters.js';

// Estilo base de inputs/selects (coherente con los overlays dinámicos del panel admin)
const INPUT_STYLE = 'width:100%;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.10);color:var(--text-color,#e0e0e0);box-sizing:border-box;font-size:0.9rem;outline:none;transition:border-color .15s ease, box-shadow .15s ease;';
const LABEL_STYLE = 'display:flex;align-items:center;gap:6px;font-size:0.78rem;color:var(--text-muted,#aaa);margin-bottom:6px;letter-spacing:0.02em;';
const CARD_STYLE = 'border-radius:12px;border:1px solid rgba(255,255,255,0.06);background:linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01));padding:14px 14px 4px;margin-bottom:14px;';

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** "31-08-2026 lunes" — mismo formato que la reserva del cliente (script.js formatFechaConDiaSemana). */
function formatFechaConDiaSemana(dateStr) {
    try {
        const [y, m, d] = String(dateStr).split('-').map(Number);
        const date = new Date(Date.UTC(y, m - 1, d, 12));
        const dd = String(date.getUTCDate()).padStart(2, '0');
        const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
        const yyyy = date.getUTCFullYear();
        const diaSemana = date.toLocaleDateString('es-ES', { weekday: 'long', timeZone: 'UTC' });
        return `${dd}-${mm}-${yyyy} ${diaSemana}`;
    } catch (e) {
        return dateStr;
    }
}

/**
 * Abre el modal "Agregar cliente".
 * @param {object} opts
 * @param {Function} [opts.onGuardado] callback tras guardar (para refrescar la lista)
 */
export async function abrirModalAgregarCliente({ onGuardado } = {}) {
    const tenantId = await getCurrentTenantId();
    if (!tenantId) { mostrarToast('No se pudo identificar el negocio', 'error'); return; }

    // 1) ¿El negocio atiende a domicilio? → el formulario pide dirección (obligatoria).
    let exigeDireccion = false;
    try {
        const cfg = await getVisualConfig(tenantId);
        exigeDireccion = cfg.ubicacion_tipo === 'domicilio';
    } catch (e) {
        console.warn('[AgregarCliente] Error leyendo config visual:', e);
    }

    // 2) Servicios con horarios (solo estos se pueden asignar como reserva).
    let servicios = [];
    try {
        servicios = (await getAllServicios(tenantId)) || [];
    } catch (e) {
        console.warn('[AgregarCliente] Error cargando servicios:', e);
    }
    const serviciosConHorarios = servicios.filter(s => s && s.disponibilidad && Object.keys(s.disponibilidad).length > 0);

    // Estado del modal
    const state = { tenantId, servicio: null, fecha: '', hora: '', trabajadorId: '' };

    // ========== HTML ==========
    const overlay = document.createElement('div');
    overlay.className = 'kanban-card-overlay';
    overlay.style.zIndex = '2400';
    overlay.innerHTML = `
        <div class="agregar-cliente-modal glass-panel" style="max-width:560px;width:94%;max-height:94vh;overflow-y:auto;padding:0;border-radius:16px;">
            <header style="display:flex;align-items:center;gap:14px;padding:18px 22px;border-bottom:1px solid rgba(255,255,255,0.08);position:sticky;top:0;background:linear-gradient(135deg, rgba(157,78,221,0.16), rgba(0,184,148,0.06));z-index:1;border-radius:16px 16px 0 0;">
                <div style="width:42px;height:42px;border-radius:12px;background:linear-gradient(135deg,var(--primary-color,#9d4edd),#7b2cbf);display:flex;align-items:center;justify-content:center;color:#fff;font-size:1.15rem;flex-shrink:0;box-shadow:0 4px 14px rgba(157,78,221,0.35);">
                    <i class="fas fa-user-plus"></i>
                </div>
                <div style="flex:1;min-width:0;">
                    <h4 style="margin:0;font-size:1.05rem;"><strong>Agregar cliente</strong></h4>
                    <p style="margin:2px 0 0;font-size:0.78rem;color:var(--text-muted,#aaa);">Importa clientes que ya tenías antes de la web</p>
                </div>
                <button class="kanban-btn-close" id="ac-cerrar" title="Cerrar (cancela sin guardar)">&times;</button>
            </header>

            <div style="padding:18px 22px;">

                <p style="margin:0 0 14px;font-size:0.8rem;color:var(--text-muted,#aaa);display:flex;gap:8px;align-items:flex-start;">
                    <i class="fas fa-shield-alt" style="margin-top:2px;color:var(--primary-color,#9d4edd);"></i>
                    <span>Su información se conserva para siempre: solo se borra si tú la eliminas. Si tocas fuera sin guardar, te preguntaremos antes de descartar lo escrito.</span>
                </p>

                <!-- ===== DATOS DE CONTACTO ===== -->
                <div style="${CARD_STYLE}">
                    <div class="form-group" style="margin-bottom:12px;">
                        <label style="${LABEL_STYLE}"><i class="fas fa-user" style="color:var(--primary-color,#9d4edd);"></i> Nombre <span style="color:#ff4949;">*</span></label>
                        <input id="ac-nombre" type="text" placeholder="Nombre del cliente" style="${INPUT_STYLE}">
                    </div>
                    <div class="form-group" style="margin-bottom:12px;">
                        <label style="${LABEL_STYLE}"><i class="fas fa-phone-alt" style="color:var(--primary-color,#9d4edd);"></i> Número de teléfono <span style="color:#ff4949;">*</span></label>
                        <input id="ac-telefono" type="tel" placeholder="Ej: +56 9 1234 5678" style="${INPUT_STYLE}">
                    </div>
                    <div class="form-group" style="margin-bottom:12px;">
                        <label style="${LABEL_STYLE}"><i class="fas fa-envelope" style="color:var(--primary-color,#9d4edd);"></i> Correo electrónico <span style="color:#ff4949;">*</span></label>
                        <input id="ac-email" type="email" placeholder="cliente@correo.com" style="${INPUT_STYLE}">
                    </div>
                    ${exigeDireccion ? `
                    <div class="form-group" style="margin-bottom:12px;">
                        <label style="${LABEL_STYLE}"><i class="fas fa-map-marker-alt" style="color:var(--primary-color,#9d4edd);"></i> Dirección del domicilio <span style="color:#ff4949;">*</span></label>
                        <input id="ac-direccion" type="text" placeholder="Calle, número, ciudad, referencia" style="${INPUT_STYLE}">
                        <span style="display:block;font-size:0.72rem;color:var(--text-muted,#aaa);margin-top:5px;">El negocio va al domicilio del cliente: escribe su dirección.</span>
                    </div>` : ''}
                </div>

                <!-- ===== RESERVA ===== -->
                <div style="${CARD_STYLE}">
                    ${serviciosConHorarios.length ? `
                    <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:0.88rem;margin-bottom:4px;padding:2px 0 12px;">
                        <input type="checkbox" id="ac-asignar-reserva" checked style="accent-color:#9d4edd;width:17px;height:17px;">
                        <span><i class="fas fa-calendar-plus" style="color:var(--primary-color,#9d4edd);"></i> <strong>Asignar reserva de un servicio</strong></span>
                    </label>
                    <div id="ac-reserva-section">
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                            <div class="form-group" style="margin-bottom:12px;grid-column:1 / -1;">
                                <label style="${LABEL_STYLE}"><i class="fas fa-tag" style="color:var(--primary-color,#9d4edd);"></i> Servicio <span style="color:#ff4949;">*</span></label>
                                <select id="ac-servicio" style="${INPUT_STYLE}">
                                    <option value="">Selecciona un servicio...</option>
                                    ${serviciosConHorarios.map(s => `<option value="${s.id}">${escapeHtml(s.nombre)} · ${formatearDinero(s.precio)}</option>`).join('')}
                                </select>
                            </div>
                            <div class="form-group" style="margin-bottom:12px;display:none;" id="ac-fecha-group">
                                <label style="${LABEL_STYLE}"><i class="fas fa-calendar-day" style="color:var(--primary-color,#9d4edd);"></i> Fecha <span style="color:#ff4949;">*</span></label>
                                <select id="ac-fecha" style="${INPUT_STYLE}"><option value="">Selecciona una fecha...</option></select>
                            </div>
                            <div class="form-group" style="margin-bottom:12px;display:none;" id="ac-hora-group">
                                <label style="${LABEL_STYLE}"><i class="fas fa-clock" style="color:var(--primary-color,#9d4edd);"></i> Hora <span style="color:#ff4949;">*</span></label>
                                <select id="ac-hora" style="${INPUT_STYLE}"><option value="">Selecciona una hora...</option></select>
                            </div>
                            <div class="form-group" style="margin-bottom:12px;display:none;grid-column:1 / -1;" id="ac-trabajador-group">
                                <label style="${LABEL_STYLE}"><i class="fas fa-user-friends" style="color:var(--primary-color,#9d4edd);"></i> Trabajador (opcional)</label>
                                <select id="ac-trabajador" style="${INPUT_STYLE}">
                                    <option value="">Sin asignar</option>
                                </select>
                            </div>
                        </div>
                        <div id="ac-resumen" style="display:none;margin:2px 0 12px;padding:10px 12px;border-radius:10px;background:rgba(157,78,221,0.08);border:1px solid rgba(157,78,221,0.18);font-size:0.82rem;color:var(--text-color,#e0e0e0);"></div>
                    </div>` : `
                    <p style="margin:0;font-size:0.82rem;color:var(--text-muted,#aaa);display:flex;gap:8px;align-items:flex-start;">
                        <i class="fas fa-info-circle" style="margin-top:2px;"></i>
                        <span>No hay servicios con horarios configurados para asignar una reserva. El cliente se guardará sin reserva.</span>
                    </p>`}
                </div>
            </div>

            <footer style="display:flex;gap:10px;justify-content:flex-end;padding:14px 22px;border-top:1px solid rgba(255,255,255,0.08);position:sticky;bottom:0;background:var(--card-bg,#1a1a2e);border-radius:0 0 16px 16px;">
                <button class="btn-secondary" id="ac-cancelar">Cancelar</button>
                <button class="btn-primary" id="ac-guardar" style="padding:10px 18px;"><i class="fas fa-save"></i> Guardar cliente</button>
            </footer>
        </div>
    `;
    document.body.appendChild(overlay);

    const $ = (id) => overlay.querySelector('#' + id);

    // ========== CIERRE CON PROTECCIÓN DE DATOS ==========
    let cerrado = false;
    function formTieneDatos() {
        const vals = ['ac-nombre', 'ac-telefono', 'ac-email', 'ac-direccion']
            .map(id => { const el = $(id); return el ? (el.value || '').trim() : ''; });
        if (vals.some(v => v !== '')) return true;
        return Boolean(state.servicio || state.fecha || state.hora || state.trabajadorId);
    }
    function cerrar() {
        if (cerrado) return;
        cerrado = true;
        document.removeEventListener('keydown', escHandler);
        overlay.remove();
    }
    // Tocar fuera: sin datos cierra directo; con datos pide confirmación.
    overlay.addEventListener('mousedown', (e) => {
        if (e.target !== overlay) return;
        if (formTieneDatos()) {
            if (!window.confirm('Hay información sin guardar. ¿Descartarla? El cliente no se creará.')) return;
        }
        cerrar();
    });
    function escHandler(e) {
        if (e.key !== 'Escape') return;
        if (formTieneDatos()) {
            if (!window.confirm('Hay información sin guardar. ¿Descartarla? El cliente no se creará.')) return;
        }
        cerrar();
    }
    document.addEventListener('keydown', escHandler);

    // Cancelar explícito (× o botón) → cierra siempre, es una cancelación consciente.
    $('ac-cerrar').addEventListener('click', cerrar);
    $('ac-cancelar').addEventListener('click', cerrar);

    // ========== Sección reserva ==========
    const reservaCheckbox = $('ac-asignar-reserva');
    const reservaSection = $('ac-reserva-section');
    if (reservaCheckbox && reservaSection) {
        reservaCheckbox.addEventListener('change', () => {
            reservaSection.style.display = reservaCheckbox.checked ? 'block' : 'none';
        });
    }

    function actualizarResumen() {
        const el = $('ac-resumen');
        if (!el) return;
        if (state.fecha && state.hora) {
            el.style.display = 'block';
            el.innerHTML = `<i class="fas fa-calendar-check" style="margin-right:4px;"></i> Reservarás para el <strong>${formatFechaConDiaSemana(state.fecha)}</strong> a las <strong>${formatTimeDisplay(state.hora)}</strong>.`;
        } else {
            el.style.display = 'none';
        }
    }

    async function cargarTrabajadores(servicioId) {
        const grupo = $('ac-trabajador-group');
        const select = $('ac-trabajador');
        if (!grupo || !select) return;
        try {
            const { data, error } = await getSupabase().rpc('get_trabajadores_servicio_publico', {
                p_servicio_id: Number(servicioId),
                p_tenant_id: state.tenantId
            });
            const trabajadores = (!error && Array.isArray(data)) ? data : [];
            if (!trabajadores.length) {
                grupo.style.display = 'none';
                select.innerHTML = '<option value="">Sin asignar</option>';
                return;
            }
            select.innerHTML = '<option value="">Sin asignar</option>' + trabajadores.map(t =>
                `<option value="${t.id}">${escapeHtml(t.nombre)}</option>`
            ).join('');
            grupo.style.display = 'block';
        } catch (e) {
            console.warn('[AgregarCliente] Error cargando trabajadores:', e);
            grupo.style.display = 'none';
        }
    }

    function cargarFechas(servicio) {
        const grupo = $('ac-fecha-group');
        const select = $('ac-fecha');
        const fechas = getFechasDisponibles(servicio);
        if (!fechas.length) {
            select.innerHTML = '<option value="">Sin fechas disponibles</option>';
        } else {
            select.innerHTML = '<option value="">Selecciona una fecha...</option>' + fechas.map(f => {
                const modulos = (servicio.disponibilidad && servicio.disponibilidad[f]) || [];
                const agotada = modulos.length > 0 && modulos.every(m => (Number(m.cupos || 0) <= 0));
                return `<option value="${f}" ${agotada ? 'disabled' : ''}>${formatFechaConDiaSemana(f)}${agotada ? ' (Agotada)' : ''}</option>`;
            }).join('');
        }
        grupo.style.display = 'block';
        $('ac-hora-group').style.display = 'none';
        $('ac-hora').innerHTML = '<option value="">Selecciona una hora...</option>';
        state.fecha = '';
        state.hora = '';
        actualizarResumen();
    }

    function cargarHoras(servicio, fecha) {
        const grupo = $('ac-hora-group');
        const select = $('ac-hora');
        const horas = getHorariosDisponibles(servicio, fecha);
        if (!horas.length) {
            select.innerHTML = '<option value="">Sin horarios disponibles</option>';
        } else {
            select.innerHTML = '<option value="">Selecciona una hora...</option>' + horas.map(h => {
                const horaVal = h.hora || h.startTime;
                const cupos = Number(h.cupos || 0);
                const etiqueta = cupos > 1
                    ? `${formatTimeDisplay(horaVal)} · ${cupos} cupos`
                    : `${formatTimeDisplay(horaVal)} · 1 cupo`;
                return `<option value="${escapeHtml(horaVal)}">${etiqueta}</option>`;
            }).join('');
        }
        grupo.style.display = 'block';
        state.hora = '';
        actualizarResumen();
    }

    const servicioSelect = $('ac-servicio');
    if (servicioSelect) {
        servicioSelect.addEventListener('change', async () => {
            const id = servicioSelect.value;
            state.servicio = serviciosConHorarios.find(s => String(s.id) === String(id)) || null;
            state.fecha = ''; state.hora = ''; state.trabajadorId = '';
            $('ac-fecha-group').style.display = 'none';
            $('ac-hora-group').style.display = 'none';
            actualizarResumen();
            if (state.servicio) {
                cargarFechas(state.servicio);
                await cargarTrabajadores(state.servicio.id);
            }
        });
    }

    const fechaSelect = $('ac-fecha');
    if (fechaSelect) {
        fechaSelect.addEventListener('change', () => {
            state.fecha = fechaSelect.value;
            state.hora = '';
            if (state.servicio && state.fecha) cargarHoras(state.servicio, state.fecha);
            else actualizarResumen();
        });
    }

    const horaSelect = $('ac-hora');
    if (horaSelect) {
        horaSelect.addEventListener('change', () => { state.hora = horaSelect.value; actualizarResumen(); });
    }

    const trabajadorSelect = $('ac-trabajador');
    if (trabajadorSelect) {
        trabajadorSelect.addEventListener('change', () => { state.trabajadorId = trabajadorSelect.value; });
    }

    // ========== Guardar ==========
    $('ac-guardar').addEventListener('click', async () => {
        const nombre = ($('ac-nombre').value || '').trim();
        const telefono = ($('ac-telefono').value || '').trim();
        const email = ($('ac-email').value || '').trim();
        const direccionInput = $('ac-direccion');
        const direccion = direccionInput ? (direccionInput.value || '').trim() : '';

        // Validación de contacto
        if (!nombre) { mostrarToast('El nombre del cliente es requerido', 'warning'); return; }
        if (!telefono) { mostrarToast('El número de teléfono es requerido', 'warning'); return; }
        if (!/^\S+@\S+\.\S+$/.test(email)) { mostrarToast('Ingresa un correo electrónico válido', 'warning'); return; }
        if (exigeDireccion && !direccion) { mostrarToast('La dirección es requerida (el negocio atiende a domicilio)', 'warning'); return; }

        // Validación de la reserva (si está activa)
        const asignarReserva = reservaCheckbox ? reservaCheckbox.checked : false;
        if (asignarReserva && serviciosConHorarios.length) {
            if (!state.servicio) { mostrarToast('Selecciona el servicio para la reserva', 'warning'); return; }
            if (!state.fecha) { mostrarToast('Selecciona la fecha de la reserva', 'warning'); return; }
            if (!state.hora) { mostrarToast('Selecciona la hora de la reserva', 'warning'); return; }
        }

        const btn = $('ac-guardar');
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...';

        try {
            // 1) Guardar el cliente (upsert por email del tenant)
            const { data: r, error: e } = await getSupabase().rpc('admin_agregar_cliente', {
                p_tenant_id: state.tenantId,
                p_nombre: nombre,
                p_telefono: telefono,
                p_email: email,
                p_direccion: direccion
            });
            if (e || !r || r.ok !== true) {
                mostrarToast((r && r.error) || (e && e.message) || 'No se pudo guardar el cliente', 'error');
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-save"></i> Guardar cliente';
                return;
            }

            // 2) Asignar la reserva (flujo normal: valida cupos/trabajador, descuenta, notifica al admin)
            let reservaMsg = null;
            if (asignarReserva && serviciosConHorarios.length) {
                const { data: rr, error: re } = await getSupabase().rpc('reservar_cita', {
                    p_tenant_id: state.tenantId,
                    p_servicio_id: Number(state.servicio.id),
                    p_fecha: state.fecha,
                    p_hora: state.hora,
                    p_contacto: { nombre, telefono, email, direccion },
                    p_trabajador_id: state.trabajadorId || null
                });
                if (re || !rr || rr.ok !== true) {
                    reservaMsg = { ok: false, detalle: (rr && rr.error) || (re && re.message) || 'error desconocido' };
                } else {
                    reservaMsg = { ok: true, fecha: rr.fecha, hora: rr.hora };
                }
            }

            cerrar();
            if (typeof onGuardado === 'function') onGuardado();

            if (r.ya_existia) {
                mostrarToast('El cliente ya existía: se actualizaron sus datos de contacto', 'info');
            } else {
                mostrarToast('Cliente agregado correctamente', 'success');
            }
            if (reservaMsg) {
                if (reservaMsg.ok) {
                    mostrarToast(`Reserva asignada: ${formatFechaConDiaSemana(reservaMsg.fecha)} ${formatTimeDisplay(reservaMsg.hora)}`, 'success');
                } else {
                    mostrarToast(`Cliente guardado, pero la reserva no se pudo asignar: ${reservaMsg.detalle}`, 'warning');
                }
            }
        } catch (err) {
            console.error('[AgregarCliente] Error guardando:', err);
            mostrarToast('No se pudo guardar el cliente', 'error');
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-save"></i> Guardar cliente';
        }
    });
}
