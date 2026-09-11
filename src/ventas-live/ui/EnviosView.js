// ventas-live/ui/EnviosView.js
// Lista de tareas de envíos y entregas (spec §21-23): el orden es el "qué hacer
// primero", no el orden en que llegaron.
//
// Desde la migración 20261034/35/36 el BOT deja acá la elección del cliente
// (presencial / blue / paket) apenas la hace, con el siguiente paso ya escrito
// (`siguiente_paso`) y la fecha que el cliente mencionó, tal cual la escribió.
// Cada fila ofrece: confirmar en el chat (intervenir), marcar la entrega en el
// pedido (cuando el pago ya está confirmado), crear el envío o marcar entregado.

import { vlApi } from '../domain/vlApi.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { escapeHtml } from '../../shared/infrastructure/formatters.js';
import { modalCrearEnvio, modalMarcarEntregado } from './accionesProceso.js';
import { abrirChatDeUsuario } from './ConversacionesDrawer.js';

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

// El courier que eligió el cliente en el chat -> nombre de la empresa
const COURIER_EMPRESA = { blue: 'blue_express', paket: 'paket' };

// Orden de trabajo: primero lo que vence, después lo del día, y al final lo que
// todavía no se puede hacer (sin pago confirmado). Ámbar = atención, sin rojo.
const GRUPOS = [
    { g: 'urgente_paket', titulo: '⏰ PEDIR YA (Paket: antes de las 23:59)', color: '#ffc107' },
    { g: 'hoy', titulo: '📅 HOY', color: '#ffa94d' },
    { g: 'manana', titulo: '📅 MAÑANA', color: '#74c0fc' },
    { g: 'proximos', titulo: '📅 PRÓXIMOS', color: '#adb5bd' },
    { g: 'presenciales', titulo: '🤝 ENTREGAS PRESENCIALES', color: '#e599f7' },
    { g: 'en_proceso', titulo: '🚚 ENVÍOS EN PROCESO', color: '#9775fa' },
    { g: 'esperando_pago', titulo: '⏳ ESPERANDO CONFIRMAR PAGO', color: '#adb5bd' }
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
    const [res, cfg] = await Promise.all([
        vlApi.enviosPendientes(),
        vlApi.configFaltantes()
    ]);

    const banner = bannerConfigHTML(cfg);

    if (!res.ok) {
        cont.innerHTML = banner + '<div class="vl-empty">No se pudo cargar: ' + escapeHtml(res.error || 'error') + '</div>';
        return;
    }
    const grupos = res.data.grupos || {};
    const visibles = GRUPOS.filter(gr => (grupos[gr.g] || []).length);

    if (!visibles.length) {
        cont.innerHTML = banner + '<div class="vl-empty" style="padding:50px;">Sin tareas de envío ni entregas pendientes 🎉</div>';
        return;
    }

    cont.innerHTML = banner + visibles.map(gr => {
        const filas = grupos[gr.g] || [];
        return `
            <div class="vl-grupo-titulo"><span>${gr.titulo}</span><span class="cnt" style="color:${gr.color};">${filas.length}</span></div>
            <div data-grupo="${gr.g}">${filas.map(filaHTML).join('')}</div>`;
    }).join('');

    visibles.forEach(gr => {
        const bloque = cont.querySelector(`[data-grupo="${gr.g}"]`);
        if (!bloque) return;
        (grupos[gr.g] || []).forEach((f, i) => {
            const row = bloque.querySelectorAll('.vl-fila')[i];
            if (row) bindFila(row, f);
        });
    });
}

// Aviso de configuración: sin esto el bot no vende bien. Ámbar, informativo.
function bannerConfigHTML(cfg) {
    if (!cfg || !cfg.ok || !cfg.data) return '';
    const faltan = Array.isArray(cfg.data.faltantes) ? cfg.data.faltantes : [];
    const recom = Array.isArray(cfg.data.recomendados) ? cfg.data.recomendados : [];
    if (!faltan.length && !recom.length) return '';

    const lista = faltan.length
        ? `<ul style="margin:8px 0 0 18px;padding:0;">${faltan.map(f => `<li>${escapeHtml(f.mensaje)}</li>`).join('')}</ul>`
        : '';
    const nota = recom.length
        ? `<div style="margin-top:8px;font-size:0.8rem;opacity:0.75;">Opcional: ${recom.map(r => escapeHtml(r.mensaje)).join(' ')}</div>`
        : '';
    const titulo = faltan.length
        ? '⚠️ Falta configurar el bot antes de usarlo en un LIVE'
        : '✅ El bot está listo (hay ajustes opcionales)';

    return `<div style="border:1px solid rgba(255,193,7,0.55);background:rgba(255,193,7,0.10);border-radius:10px;padding:12px 14px;margin-bottom:14px;">
        <div style="font-weight:700;">${titulo}</div>${lista}${nota}</div>`;
}

function filaHTML(f) {
    const c = f.cliente || {};
    const empresa = f.empresa ? (EMPRESA_LABEL[f.empresa] || f.empresa)
        : (COURIER_EMPRESA[f.courier] ? EMPRESA_LABEL[COURIER_EMPRESA[f.courier]] : 'por definir');
    const direccionCompleta = [c.nombre_real || ('@' + c.tiktok_user), c.whatsapp, c.direccion, c.comuna, c.ciudad]
        .filter(Boolean).join(', ');
    const chipCourier = f.tipo === 'presencial' ? '' :
        `<span style="color:${f.courier === 'paket' ? '#ffc107' : '#74c0fc'};">🚚 ${escapeHtml(f.courier === 'paket' ? 'Paket' : (f.courier === 'blue' ? 'Blue' : 'courier sin definir'))}</span>`;
    // Si el envío ya está creado (empresa definida) se muestra la empresa; si no,
    // basta el chip del courier que eligió el cliente en el chat.
    const chipEmpresa = f.tipo === 'presencial'
        ? '<span>🤝 Presencial</span>'
        : (f.empresa ? `<span>🚚 ${escapeHtml(empresa)}</span>` : '');
    const chipFecha = f.notas
        ? `<span title="Lo que escribió el cliente">🗣️ dijo: ${escapeHtml(f.notas)}</span>`
        : (f.tipo === 'presencial' ? '<span style="opacity:0.7;">🗣️ sin fecha todavía</span>' : '');
    const chipPago = f.pago_confirmado
        ? '<span style="color:#8ce99a;">✔ pago confirmado</span>'
        : '<span style="opacity:0.75;">⏳ pago sin confirmar</span>';

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
                    ${chipEmpresa}
                    ${chipCourier}
                    ${f.tracking ? '<span>#' + escapeHtml(f.tracking) + '</span>' : ''}
                    ${f.fecha_programada ? '<span>📅 ' + escapeHtml(f.fecha_programada) + '</span>' : ''}
                    ${chipFecha}
                    ${chipPago}
                </div>
                ${f.siguiente_paso ? `<div class="f-sub" style="color:#ffd8a8;margin:6px 0 2px;"><i class="fas fa-arrow-right"></i> ${escapeHtml(f.siguiente_paso)}</div>` : ''}
                <div class="vl-datos-copy">
                    <button class="vl-btn" data-acc="chat" type="button"><i class="fas fa-comments"></i> Ver chat</button>
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

// El botón principal lo decide el backend (`accion`), así el panel y el estado
// real del pedido nunca se contradicen.
function accionHTML(f) {
    if (f.accion === 'entregado') {
        return `<button class="vl-btn success" data-acc="entregado" type="button"><i class="fas fa-check-circle"></i> Marcar entregado</button>`;
    }
    if (f.accion === 'crear_envio') {
        return `<button class="vl-btn success" data-acc="crear-envio" type="button"><i class="fas fa-truck-fast"></i> ENVÍO CREADO</button>`;
    }
    if (f.accion === 'decidir_envio') {
        return `<button class="vl-btn success" data-acc="decidir" data-tipo="envio" type="button"><i class="fas fa-box"></i> Marcar envío en el pedido</button>`;
    }
    if (f.accion === 'decidir_presencial') {
        return `<button class="vl-btn success" data-acc="decidir" data-tipo="presencial" type="button"><i class="fas fa-handshake"></i> Marcar entrega presencial</button>`;
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
        btn.addEventListener('click', async () => {
            const acc = btn.dataset.acc;
            // Confirmar en el chat: abre Conversaciones en ese cliente (para
            // verificar los datos e intervenir si hace falta)
            if (acc === 'chat') {
                const ok = await abrirChatDeUsuario((f.cliente || {}).tiktok_user);
                if (!ok) mostrarToast('No encontré ese chat', 'warning');
                return;
            }
            const proceso = { proceso_id: f.proceso_id, envio: f };
            if (acc === 'crear-envio') { modalCrearEnvio(proceso, refrescarEnvios); return; }
            if (acc === 'entregado') { modalMarcarEntregado(proceso, refrescarEnvios); return; }
            if (acc === 'decidir') {
                const tipo = btn.dataset.tipo === 'presencial' ? 'presencial' : 'envio';
                btn.disabled = true;
                const res = await vlApi.decidirEntrega(f.proceso_id, 'enviar_ahora', null, tipo);
                btn.disabled = false;
                if (!res.ok) {
                    mostrarToast(res.error || 'No se pudo marcar la entrega', 'error');
                    return;
                }
                mostrarToast(tipo === 'presencial' ? 'Entrega presencial marcada ✔' : 'Envío marcado en el pedido ✔', 'success');
                refrescarEnvios();
            }
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
