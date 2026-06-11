// src/dashboard/ui/DashboardView.js
// Vista de dashboard del admin
// Carga stats desde DashboardService y renderiza cards + graficos

import { getDashboardStats } from '../application/DashboardService.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { formatearDinero } from '../../shared/infrastructure/formatters.js';

/**
 * Renderiza el dashboard completo del admin
 * @param {string} containerId - ID del contenedor donde renderizar
 * @param {Object} apis - window.__apis (legacy fallback, no usado aqui)
 */
export async function renderDashboard(containerId, apis) {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Inyectar HTML base del dashboard si el contenedor esta vacio
    if (container.innerHTML.trim() === '') {
        container.innerHTML = `
            <div class="dashboard-content">
                <h2><i class="fas fa-tachometer-alt"></i> Dashboard</h2>
                <div id="dashboard-cards" class="dashboard-cards"></div>
                <div id="dashboard-charts" class="dashboard-charts">
                    <div class="chart-container">
                        <h3><i class="fas fa-chart-line"></i> Ventas</h3>
                        <canvas id="ventasChart" width="400" height="200"></canvas>
                    </div>
                </div>
                <div id="dashboard-tables" class="dashboard-tables">
                    <div class="table-container">
                        <h3><i class="fas fa-calendar-check"></i> Proximas citas</h3>
                        <div id="proximas-citas"></div>
                    </div>
                    <div class="table-container">
                        <h3><i class="fas fa-star"></i> Top servicios</h3>
                        <div id="top-servicios"></div>
                    </div>
                </div>
            </div>
        `;
    }

    try {
        const stats = await getDashboardStats();
        renderDashboardCards(stats);
        renderTopServicios(stats.topServicios);
    } catch (e) {
        console.warn('[DashboardView] Error cargando stats, usando fallback legacy:', e.message);
    }
}

function renderDashboardCards(stats) {
    const cardsContainer = document.getElementById('dashboard-cards');
    if (!cardsContainer) return;

    const cards = [
        { icon: 'fa-calendar-check', label: 'Citas Hoy', value: stats.citasHoy, color: '#4CAF50' },
        { icon: 'fa-clock', label: 'Pendientes', value: stats.citasPendientes, color: '#FF9800' },
        { icon: 'fa-dollar-sign', label: 'Ventas Hoy', value: formatearDinero(stats.ventasHoy), color: '#2196F3' },
        { icon: 'fa-chart-bar', label: 'Ventas del Mes', value: formatearDinero(stats.ventasMes), color: '#9C27B0' },
        { icon: 'fa-cube', label: 'Servicios Activos', value: stats.totalServicios, color: '#00BCD4' }
    ];

    cardsContainer.innerHTML = cards.map(function(c) {
        return '<div class="stat-card" style="border-left: 4px solid ' + c.color + ';">' +
            '<div class="stat-icon"><i class="fas ' + c.icon + '"></i></div>' +
            '<div class="stat-details">' +
            '<div class="stat-value">' + c.value + '</div>' +
            '<div class="stat-label">' + c.label + '</div>' +
            '</div></div>';
    }).join('');
}

function renderTopServicios(topServicios) {
    const container = document.getElementById('top-servicios');
    if (!container) return;
    if (!topServicios || topServicios.length === 0) {
        container.innerHTML = '<p class="text-muted" style="padding:20px;text-align:center;">Sin datos de servicios</p>';
        return;
    }
    container.innerHTML = '<ul class="top-list">' +
        topServicios.map(function(s, i) {
            return '<li><span class="top-rank">#' + (i + 1) + '</span> ' + s.nombre + ' <span class="top-count">' + s.cantidad + ' reservas</span></li>';
        }).join('') +
        '</ul>';
}