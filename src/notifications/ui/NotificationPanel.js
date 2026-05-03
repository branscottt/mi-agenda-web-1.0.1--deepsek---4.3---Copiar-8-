// notifications/ui/NotificationPanel.js
// Panel de notificaciones para admin.html
// Badge de no leidas + dropdown con lista

import { getNotificaciones, suscribirseNotificaciones, marcarComoLeida, marcarTodasLeidas, getNotificacionesNoLeidas, iniciarPolling } from '../application/NotificationService.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';

let _notificaciones = [];
let _panelAbierto = false;

export function initNotificationPanel(containerId = 'notification-panel-container') {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Crear estructura
    container.innerHTML = `
        <div class="notification-panel">
            <button id="notif-bell-btn" class="notif-bell">
                <i class="fas fa-bell"></i>
                <span id="notif-badge" class="notif-badge" style="display:none">0</span>
            </button>
            <div id="notif-dropdown" class="notif-dropdown" style="display:none">
                <div class="notif-dropdown-header">
                    <h4>Notificaciones</h4>
                    <button id="notif-mark-all-btn" class="btn-text-small">Marcar todas leidas</button>
                </div>
                <div id="notif-list" class="notif-list">
                    <p class="notif-empty">Sin notificaciones</p>
                </div>
            </div>
        </div>
    `;

    // Toggle dropdown
    document.getElementById('notif-bell-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        togglePanel();
    });

    // Marcar todas leidas
    document.getElementById('notif-mark-all-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        await marcarTodasLeidas();
        _notificaciones.forEach(n => n.leida = true);
        actualizarUI();
        mostrarToast('Notificaciones marcadas como leidas', 'info');
    });

    // Cerrar al hacer click fuera
    document.addEventListener('click', (e) => {
        if (_panelAbierto && !container.contains(e.target)) {
            cerrarPanel();
        }
    });

    // Cargar inicial
    cargarNotificaciones();

    // Suscribirse a nuevas
    suscribirseNotificaciones((nuevas) => {
        _notificaciones = [...nuevas, ..._notificaciones];
        actualizarUI();
        if (!_panelAbierto && nuevas.some(n => !n.leida)) {
            // Cambiar icono para llamar atencion
            document.getElementById('notif-bell-btn').querySelector('i').className = 'fas fa-bell fa-ring';
            setTimeout(() => {
                document.getElementById('notif-bell-btn').querySelector('i').className = 'fas fa-bell';
            }, 2000);
        }
    });

    // Iniciar polling
    iniciarPolling();
}

async function cargarNotificaciones() {
    const notifs = await getNotificaciones();
    _notificaciones = notifs;
    actualizarUI();
}

function togglePanel() {
    if (_panelAbierto) {
        cerrarPanel();
    } else {
        abrirPanel();
    }
}

function abrirPanel() {
    _panelAbierto = true;
    const dropdown = document.getElementById('notif-dropdown');
    if (dropdown) dropdown.style.display = 'block';
    renderList();
}

function cerrarPanel() {
    _panelAbierto = false;
    const dropdown = document.getElementById('notif-dropdown');
    if (dropdown) dropdown.style.display = 'none';
}

function actualizarUI() {
    const noLeidas = getNotificacionesNoLeidas(_notificaciones);
    const badge = document.getElementById('notif-badge');
    if (badge) {
        if (noLeidas.length > 0) {
            badge.style.display = 'inline';
            badge.textContent = noLeidas.length > 99 ? '99+' : noLeidas.length;
        } else {
            badge.style.display = 'none';
        }
    }
}

function renderList() {
    const list = document.getElementById('notif-list');
    if (!list) return;

    if (!_notificaciones.length) {
        list.innerHTML = '<p class="notif-empty">Sin notificaciones</p>';
        return;
    }

    list.innerHTML = _notificaciones.map(n => `
        <div class="notif-item ${n.leida ? '' : 'notif-unread'}" data-id="${n.id}">
            <div class="notif-icon notif-${n.tipo}">
                <i class="fas fa-${iconoTipo(n.tipo)}"></i>
            </div>
            <div class="notif-content">
                <strong>${escapeHtml(n.titulo)}</strong>
                <p>${escapeHtml(n.mensaje)}</p>
                <small>${tiempoRelativo(n.creadoEn)}</small>
            </div>
            ${!n.leida ? `<button class="notif-mark-read" data-id="${n.id}"><i class="fas fa-check"></i></button>` : ''}
        </div>
    `).join('');

    list.querySelectorAll('.notif-mark-read').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            await marcarComoLeida(id);
            const notif = _notificaciones.find(n => n.id === id);
            if (notif) notif.leida = true;
            actualizarUI();
            renderList();
        });
    });

    list.querySelectorAll('.notif-item').forEach(item => {
        item.addEventListener('click', () => {
            const id = item.dataset.id;
            const notif = _notificaciones.find(n => n.id === id);
            if (notif && notif.accion) {
                manejarAccion(notif.accion);
            }
        });
    });
}

function iconoTipo(tipo) {
    const mapa = {
        success: 'check-circle',
        warning: 'exclamation-triangle',
        error: 'times-circle',
        info: 'info-circle',
        recordatorio: 'clock',
        nueva_cita: 'calendar-plus'
    };
    return mapa[tipo] || 'bell';
}

function tiempoRelativo(fechaStr) {
    if (!fechaStr) return '';
    try {
        const ahora = new Date();
        const fecha = new Date(fechaStr);
        const diffMs = ahora - fecha;
        const diffMin = Math.floor(diffMs / 60000);
        if (diffMin < 1) return 'Ahora';
        if (diffMin < 60) return `Hace ${diffMin} min`;
        const diffHoras = Math.floor(diffMin / 60);
        if (diffHoras < 24) return `Hace ${diffHoras}h`;
        const diffDias = Math.floor(diffHoras / 24);
        return `Hace ${diffDias}d`;
    } catch (e) {
        return fechaStr;
    }
}

function manejarAccion(accion) {
    cerrarPanel();
    if (accion === 'ver_cita') {
        const tab = document.querySelector('[data-tab="appointments"]');
        if (tab) tab.click();
    }
}

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function cleanup() {
    detenerPolling();
}