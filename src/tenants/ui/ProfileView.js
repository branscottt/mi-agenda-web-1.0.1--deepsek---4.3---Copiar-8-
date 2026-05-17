// src/tenants/ui/ProfileView.js
// Vista de perfil del tenant (información del negocio y usuario)
// Extraida de script.js

/**
 * Renderiza la página de perfil del tenant
 * @param {HTMLElement} container
 * @param {Object} apis - window.__apis
 */
export async function renderProfile(container, apis) {
    if (!container) return;

    const jwt = JSON.parse(localStorage.getItem('supabase.auth.token') || '{}');
    const session = jwt?.currentSession;
    const user = session?.user;
    const tenantId = user?.user_metadata?.tenant_id;

    if (!user) {
        container.innerHTML = '<p class="text-muted">Debes iniciar sesión para ver tu perfil.</p>';
        return;
    }

    // Cargar datos del tenant
    let tenant = null;
    if (tenantId && apis?.tenants?.getById) {
        try {
            tenant = await apis.tenants.getById(tenantId);
        } catch (e) {
            console.error('[ProfileView] Error cargando tenant:', e);
        }
    }

    container.innerHTML = `
        <div class="profile-container">
            <h2><i class="fas fa-user-circle"></i> Mi Perfil</h2>
            <div class="profile-card" style="background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,0.1);max-width:600px;">
                <div class="profile-section" style="margin-bottom:24px;">
                    <h4><i class="fas fa-user"></i> Información del usuario</h4>
                    <p><strong>Email:</strong> ${user.email || 'No disponible'}</p>
                    <p><strong>Rol:</strong> ${user.user_metadata?.rol || 'usuario'}</p>
                </div>
                ${tenant ? `
                <div class="profile-section" style="margin-bottom:24px;">
                    <h4><i class="fas fa-store"></i> Información del negocio</h4>
                    <p><strong>Nombre:</strong> ${tenant.nombre_negocio || 'No disponible'}</p>
                    <p><strong>Email contacto:</strong> ${tenant.email_contacto || 'No disponible'}</p>
                    <p><strong>Teléfono:</strong> ${tenant.telefono || 'No disponible'}</p>
                    <p><strong>Dirección:</strong> ${tenant.direccion || 'No disponible'}</p>
                </div>
                ` : ''}
                <div class="profile-actions">
                    <button class="btn btn-outline-primary" onclick="event.preventDefault(); alert('Funcionalidad de edición próxima');">
                        <i class="fas fa-edit"></i> Editar perfil
                    </button>
                </div>
            </div>
        </div>
    `;
}