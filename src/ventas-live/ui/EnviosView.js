// ventas-live/ui/EnviosView.js
// Lista de tareas de envíos y entregas (spec §21-23): grupos
// HOY / MAÑANA / PRÓXIMOS / PRESENCIALES / EN PROCESO con los datos
// del cliente listos para copiar y acceso a la página de la empresa.

import { vlApi } from '../domain/vlApi.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { escapeHtml } from '../../shared/infrastructure/formatters.js';
import { modalCrearEnvio, modalMarcarEntregado } from './accionesProceso.js';

const EMPRESA_SITIOS = {
    blue_express: 'https://www.bluex.cl',
    paket: 'https://www.paketexpress.cl',
    chilexpress: 'https://www.chilexpress.cl',
    starken: 'https://www.starken.cl'
};

const EMPRESA_LABEL = {
    blue_express: 'Blue Express', paket: 'Paket', chilexpress: 'Chilexpress',
    starken: 'Starken', otra: 'Otra'
};

const GRUPOS = [
    { g: 'hoy', titulo: '📅 HOY', color: '#ffa94d' },
    { g: 'manana', titulo: '📅 MAÑANA', color: '#74c0fc' },
    { g: 'proximos', titulo: '📅 PRÓXIMOS', color: '#adb5bd' },
    { g: 'presenciales', titulo: '🤝 ENTREGAS PRESENCIALES', color: '#e599f7' },
    { g: 'en_proceso', titulo: '🚚 ENVÍOS EN PROCESO', color: '#9775fa' }
];

let _built = false;

function $(id) { return document.getElementById(id); }

export function initEnvios() {
    const cont = $('vl-view-envios');
    if (!_built) {
        cont.innerHTML = `<div id="ve-contenido"></div>`;
        _built = true;
    }
    refrescarEnvios();
}

async function refrescarEnvios() {
    const cont = $('ve-contenido');
    const res = await vlApi.enviosPendientes();
    if (!res.ok) {
        cont.innerHTML = '<div class="vl-empty">No se pudo cargar: ' + escapeHtml(res.error || 'error') + '</div>';
        return;
    }
    const grupos = res.data.grupos || {};
    const total = Object.values(grupos).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);

    if (!total) {
        cont.innerHTML = '<div class="vl-empty" style="padding:50px;">Sin tareas de envío ni entregas pendientes 🎉</div>';
        return;
    }

    cont.innerHTML = GRUPOS.map(gr => {
        const filas = grupos[gr.g] || [];
        if (!filas.length) return '';
        return `
            <div class="vl-grupo-titulo"><span>${gr.titulo}</span><span class="cnt" style="color:${gr.color};">${filas.length}</span></div>
            <div data-grupo="${gr.g}">${filas.map(filaHTML).join('')}</div>`;
    }).join('');

    GRUPOS.forEach(gr => {
        const bloque = cont.querySelector(`[data-grupo="${gr.g}"]`);
        if (!bloque) return;
        (grupos[gr.g] || []).forEach((f, i) => {
            const row = bloque.querySelectorAll('.vl-fila')[i];
            if (row) bindFila(row, f);
        });
    });
}

function filaHTML(f) {
    const c = f.cliente || {};
    const empresa = f.empresa ? (EMPRESA_LABEL[f.empresa] || f.empresa) : 'por definir';
    const direccionCompleta = [c.nombre_real || ('@' + c.tiktok_user), c.whatsapp, c.direccion, c.comuna, c.ciudad]
        .filter(Boolean).join(', ');
    return `
        <div class="vl-fila" data-proceso="${f.proceso_id}">
            <div style="min-width:180px;">
                <div class="f-nick">@${escapeHtml(c.tiktok_user)}</div>
                <div class="f-sub">
                    ${escapeHtml(c.nombre_real || '')} ${c.whatsapp ? '· ' + escapeHtml(c.whatsapp) : ''}
                </div>
                <div class="f-sub">
                    ${[c.direccion, c.comuna, c.ciudad].filter(Boolean).map(escapeHtml).join(' · ') || 'sin dirección registrada'}
                </div>
            </div>
            <div class="f-der">
                <div class="f-datos">
                    <span>${f.tipo === 'presencial' ? '🤝 Presencial' : '🚚 ' + escapeHtml(empresa)}</span>
                    ${f.tracking ? '<span>#' + escapeHtml(f.tracking) + '</span>' : ''}
                    ${f.fecha_programada ? '<span>📅 ' + escapeHtml(f.fecha_programada) + '</span>' : ''}
                </div>
                <div class="vl-datos-copy">
                    <button class="vl-btn" data-copiar="${encodeURIComponent('@' + c.tiktok_user + (c.nombre_real ? ' ' + c.nombre_real : ''))}" type="button"><i class="fas fa-copy"></i> Nombre</button>
                    <button class="vl-btn" data-copiar="${encodeURIComponent(c.whatsapp || '')}" type="button"><i class="fas fa-copy"></i> Teléfono</button>
                    <button class="vl-btn" data-copiar="${encodeURIComponent(direccionCompleta)}" type="button"><i class="fas fa-copy"></i> Copiar dirección</button>
                    ${f.empresa && EMPRESA_SITIOS[f.empresa]
                        ? `<button class="vl-btn" data-abrir="${EMPRESA_SITIOS[f.empresa]}" type="button"><i class="fas fa-external-link-alt"></i> ${escapeHtml(EMPRESA_LABEL[f.empresa])}</button>`
                        : ''}
                    ${accionHTML(f)}
                </div>
            </div>
        </div>`;
}

function accionHTML(f) {
    if (f.envio_estado === 'pendiente' || f.envio_estado === 'programado') {
        const label = f.tipo === 'presencial' ? 'Marcar entregado' : 'ENVÍO CREADO';
        const acc = f.tipo === 'presencial' ? 'entregado' : 'crear-envio';
        return `<button class="vl-btn success" data-acc="${acc}" type="button"><i class="fas ${f.tipo === 'presencial' ? 'fa-check-circle' : 'fa-truck-fast'}"></i> ${label}</button>`;
    }
    if (f.envio_estado === 'en_proceso') {
        return `<button class="vl-btn success" data-acc="entregado" type="button"><i class="fas fa-check-circle"></i> Marcar entregado</button>`;
    }
    return '';
}

function bindFila(row, f) {
    row.querySelectorAll('button[data-copiar]').forEach(btn => {
        btn.addEventListener('click', () => copiar(btn.dataset.copiar));
    });
    row.querySelectorAll('button[data-abrir]').forEach(btn => {
        btn.addEventListener('click', () => window.open(btn.dataset.abrir, '_blank', 'noopener'));
    });
    row.querySelectorAll('button[data-acc]').forEach(btn => {
        btn.addEventListener('click', () => {
            const proceso = { proceso_id: f.proceso_id, envio: f };
            if (btn.dataset.acc === 'crear-envio') modalCrearEnvio(proceso, refrescarEnvios);
            if (btn.dataset.acc === 'entregado') modalMarcarEntregado(proceso, refrescarEnvios);
        });
    });
}

async function copiar(texto) {
    const valor = decodeURIComponent(texto);
    if (!valor) { mostrarToast('No hay dato para copiar', 'warning'); return; }
    try {
        await navigator.clipboard.writeText(valor);
        mostrarToast('Copiado ✔', 'success');
    } catch (e) {
        // Fallback para contextos sin permisos de clipboard
        const ta = document.createElement('textarea');
        ta.value = valor;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); mostrarToast('Copiado ✔', 'success'); }
        catch (err) { mostrarToast('No se pudo copiar', 'error'); }
        ta.remove();
    }
}
