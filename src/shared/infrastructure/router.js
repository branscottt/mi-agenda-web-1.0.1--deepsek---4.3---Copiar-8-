// shared/infrastructure/router.js
// Proteccion de rutas por rol
// Ahora lee la sesion desde JwtManager (localStorage) en lugar de llamar a Supabase.
// El refresh silencioso ocurre automaticamente si el token expiro.

import { getSupabase } from './supabase.js';
import { JwtManager } from '../../auth/infrastructure/JwtManager.js';

export const ROLES = {
    SUPER_ADMIN: 'super_admin',
    ADMIN: 'admin',
    CLIENTE: 'cliente'
};

/**
 * Obtiene la sesion actual desde JwtManager (localStorage).
 * SIN llamar a Supabase -- instantaneo y sin latencia de red.
 * Si el token expiro, intenta refresh silencioso automaticamente.
 */
export async function getSession() {
    const session = JwtManager.getSession();
    if (!session) return null;

    // Si el token expiro, intentar refresh silencioso
    if (JwtManager.isTokenExpired()) {
        const supabase = getSupabase();
        if (supabase) {
            const refreshed = await JwtManager.refreshToken(supabase);
            if (refreshed) {
                return JwtManager.getSession().user;
            }
            // Refresh fallo (expirado/revocado) -> sesion invalida
            return null;
        }
    }

    return session.user;
}

/**
 * Obtiene el tenant_id desde el JWT cacheado (sin llamar a Supabase).
 */
export async function getCurrentTenantId() {
    const userData = JwtManager.getUserData();
    if (!userData || !userData.tenant_id) return null;
    const cleanId = userData.tenant_id.trim();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(cleanId) ? cleanId : null;
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
 * Valida que la pagina actual corresponda al rol del usuario.
 * Ademas, sincroniza el JWT con Supabase via setSession para que
 * las RLS y todas las queries a Supabase funcionen sin cambios.
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
    // Esto es CLAVE: sin setSession(), supabaseClient.from() no usaria nuestro token
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
                console.warn('[router] Error sincronizando JWT con Supabase:', e);
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