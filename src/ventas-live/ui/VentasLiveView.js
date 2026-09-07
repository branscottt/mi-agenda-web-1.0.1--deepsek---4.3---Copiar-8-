// ventas-live/ui/VentasLiveView.js
// Orquestador del workspace Ventas Live: identidad del espacio, plan
// y navegación entre secciones (LIVE / Procesos / Clientes / Envíos /
// Finanzas). Cada sección se construye en su propio módulo; el router
// las activa bajo demanda (patrón Strangler Fig de la app).
// El workspace vl se resuelve SIEMPRE vía RPC get_mis_proyectos
// (server-side), nunca desde el tenant_id del JWT.

import { getSupabase } from '../../shared/infrastructure/supabase.js';

const PLAN_LABELS = { vl_free: 'Gratis' };

// Vistas pendientes de ciclos posteriores (Ciclo 5: Procesos/Clientes;
// Ciclo 6: Envíos/Finanzas). Placeholder mínimo para no romper la navegación.
const PENDIENTES = {
    procesos: { icono: 'fa-list-check', titulo: 'Procesos activos', texto: 'Aquí verás a los clientes que requieren acción: esperando WhatsApp, esperando pago, listos para preparar, envíos y entregas.' },
    clientes: { icono: 'fa-users', titulo: 'Clientes', texto: 'Acá vas a buscar clientes, revisar su ficha completa (historial, saldo, prendas guardadas) y editar su perfil.' },
    envios: { icono: 'fa-truck-fast', titulo: 'Envíos y entregas', texto: 'Las tareas del día: envíos de hoy, mañana y próximos, con los datos del cliente listos para copiar.' },
    finanzas: { icono: 'fa-chart-line', titulo: 'Finanzas', texto: 'Ingresos, dinero pendiente, inversión y gastos, con ganancia estimada y flujo de caja.' }
};

let _initialized = false;

export function initVentasLive() {
    if (_initialized) return;
    _initialized = true;
    renderVentasLive().catch(e => {
        console.error('[VentasLiveView] Error:', e);
        const loading = document.getElementById('vl-loading');
        if (loading) loading.innerHTML = '<i class="fas fa-exclamation-triangle"></i> No se pudo cargar tu espacio. <a href="ventas-live.html" style="color:#ffa94d;">Reintentar</a>';
    });
}

async function renderVentasLive() {
    const supabase = getSupabase();
    if (!supabase) {
        window.location.href = 'login.html';
        return;
    }

    const JwtManager = (await import('../../auth/infrastructure/JwtManager.js')).JwtManager;
    const userData = JwtManager.getUserData();
    if (!userData) {
        window.location.href = 'login.html';
        return;
    }
    if (userData.rol === 'super_admin') {
        window.location.href = 'superadmin.html';
        return;
    }

    // Volver al hub
    const backBtn = document.getElementById('vl-back-hub');
    if (backBtn) {
        backBtn.addEventListener('click', () => { window.location.href = 'hub.html'; });
    }

    // Logout
    const logoutBtn = document.getElementById('vl-logout');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            try { await supabase.auth.signOut(); } catch (_) {}
            JwtManager.clear();
            window.location.href = 'login.html';
        });
    }

    const { data: workspaces, error } = await supabase.rpc('get_mis_proyectos');
    if (error) throw error;

    const lista = Array.isArray(workspaces) ? workspaces : [];
    const wsVl = lista.find(ws => ws.proyecto === 'ventas_live');

    // Sin workspace de Ventas Live → al hub a crearlo
    if (!wsVl) {
        window.location.href = 'hub.html';
        return;
    }

    const loadingEl = document.getElementById('vl-loading');
    if (loadingEl) loadingEl.style.display = 'none';
    const contentEl = document.getElementById('vl-content');
    if (contentEl) contentEl.style.display = 'block';

    const nombreEl = document.getElementById('vl-nombre');
    if (nombreEl) nombreEl.textContent = wsVl.nombre_negocio || 'Mi espacio';

    const planEl = document.getElementById('vl-plan');
    if (planEl) {
        const suspendido = wsVl.estado === 'inactivo';
        if (suspendido) {
            planEl.textContent = 'Suspendido por administración';
            planEl.style.background = 'rgba(230,60,60,0.14)';
            planEl.style.borderColor = 'rgba(230,60,60,0.45)';
            planEl.style.color = '#ff9f9f';
        } else {
            const label = PLAN_LABELS[wsVl.sub_plan] || wsVl.sub_plan || 'Gratis';
            planEl.innerHTML = `<i class="fas fa-check-circle"></i> Plan ${label}`;
        }
    }

    // Router de secciones
    wireNav();
    activarVista('live');
}

function wireNav() {
    const nav = document.getElementById('vl-nav');
    if (!nav) return;
    nav.querySelectorAll('.vl-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            nav.querySelectorAll('.vl-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            activarVista(tab.dataset.view);
        });
    });
}

async function activarVista(nombre) {
    document.querySelectorAll('.vl-view').forEach(v => v.classList.remove('active'));
    const cont = document.getElementById('vl-view-' + nombre);
    if (!cont) return;
    cont.classList.add('active');

    if (nombre === 'live') {
        try {
            const mod = await import('./LiveView.js');
            (cont.dataset.cargada ? mod.activarLiveView : mod.initLiveView)();
            cont.dataset.cargada = '1';
        } catch (e) {
            console.error('[VentasLiveView] Error cargando LiveView:', e);
            cont.innerHTML = '<div class="vl-empty">No se pudo cargar el MODO LIVE.</div>';
        }
        return;
    }

    const pend = PENDIENTES[nombre];
    if (pend) {
        cont.innerHTML = `
            <div class="vl-card" style="text-align:center;padding:44px 24px;">
                <div style="font-size:2rem;color:#ffa94d;margin-bottom:14px;"><i class="fas ${pend.icono}"></i></div>
                <h2 style="margin:0 0 8px;color:#f8f9fa;font-size:1.15rem;">${pend.titulo}</h2>
                <p style="color:var(--muted,#adb5bd);max-width:480px;margin:0 auto;line-height:1.6;font-size:0.9rem;">${pend.texto}</p>
                <span class="vl-badge nuevo" style="margin-top:16px;">Próximamente</span>
            </div>`;
    }
}
