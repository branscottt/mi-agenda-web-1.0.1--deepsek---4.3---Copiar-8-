// main.js - Entry point principal (Strangler Fig)
// Se carga ANTES que script.js como script normal (no module)
// Carga modulos via import() de forma segura - si falla, no rompe nada
// script.js legacy sigue funcionando como fallback completo

(async function() {
    'use strict';

    // ============================================
    // SILENCIAR ERRORES DE RED DEL SDK (falsos positivos)
    // El SDK de Supabase intenta auto-recuperar sesiones previas
    // al crear el cliente. Si no hay conexión o hay CORS,
    // lanza un NetworkError que NO es un error real de la app.
    // ============================================
    window.addEventListener('unhandledrejection', (event) => {
        const msg = (event.reason?.message || event.reason || '').toString().toLowerCase();
        if (msg.includes('networkerror') || msg.includes('fetch') || msg.includes('network')) {
            if (msg.includes('supabase') || msg.includes('localhost') || msg.includes('127.0.0.1')) {
                event.preventDefault();
            }
        }
    });

    // ============================================
    // CREAR CLIENTE SUPABASE DE FORMA SINCRONA (sin import)
    // ============================================
    try {
        const SUPABASE_URL = 'https://dfcfimipkfhitlsyixqu.supabase.co';
        const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRmY2ZpbWlwa2ZoaXRsc3lpeHF1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxNzczMzAsImV4cCI6MjA4ODc1MzMzMH0.1OviTiPxYIK83bbmrYVY1nUR2o0bxn_wfqnWqK4Ccw0';
        
        if (!window.supabase) {
            console.warn('[main] Supabase SDK no disponible, se usara script.js legacy');
        } else {
            window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
            console.log('[main] window.supabaseClient asignado (sin import)');
        }
    } catch (e) {
        console.error('[main] Error creando supabaseClient (usando fallback script.js)');
    }

    // ============================================
    // shared/ - Cargar shared restante de forma segura
    // ============================================
    async function loadShared() {
        try {
            await import('./shared/infrastructure/toast.js');
            await import('./shared/infrastructure/formatters.js');
            await import('./shared/infrastructure/urgency-calculator.js');
            return true;
        } catch (e) {
            console.warn('[main.js] shared no disponible (usando fallback)');
            return false;
        }
    }

    // ============================================
    // Interceptor JWT + onAuthStateChange
    // ============================================
async function syncJwtSession() {
    try {
        const { JwtManager } = await import('./auth/infrastructure/JwtManager.js');
        const accessToken = JwtManager.getAccessToken();
        const supabase = window.supabaseClient;
        if (!supabase) return;

        // Exponer JwtManager al window para compatibilidad con script.js
        window.JwtManager = JwtManager;

        // Evitar setSession si ya hay una sesion activa en el cliente global
        const { data: { session: existingSession } } = await supabase.auth.getSession();
        if (existingSession) {
            console.log('[main] Sesion ya activa, no se fuerza setSession');
            JwtManager.startAutoRefresh(supabase);

            // Interceptor de sesion (onAuthStateChange) solo si hay sesion activa
            supabase.auth.onAuthStateChange(async (event, session) => {
                if (event === 'TOKEN_REFRESHED' && session) {
                    JwtManager.setTokens(session.access_token, session.refresh_token);
                }
                if (event === 'SIGNED_OUT') {
                    JwtManager.clear();
                    const esLogin = document.querySelector('.login-screen') && !document.querySelector('.planes-container');
                    if (!esLogin) {
                        window.location.href = 'login.html';
                    }
                }
            });
            return;
        }

        // Sincronizar sesion existente solo si no habia sesion activa
        if (accessToken) {
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
        }

        // Iniciar auto-refresh periodico (cada 4 min)
        JwtManager.startAutoRefresh(supabase);

        // Interceptor de sesion (onAuthStateChange)
        supabase.auth.onAuthStateChange(async (event, session) => {
            if (event === 'TOKEN_REFRESHED' && session) {
                JwtManager.setTokens(session.access_token, session.refresh_token);
            }
            if (event === 'SIGNED_OUT') {
                JwtManager.clear();
                const esLogin = document.querySelector('.login-screen') && !document.querySelector('.planes-container');
                if (!esLogin) {
                    window.location.href = 'login.html';
                }
            }
        });
    } catch (e) {
        // No bloqueante - script.js legacy maneja la sesion (con fallback)
    }
    }

    // ============================================
    // Cargar modulos por pagina (seguro - no rompe si falla)
    // ============================================
    async function loadPageModules() {
        const esLogin = document.querySelector('.login-screen') && !document.querySelector('.planes-container');
        const esAdmin = document.querySelector('.admin-screen') && !document.querySelector('.superadmin-screen');
        const esSuperAdmin = document.querySelector('.superadmin-screen');
        const esCliente = document.querySelector('.client-screen');
        const esPlanes = document.getElementById('planes-container');

        if (esLogin && !esPlanes) {
            try {
                const { iniciarLogin } = await import('./auth/ui/LoginPage.js');
                iniciarLogin();
            } catch (e) {
                console.warn('[main.js] Error cargando LoginPage.js:', e.message);
            }
        }

        if (esAdmin) {
            try {
                const { configurarFormularioServicio } = await import('./services/ui/ServiceForm.js');
                configurarFormularioServicio();

                const { renderAdminAppointments } = await import('./appointments/ui/AdminAppointmentList.js');
                renderAdminAppointments('upcoming-appointments');

                const { renderClientListView } = await import('./clients/ui/ClientListView.js');
                window.renderClientListView = renderClientListView;

                const { renderDashboard } = await import('./dashboard/ui/DashboardView.js');
                renderDashboard('stats-container');

                const { initNotificationPanel } = await import('./notifications/ui/NotificationPanel.js');
                initNotificationPanel('notif-list');

                const { initConfigEditor } = await import('./visual-config/ui/ConfigEditor.js');
                initConfigEditor('customization-form');

                // Módulos de trabajadores
                const { renderWorkersList, exposeWorkerGlobals } = await import('./workers/ui/WorkersListView.js');
                window.__initWorkersList = () => renderWorkersList('workers-list-container');
                exposeWorkerGlobals();

                const { renderWorkerSchedule } = await import('./workers/ui/WorkerScheduleView.js');
                window.__initWorkerSchedule = () => renderWorkerSchedule('schedule-container');

                const { renderWorkerShare, exposeShareGlobals } = await import('./workers/ui/WorkerShareView.js');
                window.__initWorkerShare = () => renderWorkerShare('workers-share-container');
                exposeShareGlobals();

                const { guardarWorkersDelServicio } = await import('./services/ui/ServiceForm.js');
                window.__guardarWorkersDelServicio = guardarWorkersDelServicio;

                console.log('[main.js] Modulos admin cargados correctamente');
            } catch (e) {
                console.warn('[main.js] Modulos admin no disponibles (usando fallback legacy)');
            }
        }

        if (esCliente) {
            try {
                // 1. Inicializar sesión del cliente (formulario nombre/email/whatsapp)
                const { initClientSession, getClienteSession } = await import('./clients/ui/ClientSession.js');
                window.getClienteSession = getClienteSession;

                initClientSession(async (session) => {
                    // 2. Setear tenant_id global para que getCurrentTenantId() funcione
                    //    incluso sin sesión Supabase Auth (clientes externos)
                    if (session && session.tenant_id) {
                        window.__clientTenantId = session.tenant_id;
                        console.log('[main.js] tenant_id de cliente:', session.tenant_id);
                    }

                    // 3. Una vez que el cliente ingresó sus datos, cargar el catálogo
                    try {
                        const { renderCatalogo } = await import('./catalog/ui/CatalogPage.js');
                        renderCatalogo('client-services-grid');
                    } catch (e) {
                        console.warn('[main.js] CatalogPage no disponible:', e.message);
                    }

                    try {
                        const { initCartSidebar } = await import('./catalog/ui/CartSidebar.js');
                        initCartSidebar('cart-sidebar');
                    } catch (e) {
                        console.warn('[main.js] CartSidebar no disponible:', e.message);
                    }

                    try {
                        const { renderMisReservas } = await import('./appointments/ui/ClientReservationList.js');
                        renderMisReservas('mis-reservas-list');
                    } catch (e) {
                        console.warn('[main.js] ClientReservationList no disponible:', e.message);
                    }

                    console.log('[main.js] Modulos cliente cargados correctamente');
                });
            } catch (e) {
                console.warn('[main.js] Error en inicialización cliente:', e.message);
            }
        }

        if (esPlanes) {
            try {
                const { renderPlans } = await import('./subscriptions/ui/PlansView.js');
                window.renderPlans = renderPlans;
                renderPlans('planes-container');
            } catch (e) {
                console.warn('[main.js] PlansView no disponible:', e.message);
            }
        }
    }

    // ============================================
    // Inicio seguro - no bloquea nada
    // ============================================
    // Ejecutar inmediatamente (no esperar a script.js)
    const sharedLoaded = await loadShared();
    if (sharedLoaded) {
        syncJwtSession().catch(() => {});
        loadPageModules().catch(() => {});
        exposeApi().catch(() => {});
    }

    // ============================================
    // Registrar Service Worker (silencioso, no bloquea)
    // ============================================
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
            // Silencioso — no crítico si falla
        });
    }

    // ============================================
    // Exponer APIs unicas para script.js legacy
    // ============================================
    async function exposeApi() {
        try {
            const appointmentsApi = await import('./api/appointmentsApi.js');
            window.__appointmentsApi = {
                getAllCitas: appointmentsApi.getAllCitas,
                createCita: appointmentsApi.createCita,
                updateCita: appointmentsApi.updateCita,
                deleteCita: appointmentsApi.deleteCita,
                upsertCita: appointmentsApi.upsertCita,
                getCitasByDate: appointmentsApi.getCitasByDate,
                limpiarCitasExpiradas: appointmentsApi.limpiarCitasExpiradas,
                createCitasBulk: appointmentsApi.createCitasBulk
            };

            const serviciosApi = await import('./api/serviciosApi.js');
            window.__serviciosApi = {
                getAll: serviciosApi.getAllServicios,
                getById: serviciosApi.getServicioById,
                create: serviciosApi.createServicio,
                update: serviciosApi.updateServicio,
                delete: serviciosApi.deleteServicio,
                upsert: serviciosApi.upsertServicio
            };

            const tenantsApi = await import('./api/tenantsApi.js');
            window.__tenantsApi = {
                getAll: tenantsApi.getAllTenants,
                getById: tenantsApi.getTenantById,
                getByEmail: tenantsApi.getTenantByEmail,
                create: tenantsApi.createTenant,
                update: tenantsApi.updateTenant,
                delete: tenantsApi.deleteTenant
            };

            const subscriptionsApi = await import('./api/subscriptionsApi.js');
            window.__subscriptionsApi = {
                getAll: subscriptionsApi.getAllSubscriptions,
                getByTenant: subscriptionsApi.getActiveSubscriptionByTenantId,
                create: subscriptionsApi.createSubscription,
                update: subscriptionsApi.updateSubscription,
                cancel: subscriptionsApi.cancelSubscription,
                getByFilter: subscriptionsApi.getSubscriptionsByFilter
            };

            const notificacionesApi = await import('./api/notificacionesApi.js');
            window.__notificacionesApi = {
                getAll: notificacionesApi.getAllNotificaciones,
                create: notificacionesApi.createNotificacion,
                marcarLeida: notificacionesApi.marcarComoLeida,
                delete: notificacionesApi.deleteNotificacion,
                getUnreadCount: notificacionesApi.getUnreadCount
            };

            const tenantConfigApi = await import('./api/tenantConfigApi.js');
            window.__tenantConfigApi = {
                getByTenant: tenantConfigApi.getConfigByTenantId,
                upsert: tenantConfigApi.upsertConfig,
                delete: tenantConfigApi.deleteConfig
            };

            // Exponer CitasManager modular para script.js legacy
            const cm = await import('./features/citas/CitasManager.js');
            window.__CitasManagerModular = cm;

            // Exponer httpClient para uso futuro
            const { fetchWithAuth } = await import('./shared/infrastructure/httpClient.js');
            window.fetchWithAuth = fetchWithAuth;

            // Exponer API de usuarios (vista usuarios_con_rol)
            const usuariosApi = await import('./api/usuariosApi.js');
            window.__usuariosApi = {
                getAll: usuariosApi.getAllUsuarios,
                getById: usuariosApi.getUsuarioById,
                updateRol: usuariosApi.updateUsuarioRol,
                delete: usuariosApi.deleteUsuario
            };

            console.log('[main.js] APIs expuestas en window.__*');
        } catch (e) {
            // No critico - script.js tiene fallback legacy
        }
    }

})();
