// ventas-live/ui/VentasLiveView.js
// Shell del workspace Ventas Live: muestra identidad del espacio y su plan.
// El producto en sí (conexión WhatsApp → web) se construye en ciclos
// siguientes; acá solo la base multi-proyecto.
// El workspace vl se resuelve SIEMPRE vía RPC get_mis_proyectos (server-side),
// nunca desde el tenant_id del JWT (que pertenece al proyecto de reservas).

import { getSupabase } from '../../shared/infrastructure/supabase.js';

const PLAN_LABELS = { vl_free: 'Gratis' };

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
}
