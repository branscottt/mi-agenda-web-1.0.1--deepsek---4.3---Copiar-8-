// shared/domain/session.js
// Funciones de sesion independientes de auth/ (NO importa JwtManager)
// El JwtManager se inyecta como dependencia desde quien lo use.
//
// Esto rompe shared -> auth y mantiene shared como capa base sin dependencias de negocio.

import { getSupabase } from '../infrastructure/supabase.js';
import { JwtManager } from '../../auth/infrastructure/JwtManager.js';

export const ROLES = {
    SUPER_ADMIN: 'super_admin',
    ADMIN: 'admin',
    CLIENTE: 'cliente'
};

/**
 * Obtiene la sesion actual desde JwtManager (localStorage).
 * Si el token expiro, intenta refresh silencioso.
 */
export async function getSession() {
    const session = JwtManager.getSession();
    if (!session) return null;

    if (JwtManager.isTokenExpired()) {
        const supabase = getSupabase();
        if (supabase) {
            const refreshed = await JwtManager.refreshToken(supabase);
            if (refreshed) {
                return JwtManager.getSession().user;
            }
            return null;
        }
    }

    return session.user;
}

/**
 * Obtiene el tenant_id desde el JWT cacheado (sin llamar a Supabase).
 * Si no hay JWT, fallback a window.__clientTenantId (para clientes sin Auth).
 */
export async function getCurrentTenantId() {
    // 1. Intentar desde JWT
    const userData = JwtManager.getUserData();
    if (userData && userData.tenant_id) {
        const cleanId = userData.tenant_id.trim();
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(cleanId)) return cleanId;
    }

    // 2. Fallback: tenant_id de cliente externo (sesión local, seteado por ClientSession)
    if (window.__clientTenantId) {
        return window.__clientTenantId;
    }

    return null;
}

/**
 * Redirige segun el rol del usuario.
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
 * Valida que la pagina actual corresponda al rol del usuario
 * y sincroniza el JWT con Supabase via setSession.
 */
export async function verificarProteccionRutas() {
    const session = await getSession();
    const pathname = (window.location.pathname || '').split('/').pop() || '';

    if (!session) {
        if (pathname !== 'login.html' && pathname !== '') {
            window.location.href = 'login.html';
        }
        return;
    }

    // Sincronizar JWT con Supabase para que las RLS funcionen
    const accessToken = JwtManager.getAccessToken();
    const refreshToken = JwtManager.getRefreshToken();
    if (accessToken) {
        const supabase = getSupabase();
        if (supabase) {
            try {
                await supabase.auth.setSession({
                    access_token: accessToken,
                    refresh_token: refreshToken || accessToken
                });
            } catch (e) {
                console.warn('[session] Error sincronizando JWT con Supabase:', e);
            }
        }
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
}