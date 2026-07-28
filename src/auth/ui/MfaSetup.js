// src/auth/ui/MfaSetup.js
// Configuración de MFA (Autenticación de Dos Factores) vía TOTP
//
// Se inyecta completamente por JS — no modifica HTML ni CSS existente.
// Crea un modal dinámico para el flujo de enrollamiento:
//   1. Verificar si el usuario ya tiene MFA enrolado
//   2. Mostrar banner de seguridad si no tiene
//   3. Botón "Configurar 2FA" → modal con QR code
//   4. Usuario escanea con app autenticadora (Google Authenticator, Authy, etc.)
//   5. Usuario ingresa código de 6 dígitos para verificar
//   6. MFA activado
//
// Flujo Supabase MFA API:
//   enroll() → challenge() → verify()

import { getSupabase } from '../../shared/infrastructure/supabase.js';

// Estilos inyectados solo para el MFA (no modifican style.css)
const MFA_STYLES = `
  .mfa-banner {
    background: linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%);
    border-radius: 8px;
    padding: 12px 16px;
    margin: 8px 0;
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 14px;
    color: #333;
  }
  .mfa-banner i { font-size: 20px; color: #e67e22; }
  .mfa-banner .mfa-btn {
    margin-left: auto;
    background: #e67e22;
    color: #fff;
    border: none;
    padding: 6px 16px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
  }
  .mfa-banner .mfa-btn:hover { background: #d35400; }
  .mfa-banner.mfa-active {
    background: linear-gradient(135deg, #d4edda 0%, #c3e6cb 100%);
  }
  .mfa-banner.mfa-active i { color: #28a745; }
  .mfa-banner.mfa-active .mfa-btn {
    background: #6c757d;
    cursor: default;
  }

  .mfa-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.6);
    z-index: 99999;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .mfa-modal {
    background: #fff;
    border-radius: 16px;
    padding: 32px;
    max-width: 440px;
    width: 90%;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    position: relative;
    animation: mfaFadeIn 0.3s ease;
    color: #333;
  }
  @keyframes mfaFadeIn {
    from { opacity: 0; transform: translateY(-20px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .mfa-modal h2 {
    margin: 0 0 8px;
    font-size: 22px;
    color: #222;
  }
  .mfa-modal p {
    margin: 0 0 16px;
    font-size: 14px;
    color: #666;
    line-height: 1.5;
  }
  .mfa-modal .mfa-close {
    position: absolute;
    top: 12px;
    right: 16px;
    font-size: 24px;
    cursor: pointer;
    color: #999;
    background: none;
    border: none;
    padding: 4px 8px;
  }
  .mfa-modal .mfa-close:hover { color: #333; }
  .mfa-modal .mfa-qr-container {
    text-align: center;
    margin: 16px 0;
    background: #f8f9fa;
    border-radius: 12px;
    padding: 20px;
  }
  .mfa-modal .mfa-qr-container img {
    max-width: 200px;
    border: 2px solid #dee2e6;
    border-radius: 8px;
  }
  .mfa-modal .mfa-secret-text {
    font-family: monospace;
    font-size: 13px;
    background: #f0f0f0;
    padding: 8px;
    border-radius: 6px;
    margin: 8px 0;
    word-break: break-all;
    user-select: all;
    cursor: text;
  }
  .mfa-modal .mfa-code-input {
    display: flex;
    gap: 8px;
    justify-content: center;
    margin: 16px 0;
  }
  .mfa-modal .mfa-code-input input {
    width: 44px;
    height: 52px;
    text-align: center;
    font-size: 24px;
    font-weight: 700;
    border: 2px solid #ddd;
    border-radius: 10px;
    outline: none;
    transition: border-color 0.2s;
  }
  .mfa-modal .mfa-code-input input:focus {
    border-color: #007bff;
    box-shadow: 0 0 0 3px rgba(0,123,255,0.15);
  }
  .mfa-modal .mfa-submit-btn {
    width: 100%;
    padding: 12px;
    background: #007bff;
    color: #fff;
    border: none;
    border-radius: 10px;
    font-size: 16px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
  }
  .mfa-modal .mfa-submit-btn:hover { background: #0056b3; }
  .mfa-modal .mfa-submit-btn:disabled {
    background: #ccc;
    cursor: not-allowed;
  }
  .mfa-modal .mfa-error {
    color: #dc3545;
    font-size: 13px;
    margin: 8px 0;
    display: none;
  }
  .mfa-modal .mfa-success {
    text-align: center;
    padding: 24px;
  }
  .mfa-modal .mfa-success i {
    font-size: 48px;
    color: #28a745;
    margin-bottom: 12px;
  }
  .mfa-modal .mfa-loading {
    text-align: center;
    padding: 40px;
    color: #666;
  }
  .mfa-modal .mfa-loading i { font-size: 32px; margin-bottom: 12px; }
  .mfa-modal .mfa-steps {
    display: flex;
    justify-content: center;
    gap: 8px;
    margin-bottom: 20px;
  }
  .mfa-modal .mfa-step {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: 600;
    background: #e9ecef;
    color: #999;
    transition: all 0.3s;
  }
  .mfa-modal .mfa-step.active {
    background: #007bff;
    color: #fff;
  }
  .mfa-modal .mfa-step.done {
    background: #28a745;
    color: #fff;
  }
`;

/**
 * Inyecta los estilos MFA una sola vez
 */
function injectStyles() {
  if (document.getElementById('mfa-styles')) return;
  const style = document.createElement('style');
  style.id = 'mfa-styles';
  style.textContent = MFA_STYLES;
  document.head.appendChild(style);
}

/**
 * Obtiene el cliente Supabase (desde window o import)
 */
function getClient() {
  if (window.supabaseClient) return window.supabaseClient;
  return getSupabase();
}

/**
 * Verifica si el usuario actual tiene MFA enrolado
 */
async function hasMfaEnrolled() {
  try {
    const supabase = getClient();
    if (!supabase) return false;
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) return false;
    // Si hay al menos un factor TOTP verificado, MFA está activo
    const totpFactors = data?.all || [];
    return totpFactors.some(f => f.factor_type === 'totp' && f.status === 'verified');
  } catch {
    return false;
  }
}

/**
 * Inyecta el banner de seguridad MFA en el DOM
 */
function injectBanner(mfaActive) {
  // No duplicar
  if (document.getElementById('mfa-banner')) return;

  // Buscar contenedor admin adecuado
  const target = document.querySelector('.admin-screen .sidebar') 
    || document.querySelector('.admin-screen .sidebar-footer')
    || document.querySelector('.admin-screen .sidebar-user')
    || document.querySelector('.admin-screen .sidebar-header');

  if (!target) {
    // Fallback: buscar dentro del admin-screen
    const adminScreen = document.querySelector('.admin-screen');
    if (!adminScreen) return;
    
    // Crear contenedor al inicio del contenido
    const content = document.getElementById('dynamic-content') 
      || document.querySelector('.admin-screen .main-content')
      || adminScreen.querySelector('.section-content');
    if (!content) return;
    
    const banner = document.createElement('div');
    banner.id = 'mfa-banner';
    banner.className = mfaActive ? 'mfa-banner mfa-active' : 'mfa-banner';
    banner.innerHTML = mfaActive
      ? '<i class="fas fa-shield-alt"></i> <span><strong>2FA activo</strong> — tu cuenta está protegida</span>'
      : '<i class="fas fa-exclamation-triangle"></i> <span><strong>Seguridad:</strong> configura la autenticación de dos factores (2FA) para proteger tu cuenta</span>'
        + '<button class="mfa-btn" id="mfa-setup-btn"><i class="fas fa-qrcode"></i> Configurar 2FA</button>';
    
    content.parentNode.insertBefore(banner, content);
    
    if (!mfaActive) {
      document.getElementById('mfa-setup-btn')?.addEventListener('click', openMfaModal);
    }
    return;
  }

  // Inyectar en sidebar (si existe)
  const banner = document.createElement('div');
  banner.id = 'mfa-banner';
  banner.className = mfaActive ? 'mfa-banner mfa-active' : 'mfa-banner';
  banner.innerHTML = mfaActive
    ? '<i class="fas fa-shield-alt"></i> <span>2FA activo</span>'
    : '<i class="fas fa-exclamation-triangle"></i> <span>Configurar 2FA</span>'
      + '<button class="mfa-btn" id="mfa-setup-btn"><i class="fas fa-qrcode"></i></button>';
  
  target.appendChild(banner);
  
  if (!mfaActive) {
    document.getElementById('mfa-setup-btn')?.addEventListener('click', openMfaModal);
  }
}

/**
 * Cierra el modal MFA
 */
function closeMfaModal() {
  const overlay = document.getElementById('mfa-overlay');
  if (overlay) overlay.remove();
}

/**
 * Abre el modal de configuración MFA
 */
async function openMfaModal() {
  const supabase = getClient();
  if (!supabase) return;

  // Crear overlay
  const overlay = document.createElement('div');
  overlay.id = 'mfa-overlay';
  overlay.className = 'mfa-overlay';
  overlay.innerHTML = `
    <div class="mfa-modal">
      <button class="mfa-close" id="mfa-modal-close">&times;</button>
      <div class="mfa-loading" id="mfa-loading-state">
        <i class="fas fa-spinner fa-spin"></i>
        <p>Preparando configuración 2FA...</p>
      </div>
      <div id="mfa-modal-content"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('mfa-modal-close')?.addEventListener('click', closeMfaModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeMfaModal();
  });

  // Esc para cerrar
  const escHandler = (e) => {
    if (e.key === 'Escape') { closeMfaModal(); document.removeEventListener('keydown', escHandler); }
  };
  document.addEventListener('keydown', escHandler);

  try {
    // Paso 1: Enroll
    const { data: enrollData, error: enrollError } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
    });

    if (enrollError) throw enrollError;

    const factorId = enrollData.id;
    const qrCode = enrollData.totp.qr_code;
    const secret = enrollData.totp.secret;

    // Ocultar loading, mostrar QR
    const loadingEl = document.getElementById('mfa-loading-state');
    const contentEl = document.getElementById('mfa-modal-content');
    if (loadingEl) loadingEl.style.display = 'none';

    if (contentEl) {
      contentEl.innerHTML = `
        <h2><i class="fas fa-qrcode"></i> Configurar 2FA</h2>
        <div class="mfa-steps">
          <div class="mfa-step active">1</div>
          <div class="mfa-step">2</div>
          <div class="mfa-step">3</div>
        </div>
        <p><strong>Paso 1:</strong> Escanea este código QR con tu app de autenticación (Google Authenticator, Authy, etc.)</p>
        <div class="mfa-qr-container">
          <img src="${qrCode}" alt="Código QR 2FA" id="mfa-qr-img">
        </div>
        <p style="text-align:center;margin:4px 0;font-size:13px;color:#999;">
          O ingresa manualmente esta clave secreta:
        </p>
        <div class="mfa-secret-text" id="mfa-secret">${secret}</div>
        <p style="margin-top:16px;"><strong>Paso 2:</strong> Ingresa el código de 6 dígitos de tu app para verificar</p>
        <div class="mfa-code-input" id="mfa-code-inputs">
          <input type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" class="mfa-digit" data-index="0" autofocus>
          <input type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" class="mfa-digit" data-index="1">
          <input type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" class="mfa-digit" data-index="2">
          <input type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" class="mfa-digit" data-index="3">
          <input type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" class="mfa-digit" data-index="4">
          <input type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" class="mfa-digit" data-index="5">
        </div>
        <div class="mfa-error" id="mfa-error-msg"></div>
        <button class="mfa-submit-btn" id="mfa-verify-btn" disabled>
          <i class="fas fa-shield-alt"></i> Verificar y activar
        </button>
      `;

      // Input handling: auto-advance on digit entry
      const digits = contentEl.querySelectorAll('.mfa-digit');
      digits.forEach((input, idx) => {
        input.addEventListener('input', () => {
          input.value = input.value.replace(/[^0-9]/g, '').slice(0, 1);
          if (input.value && idx < 5) {
            digits[idx + 1]?.focus();
          }
          // Enable button when all 6 digits entered
          const allFilled = Array.from(digits).every(d => d.value.length === 1);
          document.getElementById('mfa-verify-btn').disabled = !allFilled;
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Backspace' && !input.value && idx > 0) {
            digits[idx - 1]?.focus();
          }
          if (e.key === 'Enter' && idx === 5) {
            document.getElementById('mfa-verify-btn')?.click();
          }
        });
      });

      // Verify button
      document.getElementById('mfa-verify-btn')?.addEventListener('click', async () => {
        const code = Array.from(digits).map(d => d.value).join('');
        if (code.length !== 6) return;

        const verifyBtn = document.getElementById('mfa-verify-btn');
        verifyBtn.disabled = true;
        verifyBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verificando...';
        const errorMsg = document.getElementById('mfa-error-msg');

        try {
          // Paso 3: Challenge
          const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
            factorId,
          });
          if (challengeError) throw challengeError;

          // Paso 4: Verify
          const { error: verifyError } = await supabase.auth.mfa.verify({
            factorId,
            challengeId: challengeData.id,
            code,
          });
          if (verifyError) throw verifyError;

          // Éxito
          contentEl.innerHTML = `
            <div class="mfa-success">
              <i class="fas fa-check-circle"></i>
              <h2>¡2FA activado!</h2>
              <p>Tu cuenta ahora está protegida con autenticación de dos factores.</p>
              <p style="font-size:13px;color:#999;">La próxima vez que inicies sesión, se te pedirá un código adicional.</p>
              <button class="mfa-submit-btn" id="mfa-close-success" style="margin-top:16px;max-width:200px;">
                <i class="fas fa-check"></i> Listo
              </button>
            </div>
          `;
          document.getElementById('mfa-close-success')?.addEventListener('click', () => {
            closeMfaModal();
            // Actualizar banner
            const banner = document.getElementById('mfa-banner');
            if (banner) {
              banner.className = 'mfa-banner mfa-active';
              banner.innerHTML = '<i class="fas fa-shield-alt"></i> <span><strong>2FA activo</strong> — tu cuenta está protegida</span>';
            }
          });

          // Auto-cerrar después de 3 segundos
          setTimeout(() => {
            closeMfaModal();
            const banner = document.getElementById('mfa-banner');
            if (banner) {
              banner.className = 'mfa-banner mfa-active';
              banner.innerHTML = '<i class="fas fa-shield-alt"></i> <span><strong>2FA activo</strong> — tu cuenta está protegida</span>';
            }
          }, 4000);

        } catch (err) {
          if (errorMsg) {
            errorMsg.textContent = err.message || 'Código inválido. Intenta nuevamente.';
            errorMsg.style.display = 'block';
          }
          verifyBtn.disabled = false;
          verifyBtn.innerHTML = '<i class="fas fa-shield-alt"></i> Verificar y activar';
          // Limpiar inputs
          digits.forEach(d => { d.value = ''; });
          (digits[0]).focus();
        }
      });
    }
  } catch (err) {
    const loadingEl = document.getElementById('mfa-loading-state');
    const contentEl = document.getElementById('mfa-modal-content');
    if (loadingEl) loadingEl.style.display = 'none';
    if (contentEl) {
      contentEl.innerHTML = `
        <div style="text-align:center;padding:24px;">
          <i class="fas fa-exclamation-triangle" style="font-size:48px;color:#dc3545;margin-bottom:12px;"></i>
          <h2 style="color:#333;">Error al configurar 2FA</h2>
          <p style="color:#666;">${err.message || 'No se pudo iniciar la configuración. Intenta nuevamente.'}</p>
          <button class="mfa-submit-btn" id="mfa-retry-btn" style="max-width:200px;margin:16px auto 0;">
            <i class="fas fa-redo"></i> Reintentar
          </button>
        </div>
      `;
      document.getElementById('mfa-retry-btn')?.addEventListener('click', () => {
        closeMfaModal();
        setTimeout(openMfaModal, 300);
      });
    }
  }
}

/**
 * Inicializa el sistema MFA
 * - Inyecta estilos
 * - Verifica estado actual
 * - Muestra banner según corresponda
 */
export async function initMfaSetup() {
  // Solo en páginas de admin autenticado
  const esAdmin = document.querySelector('.admin-screen') && !document.querySelector('.superadmin-screen');
  if (!esAdmin) return;

  injectStyles();

  try {
    const mfaActive = await hasMfaEnrolled();
    injectBanner(mfaActive);
    console.log(`[MFA] Estado: ${mfaActive ? '✅ activo' : '⚠️ no configurado'}`);
  } catch (e) {
    // Silencioso — MFA es opcional, no debe romper nada
    console.warn('[MFA] Error verificando estado:', e);
  }
}
