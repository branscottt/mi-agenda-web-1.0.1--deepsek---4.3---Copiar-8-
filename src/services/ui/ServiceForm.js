// services/ui/ServiceForm.js
// Formulario de creacion/edicion de servicio en admin.html

import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { formatearDinero } from '../../shared/infrastructure/formatters.js';
import { getAllTrabajadores, getTrabajadoresDelServicio, asignarTrabajadoresAlServicio } from '../../workers/application/WorkersService.js';

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

    try {
        const workers = await getAllTrabajadores();
        const activos = workers.filter(w => w.activo);

        if (!activos.length) {
            container.innerHTML = `
                <div class="empty-state-small">
                    <i class="fas fa-user-slash" style="opacity:0.3;"></i>
                    <p style="margin-top:6px;font-size:0.85rem;">No hay trabajadores activos.</p>
                    <a href="#" onclick="navigateTo('equipo');return false;" style="color:var(--primary-color);font-size:0.82rem;">
                        Agregar trabajadores en Mi Equipo
                    </a>
                </div>
            `;
            return;
        }

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

        container.innerHTML = `
            <div class="workers-checkbox-grid">
                ${activos.map(w => `
                    <label class="worker-checkbox-label ${selectedIds.includes(w.id) ? 'checked' : ''}">
                        <input type="checkbox" value="${w.id}" ${selectedIds.includes(w.id) ? 'checked' : ''}>
                        <span class="worker-check-avatar" style="background:${w.color || '#9d4edd'}">
                            ${w.nombre.charAt(0).toUpperCase()}
                        </span>
                        <span class="worker-check-name">${escapeHtml(w.nombre)}</span>
                        ${w.habilidades ? `<span class="worker-check-skills">${escapeHtml(w.habilidades)}</span>` : ''}
                    </label>
                `).join('')}
            </div>
            <p class="field-hint" style="margin-top:6px;">
                Marca los trabajadores que pueden realizar este servicio. Si no marcas ninguno, el servicio funcionará sin asignación de trabajador.
            </p>
        `;

        // Event listeners para toggle class
        container.querySelectorAll('.worker-checkbox-label input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', () => {
                cb.closest('.worker-checkbox-label').classList.toggle('checked', cb.checked);
            });
        });

    } catch (e) {
        console.error('Error cargando workers checkboxes:', e);
        container.innerHTML = '<p class="field-hint" style="color:var(--danger);">Error al cargar trabajadores</p>';
    }
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
