// auth/ui/LoginPage.js
// Controlador de la pagina login.html - event listeners y render

import { login, register, loginWithGoogle, resetPassword } from '../application/AuthService.js';
import { redirectByRole } from '../../shared/infrastructure/router.js';
import { getSupabase } from '../../shared/infrastructure/supabase.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';

export function iniciarLogin() {
    console.log('Iniciando login moderno...');
    
    const loginContainer = document.getElementById('login-container');
    const registerContainer = document.getElementById('register-container');
    const loginModeBtn = document.getElementById('login-mode');
    const registerModeBtn = document.getElementById('register-mode');
    const backToLogin = document.getElementById('back-to-login');
    const loginForm = document.getElementById('login-form-modern');
    const registerForm = document.getElementById('register-form-modern');
    const loginErrorDiv = document.getElementById('login-error-message');
    const registerErrorDiv = document.getElementById('register-error-message');
    const googleBtn = document.getElementById('google-login-btn');
    const forgotLink = document.getElementById('forgot-password-link');

    function showLogin() {
        if (loginContainer) loginContainer.style.display = 'block';
        if (registerContainer) registerContainer.style.display = 'none';
        if (loginModeBtn) loginModeBtn.classList.add('active');
        if (registerModeBtn) registerModeBtn.classList.remove('active');
        if (loginErrorDiv) loginErrorDiv.style.display = 'none';
        if (registerErrorDiv) registerErrorDiv.style.display = 'none';
    }

    function showRegister() {
        if (loginContainer) loginContainer.style.display = 'none';
        if (registerContainer) registerContainer.style.display = 'block';
        if (loginModeBtn) loginModeBtn.classList.remove('active');
        if (registerModeBtn) registerModeBtn.classList.add('active');
        if (loginErrorDiv) loginErrorDiv.style.display = 'none';
        if (registerErrorDiv) registerErrorDiv.style.display = 'none';
    }

    // Toggle login/register
    if (loginModeBtn) loginModeBtn.addEventListener('click', (e) => { e.preventDefault(); showLogin(); });
    if (registerModeBtn) registerModeBtn.addEventListener('click', (e) => { e.preventDefault(); showRegister(); });
    if (backToLogin) backToLogin.addEventListener('click', (e) => { e.preventDefault(); showLogin(); });

    // --- LOGIN ---
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('login-email')?.value.trim().toLowerCase();
            const password = document.getElementById('login-password')?.value;
            
            if (loginErrorDiv) { loginErrorDiv.style.display = 'none'; loginErrorDiv.textContent = ''; }
            
            if (!email || !password) {
                if (loginErrorDiv) { loginErrorDiv.textContent = 'Completa todos los campos'; loginErrorDiv.style.display = 'block'; }
                return;
            }
            
            const btn = e.target.querySelector('button[type="submit"]');
            if (btn) { btn.disabled = true; btn.textContent = '...'; }
            
            const result = await login(email, password);
            
            if (btn) { btn.disabled = false; btn.textContent = 'Iniciar Sesión'; }
            
            if (result.success) {
                const supabase = getSupabase();
                const { data: { session } } = await supabase.auth.getSession();
                const userData = {
                    id: session.user.id,
                    nombre: session.user.user_metadata?.nombre || 'Usuario',
                    email: session.user.email,
                    rol: session.user.user_metadata?.rol || 'cliente',
                    tenant_id: session.user.user_metadata?.tenant_id
                };
                redirectByRole(userData);
            } else {
                if (loginErrorDiv) { loginErrorDiv.textContent = result.error; loginErrorDiv.style.display = 'block'; }
                mostrarToast(result.error, 'error');
            }
        });
    }

    // --- REGISTRO ---
    if (registerForm) {
        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const nombre = document.getElementById('register-name')?.value.trim();
            const email = document.getElementById('register-email')?.value.trim().toLowerCase();
            const password = document.getElementById('register-password')?.value;
            const confirmPassword = document.getElementById('register-confirm-password')?.value;
            const whatsapp = document.getElementById('register-whatsapp')?.value.trim();
            
            if (registerErrorDiv) { registerErrorDiv.style.display = 'none'; registerErrorDiv.textContent = ''; }
            
            if (!nombre || !email || !password || !confirmPassword || !whatsapp) {
                if (registerErrorDiv) { registerErrorDiv.textContent = 'Completa todos los campos'; registerErrorDiv.style.display = 'block'; }
                return;
            }
            if (password !== confirmPassword) {
                if (registerErrorDiv) { registerErrorDiv.textContent = 'Las contraseñas no coinciden'; registerErrorDiv.style.display = 'block'; }
                return;
            }
            if (password.length < 6) {
                if (registerErrorDiv) { registerErrorDiv.textContent = 'La contraseña debe tener al menos 6 caracteres'; registerErrorDiv.style.display = 'block'; }
                return;
            }
            
            const btn = e.target.querySelector('button[type="submit"]');
            if (btn) { btn.disabled = true; btn.textContent = '...'; }
            
            try {
                // 1. Crear tenant en Supabase
                const supabase = getSupabase();
                const { data: newTenant, error: tenantError } = await supabase
                    .from('tenants')
                    .insert({ nombre_negocio: nombre + ' - ' + email, email_contacto: email, plan: 'freemium' })
                    .select()
                    .single();
                
                if (tenantError) throw new Error('Error al crear negocio: ' + tenantError.message);
                const tenantId = newTenant.id;
                
                // 2. Registrar usuario con rol admin
                const result = await register(email, password, {
                    nombre,
                    rol: 'admin',
                    tenant_id: tenantId,
                    whatsapp
                });
                
                if (!result.success) throw new Error(result.error);
                
                mostrarToast('Cuenta creada exitosamente. Elige tu plan.', 'success');
                window.location.href = `planes.html?tenant_id=${tenantId}&new=true`;
            } catch (err) {
                if (registerErrorDiv) { registerErrorDiv.textContent = err.message; registerErrorDiv.style.display = 'block'; }
                mostrarToast(err.message, 'error');
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = 'Crear Cuenta'; }
            }
        });
    }

    // --- GOOGLE LOGIN ---
    if (googleBtn) {
        googleBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            await loginWithGoogle();
        });
    }

    // --- RECUPERAR CONTRASEÑA ---
    if (forgotLink) {
        forgotLink.addEventListener('click', (e) => {
            e.preventDefault();
            const modal = document.getElementById('reset-modal');
            if (modal) modal.style.display = 'flex';
        });
        
        document.getElementById('btn-send-reset')?.addEventListener('click', async () => {
            const email = document.getElementById('reset-email')?.value.trim();
            const msgDiv = document.getElementById('reset-message');
            if (msgDiv) { msgDiv.style.display = 'none'; msgDiv.textContent = ''; }
            if (!email) {
                if (msgDiv) { msgDiv.textContent = 'Ingresa tu correo'; msgDiv.style.display = 'block'; }
                return;
            }
            const result = await resetPassword(email);
            if (msgDiv) {
                if (result.success) {
                    msgDiv.textContent = 'Enlace enviado. Revisa tu correo.';
                    msgDiv.style.color = '#00b894';
                } else {
                    msgDiv.textContent = result.error;
                }
                msgDiv.style.display = 'block';
            }
        });
        
        document.getElementById('btn-cancel-reset')?.addEventListener('click', () => {
            const modal = document.getElementById('reset-modal');
            if (modal) modal.style.display = 'none';
        });
        
        document.querySelector('#reset-modal .modal-close')?.addEventListener('click', () => {
            const modal = document.getElementById('reset-modal');
            if (modal) modal.style.display = 'none';
        });
    }
}

// Compatibilidad hacia atras
window.iniciarLogin = iniciarLogin;