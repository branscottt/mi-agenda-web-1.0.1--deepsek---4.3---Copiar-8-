// dashboard/ui/DashboardView.js
// Render del dashboard admin con tarjetas de estadisticas

import { getDashboardStats } from '../application/DashboardService.js';
import { formatearDinero } from '../../shared/infrastructure/formatters.js';

export async function renderDashboard(containerId = 'dashboard-stats') {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = '<div class="loading-spinner"><i class="fas fa-spinner fa-spin"></i> Cargando dashboard...</div>';

    const stats = await getDashboardStats();

    container.innerHTML = `
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-icon" style="background:rgba(157,78,221,0.2)">
                    <i class="fas fa-calendar-check" style="color:#9d4edd"></i>
                </div>
                <div class="stat-info">
                    <span class="stat-value">${stats.citasHoy}</span>
                    <span class="stat-label">Citas hoy</span>
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-icon" style="background:rgba(0,184,148,0.2)">
                    <i class="fas fa-chart-line" style="color:#00b894"></i>
                </div>
                <div class="stat-info">
                    <span class="stat-value">${formatearDinero(stats.ventasHoy)}</span>
                    <span class="stat-label">Ventas hoy</span>
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-icon" style="background:rgba(255,109,0,0.2)">
                    <i class="fas fa-users" style="color:#ff6d00"></i>
                </div>
                <div class="stat-info">
                    <span class="stat-value">${stats.citasPendientes}</span>
                    <span class="stat-label">Pendientes</span>
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-icon" style="background:rgba(0,212,255,0.2)">
                    <i class="fas fa-box" style="color:#00d4ff"></i>
                </div>
                <div class="stat-info">
                    <span class="stat-value">${stats.totalServicios}</span>
                    <span class="stat-label">Servicios</span>
                </div>
            </div>
        </div>

        <div class="dashboard-row">
            <div class="dashboard-card">
                <h3><i class="fas fa-trophy"></i> Top Servicios</h3>
                ${stats.topServicios.length
                    ? `<div class="top-servicios-list">
                        ${stats.topServicios.map((s, i) => `
                            <div class="top-servicio-item">
                                <span class="top-rank">#${i + 1}</span>
                                <span class="top-nombre">${escapeHtml(s.nombre)}</span>
                                <span class="top-cantidad">${s.cantidad} ventas</span>
                                <span class="top-total">${formatearDinero(s.total)}</span>
                            </div>
                        `).join('')}
                    </div>`
                    : '<p class="empty-state-small">Sin datos aun</p>'
                }
            </div>
            <div class="dashboard-card">
                <h3><i class="fas fa-coins"></i> Resumen del mes</h3>
                <div class="resumen-mes">
                    <div class="resumen-item">
                        <span>Ventas del mes</span>
                        <strong>${formatearDinero(stats.ventasMes)}</strong>
                    </div>
                    <div class="resumen-item">
                        <span>Crecimiento</span>
                        <strong class="${stats.crecimiento >= 0 ? 'text-success' : 'text-danger'}">
                            ${stats.crecimiento >= 0 ? '+' : ''}${stats.crecimiento}%
                        </strong>
                    </div>
                    <div class="resumen-item">
                        <span>Total ventas historico</span>
                        <strong>${formatearDinero(stats.totalVentas)}</strong>
                    </div>
                    <div class="resumen-item">
                        <span>Total citas</span>
                        <strong>${stats.totalCitas}</strong>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}