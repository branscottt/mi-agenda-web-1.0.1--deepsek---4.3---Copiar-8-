// appointments/ui/ClientReservationList.js
// Renderiza "Mis Reservas" en la vista cliente
// Filtra por el email de la sesión local del cliente (sessionStorage)

import { getAllCitas, deleteCita } from '../application/AppointmentService.js';
import { formatearDinero, formatFechaCorta, formatTimeDisplay } from '../../shared/infrastructure/formatters.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { getVisualConfig } from '../../visual-config/application/VisualConfigService.js';

export async function renderMisReservas(containerId = 'mis-reservas-list') {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Obtener sesión del cliente local
    const session = window.getClienteSession ? window.getClienteSession() : null;
    if (!session || !session.email) {
        container.innerHTML = '<p class="empty-state"><i class="fas fa-user-lock"></i> Ingresa tus datos para ver tus reservas</p>';
        return;
    }

    const emailCliente = session.email.toLowerCase().trim();
    const citas = await getAllCitas();

    // Filtrar solo las citas de este cliente (por email)
    const misCitas = citas.filter(c => {
        const cEmail = (c.contacto?.email || '').toLowerCase().trim();
        return cEmail === emailCliente;
    });

    if (!misCitas.length) {
        container.innerHTML = '<p class="empty-state"><i class="fas fa-calendar-times"></i> No tienes reservas activas</p>';
        return;
    }

    let html = '<div class="reservas-list">';
    misCitas.forEach(c => {
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

    // Cargar y mostrar enlaces de redes sociales del negocio
    try {
        const config = await getVisualConfig();
        const instagram = config.instagram_url || '';
        const tiktok = config.tiktok_url || '';
        if (instagram || tiktok) {
            let socialHtml = '<div class="social-links-section" style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border-color, #2a2a4a);">';
            socialHtml += '<h4 style="font-size:0.85rem;color:var(--text-color,#e0e0e0);margin-bottom:10px;"><i class="fas fa-share-alt"></i> Síguenos en redes</h4>';
            socialHtml += '<div style="display:flex;gap:10px;flex-wrap:wrap;">';
            if (instagram) {
                socialHtml += `<a href="${escapeHtml(instagram)}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:8px;background:linear-gradient(45deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888);color:#fff;text-decoration:none;font-size:0.85rem;">
                    <i class="fab fa-instagram"></i> Instagram
                </a>`;
            }
            if (tiktok) {
                socialHtml += `<a href="${escapeHtml(tiktok)}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:8px;background:#000;color:#fff;text-decoration:none;font-size:0.85rem;border:1px solid #333;">
                    <i class="fab fa-tiktok"></i> TikTok
                </a>`;
            }
            socialHtml += '</div></div>';
            container.insertAdjacentHTML('afterend', socialHtml);
        }
    } catch (e) {
        console.warn('[MisReservas] Error cargando redes sociales:', e);
    }
}

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
