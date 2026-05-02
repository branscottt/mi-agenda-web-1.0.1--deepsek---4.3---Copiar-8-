// appointments/ui/ClientReservationList.js
// Renderiza "Mis Reservas" en la vista cliente

import { getAllCitas, deleteCita } from '../application/AppointmentService.js';
import { formatearDinero, formatFechaCorta, formatTimeDisplay } from '../../shared/infrastructure/formatters.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';

export async function renderMisReservas(containerId = 'mis-reservas-list') {
    const container = document.getElementById(containerId);
    if (!container) return;
    const citas = await getAllCitas();
    if (!citas.length) {
        container.innerHTML = '<p class="empty-state"><i class="fas fa-calendar-times"></i> No tienes reservas</p>';
        return;
    }
    let html = '<div class="reservas-list">';
    citas.forEach(c => {
        const esPasada = new Date(c.fecha + 'T' + (c.hora || '12:00')) < new Date();
        html += `
            <div class="reserva-card ${esPasada ? 'past' : ''}">
                <div class="reserva-header">
                    <strong>${escapeHtml(c.nombre)}</strong>
                    <span class="reserva-price">${formatearDinero(c.precio)}</span>
                </div>
                <div class="reserva-details">
                    <span><i class="fas fa-calendar"></i> ${c.fecha}</span>
                    <span><i class="fas fa-clock"></i> ${formatTimeDisplay(c.hora)}</span>
                    ${!esPasada ? `<button class="btn-small danger cancel-reserva" data-id="${c.id}"><i class="fas fa-times"></i> Cancelar</button>` : '<span class="status-badge completed">Completada</span>'}
                </div>
            </div>
        `;
    });
    html += '</div>';
    container.innerHTML = html;

    container.querySelectorAll('.cancel-reserva').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!confirm('¿Cancelar esta reserva?')) return;
            await deleteCita(btn.dataset.id);
            mostrarToast('Reserva cancelada', 'success');
            renderMisReservas(containerId);
        });
    });
}

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}