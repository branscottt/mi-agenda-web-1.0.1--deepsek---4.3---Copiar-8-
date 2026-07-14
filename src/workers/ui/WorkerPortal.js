// src/workers/ui/WorkerPortal.js
// Página pública del trabajador — sin login, solo con ?id=XXX

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

        // Cargar datos del trabajador
        const { data: worker, error: wErr } = await supabase
            .from('trabajadores')
            .select('*')
            .eq('id', workerId)
            .eq('tenant_id', String(tenantId).trim())
            .single();

        if (wErr || !worker) {
            if (nameEl) nameEl.textContent = 'Trabajador no encontrado';
            if (reservationsEl) reservationsEl.innerHTML = '<p>El trabajador no existe o fue desactivado.</p>';
            return;
        }

        // Mostrar info del trabajador
        if (nameEl) nameEl.textContent = worker.nombre;
        if (skillsEl) {
            skillsEl.textContent = worker.habilidades || 'Sin habilidades registradas';
        }

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

        // Cargar reservas de HOY
        const hoy = new Date().toISOString().split('T')[0];
        const { data: citas, error: cErr } = await supabase
            .from('citas')
            .select('*, servicios!inner(nombre)')
            .eq('trabajador_id', workerId)
            .eq('fecha', hoy)
            .order('hora');

        if (reservationsEl) {
            if (cErr || !citas || !citas.length) {
                reservationsEl.innerHTML = `
                    <div class="empty-state" style="padding:20px;">
                        <i class="fas fa-calendar-check" style="font-size:1.5rem;opacity:0.3;"></i>
                        <p style="margin-top:8px;">No tienes reservas para hoy</p>
                    </div>
                `;
            } else {
                reservationsEl.innerHTML = `
                    <div class="worker-citas-list">
                        ${citas.map(c => `
                            <div class="worker-cita-card">
                                <span class="cita-hora">${formatTime(c.hora)}</span>
                                <div class="cita-info">
                                    <strong>${escapeHtml(c.servicios?.nombre || 'Servicio')}</strong>
                                    <span>${escapeHtml(c.contacto?.nombre || 'Cliente')}</span>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                `;
            }
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

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
