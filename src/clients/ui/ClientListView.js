// clients/ui/ClientListView.js
// Gesti├│n de clientes del tenant: lista, b├║squeda, historial, contacto, exportaci├│n

import { getAllCitas } from '../../appointments/application/AppointmentService.js';
import { formatearDinero, formatFechaCorta, formatTimeDisplay } from '../../shared/infrastructure/formatters.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';

// ========== DATOS ==========

function deduplicarClientes(citas) {
    const mapa = new Map();
    citas.forEach(c => {
        const email = (c.contacto?.email || '').toLowerCase().trim();
        if (!email) return;
        if (!mapa.has(email)) {
            mapa.set(email, {
                email,
                nombre: c.contacto?.nombre || 'Sin nombre',
                telefono: c.contacto?.telefono || '',
                totalGastado: 0,
                visitas: 0,
                primeraVisita: c.fecha,
                ultimaVisita: c.fecha,
                citas: []
            });
        }
        const cl = mapa.get(email);
        cl.visitas++;
        cl.totalGastado += Number(c.precio) || 0;
        if (c.fecha < cl.primeraVisita) cl.primeraVisita = c.fecha;
        if (c.fecha > cl.ultimaVisita) cl.ultimaVisita = c.fecha;
        cl.citas.push(c);
    });
    return Array.from(mapa.values()).sort((a, b) => b.ultimaVisita.localeCompare(a.ultimaVisita));
}

// ========== RENDER ==========

let clientesCache = [];
let filtroActual = '';

export async function renderClientListView(containerId = 'clientes-list-container') {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = '<div class="loading-spinner"><i class="fas fa-spinner fa-spin"></i><p>Cargando clientes...</p></div>';

    try {
        const citas = await getAllCitas();
        clientesCache = deduplicarClientes(citas);
        renderLista(container);
    } catch (e) {
        console.error('[ClientListView] Error cargando clientes:', e);
        container.innerHTML = '<p class="empty-state"><i class="fas fa-exclamation-triangle"></i> Error al cargar clientes</p>';
    }
}

function renderLista(container) {
    const filtrados = clientesCache.filter(cl => {
        if (!filtroActual) return true;
        const q = filtroActual.toLowerCase();
        return cl.nombre.toLowerCase().includes(q)
            || cl.email.toLowerCase().includes(q)
            || cl.telefono.includes(q);
    });

    if (!clientesCache.length) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-users"></i>
                <h4>No hay clientes registrados</h4>
                <p>Aún no tienes citas agendadas. Cuando los clientes reserven servicios, aparecerán aquí.</p>
            </div>
        `;
        return;
    }

    let html = `
        <div class="clientes-header-actions" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:16px;">
            <div class="search-box" style="flex:1;min-width:200px;">
                <i class="fas fa-search"></i>
                <input type="text" id="clientes-search-input" placeholder="Buscar por nombre, email o teléfono..." value="${escapeHtml(filtroActual)}">
            </div>
            <button class="btn-secondary btn-small" id="export-clientes-csv" title="Exportar todos los clientes a CSV">
                <i class="fas fa-download"></i> Exportar CSV
            </button>
            <span style="color:var(--text-muted);font-size:0.85rem;">
                <i class="fas fa-users"></i> ${clientesCache.length} cliente${clientesCache.length !== 1 ? 's' : ''}
                ${filtroActual ? `(mostrando ${filtrados.length})` : ''}
            </span>
        </div>
        <div class="clientes-grid" id="clientes-grid">
    `;

    filtrados.forEach(cl => {
        const proxCita = cl.citas
            .filter(c => c.fecha >= new Date().toISOString().split('T')[0])
            .sort((a, b) => a.fecha.localeCompare(b.fecha))[0];

        html += `
            <div class="cliente-card glass-panel">
                <div class="cliente-card-header">
                    <div class="cliente-avatar">
                        <i class="fas fa-user-circle"></i>
                    </div>
                    <div class="cliente-info">
                        <strong>${escapeHtml(cl.nombre)}</strong>
                        <span class="cliente-email" style="font-size:0.8rem;color:var(--text-muted);">
                            ${escapeHtml(cl.email)}
                        </span>
                    </div>
                    <div class="cliente-stats-mini">
                        <span class="stat-chip" title="Total gastado">
                            <i class="fas fa-dollar-sign"></i> ${formatearDinero(cl.totalGastado)}
                        </span>
                        <span class="stat-chip" title="Visitas">
                            <i class="fas fa-calendar-check"></i> ${cl.visitas}
                        </span>
                    </div>
                </div>
                <div class="cliente-card-body">
                    <div class="cliente-meta">
                        ${cl.telefono ? `<span><i class="fas fa-phone"></i> ${escapeHtml(cl.telefono)}</span>` : ''}
                        <span><i class="fas fa-clock"></i> Última: ${formatFechaCorta(cl.ultimaVisita)}</span>
                        ${proxCita ? `<span class="proxima-cita"><i class="fas fa-calendar-alt"></i> Próxima: ${formatFechaCorta(proxCita.fecha)} ${formatTimeDisplay(proxCita.hora)}</span>` : ''}
                    </div>
                    <div class="cliente-actions-row">
                        ${cl.telefono ? `<a href="https://wa.me/${cl.telefono.replace(/[^0-9]/g, '')}" target="_blank" class="btn-small" style="background:#25D366;color:#fff;" title="Enviar WhatsApp"><i class="fab fa-whatsapp"></i></a>` : ''}
                        ${cl.email ? `<a href="mailto:${encodeURIComponent(cl.email)}" class="btn-small" style="background:var(--primary-color);color:#fff;" title="Enviar Email"><i class="fas fa-envelope"></i></a>` : ''}
                        ${cl.telefono ? `<a href="tel:${escapeHtml(cl.telefono)}" class="btn-small" style="background:var(--secondary-color);color:#fff;" title="Llamar"><i class="fas fa-phone"></i></a>` : ''}
                        <button class="btn-small btn-ver-historial" data-email="${escapeHtml(cl.email)}" style="margin-left:auto;">
                            <i class="fas fa-history"></i> Historial
                        </button>
                    </div>
                </div>
                <div class="cliente-historial" id="historial-${escapeHtml(cl.email).replace(/[@.]/g, '-')}" style="display:none;"></div>
            </div>
        `;
    });

    html += '</div>';
    container.innerHTML = html;

    // ── Search handler (con debounce 300ms) ──
    const searchInput = document.getElementById('clientes-search-input');
    if (searchInput) {
        let debounceTimer;
        searchInput.addEventListener('input', (e) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                filtroActual = e.target.value;
                renderLista(container);
            }, 300);
        });
    }

    // ── Historial toggle ──
    container.querySelectorAll('.btn-ver-historial').forEach(btn => {
        btn.addEventListener('click', () => {
            const email = btn.dataset.email;
            const historialId = `historial-${email.replace(/[@.]/g, '-')}`;
            const historialEl = document.getElementById(historialId);
            if (!historialEl) return;

            if (historialEl.style.display === 'block') {
                historialEl.style.display = 'none';
                btn.innerHTML = '<i class="fas fa-history"></i> Historial';
                return;
            }

            const cliente = clientesCache.find(c => c.email.toLowerCase() === email.toLowerCase());
            if (!cliente) return;

            btn.innerHTML = '<i class="fas fa-chevron-up"></i> Ocultar';
            historialEl.style.display = 'block';
            renderHistorial(historialEl, cliente);
        });
    });

    // ── Export CSV ──
    const exportBtn = document.getElementById('export-clientes-csv');
    if (exportBtn) {
        exportBtn.addEventListener('click', exportarClientesCSV);
    }
}

function renderHistorial(container, cliente) {
    const citas = [...cliente.citas].sort((a, b) => b.fecha.localeCompare(a.fecha) || b.hora.localeCompare(a.hora));

    if (!citas.length) {
        container.innerHTML = '<p class="muted" style="text-align:center;padding:10px;">Sin historial de citas</p>';
        return;
    }

    let html = `
        <div class="historial-header" style="display:flex;justify-content:space-between;padding:8px 12px;background:rgba(255,255,255,0.03);border-radius:8px 8px 0 0;font-weight:600;font-size:0.85rem;color:var(--text-muted);">
            <span style="flex:1;">Servicio</span>
            <span style="width:100px;text-align:center;">Fecha</span>
            <span style="width:80px;text-align:center;">Hora</span>
            <span style="width:90px;text-align:right;">Precio</span>
        </div>
    `;

    citas.forEach(c => {
        const esPasada = new Date(c.fecha + 'T' + (c.hora || '12:00')) < new Date();
        html += `
            <div class="historial-row ${esPasada ? 'past' : 'future'}" style="display:flex;align-items:center;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.05);font-size:0.85rem;">
                <span style="flex:1;">${escapeHtml(c.nombre || 'Servicio')}</span>
                <span style="width:100px;text-align:center;">${formatFechaCorta(c.fecha)}</span>
                <span style="width:80px;text-align:center;">${formatTimeDisplay(c.hora)}</span>
                <span style="width:90px;text-align:right;font-weight:600;">${formatearDinero(c.precio)}</span>
            </div>
        `;
    });

    html += `
        <div class="historial-footer" style="display:flex;justify-content:space-between;padding:10px 12px;font-size:0.9rem;border-top:1px solid rgba(255,255,255,0.1);">
            <span><strong>Total visitas:</strong> ${citas.length}</span>
            <span><strong>Total gastado:</strong> ${formatearDinero(cliente.totalGastado)}</span>
            <span><strong>Ticket promedio:</strong> ${formatearDinero(cliente.totalGastado / citas.length)}</span>
        </div>
    `;

    container.innerHTML = html;
}

// ========== EXPORT CSV ==========

function exportarClientesCSV() {
    if (!clientesCache.length) {
        mostrarToast('No hay clientes para exportar', 'warning');
        return;
    }

    // BOM para Excel con acentos
    let csv = '\uFEFF';
    csv += 'Nombre,Email,Teléfono,Visitas,Total Gastado,Última Visita,Primera Visita\n';

    clientesCache.forEach(cl => {
        const nombre = `"${(cl.nombre || '').replace(/"/g, '""')}"`;
        const email = `"${(cl.email || '').replace(/"/g, '""')}"`;
        const telefono = `"${(cl.telefono || '').replace(/"/g, '""')}"`;
        csv += `${nombre},${email},${telefono},${cl.visitas},${cl.totalGastado},${cl.ultimaVisita},${cl.primeraVisita}\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `clientes_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    mostrarToast(`Exportados ${clientesCache.length} clientes`, 'success');
}

// ========== HELPERS ==========

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
