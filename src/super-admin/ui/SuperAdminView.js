// super-admin/ui/SuperAdminView.js
// Panel de administracion global para super_admin
// Tabla de tenants, gestion de planes, estadisticas del sistema

import { getSystemStats, actualizarPlanTenant, suspenderTenant, reactivarTenant } from '../application/SuperAdminService.js';
import { formatearDinero } from '../../shared/infrastructure/formatters.js';
import { PLANES } from '../../shared/domain/constants.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';

export async function renderSuperAdmin(containerId = 'superadmin-content') {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = '<div class="loading-spinner"><i class="fas fa-spinner fa-spin"></i> Cargando panel de administracion...</div>';

    const stats = await getSystemStats();

    container.innerHTML = `
        <div class="superadmin-dashboard">
            <div class="sa-header">
                <h2><i class="fas fa-crown"></i> Panel de Administracion Global</h2>
                <span class="sa-badge">Super Admin</span>
            </div>

            <div class="sa-stats-grid">
                <div class="sa-stat-card">
                    <span class="sa-stat-value">${stats.totalTenants}</span>
                    <span class="sa-stat-label">Negocios registrados</span>
                </div>
                <div class="sa-stat-card">
                    <span class="sa-stat-value">${stats.suscripcionesActivas}</span>
                    <span class="sa-stat-label">Suscripciones activas</span>
                </div>
                <div class="sa-stat-card">
                    <span class="sa-stat-value">$${stats.ingresosTotales.toLocaleString()}</span>
                    <span class="sa-stat-label">Ingresos totales</span>
                </div>
                <div class="sa-stat-card">
                    <span class="sa-stat-value">${stats.totalUsuarios}</span>
                    <span class="sa-stat-label">Usuarios registrados</span>
                </div>
            </div>

            <div class="sa-section">
                <h3><i class="fas fa-store"></i> Distribucion de Planes</h3>
                <div class="sa-planes-grid">
                    ${Object.keys(PLANES).map(planKey => {
                        const plan = PLANES[planKey];
                        const count = stats.distribucionPlanes[planKey] || 0;
                        return `
                            <div class="sa-plan-card" style="border-left: 4px solid ${plan.color}">
                                <span class="sa-plan-name">${plan.nombre}</span>
                                <span class="sa-plan-count">${count} negocio${count !== 1 ? 's' : ''}</span>
                                <span class="sa-plan-price">${plan.precio}${plan.periodo || ''}</span>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>

            <div class="sa-section">
                <h3><i class="fas fa-building"></i> Negocios Recientes</h3>
                <div class="sa-table-container">
                    <table class="sa-table">
                        <thead>
                            <tr>
                                <th>Negocio</th>
                                <th>Email</th>
                                <th>Plan</th>
                                <th>Acciones</th>
                            </tr>
                        </thead>
                        <tbody id="sa-tenants-table">
                            ${stats.tenantsRecientes.map(t => `
                                <tr>
                                    <td>${escapeHtml(t.nombre_negocio || 'Sin nombre')}</td>
                                    <td>${escapeHtml(t.email_contacto || '')}</td>
                                    <td><span class="plan-badge plan-${t.plan || 'freemium'}">${t.plan || 'freemium'}</span></td>
                                    <td>
                                        <select class="sa-plan-select" data-tenant-id="${t.id}">
                                            ${Object.keys(PLANES).map(p => `
                                                <option value="${p}" ${t.plan === p ? 'selected' : ''}>${PLANES[p].nombre}</option>
                                            `).join('')}
                                        </select>
                                        <button class="btn-small sa-update-plan" data-tenant-id="${t.id}">
                                            <i class="fas fa-save"></i>
                                        </button>
                                        <button class="btn-small danger sa-suspend" data-tenant-id="${t.id}" title="Suspender">
                                            <i class="fas fa-ban"></i>
                                        </button>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    `;

    // Event listeners
    container.querySelectorAll('.sa-update-plan').forEach(btn => {
        btn.addEventListener('click', async () => {
            const tenantId = btn.dataset.tenantId;
            const select = container.querySelector(`.sa-plan-select[data-tenant-id="${tenantId}"]`);
            if (!select) return;
            const nuevoPlan = select.value;
            try {
                await actualizarPlanTenant(tenantId, nuevoPlan);
                mostrarToast(`Plan actualizado a ${PLANES[nuevoPlan]?.nombre || nuevoPlan}`, 'success');
            } catch (err) {
                mostrarToast('Error: ' + err.message, 'error');
            }
        });
    });

    container.querySelectorAll('.sa-suspend').forEach(btn => {
        btn.addEventListener('click', async () => {
            const tenantId = btn.dataset.tenantId;
            if (!confirm('Suspender este negocio?')) return;
            try {
                await suspenderTenant(tenantId);
                mostrarToast('Negocio suspendido', 'success');
                renderSuperAdmin(containerId);
            } catch (err) {
                mostrarToast('Error: ' + err.message, 'error');
            }
        });
    });
}

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}