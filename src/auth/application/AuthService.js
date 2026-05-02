// auth/application/AuthService.js
// Servicio de autenticacion: login, registro, logout, Google OAuth

import { getSupabase } from '../../shared/infrastructure/supabase.js';
import { redirectByRole } from '../../shared/infrastructure/router.js';

export async function login(email, password) {
    const supabase = getSupabase();
    if (!supabase) return { success: false, error: 'Supabase no inicializado' };
    try {
        const { data, error } = await supabase.auth.signInWithPassword({
            email: email.toLowerCase().trim(),
            password
        });
        if (error) return { success: false, error: error.message };
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
    if (!supabase) return;
    try {
        await supabase.auth.signOut();
        window.location.href = 'login.html';
    } catch (e) {
        console.error('Error al cerrar sesion:', e);
    }
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

// Compatibilidad hacia atras
window.cerrarSesion = logout;