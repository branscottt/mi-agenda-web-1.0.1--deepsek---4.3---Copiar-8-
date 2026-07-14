// src/workers/ui/WorkersListView.js
// Lista de trabajadores + CRUD con editor de horario semanal simplificado

import { mostrarToast } from '../../shared/infrastructure/toast.js';
import {
    getAllTrabajadores,
    agregarTrabajador,
    editarTrabajador,
    quitarTrabajador
} from '../application/WorkersService.js';

let _workers = [];

// ─── TIPOS DE JORNADA ───
const TIPOS_JORNADA = {
    full_time: { nombre: 'Full Time', desc: 'Lun–Vie 9–18, Sáb 9–14', horas: 45, dias: [1,2,3,4,5,6], inicio: '09:00', fin: '18:00', finSab: '14:00' },
    part_time: { nombre: 'Part Time', desc: 'Lun–Vie 9–13, Sáb libre', horas: 20, dias: [1,2,3,4,5], inicio: '09:00', fin: '13:00' },
    '30hrs':   { nombre: '30 hrs', desc: 'Lun–Vie 9–15, Sáb libre', horas: 30, dias: [1,2,3,4,5], inicio: '09:00', fin: '15:00' },
    custom:    { nombre: 'Personalizado', desc: 'Tú defines día por día', horas: 0, dias: [], inicio: '09:00', fin: '18:00' }
};

const NOMBRES_DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

function horarioPorTipo(tipo) {
    const t = TIPOS_JORNADA[tipo] || TIPOS_JORNADA.full_time;
    const horario = {};
    for (let i = 1; i <= 7; i++) {
        const activo = t.dias.includes(i);
        const horas = activo ? ((i === 6 && t.finSab) ? calcHorasSimples(t.inicio, t.finSab) : calcHorasSimples(t.inicio, t.fin)) : 0;
        const tieneColacion = activo && horas > 6;
        horario[String(i)] = {
            activo,
            inicio: activo ? (i === 6 && t.finSab ? t.inicio : t.inicio) : '00:00',
            fin: activo ? (i === 6 && t.finSab ? t.finSab : t.fin) : '00:00',
            colacion_inicio: tieneColacion ? '13:00' : '00:00',
            colacion_fin: tieneColacion ? '14:00' : '00:00'
        };
    }
    return horario;
}

function calcHorasSimples(ini, fin) {
    const [h1,m1] = (ini||'00:00').split(':').map(Number);
    const [h2,m2] = (fin||'00:00').split(':').map(Number);
    return ((h2*60+m2)-(h1*60+m1))/60;
}

function calcHoras(dia) {
    if (!dia || !dia.activo) return 0;
    const [h1,m1] = (dia.inicio||'00:00').split(':').map(Number);
    const [h2,m2] = (dia.fin||'00:00').split(':').map(Number);
    const [c1,c2] = [(dia.colacion_inicio||'00:00').split(':').map(Number), (dia.colacion_fin||'00:00').split(':').map(Number)];
    let total = (h2*60+m2)-(h1*60+m1);
    const colacion = (c1[0]*60+c1[1] > 0 && c2[0]*60+c2[1] > 0) ? (c2[0]*60+c2[1])-(c1[0]*60+c1[1]) : 0;
    return Math.max(0, Math.round((total - Math.max(0, colacion))/60*10)/10);
}

function totalSemanal(horario) {
    let t = 0;
    for (let i = 1; i <= 7; i++) {
        t += calcHoras(horario[String(i)]||{});
    }
    return t;
}

// ─── RENDER LISTA ───
export async function renderWorkersList(containerId = 'workers-list-container') {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Preservar el wrapper section si containerId es section-equipo
    const targetId = (containerId === 'section-equipo') ? 'workers-list-container' : containerId;
    const target = document.getElementById(targetId) || container;
    if (containerId === 'section-equipo' && targetId !== containerId) {
        // El container real es workers-list-container
        return renderWorkersList('workers-list-container');
    }

    target.innerHTML = '<div class="loading-spinner"><i class="fas fa-spinner fa-spin"></i> Cargando equipo...</div>';

    _workers = await getAllTrabajadores();

    if (!_workers.length) {
        target.innerHTML = `
            <div class="glass-panel">
                <div class="empty-state">
                    <i class="fas fa-users" style="font-size:2rem;opacity:0.3;"></i>
                    <p style="margin-top:10px;">Aún no has agregado trabajadores.</p>
                    <button class="btn-grad" onclick="window.__abrirFormTrabajador()">
                        <i class="fas fa-user-plus"></i> Agregar primer trabajador
                    </button>
                </div>
            </div>
        `;
        return;
    }

    target.innerHTML = `
        <div class="glass-panel">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
                <h3 style="margin:0;"><i class="fas fa-users"></i> Mi Equipo (${_workers.filter(w => w.activo).length} activos)</h3>
                <button class="btn-grad" onclick="window.__abrirFormTrabajador()">
                    <i class="fas fa-user-plus"></i> Agregar Trabajador
                </button>
            </div>
            <div class="workers-grid">
                ${_workers.map(w => {
                    const t = TIPOS_JORNADA[w.tipo_jornada] || TIPOS_JORNADA.full_time;
                    const hs = w.horario_semanal ? totalSemanal(w.horario_semanal) : t.horas;
                    return `
                    <div class="worker-card ${w.activo ? '' : 'inactive'}">
                        <div class="worker-avatar" style="background:${w.color || '#9d4edd'}">
                            <span>${w.nombre.charAt(0).toUpperCase()}</span>
                        </div>
                        <div class="worker-info">
                            <h4>${escapeHtml(w.nombre)}</h4>
                            ${w.habilidades ? `<p class="worker-skills">${escapeHtml(w.habilidades)}</p>` : ''}
                            <p class="worker-tipo-jornada">
                                <span class="jornada-badge tipo-${w.tipo_jornada||'full_time'}">${t.nombre}</span>
                                <span class="horas-texto">${hs}h/sem</span>
                            </p>
                        </div>
                        <div class="worker-actions">
                            <button class="btn-small" onclick="window.__editarTrabajador('${w.id}')" title="Editar horario y datos">
                                <i class="fas fa-edit"></i>
                            </button>
                            ${w.activo ? `
                                <button class="btn-small danger" onclick="window.__quitarTrabajador('${w.id}')" title="Quitar del equipo">
                                    <i class="fas fa-user-slash"></i>
                                </button>
                            ` : `<span class="inactive-badge">Inactivo</span>`}
                        </div>
                    </div>`;
                }).join('')}
            </div>
        </div>
    `;
}

// ─── FORMULARIO (simplificado) ───
export function abrirFormTrabajador(workerData = null) {
    const esEdicion = workerData !== null;
    const tipoActual = workerData?.tipo_jornada || 'full_time';
    const horarioActual = workerData?.horario_semanal || horarioPorTipo(tipoActual);

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'worker-form-overlay';
    overlay.style.overflowY = 'auto';
    overlay.innerHTML = `
        <div class="modal-content" style="max-width:480px;">
            <button class="modal-close" id="worker-form-close">&times;</button>
            <h3>${esEdicion ? '✏️ Editar' : '👤 Agregar'} Trabajador</h3>
            <form id="worker-form">
                <div style="margin-bottom:12px;">
                    <label style="display:block;font-size:0.8rem;font-weight:600;color:rgba(255,255,255,0.6);margin-bottom:4px;">Nombre *</label>
                    <input type="text" id="wf-nombre" required value="${esEdicion ? escapeAttr(workerData.nombre) : ''}" placeholder="Nombre del trabajador" style="width:100%;padding:10px 12px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:var(--text-color);font-size:0.9rem;box-sizing:border-box;">
                </div>
                <div class="form-row two-cols" style="gap:10px;margin-bottom:12px;">
                    <div>
                        <label style="display:block;font-size:0.78rem;font-weight:600;color:rgba(255,255,255,0.5);margin-bottom:4px;">Email</label>
                        <input type="email" id="wf-email" value="${esEdicion ? escapeAttr(workerData.email||'') : ''}" placeholder="correo@ejemplo.com" style="width:100%;padding:9px 10px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:var(--text-color);font-size:0.85rem;box-sizing:border-box;">
                    </div>
                    <div>
                        <label style="display:block;font-size:0.78rem;font-weight:600;color:rgba(255,255,255,0.5);margin-bottom:4px;">Teléfono</label>
                        <input type="tel" id="wf-telefono" value="${esEdicion ? escapeAttr(workerData.telefono||'') : ''}" placeholder="+56 9 1234 5678" style="width:100%;padding:9px 10px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:var(--text-color);font-size:0.85rem;box-sizing:border-box;">
                    </div>
                </div>
                <div style="margin-bottom:12px;">
                    <label style="display:block;font-size:0.78rem;font-weight:600;color:rgba(255,255,255,0.5);margin-bottom:4px;">¿Qué trabajos realiza?</label>
                    <div class="tags-input-wrapper">
                        <div class="tags-display" id="wf-tags-display">
                            ${(() => {
                                const skills = esEdicion ? (workerData.habilidades||'').split(',').map(s=>s.trim()).filter(Boolean) : [];
                                return skills.map(s => `<span class="tag-chip">${escapeHtml(s)}<i class="fas fa-times tag-remove" data-tag="${escapeAttr(s)}"></i></span>`).join('');
                            })()}
                            <input type="text" id="wf-tags-input" placeholder="${esEdicion ? 'Escribe y presiona Enter' : 'Ej: corte, tintura, manicura'}" class="tags-text-input">
                        </div>
                        <input type="hidden" id="wf-habilidades" value="${esEdicion ? escapeAttr(workerData.habilidades||'') : ''}">
                    </div>
                    <p class="field-hint" style="margin-top:4px;">Escribe un trabajo y presiona <strong>Enter</strong> o <strong>coma</strong> para agregarlo. Haz clic en <strong>×</strong> para quitarlo.</p>
                </div>
                <div style="margin-bottom:16px;">
                    <label style="display:block;font-size:0.78rem;font-weight:600;color:rgba(255,255,255,0.5);margin-bottom:4px;">Color</label>
                    <input type="color" id="wf-color" value="${esEdicion ? (workerData.color||'#9d4edd') : '#9d4edd'}" style="width:50px;height:38px;border-radius:8px;cursor:pointer;">
                </div>
                <div style="display:flex;gap:10px;">
                    <button type="button" class="btn-reset-styled" id="wf-cancel" style="flex:1;">Cancelar</button>
                    <button type="submit" class="btn-save-primary" style="flex:1;">
                        <i class="fas fa-save"></i> ${esEdicion ? 'Guardar Cambios' : 'Agregar'}
                    </button>
                </div>
            </form>
        </div>
    `;

    document.body.appendChild(overlay);
    overlay.style.display = 'flex';

    // Cerrar
    document.getElementById('worker-form-close').onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    document.getElementById('wf-cancel').onclick = () => overlay.remove();

    // ─── EVENTOS DEL FORMULARIO ───

    // 1. Tipo de jornada → actualiza días + horario
    overlay.querySelectorAll('.jornada-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            overlay.querySelectorAll('.jornada-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const tipo = btn.dataset.tipo;
            const conf = TIPOS_JORNADA[tipo] || TIPOS_JORNADA.full_time;

            // Mostrar/ocultar editores
            document.getElementById('wf-horario-general').style.display = tipo === 'custom' ? 'none' : '';
            document.getElementById('wf-horario-custom').style.display = tipo === 'custom' ? '' : 'none';

            if (tipo !== 'custom') {
                // Auto-completar días y horario general
                const inicio = conf.inicio || '09:00';
                const fin = conf.fin || '18:00';
                document.getElementById('wf-inicio-general').value = inicio;
                document.getElementById('wf-fin-general').value = fin;
                const tieneColacion = conf.horas > 6;
                document.getElementById('wf-colacion-inicio-general').value = tieneColacion ? '13:00' : '00:00';
                document.getElementById('wf-colacion-fin-general').value = tieneColacion ? '14:00' : '00:00';

                overlay.querySelectorAll('.wf-dia-cb').forEach(cb => {
                    const diaKey = parseInt(cb.dataset.dia);
                    const activo = conf.dias.includes(diaKey);
                    cb.checked = activo;
                    cb.closest('.wf-dia-label').classList.toggle('activo', activo);
                });
            }

            recalcTotal(overlay);
        });
    });

    // 2. Días check (modo normal)
    overlay.querySelectorAll('.wf-dia-cb').forEach(cb => {
        cb.addEventListener('change', () => {
            cb.closest('.wf-dia-label').classList.toggle('activo', cb.checked);
            recalcTotal(overlay);
        });
    });

    // 3. Horario general cambia
    ['wf-inicio-general', 'wf-fin-general', 'wf-colacion-inicio-general', 'wf-colacion-fin-general'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', () => recalcTotal(overlay));
    });

    // 4. Custom: checkbox día
    overlay.querySelectorAll('.wf-custom-cb').forEach(cb => {
        cb.addEventListener('change', () => {
            const row = cb.closest('.wf-dia-row');
            ['.wf-custom-inicio','.wf-custom-fin','.wf-custom-colacion-inicio','.wf-custom-colacion-fin'].forEach(sel => {
                const el = row.querySelector(sel);
                if (el) el.disabled = !cb.checked;
            });
            recalcTotal(overlay);
        });
    });
    overlay.querySelectorAll('.wf-custom-inicio, .wf-custom-fin, .wf-custom-colacion-inicio, .wf-custom-colacion-fin').forEach(inp => {
        inp.addEventListener('change', () => recalcTotal(overlay));
    });

    // ─── TAGS INPUT: skills multi-valor ───
    const tagsInput = document.getElementById('wf-tags-input');
    const tagsDisplay = document.getElementById('wf-tags-display');
    const hiddenSkills = document.getElementById('wf-habilidades');

    function actualizarHidden() {
        const tags = [];
        tagsDisplay.querySelectorAll('.tag-chip').forEach(chip => {
            const text = chip.childNodes[0]?.textContent?.trim();
            if (text) tags.push(text);
        });
        if (hiddenSkills) hiddenSkills.value = tags.join(', ');
    }

    if (tagsInput && tagsDisplay) {
        // Enter o coma → agregar tag
        tagsInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                const val = tagsInput.value.trim().replace(/,/g, '');
                if (!val) return;
                // No duplicados
                const existente = tagsDisplay.querySelector(`.tag-chip`);
                const yaExiste = Array.from(tagsDisplay.querySelectorAll('.tag-chip')).some(chip => 
                    chip.childNodes[0]?.textContent?.trim().toLowerCase() === val.toLowerCase()
                );
                if (yaExiste) { tagsInput.value = ''; return; }
                const chip = document.createElement('span');
                chip.className = 'tag-chip';
                chip.innerHTML = `${escapeHtml(val)}<i class="fas fa-times tag-remove"></i>`;
                chip.querySelector('.tag-remove').addEventListener('click', () => { chip.remove(); actualizarHidden(); });
                tagsInput.parentNode.insertBefore(chip, tagsInput);
                tagsInput.value = '';
                actualizarHidden();
            }
        });
        // Click en X para quitar tag (para chips precargados)
        tagsDisplay.querySelectorAll('.tag-remove').forEach(el => {
            el.addEventListener('click', () => { el.parentElement.remove(); actualizarHidden(); });
        });
        // Click fuera del input → también agrega
        tagsInput.addEventListener('blur', () => {
            const val = tagsInput.value.trim();
            if (val) {
                // Disparar evento Enter
                const e = new KeyboardEvent('keydown', { key: 'Enter' });
                tagsInput.dispatchEvent(e);
            }
        });
    }

    recalcTotal(overlay);

    // ─── SUBMIT ───
    document.getElementById('worker-form').onsubmit = async (e) => {
        e.preventDefault();
        const tipoJornada = overlay.querySelector('.jornada-btn.active')?.dataset.tipo || 'custom';
        const horario = {};

        if (tipoJornada === 'custom') {
            overlay.querySelectorAll('.wf-dia-row').forEach(row => {
                const dk = row.dataset.dia;
                const cb = row.querySelector('.wf-custom-cb');
                horario[dk] = {
                    activo: cb.checked,
                    inicio: cb.checked ? (row.querySelector('.wf-custom-inicio').value || '09:00') : '00:00',
                    fin: cb.checked ? (row.querySelector('.wf-custom-fin').value || '18:00') : '00:00',
                    colacion_inicio: cb.checked ? (row.querySelector('.wf-custom-colacion-inicio').value || '13:00') : '00:00',
                    colacion_fin: cb.checked ? (row.querySelector('.wf-custom-colacion-fin').value || '14:00') : '00:00'
                };
            });
        } else {
            const inicioGral = document.getElementById('wf-inicio-general').value || '09:00';
            const finGral = document.getElementById('wf-fin-general').value || '18:00';
            const colacionInicio = document.getElementById('wf-colacion-inicio-general').value || '13:00';
            const colacionFin = document.getElementById('wf-colacion-fin-general').value || '14:00';
            const conf = TIPOS_JORNADA[tipoJornada] || TIPOS_JORNADA.full_time;

            overlay.querySelectorAll('.wf-dia-cb').forEach(cb => {
                const dk = cb.dataset.dia;
                horario[dk] = {
                    activo: cb.checked,
                    inicio: cb.checked ? inicioGral : '00:00',
                    fin: cb.checked ? finGral : '00:00',
                    colacion_inicio: cb.checked ? colacionInicio : '00:00',
                    colacion_fin: cb.checked ? colacionFin : '00:00'
                };
            });
        }

        const data = {
            nombre: document.getElementById('wf-nombre').value.trim(),
            email: document.getElementById('wf-email').value.trim(),
            telefono: document.getElementById('wf-telefono').value.trim(),
            habilidades: (document.getElementById('wf-habilidades')?.value || '').trim(),
            color: document.getElementById('wf-color').value
        };
        if (!data.nombre) { mostrarToast('El nombre es obligatorio', 'warning'); return; }

        try {
            if (esEdicion) {
                await editarTrabajador(workerData.id, data);
                mostrarToast(`✅ ${data.nombre} actualizado`, 'success');
            } else {
                await agregarTrabajador(data);
                mostrarToast(`✅ ${data.nombre} agregado al equipo`, 'success');
            }
            overlay.remove();
            await renderWorkersList('workers-list-container');
        } catch (err) {
            mostrarToast('❌ Error: ' + err.message, 'error');
        }
    };
}

// ─── RECALCULAR TOTAL ───
function recalcTotal(overlay) {
    const tipo = overlay.querySelector('.jornada-btn.active')?.dataset.tipo || 'custom';
    let total = 0;

    if (tipo === 'custom') {
        overlay.querySelectorAll('.wf-dia-row').forEach(row => {
            const cb = row.querySelector('.wf-custom-cb');
            if (!cb.checked) return;
            const ini = row.querySelector('.wf-custom-inicio').value || '09:00';
            const fin = row.querySelector('.wf-custom-fin').value || '18:00';
            const ci = row.querySelector('.wf-custom-colacion-inicio').value || '00:00';
            const cf = row.querySelector('.wf-custom-colacion-fin').value || '00:00';
            const hs = calcHoras({ activo: true, inicio: ini, fin, colacion_inicio: ci, colacion_fin: cf });
            total += hs;
            const el = document.getElementById(`wf-hs-${row.dataset.dia}`);
            if (el) el.textContent = hs + 'h';
        });
    } else {
        overlay.querySelectorAll('.wf-dia-cb').forEach(cb => {
            if (!cb.checked) return;
            const ini = document.getElementById('wf-inicio-general').value || '09:00';
            const fin = document.getElementById('wf-fin-general').value || '18:00';
            const ci = document.getElementById('wf-colacion-inicio-general').value || '00:00';
            const cf = document.getElementById('wf-colacion-fin-general').value || '00:00';
            total += calcHoras({ activo: true, inicio: ini, fin, colacion_inicio: ci, colacion_fin: cf });
        });
    }

    const el = document.getElementById('wf-total-hs');
    if (el) el.textContent = Math.round(total * 10) / 10;
}

// ─── QUITAR ───
export async function quitarTrabajadorHandler(id) {
    const worker = _workers.find(w => w.id === id);
    if (!worker) return;
    if (!confirm(`¿Eliminar a ${worker.nombre} del equipo?`)) return;
    if (!confirm(`⚠️ Acción irreversible: ${worker.nombre} se eliminará permanentemente. Sus citas pasadas se conservarán sin trabajador asignado. ¿Confirmas?`)) return;
    try {
        await quitarTrabajador(id);
        mostrarToast(`${worker.nombre} quitado del equipo`, 'success');
        await renderWorkersList('workers-list-container');
    } catch (err) {
        mostrarToast('❌ Error: ' + err.message, 'error');
    }
}

// ─── EXPONER ───
export function exposeWorkerGlobals() {
    window.__abrirFormTrabajador = () => abrirFormTrabajador(null);
    window.__editarTrabajador = async (id) => {
        const worker = _workers.find(w => w.id === id);
        if (worker) abrirFormTrabajador(worker);
        else mostrarToast('Error: trabajador no encontrado', 'error');
    };
    window.__quitarTrabajador = (id) => quitarTrabajadorHandler(id);
}

function escapeHtml(s) { return !s ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escapeAttr(s) { return !s ? '' : String(s).replace(/"/g,'&quot;'); }
