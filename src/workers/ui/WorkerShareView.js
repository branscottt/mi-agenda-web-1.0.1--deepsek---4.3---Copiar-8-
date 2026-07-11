// src/workers/ui/WorkerShareView.js
// Compartir links individuales con trabajadores

import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { getAllTrabajadores, getWorkerPortalUrl } from '../application/WorkersService.js';
import { getCurrentTenantId } from '../../shared/infrastructure/router.js';

export async function renderWorkerShare(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = '<div class="loading-spinner"><i class="fas fa-spinner fa-spin"></i> Cargando...</div>';

    const workers = await getAllTrabajadores();
    const tenantId = await getCurrentTenantId();
    const activos = workers.filter(w => w.activo);

    if (!activos.length) {
        container.innerHTML = `
            <div class="glass-panel">
                <div class="empty-state">
                    <i class="fas fa-user-slash" style="font-size:2rem;opacity:0.3;"></i>
                    <p style="margin-top:10px;">No hay trabajadores activos para compartir.</p>
                    <p class="field-hint">Agrega trabajadores en la sección <strong>Mi Equipo</strong> primero.</p>
                </div>
            </div>
        `;
        return;
    }

    let html = `
        <div class="glass-panel">
            <h3><i class="fas fa-share-alt"></i> Compartir con Trabajadores</h3>
            <div class="step-guide" style="margin-bottom:16px;">
                <i class="fas fa-info-circle"></i>
                <span>Cada trabajador tiene su propio enlace. Puedes copiarlo o enviarlo por WhatsApp. Al abrirlo, verán su horario y las reservas que tienen asignadas.</span>
            </div>
            <div class="workers-share-list">
                ${activos.map(w => {
                    const link = getWorkerPortalUrl(tenantId, w.id);
                    return `
                        <div class="worker-share-card">
                            <div class="worker-share-avatar" style="background:${w.color || '#9d4edd'}">
                                <span>${w.nombre.charAt(0).toUpperCase()}</span>
                            </div>
                            <div class="worker-share-info">
                                <h4>${escapeHtml(w.nombre)}</h4>
                                ${w.habilidades ? `<p class="worker-skills">${escapeHtml(w.habilidades)}</p>` : ''}
                            </div>
                            <div class="worker-share-links">
                                <input type="text" class="worker-share-input" value="${escapeAttr(link)}" readonly>
                                <button class="btn-secondary btn-sm" onclick="window.__copiarLinkTrabajador(this, '${escapeAttr(link)}')" title="Copiar enlace">
                                    <i class="fas fa-copy"></i>
                                </button>
                                <button class="btn-secondary btn-sm" onclick="window.__whatsappTrabajador('${escapeAttr(link)}', '${escapeAttr(w.nombre)}')" title="Enviar por WhatsApp">
                                    <i class="fab fa-whatsapp"></i>
                                </button>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;

    container.innerHTML = html;
}

export function exposeShareGlobals() {
    window.__copiarLinkTrabajador = async (btn, link) => {
        try {
            await navigator.clipboard.writeText(link);
            btn.classList.add('copied');
            btn.innerHTML = '<i class="fas fa-check"></i>';
            setTimeout(() => {
                btn.classList.remove('copied');
                btn.innerHTML = '<i class="fas fa-copy"></i>';
            }, 2000);
        } catch {
            mostrarToast('Enlace copiado al portapapeles', 'success');
        }
    };

    window.__whatsappTrabajador = (link, nombre) => {
        const message = `📋 *Hola ${nombre}!* 👋\\n\\nAquí tienes tu enlace personal para ver tu horario y reservas:\\n${link}\\n\\n*Importante:* Este enlace es solo para ti. No lo compartas con otras personas.`;
        const waUrl = `https://wa.me/?text=${encodeURIComponent(message)}`;
        window.open(waUrl, '_blank');
    };
}

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str) {
    if (!str) return '';
    return String(str).replace(/"/g, '&quot;');
}
