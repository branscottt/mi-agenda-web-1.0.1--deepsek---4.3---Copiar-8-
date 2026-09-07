// share/ui/SimuladorWhatsApp.js
// "Así recibe tu cliente lo que le compartes": antes de saltar a WhatsApp,
// muestra en una maqueta de celular el mensaje que verá el cliente.
// El texto viene pre-escrito en neutro, es editable, y el botón final
// "Enviar de verdad" abre WhatsApp con ese texto.
// La primera vez se muestra el simulador; después el envío es directo
// (preferencia recordada en localStorage, como los demás avisos).
import { mostrarToast } from '../../shared/infrastructure/toast.js';

const KEY_VISTO = 'agendapro_sim_compartir_visto';

export function shareSimPendiente() {
    try { return localStorage.getItem(KEY_VISTO) !== '1'; } catch (e) { return false; }
}

export function marcarShareSimVisto() {
    try { localStorage.setItem(KEY_VISTO, '1'); } catch (e) { /* sin almacenamiento */ }
}

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function soloDigitos(telefono) {
    return String(telefono || '').replace(/[^0-9]/g, '');
}

function buildWaUrl(telefono, texto) {
    return `https://wa.me/${soloDigitos(telefono)}?text=${encodeURIComponent(texto)}`;
}

async function copiarTexto(texto) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(texto);
            return true;
        }
    } catch (e) { /* fallback */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = texto;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, 99999);
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch (e) {
        return false;
    }
}

/**
 * Abre el simulador.
 * @param {object} opts
 * @param {string} opts.nombreCliente  Nombre del cliente (para el saludo y el chat simulado)
 * @param {string} opts.telefono       Teléfono con código de país (ej. +56 9 …)
 * @param {string} opts.enlace         Enlace que recibe el cliente (tarjeta simulada)
 * @param {string} opts.mensaje        Texto inicial del mensaje (editable)
 * @param {Function} [opts.onEnviar]   Callback tras "Enviar de verdad"
 */
export function abrirSimuladorWhatsApp({ nombreCliente = '', telefono = '', enlace = '', mensaje = '', onEnviar } = {}) {
    const nombre = (nombreCliente && nombreCliente !== 'Sin nombre') ? String(nombreCliente).split(' ')[0] : 'tu cliente';
    const telefonoValido = soloDigitos(telefono).length > 0;
    const hora = new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });

    const overlay = document.createElement('div');
    overlay.className = 'sw-overlay';
    overlay.innerHTML = `
        <div class="sw-modal">
            <header class="sw-head">
                <div class="sw-head-icono"><i class="fab fa-whatsapp"></i></div>
                <div class="sw-head-txt">
                    <strong>Así recibe ${escapeHtml(nombre)} lo que le compartes</strong>
                    <span>Mira el mensaje del lado del cliente antes de enviarlo</span>
                </div>
                <button type="button" class="sw-cerrar" id="sw-cerrar" title="Cerrar" aria-label="Cerrar">&times;</button>
            </header>
            <div class="sw-body">
                <div class="sw-panel-ph">
                    <div class="sw-ph-label"><i class="fas fa-mobile-alt"></i> Lo que recibe ${escapeHtml(nombre)}</div>
                    <div class="sw-wa">
                        <div class="sw-wa-head">
                            <span class="sw-wa-avatar">${escapeHtml((nombreCliente || 'C')[0].toUpperCase())}</span>
                            <div><strong>${escapeHtml(nombreCliente || 'Cliente')}</strong><small>WhatsApp · en línea</small></div>
                        </div>
                        <div class="sw-wa-chat">
                            <div class="sw-wa-burbuja sw-wa-salida">
                                <div class="sw-wa-msg">${escapeHtml(mensaje || '')}</div>
                                ${enlace ? `
                                <a class="sw-wa-link" href="${escapeHtml(enlace)}" target="_blank" rel="noopener noreferrer">
                                    <span class="sw-wa-link-titulo"><i class="fas fa-store"></i> Organify</span>
                                    <span class="sw-wa-link-url">${escapeHtml(enlace.replace(/^https?:\/\//, ''))}</span>
                                    <span class="sw-wa-link-cta">Abrir mi información <i class="fas fa-arrow-right"></i></span>
                                </a>` : ''}
                                <span class="sw-wa-hora">${hora} <i class="fas fa-check-double" style="color:#53bdeb;"></i></span>
                            </div>
                            <p class="sw-wa-nota">${escapeHtml(nombre)} ve solo lo que marcaste con el ojo 👁 en su tablero. Siempre actualizado.</p>
                        </div>
                    </div>
                </div>
                <div class="sw-panel-editor">
                    <p class="sw-sub">Fotos de progreso, rutinas, resultados: todo se lo puedes mandar desde aquí, sin buscar su WhatsApp.</p>
                    <label class="sw-label" for="sw-texto">Mensaje (edítalo si quieres)</label>
                    <textarea id="sw-texto" class="sw-texto" rows="6" maxlength="900">${escapeHtml(mensaje || '')}</textarea>
                    <div class="sw-acciones">
                        <button type="button" class="sw-btn sw-btn-primario" id="sw-enviar" ${telefonoValido ? '' : 'disabled'} title="${telefonoValido ? 'Abrir WhatsApp con este mensaje' : 'Este cliente no tiene teléfono guardado'}">
                            <i class="fab fa-whatsapp"></i> Enviar de verdad
                        </button>
                        <button type="button" class="sw-btn sw-btn-secundario" id="sw-copiar" title="Copiar mensaje y enlace">Copiar mensaje</button>
                    </div>
                    ${!telefonoValido ? '<p class="sw-aviso"><i class="fas fa-info-circle"></i> Este cliente no tiene teléfono: copia el mensaje y envíalo cuando tengas su número.</p>' : ''}
                    <p class="sw-foot"><i class="fas fa-shield-alt"></i> Se abre WhatsApp con el mensaje listo: tú decides cuándo enviarlo.</p>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const cerrar = () => overlay.remove();
    document.getElementById('sw-cerrar').addEventListener('click', cerrar);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) cerrar(); });

    document.getElementById('sw-enviar').addEventListener('click', () => {
        const texto = document.getElementById('sw-texto').value.trim() || mensaje;
        if (!telefonoValido) return;
        marcarShareSimVisto();
        window.open(buildWaUrl(telefono, texto), '_blank', 'noopener');
        if (typeof onEnviar === 'function') onEnviar();
        cerrar();
    });

    document.getElementById('sw-copiar').addEventListener('click', async () => {
        const texto = document.getElementById('sw-texto').value.trim() || mensaje;
        const paraCopiar = enlace ? `${texto}\n\n${enlace}` : texto;
        const ok = await copiarTexto(paraLoCopiar);
        mostrarToast(ok ? 'Mensaje y enlace copiados' : 'No se pudo copiar', ok ? 'success' : 'error');
    });

    return overlay;
}
