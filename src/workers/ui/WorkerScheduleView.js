// src/workers/ui/WorkerScheduleView.js
// Calendario semanal visual — clic en trabajador abre editor de horario

import { getAllTrabajadores } from '../application/WorkersService.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';

const DIAS = ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'];

export async function renderWorkerSchedule(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '<div class="loading-spinner"><i class="fas fa-spinner fa-spin"></i> Cargando horarios...</div>';
    let workers = await getAllTrabajadores();
    const activos = workers.filter(w => w.activo);
    if (!activos.length) {
        container.innerHTML = '<div class="glass-panel"><div class="empty-state"><i class="fas fa-calendar-times" style="font-size:2rem;opacity:0.3;"></i><p style="margin-top:10px;">No hay trabajadores activos.</p><p class="field-hint">Agrega trabajadores en <strong>Mi Equipo</strong> primero.</p></div></div>';
        return;
    }
    const hoy = new Date();
    const inicioSemana = new Date(hoy);
    inicioSemana.setDate(hoy.getDate() - ((hoy.getDay() + 6) % 7));

    let html = `
        <div class="glass-panel">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
                <h3 style="margin:0;"><i class="fas fa-calendar-alt"></i> Horarios del Equipo</h3>
                <span style="font-size:0.85rem;color:rgba(255,255,255,0.5);">Semana del ${formatearFecha(inicioSemana)}</span>
            </div>
            <div class="step-guide" style="margin-bottom:14px;">
                <i class="fas fa-info-circle"></i>
                <span>Haz clic en cualquier trabajador para editar su horario. Los bloques verdes muestran disponibilidad. El tenedor 🍴 indica horario de colación.</span>
            </div>
            <div class="schedule-container">
                <div class="schedule-header-row">
                    <div class="schedule-corner"></div>
                    ${[0,1,2,3,4,5,6].map(i => {
                        const d = new Date(inicioSemana); d.setDate(inicioSemana.getDate() + i);
                        const esHoy = d.toDateString() === hoy.toDateString();
                        const idx = d.getDay() === 0 ? 6 : d.getDay() - 1;
                        return `<div class="schedule-day-header ${esHoy ? 'today' : ''}"><span class="s-day-name">${DIAS[idx].slice(0,3)}</span><span class="s-day-num">${d.getDate()}</span></div>`;
                    }).join('')}
                </div>
                ${activos.map(w => {
                    const hr = w.horario_semanal || {};
                    const total = [1,2,3,4,5,6,7].reduce((s,k) => s + calcHoras(hr[k]||{}), 0);
                    return `
                        <div class="schedule-worker-row clickable" data-worker='${escapeAttr(JSON.stringify(w))}' style="border-left:4px solid ${w.color||'#9d4edd'};cursor:pointer;" title="Editar horario de ${escapeAttr(w.nombre)}">
                            <div class="schedule-worker-info">
                                <span class="sw-avatar" style="background:${w.color||'#9d4edd'}">${w.nombre.charAt(0).toUpperCase()}</span>
                                <div class="sw-details">
                                    <strong class="sw-name">${escapeHtml(w.nombre)}</strong>
                                    <span class="sw-total">${total}h/sem</span>
                                </div>
                            </div>
                            ${[0,1,2,3,4,5,6].map(i => {
                                const d = new Date(inicioSemana); d.setDate(inicioSemana.getDate() + i);
                                const dk = String(d.getDay() === 0 ? 7 : d.getDay());
                                const dia = hr[dk];
                                const esHoy = d.toDateString() === hoy.toDateString();
                                if (!dia || !dia.activo) return `<div class="schedule-day-cell off ${esHoy?'today':''}"><span class="s-day-status">—</span></div>`;
                                const horas = calcHoras(dia);
                                const tieneColacion = dia.colacion_inicio && dia.colacion_inicio !== '00:00';
                                return `
                                    <div class="schedule-day-cell on ${esHoy?'today':''}">
                                        <div class="s-day-bar" style="background:${w.color||'#9d4edd'}15;">
                                            <div class="s-day-fill" style="width:${Math.min(100,(horas/12)*100)}%;background:${w.color||'#9d4edd'};">
                                                <span class="s-day-hours">${dia.inicio}${tieneColacion?' 🍴':''} ${dia.fin}</span>
                                            </div>
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                        </div>`;
                }).join('')}
            </div>
            <div class="schedule-legend" style="margin-top:14px;display:flex;gap:16px;justify-content:center;flex-wrap:wrap;">
                <span class="legend-item"><span class="legend-dot" style="background:rgba(0,184,148,0.4);"></span> Disponible</span>
                <span class="legend-item"><span class="legend-dot" style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);"></span> Descanso</span>
                <span class="legend-item"><span class="legend-dot" style="background:rgba(253,203,110,0.5);">🍴</span> Colación</span>
                <span class="legend-item"><span class="legend-dot" style="background:var(--primary-color);"></span> Clic = editar horario</span>
            </div>
        </div>`;
    container.innerHTML = html;

    // Click en fila → abrir editor de horario
    container.querySelectorAll('.schedule-worker-row.clickable').forEach(row => {
        row.addEventListener('click', () => {
            try {
                const worker = JSON.parse(row.dataset.worker);
                abrirEditorHorario(worker);
            } catch(e) { console.error(e); }
        });
    });
}

// ─── MODAL LIGERO: EDITAR SOLO HORARIO ───
export function abrirEditorHorario(worker) {
    const horarioActual = worker.horario_semanal || {};
    const tipoActual = worker.tipo_jornada || 'full_time';
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'schedule-editor-overlay';
    overlay.style.overflowY = 'auto';
    overlay.innerHTML = `
        <div class="modal-content" style="max-width:520px;">
            <button class="modal-close" id="se-close">&times;</button>
            <h3><i class="fas fa-clock"></i> Horario: ${escapeHtml(worker.nombre)}</h3>
            <form id="se-form">
                <div class="form-section">
                    <h4 class="config-section-title"><i class="fas fa-user"></i> ${escapeHtml(worker.nombre)}</h4>
                    <p class="field-hint" style="margin-bottom:10px;">Define los días y horarios. La colación (🍴) se descuenta automáticamente del total.</p>

                    <label style="display:block;font-size:0.8rem;font-weight:600;color:rgba(255,255,255,0.6);margin-bottom:6px;">Días que trabaja</label>
                    <div id="se-dias" class="wf-dias-grid" style="margin-bottom:12px;">
                        ${DIAS.map((d,i)=>{
                            const dk = String(i+1);
                            const a = horarioActual[dk]?.activo || false;
                            return `<label class="wf-dia-label ${a?'activo':''}"><input type="checkbox" class="se-dia-cb" data-dia="${dk}" ${a?'checked':''}><span>${d.slice(0,3)}</span></label>`;
                        }).join('')}
                    </div>

                    <label style="display:block;font-size:0.8rem;font-weight:600;color:rgba(255,255,255,0.6);margin-bottom:6px;">Horario general</label>
                    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                        <div class="time-input-group"><i class="fas fa-play" style="font-size:0.65rem;color:rgba(255,255,255,0.3);"></i><input type="time" id="se-inicio" value="${horarioActual['1']?.inicio||'09:00'}" class="se-time"></div>
                        <span style="color:rgba(255,255,255,0.2);">│</span>
                        <div class="time-input-group"><i class="fas fa-utensils" style="font-size:0.65rem;color:rgba(253,203,110,0.5);"></i><input type="time" id="se-colacion-inicio" value="${horarioActual['1']?.colacion_inicio||'13:00'}" class="se-time" style="width:80px;"><span style="color:rgba(255,255,255,0.2);font-size:0.7rem;">a</span><input type="time" id="se-colacion-fin" value="${horarioActual['1']?.colacion_fin||'14:00'}" class="se-time" style="width:80px;"></div>
                        <span style="color:rgba(255,255,255,0.2);">│</span>
                        <div class="time-input-group"><i class="fas fa-stop" style="font-size:0.65rem;color:rgba(255,255,255,0.3);"></i><input type="time" id="se-fin" value="${horarioActual['1']?.fin||'18:00'}" class="se-time"></div>
                    </div>

                    <div id="se-total" style="text-align:center;margin-top:12px;padding:10px;background:rgba(157,78,221,0.06);border-radius:10px;font-size:0.9rem;">
                        Total semanal: <strong id="se-total-hs" style="color:var(--primary-color);font-size:1.1rem;">0</strong> horas
                    </div>
                </div>
                <div style="display:flex;gap:10px;margin-top:14px;">
                    <button type="button" class="btn-reset-styled" id="se-cancel" style="flex:1;">Cancelar</button>
                    <button type="submit" class="btn-save-primary" style="flex:1;"><i class="fas fa-save"></i> Guardar Horario</button>
                </div>
            </form>
        </div>`;
    document.body.appendChild(overlay);
    overlay.style.display = 'flex';

    document.getElementById('se-close').onclick = () => overlay.remove();
    overlay.onclick = e => { if(e.target===overlay)overlay.remove(); };
    document.getElementById('se-cancel').onclick = () => overlay.remove();

    const recalc = () => {
        let total = 0;
        overlay.querySelectorAll('.se-dia-cb').forEach(cb => {
            if(!cb.checked) return;
            const ini = document.getElementById('se-inicio').value||'09:00';
            const fin = document.getElementById('se-fin').value||'18:00';
            const ci = document.getElementById('se-colacion-inicio').value||'00:00';
            const cf = document.getElementById('se-colacion-fin').value||'00:00';
            total += calcHoras({activo:true,inicio:ini,fin,colacion_inicio:ci,colacion_fin:cf});
        });
        document.getElementById('se-total-hs').textContent = Math.round(total*10)/10;
    };

    overlay.querySelectorAll('.se-dia-cb').forEach(cb => cb.addEventListener('change', function(){ this.closest('.wf-dia-label').classList.toggle('activo',this.checked); recalc(); }));
    ['se-inicio','se-fin','se-colacion-inicio','se-colacion-fin'].forEach(id => document.getElementById(id)?.addEventListener('change', recalc));
    recalc();

    document.getElementById('se-form').onsubmit = async e => {
        e.preventDefault();
        const horario = {};
        overlay.querySelectorAll('.se-dia-cb').forEach(cb => {
            const dk = cb.dataset.dia;
            const ini = document.getElementById('se-inicio').value||'09:00';
            const fin = document.getElementById('se-fin').value||'18:00';
            const ci = document.getElementById('se-colacion-inicio').value||'13:00';
            const cf = document.getElementById('se-colacion-fin').value||'14:00';
            horario[dk] = {activo:cb.checked,inicio:cb.checked?ini:'00:00',fin:cb.checked?fin:'00:00',colacion_inicio:cb.checked?ci:'00:00',colacion_fin:cb.checked?cf:'00:00'};
        });
        try {
            const {editarTrabajador} = await import('../application/WorkersService.js');
            await editarTrabajador(worker.id, {
                tipo_jornada: 'custom',
                horario_semanal: horario
            });
            mostrarToast(`✅ Horario de ${worker.nombre} actualizado`,'success');
            overlay.remove();
            const container = document.getElementById('section-horarios');
            if(container) renderWorkerSchedule('schedule-container');
        } catch(err) {
            mostrarToast('❌ Error: '+err.message,'error');
        }
    };
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
function escapeHtml(s) { return !s ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escapeAttr(s) { return !s ? '' : String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
