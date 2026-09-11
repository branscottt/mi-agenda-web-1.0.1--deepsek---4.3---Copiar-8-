// clients/ui/InvitacionClientes.js
// "Tus clientes ya se guardan solos" — invitación de descubrimiento a
// Mis Clientes. Aparece UNA vez por tenant cuando el admin ya tiene
// clientes reales (gente que reservó por la web o compró sin turno)
// pero todavía NO ha guardado nada de ellos:
//   - 0 clientes manuales (nunca usó "Agregar cliente") y
//   - ninguna ficha con contenido (0 notas/archivos/fotos guardadas).
// Es el momento exacto en que la sección tiene valor pero el admin que
// no la conoce sigue sin entrar: la invitación se muestra sola, con una
// mini-tarjeta de ejemplo (badges), chips de lo que se puede hacer y un
// "¿Cómo funciona?" de 3 pasos. Nunca obliga: "Ahora no" la posterga.
//
// Reglas de convivencia:
//  - localStorage por tenant: 'agendapro_inv_clientes_<tid>' =
//      'visto' | 'postergada:<epoch ms>' (reaparece a los 3 días).
//  - No compite con el tour de bienvenida (AdminTour): si el tour está
//    pendiente o su overlay está abierto, esta invitación espera/omite.
//  - Sin onclick inline ni <style> dinámico (CSP por hashes).
//  - z-index 9900 (sobre sidebar/modales de app; bajo el tour 10000+).
//  - Cero lecturas forzadas si ya está 'visto': las consultas solo
//    corren cuando la invitación puede aparecer.
import { getAllCitas } from '../../appointments/application/AppointmentService.js';
import { getVentasArchivadas } from '../../api/appointmentsApi.js';
import { getCurrentTenantId } from '../../shared/infrastructure/router.js';
import { getSupabase } from '../../shared/infrastructure/supabase.js';
import * as kanbanApi from '../../api/kanbanApi.js';

const KEY_PREFIJO = 'agendapro_inv_clientes_';
// Conteo de clientes reales la última vez que se evaluó: si aparece gente
// nueva que reservó y el admin sigue sin guardar nada, la invitación REAPARECE
// (no es "una vez y nunca más": el momento valioso se repite solo).
const KEY_CONTEO = 'agendapro_inv_clientes_conteo_';
const TOUR_KEY_PREFIJO = 'agendapro_tour_';
const REAPARECER_MS = 3 * 24 * 60 * 60 * 1000; // "Ahora no" → vuelve en 3 días
const ESPERA_TOUR_MAX_MS = 90 * 1000; // cuánto esperar a que cierre el tour

let tenantIdActual = null;
let overlayEl = null;
let guiaAbierta = false;

// ─────────────────────────────────────────────
// PERSISTENCIA (localStorage por tenant)
// ─────────────────────────────────────────────
function claveInv() {
    return KEY_PREFIJO + tenantIdActual;
}

function estadoGuardado() {
    try {
        const v = localStorage.getItem(claveInv());
        if (!v) return null;
        if (v === 'visto') return { visto: true };
        if (v.startsWith('postergada:')) {
            const t = Number(v.slice('postergada:'.length));
            if (Number.isFinite(t)) return { visto: false, postergadaHasta: t + REAPARECER_MS };
        }
        return null;
    } catch (e) { return null; }
}

function marcarVisto() {
    try { localStorage.setItem(claveInv(), 'visto'); } catch (e) { /* sin almacenamiento */ }
}

function postergar() {
    try { localStorage.setItem(claveInv(), 'postergada:' + Date.now()); } catch (e) { /* sin almacenamiento */ }
}

function leerConteo() {
    try { return Number(localStorage.getItem(KEY_CONTEO + tenantIdActual) || 0); } catch (e) { return 0; }
}

function guardarConteo(n) {
    try { localStorage.setItem(KEY_CONTEO + tenantIdActual, String(n)); } catch (e) { /* sin almacenamiento */ }
}

// ─────────────────────────────────────────────
// DECISIÓN (solo corre cuando puede aparecer)
// ─────────────────────────────────────────────
function emailClave(e) {
    return String(e || '').toLowerCase().trim();
}

async function decidirMostrar() {
    const es = estadoGuardado();
    // "Ahora no" reciente: esperar (aplica tanto si está postergada como si no).
    if (es && !es.visto && es.postergadaHasta > Date.now()) return;

    const [rCitas, rVentas, rManuales, rFichas] = await Promise.allSettled([
        getAllCitas(),
        getVentasArchivadas(tenantIdActual),
        getSupabase()
            .from('clientes_manuales')
            .select('id', { count: 'exact', head: true })
            .eq('tenant_id', tenantIdActual),
        kanbanApi.getResumenFichas(tenantIdActual)
    ]);

    // 1) Clientes reales: emails únicos entre citas vigentes y ventas archivadas
    const emails = new Set();
    if (rCitas.status === 'fulfilled') {
        (rCitas.value || []).forEach(c => {
            const e = emailClave(c.contacto && c.contacto.email);
            if (e) emails.add(e);
        });
    }
    if (rVentas.status === 'fulfilled') {
        (rVentas.value || []).forEach(v => {
            const e = emailClave(v.contacto && v.contacto.email);
            if (e) emails.add(e);
        });
    }
    if (!emails.size) return; // sin clientes todavía → no hay nada que descubrir

    // 2) ¿Ya guardó algo de ellos? Manuales o contenido en alguna ficha.
    if (rManuales.status === 'fulfilled') {
        const n = rManuales.value && typeof rManuales.value.count === 'number' ? rManuales.value.count : 0;
        if (n > 0) return; // ya usó "Agregar cliente" → conoce la sección
    }
    if (rFichas.status === 'fulfilled') {
        const hayContenido = (rFichas.value || []).some(f => (f.n_cards || 0) > 0 || (f.n_adjuntos || 0) > 0);
        if (hayContenido) { guardarConteo(emails.size); return; } // ya guardó notas/archivos → conoce la ficha
    }

    // Ya la vio alguna vez: solo volver a mostrarla si aparecieron clientes
    // NUEVOS desde la última evaluación (alguien reservó y sigue sin datos).
    if (es && es.visto && emails.size <= leerConteo()) return;

    guardarConteo(emails.size);
    mostrarInvitacion(emails.size);
}

// ─────────────────────────────────────────────
// ESPERA AL TOUR DE BIENVENIDA
// Si el tour está pendiente o su overlay está abierto, la invitación
// espera a que termine (el tour ya enseña Mis Clientes con su paso
// propio); si al final el tour sigue sin resolverse, esta carga omite.
// ─────────────────────────────────────────────
function esperarTourResuelto() {
    return new Promise((resolve) => {
        const inicio = Date.now();
        const revisar = () => {
            const hayOverlayTour = !!(document.getElementById('tour-welcome-overlay') || document.getElementById('tour-overlay'));
            let estadoTour = null;
            try { estadoTour = localStorage.getItem(TOUR_KEY_PREFIJO + tenantIdActual); } catch (e) { /* ignore */ }
            const resuelto = !hayOverlayTour && (estadoTour === 'visto' || estadoTour === 'omitido');
            if (resuelto) return resolve(true);
            if (Date.now() - inicio > ESPERA_TOUR_MAX_MS) return resolve(false);
            setTimeout(revisar, 1500);
        };
        revisar();
    });
}

// ─────────────────────────────────────────────
// OVERLAY
// ─────────────────────────────────────────────
function cerrarOverlay() {
    if (!overlayEl) return;
    overlayEl.remove();
    overlayEl = null;
    document.removeEventListener('keydown', manejarTeclado);
}

function mostrarInvitacion(nClientes) {
    if (overlayEl) return;
    if (document.getElementById('tour-welcome-overlay') || document.getElementById('tour-overlay')) return;

    overlayEl = document.createElement('div');
    overlayEl.className = 'invcl-overlay';
    overlayEl.innerHTML = `
        <div class="invcl-card" role="dialog" aria-modal="true" aria-labelledby="invcl-titulo">
            <header class="invcl-head">
                <div class="invcl-avatar"><i class="fas fa-users"></i></div>
                <div class="invcl-head-txt">
                    <strong id="invcl-titulo">¡Tus clientes ya se guardan solos! 🎉</strong>
                    <span>${nClientes === 1 ? '1 persona ya reservó' : nClientes + ' personas ya reservaron'} y está${nClientes === 1 ? '' : 'n'} en <b>Mis Clientes</b></span>
                </div>
                <button type="button" class="invcl-x" id="invcl-cerrar" title="Ahora no (vuelve en unos días)" aria-label="Cerrar">&times;</button>
            </header>
            <div class="invcl-body">
                <p class="invcl-msg">Todavía no guardas nada de ellas. Con un toque en su tarjeta puedes tener una ficha así, lista para la próxima vez que vengan:</p>
                <div class="invcl-ejemplo">
                    <div class="invcl-ej-avatar">M</div>
                    <div class="invcl-ej-main">
                        <div class="invcl-ej-nombre">María González</div>
                        <div class="invcl-ej-meta">3 visitas · $45.000 · Próxima: jue 10:30</div>
                        <div class="invcl-ej-badges">
                            <span class="invcl-badge"><i class="fas fa-image"></i> 1 foto</span>
                            <span class="invcl-badge"><i class="fas fa-paperclip"></i> 2 archivos</span>
                            <span class="invcl-badge"><i class="fas fa-sticky-note"></i> 1 nota</span>
                        </div>
                    </div>
                </div>
                <div class="invcl-chips">
                    <span class="invcl-chip"><i class="fab fa-whatsapp"></i> WhatsApp con un toque</span>
                    <span class="invcl-chip"><i class="fas fa-history"></i> Historial y total gastado</span>
                    <span class="invcl-chip"><i class="fas fa-paper-plane"></i> Enviarles su info</span>
                </div>
                <div class="invcl-guia" id="invcl-guia" style="display:none;">
                    <div class="invcl-guia-titulo"><i class="fas fa-lightbulb"></i> Cómo funciona, en 30 segundos</div>
                    <div class="invcl-guia-paso"><span class="invcl-guia-num">1</span><span>Cuando alguien reserva en tu web (o compra sin turno), <b>queda guardado solo</b> en Mis Clientes con su historial.</span></div>
                    <div class="invcl-guia-paso"><span class="invcl-guia-num">2</span><span>Toca su tarjeta y se abre su <b>ficha</b>: notas, fotos, archivos (PDF, Word…), checklists y estado de pago en un solo lugar.</span></div>
                    <div class="invcl-guia-paso"><span class="invcl-guia-num">3</span><span>Marca listas como visibles y el botón <b>"Enviar info"</b> le manda por WhatsApp un enlace con eso, siempre actualizado.</span></div>
                </div>
            </div>
            <footer class="invcl-foot">
                <button type="button" class="invcl-btn invcl-btn-sec" id="invcl-como"><i class="fas fa-question-circle"></i> <span>¿Cómo funciona?</span></button>
                <button type="button" class="invcl-btn invcl-btn-prim" id="invcl-ir"><i class="fas fa-users"></i> Ver Mis Clientes</button>
                <button type="button" class="invcl-btn invcl-btn-ghost" id="invcl-no">Ahora no</button>
            </footer>
        </div>
    `;
    document.body.appendChild(overlayEl);

    document.getElementById('invcl-cerrar').addEventListener('click', () => { postergar(); cerrarOverlay(); });
    document.getElementById('invcl-no').addEventListener('click', () => { postergar(); cerrarOverlay(); });
    overlayEl.addEventListener('mousedown', (e) => { if (e.target === overlayEl) { postergar(); cerrarOverlay(); } });

    const btnComo = document.getElementById('invcl-como');
    const btnComoTxt = btnComo.querySelector('span');
    btnComo.addEventListener('click', async () => {
        // Guía interactiva completa (4 pasos, con ejemplos). Si por lo que sea
        // no carga el chunk, cae al resumen inline de 3 pasos.
        try {
            const { abrirMisClientesGuia } = await import('./MisClientesGuia.js');
            abrirMisClientesGuia({});
            return;
        } catch (e) { /* fallback abajo */ }
        const guia = document.getElementById('invcl-guia');
        if (!guia) return;
        guiaAbierta = !guiaAbierta;
        guia.style.display = guiaAbierta ? 'block' : 'none';
        btnComoTxt.textContent = guiaAbierta ? 'Ver el resumen' : '¿Cómo funciona?';
    });

    document.getElementById('invcl-ir').addEventListener('click', () => {
        marcarVisto();
        cerrarOverlay();
        if (typeof window.navigateTo === 'function') {
            try { window.navigateTo('clientes'); } catch (e) { /* sección ya visible */ }
        }
    });

    document.addEventListener('keydown', manejarTeclado);
}

function manejarTeclado(e) {
    if (e.key === 'Escape' && overlayEl) {
        postergar();
        cerrarOverlay();
    }
}

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────
export async function initInvitacionClientes() {
    try {
        if (!document.querySelector('.admin-screen')) return;
        if (document.querySelector('.superadmin-screen')) return;

        tenantIdActual = await getCurrentTenantId();
        if (!tenantIdActual) return;

        // 1) Puertas locales rápidas (sin red): ya visto o postergado vigente.
        const es = estadoGuardado();
        if (es && es.visto) return;
        if (es && es.postergadaHasta > Date.now()) return;

        // 2) El tour de bienvenida manda: si está pendiente u abierto, esperar.
        let estadoTour = null;
        try { estadoTour = localStorage.getItem(TOUR_KEY_PREFIJO + tenantIdActual); } catch (e) { /* ignore */ }
        const hayOverlayTour = !!(document.getElementById('tour-welcome-overlay') || document.getElementById('tour-overlay'));
        if (!estadoTour || hayOverlayTour) {
            const ok = await esperarTourResuelto();
            if (!ok) return; // el tour no se resolvió: esta carga omite, no insiste
        }

        // 3) Pequeña pausa para que el panel pinte (mismo espíritu que el tour).
        setTimeout(() => {
            decidirMostrar().catch((e) => console.warn('[InvitacionClientes]', e && e.message));
        }, 600);
    } catch (e) {
        console.warn('[InvitacionClientes] No disponible:', e && e.message);
    }
}
