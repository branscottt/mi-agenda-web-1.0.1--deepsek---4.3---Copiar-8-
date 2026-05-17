// src/dashboard/ui/DashboardView.js
// Vista de dashboard del admin
// Extraida de script.js (funciones: iniciarAdmin, actualizarDashboardFinanzas, renderizarGraficoVentas, configurarDashboardEventos, inicializarFechasDashboard)

/**
 * Renderiza el dashboard completo del admin
 * @param {HTMLElement} container - Contenedor donde renderizar
 * @param {Object} apis - window.__apis (appointments, servicios, subscriptions, notificaciones, usuarios, etc.)
 */
export async function renderDashboard(container, apis) {
    if (!container) return;
    
    // Inyectar HTML base del dashboard
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
                    <h3><i class="fas fa-calendar-check"></i> Próximas citas</h3>
                    <div id="proximas-citas"></div>
                </div>
                <div class="table-container">
                    <h3><i class="fas fa-star"></i> Top servicios</h3>
                    <div id="top-servicios"></div>
                </div>
            </div>
        </div>
    `;

    const tenantId = obte...[truncated]