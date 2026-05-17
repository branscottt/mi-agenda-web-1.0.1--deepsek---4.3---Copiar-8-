// shared/infrastructure/httpClient.js
// Wrapper global de fetch con interceptor 401.
// Intenta refrescar el token automaticamente si recibe 401 y re-intenta 1 vez.
// Si falla el refresh, redirige a login.html.

import { JwtManager } from '../../auth/infrastructure/JwtManager.js';

export async function fetchWithAuth(url, options = {}) {
    const token = JwtManager.getAccessToken();
    const headers = {
        ...options.headers,
    };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    let response = await fetch(url, { ...options, headers });

    if (response.status === 401) {
        // Intentar refrescar el token
        const refreshed = await JwtManager.refreshToken(window.supabaseClient);
        if (refreshed) {
            const newToken = JwtManager.getAccessToken();
            headers['Authorization'] = `Bearer ${newToken}`;
            response = await fetch(url, { ...options, headers });
        } else {
            // Refresh fallo -- redirigir a login
            JwtManager.clear();
            const esLogin = document.querySelector('.login-screen') && !document.querySelector('.planes-container');
            if (!esLogin) {
                window.location.href = 'login.html';
            }
            throw new Error('Sesion expirada. Redirigiendo a login...');
        }
    }

    return response;
}

// Compatibilidad global
window.fetchWithAuth = fetchWithAuth;