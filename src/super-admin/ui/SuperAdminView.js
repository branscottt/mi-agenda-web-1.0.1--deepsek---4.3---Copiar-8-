// src/super-admin/ui/SuperAdminView.js
// Vista de super-administrador
// Extraida de script.js (funciones: iniciarSuperAdmin, cargarTenants, renderTenants, cargarUsuarios, renderUsuarios, cargarServiciosExistentes, setupSuperAdminTabs, cargarEstadisticasGlobales, cargarMetricasGlobales, cargarUsuariosSuper, cargarServiciosGlobales, cargarCitasGlobales)

/**
 * Renderiza la vista completa de super-admin
 * @param {HTMLElement} container
 * @param {Object} apis - window.__apis
 */
export async function renderSuperAdmin(container, apis) {
    if (!container) return;

    container.innerHTML = `
        <div class="super-admin-container">
            <h2><i class="fas fa-shield-alt"></i> Panel de Administración</h2>
            <ul class="nav nav-tabs" id="superAdminTabs">
                <li class="nav-item"><a class="nav-link active" data-tab="estadisticas" href="#"><i class="fas fa-chart-bar"></i> Estadísticas</a></li>
                <li class="nav-item"><a class="nav-link" data-tab="tenants" href="#"><i class="fas fa-building"></i> Tenants</a></li>
                <li class="nav-item"><a class="nav-link" data-tab="servicios" href="#"><i class="fas fa-concierge-bell"></i> Servicios</a></li>
                <li class="nav-item"><a class="nav-link" data-tab="citas" href="#"><i class="fas fa-calendar-alt"></i> Citas</a></li>
                <li class="nav-item"><a class="nav-link" data-tab="promociones" href="#"><i class="fas fa-video"></i> Promociones Video <span id="promo-pending-badge" class="promo-pending-badge" style="display:none;background:#e74c3c;color:#fff;font-size:0.65rem;padding:1px 6px;border-radius:10px;margin-left:4px;font-weight:700;vertical-align:middle;">0</span></a></li>
            </ul>
            <div id="superAdminContent" class="tab-content mt-3"></div>
        </div>
    `;

    const content = document.getElementById('superAdminContent');
    const tabs = container.querySelectorAll('[data-tab]');

    tabs.forEach(tab => {
        tab.addEventListener('click', async (e) => {
            e.preventDefault();
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            await cargarVista(tab.dataset.tab, content, apis);
        });
    });

    // Vista inicial
    await cargarVista('estadisticas', content, apis);
}

async function cargarVista(vista, content, apis) {
    switch (vista) {
        case 'estadisticas':
            await cargarEstadisticasGlobales(content, apis);
            break;
        case 'tenants':
            await cargarTenants(content, apis);
            break;
        case 'servicios':
            await cargarServiciosGlobales(content, apis);
            break;
        case 'citas':
            await cargarCitasGlobales(content, apis);
            break;
        case 'promociones':
            await cargarPromocionesVideo(content, apis);
            break;
    }
}

async function cargarEstadisticasGlobales(content, apis) {
    content.innerHTML = '<p><i class="fas fa-spinner fa-spin"></i> Cargando estadísticas...</p>';
    try {
        const [tenants, servicios, citas, usuarios] = await Promise.all([
            apis.tenants.getAll().catch(() => []),
            apis.servicios.getAll().catch(() => []),
            apis.appointments.getAll().catch(() => []),
            apis.usuarios ? apis.usuarios.getAll().catch(() => []) : []
        ]);
        content.innerHTML = `
            <div class="row" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;">
                <div class="stat-card" style="background:#fff;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,0.1);text-align:center;">
                    <i class="fas fa-building" style="font-size:36px;color:#007bff;"></i>
                    <h3 style="margin:8px 0;">${tenants.length}</h3>
                    <p class="text-muted">Tenants</p>
                </div>
                <div class="stat-card" style="background:#fff;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,0.1);text-align:center;">
                    <i class="fas fa-concierge-bell" style="font-size:36px;color:#28a745;"></i>
                    <h3 style="margin:8px 0;">${servicios.length}</h3>
                    <p class="text-muted">Servicios</p>
                </div>
                <div class="stat-card" style="background:#fff;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,0.1);text-align:center;">
                    <i class="fas fa-calendar-check" style="font-size:36px;color:#ffc107;"></i>
                    <h3 style="margin:8px 0;">${citas.length}</h3>
                    <p class="text-muted">Citas</p>
                </div>
                <div class="stat-card" style="background:#fff;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,0.1);text-align:center;">
                    <i class="fas fa-users" style="font-size:36px;color:#17a2b8;"></i>
                    <h3 style="margin:8px 0;">${usuarios.length}</h3>
                    <p class="text-muted">Usuarios</p>
                </div>
            </div>
        `;
    } catch (e) {
        content.innerHTML = `<p class="text-danger">Error cargando estadísticas: ${e.message}</p>`;
    }
}

async function cargarTenants(content, apis) {
    content.innerHTML = '<p><i class="fas fa-spinner fa-spin"></i> Cargando tenants...</p>';
    try {
        const [tenants, subscriptions] = await Promise.all([
            apis.tenants.getAll(),
            apis.subscriptions.getAll().catch(() => [])
        ]);

        const subMap = {};
        (subscriptions || []).forEach(s => {
            if (!subMap[s.tenant_id] || s.status === 'active') {
                subMap[s.tenant_id] = s;
            }
        });

        content.innerHTML = `
            <h3>Gestión de Tenants</h3>
            <button class="btn btn-primary mb-3" onclick="abrirModalNuevoTenant()"><i class="fas fa-plus"></i> Nuevo Tenant</button>
            <div class="tenants-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;">
                ${tenants.map(t => {
                    const sub = subMap[t.id];
                    const activo = t.estado !== 'inactivo';
                    const subActiva = sub && sub.status === 'active';
                    const subExpirada = sub && sub.end_date && new Date(sub.end_date) < new Date();
                    const subDisplay = subExpirada ? 'expirada' : (subActiva ? 'activa' : (sub ? sub.status : 'sin suscripción'));
                    const endDateStr = sub?.end_date ? new Date(sub.end_date).toLocaleDateString() : '—';

                    return `
                        <div class="tenant-card glass-panel" style="padding:20px;position:relative;${!activo ? 'opacity:0.7;border-color:#e74c3c;' : ''}">
                            ${!activo ? '<div style="position:absolute;top:8px;right:8px;background:#e74c3c;color:#fff;padding:2px 10px;border-radius:4px;font-size:0.75rem;font-weight:600;">DESACTIVADO</div>' : ''}
                            <div class="tenant-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                                <h4 style="margin:0;">${t.nombre_negocio || 'Sin nombre'}</h4>
                                <span class="badge ${t.plan || 'freemium'}" style="font-size:0.75rem;padding:3px 10px;border-radius:20px;background:${t.plan === 'premium_anual' ? '#ffd700' : t.plan === 'pro' ? '#b300ff' : '#666'};color:${t.plan === 'premium_anual' ? '#000' : '#fff'};">${t.plan || 'freemium'}</span>
                            </div>
                            <p style="margin:4px 0;font-size:0.85rem;"><i class="fas fa-envelope"></i> ${t.email_contacto || 'Sin email'}</p>
                            <p style="margin:4px 0;font-size:0.85rem;"><i class="fas fa-phone"></i> ${t.telefono || 'Sin teléfono'}</p>
                            <p style="margin:4px 0;font-size:0.85rem;"><i class="fas fa-calendar"></i> Registro: ${t.fecha_registro ? new Date(t.fecha_registro).toLocaleDateString() : '—'}</p>
                            <p style="margin:4px 0;font-size:0.85rem;"><i class="fas fa-ticket-alt"></i> Suscripción: <strong style="color:${subExpirada ? '#e74c3c' : subActiva ? '#2ecc71' : '#f39c12'}">${subDisplay}</strong> ${sub?.end_date ? `(hasta ${endDateStr})` : ''}</p>
                            <div class="tenant-actions" style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
                                <button class="btn btn-sm btn-outline-primary" onclick="editarTenant('${t.id}')"><i class="fas fa-edit"></i> Editar</button>
                                ${activo
                                    ? `<button class="btn btn-sm btn-outline-warning" onclick="superAdminToggleActivo('${t.id}', false)"><i class="fas fa-pause-circle"></i> Desactivar</button>`
                                    : `<button class="btn btn-sm btn-outline-success" onclick="superAdminToggleActivo('${t.id}', true)"><i class="fas fa-play-circle"></i> Reactivar</button>`
                                }
                                <button class="btn btn-sm btn-outline-danger" onclick="superAdminEliminarInactivo('${t.id}')"><i class="fas fa-trash"></i> Eliminar</button>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    } catch (e) {
        content.innerHTML = `<p class="text-danger">Error cargando tenants: ${e.message}</p>`;
    }
}

async function cargarServiciosGlobales(content, apis) {
    content.innerHTML = '<p><i class="fas fa-spinner fa-spin"></i> Cargando servicios globales...</p>';
    try {
        const servicios = await apis.servicios.getAll();
        content.innerHTML = `
            <h3>Servicios Globales</h3>
            <div class="table-responsive">
                <table class="table table-striped">
                    <thead><tr><th>ID</th><th>Nombre</th><th>Duración</th><th>Precio</th><th>Tenant</th></tr></thead>
                    <tbody>
                        ${servicios.map(s => `
                            <tr>
                                <td>${s.id?.substring(0,8) || ''}</td>
                                <td>${s.nombre || 'Sin nombre'}</td>
                                <td>${s.duracion || 0} min</td>
                                <td>$${s.precio || 0}</td>
                                <td>${s.tenant_id?.substring(0,8) || ''}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    } catch (e) {
        content.innerHTML = `<p class="text-danger">Error cargando servicios: ${e.message}</p>`;
    }
}

async function cargarCitasGlobales(content, apis) {
    content.innerHTML = '<p><i class="fas fa-spinner fa-spin"></i> Cargando citas globales...</p>';
    try {
        const citas = await apis.appointments.getAll();
        content.innerHTML = `
            <h3>Citas Globales</h3>
            <div class="table-responsive">
                <table class="table table-striped">
                    <thead><tr><th>ID</th><th>Cliente</th><th>Servicio</th><th>Fecha</th><th>Estado</th><th>Tenant</th></tr></thead>
                    <tbody>
                        ${citas.map(c => `
                            <tr>
                                <td>${c.id?.substring(0,8) || ''}</td>
                                <td>${c.cliente_nombre || c.contacto?.nombre || 'N/A'}</td>
                                <td>${c.servicio_nombre || 'N/A'}</td>
                                <td>${c.fecha ? new Date(c.fecha).toLocaleDateString() : 'N/A'}</td>
                                <td><span class="badge badge-${c.estado === 'confirmada' ? 'success' : 'warning'}">${c.estado || 'pendiente'}</span></td>
                                <td>${c.tenant_id?.substring(0,8) || ''}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    } catch (e) {
        content.innerHTML = `<p class="text-danger">Error cargando citas: ${e.message}</p>`;
    }
}

/**
 * Carga y renderiza las solicitudes de Promoción Video (cupón 50%)
 * para que el superadmin pueda aprobar o rechazar.
 */
async function cargarPromocionesVideo(content, apis) {
    content.innerHTML = '<p><i class="fas fa-spinner fa-spin"></i> Cargando promociones de video...</p>';
    try {
        // Dynamic import de la API de promos
        const { getAllPromoCoupons, updatePromoCouponStatus } = await import('../../api/subscriptionsApi.js');
        const promos = await getAllPromoCoupons();

        // Actualizar badge de solicitudes pendientes
        const pendingCount = promos.filter(p => p.status === 'pending').length;
        const badge = document.getElementById('promo-pending-badge');
        if (badge) {
            if (pendingCount > 0) {
                badge.textContent = pendingCount;
                badge.style.display = 'inline';
            } else {
                badge.style.display = 'none';
            }
        }

        content.innerHTML = `
            <h3>Promociones Video — Cupón 50% descuento</h3>
            <p class="text-muted" style="margin-bottom:16px;">Revisa los videos promocionales enviados por los tenants. Aprueba o rechaza cada solicitud.</p>
            ${promos.length === 0
                ? '<p class="text-muted">No hay solicitudes de promoción.</p>'
                : `<div style="display:flex;flex-direction:column;gap:16px;">
                    ${promos.map(p => {
                        const statusColor = p.status === 'approved' ? '#2ecc71' : p.status === 'rejected' ? '#e74c3c' : '#f39c12';
                        const statusIcon = p.status === 'approved' ? 'fa-check-circle' : p.status === 'rejected' ? 'fa-times-circle' : 'fa-clock';
                        return `
                        <div class="promo-review-card" data-promo-id="${p.id}" style="background:#fff;border-radius:12px;padding:16px 20px;box-shadow:0 2px 8px rgba(0,0,0,0.08);border-left:4px solid ${statusColor};">
                            <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
                                <div style="flex:1;min-width:200px;">
                                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                                        <strong style="font-size:1rem;">${p.tenants?.nombre_negocio || 'Sin nombre'}</strong>
                                        <span style="font-size:0.72rem;padding:2px 8px;border-radius:12px;background:${statusColor};color:#fff;">${p.status}</span>
                                        <span style="font-size:0.72rem;color:#999;">Período: ${p.coupon_period}</span>
                                        ${p.discount_applied ? '<span style="font-size:0.72rem;padding:2px 8px;border-radius:12px;background:#3498db;color:#fff;">✅ Usado</span>' : ''}
                                    </div>
                                    <p style="font-size:0.82rem;margin:4px 0;color:#555;">
                                        <i class="fas fa-envelope"></i> ${p.tenants?.email_contacto || ''} 
                                        <span style="margin-left:8px;"><i class="fas fa-tag"></i> ${p.tenants?.plan || ''}</span>
                                    </p>
                                    <p style="font-size:0.82rem;margin:6px 0;word-break:break-all;">
                                        <i class="fas fa-video" style="color:#e74c3c;"></i>
                                        <a href="${escapeHtml(p.video_url)}" target="_blank" rel="noopener" style="color:#007bff;">${escapeHtml(p.video_url)}</a>
                                    </p>
                                    <div style="font-size:0.82rem;margin-top:6px;padding:8px 10px;background:#f8f9fa;border-radius:8px;color:#333;">
                                        <i class="fas fa-store"></i> <strong>Descripción:</strong> ${escapeHtml(p.business_description)}
                                    </div>
                                    ${p.admin_comment ? `<div style="font-size:0.82rem;margin-top:6px;padding:8px 10px;background:#fff3f3;border-radius:8px;color:#c0392b;">
                                        <i class="fas fa-comment"></i> <strong>Comentario admin:</strong> ${escapeHtml(p.admin_comment)}
                                    </div>` : ''}
                                </div>
                                ${p.status === 'pending' ? `
                                <div style="display:flex;flex-direction:column;gap:6px;min-width:140px;">
                                    <button class="promo-btn-approve btn-sm" style="background:#2ecc71;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:600;" data-id="${p.id}">
                                        <i class="fas fa-check"></i> Aprobar
                                    </button>
                                    <button class="promo-btn-reject btn-sm" style="background:#e74c3c;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:600;" data-id="${p.id}">
                                        <i class="fas fa-times"></i> Rechazar
                                    </button>
                                </div>
                                ` : ''}
                            </div>
                        </div>`;
                    }).join('')}
                </div>`
            }
        `;

        // Bindeo de eventos para aprobar/rechazar
        content.querySelectorAll('.promo-btn-approve').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.id;
                const comment = prompt('Comentario opcional para el tenant:');
                try {
                    await updatePromoCouponStatus(id, { status: 'approved', adminComment: comment || '' });
                    // Recargar
                    await cargarPromocionesVideo(content, apis);
                } catch (e) {
                    alert('Error: ' + e.message);
                }
            });
        });

        content.querySelectorAll('.promo-btn-reject').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.id;
                const comment = prompt('Indica al tenant por qué no cumple (obligatorio):');
                if (!comment || comment.trim().length < 5) {
                    alert('Debes escribir un comentario explicando el motivo del rechazo.');
                    return;
                }
                try {
                    await updatePromoCouponStatus(id, { status: 'rejected', adminComment: comment.trim() });
                    await cargarPromocionesVideo(content, apis);
                } catch (e) {
                    alert('Error: ' + e.message);
                }
            });
        });

    } catch (e) {
        content.innerHTML = `<p class="text-danger">Error cargando promociones: ${e.message}</p>`;
    }
}

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}