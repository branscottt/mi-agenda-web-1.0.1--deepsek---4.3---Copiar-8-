// services/ui/ServiceForm.js
// Formulario de creacion/edicion de servicio en admin.html

import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { formatearDinero } from '../../shared/infrastructure/formatters.js';

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
    // Scrollear al formulario
    form.scrollIntoView({ behavior: 'smooth' });
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.textContent = 'ACTUALIZAR SERVICIO';
}