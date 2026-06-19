// auth/infrastructure/JwtManager.js
// Manejador de JWT: almacenamiento explicito en localStorage, decodificacion
// y refresh contra Supabase.
// NO firma tokens propios -- reutiliza el JWT que Supabase ya emite.
// NO necesita backend propio -- refresh directo contra Supabase.

const STORAGE_KEYS = {
    ACCESS_TOKEN: 'agendapro_access_token',
    REFRESH_TOKEN: 'agendapro_refresh_token',
    USER_DATA: 'agendapro_user_data'
};

// Lista de emails con rol super_admin (detectados por email, sin depender del JWT)
const SUPER_ADMIN_EMAILS = ['super@demo.com'];

/**
 * Decodifica la parte central (payload) de un JWT sin verificar la firma.
 * Solo lectura de claims; la verificacion la hace Supabase via RLS.
 */
function decodeJWTPayload(token) {
    try {
        const payload = token.split('.')[1];
        return JSON.parse(atob(payload));
    } catch (e) {
        return null;
    }
}

export const JwtManager = {
    /**
     * Guarda tokens y extrae datos de usuario del JWT.
     * Se llama despues de login, registro con sesion, y refresh.
     */
    setTokens(accessToken, refreshToken) {
        localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, accessToken);
        if (refreshToken) {
            localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, refreshToken);
        }
        // Cachear datos de usuario desde el payload del JWT
        const payload = decodeJWTPayload(accessToken);
        if (payload) {
            const meta = payload.user_metadata || {};
            const email = payload.email || '';
            // Detectar super_admin por email (sobrescribe cualquier rol del JWT)
            const rol = SUPER_ADMIN_EMAILS.includes(email) ? 'super_admin' : (meta.rol || 'cliente');
            localStorage.setItem(STORAGE_KEYS.USER_DATA, JSON.stringify({
                id: payload.sub,
                nombre: meta.nombre || (email ? email.split('@')[0] : 'Usuario'),
                email: email,
                rol: rol,
                tenant_id: meta.tenant_id
            }));
            if (SUPER_ADMIN_EMAILS.includes(email) && meta.rol !== 'super_admin') {
                console.log('[JwtManager] Superadmin detectado por email:', email);
            }
        }
    },

    getAccessToken() {
        return localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
    },

    getRefreshToken() {
        return localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN);
    },

    /**
     * Retorna los datos del usuario cacheados (sin llamar a Supabase).
     */
    getUserData() {
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.USER_DATA);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    },

    /**
     * Verifica si el access token expiro (con margen de 60 segundos).
     */
    isTokenExpired() {
        const token = this.getAccessToken();
        if (!token) return true;
        const payload = decodeJWTPayload(token);
        if (!payload || !payload.exp) return true;
        return (payload.exp * 1000) <= (Date.now() + 60000);
    },

    /**
     * Refresca el access token contra Supabase usando el refresh token.
     * Si falla (refresh expirado o revocado), limpia todo.
     */
    async refreshToken(supabaseClient) {
        const refreshToken = this.getRefreshToken();
        if (!refreshToken) return false;

        try {
            const { data, error } = await supabaseClient.auth.refreshSession();
            if (error || !data || !data.session) {
                this.clear();
                return false;
            }
            this.setTokens(data.session.access_token, data.session.refresh_token);
            return true;
        } catch (e) {
            console.error('[JwtManager] Error refreshing token:', e);
            this.clear();
            return false;
        }
    },

    /**
     * Retorna la sesion completa: tokens + datos de usuario.
     * Funcion principal que reemplaza supabase.auth.getSession().
     */
    getSession() {
        const accessToken = this.getAccessToken();
        const refreshToken = this.getRefreshToken();
        const userData = this.getUserData();
        if (!accessToken || !userData) return { data: { session: null }, error: null };
        // Devuelve el mismo formato que supabase.auth.getSession() para compatibilidad
        return {
            data: {
                session: {
                    access_token: accessToken,
                    refresh_token: refreshToken,
                    user: {
                        id: userData.id,
                        email: userData.email,
                        user_metadata: {
                            nombre: userData.nombre,
                            rol: userData.rol,
                            tenant_id: userData.tenant_id
                        }
                    }
                }
            },
            error: null
        };
    },

    /**
     * Limpia TODO el almacenamiento local relacionado con auth.
     * Se llama en logout y cuando el refresh falla.
     */
    clear() {
        localStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN);
        localStorage.removeItem(STORAGE_KEYS.REFRESH_TOKEN);
        localStorage.removeItem(STORAGE_KEYS.USER_DATA);
        this._stopAutoRefresh();
    },

    // ============================================
    // Auto-refresh periodico (cada 4 minutos)
    // ============================================
    _refreshTimer: null,

    /**
     * Inicia el refresco automatico del token cada 4 minutos.
     * Si falla 2 veces seguidas, cierra sesion silenciosamente.
     */
    startAutoRefresh(supabaseClient) {
        this._stopAutoRefresh();
        this._refreshTimer = setInterval(async () => {
            if (this.isTokenExpired()) {
                const success = await this.refreshToken(supabaseClient);
                if (!success) {
                    // Segunda verificacion: si sigue expirado, cerrar sesion
                    if (this.isTokenExpired()) {
                        this.clear();
                        if (window.location.pathname !== '/login.html') {
                            window.location.href = 'login.html';
                        }
                    }
                }
            }
        }, 240000); // 4 minutos
    },

    _stopAutoRefresh() {
        if (this._refreshTimer) {
            clearInterval(this._refreshTimer);
            this._refreshTimer = null;
        }
    }
};