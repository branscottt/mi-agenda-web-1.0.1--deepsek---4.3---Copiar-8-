// src/AuthenticateUser.js
// Screaming Architecture: la intencion es clara desde el nombre del archivo
import { supabaseClient } from './shared/infrastructure/supabase.js';

export async function loginUser(email, password) {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    if (window.JwtManager && data.session) {
        window.JwtManager.setTokens(data.session.access_token, data.session.refresh_token);
    }
    return data;
}

export async function logoutUser() {
    if (window.JwtManager) window.JwtManager.clear();
    await supabaseClient.auth.signOut();
}