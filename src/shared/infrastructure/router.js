// shared/infrastructure/router.js
// Proteccion de rutas por rol - Strangler Fig: coexiste con verificarProteccionRutas original

import { getSupabase } from './supabase.js';

export const ROLES = {
    SUPER_ADMIN: 'super_admin',
    ADMIN: 'admin',
    CLIENTE: 'cliente'
};

/**
 * Obtiene la sesion actual desde Supabase y extrae user_metadata
 */
export async function getSession() {
    try {
        const supabase = getSupabase();
        if (!supabase) return null;
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return null;
        return {
            id: session.user.id,
            nombre: session.user.user_metadata?.nombre || session.user.email?.split('@')[0] || 'Usuario',
            email: session.user.email,
            rol: session.user.user_metadata?.rol || 'cliente',
            tenant_id: session.user.user_metadata?.tenant_id
        };
    } catch (e) {
        console.error('Error en getSession:', e);
        return null;
    }
}

export async function getCurrentTenantId() {
    try {
        const supabase = getSupabase();
        if (!supabase) return null;
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return null;
        const tenantId = session.user?.user_metadata?.tenant_id;
        if (tenantId && typeof tenantId === 'string') {
            const cleanId = tenantId.trim();
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (uuidRegex.test(cleanId)) return cleanId;
        }
        return null;
    } catch (e) {
        console.error('Error obteniendo tenant_id:', e);
        return null;
    }
}

/**
 * Redirige segun el rol del usuario
 */
export function redirectByRole(session) {
    if (!session) {
        window.location.href = 'login.html';
        return;
    }
    if (session.rol === ROLES.SUPER_ADMIN) {
        window.location.href = 'superadmin.html';
    } else if (session.rol === ROLES.ADMIN) {
        window.location.href = 'admin.html';
    } else {
        window.location.href = 'cliente.html';
    }
}

/**
 * Valida que la pagina actual corresponda al rol del usuario. Redirige si no.
 */
export async function verificarProteccionRutas() {
    try {
        const session = await getSession();
        const pathname = (window.location.pathname || '').split('/').pop() || '';

        if (!session) {
            if (pathname !== 'login.html' && pathname !== '') {
                window.location.href = 'login.html';
            }
            return;
        }

        // Super admin solo ve superadmin.html
        if (session.rol === ROLES.SUPER_ADMIN) {
            if (pathname !== 'superadmin.html' && pathname !== 'login.html') {
                window.location.href = 'superadmin.html';
            }
            return;
        }

        // Admin
        if (pathname === 'admin.html') {
            if (session.tenant_id && session.rol !== ROLES.ADMIN) {
                window.location.href = 'cliente.html';
            }
            return;
        }

        // Superadmin page solo para super_admin
        if (pathname === 'superadmin.html' && session.rol !== ROLES.SUPER_ADMIN) {
            window.location.href = 'cliente.html';
            return;
        }

        // Login con sesion activa - redirigir segun rol
        if (pathname === 'login.html' || pathname === '') {
            redirectByRole(session);
        }
    } catch (err) {
        console.error('Error en proteccion de rutas:', err);
    }
}