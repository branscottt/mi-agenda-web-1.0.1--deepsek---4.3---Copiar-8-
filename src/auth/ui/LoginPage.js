// auth/ui/LoginPage.js
// Controlador de la pagina login.html - event listeners y render
// Toda la logica de datos va a traves de src/api/tenantsApi.js

import { login, register, loginWithGoogle, resetPassword } from '../application/AuthService.js';
import { redirectByRole } from '../../shared/infrastructure/router.js';
import { getSupabase } from '../../shared/infrastructure/supabase.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { createTenant } from '../../api/tenantsApi.js';

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
                const JwtManager = (await import('../../auth/infrastructure/JwtManager.js')).JwtManager;
                const userData = JwtManager.getUserData();
                if (userData) {
                    redirectByRole(userData);
                }
            } else {
                if (loginErrorDiv) { loginErrorDiv.textContent = result.error; loginErrorDiv.style.display = 'block'; }
                mostrarToast(result.error, 'error');
            }
        });
    }

    // --- REGISTRO con orden secuencial seguro: signUp → createTenant → updateUser ---
    // Orden corregido para evitar orphan tenants y garantizar RLS.
    // 1. signUp: crear usuario en Auth (rol: 'admin' desde el inicio)
    // 2. signInWithPassword: activar sesion
    // 3. createTenant: crear negocio (usuario autenticado, RLS OK)
    // 4. updateUser: inyectar tenant_id en metadatos
    // 5. refreshSession: propagar tenant_id al JWT local
    // 6. redirect a planes.html
    if (registerForm) {
        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const nombre = document.getElementById('register-name')?.value.trim();
            const email = document.getElementById('register-email')?.value.trim().toLowerCase();
            const password = document.getElementById('register-password')?.value;
            const confirmPassword = document.getElementById('register-confirm-password')?.value;
            const whatsapp = document.getElementById('register-whatsapp')?.value.trim();

            if (registerErrorDiv) { registerErrorDiv.style.display = 'none'; registerErrorDiv.textContent = ''; }

            // --- Validaciones ---
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
            const digits = whatsapp.replace(/\D/g, '');
            if (digits.length < 8) {
                if (registerErrorDiv) { registerErrorDiv.textContent = 'WhatsApp inválido (mínimo 8 dígitos)'; registerErrorDiv.style.display = 'block'; }
                return;
            }
            const whatsappClean = whatsapp.startsWith('+') ? '+' + digits : digits;

            // --- Estado de carga ---
            const btn = e.target.querySelector('button[type="submit"]');
            if (btn) { btn.disabled = true; btn.textContent = 'Procesando...'; }

            const supabase = getSupabase();
            if (!supabase) {
                if (registerErrorDiv) { registerErrorDiv.textContent = 'Error de conexión. Recarga la página.'; registerErrorDiv.style.display = 'block'; }
                if (btn) { btn.disabled = false; btn.textContent = 'Crear Cuenta'; }
                return;
            }

            try {
                // ================================================================
                // PASO 1: signUp — crear usuario en Supabase Auth
                // rol: 'admin' desde el primer momento (no temporal)
                // ================================================================
                const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
                    email: email,
                    password: password,
                    options: {
                        data: {
                            nombre: nombre,
                            rol: 'admin',
                            whatsapp: whatsappClean
                        }
                    }
                });
                if (signUpError) throw signUpError;
                if (!signUpData || !signUpData.user) throw new Error('Error al crear la cuenta. Intenta nuevamente.');

                console.log('[LoginPage] signUp OK:', signUpData.user.id);

                // ================================================================
                // PASO 2: signInWithPassword — activar sesión (necesaria para RLS)
                // ================================================================
                const { error: signInError } = await supabase.auth.signInWithPassword({
                    email: email,
                    password: password
                });
                if (signInError) throw signInError;

                // ================================================================
                // PASO 3: createTenant — crear el negocio (usuario autenticado)
                // ================================================================
                const { data: tenant, error: tenantError } = await supabase
                    .from('tenants')
                    .insert({
                        nombre_negocio: nombre + "'s negocio",
                        email_contacto: email,
                        plan: null
                    })
                    .select()
                    .single();
                if (tenantError) throw tenantError;

                console.log('[LoginPage] tenant created:', tenant.id);

                // ================================================================
                // PASO 4: updateUser — inyectar tenant_id y rol admin en metadatos
                // ================================================================
                const { error: updateError } = await supabase.auth.updateUser({
                    data: {
                        tenant_id: tenant.id,
                        rol: 'admin',
                        nombre: nombre
                    }
                });
                if (updateError) throw updateError;

                // ================================================================
                // PASO 5: refreshSession — propagar metadatos al JWT local
                // ================================================================
                await supabase.auth.refreshSession();

                // Sincronizar JwtManager
                const { JwtManager } = await import('../../auth/infrastructure/JwtManager.js');
                const { data: { session: freshSession } } = await supabase.auth.getSession();
                if (freshSession) {
                    JwtManager.setTokens(freshSession.access_token, freshSession.refresh_token);
                }

                // ================================================================
                // PASO 6: Redirigir a selección de plan
                // ================================================================
                mostrarToast('¡Cuenta creada exitosamente! Elige tu plan.', 'success');
                window.location.href = `planes.html?tenant_id=${tenant.id}&new=true`;

            } catch (err) {
                console.error('[LoginPage] Registration error:', err);
                let msg = err.message;
                if (msg.includes('User already registered')) msg = 'Este correo ya está registrado';
                if (msg.includes('weak_password')) msg = 'La contraseña es muy débil. Usa al menos 6 caracteres.';
                if (registerErrorDiv) {
                    registerErrorDiv.textContent = msg;
                    registerErrorDiv.style.display = 'block';
                }
                mostrarToast(msg, 'error');
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = 'Crear Cuenta'; }
            }
        });
    }

    // --- GOOGLE LOGIN ---
    if (googleBtn) {
        googleBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            console.log('[LoginPage] Botón Google clickeado, llamando a loginWithGoogle()');
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

window.iniciarLogin = iniciarLogin;