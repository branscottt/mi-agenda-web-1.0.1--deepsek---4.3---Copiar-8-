// clients/ui/ClientListView.js
// Gestión de clientes del tenant: lista, búsqueda, historial, contacto, exportación

import { getAllCitas } from '../../appointments/application/AppointmentService.js';
import { getVentasArchivadas } from '../../api/appointmentsApi.js';
import { getAllServicios } from '../../api/serviciosApi.js';
import { getCurrentTenantId } from '../../shared/infrastructure/router.js';
import { getSupabase } from '../../shared/infrastructure/supabase.js';
import { formatearDinero, formatDate, formatFechaCorta, formatTimeDisplay } from '../../shared/infrastructure/formatters.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { abrirMenuEtiquetas, renderChipEtiqueta } from '../../shared/ui/etiquetasPago.js';
import * as kanbanApi from '../../api/kanbanApi.js';

// ========== POLÍTICA DE RETENCIÓN ==========
// Un cliente solo sale de "Mis Clientes" cuando:
//   a) el admin lo elimina explícitamente (botón en ClientBoard), o
//   b) pasan MESES_SIN_RESERVAR_PARA_ELIMINAR meses sin una nueva
//      reserva (filtro de vista; sus datos quedan en `ventas` para
//      el dashboard y si vuelve a reservar, reaparece).
const MESES_SIN_RESERVAR_PARA_ELIMINAR = 3;

function fechaCorteInactividad() {
    const d = new Date();
    d.setMonth(d.getMonth() - MESES_SIN_RESERVAR_PARA_ELIMINAR);
    return formatDate(d);
}

// ========== DATOS ==========

function deduplicarClientes(citas) {
    const mapa = new Map();
    const hoy = formatDate(new Date());
    const corteInactividad = fechaCorteInactividad();
    citas.forEach(c => {
        const email = (c.contacto?.email || '').toLowerCase().trim();
        if (!email) return;
        if (!mapa.has(email)) {
            mapa.set(email, {
                email,
                nombre: c.contacto?.nombre || 'Sin nombre',
                telefono: c.contacto?.telefono || '',
                direccion: c.contacto?.direccion || '',
                totalGastado: 0,
                visitas: 0,
                primeraVisita: c.fecha,
                ultimaVisita: c.fecha,
                estadoPago: null,
                citas: []
            });
        }
        const cl = mapa.get(email);
        if (c.contacto?.direccion) cl.direccion = c.contacto.direccion;
        cl.visitas++;
        cl.totalGastado += Number(c.precio) || 0;
        if (c.fecha < cl.primeraVisita) cl.primeraVisita = c.fecha;
        if (c.fecha > cl.ultimaVisita) cl.ultimaVisita = c.fecha;
        cl.citas.push(c);
    });
    return Array.from(mapa.values()).map(cl => {
        // Estado de pago del cliente = el de su próxima cita; si no hay, el de la última
        const futuras = cl.citas
            .filter(c => c.fecha >= hoy)
            .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.hora.localeCompare(b.hora));
        const ultima = [...cl.citas].sort((a, b) => b.fecha.localeCompare(a.fecha) || b.hora.localeCompare(a.hora))[0];
        cl.estadoPago = (futuras[0] && futuras[0].estadoPago) || (ultima && ultima.estadoPago) || null;
        return cl;
    })
    // Retención: un cliente solo sale de la lista tras
    // MESES_SIN_RESERVAR_PARA_ELIMINAR sin reservar (su última visita
    // anterior al corte). Con citas futuras/hoy la última visita es
    // >= hoy, así que nunca se filtra por error.
    .filter(cl => cl.ultimaVisita >= corteInactividad)
    .sort((a, b) => b.ultimaVisita.localeCompare(a.ultimaVisita));
}

/**
 * Mapea una fila de la tabla `ventas` (archivo histórico) al mismo shape
 * camelCase que las citas vigentes, para que deduplicarClientes las trate igual.
 */
function mapearVenta(v) {
    return {
        id: `VENTA-${v.cita_id}`,
        servicioId: v.servicio_id,
        nombre: 'Servicio', // placeholder; el nombre real se resuelve con mapaServicios
        fecha: v.fecha,
        hora: v.hora,
        precio: v.precio,
        contacto: v.contacto || {},
        notificaciones: {},
        creadoEn: v.fecha_venta || v.archivado_en,
        trabajadorId: null,
        trabajador: null
    };
}

// ========== CLIENTES MANUALES (alta del admin) ==========

/**
 * Fusiona los clientes manuales (tabla clientes_manuales) con los
 * clientes derivados de citas/ventas. Dedup por email:
 * - Email ya existente (cliente derivado): el registro manual aporta
 *   datos de contacto (nombre/teléfono/dirección) cuando faltan.
 * - Email nuevo: se agrega como cliente manual, SIEMPRE visible hasta
 *   que el admin lo borre (se fusiona DESPUÉS del filtro de inactividad
 *   de deduplicarClientes, por eso queda exento de los 3 meses).
 */
function fusionarClientesManuales(manuales) {
    if (!Array.isArray(manuales) || !manuales.length) return;
    const mapa = new Map(clientesCache.map(c => [c.email.toLowerCase(), c]));
    manuales.forEach(m => {
        const email = (m.email || '').toLowerCase().trim();
        if (!email) return;
        const existente = mapa.get(email);
        if (existente) {
            if (m.nombre && (!existente.nombre || existente.nombre === 'Sin nombre')) existente.nombre = m.nombre;
            if (m.telefono && !existente.telefono) existente.telefono = m.telefono;
            if (m.direccion && !existente.direccion) existente.direccion = m.direccion;
        } else {
            mapa.set(email, {
                email,
                nombre: m.nombre || 'Sin nombre',
                telefono: m.telefono || '',
                direccion: m.direccion || '',
                totalGastado: 0,
                visitas: 0,
                primeraVisita: null,
                ultimaVisita: null,
                estadoPago: null,
                citas: [],
                origen: 'manual',
                creadoEn: m.creado_en
            });
        }
    });
    // Orden: última visita (o fecha de alta para manuales) descendente.
    clientesCache = Array.from(mapa.values()).sort((a, b) => {
        const aFecha = a.ultimaVisita || a.creadoEn || '';
        const bFecha = b.ultimaVisita || b.creadoEn || '';
        return bFecha.localeCompare(aFecha);
    });
}

/** Botón "Agregar cliente" → modal de alta (AgregarClienteModal.js). */
function bindAgregarCliente(container) {
    const btns = container.querySelectorAll('#agregar-cliente-btn, #agregar-cliente-btn-empty');
    btns.forEach(btn => {
        btn.addEventListener('click', async () => {
            try {
                const { abrirModalAgregarCliente } = await import('./AgregarClienteModal.js');
                await abrirModalAgregarCliente({
                    onGuardado: () => renderClientListView()
                });
            } catch (err) {
                console.error('[ClientListView] Error abriendo modal agregar cliente:', err);
                mostrarToast('No se pudo abrir el formulario de alta', 'error');
            }
        });
    });
}

/**
 * Botón "Crear mi primer cliente" (estado vacío) → chat guiado que
 * agrega el cliente conversando (PrimerClienteChat.js). Al guardar,
 * refresca la lista: la tarjeta nueva aparece con sus badges si subió
 * fotos o archivos.
 */
function bindPrimerCliente(container) {
    const btns = container.querySelectorAll('#primer-cliente-btn-empty');
    btns.forEach(btn => {
        btn.addEventListener('click', async () => {
            try {
                const { abrirPrimerClienteChat } = await import('./PrimerClienteChat.js');
                await abrirPrimerClienteChat({
                    onGuardado: () => renderClientListView()
                });
            } catch (err) {
                console.error('[ClientListView] Error abriendo chat primer cliente:', err);
                mostrarToast('No se pudo abrir la conversación', 'error');
            }
        });
    });
}

// ========== RENDER ==========

let clientesCache = [];
let filtroActual = '';
let mapaServicios = {};
// Tenant actual de la vista (para las claves de localStorage de la bienvenida)
let tenantIdActual = null;
// Permiso de etiquetas de pago para trabajadores (master + lista blanca)
let permisoEtiquetas = { permitir: false, trabajadores: [], trabajadoresLista: [] };
// Resumen de la ficha (tablero) de cada cliente: { email -> { board_id, token_compartido,
// listas_compartidas, n_listas, n_cards, n_adjuntos, n_fotos } }
let fichasPorEmail = {};

/** Botón "Traer/Importar clientes y archivos" → Centro de Mudanza (MudanzaModal.js). */
function bindMudanza(container) {
    const btn = container.querySelector('#mudanza-clientes-btn, #mudanza-clientes-btn-empty');
    if (btn) btn.addEventListener('click', abrirMudanza);
}

/** Abre la mini-guía interactiva "Cómo funciona Mis Clientes". */
async function abrirGuia() {
    try {
        const { abrirMisClientesGuia } = await import('./MisClientesGuia.js');
        abrirMisClientesGuia({ onImportar: abrirMudanza });
    } catch (err) {
        console.error('[ClientListView] Error abriendo la guía:', err);
        mostrarToast('No se pudo abrir la guía', 'error');
    }
}

// ========== BIENVENIDA / DESCUBRIMIENTO ==========
// Tarjeta llamativa ARRIBA de la sección (visible sin bajar) que enseña lo que
// se puede hacer. Es el reemplazo visible del aviso de una línea: se muestra
// hasta que el admin la cierra, y REAPARECE sola cuando entran clientes nuevos
// y todavía no guardó nada de ellos (el momento en que la sección tiene valor).

const HERO_KEY_PREFIJO = 'agendapro_mc_hero_';
const CONTEO_KEY_PREFIJO = 'agendapro_mc_conteo_';

function leerLS(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function escribirLS(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } }

/** ¿El admin ya guardó algo? (clientes manuales o contenido en alguna ficha) */
function hayDatosGuardados() {
    if ((clientesCache || []).some(c => c.origen === 'manual')) return true;
    return Object.values(fichasPorEmail || {}).some(f => (f.n_cards || 0) > 0 || (f.n_adjuntos || 0) > 0);
}

function renderBienvenida() {
    if (!clientesCache.length) return ''; // el estado vacío ya enseña
    const tid = tenantIdActual || 'na';
    const descartada = leerLS(HERO_KEY_PREFIJO + tid) === '1';
    const conteoKey = CONTEO_KEY_PREFIJO + tid;
    const previo = Number(leerLS(conteoKey) || 0);
    const nAhora = clientesCache.length;
    const nuevos = previo > 0 ? Math.max(0, nAhora - previo) : 0;
    escribirLS(conteoKey, String(nAhora));

    const sinDatos = !hayDatosGuardados();
    // Rearmar: la había cerrado, pero llegaron clientes nuevos y sigue sin
    // guardar nada → volvemos a ofrecerla (y queda visible hasta cerrarla).
    if (descartada && nuevos > 0 && sinDatos) escribirLS(HERO_KEY_PREFIJO + tid, '0');
    if (descartada && !(nuevos > 0 && sinDatos)) return '';

    const chipNuevos = nuevos > 0
        ? `<span class="mc-hero-nuevo"><i class="fas fa-bell"></i> ${nuevos === 1 ? '1 cliente nuevo' : nuevos + ' clientes nuevos'} desde tu última visita</span>`
        : '';

    return `
        <div class="mc-hero" id="mc-hero">
            <button type="button" class="mc-hero-x" id="mc-hero-x" title="Cerrar (puedes reabrirla desde “¿Cómo funciona?”)" aria-label="Cerrar">&times;</button>
            <div class="mc-hero-top">
                <div class="mc-hero-badge"><i class="fas fa-star"></i></div>
                <div class="mc-hero-txt">
                    <strong>Cada cliente tiene una ficha que lo guarda todo</strong>
                    <span>Notas, archivos, fotos, checklists y envío por WhatsApp — en un solo lugar y sin cargar nada a mano. ${chipNuevos}</span>
                </div>
            </div>
            <div class="mc-hero-pasos">
                <span class="mc-hero-paso"><i class="fas fa-hand-pointer"></i> Toca a un cliente</span>
                <span class="mc-hero-paso"><i class="fas fa-folder-open"></i> Guarda notas y archivos</span>
                <span class="mc-hero-paso"><i class="fab fa-whatsapp"></i> Envíale su info</span>
            </div>
            <div class="mc-hero-ctas">
                <button type="button" class="btn-llamativo" id="mc-hero-como"><i class="fas fa-graduation-cap"></i> Ver cómo funciona (30 seg)</button>
                <button type="button" class="btn-suave" id="mc-hero-mudanza"><i class="fas fa-truck-moving"></i> Traer mis clientes y archivos</button>
            </div>
        </div>
    `;
}

function bindBienvenida(container) {
    const como = container.querySelector('#mc-hero-como');
    if (como) como.addEventListener('click', abrirGuia);
    const mud = container.querySelector('#mc-hero-mudanza');
    if (mud) mud.addEventListener('click', abrirMudanza);
    const x = container.querySelector('#mc-hero-x');
    if (x) x.addEventListener('click', () => {
        escribirLS(HERO_KEY_PREFIJO + (tenantIdActual || 'na'), '1');
        const hero = document.getElementById('mc-hero');
        if (hero) hero.remove();
    });
}

async function abrirMudanza() {
    try {
        const { abrirCentroMudanza } = await import('./MudanzaModal.js');
        const clientes = (clientesCache || []).map(c => ({
            nombre: c.nombre || '',
            email: c.email || '',
            telefono: c.telefono || ''
        }));
        await abrirCentroMudanza({
            clientes,
            onTerminado: () => {
                try { renderClientListView(); } catch (e) { /* sin listado */ }
            }
        });
    } catch (err) {
        console.error('[ClientListView] Error abriendo Centro de Mudanza:', err);
        mostrarToast('No se pudo abrir el Centro de Mudanza', 'error');
    }
}

export async function renderClientListView(containerId = 'clientes-list-container') {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = '<div class="loading-spinner"><i class="fas fa-spinner fa-spin"></i><p>Cargando clientes...</p></div>';

    try {
        const tenantId = await getCurrentTenantId();
        tenantIdActual = tenantId;

        // Las lecturas de la vista son INDEPENDIENTES entre sí: se lanzan en
        // paralelo (antes eran secuenciales → ~6 round-trips encadenados por
        // apertura). Promise.allSettled conserva el manejo de error individual
        // de cada fuente (ninguna puede tumbar a las demás).
        const [rPermiso, rCitas, rVentas, rServicios, rManuales, rResumen] = await Promise.allSettled([
            getSupabase().rpc('admin_get_permiso_etiquetas', { p_tenant_id: tenantId }),
            getAllCitas(),
            getVentasArchivadas(tenantId),
            getAllServicios(tenantId),
            getSupabase()
                .from('clientes_manuales')
                .select('id, tenant_id, nombre, telefono, email, direccion, creado_en')
                .eq('tenant_id', tenantId),
            kanbanApi.getResumenFichas(tenantId)
        ]);

        // 1) Permiso de etiquetas de pago para trabajadores (master + lista blanca)
        try {
            const permisoData = rPermiso.status === 'fulfilled' ? rPermiso.value?.data : null;
            if (permisoData && permisoData.ok) {
                permisoEtiquetas = {
                    permitir: permisoData.permitir === true,
                    trabajadores: permisoData.trabajadores || [],
                    trabajadoresLista: permisoData.trabajadores_lista || []
                };
            }
        } catch (e) {
            console.warn('[ClientListView] No se pudo leer el permiso de etiquetas:', e);
        }

        // 2) Citas vigentes — si fallan, error general de la vista (comportamiento original)
        if (rCitas.status === 'rejected') throw rCitas.reason;
        const citas = rCitas.value || [];

        // 3) Ventas archivadas (histórico): fallo individual no tumba la vista
        let ventas = [];
        try {
            if (rVentas.status === 'fulfilled') ventas = rVentas.value || [];
        } catch (e) {
            console.warn('[ClientListView] No se pudieron cargar ventas archivadas:', e);
        }

        // 4) Mapa servicio_id -> nombre real (la cita solo guarda servicio_id; el
        // campo c.nombre es el placeholder 'Servicio' del mapeo legacy).
        mapaServicios = {};
        try {
            const servicios = rServicios.status === 'fulfilled' ? (rServicios.value || []) : [];
            servicios.forEach(s => { if (s && s.id != null) mapaServicios[s.id] = s.nombre; });
        } catch (e) {
            console.warn('[ClientListView] No se pudieron cargar nombres de servicios:', e);
        }

        const idsVigentes = new Set(citas.map(c => c.id));
        const todas = [
            ...citas,
            ...(ventas || [])
                .filter(v => v && v.cita_id && !idsVigentes.has(v.cita_id))
                .map(mapearVenta)
        ];

        clientesCache = deduplicarClientes(todas);

        // 5) Clientes agregados manualmente por el admin (tabla clientes_manuales):
        // se fusionan DESPUÉS del filtro de inactividad → siempre visibles hasta
        // que el admin los borre (política de retención del producto).
        let manuales = [];
        try {
            if (rManuales.status === 'fulfilled' && !rManuales.value?.error) manuales = rManuales.value.data || [];
        } catch (e) {
            console.warn('[ClientListView] No se pudieron cargar clientes manuales:', e);
        }
        fusionarClientesManuales(manuales);

        // 6) Resumen de la ficha de cada cliente: listas compartidas (chip + botón
        // WhatsApp) y contenido guardado (tarjetas, fotos, archivos → badges).
        fichasPorEmail = {};
        try {
            const resumen = rResumen.status === 'fulfilled' ? (rResumen.value || []) : [];
            resumen.forEach(r => { fichasPorEmail[r.cliente_email] = r; });
        } catch (e) {
            console.warn('[ClientListView] No se pudo leer el resumen de fichas:', e);
        }

        renderLista(container);
    } catch (e) {
        console.error('[ClientListView] Error cargando clientes:', e);
        container.innerHTML = '<p class="empty-state"><i class="fas fa-exclamation-triangle"></i> Error al cargar clientes</p>';
    }
}

function coincideFiltro(cl) {
    if (!filtroActual) return true;
    const q = filtroActual.toLowerCase();
    return cl.nombre.toLowerCase().includes(q)
        || cl.email.toLowerCase().includes(q)
        || cl.telefono.includes(q);
}

function getFiltrados() {
    return clientesCache.filter(coincideFiltro);
}

function renderLista(container) {
    if (!clientesCache.length) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-users"></i>
                <h4>No hay clientes registrados</h4>
                <p>Cuando tus clientes reserven en la web aparecerán aquí solos, con su historial y sus archivos. ¿Partimos con el primero?</p>
                <div class="empty-ctas" style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:14px;">
                    <button class="btn-primary btn-small" id="primer-cliente-btn-empty" title="Responde unas preguntas y el cliente queda guardado, con fotos y archivos si quieres">
                        <i class="fas fa-comments"></i> Crear mi primer cliente
                    </button>
                    <button class="btn-secondary btn-small" id="agregar-cliente-btn-empty" title="Formulario completo: datos de contacto y reserva opcional">
                        <i class="fas fa-user-plus"></i> Agregar con formulario
                    </button>
                    <button class="btn-llamativo btn-small" id="mudanza-clientes-btn-empty" title="Traé de una todo lo que ya tenías: pega tu Excel con los clientes y sube sus archivos en montón">
                        <i class="fas fa-truck-moving"></i> Traer mis clientes y archivos
                    </button>
                    <button class="btn-suave btn-small" id="guia-clientes-btn-empty" title="¿Qué se puede hacer en Mis Clientes? Te lo muestro con ejemplos, en 30 segundos">
                        <i class="fas fa-graduation-cap"></i> Ver cómo funciona
                    </button>
                </div>
                <p style="color:var(--text-muted,#999);font-size:0.75rem;margin-top:10px;"><i class="fas fa-info-circle"></i> También se puede tocar "Crear mi primer cliente" las veces que quieras: cada conversación agrega un cliente.</p>
            </div>
        `;
        bindAgregarCliente(container);
        bindPrimerCliente(container);
        bindMudanza(container);
        const guiaEmpty = container.querySelector('#guia-clientes-btn-empty');
        if (guiaEmpty) guiaEmpty.addEventListener('click', abrirGuia);
        return;
    }

    const filtrados = getFiltrados();

    let html = `
        ${renderBienvenida()}
        <div class="clientes-header-actions" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:16px;">
            <div class="search-box" style="flex:1;min-width:200px;">
                <i class="fas fa-search"></i>
                <input type="text" id="clientes-search-input" placeholder="Buscar por nombre, email o teléfono..." value="${escapeHtml(filtroActual)}">
            </div>
            <button class="btn-llamativo btn-small" id="mudanza-clientes-btn" title="Traé de una todo lo que ya tenías: pega tu Excel con los clientes y sube sus archivos en montón (se distribuyen solos a cada cliente)">
                <i class="fas fa-truck-moving"></i> Importar clientes y archivos
            </button>
            <button class="btn-suave btn-small" id="guia-clientes-btn" title="¿Qué se puede hacer en Mis Clientes? Te lo muestro con ejemplos, en 30 segundos">
                <i class="fas fa-graduation-cap"></i> ¿Cómo funciona?
            </button>
            <button class="btn-primary btn-small" id="agregar-cliente-btn" title="Agregar un cliente que ya tenías antes de la web y asignarle una reserva si quieres">
                <i class="fas fa-user-plus"></i> Agregar cliente
            </button>
            <button class="btn-secondary btn-small" id="toggle-permiso-etiquetas" title="Permitir que los trabajadores pongan etiquetas de pago a sus clientes (el estado aparece en Citas Programadas)">
                <i class="fas fa-tags"></i> Etiquetas: ${textoPermisoEtiquetas()}
            </button>
            <button class="btn-secondary btn-small" id="export-clientes-csv" title="Exportar todos los clientes a CSV">
                <i class="fas fa-download"></i> Exportar CSV
            </button>
            <span style="color:var(--text-muted);font-size:0.85rem;" id="clientes-count">
                <i class="fas fa-users"></i> ${clientesCache.length} cliente${clientesCache.length !== 1 ? 's' : ''}
                ${filtroActual ? `(mostrando ${filtrados.length})` : ''}
            </span>
        </div>
        <p style="color:var(--text-muted);font-size:0.78rem;margin:-8px 0 14px;">
            <i class="fas fa-info-circle"></i> Los clientes solo se eliminan si los borras tú o llevan más de ${MESES_SIN_RESERVAR_PARA_ELIMINAR} meses sin reservar. Los clientes que agregas manualmente se conservan hasta que tú los borres.
        </p>
        ${renderHelpBanner()}
        <div class="clientes-grid" id="clientes-grid">
            ${renderGridHtml(filtrados)}
        </div>
    `;

    container.innerHTML = html;

    bindSearch(container);
    bindExport(container);
    bindAgregarCliente(container);
    bindMudanza(container);
    bindBienvenida(container);
    bindHelpToggle(container);
    bindTogglePermisoEtiquetas(container);
    const guiaBtn = container.querySelector('#guia-clientes-btn');
    if (guiaBtn) guiaBtn.addEventListener('click', abrirGuia);
    bindHistorialButtons(container);
    bindClienteCards(container);
}

/**
 * Banner "¿Cómo usar Mis Clientes?" — hace evidente todo lo que se puede
 * hacer en la sección (tablero del cliente: notas, datos, archivos, pago).
 * Colapsable; el estado se recuerda en localStorage (visible por defecto).
 */
function renderHelpBanner() {
    let visible = true;
    try {
        const pref = localStorage.getItem('mis_clientes_help_visible');
        if (pref === null) {
            // Primera visita: plegado en todos los tamaños. El aviso de una
            // línea (renderHintFicha) hace el descubrimiento; el detalle
            // completo queda a un toque para quien lo quiera.
            visible = false;
        } else {
            visible = pref !== '0';
        }
    } catch (e) { /* sin almacenamiento */ }
    return `
        <div class="clientes-help" style="border:1px solid rgba(157,78,221,0.28);border-radius:12px;background:linear-gradient(135deg, rgba(157,78,221,0.10), rgba(0,184,148,0.05));margin-bottom:14px;overflow:hidden;">
            <button id="toggle-clientes-help" style="width:100%;display:flex;align-items:center;gap:10px;padding:10px 14px;background:none;border:none;color:var(--text-color,#e0e0e0);cursor:pointer;font-size:0.88rem;text-align:left;">
                <i class="fas fa-lightbulb" style="color:#ffd166;"></i>
                <strong style="flex:1;">¿Cómo usar Mis Clientes? — todo lo que puedes hacer</strong>
                <i class="fas fa-chevron-down" id="clientes-help-chevron" style="transition:transform .2s;${visible ? 'transform:rotate(180deg);' : ''}"></i>
            </button>
            <div id="clientes-help-body" style="display:${visible ? 'block' : 'none'};padding:2px 16px 14px;font-size:0.83rem;color:var(--text-muted,#bbb);line-height:1.6;">
                <ul style="margin:0;padding-left:18px;">
                    <li><strong>Información</strong> (botón de la tarjeta o clic en ella): abre el tablero completo del cliente. Ahí puedes <strong>guardar datos y escribir información</strong> (listas y tarjetas, ej. "Historia clínica", "Seguimiento", "Notas"), crear <strong>checklists</strong>, <strong>subir archivos</strong> (fotos, PDF, Word, Excel… hasta 100 MB), marcar el <strong>estado de pago</strong>, guardar plantillas de listas, editar su contacto y eliminarlo.</li>
                    <li><strong>Compartir con el cliente</strong>: activa el <i class="fas fa-eye"></i> en las listas que quieras (o "Lo que ve el cliente" en el tablero) y en la tarjeta aparecerá <strong>"Enviar info"</strong>: le manda por WhatsApp un enlace donde el cliente ve <strong>solo esas listas</strong>, siempre actualizado.</li>
                    <li><strong>Historial</strong>: muestra todas sus citas (servicio, fecha, hora, precio y totales).</li>
                    <li><strong>Agregar cliente</strong>: importa clientes que ya tenías antes de la web, con reserva opcional.</li>
                    <li><strong>WhatsApp / Email / Llamar</strong>: contacto directo desde la tarjeta.</li>
                    <li><strong>Marcar pago</strong>: estado de pago del cliente con un clic.</li>
                    <li><strong>Exportar CSV</strong>: descarga todos tus clientes.</li>
                </ul>
                <p style="margin:10px 0 0;"><i class="fas fa-shield-alt" style="margin-right:4px;"></i> Los clientes solo se borran si tú los eliminas o llevan más de ${MESES_SIN_RESERVAR_PARA_ELIMINAR} meses sin reservar. Los que agregas a mano se conservan siempre.</p>
            </div>
        </div>
    `;
}

function bindHelpToggle(container) {
    const btn = document.getElementById('toggle-clientes-help');
    if (!btn) return;
    btn.addEventListener('click', () => {
        const body = document.getElementById('clientes-help-body');
        const chevron = document.getElementById('clientes-help-chevron');
        if (!body) return;
        const visible = body.style.display !== 'none';
        body.style.display = visible ? 'none' : 'block';
        if (chevron) chevron.style.transform = visible ? '' : 'rotate(180deg)';
        try { localStorage.setItem('mis_clientes_help_visible', visible ? '0' : '1'); } catch (e) { /* sin almacenamiento */ }
    });
}

function textoPermisoEtiquetas() {
    if (!permisoEtiquetas.permitir) return 'Desactivadas';
    if (permisoEtiquetas.trabajadores.length) return `${permisoEtiquetas.trabajadores.length} trabajador(es)`;
    return 'Todos los trabajadores';
}

/**
 * Mini-badges del contenido guardado en la ficha del cliente (solo se
 * muestran cuando hay algo: un cliente recién creado se ve simple, uno
 * "trabajado" delata que adentro hay más). Fotos y archivos se cuentan
 * por separado para no duplicar (n_fotos ⊂ n_adjuntos).
 */
function renderBadgesFicha(fichas) {
    if (!fichas) return '';
    const nFotos = fichas.n_fotos || 0;
    const nDocs = (fichas.n_adjuntos || 0) - nFotos;
    const nCards = fichas.n_cards || 0;
    if (!nFotos && !nDocs && !nCards) return '';
    const badges = [];
    if (nFotos) {
        badges.push(`<span class="cliente-ficha-badge cfb-foto" title="Fotos guardadas en su ficha"><i class="fas fa-image"></i> ${nFotos} foto${nFotos !== 1 ? 's' : ''}</span>`);
    }
    if (nDocs) {
        badges.push(`<span class="cliente-ficha-badge cfb-archivo" title="Archivos en su ficha: PDF, Word, Excel y más"><i class="fas fa-paperclip"></i> ${nDocs} archivo${nDocs !== 1 ? 's' : ''}</span>`);
    }
    if (nCards) {
        badges.push(`<span class="cliente-ficha-badge cfb-nota" title="Tarjetas en su tablero: notas, seguimientos y tareas"><i class="fas fa-sticky-note"></i> ${nCards} nota${nCards !== 1 ? 's' : ''}</span>`);
    }
    return `<div class="cliente-ficha-badges">${badges.join('')}</div>`;
}

function renderGridHtml(filtrados) {
    let html = '';
    const hoyLocal = formatDate(new Date());
    filtrados.forEach(cl => {
        const proxCita = cl.citas
            .filter(c => c.fecha >= hoyLocal)
            .sort((a, b) => a.fecha.localeCompare(b.fecha))[0];

        // Contenido guardado en la ficha de este cliente (badges) + listas
        // compartidas (botón WhatsApp / copiar enlace)
        const fichas = fichasPorEmail[cl.email] || null;
        const nComp = fichas ? fichas.listas_compartidas : 0;
        const enlaceComp = (nComp > 0 && fichas.token_compartido) ? kanbanApi.buildEnlaceCompartido(fichas.token_compartido) : '';

        html += `
            <div class="cliente-card glass-panel cliente-card-clickable" data-email="${escapeHtml(cl.email)}" title="Clic para abrir el tablero del cliente: guarda notas, datos, archivos y estado de pago">
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
                        ${cl.direccion ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(cl.direccion)}" target="_blank" rel="noopener noreferrer" class="cliente-direccion-link" title="Ver dirección en Google Maps / Cómo llegar"><i class="fas fa-map-marker-alt"></i> ${escapeHtml(cl.direccion)}</a>` : ''}
                        ${cl.ultimaVisita
                            ? `<span><i class="fas fa-clock"></i> Última: ${formatFechaCorta(cl.ultimaVisita)}</span>`
                            : `<span><i class="fas fa-user-plus"></i> Agregado: ${formatFechaCorta(cl.creadoEn)}</span>`}
                        ${proxCita ? `<span class="proxima-cita"><i class="fas fa-calendar-alt"></i> Próxima: ${formatFechaCorta(proxCita.fecha)} ${formatTimeDisplay(proxCita.hora)}</span>` : ''}
                    </div>
                    ${renderBadgesFicha(fichas)}
                    ${nComp > 0 ? `
                    <div style="margin:4px 0 2px;">
                        <span class="cliente-compartido-chip" title="Listas que este cliente ve a través de su enlace"><i class="fas fa-eye"></i> ${nComp} lista${nComp !== 1 ? 's' : ''} compartida${nComp !== 1 ? 's' : ''}</span>
                    </div>` : ''}
                    <div class="cliente-etiqueta-fila" data-email="${escapeHtml(cl.email)}" title="Cambiar el estado de pago del cliente (aparece en Citas Programadas)">
                        ${renderChipEtiqueta(cl.estadoPago, { clickeable: true, vacioTexto: '<i class="fas fa-tag"></i> Marcar pago' })}
                    </div>
                    <div class="cliente-actions-row">
                        ${cl.telefono ? `<a href="https://wa.me/${cl.telefono.replace(/[^0-9]/g, '')}" target="_blank" class="btn-small" style="background:#25D366;color:#fff;" title="Enviar WhatsApp"><i class="fab fa-whatsapp"></i></a>` : ''}
                        ${cl.email ? `<a href="mailto:${encodeURIComponent(cl.email)}" class="btn-small" style="background:var(--primary-color);color:#fff;" title="Enviar Email"><i class="fas fa-envelope"></i></a>` : ''}
                        ${cl.telefono ? `<a href="tel:${escapeHtml(cl.telefono)}" class="btn-small" style="background:var(--secondary-color);color:#fff;" title="Llamar"><i class="fas fa-phone"></i></a>` : ''}
                        ${nComp > 0 && enlaceComp && cl.telefono ? `
                        <button class="btn-small btn-enviar-info-cliente" data-email="${escapeHtml(cl.email)}" style="background:#128C7E;color:#fff;font-weight:600;border:none;cursor:pointer;" title="Ver cómo recibe el cliente su información y enviársela por WhatsApp">
                            <i class="fab fa-whatsapp"></i> Enviar info
                        </button>` : ''}
                        ${nComp > 0 && !enlaceComp ? `
                        <button class="btn-small btn-copiar-enlace-cliente" data-email="${escapeHtml(cl.email)}" style="background:rgba(46,230,168,0.15);color:#2ee6a8;border:1px solid rgba(46,230,168,0.3);" title="Copiar el enlace con la información compartida de este cliente">
                            <i class="fas fa-link"></i> Copiar enlace
                        </button>` : ''}
                        <button class="btn-small btn-info-cliente" data-email="${escapeHtml(cl.email)}" title="Abrir el tablero del cliente: guarda notas, datos, archivos y estado de pago">
                            <i class="fas fa-id-card"></i> Información
                        </button>
                        <button class="btn-small btn-ver-historial" data-email="${escapeHtml(cl.email)}" style="margin-left:auto;">
                            <i class="fas fa-history"></i> Historial
                        </button>
                    </div>
                </div>
                <div class="cliente-historial" id="historial-${escapeHtml(cl.email).replace(/[@.]/g, '-')}" style="display:none;"></div>
            </div>
        `;
    });
    return html;
}

function bindSearch(container) {
    const searchInput = document.getElementById('clientes-search-input');
    if (!searchInput) return;

    let debounceTimer;
    searchInput.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            filtroActual = e.target.value;
            // Re-renderizar SOLO la grilla. Re-renderizar el contenedor completo
            // destruye el input y pierde el foco (imposible escribir >1 carácter).
            const grid = container.querySelector('#clientes-grid');
            if (grid) {
                grid.innerHTML = renderGridHtml(getFiltrados());
                actualizarContador(container);
                bindHistorialButtons(container);
                bindClienteCards(container);
            } else {
                renderLista(container);
            }
        }, 300);
    });
}

function actualizarContador(container) {
    const span = container.querySelector('#clientes-count');
    if (!span) return;
    const total = clientesCache.length;
    const visibles = getFiltrados().length;
    span.innerHTML = `<i class="fas fa-users"></i> ${total} cliente${total !== 1 ? 's' : ''}${filtroActual ? ` (mostrando ${visibles})` : ''}`;
}

function bindExport(container) {
    const exportBtn = document.getElementById('export-clientes-csv');
    if (exportBtn) {
        exportBtn.addEventListener('click', exportarClientesCSV);
    }
}

function bindHistorialButtons(container) {
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
}

/**
 * Click en la tarjeta del cliente o en su botón "Información" →
 * abre el modal full-screen con listas/tarjetas/documentos del
 * cliente (ClientBoard.js). Los clicks en botones/enlaces internos
 * (WhatsApp, email, Historial...) no disparan la apertura.
 */
function bindClienteCards(container) {
    container.querySelectorAll('.btn-info-cliente').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const cliente = clientesCache.find(c => c.email.toLowerCase() === btn.dataset.email.toLowerCase());
            if (cliente) abrirInformacion(cliente);
        });
    });

    container.querySelectorAll('.cliente-card-clickable').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('button, a, input, textarea, select')) return;
            const cliente = clientesCache.find(c => c.email.toLowerCase() === card.dataset.email.toLowerCase());
            if (cliente) abrirInformacion(cliente);
        });
    });

    // Chip de etiqueta de pago del cliente (no abre la información)
    container.querySelectorAll('.cliente-etiqueta-fila').forEach(fila => {
        fila.addEventListener('click', (e) => {
            e.stopPropagation();
            cambiarEtiquetaCliente(fila);
        });
        fila.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); cambiarEtiquetaCliente(fila); }
        });
    });

    // Copiar enlace de información compartida (cliente sin teléfono o token pendiente)
    container.querySelectorAll('.btn-copiar-enlace-cliente').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const cl = clientesCache.find(c => c.email.toLowerCase() === btn.dataset.email.toLowerCase());
            if (!cl) return;
            const comp = fichasPorEmail[cl.email];
            if (!comp) return;
            try {
                let token = comp.token_compartido;
                if (!token) {
                    token = await kanbanApi.asegurarTokenCompartido(comp.board_id);
                    comp.token_compartido = token;
                }
                const ok = await copiarAlPortapapeles(kanbanApi.buildEnlaceCompartido(token));
                mostrarToast(ok ? 'Enlace copiado al portapapeles' : 'No se pudo copiar el enlace', ok ? 'success' : 'error');
            } catch (err) {
                console.error('[ClientListView] Error generando enlace compartido:', err);
                mostrarToast('No se pudo generar el enlace', 'error');
            }
        });
    });

    // "Enviar info": primera vez = simulador WhatsApp (cómo lo recibe el
    // cliente); después = WhatsApp directo.
    container.querySelectorAll('.btn-enviar-info-cliente').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const cl = clientesCache.find(c => c.email.toLowerCase() === btn.dataset.email.toLowerCase());
            if (!cl) return;
            const comp = fichasPorEmail[cl.email];
            if (!comp) return;
            try {
                let token = comp.token_compartido;
                if (!token) {
                    token = await kanbanApi.asegurarTokenCompartido(comp.board_id);
                    comp.token_compartido = token;
                }
                const enlace = kanbanApi.buildEnlaceCompartido(token);
                await enviarInfoCliente(cl, enlace);
            } catch (err) {
                console.error('[ClientListView] Error enviando información:', err);
                mostrarToast('No se pudo preparar el enlace', 'error');
            }
        });
    });
}

/** Menú de etiqueta de pago del cliente → RPC admin (todas sus citas). */
async function cambiarEtiquetaCliente(fila) {
    const email = fila.dataset.email;
    const cl = clientesCache.find(c => c.email.toLowerCase() === email.toLowerCase());
    if (!cl) return;
    abrirMenuEtiquetas(cl.estadoPago, async (clave) => {
        try {
            const { data, error } = await getSupabase().rpc('admin_set_estado_pago_cliente', {
                p_tenant_id: await getCurrentTenantId(),
                p_cliente_email: email,
                p_estado: clave || ''
            });
            if (error || !data || data.ok !== true) {
                mostrarToast((data && data.error) || 'No se pudo actualizar el estado de pago', 'error');
                return;
            }
            cl.estadoPago = clave;
            cl.citas.forEach(c => { c.estadoPago = clave; });
            const grid = document.getElementById('clientes-grid');
            if (grid) {
                grid.innerHTML = renderGridHtml(getFiltrados());
                const container = document.getElementById('clientes-list-container');
                if (container) {
                    bindHistorialButtons(container);
                    bindClienteCards(container);
                }
            }
            mostrarToast(`Estado de pago actualizado (${data.citas_actualizadas || 0} reserva(s))`, 'success');
        } catch (err) {
            console.error('[ClientListView] Error actualizando etiqueta:', err);
            mostrarToast('No se pudo actualizar el estado de pago', 'error');
        }
    });
}

// ========== PERMISO DE ETIQUETAS PARA TRABAJADORES ==========

function bindTogglePermisoEtiquetas(container) {
    const btn = document.getElementById('toggle-permiso-etiquetas');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (permisoEtiquetas.permitir) {
            if (!window.confirm('¿Desactivar las etiquetas de pago para los trabajadores? El administrador siempre podrá ponerlas.')) return;
            aplicarPermisoEtiquetas(false, null);
        } else {
            abrirPanelPermisoEtiquetas();
        }
    });
}

async function aplicarPermisoEtiquetas(permitir, trabajadoresIds) {
    try {
        const { data, error } = await getSupabase().rpc('admin_set_permiso_etiquetas', {
            p_tenant_id: await getCurrentTenantId(),
            p_permitir: permitir,
            p_trabajadores: trabajadoresIds
        });
        if (error || !data || data.ok !== true) {
            mostrarToast((data && data.error) || 'No se pudo guardar el permiso', 'error');
            return;
        }
        permisoEtiquetas.permitir = data.permitir === true;
        if (trabajadoresIds !== null) {
            permisoEtiquetas.trabajadores = (trabajadoresIds || []).map(String);
        }
        const container = document.getElementById('clientes-list-container');
        if (container) renderLista(container);
        mostrarToast(permitir
            ? (trabajadoresIds && trabajadoresIds.length ? `Permiso activado para ${trabajadoresIds.length} trabajador(es)` : 'Permiso activado para todos los trabajadores')
            : 'Permiso desactivado', 'success');
    } catch (err) {
        console.error('[ClientListView] Error guardando permiso:', err);
        mostrarToast('No se pudo guardar el permiso', 'error');
    }
}

/** Panel con las opciones al activar: todos o elegir trabajadores. */
function abrirPanelPermisoEtiquetas() {
    const overlay = document.createElement('div');
    overlay.className = 'kanban-card-overlay';
    overlay.style.zIndex = '2300';
    overlay.innerHTML = `
        <div class="etiquetas-menu" style="max-width:420px;">
            <header class="etiquetas-menu-header">
                <h4><i class="fas fa-user-check"></i> Etiquetas de pago de trabajadores</h4>
                <button class="kanban-btn-close" id="permiso-cerrar" title="Cerrar">&times;</button>
            </header>
            <div class="etiquetas-menu-body">
                <p class="kanban-hint" style="margin:0 4px 10px;">Los trabajadores podrán marcar el estado de pago de sus clientes y aparecerá en Citas Programadas. El administrador siempre puede.</p>
                <button type="button" class="etiquetas-menu-opcion" id="permiso-todos"><i class="fas fa-users"></i> Permitir a todos los trabajadores</button>
                <button type="button" class="etiquetas-menu-opcion" id="permiso-elegir"><i class="fas fa-user-cog"></i> Elegir trabajadores...</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    const cerrar = () => overlay.remove();
    document.getElementById('permiso-cerrar').addEventListener('click', cerrar);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) cerrar(); });
    document.getElementById('permiso-todos').addEventListener('click', () => { cerrar(); aplicarPermisoEtiquetas(true, []); });
    document.getElementById('permiso-elegir').addEventListener('click', () => { cerrar(); abrirSelectorTrabajadores(); });
}

/** Selector de trabajadores (lista blanca) al elegir "algunos". */
function abrirSelectorTrabajadores() {
    const lista = permisoEtiquetas.trabajadoresLista || [];
    if (!lista.length) {
        mostrarToast('No hay trabajadores activos para elegir', 'warning');
        return;
    }
    const seleccionados = new Set(permisoEtiquetas.trabajadores.map(String));

    const overlay = document.createElement('div');
    overlay.className = 'kanban-card-overlay';
    overlay.style.zIndex = '2300';
    overlay.innerHTML = `
        <div class="etiquetas-menu" style="max-width:420px;">
            <header class="etiquetas-menu-header">
                <h4><i class="fas fa-user-cog"></i> ¿Quiénes pueden poner etiquetas?</h4>
                <button class="kanban-btn-close" id="selector-cerrar" title="Cerrar">&times;</button>
            </header>
            <div class="etiquetas-menu-body">
                <p class="kanban-hint" style="margin:0 4px 10px;">Solo los trabajadores seleccionados podrán marcar el estado de pago de sus clientes.</p>
                ${lista.map(t => `
                    <label class="etiquetas-menu-opcion" style="cursor:pointer;">
                        <input type="checkbox" data-trabajador-id="${t.id}" ${seleccionados.has(String(t.id)) ? 'checked' : ''} style="accent-color:#9d4edd;width:16px;height:16px;">
                        <span style="flex:1;">${escapeHtml(t.nombre)}</span>
                    </label>
                `).join('')}
                <button type="button" class="btn-primary" id="selector-guardar" style="margin-top:8px;padding:10px;"><i class="fas fa-save"></i> Guardar selección</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    const cerrar = () => overlay.remove();
    document.getElementById('selector-cerrar').addEventListener('click', cerrar);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) cerrar(); });
    document.getElementById('selector-guardar').addEventListener('click', () => {
        const ids = [...overlay.querySelectorAll('input[data-trabajador-id]:checked')].map(cb => cb.dataset.trabajadorId);
        cerrar();
        aplicarPermisoEtiquetas(true, ids);
    });
}

async function abrirInformacion(cliente) {
    try {
        // Citas del cliente enriquecidas con el nombre real del servicio
        // (la cita solo guarda servicio_id; el modal las muestra en el selector).
        const citasConServicio = (cliente.citas || []).map(c => ({
            id: c.id,
            fecha: c.fecha,
            hora: c.hora,
            precio: c.precio,
            servicio: mapaServicios[c.servicioId] || 'Servicio'
        }));
        const { abrirInformacionCliente, configurarClientBoard } = await import('./ClientBoard.js');
        // Al cerrar el tablero, refrescar Mis Clientes: así los cambios de
        // "compartir con el cliente" se reflejan en la card al instante.
        configurarClientBoard({ onCerrarBoard: () => { try { renderClientListView(); } catch (e) { /* sin listado */ } } });
        // Pasa también la lista de clientes del tenant para poder
        // aplicar un "estilo de listas" guardado a todos con un clic.
        await abrirInformacionCliente(cliente, citasConServicio, clientesCache);
    } catch (err) {
        console.error('[ClientListView] Error abriendo información del cliente:', err);
        mostrarToast('No se pudo abrir la información del cliente', 'error');
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
        // Nombre real del servicio: la cita solo guarda servicio_id
        const nombreServicio = mapaServicios[c.servicioId] || '—';
        html += `
            <div class="historial-row ${esPasada ? 'past' : 'future'}" style="display:flex;align-items:center;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.05);font-size:0.85rem;">
                <span style="flex:1;">${escapeHtml(nombreServicio)}</span>
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
        csv += `${nombre},${email},${telefono},${cl.visitas},${cl.totalGastado},${cl.ultimaVisita || cl.creadoEn || ''},${cl.primeraVisita || ''}\n`;
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

/** Texto del mensaje con la información compartida (neutro, editable en el simulador). */
function mensajeInfoCliente(cl, enlace) {
    const nombre = (cl.nombre && cl.nombre !== 'Sin nombre') ? cl.nombre.split(' ')[0] : '';
    const saludo = nombre ? `¡Hola ${nombre}! 👋` : '¡Hola! 👋';
    return `${saludo}\nTe compartí información a través de Organify. Abre este enlace para verla:\n${enlace}\n\nEste enlace es solo para ti: cualquier cambio que haga se ve actualizado ahí.`;
}

/** Enlace de WhatsApp con el mensaje de información compartida del cliente. */
function buildWaInfoCliente(cl, enlace) {
    return `https://wa.me/${cl.telefono.replace(/[^0-9]/g, '')}?text=${encodeURIComponent(mensajeInfoCliente(cl, enlace))}`;
}

/**
 * "Enviar info": la primera vez muestra el simulador de WhatsApp (cómo
 * recibe el cliente el mensaje, editable); después abre WhatsApp directo.
 */
async function enviarInfoCliente(cl, enlace) {
    const mensaje = mensajeInfoCliente(cl, enlace);
    let sim;
    try {
        sim = await import('../../share/ui/SimuladorWhatsApp.js');
    } catch (err) {
        console.warn('[ClientListView] No se pudo cargar el simulador:', err);
        window.open(buildWaInfoCliente(cl, enlace), '_blank', 'noopener');
        return;
    }
    if (!sim.shareSimPendiente()) {
        window.open(buildWaInfoCliente(cl, enlace), '_blank', 'noopener');
        return;
    }
    sim.abrirSimuladorWhatsApp({
        nombreCliente: cl.nombre,
        telefono: cl.telefono,
        enlace,
        mensaje
    });
}

/** Copia texto al portapapeles (con fallback). Devuelve true/false. */
async function copiarAlPortapapeles(texto) {
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

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
