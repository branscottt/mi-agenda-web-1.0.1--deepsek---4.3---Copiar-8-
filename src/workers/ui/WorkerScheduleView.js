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

// ─── MODAL: EDITAR HORARIO (flexible) ───
export function abrirEditorHorario(worker) {
    const hr = worker.horario_semanal || {};
    const maxHr = worker.horario_max_semanal || 0;
    // Detectar si todos los días activos tienen el mismo horario
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
            <h3><i class="fas fa-clock"></i> Horario: ${escapeHtml(worker.nombre)}</h3>
            <form id="se-form">

                <!-- MODO: mismo horario / por día -->
                <div style="margin-bottom:14px;display:flex;gap:8px;background:rgba(255,255,255,0.02);border-radius:10px;padding:6px;">
                    <button type="button" class="se-modo-btn ${modoUniforme?'active':''}" data-modo="uniforme" style="flex:1;padding:10px;border-radius:8px;border:2px solid transparent;cursor:pointer;font-weight:600;font-size:0.82rem;transition:all 0.2s;background:${modoUniforme?'rgba(157,78,221,0.1)':'transparent'};color:${modoUniforme?'#c77dff':'rgba(255,255,255,0.5)'};${modoUniforme?'border-color:var(--primary-color)':''}">
                        <i class="fas fa-equals"></i> Mismo horario todos los días
                    </button>
                    <button type="button" class="se-modo-btn ${!modoUniforme?'active':''}" data-modo="por-dia" style="flex:1;padding:10px;border-radius:8px;border:2px solid transparent;cursor:pointer;font-weight:600;font-size:0.82rem;transition:all 0.2s;background:${!modoUniforme?'rgba(157,78,221,0.1)':'transparent'};color:${!modoUniforme?'#c77dff':'rgba(255,255,255,0.5)'};${!modoUniforme?'border-color:var(--primary-color)':''}">
                        <i class="fas fa-list"></i> Horario diferente por día
                    </button>
                </div>

                <!-- SECCIÓN: uniforme -->
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

                <!-- SECCIÓN: por día -->
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

                <!-- MÁXIMO SEMANAL + PROGRESS -->
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
                    <button type="button" class="btn-secondary" id="se-copy-week" style="flex:1;min-width:120px;"><i class="fas fa-copy"></i> Copiar a siguiente semana</button>
                    <button type="submit" class="btn-save-primary" style="flex:2;"><i class="fas fa-save"></i> Guardar</button>
                </div>
            </form>
        </div>`;
    document.body.appendChild(overlay);
    overlay.style.display = 'flex';

    // Cerrar
    document.getElementById('se-close').onclick = () => overlay.remove();
    overlay.onclick = e => { if(e.target===overlay) overlay.remove(); };
    document.getElementById('se-cancel').onclick = () => overlay.remove();

    // ─── RECALC ───
    function recalc() {
        let total = 0;
        const modo = overlay.querySelector('.se-modo-btn.active')?.dataset.modo || 'uniforme';
        if (modo === 'uniforme') {
            const ini=document.getElementById('se-inicio').value||'09:00', fin=document.getElementById('se-fin').value||'18:00';
            const ci=document.getElementById('se-ci').value||'00:00', cf=document.getElementById('se-cf').value||'00:00';
            overlay.querySelectorAll('.se-dia-cb').forEach(cb => { if(cb.checked) total+=calcHoras({activo:true,inicio:ini,fin,colacion_inicio:ci,colacion_fin:cf}); });
        } else {
            overlay.querySelectorAll('.se-pd-cb').forEach(cb => {
                if(!cb.checked) return;
                const row=cb.closest('.se-dia-row'); const k=cb.dataset.dia;
                const ini=row.querySelector('.se-pd-inicio').value||'09:00', fin=row.querySelector('.se-pd-fin').value||'18:00';
                const ci=row.querySelector('.se-pd-ci').value||'00:00', cf=row.querySelector('.se-pd-cf').value||'00:00';
                const hs=calcHoras({activo:true,inicio:ini,fin,colacion_inicio:ci,colacion_fin:cf});
                total+=hs;
                const el=row.querySelector('.se-pd-hs'); if(el) el.textContent=hs+'h';
            });
        }
        const totalEl=document.getElementById('se-total-hs'); if(totalEl) totalEl.textContent=Math.round(total*10)/10;
        // Progress bar
        const max=parseInt(document.getElementById('se-max')?.value)||0;
        const bar=document.getElementById('se-progress-fill');
        if(bar&&max>0){ const pct=Math.min(100,(total/max)*100); bar.style.width=pct+'%'; bar.style.background=pct>100?'#ff6b6b':pct>85?'#fdcb6e':'var(--primary-color)'; }
        else if(bar){ bar.style.width='0%'; }
    }

    // ─── EVENTOS ───
    // Toggle modo
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

    // Uniforme: días
    overlay.querySelectorAll('.se-dia-cb').forEach(cb => cb.addEventListener('change', function(){ this.closest('.wf-dia-label').classList.toggle('activo',this.checked); recalc(); }));
    // Uniforme: times
    ['se-inicio','se-fin','se-ci','se-cf'].forEach(id => document.getElementById(id)?.addEventListener('change', recalc));

    // Por día: checkbox
    overlay.querySelectorAll('.se-pd-cb').forEach(cb => {
        cb.addEventListener('change', function(){
            const row=this.closest('.se-dia-row');
            row.style.opacity=this.checked?'1':'0.4';
            row.querySelectorAll('input[type="time"]').forEach(inp=>inp.disabled=!this.checked);
            recalc();
        });
    });
    // Por día: times
    overlay.querySelectorAll('.se-pd-inicio, .se-pd-fin, .se-pd-ci, .se-pd-cf').forEach(inp => inp.addEventListener('change', recalc));
    // Max horas
    document.getElementById('se-max')?.addEventListener('input', recalc);

    recalc();

    // ─── COPIAR A SIGUIENTE SEMANA ───
    document.getElementById('se-copy-week')?.addEventListener('click', () => {
        const data = recolectarHorario(overlay);
        const max = parseInt(document.getElementById('se-max')?.value)||0;
        overlay.remove();

        // Crear worker ficticio con los mismos datos para abrir el editor de nuevo
        // simulando la "siguiente semana" (el horario se guarda igual, el usuario puede editarlo)
        const workerCopy = { ...worker, horario_semanal: data, horario_max_semanal: max };
        mostrarToast('Horario copiado. Ahora puedes ajustarlo para la próxima semana.', 'info');
        abrirEditorHorario(workerCopy);
    });

    // ─── SUBMIT ───
    document.getElementById('se-form').onsubmit = async e => {
        e.preventDefault();
        const horario = recolectarHorario(overlay);
        const max = parseInt(document.getElementById('se-max')?.value)||null;
        try {
            const {editarTrabajador} = await import('../application/WorkersService.js');
            await editarTrabajador(worker.id, { tipo_jornada: 'custom', horario_semanal: horario, horario_max_semanal: max });
            mostrarToast(`✅ Horario de ${worker.nombre} actualizado`, 'success');
            overlay.remove();
            const container = document.getElementById('schedule-container')?.closest('.glass-panel');
            if(container) renderWorkerSchedule('schedule-container');
        } catch(err) { mostrarToast('❌ Error: '+err.message, 'error'); }
    };
}

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
function escapeHtml(s) { return !s ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escapeAttr(s) { return !s ? '' : String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
