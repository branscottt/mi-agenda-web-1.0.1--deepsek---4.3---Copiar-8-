// notifications/ui/AvisosPreview.js
// ============================================================
// Fase 2 — "Notificaciones que se entienden" (admin).
// 1) SIMULADOR: botón "Probar avisos" en el popover de la campana.
//    Mockup de celular/correo con el mensaje EXACTO que arma el
//    sistema (renderNotificaciones, script.js) para cada momento:
//    - Al reservar (correo de confirmación)
//    - Recordatorio 24 h antes (WhatsApp)
//    - Cambio de fecha (WhatsApp)
//    Usa datos REALES del tenant cuando existen (negocio, próxima
//    cita) y ejemplo claro si aún no hay citas.
// 2) PRUEBA REAL: "Enviarme una prueba a mi WhatsApp" → wa.me con el
//    número del DUEÑO (tenants.whatsapp) y el texto del momento activo.
// 3) BANNER "Tus citas de hoy" al entrar al panel (client-side).
// ============================================================

import { getCurrentTenantId } from '../../shared/infrastructure/router.js';
import { getTenantById } from '../../api/tenantsApi.js';
import { getCitasByDate, getCitasByDateRange } from '../../api/appointmentsApi.js';
import { getAllServicios } from '../../services/application/ServiceService.js';

// Textos IDÉNTICOS al armado real de script.js (renderNotificaciones).
// Si algún día se editan allá, actualizar aquí para que el simulador no mienta.
const MOMENTOS = [
    {
        id: 'reserva',
        etiqueta: 'Al reservar (correo)',
        icono: 'fas fa-envelope',
        canal: 'email',
        titulo: 'Confirmación de reserva',
        asunto: (s) => `Confirmación de reserva: ${s.servicio}`,
        cuerpo: (s) => `Hola ${s.cliente},\n\nTe confirmamos tu reserva para ${s.servicio} el ${s.fecha} a las ${s.hora}.\n\nGracias.`
    },
    {
        id: 'recordatorio',
        etiqueta: 'Recordatorio 24 h antes',
        icono: 'fab fa-whatsapp',
        canal: 'whatsapp',
        titulo: 'Recordatorio de cita (WhatsApp)',
        cuerpo: (s) => `Hola ${s.cliente}, recordatorio: tienes una cita de ${s.servicio} el ${s.fecha} a las ${s.hora}.`
    },
    {
        id: 'cambio',
        etiqueta: 'Cambio de fecha',
        icono: 'fab fa-whatsapp',
        canal: 'whatsapp',
        titulo: 'Cita reprogramada (WhatsApp)',
        cuerpo: (s) => `Hola ${s.cliente}, te informamos que tu cita ha sido reprogramada por el administrador.\n\nNueva fecha: ${s.fechaNueva || s.fecha} a las ${s.horaNueva || s.hora}\n\nSi tienes dudas, contáctanos.`
    }
];

let _datos = null; // { negocio, whatsapp, ejemplo }
let _el = null;    // refs del modal
let _tabActivo = 'recordatorio';

function fmtHoyLocal() {
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtFechaLegible(iso) {
    if (!iso) return '';
    const p = iso.split('-');
    if (p.length !== 3) return iso;
    const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    return `${parseInt(p[2], 10)} de ${meses[parseInt(p[1], 10) - 1] || p[1]}`;
}

function horaActualMin() {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
}

function horaAMin(hhmm) {
    const p = String(hhmm || '').split(':').map(Number);
    return (p[0] || 0) * 60 + (p[1] || 0);
}

// ============================================================
// Carga de datos reales del tenant (una sola vez)
// ============================================================
async function cargarDatos() {
    if (_datos) return _datos;
    const tenantId = await getCurrentTenantId();
    if (!tenantId) { _datos = { negocio: '', whatsapp: '', ejemplo: ejemploVacio() }; return _datos; }

    let negocio = '';
    let whatsapp = '';
    try {
        const t = await getTenantById(tenantId);
        if (t) {
            negocio = t.nombre_negocio || '';
            whatsapp = String(t.whatsapp || '').replace(/\D/g, '');
        }
    } catch (e) {
        console.warn('[avisos] No se pudo leer el tenant:', e.message);
    }

    // Próxima cita futura (para mostrar el mensaje con datos reales).
    const ejemplo = ejemploVacio();
    try {
        const hoy = fmtHoyLocal();
        const hasta = new Date();
        hasta.setDate(hasta.getDate() + 45);
        const p = (x) => String(x).padStart(2, '0');
        const hastaStr = `${hasta.getFullYear()}-${p(hasta.getMonth() + 1)}-${p(hasta.getDate())}`;
        const citas = await getCitasByDateRange(hoy, hastaStr, tenantId);
        const servicios = await getAllServicios(tenantId);
        const nombreServ = (id) => {
            const s = (servicios || []).find(x => String(x.id) === String(id));
            return s ? s.nombre : '';
        };
        const ahora = new Date();
        const futuras = (citas || [])
            .map(c => {
                const fp = String(c.fecha || '').split('-').map(Number);
                const d = fp.length === 3 ? new Date(fp[0], fp[1] - 1, fp[2]) : null;
                return {
                    ...c,
                    _ts: d ? d.getTime() + horaAMin(c.hora) * 60000 : 0,
                    servicioNombre: nombreServ(c.servicio_id)
                };
            })
            .filter(c => c._ts > ahora.getTime())
            .sort((a, b) => a._ts - b._ts);
        const prox = futuras[0];
        if (prox) {
            ejemplo.cliente = (prox.contacto && prox.contacto.nombre) || 'Cliente';
            ejemplo.servicio = prox.servicioNombre || 'tu servicio';
            ejemplo.fecha = prox.fecha;
            ejemplo.fechaLegible = fmtFechaLegible(prox.fecha);
            ejemplo.hora = prox.hora;
        }
    } catch (e) {
        console.warn('[avisos] No se pudieron cargar citas de ejemplo:', e.message);
    }

    _datos = { negocio, whatsapp, ejemplo };
    return _datos;
}

function ejemploVacio() {
    // Mañana a las 18:00, ejemplo claro (se usa solo si no hay citas reales).
    const manana = new Date();
    manana.setDate(manana.getDate() + 1);
    const p = (x) => String(x).padStart(2, '0');
    return {
        cliente: 'María',
        servicio: 'tu servicio',
        fecha: `${manana.getFullYear()}-${p(manana.getMonth() + 1)}-${p(manana.getDate())}`,
        fechaLegible: fmtFechaLegible(`${manana.getFullYear()}-${p(manana.getMonth() + 1)}-${p(manana.getDate())}`),
        hora: '18:00'
    };
}

// ============================================================
// Init: botón en el popover + banner "Tus citas de hoy"
// ============================================================
export async function initAvisosPreview() {
    const popover = document.getElementById('notif-popover');
    if (!popover) return;
    const header = popover.querySelector('.notif-popover-header');
    if (!header) return;

    // Botón junto a "Ver tutorial" (grupo flex creado por NotificationsTutorial).
    let grupo = header.querySelector('.notif-popover-header .tutorial-btn')?.parentElement;
    if (!grupo || grupo.tagName !== 'DIV') {
        grupo = document.createElement('div');
        grupo.style.cssText = 'display:flex;align-items:center;gap:10px;min-width:0;';
        const h4 = header.querySelector('h4');
        header.insertBefore(grupo, h4);
        grupo.appendChild(h4);
    }
    if (document.getElementById('btn-probar-avisos')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'btn-probar-avisos';
    btn.className = 'tutorial-btn avisos-btn-probar';
    btn.innerHTML = '<i class="fas fa-mobile-alt"></i> Probar avisos';
    btn.title = 'Mira cómo recibe tus avisos un cliente y envíate una prueba';
    btn.addEventListener('click', () => abrirSimulador());
    grupo.appendChild(btn);

    await montarBannerCitasHoy();
}

// ============================================================
// Banner "Tus citas de hoy" (dashboard)
// ============================================================
async function montarBannerCitasHoy() {
    const section = document.getElementById('section-dashboard');
    if (!section) return;
    if (document.getElementById('avisos-banner-hoy')) return;

    const tenantId = await getCurrentTenantId();
    if (!tenantId) return;

    let citas = [];
    let servicios = [];
    try {
        const hoy = fmtHoyLocal();
        citas = await getCitasByDate(hoy, tenantId);
        servicios = await getAllServicios(tenantId);
    } catch (e) {
        console.warn('[avisos] Banner citas de hoy no disponible:', e.message);
        return;
    }
    const nombreServ = (id) => {
        const s = (servicios || []).find(x => String(x.id) === String(id));
        return s ? s.nombre : '';
    };

    const ahoraMin = horaActualMin();
    const hoy = fmtHoyLocal();
    const futuras = (citas || [])
        .map(c => ({
            hora: c.hora,
            min: horaAMin(c.hora),
            cliente: (c.contacto && c.contacto.nombre) || 'Cliente',
            servicio: nombreServ(c.servicio_id)
        }))
        .filter(c => c.min >= ahoraMin)
        .sort((a, b) => a.min - b.min);

    if (!futuras.length) return;

    const chips = futuras.slice(0, 3).map(c => {
        const extra = c.servicio ? ` · ${escapeHtml(c.servicio)}` : '';
        return `<span class="avisos-chip"><strong>${escapeHtml(c.hora)}</strong> ${escapeHtml(c.cliente)}${extra}</span>`;
    }).join('');
    const resto = futuras.length > 3 ? `<span class="avisos-resto">y ${futuras.length - 3} más</span>` : '';

    const banner = document.createElement('div');
    banner.className = 'avisos-banner-hoy';
    banner.id = 'avisos-banner-hoy';
    banner.innerHTML = `
        <div class="avisos-banner-icono"><i class="fas fa-calendar-day"></i></div>
        <div class="avisos-banner-texto">
            <strong>Tus citas de hoy (${futuras.length})</strong>
            <div class="avisos-banner-chips">${chips} ${resto}</div>
        </div>
        <button type="button" class="avisos-banner-ver" id="avisos-ver-citas"><i class="fas fa-list"></i> Ver citas</button>
        <button type="button" class="avisos-banner-cerrar" id="avisos-cerrar-banner" title="Cerrar" aria-label="Cerrar"><i class="fas fa-times"></i></button>
    `;
    section.insertBefore(banner, section.firstChild);

    banner.querySelector('#avisos-cerrar-banner').addEventListener('click', () => {
        banner.remove();
    });
    banner.querySelector('#avisos-ver-citas').addEventListener('click', () => {
        if (typeof window.navigateTo === 'function') window.navigateTo('citas');
    });
}

// ============================================================
// Simulador (modal)
// ============================================================
async function abrirSimulador() {
    const datos = await cargarDatos();
    if (!_el) construirModal();
    _el.modal.hidden = false;
    document.body.classList.add('avisos-abierto');
    pintarTabs(datos);
}

function cerrarSimulador() {
    if (!_el) return;
    _el.modal.hidden = true;
    document.body.classList.remove('avisos-abierto');
}

function construirModal() {
    const modal = document.createElement('div');
    modal.id = 'avisos-preview-modal';
    modal.className = 'avisos-modal';
    modal.hidden = true;
    modal.innerHTML = `
        <div class="avisos-backdrop" data-avisos-cerrar="1"></div>
        <div class="avisos-panel" role="dialog" aria-modal="true" aria-label="Probar avisos a clientes">
            <div class="avisos-head">
                <div>
                    <h4><i class="fas fa-mobile-alt"></i> Así recibe tus avisos el cliente</h4>
                    <p>El mensaje se arma solo con los datos de cada reserva. Esto es lo que verá tu cliente:</p>
                </div>
                <button type="button" class="avisos-cerrar" data-avisos-cerrar="1" title="Cerrar" aria-label="Cerrar"><i class="fas fa-times"></i></button>
            </div>
            <div class="avisos-tabs" id="avisos-tabs"></div>
            <div class="avisos-cuerpo" id="avisos-cuerpo"></div>
            <div class="avisos-foot">
                <p class="avisos-foot-nota" id="avisos-foot-nota"><i class="fas fa-info-circle"></i> La prueba llega a <strong>TU WhatsApp</strong>, con el mismo texto que vería un cliente.</p>
                <button type="button" class="avisos-btn-prueba" id="avisos-btn-prueba">
                    <i class="fab fa-whatsapp"></i> Enviarme una prueba
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    _el = {
        modal,
        tabs: modal.querySelector('#avisos-tabs'),
        cuerpo: modal.querySelector('#avisos-cuerpo'),
        btnPrueba: modal.querySelector('#avisos-btn-prueba'),
        footNota: modal.querySelector('#avisos-foot-nota')
    };
    modal.querySelectorAll('[data-avisos-cerrar]').forEach(el => {
        el.addEventListener('click', cerrarSimulador);
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.hidden) cerrarSimulador();
    });
    // Listener ÚNICO del botón de prueba (lee el tab activo al hacer clic).
    modal.querySelector('#avisos-btn-prueba').addEventListener('click', () => {
        const datos = _datos || ejemploVacio();
        if (datos && datos.whatsapp) enviarPrueba(datos);
    });
}

function pintarTabs(datos) {
    _el.tabs.innerHTML = MOMENTOS.map(m => `
        <button type="button" class="avisos-tab ${m.id === _tabActivo ? 'active' : ''}" data-momento="${m.id}">
            <i class="${m.icono}"></i> ${m.etiqueta}
        </button>
    `).join('');
    _el.tabs.querySelectorAll('.avisos-tab').forEach(b => {
        b.addEventListener('click', () => {
            _tabActivo = b.dataset.momento;
            _el.tabs.querySelectorAll('.avisos-tab').forEach(t => t.classList.toggle('active', t.dataset.momento === _tabActivo));
            pintarMomento(datos);
        });
    });
    pintarMomento(datos);
}

function datosMomento(datos) {
    const ej = datos.ejemplo;
    return {
        cliente: ej.cliente,
        servicio: ej.servicio,
        fecha: ej.fechaLegible || ej.fecha,
        hora: ej.hora,
        fechaNueva: ej.fechaLegible || ej.fecha,
        horaNueva: ej.hora,
        negocio: datos.negocio
    };
}

function pintarMomento(datos) {
    const m = MOMENTOS.find(x => x.id === _tabActivo) || MOMENTOS[0];
    const d = datosMomento(datos);
    const cuerpoTexto = m.cuerpo(d);
    const cuerpoHtml = escapeHtml(cuerpoTexto).replace(/\n/g, '<br>');
    const esEmail = m.canal === 'email';
    const conDatosReales = !!(datos.ejemplo && datos.ejemplo.servicio !== 'tu servicio');

    _el.cuerpo.innerHTML = `
        <div class="avisos-aviso-datos">
            ${conDatosReales
                ? `<i class="fas fa-check-circle"></i> Mostrando tu <strong>próxima cita real</strong> (${escapeHtml(datos.ejemplo.cliente)} · ${escapeHtml(datos.ejemplo.fecha)} ${escapeHtml(datos.ejemplo.hora)}).`
                : '<i class="fas fa-flask"></i> Ejemplo: aún no tienes citas futuras, así se verá con la primera que llegue.'}
        </div>
        <div class="avisos-mockup avisos-mockup-${esEmail ? 'email' : 'whatsapp'}">
            ${esEmail ? `
                <div class="avisos-mail-cabecera">
                    <span class="avisos-mail-de"><strong>De:</strong> ${escapeHtml(d.negocio || 'Tu negocio')}</span>
                    <span class="avisos-mail-asunto"><strong>Asunto:</strong> ${escapeHtml(m.asunto(d))}</span>
                </div>
                <div class="avisos-mail-cuerpo">${cuerpoHtml}</div>
            ` : `
                <div class="avisos-wa-chat">
                    <div class="avisos-wa-contacto">
                        <span class="avisos-wa-avatar"><i class="fas fa-store"></i></span>
                        <span class="avisos-wa-nombre">${escapeHtml(d.negocio || 'Tu negocio')}</span>
                        <span class="avisos-wa-online">en línea</span>
                    </div>
                    <div class="avisos-wa-burbuja">
                        <span class="avisos-wa-remitente"><strong>${escapeHtml(d.negocio || 'Tu negocio')}</strong></span>
                        <span class="avisos-wa-texto">${cuerpoHtml}</span>
                        <span class="avisos-wa-hora">${new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                </div>
            `}
        </div>
        <p class="avisos-texto-real">El texto exacto que se envía hoy desde tu campana de notificaciones.</p>
    `;

    // Footer: la prueba por WhatsApp solo aplica a los momentos WhatsApp.
    const conNumero = !!(datos.whatsapp);
    if (esEmail) {
        _el.btnPrueba.style.display = 'none';
        _el.footNota.innerHTML = '<i class="fas fa-info-circle"></i> El correo se envía con el botón <strong>Email</strong> de cada aviso en tu campana: se abre ya escrito y solo lo envías.';
    } else if (!conNumero) {
        _el.btnPrueba.style.display = 'none';
        _el.footNota.innerHTML = '<i class="fas fa-info-circle"></i> Tu negocio aún no tiene WhatsApp cargado, así que la prueba no está disponible.';
    } else {
        _el.btnPrueba.style.display = '';
        _el.footNota.innerHTML = 'La prueba llega a <strong>TU WhatsApp</strong>, con el mismo texto que vería un cliente.';
    }
}

function enviarPrueba(datos) {
    if (!datos.whatsapp) return;
    const m = MOMENTOS.find(x => x.id === _tabActivo) || MOMENTOS[0];
    const d = datosMomento(datos);
    const texto = m.id === 'reserva'
        ? `${m.asunto(d)}\n\n${m.cuerpo(d)}`
        : m.cuerpo(d);
    const url = `https://wa.me/${datos.whatsapp}?text=${encodeURIComponent(texto)}`;
    window.open(url, '_blank', 'noopener');
}

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
