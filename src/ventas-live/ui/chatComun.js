// ventas-live/ui/chatComun.js
// Piezas compartidas para pintar conversaciones de WhatsApp: las usa la
// vista Chats y el panel de chat dentro de MODO LIVE. Así el formato de
// las burbujas y las etiquetas de autor son idénticos en ambos lados.

import { escapeHtml } from '../../shared/infrastructure/formatters.js';

export const ESTADO_CHAT = {
    nuevo: 'Nuevo',
    esperando_tiktok: 'Esperando @TikTok',
    esperando_confirmar_usuario: 'Confirmando usuario',
    esperando_tipo_entrega: 'Eligiendo entrega',
    esperando_datos_envio: 'Esperando datos de envío',
    esperando_forma_pago: 'Presencial: cómo paga',
    listo: 'Listo'
};

// Avisos que el bot dejó para que los revise una persona, con el nombre
// que se muestra en el chip del chat (el detalle va en el tooltip).
export const AVISO_CHAT = {
    comprobante: 'Comprobante',
    pago: 'Dijo que pagó',
    sin_cliente: 'Revisar chat',
    sin_courier: 'Elegir courier',
    no_entendido: 'No se entendió',
    usuario_no_encontrado: 'Usuario no encontrado',
    usuario_no_confirmado: 'Usuario no confirmado'
};

/** Hora del mensaje: solo hora si es de hoy, si no fecha + hora. */
export function fmtHora(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const mismoDia = d.toDateString() === new Date().toDateString();
    return mismoDia
        ? d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit' }) + ' ' +
          d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
}

/**
 * HTML del hilo completo. Cada mensaje lleva arriba el autor:
 * el nombre del cliente (entrante), "Bot" o "Tú" (saliente).
 */
export function burbujasHtml(mensajes, { nombreCliente = 'Cliente' } = {}) {
    if (!mensajes || mensajes.length === 0) {
        return '<div class="vl-empty">Sin mensajes todavía.</div>';
    }
    return mensajes.map(m => {
        const saliente = m.direction === 'out';
        const cuerpo = escapeHtml(m.body || '').replace(/\n/g, '<br>');
        const autor = saliente
            ? (m.origen === 'humano' ? 'Tú' : 'Bot')
            : escapeHtml(nombreCliente);
        return `
            <div class="vl-fila-msg ${saliente ? 'out' : 'in'}">
                <div class="vl-msg-autor">${autor}</div>
                <div class="vl-burbuja ${saliente ? 'out' : 'in'}">
                    <div class="vl-burbuja-txt">${cuerpo}</div>
                    <div class="vl-burbuja-hora">${escapeHtml(fmtHora(m.creado_en))}</div>
                </div>
            </div>`;
    }).join('');
}

/** Nombre con el que se etiqueta al cliente en el hilo. */
export function nombreDeCliente(chat) {
    if (!chat) return 'Cliente';
    return chat.nombre_real || (chat.tiktok_user ? '@' + chat.tiktok_user : 'Cliente');
}

/**
 * Baja el scroll al final del contenedor, salvo que el usuario esté
 * leyendo hacia arriba (no le movemos la vista).
 */
export function autoScrollAbajo(el, { forzar = false } = {}) {
    if (!el) return;
    const cercaDelFinal = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (forzar || cercaDelFinal) el.scrollTop = el.scrollHeight;
}
