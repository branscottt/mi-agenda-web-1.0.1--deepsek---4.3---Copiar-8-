// main.js - Entry point principal
// Estrategia Strangler Fig: coexiste con script.js
// Cada pagina importa este archivo que detecta que modulos cargar

// ============================================
// shared/ - Siempre se cargan
// ============================================
import './shared/infrastructure/supabase.js';
import './shared/infrastructure/toast.js';
import './shared/infrastructure/formatters.js';
import './shared/infrastructure/urgency-calculator.js';
import { verificarProteccionRutas, getSession } from './shared/infrastructure/router.js';
import { supabaseClient } from './shared/infrastructure/supabase.js';

// Asegurar compatibilidad con script.js legacy
window.supabaseClient = supabaseClient;

// ============================================
// Detectar pagina actual y cargar modulos
// ============================================
// Usar setTimeout(fn, 0) para ejecutarse DESPUES de script.js (que corre inline/sync)
setTimeout(async () => {
    const esLogin = document.querySelector('.login-screen') && !document.querySelector('.planes-container');
    const esAdmin = document.querySelector('.admin-screen') && !document.querySelector('.superadmin-screen');
    const esSuperAdmin = document.querySelector('.superadmin-screen');
    const esCliente = document.querySelector('.client-screen');
    const esPlanes = document.getElementById('planes-container');

    // Proteccion de rutas
    await verificarProteccionRutas();

    if (esLogin && !esPlanes) {
        const { iniciarLogin } = await import('./auth/ui/LoginPage.js');
        iniciarLogin();
    }

    if (esAdmin) {
        // Anular handlers legacy de script.js para evitar duplicacion
        window.renderAdminAppointments = () => {};
        window.actualizarEstadisticas = () => {};
        window.actualizarStatsHeader = () => {};

        // Cargar modulos admin modernos
        const { configurarFormularioServicio } = await import('./services/ui/ServiceForm.js');
        configurarFormularioServicio();

        // FASE 3: appointments + dashboard
        const { renderAdminAppointments } = await import('./appointments/ui/AdminAppointmentList.js');
        renderAdminAppointments('upcoming-appointments');

        const { renderDashboard } = await import('./dashboard/ui/DashboardView.js');
        renderDashboard('stats-container');

        // FASE 5: notifications
        const { initNotificationPanel } = await import('./notifications/ui/NotificationPanel.js');
        initNotificationPanel('notif-list');

        // FASE 8: visual-config
        const { initConfigEditor } = await import('./visual-config/ui/ConfigEditor.js');
        initConfigEditor('customization-form');

        console.log('[main.js] Admin: ServiceForm + Appointments + Dashboard + Notifications + ConfigEditor activos');
    }

    if (esCliente) {
        // Anular handlers legacy
        window.renderCatalogo = () => {};
        window.renderCarrito = () => {};
        window.renderMisReservas = () => {};

        // FASE 4: catalog/cliente
        const { renderCatalogo } = await import('./catalog/ui/CatalogPage.js');
        renderCatalogo('client-services-grid');

        const { initCartSidebar } = await import('./catalog/ui/CartSidebar.js');
        initCartSidebar('cart-sidebar');

        const { renderMisReservas } = await import('./appointments/ui/ClientReservationList.js');
        renderMisReservas('mis-reservas-list');

        console.log('[main.js] Cliente: CatalogPage + CartSidebar + Reservations activos');
    }

    if (esSuperAdmin) {
        // Anular handlers legacy
        window.renderSuperAdmin = () => {};

        // FASE 7: super-admin
        const { renderSuperAdmin } = await import('./super-admin/ui/SuperAdminView.js');
        renderSuperAdmin('superadmin-content');

        console.log('[main.js] SuperAdmin: SuperAdminView activo');
    }

    if (esPlanes) {
        // FASE 6: subscriptions (la pagina de planes carga suscripciones)
        console.log('[main.js] Planes: usando script.js legacy');
    }
}, 0);