// appointments/ui/AdminAppointmentList.js
// Renderiza lista de citas en el panel admin con acciones

import { getAllCitas, deleteCita } from '../application/AppointmentService.js';
import { formatearDinero, formatFechaCorta, formatTimeDisplay } from '../../shared/infrastructure/formatters.js';
import { aplicarClaseUrgencia } from '../../shared/infrastructure/urgency-calculator.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';

export async function renderAdminAppointments(containerId = 'upcoming-appointments') {
    const container = document.getElementById(containerId);
    if (!container) return;
    const citas = await getAllCitas();
    if (!citas.length) {
        container.innerHTML = '<p class="empty-state"><i class="fas fa-calendar-check"></i> No hay citas agendadas</p>';
        return;
    }
    let html = '<div class="appointments-list">';
    citas.slice(0, 50).forEach(c => {
        const estado = (() => {
            const d = new Date(c.fecha + 'T' + (c.hora || '12:00'));
            return d < new Date() ? 'Completada' : 'Pendiente';
        })();
        html += `
            <div class="appointment-card" data-id="${c.id}">
                <div class="apt-header">
                    <strong>${escapeHtml(c.nombre)}</strong>
                    <span class="apt-price">${formatearDinero(c.precio)}</span>
                </div>
                <div class="apt-details">
                    <span><i class="fas fa-calendar"></i> ${c.fecha}</span>
                    <span><i class="fas fa-clock"></i> ${formatTimeDisplay(c.hora)}</span>
                    <span><i class="fas fa-user"></i> ${escapeHtml(c.contacto?.nombre || 'Anónimo')}</span>
                    ${c.trabajador ? `<span><i class="fas fa-user-friends"></i> ${escapeHtml(c.trabajador.nombre)}</span>` : ''}
                    <span class="status-badge ${estado === 'Completada' ? 'completed' : 'pending'}">${estado}</span>
                </div>
                <div class="apt-actions">
                    <button class="btn-small danger delete-apt" data-id="${c.id}"><i class="fas fa-trash"></i></button>
                </div>
            </div>
        `;
    });
    html += '</div>';
    container.innerHTML = html;

    // Event listeners para acciones
    container.querySelectorAll('.delete-apt').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!confirm('¿Eliminar esta cita?')) return;
            await deleteCita(btn.dataset.id);
            mostrarToast('Cita eliminada', 'success');
            renderAdminAppointments(containerId);
        });
    });

    // Aplicar clases de urgencia
    container.querySelectorAll('.appointment-card').forEach(card => {
        aplicarClaseUrgencia(card, card.querySelector('.apt-details span')?.textContent?.split(' ')[1]);
    });
}

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}