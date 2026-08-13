// services/ui/ServiceForm.js
// Formulario de creacion/edicion de servicio en admin.html

import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { formatearDinero } from '../../shared/infrastructure/formatters.js';
import { getAllTrabajadores, getTrabajadoresDelServicio, asignarTrabajadoresAlServicio } from '../../workers/application/WorkersService.js';
import { calcularHorasEfectivas } from '../../workers/domain/horarioValidation.js';

/**
 * Un trabajador "tiene tiempo disponible" si su horario semanal tiene
 * al menos un día activo con horas efectivas > 0.
 */
function tieneDisponibilidad(w) {
    const hs = w && w.horario_semanal;
    if (!hs || typeof hs !== 'object') return false;
    for (let k = 1; k <= 7; k++) {
        const dia = hs[String(k)];
        if (dia && dia.activo && calcularHorasEfectivas(dia) > 0) return true;
    }
    return false;
}

export function configurarFormularioServicio() {
    const form = document.getElementById('service-form');
    if (!form) return;

    // Contador de caracteres en descripcion
    const textarea = document.getElementById('srv-desc');
    const contador = document.getElementById('char-count');
    if (textarea && contador) {
        textarea.addEventListener('input', function() { contador.textContent = this.value.length; });
    }

    document.getElementById('reset-form')?.addEventListener('click', () => {
        delete form.dataset.editId;
    });

    document.getElementById('clear-image')?.addEventListener('click', function() {
        document.getElementById('srv-image-url').value = '';
        const fi = document.getElementById('srv-image-file');
        if (fi) fi.value = '';
        const fnd = document.getElementById('file-name-display');
        if (fnd) fnd.textContent = 'Elegir imagen';
    });

    // Sincronizar duración con el hint del generador de módulos
    const durInput = document.getElementById('srv-duration');
    const genDurDisplay = document.getElementById('gen-duration-display');
    if (durInput && genDurDisplay) {
        const actualizarHintDuracion = () => {
            genDurDisplay.textContent = durInput.value || '60';
        };
        durInput.addEventListener('input', actualizarHintDuracion);
        durInput.addEventListener('change', actualizarHintDuracion);
        actualizarHintDuracion();
    }

    // Cargar checkboxes de trabajadores
    cargarWorkersCheckboxes();

    // Guardar trabajadores al hacer submit del form
    // El submit lo maneja el legacy script.js, pero interceptamos para
    // guardar la relación servicio↔trabajadores
    const existingSubmit = form.querySelector('button[type="submit"]');
    if (existingSubmit) {
        existingSubmit.addEventListener('click', async (e) => {
            const editId = form.dataset.editId;
            if (!editId) return; // Solo en edición se necesita guardar la relación
    
            // Obtener workers seleccionados
            const checkboxes = document.querySelectorAll('#service-workers-list input[type="checkbox"]:checked');
            const selectedIds = Array.from(checkboxes).map(cb => cb.value);
            try {
                await asignarTrabajadoresAlServicio(editId, selectedIds);
            } catch (err) {
                console.error('Error guardando trabajadores del servicio:', err);
            }
        });
    }
}

// Expuesta globalmente para que script.js legacy pueda llamarla al crear/editar
export async function guardarWorkersDelServicio(servicioId) {
    const checkboxes = document.querySelectorAll('#service-workers-list input[type="checkbox"]:checked');
    const selectedIds = Array.from(checkboxes).map(cb => cb.value);
    try {
        await asignarTrabajadoresAlServicio(servicioId, selectedIds);
    } catch (err) {
        console.error('Error guardando trabajadores del servicio:', err);
    }
}

async function cargarWorkersCheckboxes() {
    const container = document.getElementById('service-workers-list');
    if (!container) return;

    // El paso 4 del formulario (details.form-step) se oculta por completo
    // cuando no hay trabajadores activos: crear el servicio no debe exigir nada.
    const paso = container.closest('details.form-step') || container.closest('details');

    try {
        const workers = await getAllTrabajadores();
        const activos = workers.filter(w => w.activo);

        if (!activos.length) {
            container.innerHTML = '';
            container.dataset.requiereTrabajador = '0';
            if (paso) paso.style.display = 'none';
            return;
        }
        if (paso) paso.style.display = '';

        // Determinar workers ya seleccionados (modo edición)
        const editId = document.getElementById('service-form')?.dataset?.editId;
        let selectedIds = [];
        if (editId) {
            try {
                const existing = await getTrabajadoresDelServicio(editId);
                selectedIds = (existing || []).map(w => w.id);
            } catch (e) {
                // Silencioso
            }
        }

        // Separar: solo los que tienen horario configurado son seleccionables
        const disponibles = activos.filter(tieneDisponibilidad);
        const sinHorario = activos.filter(w => !tieneDisponibilidad(w));
        // En edición, los ya asignados se mantienen habilitados aunque no tengan horario
        const sinHorarioYaAsignados = sinHorario.filter(w => selectedIds.includes(w.id));
        const sinHorarioBloqueados = sinHorario.filter(w => !selectedIds.includes(w.id));

        container.dataset.requiereTrabajador = disponibles.length > 0 ? '1' : '0';

        const renderWorker = (w, bloqueado) => {
            const checked = selectedIds.includes(w.id);
            const disabled = bloqueado ? 'disabled' : '';
            const cls = `worker-checkbox-label ${checked ? 'checked' : ''} ${bloqueado ? 'worker-checkbox-disabled' : ''}`;
            return `
                <label class="${cls}" title="${bloqueado ? 'Sin horario configurado — define su horario en la sección Horarios antes de asignarlo' : ''}">
                    <input type="checkbox" value="${w.id}" ${checked ? 'checked' : ''} ${disabled}>
                    <span class="worker-check-avatar" style="background:${w.color || '#9d4edd'};${bloqueado ? 'filter:grayscale(1);opacity:0.5;' : ''}">
                        ${w.nombre.charAt(0).toUpperCase()}
                    </span>
                    <span class="worker-check-name">${escapeHtml(w.nombre)}</span>
                    <span class="worker-check-skills">
                        ${bloqueado
                            ? '<span style="color:#ff9f43;">⛔ Sin horario</span>'
                            : (w.habilidades ? escapeHtml(w.habilidades) : 'Disponible')}
                    </span>
                </label>
            `;
        };

        container.innerHTML = `
            <div class="workers-checkbox-grid">
                ${disponibles.map(w => renderWorker(w, false)).join('')}
                ${sinHorarioYaAsignados.map(w => renderWorker(w, false)).join('')}
                ${sinHorarioBloqueados.map(w => renderWorker(w, true)).join('')}
            </div>
            ${disponibles.length > 0 ? `
                <p class="field-hint" style="margin-top:6px;color:#ffd700;">
                    <i class="fas fa-exclamation-triangle"></i> Obligatorio: selecciona al menos un trabajador con disponibilidad para este servicio.
                </p>
            ` : `
                <p class="field-hint" style="margin-top:6px;">
                    Ningún trabajador tiene horario configurado aún. Puedes crear el servicio sin asignar trabajadores, o configurar horarios en la sección Horarios.
                </p>
            `}
        `;

        // Event listeners para toggle class
        container.querySelectorAll('.worker-checkbox-label input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', () => {
                cb.closest('.worker-checkbox-label').classList.toggle('checked', cb.checked);
            });
        });

    } catch (e) {
        console.error('Error cargando workers checkboxes:', e);
        container.innerHTML = '';
        container.dataset.requiereTrabajador = '0';
        if (paso) paso.style.display = 'none';
    }
}

/**
 * Validación usada por legacy script.js al CREAR un servicio.
 * Solo exige seleccionar trabajador si existen trabajadores con disponibilidad horaria.
 * @returns {{valido: boolean, mensaje: string}}
 */
export function validarWorkersServicio() {
    const container = document.getElementById('service-workers-list');
    if (!container || container.dataset.requiereTrabajador !== '1') {
        return { valido: true, mensaje: '' };
    }
    const checkboxes = container.querySelectorAll('input[type="checkbox"]:checked');
    if (!checkboxes.length) {
        return {
            valido: false,
            mensaje: '⚠️ Hay trabajadores con disponibilidad horaria. Selecciona al menos uno para este servicio (o quita el horario a todos en la sección Horarios si quieres crearlo sin asignación).'
        };
    }
    return { valido: true, mensaje: '' };
}

export async function editarServicioForm(id, servicio) {
    const form = document.getElementById('service-form');
    if (!form) return;
    form.dataset.editId = id;
    document.getElementById('srv-name').value = servicio.nombre || '';
    document.getElementById('srv-price').value = servicio.precio || 0;
    document.getElementById('srv-desc').value = servicio.descripcion || '';
    document.getElementById('srv-image-url').value = servicio.imagen || '';
    const fi2 = document.getElementById('srv-image-file');
    if (fi2) fi2.value = '';
    const fnd2 = document.getElementById('file-name-display');
    if (fnd2) fnd2.textContent = 'Elegir imagen';
    document.getElementById('srv-featured').checked = servicio.destacado || false;
    document.getElementById('srv-active').checked = servicio.activo !== false;
    // Cargar fechas
    const fechas = servicio.fechas || Object.keys(servicio.disponibilidad || {});
    window.selectedDates = new Set(fechas);
    if (typeof renderCalendar === 'function') renderCalendar();
    // Cargar modulos
    const modulos = Object.values(servicio.disponibilidad || {})[0] || [];
    window.serviceModules = modulos.map((m, i) => ({ ...m, id: window.generateModuleId() }));
    if (typeof renderModulesList === 'function') renderModulesList();
    // Recargar checkboxes de trabajadores
    await cargarWorkersCheckboxes();
    // Scrollear al formulario
    form.scrollIntoView({ behavior: 'smooth' });
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.textContent = 'ACTUALIZAR SERVICIO';
}

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
