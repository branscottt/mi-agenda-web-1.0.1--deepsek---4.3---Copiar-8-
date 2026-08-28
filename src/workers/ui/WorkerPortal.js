// src/workers/ui/WorkerPortal.js
// Página pública del trabajador — sin login, solo con ?id=XXX
// Usa la RPC get_worker_portal_data (SECURITY DEFINER) para leer
// datos sin exponer RLS de citas/trabajadores a anon.

import { getCurrentTenantId } from '../../shared/infrastructure/router.js';
import { getSemanaISO, getHorarioParaSemana } from '../../workers/domain/horarioValidation.js';

export async function initWorkerPortal() {
    const params = new URLSearchParams(window.location.search);
    const workerId = params.get('id');
    const tenantId = params.get('tenant') || await getCurrentTenantId();

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
            const hoyStr = (() => {
                const d = new Date();
                return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
            })();
            const proximas = (data.citas_proximas || []).filter(c => String(c.fecha) !== hoyStr);

            const h3 = reservationsEl.closest('.wp-section')?.querySelector('h3');
            if (h3) h3.textContent = 'Reservas';

            const tarjeta = (c) => `
                <div class="worker-cita-card">
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
        }

    } catch (e) {
        console.error('[WorkerPortal] Error:', e);
        const reservationsEl = document.getElementById('wp-reservas');
        if (reservationsEl) reservationsEl.innerHTML = '<p>Error al cargar datos.</p>';
    }
}

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

function formatFechaReserva(fechaStr) {
    const hoy = new Date();
    const hoyStr = hoy.getFullYear() + '-' + String(hoy.getMonth() + 1).padStart(2, '0') + '-' + String(hoy.getDate()).padStart(2, '0');
    const manana = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + 1);
    const mananaStr = manana.getFullYear() + '-' + String(manana.getMonth() + 1).padStart(2, '0') + '-' + String(manana.getDate()).padStart(2, '0');
    if (fechaStr === hoyStr) return 'Hoy';
    if (fechaStr === mananaStr) return 'Mañana';
    const d = new Date(fechaStr + 'T12:00:00');
    return d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
}
