// ventas-live/ui/VentasLiveView.js
// Orquestador del workspace Ventas Live: identidad del espacio, plan
// y navegación entre secciones (LIVE / Procesos / Clientes / Envíos /
// Finanzas). Cada sección se construye en su propio módulo; el router
// las activa bajo demanda (patrón Strangler Fig de la app).
// El workspace vl se resuelve SIEMPRE vía RPC get_mis_proyectos
// (server-side), nunca desde el tenant_id del JWT.

import { getSupabase } from '../../shared/infrastructure/supabase.js';
import { vlApi } from '../domain/vlApi.js';
import { abrirModal, cerrarModal } from './vlModales.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { escapeHtml } from '../../shared/infrastructure/formatters.js';

const PLAN_LABELS = { vl_free: 'Gratis' };

// Todas las vistas están implementadas (Live, Procesos, Clientes,
// Envíos, Finanzas).
const PENDIENTES = {};

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
    pintarWhatsappYConfig();

    // Puente Procesos → ficha del cliente (pestaña Clientes)
    window.__vlIrAFicha = async (clienteId) => {
        document.querySelectorAll('.vl-tab').forEach(t => t.classList.toggle('active', t.dataset.view === 'clientes'));
        document.querySelectorAll('.vl-view').forEach(v => v.classList.remove('active'));
        const cont = document.getElementById('vl-view-clientes');
        if (!cont) return;
        cont.classList.add('active');
        try {
            const mod = await import('./ClientesView.js');
            mod.initClientes();
            mod.abrirFicha(clienteId);
        } catch (e) {
            console.error('[VentasLiveView] Error abriendo ficha:', e);
        }
    };
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

// Nombre y WhatsApp del espacio (propios de Ventas Live)
function pintarWhatsapp(whatsapp) {
    const sub = document.getElementById('vl-ws-sub');
    const waEl = document.getElementById('vl-whatsapp');
    if (!sub || !waEl) return;
    if (whatsapp) {
        waEl.textContent = whatsapp;
        sub.classList.remove('sin-numero');
    } else {
        waEl.textContent = 'Sin número configurado';
        sub.classList.add('sin-numero');
    }
}

async function pintarWhatsappYConfig() {
    const btn = document.getElementById('vl-config-btn');
    const info = await vlApi.workspaceInfo();
    if (info.ok && info.data) {
        pintarWhatsapp(info.data.whatsapp);
        if (info.data.nombre_negocio) {
            const nombreEl = document.getElementById('vl-nombre');
            if (nombreEl) nombreEl.textContent = info.data.nombre_negocio;
        }
    } else {
        pintarWhatsapp('');
    }
    if (btn) {
        // Datos SIEMPRE frescos al abrir (evita revertir cambios con caché vieja)
        btn.addEventListener('click', async () => {
            const fresh = await vlApi.workspaceInfo();
            const nombreEl = document.getElementById('vl-nombre');
            abrirModalConfig({
                nombre: (fresh.ok && fresh.data && fresh.data.nombre_negocio) || (nombreEl ? nombreEl.textContent : '') || '',
                whatsapp: (fresh.ok && fresh.data && fresh.data.whatsapp) || ''
            });
        });
    }
}

function abrirModalConfig(ws) {
    abrirModal({
        titulo: '⚙️ Configurar este espacio',
        sub: 'Ventas Live tiene su propio nombre y su propio WhatsApp, independientes del proyecto Reservas.',
        html: `
            <div class="vl-form-row">
                <label for="vw-nombre">Nombre del espacio</label>
                <input class="vl-control" id="vw-nombre" value="${escapeHtml(ws.nombre || '')}" maxlength="60">
            </div>
            <div class="vl-form-row">
                <label for="vw-whatsapp">WhatsApp a cargo</label>
                <input class="vl-control" id="vw-whatsapp" value="${escapeHtml(ws.whatsapp || '')}" placeholder="+56 9 …">
                <div style="font-size:0.75rem;color:var(--muted,#adb5bd);margin-top:5px;">
                    El número que recibirá los mensajes de tus clientes. Vacío = conserva el actual.
                </div>
            </div>
            <div class="vl-modal-actions">
                <button class="vl-btn" id="vw-cancelar" type="button">Cancelar</button>
                <button class="vl-btn primary" id="vw-ok" type="button"><i class="fas fa-save"></i> Guardar</button>
            </div>`,
        onMount: (modal, { marcarSucio }) => {
            const nombreEl = modal.querySelector('#vw-nombre');
            const waEl = modal.querySelector('#vw-whatsapp');
            [nombreEl, waEl].forEach(el => el.addEventListener('input', marcarSucio));
            modal.querySelector('#vw-cancelar').addEventListener('click', () => cerrarModal(true));
            modal.querySelector('#vw-ok').addEventListener('click', guardar);
            nombreEl.focus();
            async function guardar() {
                const nombre = nombreEl.value.trim();
                const whatsapp = waEl.value.trim();
                if (nombre.length < 2) { mostrarToast('El nombre debe tener al menos 2 caracteres', 'warning'); return; }
                const digits = whatsapp.replace(/\D/g, '');
                if (whatsapp && digits.length < 8) { mostrarToast('WhatsApp inválido (mínimo 8 dígitos)', 'warning'); return; }
                const btn = modal.querySelector('#vw-ok');
                btn.disabled = true;
                const res = await vlApi.actualizarWorkspace(nombre, whatsapp);
                btn.disabled = false;
                if (!res.ok) { mostrarToast(res.error || 'No se pudo guardar', 'error'); return; }
                cerrarModal(true);
                const nombreElH = document.getElementById('vl-nombre');
                if (nombreElH && res.data && res.data.nombre_negocio) nombreElH.textContent = res.data.nombre_negocio;
                pintarWhatsapp(res.data && res.data.whatsapp ? res.data.whatsapp : whatsapp);
                mostrarToast('Espacio actualizado ✔', 'success');
            }
        }
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

    if (nombre === 'procesos') {
        try {
            const mod = await import('./ProcesosView.js');
            mod.initProcesos();
        } catch (e) {
            console.error('[VentasLiveView] Error cargando ProcesosView:', e);
            cont.innerHTML = '<div class="vl-empty">No se pudo cargar Procesos.</div>';
        }
        return;
    }

    if (nombre === 'clientes') {
        try {
            const mod = await import('./ClientesView.js');
            mod.initClientes();
        } catch (e) {
            console.error('[VentasLiveView] Error cargando ClientesView:', e);
            cont.innerHTML = '<div class="vl-empty">No se pudo cargar Clientes.</div>';
        }
        return;
    }

    if (nombre === 'envios') {
        try {
            const mod = await import('./EnviosView.js');
            mod.initEnvios();
        } catch (e) {
            console.error('[VentasLiveView] Error cargando EnviosView:', e);
            cont.innerHTML = '<div class="vl-empty">No se pudo cargar Envíos.</div>';
        }
        return;
    }

    if (nombre === 'finanzas') {
        try {
            const mod = await import('./FinanzasView.js');
            mod.initFinanzas();
        } catch (e) {
            console.error('[VentasLiveView] Error cargando FinanzasView:', e);
            cont.innerHTML = '<div class="vl-empty">No se pudo cargar Finanzas.</div>';
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
