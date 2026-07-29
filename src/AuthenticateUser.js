// src/AuthenticateUser.js
// Screaming Architecture: la intencion es clara desde el nombre del archivo
import { supabaseClient } from './shared/infrastructure/supabase.js';
import { trackEvent, identifyUser, resetAnalytics } from './shared/infrastructure/analytics.js';

export async function loginUser(email, password) {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) {
        trackEvent('login_failed', { reason: error.message });
        throw error;
    }
    if (window.JwtManager && data.session) {
        window.JwtManager.setTokens(data.session.access_token, data.session.refresh_token);
    }
    // Identificar en analytics (sin PII — solo IDs internos)
    if (data && data.user) {
        trackEvent('login_success', { user_id: data.user.id });
        const userData = window.JwtManager?.getUserData();
        identifyUser(data.user.id, {
            rol: userData?.rol || 'unknown',
            tenant_id: userData?.tenant_id || undefined,
        });
    }
    return data;
}

export async function logoutUser() {
    trackEvent('logout');
    if (window.JwtManager) {
        const userData = window.JwtManager.getUserData();
        if (userData) {
            trackEvent('logout', { user_id: userData.id, tenant_id: userData.tenant_id });
        }
        window.JwtManager.clear();
    }
    resetAnalytics();
    await supabaseClient.auth.signOut();
}
