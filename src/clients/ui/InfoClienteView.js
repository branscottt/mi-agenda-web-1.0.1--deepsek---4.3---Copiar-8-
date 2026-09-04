// clients/ui/InfoClienteView.js
// Vista pública "lo que ve el cliente" (info-cliente.html?t=TOKEN).
// Sin login: el token del board (kanban_boards.token_compartido) autoriza
// leer SOLO las listas con compartida=true vía la RPC SECURITY DEFINER
// get_cliente_info_compartida (el anon jamás toca tablas, mismo patrón
// que get_worker_portal_data). Render read-only, apto móvil.
import { getSupabase } from '../../shared/infrastructure/supabase.js';

export async function initInfoCliente() {
    const params = new URLSearchParams(window.location.search);
    const token = (params.get('t') || '').trim();

    const inicialEl = document.getElementById('ic-inicial');
    const negocioEl = document.getElementById('ic-negocio');
    const contenidoEl = document.getElementById('ic-contenido');

    if (!token) {
        mostrarEstado(contenidoEl, 'error', 'fa-link-slash', 'Enlace inválido', 'Este enlace no es válido o está incompleto.');
        if (negocioEl) negocioEl.textContent = 'Enlace inválido';
        return;
    }

    const supabase = getSupabase();
    if (!supabase) {
        mostrarEstado(contenidoEl, 'error', 'fa-plug', 'Error de conexión', 'No se pudo conectar. Intentá de nuevo en unos minutos.');
        return;
    }

    try {
        const { data, error } = await supabase.rpc('get_cliente_info_compartida', { p_token: token });
        if (error) throw error;
        if (!data || data.error === 'not_found') {
            mostrarEstado(contenidoEl, 'error', 'fa-lock', 'Enlace no válido', 'Este enlace no corresponde a información compartida o fue desactivado por quien te lo envió.');
            if (negocioEl) negocioEl.textContent = 'Información no disponible';
            return;
        }

        const negocio = data.tenant_nombre || 'Mi negocio';
        if (negocioEl) negocioEl.textContent = negocio;
        if (inicialEl) inicialEl.textContent = (negocio.trim().charAt(0) || '—').toUpperCase();

        renderContenido(contenidoEl, data);
    } catch (e) {
        console.error('[InfoCliente] Error cargando información compartida:', e);
        mostrarEstado(contenidoEl, 'error', 'fa-exclamation-triangle', 'No se pudo cargar', 'Ocurrió un error al cargar la información. Vuelve a intentarlo.');
    }
}

function renderContenido(contenidoEl, data) {
    const listas = Array.isArray(data.listas) ? data.listas : [];

    if (!listas.length) {
        mostrarEstado(
            contenidoEl,
            'vacio',
            'fa-eye-slash',
            'Todavía no hay información compartida',
            'Quien te envió este enlace todavía no compartió listas contigo. Vuelve a ingresar más tarde.'
        );
        return;
    }

    const nombreCliente = (data.cliente_nombre && data.cliente_nombre !== 'Sin nombre') ? data.cliente_nombre : null;
    const totalTarjetas = listas.reduce((acc, l) => acc + (l.cards || []).length, 0);

    let html = '';
    if (nombreCliente) {
        const nombreCorto = String(nombreCliente).split(' ')[0];
        html += `<p class="ic-saludo">Hola ${escapeHtml(nombreCorto)}! 👋 Te compartieron ${totalTarjetas} tarjeta${totalTarjetas !== 1 ? 's' : ''} en ${listas.length} sección${listas.length !== 1 ? 'es' : ''}:</p>`;
    } else {
        html += `<p class="ic-saludo">Te compartieron ${totalTarjetas} tarjeta${totalTarjetas !== 1 ? 's' : ''} en ${listas.length} sección${listas.length !== 1 ? 'es' : ''}:</p>`;
    }

    html += listas.map(lista => {
        const cards = Array.isArray(lista.cards) ? lista.cards : [];
        const cardsHtml = cards.map(card => renderTarjeta(card)).join('');
        return `
            <section class="ic-lista">
                <header class="ic-lista-header">
                    <i class="fas fa-eye"></i>
                    <h3 class="ic-lista-titulo">${escapeHtml(lista.titulo || 'Lista')}</h3>
                    <span style="margin-left:auto;font-size:0.75rem;color:rgba(255,255,255,0.45);">${cards.length} tarjeta${cards.length !== 1 ? 's' : ''}</span>
                </header>
                ${cardsHtml || '<p style="padding:14px 16px;font-size:0.83rem;color:rgba(255,255,255,0.5);">Sin tarjetas por ahora.</p>'}
            </section>
        `;
    }).join('');

    html += `
        <div class="ic-actualizar">
            <button type="button" class="btn-primary btn-small" id="ic-recargar" title="Actualizar la información"><i class="fas fa-sync-alt"></i> Actualizar</button>
        </div>
    `;

    contenidoEl.innerHTML = html;
    const recargar = document.getElementById('ic-recargar');
    if (recargar) recargar.addEventListener('click', () => window.location.reload());
}

function renderTarjeta(card) {
    const checklists = Array.isArray(card.checklists) ? card.checklists : [];
    const checklistsHtml = checklists.map(ch => {
        const items = Array.isArray(ch.items) ? ch.items : [];
        const hechos = items.filter(i => i.completado).length;
        return `
            <div class="ic-checklist">
                <p class="ic-checklist-titulo">
                    <span>${escapeHtml(ch.titulo || 'Checklist')}</span>
                    <span class="ic-checklist-progreso">${hechos}/${items.length}</span>
                </p>
                ${items.map(it => `
                    <div class="ic-item ${it.completado ? 'hecho' : ''}">
                        <i class="${it.completado ? 'fas fa-check-circle' : 'far fa-circle'}"></i>
                        <span>${escapeHtml(it.texto)}</span>
                    </div>
                `).join('')}
            </div>
        `;
    }).join('');

    return `
        <div class="ic-tarjeta ${card.completado ? 'done' : ''}">
            <p class="ic-tarjeta-titulo">
                ${card.completado ? '<i class="fas fa-check-circle"></i>' : ''}
                <span class="ic-tarjeta-titulo-text">${escapeHtml(card.titulo || 'Tarjeta')}</span>
            </p>
            ${card.descripcion ? `<p class="ic-tarjeta-descripcion">${escapeHtml(card.descripcion)}</p>` : ''}
            ${checklistsHtml}
        </div>
    `;
}

function mostrarEstado(contenidoEl, tipo, icono, titulo, detalle) {
    if (!contenidoEl) return;
    contenidoEl.innerHTML = `
        <div class="ic-${tipo}">
            <i class="fas ${icono}"></i>
            <h4 style="margin:0 0 6px;color:rgba(255,255,255,0.85);">${escapeHtml(titulo)}</h4>
            <p style="margin:0 auto;max-width:420px;">${escapeHtml(detalle)}</p>
        </div>
    `;
}

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
