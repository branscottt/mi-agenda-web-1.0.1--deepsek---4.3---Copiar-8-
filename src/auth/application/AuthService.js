// auth/application/AuthService.js
// Servicio de autenticacion: login, registro, logout, Google OAuth
// Ahora guarda el JWT explicitamente en JwtManager para control stateless

import { getSupabase } from '../../shared/infrastructure/supabase.js';
import { redirectByRole } from '../../shared/infrastructure/router.js';
import { JwtManager } from '../infrastructure/JwtManager.js';

export async function login(email, password) {
    const supabase = getSupabase();
    if (!supabase) return { success: false, error: 'Supabase no inicializado' };
    try {
        const { data, error } = await supabase.auth.signInWithPassword({
            email: email.toLowerCase().trim(),
            password
        });
        if (error) return { success: false, error: error.message };

        // Guardar JWT explicitamente en localStorage
        JwtManager.setTokens(data.session.access_token, data.session.refresh_token);

        return { success: true, session: data.session };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

export async function register(email, password, metadata) {
    const supabase = getSupabase();
    if (!supabase) return { success: false, error: 'Supabase no inicializado' };
    try {
        const { data, error } = await supabase.auth.signUp({
            email: email.toLowerCase().trim(),
            password,
            options: { data: metadata }
        });
        if (error) return { success: false, error: error.message };
        return { success: true, user: data.user };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

export async function loginWithGoogle() {
    const supabase = getSupabase();
    if (!supabase) return;
    try {
        // Limpiar cualquier sesión previa antes de iniciar OAuth
        JwtManager.clear();
        await supabase.auth.signOut();

        await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: window.location.origin + '/admin.html' }
        });
    } catch (e) {
        console.error('Error Google OAuth:', e);
    }
}

export async function logout() {
    const supabase = getSupabase();

    // 1. Limpiar JWT inmediatamente (localStorage)
    JwtManager.clear();

    // 2. Limpiar sesion en Supabase (fire-and-forget, no bloquea)
    if (supabase) {
        try {
            await supabase.auth.signOut();
        } catch (e) {
            console.error('Error al cerrar sesion en Supabase:', e);
        }
    }

    window.location.href = 'login.html';
}

export async function resetPassword(email) {
    const supabase = getSupabase();
    if (!supabase) return { success: false, error: 'Supabase no inicializado' };
    try {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: window.location.origin + '/login.html'
        });
        if (error) return { success: false, error: error.message };
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// Compatibilidad hacia atras con script.js
window.cerrarSesion = logout;