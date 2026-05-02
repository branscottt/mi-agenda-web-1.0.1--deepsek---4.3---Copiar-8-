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
document.addEventListener('DOMContentLoaded', async () => {
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
        // Cargar modulos admin modernos
        const { configurarFormularioServicio } = await import('./services/ui/ServiceForm.js');
        configurarFormularioServicio();
        
        // El resto (carga de servicios, estadisticas, notificaciones) 
        // sigue siendo manejado por script.js legacy
        console.log('[main.js] Admin: ServiceForm moderno activo');
    }

    if (esCliente) {
        // Cliente: los modulos se cargaran en fases posteriores
        console.log('[main.js] Cliente: usando script.js legacy');
    }

    if (esSuperAdmin) {
        console.log('[main.js] SuperAdmin: usando script.js legacy');
    }

    if (esPlanes) {
        console.log('[main.js] Planes: usando script.js legacy');
    }
});