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
import { getAppConfig } from '../../shared/infrastructure/config.js';

const PLAN_LABELS = { vl_free: 'Gratis' };

// URL pública del webhook de WhatsApp (la misma que se pega en Meta).
const WA_WEBHOOK_URL = (getAppConfig().supabaseUrl || '').replace(/\/+$/, '') + '/functions/v1/wa-webhook';

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
        if (loading) loading.innerHTML = '<i class="fas fa-exclamation-triangle"></i> No se pudo cargar tu espacio. <a href="ventas-live.html" style="color:#c77dff;">Reintentar</a>';
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

    // Atajo directo a Reservas de Pymes (si el usuario también tiene ese
    // workspace): si entró a Ventas Live por error o quiere cambiar al toque,
    // no necesita volver al hub. admin.html resuelve solo el tenant correcto.
    const wsRes = lista.find(ws => ws.proyecto === 'reservas');
    const goReservasBtn = document.getElementById('vl-go-reservas');
    if (wsRes && goReservasBtn) {
        goReservasBtn.style.display = '';
        goReservasBtn.addEventListener('click', () => {
            window.location.href = 'admin.html';
        });
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

    // Botón WhatsApp (bot automático): estado + wizard de conexión
    const waBtn = document.getElementById('vl-wa-btn');
    const conn = await vlApi.waConexionInfo();
    if (conn.ok && conn.data) pintarEstadoWa(conn.data);
    if (waBtn) {
        waBtn.addEventListener('click', async () => {
            const fresh = await vlApi.waConexionInfo();
            abrirModalWhatsApp(fresh.ok && fresh.data ? fresh.data : {});
        });
    }
}

function pintarEstadoWa(conn) {
    const btn = document.getElementById('vl-wa-btn');
    if (!btn) return;
    const on = !!conn && conn.wa_estado === 'conectado';
    btn.style.color = on ? '#25d366' : '';
    btn.style.borderColor = on ? 'rgba(37, 211, 102, 0.6)' : '';
    btn.title = on ? 'Bot de WhatsApp conectado' : 'Conectar WhatsApp (bot automático)';
}

// Wizard "Conectar WhatsApp": pegar los 4 valores de Meta Cloud API.
// El token y el app secret solo se escriben (vacío = conserva el actual);
// la lectura enmascarada (vl_wa_conexion_info) NUNCA los devuelve.
function abrirModalWhatsApp(conn) {
    const conectado = conn.wa_estado === 'conectado';
    const pill = conectado
        ? '<span class="vl-badge confiable" id="vww-pill">🟢 Conectado</span>'
        : '<span class="vl-badge problematico" id="vww-pill">⚪ Desconectado</span>';

    abrirModal({
        titulo: '🤖 Conectar WhatsApp',
        sub: 'El bot responde solo a tus clientes (Cloud API de Meta). Los valores se guardan solo del lado del servidor y el token nunca se vuelve a mostrar.',
        html: `
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
                <span style="font-size:0.82rem;font-weight:700;color:#ced4da;">Estado:</span> ${pill}
            </div>

            <div class="vl-form-row">
                <label for="vww-phone">ID del número (phone_number_id)</label>
                <input class="vl-control" id="vww-phone" value="${escapeHtml(conn.wa_phone_id || '')}" placeholder="123456789012345" autocomplete="off">
                <div style="font-size:0.75rem;color:var(--muted,#adb5bd);margin-top:5px;">Lo copiaste en WhatsApp Manager → tu número → "ID del número".</div>
            </div>
            <div class="vl-form-row">
                <label for="vww-token">Token de acceso ${conn.tiene_token ? '<span style="color:#7ff5d8;font-weight:700;">✓ guardado</span>' : ''}</label>
                <input class="vl-control" id="vww-token" type="password" placeholder="EAA…" autocomplete="off">
                <div style="font-size:0.75rem;color:var(--muted,#adb5bd);margin-top:5px;">Vacío = conserva el actual. ¿Token vencido? Pega el nuevo aquí.</div>
            </div>
            <div class="vl-form-row">
                <label for="vww-verify">Verify token</label>
                <input class="vl-control" id="vww-verify" value="${escapeHtml(conn.wa_verify_token || '')}" placeholder="el texto secreto que inventaste" autocomplete="off">
                <div style="font-size:0.75rem;color:var(--muted,#adb5bd);margin-top:5px;">Es el mismo que pegarás en Meta al configurar el webhook.</div>
            </div>
            <div class="vl-form-row">
                <label for="vww-secret">App secret ${conn.tiene_app_secret ? '<span style="color:#7ff5d8;font-weight:700;">✓ guardado</span>' : ''}</label>
                <input class="vl-control" id="vww-secret" type="password" placeholder="secreto de la app de Meta" autocomplete="off">
                <div style="font-size:0.75rem;color:var(--muted,#adb5bd);margin-top:5px;">Vacío = conserva el actual.</div>
            </div>

            <div class="vl-form-row">
                <label>URL del webhook (pégala en Meta)</label>
                <div style="display:flex;gap:8px;">
                    <input class="vl-control" id="vww-url" readonly value="${escapeHtml(WA_WEBHOOK_URL)}" style="flex:1;font-size:0.78rem;">
                    <button class="vl-btn" id="vww-copiar" type="button" title="Copiar URL"><i class="fas fa-copy"></i></button>
                </div>
            </div>

            <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:10px 14px;font-size:0.78rem;color:var(--muted,#adb5bd);line-height:1.7;">
                <b style="color:#ced4da;">Para terminar en Meta (una vez):</b><br>
                1. developers.facebook.com → tu app → WhatsApp → Configuración → Webhook.<br>
                2. Pega la URL de arriba y el verify token → "Verificar y guardar".<br>
                3. Suscríbete al campo <b style="color:#ced4da;">messages</b>.<br>
                Listo: cada mensaje que reciba tu número entra solo al sistema.
            </div>

            <div class="vl-modal-actions">
                <button class="vl-btn" id="vww-cancelar" type="button">Cancelar</button>
                <button class="vl-btn primary" id="vww-ok" type="button"><i class="fas fa-save"></i> Guardar conexión</button>
            </div>`,
        ancho: '560px',
        onMount: (modal, { marcarSucio }) => {
            const phoneEl = modal.querySelector('#vww-phone');
            const tokenEl = modal.querySelector('#vww-token');
            const verifyEl = modal.querySelector('#vww-verify');
            const secretEl = modal.querySelector('#vww-secret');
            [phoneEl, tokenEl, verifyEl, secretEl].forEach(el => el.addEventListener('input', marcarSucio));
            modal.querySelector('#vww-cancelar').addEventListener('click', () => cerrarModal(true));
            modal.querySelector('#vww-copiar').addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(WA_WEBHOOK_URL);
                    mostrarToast('URL copiada ✔', 'success');
                } catch (_) {
                    mostrarToast('No se pudo copiar; selecciónala manualmente', 'warning');
                }
            });
            modal.querySelector('#vww-ok').addEventListener('click', guardar);
            phoneEl.focus();

            async function guardar() {
                const btn = modal.querySelector('#vww-ok');
                btn.disabled = true;
                const res = await vlApi.guardarConfigWa({
                    p_phone_id: phoneEl.value.trim(),
                    p_token: tokenEl.value.trim(),
                    p_verify_token: verifyEl.value.trim(),
                    p_app_secret: secretEl.value.trim()
                });
                btn.disabled = false;
                if (!res.ok) { mostrarToast(res.error || 'No se pudo guardar la conexión', 'error'); return; }
                cerrarModal(true);
                const conn2 = await vlApi.waConexionInfo();
                if (conn2.ok && conn2.data) pintarEstadoWa(conn2.data);
                mostrarToast('Conexión guardada ✔', 'success');
            }
        }
    });
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
                <div style="font-size:2rem;color:#c77dff;margin-bottom:14px;"><i class="fas ${pend.icono}"></i></div>
                <h2 style="margin:0 0 8px;color:#f8f9fa;font-size:1.15rem;">${pend.titulo}</h2>
                <p style="color:var(--muted,#adb5bd);max-width:480px;margin:0 auto;line-height:1.6;font-size:0.9rem;">${pend.texto}</p>
                <span class="vl-badge nuevo" style="margin-top:16px;">Próximamente</span>
            </div>`;
    }
}
