// src/workers/ui/WorkerScheduleView.js
// Calendario semanal visual con navegación mensual, tarjetas de semana y edición por semana
// - Vista actual: grid semanal de todos los trabajadores
// - Navegación: selector de mes + flechas de semana
// - Edición: por semana (excepción) o plantilla base

import { getAllTrabajadores } from '../application/WorkersService.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { validarHorarioChile, resumenValidacion, getSemanaISO, getHorarioParaSemana, getSemanasDelMes } from '../domain/horarioValidation.js';
import { getCitasByDateRange } from '../../api/appointmentsApi.js';
import { getCurrentTenantId } from '../../shared/infrastructure/router.js';

const DIAS = ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'];
const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

// Estado de navegación
let _workersCache = [];
let _currentDate = new Date(); // inicio de la semana actual
let _currentWeekKey = '';
let _selectedMonth = null; // { year, month } cuando se ve el mes
let _citasCache = {}; // { "workerId_fecha": count }

// ─── RENDER PRINCIPAL ───
export async function renderWorkerSchedule(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = '<div class="loading-spinner"><i class="fas fa-spinner fa-spin"></i> Cargando horarios...</div>';
    _workersCache = await getAllTrabajadores();
    const activos = _workersCache.filter(w => w.activo);
    if (!activos.length) {
        container.innerHTML = '<div class="glass-panel"><div class="empty-state"><i class="fas fa-calendar-times" style="font-size:2rem;opacity:0.3;"></i><p style="margin-top:10px;">No hay trabajadores activos.</p><p class="field-hint">Agrega trabajadores en <strong>Mi Equipo</strong> primero.</p></div></div>';
        return;
    }

    const hoy = new Date();
    _currentDate = new Date(hoy);
    _currentDate.setDate(hoy.getDate() - ((hoy.getDay() + 6) % 7));
    _currentWeekKey = getSemanaISO(hoy);

    renderVistaCompleta(container, activos, _currentWeekKey);
}

async function cargarCitasSemana(weekKey, workers) {
    try {
        const tenantId = await getCurrentTenantId();
        if (!tenantId) return;
        const year = parseInt(weekKey.split('-W')[0]);
        const weekNum = parseInt(weekKey.split('-W')[1]);
        const inicio = fechaDesdeSemanaISO(year, weekNum);
        const fin = new Date(inicio);
        fin.setDate(fin.getDate() + 6);
        const fInicio = inicio.toISOString().split('T')[0];
        const fFin = fin.toISOString().split('T')[0];
        const citas = await getCitasByDateRange(fInicio, fFin, tenantId);
        // Indexar por worker+fecha
        _citasCache = {};
        citas.forEach(c => {
            const key = (c.trabajador_id || 'null') + '_' + c.fecha;
            _citasCache[key] = (_citasCache[key] || 0) + 1;
        });
    } catch (e) {
        console.warn('[Schedule] Error cargando citas:', e.message);
        _citasCache = {};
    }
}

async function renderVistaCompleta(container, workers, weekKey) {
    const hoy = new Date();
    const currentMonth = _selectedMonth || { year: hoy.getFullYear(), month: hoy.getMonth() };
    const semanas = getSemanasDelMes(currentMonth.year, currentMonth.month);

    // Cargar citas de la semana activa
    if (weekKey) {
        await cargarCitasSemana(weekKey, workers);
    }

    let html = '<div class="glass-panel schedule-main-panel">';

    // ─── HEADER + NAVEGACION ───
    html += `
        <div class="schedule-nav-bar">
            <div class="schedule-nav-left">
                <h3 style="margin:0;"><i class="fas fa-calendar-alt"></i> Horarios del Equipo</h3>
            </div>
            <div class="schedule-nav-center">
                <button class="schedule-nav-btn" id="sn-prev-month" title="Mes anterior"><i class="fas fa-chevron-left"></i></button>
                <span class="schedule-month-label" id="sn-month-label">${MESES[currentMonth.month]} ${currentMonth.year}</span>
                <button class="schedule-nav-btn" id="sn-next-month" title="Mes siguiente"><i class="fas fa-chevron-right"></i></button>
                <button class="schedule-nav-btn schedule-nav-today" id="sn-today" title="Ir a hoy"><i class="fas fa-calendar-day"></i> Hoy</button>
            </div>
            <div class="schedule-nav-right">
                <button class="schedule-nav-btn schedule-nav-week" id="sn-prev-week" title="Semana anterior"><i class="fas fa-arrow-left"></i> Sem.</button>
                <span class="schedule-week-label" id="sn-week-label">${_currentWeekKey}</span>
                <button class="schedule-nav-btn schedule-nav-week" id="sn-next-week" title="Semana siguiente">Sem. <i class="fas fa-arrow-right"></i></button>
            </div>
        </div>`;

    // --- GUIA RAPIDA (colapsable) ---
    html += `
        <details class="schedule-help" style="margin-bottom:14px;">
            <summary class="schedule-help-summary" style="cursor:pointer;padding:10px 14px;background:rgba(157,78,221,0.06);border:1px solid rgba(157,78,221,0.12);border-radius:10px;font-size:0.82rem;font-weight:600;color:var(--primary-light);transition:all 0.2s;">
                <i class="fas fa-question-circle"></i> ¿Cómo funciona? — Guía rápida de horarios
            </summary>
            <div style="padding:14px 14px 6px;background:rgba(255,255,255,0.015);border:1px solid rgba(255,255,255,0.04);border-radius:0 0 10px 10px;margin-top:-1px;">
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;">
                    <div class="help-step clickable" data-guide="1">
                        <div class="help-step-num">1</div>
                        <div class="help-step-body">
                            <strong>Plantilla base</strong>
                            <p>En <strong>Mi Equipo</strong> crea cada trabajador con su horario t\u00EDpico (Full Time, Part Time o personalizado). Es la base que se repite cada semana.</p>
                        </div>
                    </div>
                    <div class="help-step clickable" data-guide="2">
                        <div class="help-step-num">2</div>
                        <div class="help-step-body">
                            <strong>Navega el mes</strong>
                            <p>Usa las flechas <i class="fas fa-chevron-left" style="font-size:0.55rem;"></i> <i class="fas fa-chevron-right" style="font-size:0.55rem;"></i> para cambiar de mes. Las tarjetas muestran las semanas. La actual tiene badge <span class="week-card-hoy" style="position:static;font-size:0.5rem;">HOY</span>.</p>
                        </div>
                    </div>
                    <div class="help-step clickable" data-guide="3">
                        <div class="help-step-num">3</div>
                        <div class="help-step-body">
                            <strong>Personaliza una semana</strong>
                            <p>Clic en tarjeta de semana \u2192 clic en trabajador \u2192 modal de edici\u00F3n. Define horario \u00FAnico para <strong>solo esa semana</strong>. Las semanas personalizadas muestran <span class="week-type-badge week-type-custom" style="font-size:0.6rem;">\u270F\uFE0F</span>.</p>
                        </div>
                    </div>
                    <div class="help-step clickable" data-guide="4">
                        <div class="help-step-num">4</div>
                        <div class="help-step-body">
                            <strong>Copia a varias semanas</strong>
                            <p>En el editor del trabajador, usa <strong>Copiar a semanas...</strong> para aplicar el mismo horario a m\u00FAltiples semanas futuras de una sola vez. O usa el bot\u00F3n <strong>Copiar a semanas...</strong> de la barra superior para copiar los horarios de <strong>todos</strong> los trabajadores.</p>
                        </div>
                    </div>
                    <div class="help-step clickable" data-guide="5">
                        <div class="help-step-num">5</div>
                        <div class="help-step-body">
                            <strong>Restaura o revierte</strong>
                            <p>Si una semana est\u00E1 personalizada (<span class="week-type-badge week-type-custom" style="font-size:0.6rem;">\u270F\uFE0F</span>), puedes <strong>Restaurar plantilla</strong> para volver al horario base (doble confirmaci\u00F3n). El cambio aplica a todos los trabajadores de esa semana.</p>
                        </div>
                    </div>
                    <div class="help-step clickable" data-guide="6">
                        <div class="help-step-num">6</div>
                        <div class="help-step-body">
                            <strong>Revisa ocupaci\u00F3n y normas</strong>
                            <p>El banner <i class="fas fa-clipboard-check" style="font-size:0.65rem;"></i> muestra cumplimiento de 45h semanales, colaci\u00F3n y m\u00E1ximos legales. Las celdas del grid indican citas del d\u00EDa: <span style="color:#00b894;">\uD83D\uDFE2 baja</span> <span style="color:#fdcb6e;">\uD83D\uDFE1 media</span> <span style="color:#ff6b6b;">\uD83D\uDD34 completa</span>. Clientes no pueden reservar si el trabajador est\u00E1 completo.</p>
                        </div>
                    </div>
                </div>
                <div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.04);font-size:0.78rem;color:rgba(255,255,255,0.4);">
                    <i class="fas fa-lightbulb"></i> 
                    <strong>Resumen:</strong> 
                    <span class="week-type-badge week-type-template" style="font-size:0.65rem;">Plantilla</span> = horario base (se repite). 
                    <span class="week-type-badge week-type-custom" style="font-size:0.65rem;">Personalizada</span> = horario \u00FAnico para esa semana.
                    Los cambios se guardan autom\u00E1ticamente y la vista se refresca sola.
                </div>
            </div>
        </details>`;

    // --- TARJETAS DE SEMANA ---
    html += '<div class="schedule-week-cards" id="schedule-week-cards">';
    semanas.forEach(sem => {
        const esActual = sem.weekKey === _currentWeekKey;
        const esSemanaHoy = sem.weekKey === getSemanaISO(hoy);
        const resumen = resumirSemana(workers, sem.weekKey);
        html += `
            <div class="week-card ${esActual ? 'week-card-active' : ''} ${esSemanaHoy ? 'week-card-today' : ''}" data-week="${sem.weekKey}" title="Ver semana del ${formatearFecha(sem.start)}">
                <span class="week-card-label">Sem ${sem.weekKey.split('-W')[1]}</span>
                <span class="week-card-range">${sem.start.getDate()} ${MESES[sem.start.getMonth()].slice(0,3)} – ${sem.end.getDate()} ${MESES[sem.end.getMonth()].slice(0,3)}</span>
                <span class="week-card-summary">${resumen.badge} ${resumen.ok}/${workers.length}</span>
                <span class="week-card-type">${resumen.esExcepcion ? '✏️ Personalizada' : '📋 Plantilla'}</span>
                ${esSemanaHoy ? '<span class="week-card-hoy">HOY</span>' : ''}
            </div>`;
    });
    html += '</div>';

    // --- INDICADOR DE SEMANA ACTUAL ---
    const semanaInfo = getSemanaInfo(workers, _currentWeekKey);
    html += `
        <div class="schedule-week-indicator" id="schedule-week-indicator">
            <span><i class="fas fa-calendar-week"></i> Semana del <strong>${formatearFecha(semanaInfo.inicio)}</strong> al <strong>${formatearFecha(semanaInfo.fin)}</strong></span>
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                ${semanaInfo.esExcepcion
                    ? '<span class="week-type-badge week-type-custom"><i class="fas fa-pencil-alt"></i> Personalizada <button class="btn-reset-week" id="btn-restore-template" title="Restaurar plantilla base">Restaurar plantilla</button></span>'
                    : '<span class="week-type-badge week-type-template"><i class="fas fa-book"></i> Plantilla base</span>'
                }
                <button class="btn-secondary" id="btn-copy-all-weeks" style="font-size:0.72rem;padding:4px 10px;white-space:nowrap;"><i class="fas fa-copy"></i> Copiar a semanas...</button>
            </div>
        </div>`;

    // ─── BANNER DE CUMPLIMIENTO ───
    html += `
        <div class="schedule-compliance-banner" style="margin-bottom:14px;padding:10px 14px;border-radius:10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
            <span style="font-weight:600;font-size:0.85rem;white-space:nowrap;"><i class="fas fa-clipboard-check"></i> Cumplimiento Chile</span>
            <span class="comp-badge comp-ok" id="comp-ok-count">✅ 0</span>
            <span class="comp-badge comp-warning" id="comp-warning-count">⚠️ 0</span>
            <span class="comp-badge comp-error" id="comp-error-count">❌ 0</span>
            <span style="font-size:0.78rem;color:rgba(255,255,255,0.35);margin-left:auto;" id="comp-total-hs">0h totales</span>
        </div>`;

    // ─── GRID SEMANAL ───
    html += renderGridSemanal(workers, _currentWeekKey);

    // ─── LEYENDA ───
    html += `
        <div class="schedule-legend" style="margin-top:14px;display:flex;gap:16px;justify-content:center;flex-wrap:wrap;">
            <span class="legend-item"><span class="legend-dot" style="background:rgba(0,184,148,0.4);"></span> Disponible</span>
            <span class="legend-item"><span class="legend-dot" style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);"></span> Descanso</span>
            <span class="legend-item"><span class="legend-dot" style="background:rgba(253,203,110,0.5);">\uD83C\uDF74</span> Colaci\u00F3n</span>
            <span class="legend-item"><span style="font-size:0.6rem;">\uD83D\uDFE2</span> Baja ocup.</span>
            <span class="legend-item"><span style="font-size:0.6rem;">\uD83D\uDFE1</span> Media ocup.</span>
            <span class="legend-item"><span style="font-size:0.6rem;">\uD83D\uDD34</span> Alta ocup.</span>
        </div>`;

    html += '</div>'; // cierra glass-panel
    container.innerHTML = html;

    // Bindear eventos de navegación
    document.getElementById('sn-prev-month')?.addEventListener('click', () => navegarMes(container, workers, -1));
    document.getElementById('sn-next-month')?.addEventListener('click', () => navegarMes(container, workers, 1));
    document.getElementById('sn-today')?.addEventListener('click', () => {
        _selectedMonth = null;
        _currentDate = new Date();
        const hoy = new Date();
        _currentDate.setDate(hoy.getDate() - ((hoy.getDay() + 6) % 7));
        _currentWeekKey = getSemanaISO(hoy);
        renderVistaCompleta(container, workers, _currentWeekKey);
    });
    document.getElementById('sn-prev-week')?.addEventListener('click', () => navegarSemana(container, workers, -7));
    document.getElementById('sn-next-week')?.addEventListener('click', () => navegarSemana(container, workers, 7));

    // Tarjetas de semana
    container.querySelectorAll('.week-card').forEach(card => {
        card.addEventListener('click', () => {
            _currentWeekKey = card.dataset.week;
            // Ajustar _currentDate al inicio de esa semana
            const semEncontrada = getSemanasDelMes(
                parseInt(_currentWeekKey.split('-W')[0]),
                0 // placeholder, buscaremos
            );
            renderVistaCompleta(container, workers, _currentWeekKey);
        });
    });

    // Restaurar plantilla
    document.getElementById('btn-restore-template')?.addEventListener('click', async () => {
        if (!confirm('¿Restaurar plantilla base para TODA la semana? Se perderán los cambios personalizados de todos los trabajadores.')) return;
        if (!confirm('⚠️ Confirmación final: ¿estás seguro? Esta acción no se puede deshacer.')) return;
        try {
            const { editarTrabajador } = await import('../application/WorkersService.js');
            for (const w of workers) {
                const excepciones = { ...(w.horario_excepciones || {}) };
                delete excepciones[_currentWeekKey];
                await editarTrabajador(w.id, { horario_excepciones: excepciones });
            }
            mostrarToast('✅ Semana restaurada a plantilla base', 'success');
            setTimeout(() => renderWorkerSchedule('schedule-container'), 200);
        } catch (err) {
            mostrarToast('❌ Error: ' + err.message, 'error');
        }
    });

    // Copiar horarios de todos a semanas
    document.getElementById('btn-copy-all-weeks')?.addEventListener('click', () => {
        abrirSelectorCopiarTodos(container, workers, _currentWeekKey);
    });

    // Click en fila de trabajador
    container.querySelectorAll('.schedule-worker-row.clickable').forEach(row => {
        row.addEventListener('click', () => {
            try {
                const w = JSON.parse(row.dataset.worker);
                const hrInfo = getHorarioParaSemana(w, _currentWeekKey);
                abrirEditorHorario(w, _currentWeekKey, hrInfo);
            } catch (e) { console.error(e); }
        });
    });

    actualizarBannerCumplimiento(workers, _currentWeekKey);

    // Guia interactiva: clic en paso ilumina la seccion
    container.querySelectorAll('.help-step.clickable').forEach(step => {
        step.addEventListener('click', (e) => {
            e.stopPropagation();
            const target = step.dataset.guide;
            // Quitar highlight previo
            document.querySelectorAll('.guide-highlight').forEach(el => el.classList.remove('guide-highlight'));
            switch (target) {
                case '1':
                    if (window.navigateTo) {
                        window.navigateTo('equipo');
                        setTimeout(() => {
                            const equipo = document.getElementById('workers-list-container');
                            if (equipo) equipo.classList.add('guide-highlight');
                        }, 300);
                    }
                    break;
                case '2': {
                    const nav = document.querySelector('.schedule-nav-center');
                    if (nav) { nav.classList.add('guide-highlight'); nav.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
                    break;
                }
                case '3': {
                    const cards = document.getElementById('schedule-week-cards');
                    if (cards) { cards.classList.add('guide-highlight'); cards.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
                    break;
                }
                case '4': {
                    const indicator = document.getElementById('schedule-week-indicator');
                    if (indicator) { indicator.classList.add('guide-highlight'); indicator.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
                    break;
                }
                case '5': {
                    const restoreBtn = document.getElementById('btn-restore-template');
                    if (restoreBtn) { restoreBtn.classList.add('guide-highlight'); restoreBtn.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
                    break;
                }
                case '6': {
                    const banner = document.querySelector('.schedule-compliance-banner');
                    if (banner) { banner.classList.add('guide-highlight'); banner.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
                    break;
                }
            }
            setTimeout(() => {
                document.querySelectorAll('.guide-highlight').forEach(el => el.classList.remove('guide-highlight'));
            }, 3000);
        });
    });
}

// ─── RENDER GRID SEMANAL ───
function renderGridSemanal(workers, weekKey) {
    // Calcular inicio de semana desde el weekKey
    const year = parseInt(weekKey.split('-W')[0]);
    const weekNum = parseInt(weekKey.split('-W')[1]);
    const inicioSemana = fechaDesdeSemanaISO(year, weekNum);

    const hoy = new Date();
    let html = '<div class="schedule-container">';
    html += '<div class="schedule-header-row">';
    html += '<div class="schedule-corner"></div>';
    for (let i = 0; i < 7; i++) {
        const d = new Date(inicioSemana);
        d.setDate(inicioSemana.getDate() + i);
        const esHoy = d.toDateString() === hoy.toDateString();
        html += `<div class="schedule-day-header ${esHoy ? 'today' : ''}"><span class="s-day-name">${DIAS[i].slice(0,3)}</span><span class="s-day-num">${d.getDate()}</span></div>`;
    }
    html += '</div>';

    workers.forEach(w => {
        const hrInfo = getHorarioParaSemana(w, weekKey);
        const hr = hrInfo.horario;
        const val = resumenValidacion(hr, hrInfo.maxSemanal);
        const total = val.total_horas;
        html += `
            <div class="schedule-worker-row clickable" data-worker='${escapeAttr(JSON.stringify(w))}' style="border-left:4px solid ${w.color||'#9d4edd'};cursor:pointer;" title="Editar horario de ${escapeAttr(w.nombre)}">
                <div class="schedule-worker-info">
                    <span class="sw-avatar" style="background:${w.color||'#9d4edd'}">${w.nombre.charAt(0).toUpperCase()}</span>
                    <div class="sw-details">
                        <strong class="sw-name">${escapeHtml(w.nombre)}</strong>
                        <span class="sw-total">${total}h/sem <span class="sw-badge ${val.estado === 'ok' ? 'badge-ok' : val.estado === 'warning' ? 'badge-warning' : 'badge-error'}">${val.badge}</span></span>
                    </div>
                </div>`;
        for (let i = 0; i < 7; i++) {
            const d = new Date(inicioSemana);
            d.setDate(inicioSemana.getDate() + i);
            const dk = String(d.getDay() === 0 ? 7 : d.getDay());
            const dia = hr[dk];
            const esHoy = d.toDateString() === hoy.toDateString();
            const fechaStr = d.toISOString().split('T')[0];
            const citasCount = _citasCache[(w.id || 'null') + '_' + fechaStr] || 0;
            if (!dia || !dia.activo) {
                html += `<div class="schedule-day-cell off ${esHoy ? 'today' : ''}"><span class="s-day-status">--</span></div>`;
            } else {
                const horas = calcHoras(dia);
                const tieneColacion = dia.colacion_inicio && dia.colacion_inicio !== '00:00';
                const slotsDisp = Math.max(1, Math.ceil(horas * 2));
                const ocupPct = Math.min(100, Math.round((citasCount / slotsDisp) * 100));
                let ocupClass = 'ocup-baja';
                let ocupIcon = '';
                if (ocupPct >= 100) { ocupClass = 'ocup-llena'; ocupIcon = '\uD83D\uDD34'; }
                else if (ocupPct >= 60) { ocupClass = 'ocup-media'; ocupIcon = '\uD83D\uDFE1'; }
                else if (citasCount > 0) { ocupIcon = '\uD83D\uDFE2'; }
                html += `
                    <div class="schedule-day-cell on ${esHoy ? 'today' : ''}">
                        <div class="s-day-bar" style="background:${w.color||'#9d4edd'}15;">
                            <div class="s-day-fill" style="width:${Math.min(100,(horas/12)*100)}%;background:${w.color||'#9d4edd'};">
                                <span class="s-day-hours">${dia.inicio}${tieneColacion ? ' \uD83C\uDF74' : ''} ${dia.fin}</span>
                            </div>
                        </div>
                        <span class="s-day-ocupacion ${ocupClass}">${ocupIcon} ${citasCount}${citasCount === 1 ? ' cita' : ' citas'}</span>
                    </div>`;
            }
        }
        html += '</div>';
    });

    html += '</div>';
    return html;
}

// ─── NAVEGACION ───
async function navegarMes(container, workers, direccion) {
    const hoy = new Date();
    const current = _selectedMonth || { year: hoy.getFullYear(), month: hoy.getMonth() };
    current.month += direccion;
    if (current.month < 0) { current.month = 11; current.year--; }
    if (current.month > 11) { current.month = 0; current.year++; }
    _selectedMonth = current;
    renderVistaCompleta(container, workers, _currentWeekKey);
}

async function navegarSemana(container, workers, dias) {
    _selectedMonth = null; // salir de vista de mes al navegar semana
    _currentDate.setDate(_currentDate.getDate() + dias);
    _currentWeekKey = getSemanaISO(_currentDate);
    renderVistaCompleta(container, workers, _currentWeekKey);
}

// ─── MODAL: EDITAR HORARIO (adaptado para semana) ───
export function abrirEditorHorario(worker, weekKey, hrInfo) {
    const hr = hrInfo ? hrInfo.horario : (worker.horario_semanal || {});
    const esExcepcion = hrInfo ? hrInfo.esExcepcion : false;
    const maxHr = hrInfo ? hrInfo.maxSemanal : (worker.horario_max_semanal || 0);

    const diasActivos = [1,2,3,4,5,6,7].filter(k => hr[String(k)]?.activo);
    const horariosUnicos = new Set(diasActivos.map(k => `${hr[String(k)].inicio}|${hr[String(k)].colacion_inicio||''}|${hr[String(k)].colacion_fin||''}|${hr[String(k)].fin}`));
    const modoUniforme = horariosUnicos.size <= 1;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'schedule-editor-overlay';
    overlay.style.overflowY = 'auto';
    overlay.innerHTML = `
        <div class="modal-content" style="max-width:580px;">
            <button class="modal-close" id="se-close">&times;</button>
            <h3><i class="fas fa-clock"></i> ${escapeHtml(worker.nombre)}</h3>
            <div style="margin-bottom:12px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                <span class="week-type-badge ${esExcepcion ? 'week-type-custom' : 'week-type-template'}" style="font-size:0.78rem;">
                    ${esExcepcion ? '✏️ Personalizada (' + weekKey + ')' : '📋 Plantilla base'}
                </span>
                ${weekKey ? '<span style="font-size:0.72rem;color:rgba(255,255,255,0.3);">Semana ' + weekKey + '</span>' : ''}
            </div>
            <form id="se-form">

                <!-- TABS: mismo horario / por día -->
                <div style="margin-bottom:14px;display:flex;gap:8px;background:rgba(255,255,255,0.02);border-radius:10px;padding:6px;">
                    <button type="button" class="se-modo-btn ${modoUniforme?'active':''}" data-modo="uniforme" style="flex:1;padding:10px;border-radius:8px;border:2px solid transparent;cursor:pointer;font-weight:600;font-size:0.82rem;transition:all 0.2s;background:${modoUniforme?'rgba(157,78,221,0.1)':'transparent'};color:${modoUniforme?'#c77dff':'rgba(255,255,255,0.5)'};${modoUniforme?'border-color:var(--primary-color)':''}">
                        <i class="fas fa-equals"></i> Mismo horario todos los días
                    </button>
                    <button type="button" class="se-modo-btn ${!modoUniforme?'active':''}" data-modo="por-dia" style="flex:1;padding:10px;border-radius:8px;border:2px solid transparent;cursor:pointer;font-weight:600;font-size:0.82rem;transition:all 0.2s;background:${!modoUniforme?'rgba(157,78,221,0.1)':'transparent'};color:${!modoUniforme?'#c77dff':'rgba(255,255,255,0.5)'};${!modoUniforme?'border-color:var(--primary-color)':''}">
                        <i class="fas fa-list"></i> Horario diferente por día
                    </button>
                </div>

                <!-- UNIFORME -->
                <div id="se-uniforme" style="${modoUniforme?'':'display:none;'}">
                    <label style="display:block;font-size:0.8rem;font-weight:600;color:rgba(255,255,255,0.6);margin-bottom:8px;">Días que trabaja</label>
                    <div class="wf-dias-grid" style="margin-bottom:12px;">
                        ${['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'].map((d,i)=>{
                            const k=String(i+1); const a=hr[k]?.activo||false;
                            return `<label class="wf-dia-label ${a?'activo':''}"><input type="checkbox" class="se-dia-cb" data-dia="${k}" ${a?'checked':''}><span>${d}</span></label>`;
                        }).join('')}
                    </div>
                    <label style="display:block;font-size:0.8rem;font-weight:600;color:rgba(255,255,255,0.6);margin-bottom:6px;">Horario</label>
                    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                        <div class="time-input-group"><i class="fas fa-play"></i><input type="time" id="se-inicio" value="${hr['1']?.inicio||'09:00'}" class="se-time"></div>
                        <span style="color:rgba(255,255,255,0.15);">│</span>
                        <div class="time-input-group"><i class="fas fa-utensils" style="color:rgba(253,203,110,0.5);"></i><input type="time" id="se-ci" value="${hr['1']?.colacion_inicio||'13:00'}" class="se-time" style="width:80px;"><span style="color:rgba(255,255,255,0.15);font-size:0.7rem;">a</span><input type="time" id="se-cf" value="${hr['1']?.colacion_fin||'14:00'}" class="se-time" style="width:80px;"></div>
                        <span style="color:rgba(255,255,255,0.15);">│</span>
                        <div class="time-input-group"><i class="fas fa-stop"></i><input type="time" id="se-fin" value="${hr['1']?.fin||'18:00'}" class="se-time"></div>
                    </div>
                </div>

                <!-- POR DIA -->
                <div id="se-por-dia" style="${modoUniforme?'display:none;':''}">
                    ${[1,2,3,4,5,6,7].map(k => {
                        const d = hr[String(k)]||{activo:false,inicio:'09:00',fin:'18:00',colacion_inicio:'13:00',colacion_fin:'14:00'};
                        const nom = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'][k-1];
                        return `
                            <div class="se-dia-row" data-dia="${k}" style="display:flex;align-items:center;gap:6px;padding:5px 8px;margin-bottom:4px;border-radius:8px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.04);${d.activo?'':'opacity:0.4;'}">
                                <label style="display:flex;align-items:center;gap:4px;min-width:40px;cursor:pointer;font-size:0.82rem;font-weight:600;">
                                    <input type="checkbox" class="se-pd-cb" data-dia="${k}" ${d.activo?'checked':''}> ${nom}
                                </label>
                                <input type="time" class="se-pd-inicio se-time-sm" data-dia="${k}" value="${d.inicio}" ${d.activo?'':'disabled'}>
                                <i class="fas fa-utensils" style="font-size:0.55rem;color:rgba(253,203,110,0.3);"></i>
                                <input type="time" class="se-pd-ci se-time-sm" data-dia="${k}" value="${d.colacion_inicio}" ${d.activo?'':'disabled'}>
                                <span style="color:rgba(255,255,255,0.1);font-size:0.65rem;">a</span>
                                <input type="time" class="se-pd-cf se-time-sm" data-dia="${k}" value="${d.colacion_fin}" ${d.activo?'':'disabled'}>
                                <i class="fas fa-stop" style="font-size:0.55rem;color:rgba(255,255,255,0.15);"></i>
                                <input type="time" class="se-pd-fin se-time-sm" data-dia="${k}" value="${d.fin}" ${d.activo?'':'disabled'}>
                                <span class="se-pd-hs" style="font-size:0.7rem;font-weight:600;color:rgba(255,255,255,0.3);min-width:30px;text-align:right;">${calcHoras(d)}h</span>
                            </div>`;
                    }).join('')}
                </div>

                <!-- MAXIMO + PROGRESS -->
                <div style="margin-top:14px;padding:12px;background:rgba(255,255,255,0.02);border-radius:10px;border:1px solid rgba(255,255,255,0.04);">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                        <span style="font-size:0.8rem;font-weight:600;color:rgba(255,255,255,0.5);">Total semanal: <strong id="se-total-hs" style="color:var(--primary-color);font-size:1.2rem;">0</strong>h</span>
                        <div style="display:flex;align-items:center;gap:6px;">
                            <span style="font-size:0.7rem;color:rgba(255,255,255,0.35);">Máx:</span>
                            <input type="number" id="se-max" value="${maxHr||''}" placeholder="—" min="1" max="168" style="width:55px;padding:5px 8px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.08);border-radius:6px;color:var(--text-color);font-size:0.8rem;text-align:center;">
                            <span style="font-size:0.7rem;color:rgba(255,255,255,0.35);">h/sem</span>
                        </div>
                    </div>
                    <div class="se-progress-bar" id="se-progress-bar">
                        <div class="se-progress-fill" id="se-progress-fill" style="width:0%;"></div>
                    </div>
                </div>

                <!-- ACCIONES -->
                <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
                    <button type="button" class="btn-reset-styled" id="se-cancel" style="flex:1;min-width:100px;">Cancelar</button>
                    ${weekKey ? `<button type="button" class="btn-secondary" id="se-copy-weeks" style="flex:1;min-width:120px;"><i class="fas fa-copy"></i> Copiar a semanas...</button>` : ''}
                    <button type="submit" class="btn-save-primary" style="flex:2;"><i class="fas fa-save"></i> Guardar</button>
                </div>
            </form>
        </div>`;
    document.body.appendChild(overlay);
    overlay.style.display = 'flex';

    // Cerrar
    document.getElementById('se-close').onclick = () => overlay.remove();
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    document.getElementById('se-cancel').onclick = () => overlay.remove();

    // ─── RECALC ───
    function recalc() {
        const modo = overlay.querySelector('.se-modo-btn.active')?.dataset.modo || 'uniforme';
        if (modo !== 'uniforme') {
            overlay.querySelectorAll('.se-pd-cb').forEach(cb => {
                if (!cb.checked) return;
                const row = cb.closest('.se-dia-row');
                const ini = row.querySelector('.se-pd-inicio').value || '09:00';
                const fin = row.querySelector('.se-pd-fin').value || '18:00';
                const ci = row.querySelector('.se-pd-ci').value || '00:00';
                const cf = row.querySelector('.se-pd-cf').value || '00:00';
                const hs = calcHoras({ activo: true, inicio: ini, fin, colacion_inicio: ci, colacion_fin: cf });
                const el = row.querySelector('.se-pd-hs');
                if (el) el.textContent = hs + 'h';
            });
        }
        actualizarValidacionEditorModal(overlay);
    }

    // Eventos
    overlay.querySelectorAll('.se-modo-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            overlay.querySelectorAll('.se-modo-btn').forEach(b => { b.style.background='transparent'; b.style.color='rgba(255,255,255,0.5)'; b.style.borderColor='transparent'; });
            btn.style.background='rgba(157,78,221,0.1)'; btn.style.color='#c77dff'; btn.style.borderColor='var(--primary-color)';
            const modo=btn.dataset.modo;
            document.getElementById('se-uniforme').style.display=modo==='uniforme'?'':'none';
            document.getElementById('se-por-dia').style.display=modo==='por-dia'?'':'none';
            recalc();
        });
    });
    overlay.querySelectorAll('.se-dia-cb').forEach(cb => cb.addEventListener('change', function(){ this.closest('.wf-dia-label').classList.toggle('activo',this.checked); recalc(); }));
    ['se-inicio','se-fin','se-ci','se-cf'].forEach(id => document.getElementById(id)?.addEventListener('change', recalc));
    overlay.querySelectorAll('.se-pd-cb').forEach(cb => {
        cb.addEventListener('change', function(){
            const row=this.closest('.se-dia-row');
            row.style.opacity=this.checked?'1':'0.4';
            row.querySelectorAll('input[type="time"]').forEach(inp=>inp.disabled=!this.checked);
            recalc();
        });
    });
    overlay.querySelectorAll('.se-pd-inicio, .se-pd-fin, .se-pd-ci, .se-pd-cf').forEach(inp => inp.addEventListener('change', recalc));
    document.getElementById('se-max')?.addEventListener('input', recalc);
    recalc();

    // --- COPIAR A SEMANAS (selector multiple) ---
    document.getElementById('se-copy-weeks')?.addEventListener('click', () => {
        const horarioActual = recolectarHorario(overlay);
        const maxActual = parseInt(document.getElementById('se-max')?.value) || 0;

        // Crear overlay selector de semanas
        const selOverlay = document.createElement('div');
        selOverlay.className = 'modal-overlay';
        selOverlay.id = 'week-selector-overlay';
        selOverlay.style.overflowY = 'auto';
        selOverlay.style.zIndex = '10001';

        const hoy = new Date();
        const meses = [];
        for (let m = 0; m < 4; m++) {
            const d = new Date(hoy.getFullYear(), hoy.getMonth() + m, 1);
            meses.push({ year: d.getFullYear(), month: d.getMonth() });
        }

        let selHtml = `
            <div class="modal-content" style="max-width:500px;">
                <button class="modal-close" id="ws-close">&times;</button>
                <h3><i class="fas fa-copy"></i> Copiar horario a semanas</h3>
                <p style="font-size:0.8rem;color:rgba(255,255,255,0.4);margin-bottom:12px;">
                    Selecciona las semanas donde aplicar este horario. Semanas con <span class="week-type-badge week-type-custom" style="font-size:0.65rem;">✏️</span> ya tienen horario personalizado.
                </p>
                <div style="max-height:350px;overflow-y:auto;padding-right:4px;">`;

        const semanasYaConExcepcion = new Set(Object.keys(worker.horario_excepciones || {}));

        meses.forEach((m, mi) => {
            const semanas = getSemanasDelMes(m.year, m.month);
            const filtered = semanas.filter(s => s.weekKey !== weekKey); // excluir semana actual
            if (!filtered.length) return;
            selHtml += `
                <div style="margin-bottom:10px;">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
                        <strong style="font-size:0.85rem;">${MESES[m.month]} ${m.year}</strong>
                        <button type="button" class="ws-select-all" data-month="${mi}" style="font-size:0.65rem;background:rgba(157,78,221,0.08);border:1px solid rgba(157,78,221,0.2);color:#c77dff;padding:2px 8px;border-radius:4px;cursor:pointer;">Seleccionar todas</button>
                    </div>
                    <div class="ws-weeks-grid">`;
            filtered.forEach(sem => {
                const tieneExcepcion = semanasYaConExcepcion.has(sem.weekKey);
                selHtml += `
                    <label class="ws-week-label ${tieneExcepcion ? 'ws-has-exception' : ''}" style="display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:6px;background:rgba(255,255,255,0.01);border:1px solid rgba(255,255,255,0.04);cursor:pointer;transition:all 0.15s;">
                        <input type="checkbox" class="ws-week-cb" data-week="${sem.weekKey}" ${tieneExcepcion ? 'checked' : ''}>
                        <span style="font-size:0.78rem;font-weight:600;min-width:32px;">Sem ${sem.weekKey.split('-W')[1]}</span>
                        <span style="font-size:0.65rem;color:rgba(255,255,255,0.3);">${sem.start.getDate()} ${MESES[sem.start.getMonth()].slice(0,3)}</span>
                        ${tieneExcepcion ? '<span style="font-size:0.6rem;color:#fdcb6e;margin-left:auto;">✏️</span>' : ''}
                    </label>`;
            });
            selHtml += `</div></div>`;
        });

        selHtml += `
                </div>
                <div style="display:flex;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.06);">
                    <button type="button" class="btn-reset-styled" id="ws-cancel" style="flex:1;">Cancelar</button>
                    <button type="button" class="btn-save-primary" id="ws-confirm" style="flex:2;"><i class="fas fa-check"></i> Copiar a ${'N'} semana(s)</button>
                </div>
            </div>`;
        selOverlay.innerHTML = selHtml;
        document.body.appendChild(selOverlay);
        selOverlay.style.display = 'flex';

        // Actualizar contador
        function actualizarContador() {
            const count = selOverlay.querySelectorAll('.ws-week-cb:checked').length;
            const btn = document.getElementById('ws-confirm');
            if (btn) btn.innerHTML = '<i class="fas fa-check"></i> Copiar a ' + count + ' semana' + (count !== 1 ? 's' : '');
        }

        // Cerrar
        document.getElementById('ws-close').onclick = () => selOverlay.remove();
        document.getElementById('ws-cancel').onclick = () => selOverlay.remove();
        selOverlay.onclick = e => { if (e.target === selOverlay) selOverlay.remove(); };

        // Select all por mes
        selOverlay.querySelectorAll('.ws-select-all').forEach(btn => {
            btn.addEventListener('click', () => {
                const mi = parseInt(btn.dataset.month);
                const monthDiv = btn.closest('div[style*="margin-bottom"]');
                if (!monthDiv) return;
                const cbs = monthDiv.querySelectorAll('.ws-week-cb');
                const todasSeleccionadas = Array.from(cbs).every(cb => cb.checked);
                cbs.forEach(cb => cb.checked = !todasSeleccionadas);
                actualizarContador();
            });
        });

        // Checkbox change
        selOverlay.querySelectorAll('.ws-week-cb').forEach(cb => cb.addEventListener('change', actualizarContador));
        actualizarContador();

        // Confirmar copia
        document.getElementById('ws-confirm').addEventListener('click', async () => {
            const selected = [];
            selOverlay.querySelectorAll('.ws-week-cb:checked').forEach(cb => selected.push(cb.dataset.week));
            if (!selected.length) {
                mostrarToast('Selecciona al menos una semana', 'warning');
                return;
            }
            try {
                const { editarTrabajador } = await import('../application/WorkersService.js');
                const excepciones = { ...(worker.horario_excepciones || {}) };
                selected.forEach(wk => { excepciones[wk] = { ...horarioActual }; });
                await editarTrabajador(worker.id, { horario_excepciones: excepciones, horario_max_semanal: maxActual || null });
                mostrarToast('Copiado a ' + selected.length + ' semana' + (selected.length !== 1 ? 's' : ''), 'success');
                selOverlay.remove();
                overlay.remove();
                setTimeout(() => renderWorkerSchedule('schedule-container'), 200);
            } catch (err) {
                mostrarToast('Error: ' + err.message, 'error');
            }
        });
    });

    // SUBMIT
    document.getElementById('se-form').onsubmit = async e => {
        e.preventDefault();
        const horario = recolectarHorario(overlay);
        const max = parseInt(document.getElementById('se-max')?.value) || null;
        try {
            const { editarTrabajador } = await import('../application/WorkersService.js');
            if (weekKey && esExcepcion) {
                // Guardar como excepción de semana
                const excepciones = { ...(worker.horario_excepciones || {}) };
                excepciones[weekKey] = horario;
                await editarTrabajador(worker.id, { horario_excepciones: excepciones, horario_max_semanal: max });
                mostrarToast('✅ Horario personalizado para ' + weekKey + ' guardado', 'success');
            } else if (weekKey) {
                // Guardar como excepción (primera vez que se personaliza esta semana)
                const excepciones = { ...(worker.horario_excepciones || {}) };
                excepciones[weekKey] = horario;
                await editarTrabajador(worker.id, { horario_excepciones: excepciones, horario_max_semanal: max });
                mostrarToast('✅ Horario personalizado para ' + weekKey + ' guardado', 'success');
            } else {
                // Guardar como plantilla base
                await editarTrabajador(worker.id, { tipo_jornada: 'custom', horario_semanal: horario, horario_max_semanal: max });
                mostrarToast('✅ Horario plantilla de ' + worker.nombre + ' actualizado', 'success');
            }
            overlay.remove();
            setTimeout(() => renderWorkerSchedule('schedule-container'), 200);
        } catch (err) {
            mostrarToast('❌ Error: ' + err.message, 'error');
        }
    };
}

// ─── FUNCIONES AYUDANTES ───
function recolectarHorario(overlay) {
    const horario = {};
    const modo = overlay.querySelector('.se-modo-btn.active')?.dataset.modo || 'uniforme';
    if (modo === 'uniforme') {
        const ini=document.getElementById('se-inicio').value||'09:00', fin=document.getElementById('se-fin').value||'18:00';
        const ci=document.getElementById('se-ci').value||'13:00', cf=document.getElementById('se-cf').value||'14:00';
        overlay.querySelectorAll('.se-dia-cb').forEach(cb => {
            const dk=cb.dataset.dia;
            horario[dk]={activo:cb.checked,inicio:cb.checked?ini:'00:00',fin:cb.checked?fin:'00:00',colacion_inicio:cb.checked?ci:'00:00',colacion_fin:cb.checked?cf:'00:00'};
        });
    } else {
        overlay.querySelectorAll('.se-dia-row').forEach(row => {
            const dk=row.dataset.dia; const cb=row.querySelector('.se-pd-cb');
            const ini=row.querySelector('.se-pd-inicio').value||'09:00', fin=row.querySelector('.se-pd-fin').value||'18:00';
            const ci=row.querySelector('.se-pd-ci').value||'13:00', cf=row.querySelector('.se-pd-cf').value||'14:00';
            horario[dk]={activo:cb.checked,inicio:cb.checked?ini:'00:00',fin:cb.checked?fin:'00:00',colacion_inicio:cb.checked?ci:'00:00',colacion_fin:cb.checked?cf:'00:00'};
        });
    }
    return horario;
}

function calcHoras(dia) {
    if(!dia||!dia.activo) return 0;
    const[i1,i2] = [(dia.inicio||'00:00').split(':').map(Number),(dia.fin||'00:00').split(':').map(Number)];
    const[c1,c2] = [(dia.colacion_inicio||'00:00').split(':').map(Number),(dia.colacion_fin||'00:00').split(':').map(Number)];
    let t = (i2[0]*60+i2[1])-(i1[0]*60+i1[1]);
    const col = (c1[0]*60+c1[1]>0&&c2[0]*60+c2[1]>0)?(c2[0]*60+c2[1])-(c1[0]*60+c1[1]):0;
    return Math.max(0,Math.round((t-Math.max(0,col))/60*10)/10);
}

function formatearFecha(d) { return d.toLocaleDateString('es-CL',{day:'numeric',month:'long'}); }

// --- COPIAR HORARIOS DE TODOS A SEMANAS SELECCIONADAS ---
function abrirSelectorCopiarTodos(container, workers, weekKeyOrigen) {
    const hoy = new Date();
    const meses = [];
    for (let m = 0; m < 4; m++) {
        const d = new Date(hoy.getFullYear(), hoy.getMonth() + m, 1);
        meses.push({ year: d.getFullYear(), month: d.getMonth() });
    }

    const selOverlay = document.createElement('div');
    selOverlay.className = 'modal-overlay';
    selOverlay.id = 'copy-all-overlay';
    selOverlay.style.overflowY = 'auto';
    selOverlay.style.zIndex = '10001';

    let selHtml = `
        <div class="modal-content" style="max-width:500px;">
            <button class="modal-close" id="ca-close">&times;</button>
            <h3><i class="fas fa-copy"></i> Copiar horarios de todos a semanas</h3>
            <p style="font-size:0.8rem;color:rgba(255,255,255,0.4);margin-bottom:12px;">
                Se copiar\u00E1 el horario actual de <strong>${workers.length} trabajador${workers.length !== 1 ? 'es' : ''}</strong> a las semanas seleccionadas.
                Semanas con <span class="week-type-badge week-type-custom" style="font-size:0.65rem;">✏️</span> ser\u00E1n sobrescritas.
            </p>
            <div style="max-height:350px;overflow-y:auto;padding-right:4px;">`;

    meses.forEach((m, mi) => {
        const semanas = getSemanasDelMes(m.year, m.month);
        const filtered = semanas.filter(s => s.weekKey !== weekKeyOrigen);
        if (!filtered.length) return;
        selHtml += `
            <div style="margin-bottom:10px;">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
                    <strong style="font-size:0.85rem;">${MESES[m.month]} ${m.year}</strong>
                    <button type="button" class="ca-select-all" data-month="${mi}" style="font-size:0.65rem;background:rgba(157,78,221,0.08);border:1px solid rgba(157,78,221,0.2);color:#c77dff;padding:2px 8px;border-radius:4px;cursor:pointer;">Sel. todas</button>
                </div>
                <div class="ws-weeks-grid">`;
        filtered.forEach(sem => {
            selHtml += `
                <label class="ws-week-label" style="display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:6px;background:rgba(255,255,255,0.01);border:1px solid rgba(255,255,255,0.04);cursor:pointer;transition:all 0.15s;">
                    <input type="checkbox" class="ca-week-cb" data-week="${sem.weekKey}">
                    <span style="font-size:0.78rem;font-weight:600;min-width:32px;">Sem ${sem.weekKey.split('-W')[1]}</span>
                    <span style="font-size:0.65rem;color:rgba(255,255,255,0.3);">${sem.start.getDate()} ${MESES[sem.start.getMonth()].slice(0,3)}</span>
                </label>`;
        });
        selHtml += `</div></div>`;
    });

    selHtml += `
            </div>
            <div style="display:flex;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.06);">
                <button type="button" class="btn-reset-styled" id="ca-cancel" style="flex:1;">Cancelar</button>
                <button type="button" class="btn-save-primary" id="ca-confirm" style="flex:2;"><i class="fas fa-check"></i> Copiar a N semana(s)</button>
            </div>
        </div>`;
    selOverlay.innerHTML = selHtml;
    document.body.appendChild(selOverlay);
    selOverlay.style.display = 'flex';

    function actualizarContador() {
        const count = selOverlay.querySelectorAll('.ca-week-cb:checked').length;
        const btn = document.getElementById('ca-confirm');
        if (btn) btn.innerHTML = '<i class="fas fa-check"></i> Copiar a ' + count + ' semana' + (count !== 1 ? 's' : '');
    }

    document.getElementById('ca-close').onclick = () => selOverlay.remove();
    document.getElementById('ca-cancel').onclick = () => selOverlay.remove();
    selOverlay.onclick = e => { if (e.target === selOverlay) selOverlay.remove(); };

    selOverlay.querySelectorAll('.ca-select-all').forEach(btn => {
        btn.addEventListener('click', () => {
            const monthDiv = btn.closest('div[style*="margin-bottom"]');
            if (!monthDiv) return;
            const cbs = monthDiv.querySelectorAll('.ca-week-cb');
            const todasSel = Array.from(cbs).every(cb => cb.checked);
            cbs.forEach(cb => cb.checked = !todasSel);
            actualizarContador();
        });
    });
    selOverlay.querySelectorAll('.ca-week-cb').forEach(cb => cb.addEventListener('change', actualizarContador));
    actualizarContador();

    document.getElementById('ca-confirm').addEventListener('click', async () => {
        const selected = [];
        selOverlay.querySelectorAll('.ca-week-cb:checked').forEach(cb => selected.push(cb.dataset.week));
        if (!selected.length) { mostrarToast('Selecciona al menos una semana', 'warning'); return; }
        if (!confirm('Copiar horarios de ' + workers.length + ' trabajador' + (workers.length !== 1 ? 'es' : '') + ' a ' + selected.length + ' semana' + (selected.length !== 1 ? 's' : '') + '?')) return;

        try {
            const { editarTrabajador } = await import('../application/WorkersService.js');
            for (const w of workers) {
                const hrOrigen = getHorarioParaSemana(w, weekKeyOrigen);
                const excepciones = { ...(w.horario_excepciones || {}) };
                selected.forEach(wk => { excepciones[wk] = { ...hrOrigen.horario }; });
                await editarTrabajador(w.id, { horario_excepciones: excepciones });
            }
            mostrarToast('Copiado a ' + selected.length + ' semana' + (selected.length !== 1 ? 's' : '') + ' para ' + workers.length + ' trabajador' + (workers.length !== 1 ? 'es' : ''), 'success');
            selOverlay.remove();
            setTimeout(() => renderWorkerSchedule('schedule-container'), 200);
        } catch (err) {
            mostrarToast('Error: ' + err.message, 'error');
        }
    });
}

function escapeHtml(s) { return !s ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escapeAttr(s) { return !s ? '' : String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// ─── BANNER DE CUMPLIMIENTO ───
function actualizarBannerCumplimiento(workers, weekKey) {
    let ok = 0, warning = 0, error = 0, totalHs = 0;
    workers.forEach(w => {
        const hrInfo = getHorarioParaSemana(w, weekKey);
        const val = resumenValidacion(hrInfo.horario, hrInfo.maxSemanal);
        totalHs += val.total_horas;
        if (val.estado === 'ok') ok++;
        else if (val.estado === 'warning') warning++;
        else error++;
    });
    const okEl = document.getElementById('comp-ok-count');
    const warnEl = document.getElementById('comp-warning-count');
    const errEl = document.getElementById('comp-error-count');
    const totalEl = document.getElementById('comp-total-hs');
    if (okEl) okEl.textContent = '✅ ' + ok + ' cumplen';
    if (warnEl) warnEl.textContent = '⚠️ ' + warning + ' con advertencias';
    if (errEl) errEl.textContent = '❌ ' + error + ' exceden';
    if (totalEl) totalEl.textContent = Math.round(totalHs * 10) / 10 + 'h totales / ' + workers.length + ' trabajadores';
}

// ─── VALIDACION EN MODAL ───
function actualizarValidacionEditorModal(overlay) {
    const horario = recolectarHorario(overlay);
    const max = parseInt(document.getElementById('se-max')?.value) || null;
    const val = validarHorarioChile(horario, max);

    const totalEl = document.getElementById('se-total-hs');
    if (totalEl) totalEl.textContent = val.total_horas;

    const maxRef = max || 45;
    const bar = document.getElementById('se-progress-fill');
    if (bar && maxRef > 0) {
        const pct = Math.min(100, (val.total_horas / maxRef) * 100);
        bar.style.width = pct + '%';
        if (val.estado === 'error') bar.style.background = '#ff6b6b';
        else if (val.estado === 'warning') bar.style.background = '#fdcb6e';
        else bar.style.background = 'var(--primary-color)';
    }

    let msgsContainer = document.getElementById('se-validation-msgs');
    if (!msgsContainer) {
        msgsContainer = document.createElement('div');
        msgsContainer.id = 'se-validation-msgs';
        msgsContainer.style.marginTop = '8px';
        const progressContainer = document.getElementById('se-progress-bar')?.parentElement;
        if (progressContainer) progressContainer.after(msgsContainer);
    }

    const mensajes = [];
    val.errores.forEach(e => mensajes.push('<div class="val-msg val-error"><i class="fas fa-times-circle"></i> ' + escapeHtml(e) + '</div>'));
    val.advertencias.forEach(a => mensajes.push('<div class="val-msg val-warning"><i class="fas fa-exclamation-triangle"></i> ' + escapeHtml(a) + '</div>'));
    if (val.estado === 'ok' && val.total_horas > 0) {
        mensajes.push('<div class="val-msg val-ok"><i class="fas fa-check-circle"></i> Cumple con las normas laborales chilenas</div>');
    }
    msgsContainer.innerHTML = mensajes.join('');

    const progressContainer = document.getElementById('se-progress-bar');
    if (progressContainer) progressContainer.style.display = maxRef > 0 ? '' : 'none';
}

// ─── AYUDANTES DE SEMANA ───
function getSemanaInfo(workers, weekKey) {
    const year = parseInt(weekKey.split('-W')[0]);
    const weekNum = parseInt(weekKey.split('-W')[1]);
    const inicio = fechaDesdeSemanaISO(year, weekNum);
    const fin = new Date(inicio);
    fin.setDate(fin.getDate() + 6);

    // Detectar si algún trabajador tiene excepción para esta semana
    const algunaExcepcion = workers.some(w => (w.horario_excepciones || {})[weekKey]);

    return { inicio, fin, esExcepcion: algunaExcepcion };
}

function resumirSemana(workers, weekKey) {
    let ok = 0, total = 0;
    let algunaExcepcion = false;
    workers.forEach(w => {
        const hrInfo = getHorarioParaSemana(w, weekKey);
        const val = resumenValidacion(hrInfo.horario, hrInfo.maxSemanal);
        if (val.estado === 'ok') ok++;
        total++;
        if (hrInfo.esExcepcion) algunaExcepcion = true;
    });
    const badge = ok === total ? '✅' : ok > 0 ? '⚠️' : '❌';
    return { ok, total, badge, esExcepcion: algunaExcepcion };
}

function fechaDesdeSemanaISO(year, week) {
    const simple = new Date(year, 0, 1 + (week - 1) * 7);
    const dow = simple.getDay();
    const ISOweekStart = simple;
    if (dow <= 4) ISOweekStart.setDate(simple.getDate() - simple.getDay() + 1);
    else ISOweekStart.setDate(simple.getDate() + 8 - simple.getDay());
    return ISOweekStart;
}
