// services/ui/ServiceForm.js
// Formulario de creacion/edicion de servicio en admin.html

import { saveServicio } from '../application/ServiceService.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { formatearDinero } from '../../shared/infrastructure/formatters.js';

export function configurarFormularioServicio() {
    const form = document.getElementById('service-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = form.dataset.editId || null;
        const servicio = {
            id: id || undefined,
            nombre: document.getElementById('srv-name')?.value.trim(),
            categoria: document.getElementById('srv-category')?.value,
            precio: Number(document.getElementById('srv-price')?.value) || 0,
            descripcion: document.getElementById('srv-desc')?.value.trim() || '',
            imagen: document.getElementById('srv-image-url')?.value.trim() || '',
            destacado: document.getElementById('srv-featured')?.checked || false,
            activo: document.getElementById('srv-active')?.checked !== false,
            disponibilidad: buildDisponibilidadFromForm()
        };

        if (!servicio.nombre || !servicio.categoria || servicio.precio <= 0) {
            mostrarToast('Completa nombre, categoría y precio', 'error');
            return;
        }

        const btn = form.querySelector('button[type="submit"]');
        if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }

        try {
            await saveServicio(servicio);
            mostrarToast('Servicio guardado correctamente', 'success');
            form.reset();
            delete form.dataset.editId;
            if (typeof cargarServiciosExistentes === 'function') cargarServiciosExistentes();
            if (typeof actualizarEstadisticas === 'function') actualizarEstadisticas();
        } catch (err) {
            mostrarToast('Error: ' + err.message, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = id ? 'ACTUALIZAR SERVICIO' : 'CREAR SERVICIO'; }
        }
    });

    document.getElementById('reset-form')?.addEventListener('click', () => {
        delete form.dataset.editId;
    });
}

function buildDisponibilidadFromForm() {
    const fechasStr = document.getElementById('service-dates')?.value;
    const modulesStr = document.getElementById('service-modules')?.value;
    let fechas = [];
    let modules = [];
    try { fechas = JSON.parse(fechasStr || '[]'); } catch(e) {}
    try { modules = JSON.parse(modulesStr || '[]'); } catch(e) {}
    if (!fechas.length || !modules.length) return {};
    const disponibilidad = {};
    fechas.forEach(f => {
        disponibilidad[f] = modules.map(m => ({
            startTime: m.startTime,
            endTime: m.endTime,
            cupos: m.cupos ?? 10
        }));
    });
    return disponibilidad;
}

export async function editarServicioForm(id, servicio) {
    const form = document.getElementById('service-form');
    if (!form) return;
    form.dataset.editId = id;
    document.getElementById('srv-name').value = servicio.nombre || '';
    document.getElementById('srv-category').value = servicio.categoria || '';
    document.getElementById('srv-price').value = servicio.precio || 0;
    document.getElementById('srv-desc').value = servicio.descripcion || '';
    document.getElementById('srv-image-url').value = servicio.imagen || '';
    document.getElementById('srv-featured').checked = servicio.destacado || false;
    document.getElementById('srv-active').checked = servicio.activo !== false;
    // Cargar fechas
    const fechas = servicio.fechas || Object.keys(servicio.disponibilidad || {});
    window.selectedDates = new Set(fechas);
    if (typeof updateDatesPreview === 'function') updateDatesPreview();
    if (typeof renderCalendar === 'function') renderCalendar();
    // Cargar modulos
    const modulos = Object.values(servicio.disponibilidad || {})[0] || [];
    window.serviceModules = modulos.map((m, i) => ({ ...m, id: Date.now() + i }));
    if (typeof renderModulesList === 'function') renderModulesList();
    // Scrollear al formulario
    form.scrollIntoView({ behavior: 'smooth' });
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.textContent = 'ACTUALIZAR SERVICIO';
}