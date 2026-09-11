// auth/ui/LoginPage.js
// Controlador de la pagina login.html - event listeners y render
// Toda la logica de datos va a traves de src/api/tenantsApi.js

import { login, register, loginWithGoogle, resetPassword } from '../application/AuthService.js';
import { redirectByRole } from '../../shared/infrastructure/router.js';
import { getSupabase } from '../../shared/infrastructure/supabase.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { trackEvent } from '../../shared/infrastructure/analytics.js';

// Mensajes de error de autenticacion en espanol.
// Importante: Supabase devuelve el MISMO error (invalid_credentials) cuando la
// contrasena es incorrecta y cuando la cuenta se creo con Google (esas cuentas
// no tienen contrasena). Por eso el mensaje cubre las dos posibilidades y
// ofrece el camino correcto: el boton "Continuar con Google".
const MENSAJES_AUTH = {
    invalid_credentials: 'Correo o contraseña incorrectos. Si tu cuenta la creaste con Google, entra con «Continuar con Google» o crea tu contraseña en «¿Olvidaste tu contraseña?».',
    email_not_confirmed: 'Tu correo todavía no está confirmado. Revisa tu bandeja de entrada (y la carpeta de spam).',
    user_banned: 'Esta cuenta está bloqueada. Escríbenos por WhatsApp y te ayudamos.',
    over_request_rate_limit: 'Demasiados intentos seguidos. Espera un minuto y vuelve a intentarlo.',
    captcha_failed: 'No pudimos verificar que no eres un robot. Recarga la página e inténtalo otra vez.',
    same_password: 'Esa ya es tu contraseña actual. Elige una diferente.',
    reauthentication_needed: 'Por seguridad, abre de nuevo el enlace del correo e inténtalo otra vez.',
    current_password_required: 'Por seguridad, abre el enlace del correo para cambiar tu contraseña.',
    current_password_mismatch: 'Por seguridad, abre el enlace del correo para cambiar tu contraseña.',
    session_not_found: 'El enlace ya venció o se usó. Pídelo de nuevo en «¿Olvidaste tu contraseña?».'
};

function mensajeErrorAuth(error) {
    const code = (error && error.code) || '';
    if (MENSAJES_AUTH[code]) return MENSAJES_AUTH[code];
    const msg = (error && error.message) || '';
    if (/invalid login credentials/i.test(msg)) return MENSAJES_AUTH.invalid_credentials;
    if (/email not confirmed/i.test(msg)) return MENSAJES_AUTH.email_not_confirmed;
    if (/captcha/i.test(msg)) return MENSAJES_AUTH.captcha_failed;
    if (/rate limit|too many/i.test(msg)) return MENSAJES_AUTH.over_request_rate_limit;
    if (/auth session missing/i.test(msg)) return MENSAJES_AUTH.session_not_found;
    return msg || 'No pudimos iniciar tu sesión. Inténtalo otra vez.';
}

// Boton "ojito": alterna mostrar/ocultar la contrasena del input indicado en data-target.
function configurarTogglesPassword() {
    document.querySelectorAll('.toggle-password').forEach((btn) => {
        const input = document.getElementById(btn.dataset.target || '');
        if (!input) return;
        const icon = btn.querySelector('i');
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const estabaOculta = input.type === 'password';
            input.type = estabaOculta ? 'text' : 'password';
            if (icon) icon.className = estabaOculta ? 'fas fa-eye-slash' : 'fas fa-eye';
            const etiqueta = estabaOculta ? 'Ocultar contraseña' : 'Mostrar contraseña';
            btn.setAttribute('aria-label', etiqueta);
            btn.setAttribute('aria-pressed', estabaOculta ? 'true' : 'false');
            btn.title = etiqueta;
            // Devolver el foco al input con el cursor al final, para poder seguir escribiendo
            devolverFocoAlInput(input);
        });
    });
}

function devolverFocoAlInput(input) {
    try {
        const pos = input.value.length;
        input.focus();
        input.setSelectionRange(pos, pos);
    } catch (_) { /* algunos navegadores no permiten seleccionar en type=password */ }
}

export function iniciarLogin() {

    // GUARD: evitar doble inicialización (main.js + script.js llaman esta función)
    if (window._loginInitialized) {
        console.log('[LoginPage] ya inicializado, skipping');
        return;
    }
    window._loginInitialized = true;
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
    const googleBtnRegister = document.getElementById('google-login-btn-register');
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

    // Botón "ojito" para ver la contraseña que se está escribiendo
    configurarTogglesPassword();

    // ==================================================================
    // NUEVA CONTRASEÑA (enlace del correo de recuperación)
    // Permite que una cuenta creada con Google tenga contraseña propia y
    // después entre con correo + contraseña, sin depender de Google.
    // ==================================================================
    const recoveryContainer = document.getElementById('recovery-container');
    const recoveryForm = document.getElementById('recovery-form');
    const recoveryErrorDiv = document.getElementById('recovery-error-message');

    function mostrarRecovery() {
        if (loginContainer) loginContainer.style.display = 'none';
        if (registerContainer) registerContainer.style.display = 'none';
        if (recoveryContainer) recoveryContainer.style.display = 'block';
        const modeToggle = document.querySelector('.mode-toggle');
        if (modeToggle) modeToggle.style.display = 'none';
        if (loginErrorDiv) loginErrorDiv.style.display = 'none';
        if (registerErrorDiv) registerErrorDiv.style.display = 'none';
        console.log('[LoginPage] Flujo de nueva contraseña activo');
    }

    function paramsDelHash() {
        const hash = (window.location.hash || '').replace(/^#/, '');
        return new URLSearchParams(hash);
    }

    // El enlace del correo vuelve como #access_token=...&type=recovery
    function esEnlaceDeRecovery() {
        try { return paramsDelHash().get('type') === 'recovery'; } catch (_) { return false; }
    }

    // Errores que Supabase devuelve EN LA URL (login con Google fallido, enlace
    // vencido, etc.). Hay que mostrarlos SIEMPRE: si no, el usuario vuelve al
    // login sin saber qué pasó (caso real reportado 2026-11).
    function paramsDeUrl() {
        const q = new URLSearchParams((window.location.search || '').replace(/^\?/, ''));
        const h = paramsDelHash();
        return {
            error: h.get('error') || q.get('error'),
            errorCode: h.get('error_code') || q.get('error_code'),
            errorDescription: h.get('error_description') || q.get('error_description'),
        };
    }

    function mensajeDeErrorDeUrl(p) {
        const code = p.errorCode || '';
        const detalle = p.errorDescription ? ' Detalle: ' + String(p.errorDescription).slice(0, 120) : '';
        if (code === 'otp_expired') return 'Ese enlace ya venció o se usó. Pídelo de nuevo en «¿Olvidaste tu contraseña?».';
        if (code === 'access_denied' || p.error === 'access_denied') {
            return 'No se autorizó el acceso con Google. Inténtalo otra vez, o entra con tu correo y tu contraseña.' + detalle;
        }
        if (code === 'unexpected_failure' || p.error === 'server_error') {
            return 'Google no pudo confirmar la cuenta, así que no se pudo entrar. Inténtalo otra vez; si sigue pasando, escríbenos por WhatsApp.' + detalle;
        }
        if (code) return 'No se pudo completar el acceso (' + code + '). Inténtalo otra vez.' + detalle;
        return 'No se pudo completar el acceso. Inténtalo otra vez.' + detalle;
    }

    function avisarErrorDeUrl() {
        try {
            const p = paramsDeUrl();
            if (!p.error && !p.errorCode) return;
            const msg = mensajeDeErrorDeUrl(p);
            if (loginErrorDiv) { loginErrorDiv.textContent = msg; loginErrorDiv.style.display = 'block'; }
            mostrarToast(msg, 'error');
            console.warn('[LoginPage] Supabase devolvió un error en la URL:', p.errorCode || p.error);
        } catch (_) {}
    }

    // Si la URL trae una sesión (login con Google que aterrizó en login.html en
    // vez de hub.html), terminamos el login en vez de quedarnos en silencio.
    function completarLoginDesdeUrl() {
        if (esEnlaceDeRecovery()) return false;
        if (!/access_token=/.test((window.location.hash || '') + (window.location.search || ''))) return false;
        console.log('[LoginPage] Sesión recibida en la URL: completando login');
        mostrarToast('Entrando a tu cuenta...', 'info');
        setTimeout(() => { window.location.replace('hub.html'); }, 500);
        return true;
    }

    if (recoveryForm) {
        recoveryForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const pass = document.getElementById('recovery-password')?.value || '';
            const repetida = document.getElementById('recovery-confirm-password')?.value || '';
            const mostrarError = (texto, color) => {
                if (!recoveryErrorDiv) return;
                recoveryErrorDiv.textContent = texto;
                recoveryErrorDiv.style.color = color || '';
                recoveryErrorDiv.style.display = 'block';
            };
            if (recoveryErrorDiv) { recoveryErrorDiv.style.display = 'none'; recoveryErrorDiv.textContent = ''; }

            if (!pass || !repetida) return mostrarError('Completa los dos campos');
            if (pass.length < 6) return mostrarError('La contraseña debe tener al menos 6 caracteres');
            if (pass !== repetida) return mostrarError('Las contraseñas no coinciden');

            const supabase = getSupabase();
            if (!supabase) return mostrarError('Error de conexión. Recarga la página.');

            const btn = e.target.querySelector('button[type="submit"]');
            if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }

            const { error } = await supabase.auth.updateUser({ password: pass });

            if (btn) { btn.disabled = false; btn.textContent = 'Guardar contraseña'; }

            if (error) {
                const msg = mensajeErrorAuth(error);
                mostrarError(msg);
                mostrarToast(msg, 'error');
                return;
            }

            trackEvent('password_created', {});
            mostrarError('¡Listo! Ya tienes contraseña. Ahora puedes entrar con tu correo y tu contraseña.', '#00b894');
            mostrarToast('Contraseña creada correctamente', 'success');
            setTimeout(() => { window.location.href = 'hub.html'; }, 2000);
        });
    }

    // Detección del enlace (evento del SDK + hash de la URL como respaldo)
    try {
        const supabaseAuth = getSupabase();
        if (supabaseAuth) {
            supabaseAuth.auth.onAuthStateChange((event) => {
                if (event === 'PASSWORD_RECOVERY') mostrarRecovery();
            });
        }
    } catch (_) {}
    if (esEnlaceDeRecovery()) mostrarRecovery();
    avisarErrorDeUrl();
    completarLoginDesdeUrl();

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
            
            // Obtener captcha token si Turnstile está activo (try/catch por si no está configurado)
            let captchaToken = null;
            try {
                if (typeof turnstile !== 'undefined') {
                    captchaToken = turnstile.getResponse();
                }
            } catch (_) {}
            
            const result = await login(email, password, captchaToken);
            
            if (btn) { btn.disabled = false; btn.textContent = 'Iniciar Sesión'; }
            
            if (result.success) {
                const JwtManager = (await import('../../auth/infrastructure/JwtManager.js')).JwtManager;
                const userData = JwtManager.getUserData();
                if (userData) {
                    redirectByRole(userData);
                }
            } else {
                const mensaje = mensajeErrorAuth({ code: result.code, message: result.error });
                if (loginErrorDiv) { loginErrorDiv.textContent = mensaje; loginErrorDiv.style.display = 'block'; }
                mostrarToast(mensaje, 'error');
            }
        });
    }

    // --- REGISTRO con orden secuencial seguro: signUp → crear_tenant_completo (RPC) → updateUser ---
    // 1. signUp: crear usuario en Auth (rol: 'admin' desde el inicio)
    // 2. Activar sesión (signUp session auto-activada || signInWithPassword legacy)
    // 3. crear_tenant_completo (RPC SECURITY DEFINER): tenant + trigger subscription
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

            // Obtener captcha token si Turnstile está activo
            let captchaToken = null;
            try {
                if (typeof turnstile !== 'undefined') {
                    captchaToken = turnstile.getResponse();
                }
            } catch (_) {}

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
                const signUpOptions = {
                    data: {
                        nombre: nombre,
                        rol: 'admin',
                        whatsapp: whatsappClean
                    }
                };
                if (captchaToken) {
                    signUpOptions.captchaToken = captchaToken;
                }
                const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
                    email: email,
                    password: password,
                    options: signUpOptions
                });
                if (signUpError) throw signUpError;
                if (!signUpData || !signUpData.user) throw new Error('Error al crear la cuenta. Intenta nuevamente.');

                console.log('[LoginPage] signUp OK:', signUpData.user.id);

                // ================================================================
                // PASO 2: Activar sesión (necesaria para RLS)
                // Si signUp ya devolvió sesión (email auto-confirmado), la usamos
                // directamente para evitar un bug del SDK en signInWithPassword
                // post-signUp. Si no hay sesión (confirmación ON), hacemos login
                // tradicional. Esto garantiza retrocompatibilidad total.
                // ================================================================
                if (!signUpData.session) {
                    const signInOpts = {
                        email: email,
                        password: password
                    };
                    if (captchaToken) {
                        signInOpts.options = { captchaToken };
                    }
                    const { error: signInError } = await supabase.auth.signInWithPassword(signInOpts);
                    if (signInError) throw signInError;
                } else {
                    console.log('[LoginPage] Sesión auto-activada por signUp (confirmación OFF)');
                }

                // ================================================================
                // PASO 3: crear_tenant_completo — crear el negocio vía RPC
                // Usamos RPC con SECURITY DEFINER para bypassear el bloqueo
                // del API Gateway con JWTs ES256. La función también dispara
                // el trigger de creación de suscripción automáticamente.
                // ================================================================
                const { data: tenant, error: tenantError } = await supabase
                    .rpc('crear_tenant_completo', {
                        p_nombre_negocio: nombre,
                        p_email_contacto: email,
                        p_whatsapp: whatsappClean
                    });
                if (tenantError) throw tenantError;
                if (!tenant || !tenant.id) throw new Error('Error al crear el negocio. Intenta nuevamente.');

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
                trackEvent('registration_complete', {
                    tenant_id: tenant.id,
                    has_subscription: true
                });
                mostrarToast('¡Cuenta creada exitosamente! Elige tu plan.', 'success');
                window.location.href = `planes.html?tenant_id=${tenant.id}&new=true`;

            } catch (err) {
                console.error('[LoginPage] Registration error:', err);
                let msg = err.message;
                // Cuenta creada con Google: no tiene contraseña, hay que entrar por OAuth
                if (msg.includes('User already registered') || err.code === 'user_already_exists' || err.code === 'email_exists') {
                    msg = 'Este correo ya está registrado. Si tu cuenta la creaste con Google, usa «Continuar con Google» (esa cuenta no tiene contraseña); si no, inicia sesión con tu contraseña.';
                }
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

    // --- GOOGLE LOGIN (login y registro comparten el mismo flujo OAuth) ---
    // El onboarding de usuario nuevo lo resuelve el AuthGuard legacy (iniciarAdmin,
    // CASO A): crea el tenant, redirige a planes.html?pending_whatsapp=true.
    const handleGoogleLogin = async (e) => {
        e.preventDefault();
        console.log('[LoginPage] Botón Google clickeado, llamando a loginWithGoogle()');
        const result = await loginWithGoogle();
        if (result && !result.success) {
            const msg = result.error || 'Error al iniciar con Google. Intenta nuevamente.';
            mostrarToast(msg, 'error');
        }
    };
    if (googleBtn) googleBtn.addEventListener('click', handleGoogleLogin);
    if (googleBtnRegister) googleBtnRegister.addEventListener('click', handleGoogleLogin);

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