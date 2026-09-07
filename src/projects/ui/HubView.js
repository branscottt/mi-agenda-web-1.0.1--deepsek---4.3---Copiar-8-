// projects/ui/HubView.js
// Hub post-login: selector de proyectos (Reservas de Pymes / Ventas Live).
// Muestra una card por proyecto. Regla de énfasis:
//   * El proyecto donde el usuario YA tiene workspace resalta al frente.
//   * El que NO tiene sale atrás, difuminado (enlace "Ver el otro proyecto").
//   * Si tiene ambos (o ninguno) las dos cards se ven por igual.
// Los datos vienen de la RPC get_mis_proyectos (SECURITY DEFINER), fuente
// de verdad server-side (user_roles + tenants + subscriptions).

import { getSupabase } from '../../shared/infrastructure/supabase.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';

const PROYECTOS = {
    reservas: {
        title: 'Reservas de Pymes',
        entrar: 'admin.html'
    },
    ventas_live: {
        title: 'Ventas Live',
        entrar: 'ventas-live.html'
    }
};

const PLAN_LABELS = {
    freemium: 'Freemium',
    free_trial: 'Free Trial',
    pro: 'Pro',
    premium_anual: 'Premium',
    vl_free: 'Gratis'
};

let _initialized = false;

export function initHub() {
    if (_initialized) return;
    _initialized = true;
    renderHub().catch(e => {
        console.error('[HubView] Error:', e);
        const loading = document.getElementById('hub-loading');
        if (loading) loading.innerHTML = '<i class="fas fa-exclamation-triangle"></i> No se pudieron cargar tus proyectos. <a href="hub.html" style="color:#c77dff;">Reintentar</a>';
    });
}

async function renderHub() {
    const supabase = getSupabase();
    if (!supabase) {
        window.location.href = 'login.html';
        return;
    }

    const JwtManager = (await import('../../auth/infrastructure/JwtManager.js')).JwtManager;
    const userData = JwtManager.getUserData();

    // Guard de rol (los guards de ruta legacy ya re-dirigen al superadmin,
    // esto es una red de seguridad extra por si corre primero el módulo).
    if (!userData) {
        window.location.href = 'login.html';
        return;
    }
    if (userData.rol === 'super_admin') {
        window.location.href = 'superadmin.html';
        return;
    }

    const emailEl = document.getElementById('hub-user-email');
    if (emailEl) emailEl.textContent = userData.email || '';

    // Logout
    const logoutBtn = document.getElementById('hub-logout');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            try { await supabase.auth.signOut(); } catch (_) {}
            JwtManager.clear();
            window.location.href = 'login.html';
        });
    }

    // Workspaces del usuario
    const { data: workspaces, error } = await supabase.rpc('get_mis_proyectos');
    if (error) throw error;
    const lista = Array.isArray(workspaces) ? workspaces : [];

    const wsPorProyecto = {};
    lista.forEach(ws => { wsPorProyecto[ws.proyecto] = ws; });

    // Regla de énfasis
    const tieneReservas = !!wsPorProyecto.reservas;
    const tieneVl = !!wsPorProyecto.ventas_live;
    const dimmedProject = (tieneReservas !== tieneVl)
        ? (tieneReservas ? 'ventas_live' : 'reservas')
        : null;

    const loadingEl = document.getElementById('hub-loading');
    if (loadingEl) loadingEl.style.display = 'none';
    const cardsEl = document.getElementById('hub-cards');
    if (cardsEl) cardsEl.style.display = 'grid';

    Object.keys(PROYECTOS).forEach(proyecto => {
        const card = document.querySelector(`.project-card[data-proyecto="${proyecto}"]`);
        if (!card) return;
        const ws = wsPorProyecto[proyecto];
        card.classList.toggle('primary', dimmedProject !== proyecto && !!ws);
        card.classList.toggle('dimmed', dimmedProject === proyecto);
        renderCardEstado(proyecto, ws, userData);
    });

    // Enlace para traer al frente el proyecto difuminado
    const swapBtn = document.getElementById('hub-swap');
    if (swapBtn) {
        swapBtn.style.display = dimmedProject ? 'inline-block' : 'none';
        if (dimmedProject) {
            const otroTitulo = PROYECTOS[dimmedProject].title;
            swapBtn.textContent = `Quiero ver ${otroTitulo}`;
            swapBtn.onclick = () => {
                // Invertir énfasis: difuminar el otro y mostrar este
                Object.keys(PROYECTOS).forEach(proyecto => {
                    const c = document.querySelector(`.project-card[data-proyecto="${proyecto}"]`);
                    if (!c) return;
                    const ws = wsPorProyecto[proyecto];
                    c.classList.toggle('primary', proyecto === dimmedProject);
                    c.classList.toggle('dimmed', proyecto !== dimmedProject && !!ws);
                });
                swapBtn.style.display = 'none';
            };
        }
    }

    const noteEl = document.getElementById('hub-note');
    if (noteEl) {
        if (!tieneReservas && !tieneVl) {
            noteEl.textContent = 'Aún no tienes ningún proyecto. Elige uno para comenzar.';
        } else {
            noteEl.textContent = 'Cada proyecto tiene su propio plan y suscripción.';
        }
    }
}

function renderCardEstado(proyecto, ws, userData) {
    const pill = document.getElementById(`pill-${proyecto}`);
    const cta = document.getElementById(`cta-${proyecto}`);
    const wsnameEl = document.getElementById(`wsname-${proyecto}`);
    if (!pill || !cta) return;

    // Nombre del workspace en su card: cada proyecto es independiente
    if (wsnameEl) {
        if (ws && ws.nombre_negocio) {
            wsnameEl.textContent = ws.nombre_negocio;
            wsnameEl.classList.remove('empty');
        } else {
            wsnameEl.textContent = 'Sin nombre todavía';
            wsnameEl.classList.add('empty');
        }
    }

    const etiquetas = {
        reservas: 'Reservas de Pymes',
        ventas_live: 'Ventas Live'
    };
    void etiquetas;

    if (!ws) {
        // Sin workspace: invitar a comenzar
        pill.className = 'project-pill sin';
        pill.innerHTML = '<i class="fas fa-plus-circle"></i> Sin espacio todavía';
        cta.style.display = 'inline-block';
        cta.className = 'card-cta ' + (proyecto === 'ventas_live' ? 'grad-ventas' : 'grad');
        cta.innerHTML = '<i class="fas fa-rocket"></i> Comenzar';
        cta.onclick = () => abrirModalCrear(proyecto, userData);
        return;
    }

    const subActiva = ws.sub_status === 'active' || ws.sub_status === 'trial';
    const suspendido = ws.estado === 'inactivo';
    const planLabel = PLAN_LABELS[ws.sub_plan] || ws.sub_plan || 'Sin plan';

    if (suspendido) {
        pill.className = 'project-pill alerta';
        pill.innerHTML = '<i class="fas fa-ban"></i> Suspendido por administración';
        cta.style.display = 'none';
        return;
    }

    if (proyecto === 'ventas_live') {
        // Ventas Live: hoy es 100% gratis (vl_free). Sin gates de pago.
        pill.className = 'project-pill activo';
        pill.innerHTML = `<i class="fas fa-check-circle"></i> Plan ${planLabel}`;
        cta.style.display = 'inline-block';
        cta.className = 'card-cta grad-ventas';
        cta.innerHTML = '<i class="fas fa-arrow-right"></i> Entrar';
        cta.onclick = () => { window.location.href = 'ventas-live.html'; };
        return;
    }

    // Reservas: mismo criterio que verificarProteccionRutas (admin.html)
    if (subActiva) {
        pill.className = 'project-pill activo';
        pill.innerHTML = `<i class="fas fa-check-circle"></i> Plan ${planLabel}`;
        cta.style.display = 'inline-block';
        cta.className = 'card-cta grad';
        cta.innerHTML = '<i class="fas fa-arrow-right"></i> Entrar';
        cta.onclick = () => { window.location.href = 'admin.html'; };
    } else {
        pill.className = 'project-pill';
        pill.innerHTML = `<i class="fas fa-hourglass-half"></i> Plan ${planLabel} · sin suscripción activa`;
        cta.style.display = 'inline-block';
        cta.className = 'card-cta grad';
        cta.innerHTML = '<i class="fas fa-tags"></i> Ver planes';
        cta.onclick = () => { window.location.href = `planes.html?tenant_id=${ws.tenant_id}`; };
    }
}

// ============================================================
// Modal de alta de workspace (reservas / ventas_live)
// ============================================================
let _modalProyecto = null;
let _modalUserData = null;

function abrirModalCrear(proyecto, userData) {
    _modalProyecto = proyecto;
    _modalUserData = userData;

    const overlay = document.getElementById('hub-modal-overlay');
    const title = document.getElementById('hub-modal-title');
    const sub = document.getElementById('hub-modal-sub');
    const nombre = document.getElementById('hub-modal-nombre');
    const whatsapp = document.getElementById('hub-modal-whatsapp');
    const errorDiv = document.getElementById('hub-modal-error');
    const confirmBtn = document.getElementById('hub-modal-confirm');

    if (proyecto === 'ventas_live') {
        title.textContent = 'Crea tu espacio de Ventas Live';
        sub.textContent = 'Tu espacio para conectar WhatsApp a tu web y vender en vivo. Empieza gratis.';
        confirmBtn.className = 'card-cta grad-ventas';
        confirmBtn.innerHTML = '<i class="fas fa-bolt"></i> Crear espacio';
    } else {
        title.textContent = 'Crea tu negocio de Reservas';
        sub.textContent = 'Tu agenda online: servicios, turnos y recordatorios para tus clientes.';
        confirmBtn.className = 'card-cta grad';
        confirmBtn.innerHTML = '<i class="fas fa-rocket"></i> Crear negocio';
    }

    nombre.value = '';
    whatsapp.value = userData?.whatsapp || '';
    errorDiv.style.display = 'none';
    overlay.classList.add('visible');
    setTimeout(() => nombre.focus(), 50);
}

function cerrarModalCrear() {
    const overlay = document.getElementById('hub-modal-overlay');
    if (overlay) overlay.classList.remove('visible');
    _modalProyecto = null;
}

export function initHubModalEvents() {
    const overlay = document.getElementById('hub-modal-overlay');
    if (!overlay) return;

    const cancelBtn = document.getElementById('hub-modal-cancel');
    const confirmBtn = document.getElementById('hub-modal-confirm');

    if (cancelBtn && !cancelBtn.dataset.bound) {
        cancelBtn.dataset.bound = '1';
        cancelBtn.addEventListener('click', cerrarModalCrear);
    }

    // Regla de UX del proyecto: los modales con formulario NUNCA se cierran
    // por clic fuera ni Escape (evita perder lo escrito). Solo el botón
    // Cancelar explícito cierra.

    if (confirmBtn && !confirmBtn.dataset.bound) {
        confirmBtn.dataset.bound = '1';
        confirmBtn.addEventListener('click', async () => {
            const errorDiv = document.getElementById('hub-modal-error');
            const nombre = document.getElementById('hub-modal-nombre')?.value.trim();
            const whatsappRaw = document.getElementById('hub-modal-whatsapp')?.value.trim() || '';

            const ocultarError = () => { if (errorDiv) { errorDiv.style.display = 'none'; } };
            const mostrarError = (msg) => { if (errorDiv) { errorDiv.textContent = msg; errorDiv.style.display = 'block'; } };
            ocultarError();

            if (!nombre || nombre.length < 2) {
                mostrarError('Ingresa el nombre (mínimo 2 caracteres).');
                return;
            }
            let whatsappClean = '';
            if (whatsappRaw) {
                const digits = whatsappRaw.replace(/\D/g, '');
                if (digits.length < 8) {
                    mostrarError('WhatsApp inválido (mínimo 8 dígitos).');
                    return;
                }
                whatsappClean = whatsappRaw.startsWith('+') ? '+' + digits : digits;
            }

            confirmBtn.disabled = true;
            confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creando...';

            try {
                const supabase = getSupabase();
                const proyecto = _modalProyecto;
                const userData = _modalUserData;
                if (!proyecto || !userData) throw new Error('Sesión expirada. Vuelve a iniciar sesión.');

                if (proyecto === 'ventas_live') {
                    const { data: ws, error } = await supabase.rpc('crear_workspace_ventas_live', {
                        p_nombre_negocio: nombre,
                        p_whatsapp: whatsappClean || null
                    });
                    if (error) throw error;
                    if (!ws || !ws.id) throw new Error('No se pudo crear el espacio. Intenta nuevamente.');
                    mostrarToast('¡Espacio de Ventas Live creado!', 'success');
                    window.location.href = 'ventas-live.html';
                    return;
                }

                // Reservas: mismo flujo que el registro (LoginPage PASOS 3-6):
                // RPC → updateUser(tenant_id) → refreshSession → JwtManager → planes
                const { data: tenant, error: tenantError } = await supabase.rpc('crear_tenant_completo', {
                    p_nombre_negocio: nombre,
                    p_email_contacto: userData.email,
                    p_whatsapp: whatsappClean || null
                });
                if (tenantError) throw tenantError;
                if (!tenant || !tenant.id) throw new Error('No se pudo crear el negocio. Intenta nuevamente.');

                const { error: updateError } = await supabase.auth.updateUser({
                    data: {
                        tenant_id: tenant.id,
                        rol: 'admin',
                        nombre
                    }
                });
                if (updateError) throw updateError;

                await supabase.auth.refreshSession();
                const JwtManager = (await import('../../auth/infrastructure/JwtManager.js')).JwtManager;
                const { data: { session: freshSession } } = await supabase.auth.getSession();
                if (freshSession) {
                    JwtManager.setTokens(freshSession.access_token, freshSession.refresh_token);
                }

                mostrarToast('¡Negocio creado! Elige tu plan.', 'success');
                window.location.href = `planes.html?tenant_id=${tenant.id}&new=true`;
            } catch (err) {
                console.error('[HubView] Error creando workspace:', err);
                mostrarError(err.message || 'Error inesperado. Intenta nuevamente.');
            } finally {
                confirmBtn.disabled = false;
                const proyecto = _modalProyecto;
                confirmBtn.innerHTML = proyecto === 'ventas_live'
                    ? '<i class="fas fa-bolt"></i> Crear espacio'
                    : '<i class="fas fa-rocket"></i> Crear negocio';
            }
        });
    }
}
