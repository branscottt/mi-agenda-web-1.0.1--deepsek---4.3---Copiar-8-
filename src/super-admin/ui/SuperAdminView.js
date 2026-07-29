// src/super-admin/ui/SuperAdminView.js
// Vista de super-administrador
// Extraida de script.js (funciones: iniciarSuperAdmin, cargarTenants, renderTenants, cargarUsuarios, renderUsuarios, cargarServiciosExistentes, setupSuperAdminTabs, cargarEstadisticasGlobales, cargarMetricasGlobales, cargarUsuariosSuper, cargarServiciosGlobales, cargarCitasGlobales, cargarSolicitudesCSS, abrirModalAplicarCSS)

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
                <li class="nav-item"><a class="nav-link" data-tab="solicitudes" href="#"><i class="fas fa-envelope"></i> Solicitudes CSS</a></li>
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
        case 'solicitudes':
            await cargarSolicitudesCSS(content, apis);
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

async function cargarSolicitudesCSS(content, apis) {
    content.innerHTML = '<p><i class="fas fa-spinner fa-spin"></i> Cargando solicitudes CSS...</p>';
    try {
        const solicitudes = await apis.notificaciones.getAll();
        const filtradas = (solicitudes || []).filter(n => n.tipo === 'personalizacion_css' || n.title?.includes('CSS'));
        content.innerHTML = `
            <h3>Solicitudes de Personalización CSS</h3>
            ${filtradas.length === 0
                ? '<p class="text-muted">No hay solicitudes pendientes.</p>'
                : `<div class="table-responsive">
                    <table class="table table-striped">
                        <thead><tr><th>ID</th><th>Mensaje</th><th>Tenant</th><th>Fecha</th><th>Acción</th></tr></thead>
                        <tbody>
                            ${filtradas.map(n => `
                                <tr>
                                    <td>${n.id?.substring(0,8) || ''}</td>
                                    <td>${n.message || n.title || 'Sin mensaje'}</td>
                                    <td>${n.tenant_id?.substring(0,8) || ''}</td>
                                    <td>${n.created_at ? new Date(n.created_at).toLocaleDateString() : ''}</td>
                                    <td><button class="btn btn-sm btn-primary" onclick="abrirModalAplicarCSS('${n.id}', '${n.tenant_id}')"><i class="fas fa-paint-brush"></i> Aplicar</button></td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>`
            }
        `;
    } catch (e) {
        content.innerHTML = `<p class="text-danger">Error cargando solicitudes: ${e.message}</p>`;
    }
}