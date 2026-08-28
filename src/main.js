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
    // SENTRY — Inicializar monitoreo de errores
    // Solo si el DSN está configurado (ver sentry.js)
    // ============================================
    try {
        const { initSentry } = await import('./shared/infrastructure/sentry.js');
        initSentry();
    } catch (e) {
        // Silencioso — Sentry es opcional
    }

    // ============================================
    // POSTHOG — Inicializar analytics (gratuito)
    // Solo se activa en producción con API key
    // ============================================
    try {
        const { initAnalytics } = await import('./shared/infrastructure/analytics.js');
        initAnalytics();
    } catch (e) {
        // Silencioso — Analytics es opcional
    }

    // ============================================
    // CREAR CLIENTE SUPABASE DE FORMA SINCRONA (sin import)
    // ============================================
    try {
        const cfg = window.__APP_CONFIG || {
            supabaseUrl: 'https://dfcfimipkfhitlsyixqu.supabase.co',
            supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRmY2ZpbWlwa2ZoaXRsc3lpeHF1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxNzczMzAsImV4cCI6MjA4ODc1MzMzMH0.1OviTiPxYIK83bbmrYVY1nUR2o0bxn_wfqnWqK4Ccw0',
        };
        
        if (!window.supabase) {
            console.warn('[main] Supabase SDK no disponible, se usara script.js legacy');
        } else {
            window.supabaseClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);
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
        const esTrabajador = document.querySelector('.worker-portal-body');

        if (esLogin && !esPlanes) {
            try {
                const { iniciarLogin } = await import('./auth/ui/LoginPage.js');
                iniciarLogin();
            } catch (e) {
                console.warn('[main.js] Error cargando LoginPage.js:', e.message);
            }

            // Directorio Público de PYMEs (sección de reseñas bajo el login)
            try {
                const { initDirectorio } = await import('./directory/ui/DirectoryView.js');
                initDirectorio();
            } catch (e) {
                console.warn('[main.js] Error cargando DirectoryView.js:', e.message);
            }
        }

        if (esAdmin) {
            try {
                const { configurarFormularioServicio } = await import('./services/ui/ServiceForm.js');
                configurarFormularioServicio();

                // NOTA: la sección "Citas Programadas" la renderiza el legacy
                // renderAdminAppointments (script.js) vía navigateTo — el render
                // moderno inicial aquí era sobrescrito y quedaba como trabajo muerto.
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

                const { guardarWorkersDelServicio, validarWorkersServicio, refrescarWorkersServicio, validarCoberturaWorkersServicio } = await import('./services/ui/ServiceForm.js');
                window.__guardarWorkersDelServicio = guardarWorkersDelServicio;
                window.__validarWorkersServicio = validarWorkersServicio;
                window.__refrescarWorkersServicio = refrescarWorkersServicio;
                window.__validarCoberturaWorkersServicio = validarCoberturaWorkersServicio;

                // Tutorial en video — sección Compartir con Clientes (mismo patrón que Crear Servicio)
                const { initTutorialCompartir } = await import('./share/ui/ShareTutorial.js');
                initTutorialCompartir();

                // Tutorial en video — Notificaciones (popover de la campana)
                const { initTutorialNotificaciones } = await import('./notifications/ui/NotificationsTutorial.js');
                initTutorialNotificaciones();

                // Tutorial en video — Citas Programadas
                const { initTutorialCitas } = await import('./appointments/ui/CitasTutorial.js');
                initTutorialCitas();

                // Tutorial en video — Mi Equipo
                const { initTutorialEquipo } = await import('./workers/ui/EquipoTutorial.js');
                initTutorialEquipo();

                // Módulo MFA — banner de configuración 2FA (no modifica HTML/CSS)
                const { initMfaSetup } = await import('./auth/ui/MfaSetup.js');
                initMfaSetup();

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
                renderPlans(document.getElementById('planes-container'));
            } catch (e) {
                console.warn('[main.js] PlansView no disponible:', e.message);
            }
        }

        if (esTrabajador) {
            try {
                // Portal público del trabajador (trabajador.html?tenant=X&id=Y)
                const { initWorkerPortal } = await import('./workers/ui/WorkerPortal.js');
                initWorkerPortal();
                console.log('[main.js] Portal trabajador iniciado');
            } catch (e) {
                console.warn('[main.js] WorkerPortal no disponible:', e.message);
            }
        }

        if (esSuperAdmin) {
            try {
                const { initAuditDashboard } = await import('./superadmin/ui/AuditDashboard.js');
                initAuditDashboard();
            } catch (e) {
                console.warn('[main.js] AuditDashboard no disponible:', e.message);
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
    // Los globals se definen NO-enumerables: no aparecen en Object.keys(window)
    // ni en el autocompletado de la consola, pero siguen accesibles por nombre
    // (script.js legacy los consume así). No son credenciales: son wrappers de
    // fetch que usan la anon key pública de Supabase + el JWT de sesión del usuario.
    function exposeGlobal(name, value) {
        Object.defineProperty(window, name, {
            value,
            enumerable: false,   // invisible en Object.keys(window)
            configurable: false, // no redefinible desde consola
            writable: false,     // no reasignable desde consola
        });
    }

    async function exposeApi() {
        try {
            const appointmentsApi = await import('./api/appointmentsApi.js');
            exposeGlobal('__appointmentsApi', {
                getAllCitas: appointmentsApi.getAllCitas,
                createCita: appointmentsApi.createCita,
                updateCita: appointmentsApi.updateCita,
                deleteCita: appointmentsApi.deleteCita,
                upsertCita: appointmentsApi.upsertCita,
                getCitasByDate: appointmentsApi.getCitasByDate,
                limpiarCitasExpiradas: appointmentsApi.limpiarCitasExpiradas,
                createCitasBulk: appointmentsApi.createCitasBulk,
                deleteAllCitas: appointmentsApi.deleteAllCitas
            });

            const serviciosApi = await import('./api/serviciosApi.js');
            exposeGlobal('__serviciosApi', {
                getAll: serviciosApi.getAllServicios,
                getById: serviciosApi.getServicioById,
                create: serviciosApi.createServicio,
                update: serviciosApi.updateServicio,
                delete: serviciosApi.deleteServicio,
                upsert: serviciosApi.upsertServicio
            });

            const tenantsApi = await import('./api/tenantsApi.js');
            exposeGlobal('__tenantsApi', {
                getAll: tenantsApi.getAllTenants,
                getById: tenantsApi.getTenantById,
                getByEmail: tenantsApi.getTenantByEmail,
                create: tenantsApi.createTenant,
                update: tenantsApi.updateTenant,
                delete: tenantsApi.deleteTenant
            });

            const subscriptionsApi = await import('./api/subscriptionsApi.js');
            exposeGlobal('__subscriptionsApi', {
                getAll: subscriptionsApi.getAllSubscriptions,
                getByTenant: subscriptionsApi.getActiveSubscriptionByTenantId,
                create: subscriptionsApi.createSubscription,
                update: subscriptionsApi.updateSubscription,
                cancel: subscriptionsApi.cancelSubscription,
                getByFilter: subscriptionsApi.getSubscriptionsByFilter,
                checkPromoCoupon: subscriptionsApi.checkPromoCouponStatus,
                markCouponUsed: subscriptionsApi.markPromoCouponUsed
            });

            // Exponer cliente Mercado Pago para script.js legacy
            const mercadopagoClient = await import('./subscriptions/infrastructure/mercadopago.js');
            exposeGlobal('__mercadopago', {
                createPreference: mercadopagoClient.createMercadoPagoPreference,
                createPreapproval: mercadopagoClient.createMercadoPagoPreapproval,
                redirect: mercadopagoClient.redirectToMercadoPago,
                checkStatus: mercadopagoClient.checkPaymentStatusFromUrl
            });

            const notificacionesApi = await import('./api/notificacionesApi.js');
            exposeGlobal('__notificacionesApi', {
                getAll: notificacionesApi.getAllNotificaciones,
                create: notificacionesApi.createNotificacion,
                marcarLeida: notificacionesApi.marcarComoLeida,
                delete: notificacionesApi.deleteNotificacion,
                getUnreadCount: notificacionesApi.getUnreadCount
            });

            const tenantConfigApi = await import('./api/tenantConfigApi.js');
            exposeGlobal('__tenantConfigApi', {
                getByTenant: tenantConfigApi.getConfigByTenantId,
                upsert: tenantConfigApi.upsertConfig,
                delete: tenantConfigApi.deleteConfig
            });

            // Exponer CitasManager modular para script.js legacy
            const cm = await import('./features/citas/CitasManager.js');
            exposeGlobal('__CitasManagerModular', cm);

            // Exponer httpClient para uso futuro
            const { fetchWithAuth } = await import('./shared/infrastructure/httpClient.js');
            exposeGlobal('fetchWithAuth', fetchWithAuth);

            // Exponer API de usuarios (RPCs superadmin seguras — vista usuarios_con_rol bloqueada)
            const usuariosApi = await import('./api/usuariosApi.js');
            exposeGlobal('__usuariosApi', {
                getAll: usuariosApi.getAllUsuarios,
                getById: usuariosApi.getUsuarioById,
                updateRol: usuariosApi.updateUsuarioRol,
                delete: usuariosApi.deleteUsuario
            });

            console.log('[main.js] APIs expuestas en window.__*');
        } catch (e) {
            // No critico - script.js tiene fallback legacy
        }
    }

})();
