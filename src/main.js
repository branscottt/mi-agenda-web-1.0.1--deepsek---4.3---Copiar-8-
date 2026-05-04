// main.js - Entry point principal (Strangler Fig)
// Se carga DESPUES de script.js como script normal (no module)
// Carga modulos ES via import() de forma segura - si falla, no rompe nada
// script.js legacy sigue funcionando como fallback completo

(function() {
    'use strict';

    // ============================================
    // shared/ - Cargar shared de forma segura
    // ============================================
    async function loadShared() {
        try {
            const supabase = await import('./shared/infrastructure/supabase.js');
            window.supabaseClient = supabase.supabaseClient;
            window.getSupabase = supabase.getSupabase;
            await import('./shared/infrastructure/toast.js');
            await import('./shared/infrastructure/formatters.js');
            await import('./shared/infrastructure/urgency-calculator.js');
            return true;
        } catch (e) {
            console.warn('[main.js] shared no disponible (usando script.js legacy):', e.message);
            return false;
        }
    }

    // ============================================
    // Interceptor JWT (opcional - no bloqueante)
    // ============================================
    async function syncJwtSession() {
        try {
            const { JwtManager } = await import('./auth/infrastructure/JwtManager.js');
            const { getSupabase } = await import('./shared/infrastructure/supabase.js');
            const accessToken = JwtManager.getAccessToken();
            if (!accessToken) return;
            const supabase = getSupabase();
            if (!supabase) return;
            if (!JwtManager.isTokenExpired()) {
                await supabase.auth.setSession({
                    access_token: accessToken,
                    refresh_token: JwtManager.getRefreshToken() || accessToken
                });
            } else {
                const refreshed = await JwtManager.refreshToken(supabase);
                if (refreshed) {
                    const newToken = JwtManager.getAccessToken();
                    await supabase.auth.setSession({
                        access_token: newToken,
                        refresh_token: JwtManager.getRefreshToken() || newToken
                    });
                }
            }
        } catch (e) {
            // No bloqueante - script.js legacy maneja la sesion
        }
    }

    // ============================================
    // Cargar modulos por pagina (seguro - no rompe si falla)
    // ============================================
    async function loadPageModules() {
        try {
            const { verificarProteccionRutas } = await import('./shared/infrastructure/router.js');
            await verificarProteccionRutas();
        } catch (e) {
            // verificarProteccionRutas de script.js ya se ejecuto
        }

        const esLogin = document.querySelector('.login-screen') && !document.querySelector('.planes-container');
        const esAdmin = document.querySelector('.admin-screen') && !document.querySelector('.superadmin-screen');
        const esSuperAdmin = document.querySelector('.superadmin-screen');
        const esCliente = document.querySelector('.client-screen');
        const esPlanes = document.getElementById('planes-container');

        if (esLogin && !esPlanes) {
            try {
                const { iniciarLogin } = await import('./auth/ui/LoginPage.js');
                iniciarLogin();
            } catch (e) { /* script.js maneja login */ }
        }

        if (esAdmin) {
            try {
                window.renderAdminAppointments = () => {};
                window.actualizarEstadisticas = () => {};
                window.actualizarStatsHeader = () => {};

                const { configurarFormularioServicio } = await import('./services/ui/ServiceForm.js');
                configurarFormularioServicio();

                const { renderAdminAppointments } = await import('./appointments/ui/AdminAppointmentList.js');
                renderAdminAppointments('upcoming-appointments');

                const { renderDashboard } = await import('./dashboard/ui/DashboardView.js');
                renderDashboard('stats-container');

                const { initNotificationPanel } = await import('./notifications/ui/NotificationPanel.js');
                initNotificationPanel('notif-list');

                const { initConfigEditor } = await import('./visual-config/ui/ConfigEditor.js');
                initConfigEditor('customization-form');

                console.log('[main.js] Modulos admin cargados correctamente');
            } catch (e) {
                console.warn('[main.js] Modulos admin no disponibles:', e.message);
            }
        }

        if (esCliente) {
            try {
                window.renderCatalogo = () => {};
                window.renderCarrito = () => {};
                window.renderMisReservas = () => {};

                const { renderCatalogo } = await import('./catalog/ui/CatalogPage.js');
                renderCatalogo('client-services-grid');

                const { initCartSidebar } = await import('./catalog/ui/CartSidebar.js');
                initCartSidebar('cart-sidebar');

                const { renderMisReservas } = await import('./appointments/ui/ClientReservationList.js');
                renderMisReservas('mis-reservas-list');

                console.log('[main.js] Modulos cliente cargados correctamente');
            } catch (e) {
                console.warn('[main.js] Modulos cliente no disponibles:', e.message);
            }
        }

        if (esSuperAdmin) {
            try {
                window.renderSuperAdmin = () => {};

                const { renderSuperAdmin } = await import('./super-admin/ui/SuperAdminView.js');
                renderSuperAdmin('superadmin-content');

                console.log('[main.js] Modulos superadmin cargados correctamente');
            } catch (e) {
                console.warn('[main.js] Modulos superadmin no disponibles:', e.message);
            }
        }
    }

    // ============================================
    // Inicio seguro - no bloquea nada
    // ============================================
    // Ejecutar DESPUES de que script.js haya terminado
    setTimeout(async () => {
        const sharedLoaded = await loadShared();
        if (sharedLoaded) {
            await syncJwtSession();
            await loadPageModules();
        }
    }, 50);

})();