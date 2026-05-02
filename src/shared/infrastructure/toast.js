// shared/infrastructure/toast.js
// Sistema de notificaciones toast para toda la app

const TOAST_CONTAINER_ID = 'hermes-toast-container';

function ensureContainer() {
    let container = document.getElementById(TOAST_CONTAINER_ID);
    if (!container) {
        container = document.createElement('div');
        container.id = TOAST_CONTAINER_ID;
        container.style.cssText = 'position:fixed;top:20px;right:20px;z-index:99999;display:flex;flex-direction:column;gap:8px;max-width:400px;';
        document.body.appendChild(container);
    }
    return container;
}

export function mostrarToast(mensaje, tipo = 'info') {
    const container = ensureContainer();
    const toast = document.createElement('div');
    
    const colors = {
        info: 'rgba(0,123,255,0.9)',
        success: 'rgba(0,184,148,0.9)',
        error: 'rgba(231,76,60,0.9)',
        warning: 'rgba(253,203,110,0.9)'
    };
    
    toast.style.cssText = `
        background: ${colors[tipo] || colors.info};
        color: #fff; padding: 14px 20px; border-radius: 12px;
        backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1);
        box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        animation: slideIn 0.3s ease;
        font-size: 14px; line-height: 1.4;
        word-break: break-word;
    `;
    toast.textContent = mensaje;
    
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// Compatibilidad hacia atras
window.mostrarToast = mostrarToast;
window.mostrarMensaje = function(mensaje, tipo = 'info') { return mostrarToast(mensaje, tipo); };