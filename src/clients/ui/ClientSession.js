// clients/ui/ClientSession.js
// Sesión local del cliente en sessionStorage.
// No requiere Supabase Auth. Los datos se pierden al cerrar la pestaña.
// Extrae tenant_id de la URL (?tenant=XXX) para clientes sin Auth.

const STORAGE_KEY = 'agenda_cliente_session';

export function getClienteSession() {
    try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

export function setClienteSession(data) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function clearClienteSession() {
    sessionStorage.removeItem(STORAGE_KEY);
}

/**
 * Obtiene el tenant_id desde la URL (?tenant=XXX) o desde la sesión local.
 * Prioridad:
 *   1. URL param ?tenant=
 *   2. Sesión local (sessionStorage)
 *   3. null
 */
export function getTenantIdFromURL() {
    const params = new URLSearchParams(window.location.search);
    const tid = params.get('tenant');
    if (tid && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tid.trim())) {
        return tid.trim();
    }
    return null;
}

/**
 * Obtiene el tenant_id para clientes sin sesión Supabase.
 * Busca en: URL param > sessionStorage > null
 */
export function getTenantIdForClient() {
    // 1. URL param
    const fromURL = getTenantIdFromURL();
    if (fromURL) return fromURL;

    // 2. Sesión local
    const session = getClienteSession();
    if (session && session.tenant_id) return session.tenant_id;

    return null;
}

/**
 * Inicializa la sesión del cliente.
 * Si ya hay datos en sessionStorage, llama al callback inmediatamente.
 * Si el usuario ya tiene sesión Supabase (admin viendo como cliente), salta el formulario.
 * Si no, muestra un modal de registro y al completarlo guarda y llama al callback.
 * @param {Function} onReady - callback cuando la sesión está lista
 */
export function initClientSession(onReady) {
    // Caso 1: Ya hay sesión local (misma pestaña, recarga)
    const existing = getClienteSession();
    if (existing && existing.nombre && existing.email && existing.tenant_id) {
        actualizarHeaderCliente(existing);
        if (typeof onReady === 'function') onReady(existing);
        return;
    }

    // Caso 2: Usuario con sesión Supabase Auth (admin viendo "Ver como Cliente")
    // No necesita formulario de registro porque el tenant_id viene del JWT
    if (window.supabaseClient) {
        const hasAuthSession = window.supabaseClient.auth && 
            window.supabaseClient.auth.currentSession && 
            window.supabaseClient.auth.currentSession.access_token;
        if (hasAuthSession || (window.JwtManager && window.JwtManager.getAccessToken())) {
            // El admin ya tiene sesión — el tenant_id vendrá del JWT via getCurrentTenantId()
            const sessionData = {
                nombre: 'Administrador',
                email: '',
                whatsapp: '',
                tenant_id: null  // Se obtendrá del JWT
            };
            setClienteSession(sessionData);
            actualizarHeaderCliente(sessionData);
            if (typeof onReady === 'function') onReady(sessionData);
            return;
        }
    }

    // Caso 3: Cliente externo sin sesión — necesita formulario de registro
    const tenantId = getTenantIdFromURL();
    if (!tenantId) {
        mostrarErrorSinTenant();
        return;
    }

    mostrarFormularioRegistro(onReady, tenantId);
}

function mostrarErrorSinTenant() {
    let overlay = document.getElementById('cliente-registro-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'cliente-registro-overlay';
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-content glass-panel cliente-registro-modal">
                <div class="cliente-registro-icon">
                    <i class="fas fa-exclamation-triangle" style="color:#ff6b6b;"></i>
                </div>
                <h2>Enlace inválido</h2>
                <p class="muted">Este enlace no tiene un negocio asociado. Solicita un nuevo enlace al administrador.</p>
            </div>
        `;
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';
}

function mostrarFormularioRegistro(onReady, tenantId) {
    // Crear overlay si no existe
    let overlay = document.getElementById('cliente-registro-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'cliente-registro-overlay';
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-content glass-panel cliente-registro-modal">
                <div class="cliente-registro-icon">
                    <i class="fas fa-user-circle"></i>
                </div>
                <h2>¡Bienvenido!</h2>
                <p class="muted">Ingresa tus datos para comenzar a reservar servicios</p>
                <form id="cliente-registro-form" class="form-group" autocomplete="off">
                    <div class="input-with-icon">
                        <i class="fas fa-user"></i>
                        <input type="text" id="cliente-registro-nombre" placeholder="Tu nombre*" required>
                    </div>
                    <div class="input-with-icon">
                        <i class="fas fa-envelope"></i>
                        <input type="email" id="cliente-registro-email" placeholder="Tu correo electrónico*" required>
                    </div>
                    <div class="input-with-icon">
                        <i class="fab fa-whatsapp"></i>
                        <input type="tel" id="cliente-registro-whatsapp" placeholder="Tu WhatsApp (ej: +569****5678)">
                    </div>
                    <button type="submit" class="btn-grad btn-full">
                        <i class="fas fa-arrow-right"></i> Ingresar al catálogo
                    </button>
                </form>
                <p class="muted small" style="margin-top:12px;font-size:0.75rem;">
                    <i class="fas fa-shield-alt"></i> Tus datos solo se usan para gestionar tus reservas.
                    Al cerrar esta pestaña la sesión se elimina.
                </p>
            </div>
        `;
        document.body.appendChild(overlay);
    }

    overlay.style.display = 'flex';

    const form = document.getElementById('cliente-registro-form');
    const nombreInput = document.getElementById('cliente-registro-nombre');
    const emailInput = document.getElementById('cliente-registro-email');
    const whatsappInput = document.getElementById('cliente-registro-whatsapp');

    // Submit handler
    form.onsubmit = (e) => {
        e.preventDefault();
        const nombre = nombreInput.value.trim();
        const email = emailInput.value.trim();
        const whatsapp = whatsappInput.value.trim();

        if (!nombre || !email) {
            mostrarToastLocal('Completa nombre y correo', 'warning');
            return;
        }

        // Guardar con tenant_id
        const sessionData = { nombre, email, whatsapp, tenant_id: tenantId };
        setClienteSession(sessionData);
        actualizarHeaderCliente(sessionData);
        overlay.style.display = 'none';

        if (typeof onReady === 'function') onReady(sessionData);
    };

    // Auto-focus
    setTimeout(() => nombreInput?.focus(), 300);
}

function actualizarHeaderCliente(session) {
    const userSpan = document.querySelector('.user-info.client span');
    if (userSpan) userSpan.textContent = session.nombre || 'Cliente';
}

function mostrarToastLocal(mensaje, tipo) {
    const existing = document.querySelector('.toast-local');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast-local';
    toast.style.cssText = `
        position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
        padding: 10px 20px; border-radius: 8px;
        background: ${tipo === 'warning' ? 'rgba(255,165,0,0.9)' : 'rgba(0,200,83,0.9)'};
        color: #fff; z-index: 10000; font-size: 0.9rem;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        animation: fadeSlideIn 0.3s ease;
        max-width: 90vw; text-align: center;
    `;
    toast.textContent = mensaje;
    document.body.appendChild(toast);
    setTimeout(() => { toast.remove(); }, 3000);
}
