// clients/ui/MudanzaModal.js
// "Traer mis clientes y archivos" — Centro de Mudanza (Mis Clientes → admin).
// Asistente de 3 pasos para migrar lo que el negocio ya tenía antes de la web:
//   PASO 1 · Traer los clientes: pegar filas de Excel/Sheets o subir CSV,
//            con detección de columnas (sinónimos en español), vista previa
//            y resumen honesto (nuevos / actualizados / omitidos).
//   PASO 2 · Subir los archivos en montón: la web los distribuye sola entre
//            los clientes leyendo el nombre del archivo ("María - historia.docx").
//   PASO 3 · Archivos sin dueño: se asignan con un toque ("Mandar a:") o se
//            descartan. Si el cliente no existe, se crea en el momento.
// Reglas de la casa: RPCs con validación por tenant (admin_agregar_cliente /
// admin_archivo_crear_subido), nunca service_role; emails sintetizados con el
// patrón walkin.<tel>@sinemail.local cuando falta correo; avisos suaves; doble
// confirmación antes de descartar archivos sin dueño (no se pierde nada sin avisar).
import { getCurrentTenantId } from '../../shared/infrastructure/router.js';
import { getSupabase } from '../../shared/infrastructure/supabase.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';

const INPUT_STYLE = 'width:100%;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.10);color:var(--text-color,#e0e0e0);box-sizing:border-box;font-size:0.9rem;outline:none;font-family:inherit;';
const TEXTAREA_STYLE = INPUT_STYLE + 'min-height:120px;resize:vertical;line-height:1.5;';
const BTN_PRI = 'padding:9px 16px;border-radius:10px;background:linear-gradient(135deg,var(--primary-color,#9d4edd),#7b2cbf);border:none;color:#fff;cursor:pointer;font-size:0.85rem;font-weight:600;display:inline-flex;align-items:center;gap:7px;box-shadow:0 4px 14px rgba(157,78,221,0.3);';
const BTN_SEC = 'padding:8px 14px;border-radius:10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:var(--text-color,#e0e0e0);cursor:pointer;font-size:0.82rem;display:inline-flex;align-items:center;gap:6px;';
const CARD_STYLE = 'border-radius:12px;border:1px solid rgba(255,255,255,0.06);background:linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01));padding:14px;margin-bottom:14px;';
const AVISO_STYLE = 'display:flex;gap:8px;align-items:flex-start;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);font-size:0.78rem;color:var(--text-muted,#aaa);line-height:1.45;';
const MIME_ACEPTADOS = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/rtf',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain', 'text/csv',
    'application/zip'
];

// ========== Helpers ==========

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Normaliza texto para comparar: minúsculas, sin acentos, solo alfanumérico. */
function normalizar(s) {
    return String(s || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '')
        .trim();
}

function formatearTamano(bytes) {
    if (!bytes && bytes !== 0) return '';
    const n = Number(bytes);
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function iconoPorArchivo(nombre) {
    const n = String(nombre || '').toLowerCase();
    if (/\.(png|jpe?g|gif|webp|svg)$/.test(n)) return 'fa-image';
    if (/\.pdf$/.test(n)) return 'fa-file-pdf';
    if (/\.(docx?|rtf|odt)$/.test(n)) return 'fa-file-word';
    if (/\.(xlsx?|ods|csv)$/.test(n)) return 'fa-file-excel';
    if (/\.(pptx?|odp)$/.test(n)) return 'fa-file-powerpoint';
    if (/\.zip$/.test(n)) return 'fa-file-archive';
    return 'fa-file';
}

/** Parsea texto delimitado (coma, punto y coma o tabulación) respetando comillas y BOM. */
function parsearDelimitado(texto) {
    const txt = String(texto || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
    if (!txt) return [];
    const primera = txt.split('\n')[0];
    const conteo = (c) => (primera.match(new RegExp(c, 'g')) || []).length;
    const delim = conteo('\t') > conteo(';') && conteo('\t') >= conteo(',') ? '\t'
        : (conteo(';') >= conteo(',') ? ';' : ',');
    const filas = [];
    let fila = [], celda = '', enComillas = false;
    for (let i = 0; i < txt.length; i++) {
        const ch = txt[i];
        if (enComillas) {
            if (ch === '"') {
                if (txt[i + 1] === '"') { celda += '"'; i++; }
                else enComillas = false;
            } else celda += ch;
        } else if (ch === '"') {
            enComillas = true;
        } else if (ch === delim) {
            fila.push(celda); celda = '';
        } else if (ch === '\n') {
            fila.push(celda); filas.push(fila); fila = []; celda = '';
        } else {
            celda += ch;
        }
    }
    fila.push(celda); filas.push(fila);
    return filas.filter(f => f.some(c => String(c).trim() !== ''));
}

/** Detecta si la primera fila parece encabezado y mapea columnas a campos. */
function detectarColumnas(filas) {
    const sinonimos = {
        nombre: ['nombre', 'cliente', 'paciente', 'contacto', 'titular', 'name', 'nombrecompleto', 'nombreyapellido', 'nombres', 'cliente nombre'],
        telefono: ['telefono', 'celular', 'movil', 'whatsapp', 'cel', 'tel', 'phone', 'numero', 'telefonos', 'movil whatsapp', 'celular whatsapp'],
        email: ['email', 'correo', 'mail', 'correoelectronico', 'correo electronico', 'e mail', 'email cliente'],
        direccion: ['direccion', 'domicilio', 'address', 'ubicacion', 'comuna', 'ciudad', 'barrio', 'direccion cliente']
    };
    const norm = (s) => normalizar(s).replace(/[._-]/g, '');
    if (!filas.length) return { esEncabezado: false, mapa: { nombre: 0, telefono: 1, email: 2, direccion: 3 } };

    const primera = filas[0];
    const mapa = { nombre: -1, telefono: -1, email: -1, direccion: -1 };
    primera.forEach((celda, idx) => {
        const c = norm(celda);
        if (!c) return;
        for (const campo of Object.keys(sinonimos)) {
            if (mapa[campo] !== -1) continue;
            if (sinonimos[campo].some(s => c === norm(s) || c.includes(norm(s)))) { mapa[campo] = idx; break; }
        }
    });
    const detectados = Object.values(mapa).filter(i => i !== -1).length;
    if (detectados >= 2 || mapa.nombre !== -1) {
        return { esEncabezado: true, mapa };
    }
    // Sin encabezado: asumimos orden nombre, teléfono, correo, dirección.
    const nCols = primera.length;
    return {
        esEncabezado: false,
        mapa: { nombre: 0, telefono: nCols > 1 ? 1 : -1, email: nCols > 2 ? 2 : -1, direccion: nCols > 3 ? 3 : -1 }
    };
}

function emailSintetico(telefono) {
    const dig = String(telefono || '').replace(/\D/g, '');
    return dig ? `walkin.${dig}@sinemail.local` : '';
}

function descargarPlantilla() {
    const contenido = '\uFEFFnombre,telefono,correo,direccion\n' +
        'Ejemplo: María García,+56 9 1234 5678,maria@correo.com,\n';
    const blob = new Blob([contenido], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'plantilla-clientes.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

/** Sube un binario al bucket privado (mismo patrón XHR que kanbanApi). */
function subirBinario(file, tenantId) {
    const supabase = getSupabase();
    const nombreLimpio = (file.name || 'archivo')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    const storagePath = `${tenantId}/entrada/mudanza-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${nombreLimpio}`;
    return (async () => {
        let token = null;
        try {
            const { data } = await supabase.auth.getSession();
            token = data?.session?.access_token || null;
        } catch (e) { /* sin token */ }
        const url = `${supabase.supabaseUrl}/storage/v1/object/kanban-adjuntos/${storagePath}`;
        const key = supabase.supabaseKey;
        await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', url);
            if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
            if (key) xhr.setRequestHeader('apikey', key);
            xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
            xhr.setRequestHeader('x-upsert', 'false');
            xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload ${xhr.status}`)));
            xhr.onerror = () => reject(new Error('Error de red'));
            xhr.send(file);
        });
        return storagePath;
    })();
}

async function poolLimit(items, limite, fn) {
    const resultados = new Array(items.length);
    let idx = 0;
    const trabajadores = Array.from({ length: Math.min(limite, items.length) }, async () => {
        while (idx < items.length) {
            const i = idx++;
            resultados[i] = await fn(items[i], i);
        }
    });
    await Promise.all(trabajadores);
    return resultados;
}

// ========== Modal ==========

/**
 * Abre el Centro de Mudanza.
 * @param {object} opts
 * @param {Array} opts.clientes  [{ nombre, email, telefono }] clientes actuales
 * @param {Function} [opts.onTerminado]  callback al finalizar (refresca la lista)
 */
export async function abrirCentroMudanza({ clientes = [], onTerminado } = {}) {
    const tenantId = await getCurrentTenantId();
    if (!tenantId) {
        mostrarToast('No se pudo identificar el negocio', 'error');
        return;
    }
    const supabase = getSupabase();

    // ========== Estado ==========
    const state = {
        paso: 1,
        clientesTrabajo: (clientes || []).map(c => ({ nombre: c.nombre || '', email: String(c.email || '').trim().toLowerCase(), telefono: c.telefono || '' })),
        filasBruto: [],        // filas parseadas (arrays) sin encabezado
        esEncabezado: false,
        mapa: { nombre: 0, telefono: 1, email: 2, direccion: 3 },
        colCount: 0,
        importado: false,
        resumenImport: null,
        archivos: [],          // { id, file, clienteEmail, storagePath, estado }
        subidaConfirmada: false
    };
    let cerrado = false;
    let ocupado = false;
    let idSeq = 0;

    // ========== Overlay ==========
    const overlay = document.createElement('div');
    overlay.className = 'kanban-card-overlay';
    overlay.style.zIndex = '2500';
    overlay.innerHTML = `
        <div class="glass-panel" style="max-width:760px;width:95%;max-height:94vh;overflow-y:auto;padding:0;border-radius:16px;display:flex;flex-direction:column;">
            <header style="padding:16px 20px 12px;border-bottom:1px solid rgba(255,255,255,0.08);position:sticky;top:0;background:linear-gradient(135deg, rgba(157,78,221,0.16), rgba(0,184,148,0.06));z-index:1;border-radius:16px 16px 0 0;">
                <div style="display:flex;align-items:center;gap:12px;">
                    <div style="width:42px;height:42px;border-radius:12px;background:linear-gradient(135deg,var(--primary-color,#9d4edd),#00b894);display:flex;align-items:center;justify-content:center;color:#fff;font-size:1.05rem;flex-shrink:0;box-shadow:0 4px 14px rgba(157,78,221,0.35);">
                        <i class="fas fa-truck-moving"></i>
                    </div>
                    <div style="flex:1;min-width:0;">
                        <h4 style="margin:0;font-size:1.02rem;"><strong>Traer mis clientes y archivos</strong></h4>
                        <p style="margin:2px 0 0;font-size:0.76rem;color:var(--text-muted,#aaa);">Tu mudanza en 3 pasos: lo que ya tenías en Excel, Word o Drive entra acá sin re-escribir nada.</p>
                    </div>
                    <button class="kanban-btn-close" id="mud-cerrar" title="Cerrar">&times;</button>
                </div>
                <div id="mud-pasos" style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;"></div>
            </header>

            <div style="padding:16px 20px;flex:1;" id="mud-cuerpo"></div>

            <footer style="display:flex;gap:10px;justify-content:space-between;align-items:center;padding:12px 20px;border-top:1px solid rgba(255,255,255,0.08);position:sticky;bottom:0;background:var(--card-bg,#1a1a2e);border-radius:0 0 16px 16px;">
                <button class="btn-secondary" id="mud-atras" style="${BTN_SEC}"><i class="fas fa-arrow-left"></i> Atrás</button>
                <div style="display:flex;gap:8px;">
                    <button class="btn-secondary" id="mud-cancelar" style="${BTN_SEC}">Cancelar</button>
                    <button class="btn-primary" id="mud-siguiente" style="${BTN_PRI}">Siguiente <i class="fas fa-arrow-right"></i></button>
                </div>
            </footer>
        </div>
    `;
    document.body.appendChild(overlay);

    const $ = (id) => overlay.querySelector('#' + id);
    const $cuerpo = $('mud-cuerpo');
    const $atras = $('mud-atras');
    const $siguiente = $('mud-siguiente');

    const BTN_PELIGRO = 'padding:6px 10px;border-radius:8px;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.22);color:#ff6b6b;cursor:pointer;font-size:0.74rem;';

    // ========== Cierre con protección ==========
    function tieneTrabajoPendiente() {
        if (state.archivos.some(a => a.estado === 'sin_dueño')) return 'sin_dueño';
        if (state.archivos.some(a => a.estado === 'pendiente')) return 'pendientes';
        if ((state.filasBruto.length && !state.importado) || state.resumenImport) return 'datos';
        return null;
    }
    function cerrar() {
        if (cerrado) return;
        cerrado = true;
        document.removeEventListener('keydown', escHandler, true);
        overlay.remove();
    }
    // Escape en CAPTURE + stopImmediatePropagation: ningún otro handler global
    // (páginas admin) debe cerrar cosas por detrás mientras la Mudanza está abierta.
    function escHandler(e) {
        if (e.key !== 'Escape') return;
        e.stopImmediatePropagation();
        pedirCerrar();
    }
    function pedirCerrar() {
        if (ocupado) { mostrarToast('Esperá a que termine la operación actual', 'warning'); return; }
        const pend = tieneTrabajoPendiente();
        if (pend === 'sin_dueño') {
            const n = state.archivos.filter(a => a.estado === 'sin_dueño').length;
            if (!window.confirm(`Quedan ${n} archivo(s) sin dueño que se descartarán (no se guardan en ningún cliente). ¿Cerrar igual?`)) return;
        } else if (pend === 'pendientes') {
            if (!window.confirm('Hay archivos agregados que todavía no se subieron. ¿Cerrar y descartarlos?')) return;
        } else if (pend === 'datos') {
            if (!window.confirm('Hay información preparada que no se importó. ¿Cerrar y descartarla?')) return;
        }
        limpiarSinDueno().finally(cerrar);
    }
    $('mud-cerrar').addEventListener('click', pedirCerrar);
    $('mud-cancelar').addEventListener('click', pedirCerrar);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) pedirCerrar(); });
    document.addEventListener('keydown', escHandler, true);
    $atras.addEventListener('click', () => { if (!ocupado) irPaso(state.paso - 1); });
    $siguiente.addEventListener('click', () => {
        if (ocupado) return;
        if (state.paso === 3) finalizarMudanza();
        else avanzar();
    });

    /** Borra de Storage los archivos sin dueño (best effort) al cerrar. */
    async function limpiarSinDueno() {
        const sinDueno = state.archivos.filter(a => a.estado === 'sin_dueño' && a.storagePath);
        if (!sinDueno.length) return;
        try {
            await supabase.storage.from('kanban-adjuntos').remove(sinDueno.map(a => a.storagePath)).catch(() => {});
        } catch (e) { /* best effort */ }
    }

    // ========== Pasos (indicador + navegación) ==========
    const PASOS = [
        { n: 1, titulo: 'Traer los clientes', icono: 'fa-users' },
        { n: 2, titulo: 'Subir sus archivos', icono: 'fa-cloud-upload-alt' },
        { n: 3, titulo: 'Archivos sin dueño', icono: 'fa-question-circle' }
    ];
    function pintarPasos() {
        const sinDuenoCount = state.archivos.filter(a => a.estado === 'sin_dueño').length;
        $('mud-pasos').innerHTML = PASOS.map(p => {
            const activo = state.paso === p.n;
            const hecho = (p.n === 1 && state.importado) || (p.n === 2 && state.subidaConfirmada) || (p.n === 3 && sinDuenoCount === 0 && state.subidaConfirmada);
            return `
                <div style="display:flex;align-items:center;gap:8px;padding:7px 12px;border-radius:999px;font-size:0.76rem;${activo ? 'background:rgba(157,78,221,0.16);border:1px solid rgba(157,78,221,0.35);color:var(--text-color,#e0e0e0);' : 'background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);color:var(--text-muted,#999);'}">
                    <i class="fas ${hecho ? 'fa-check-circle' : p.icono}" style="${hecho ? 'color:#00b894;' : ''}"></i>
                    <span>${p.n}. ${p.titulo}</span>
                    ${p.n === 3 && sinDuenoCount ? `<span style="background:rgba(255,193,7,0.15);color:#ffc107;border-radius:999px;padding:0 7px;font-size:0.7rem;">${sinDuenoCount}</span>` : ''}
                </div>`;
        }).join('');
    }
    function irPaso(n) {
        if (n < 1 || n > 3) return;
        state.paso = n;
        pintarPasos();
        renderCuerpo();
        pintarFooter();
    }
    function avanzar() {
        if (state.paso === 1) {
            if (!state.importado && state.resumenImport && !state.resumenImport.terminado) {
                mostrarToast('Terminá la importación de clientes primero', 'warning');
                return;
            }
            irPaso(2);
        } else if (state.paso === 2) {
            const pendientes = state.archivos.some(a => a.estado === 'pendiente');
            if (pendientes) { mostrarToast('Confirmá la subida de los archivos agregados (o quitálos)', 'warning'); return; }
            irPaso(3);
        }
    }
    function pintarFooter() {
        $atras.style.visibility = state.paso > 1 ? 'visible' : 'hidden';
        if (state.paso === 3) {
            $siguiente.innerHTML = '<i class="fas fa-flag-checkered"></i> Finalizar mudanza';
            const sinDuenoCount = state.archivos.filter(a => a.estado === 'sin_dueño').length;
            $siguiente.disabled = sinDuenoCount > 0 || ocupado;
        } else {
            $siguiente.innerHTML = 'Siguiente <i class="fas fa-arrow-right"></i>';
            $siguiente.disabled = false;
        }
        $siguiente.style.opacity = $siguiente.disabled ? '0.5' : '';
        $siguiente.style.cursor = $siguiente.disabled ? 'not-allowed' : '';
    }

    // ========== RENDER POR PASO ==========
    function renderCuerpo() {
        if (state.paso === 1) renderPaso1();
        else if (state.paso === 2) renderPaso2();
        else renderPaso3();
    }

    // ---------- PASO 1 · Importar clientes ----------
    function renderPaso1() {
        const resumen = state.resumenImport;
        let html = `
            <div style="${CARD_STYLE}">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">
                    <i class="fas fa-file-excel" style="color:#00b894;font-size:1rem;"></i>
                    <strong style="font-size:0.9rem;">¿Ya tenés tus clientes en Excel o Google Sheets?</strong>
                </div>
                <p style="margin:0 0 10px;font-size:0.78rem;color:var(--text-muted,#aaa);line-height:1.5;">
                    Pegá las filas copiadas de tu planilla (Ctrl+C → Ctrl+V), o subí el archivo CSV. Reconoceremos las columnas solos:
                    nombre, teléfono, correo y dirección. Los que ya existen se actualizan en vez de duplicarse.
                </p>
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
                    <button class="btn-primary btn-small" id="mud1-plantilla" style="${BTN_PRI};padding:7px 12px;font-size:0.78rem;"><i class="fas fa-file-download"></i> Descargar plantilla</button>
                    <label style="${BTN_SEC};cursor:pointer;padding:7px 12px;font-size:0.78rem;"><i class="fas fa-upload"></i> Subir archivo CSV<input type="file" id="mud1-csv" accept=".csv,text/csv" style="display:none;"></label>
                </div>
                <textarea id="mud1-texto" placeholder="Pegá acá tus clientes...&#10;&#10;Ejemplo:&#10;María García, +56 9 1234 5678, maria@correo.com, Av. Siempre Viva 123&#10;Juan Pérez, +56 9 9876 5432, juan@correo.com,&#10;" style="${TEXTAREA_STYLE}"></textarea>
                <div style="display:flex;justify-content:flex-end;margin-top:10px;">
                    <button class="btn-primary" id="mud1-preparar" style="${BTN_PRI}"><i class="fas fa-magic"></i> Preparar importación</button>
                </div>
            </div>
            <div id="mud1-resultado"></div>
        `;
        $cuerpo.innerHTML = html;

        $('mud1-plantilla').addEventListener('click', descargarPlantilla);
        const csvInput = $('mud1-csv');
        csvInput.addEventListener('change', () => {
            const f = csvInput.files && csvInput.files[0];
            if (!f) return;
            const reader = new FileReader();
            reader.onload = () => {
                $('mud1-texto').value = String(reader.result || '');
                csvInput.value = '';
            };
            reader.readAsText(f);
        });
        $('mud1-preparar').addEventListener('click', prepararImportacion);
    }

    function prepararImportacion() {
        const texto = ($('mud1-texto') ? $('mud1-texto').value : '').trim();
        if (!texto) { mostrarToast('Pegá tus clientes o subí un CSV primero', 'warning'); return; }
        const filas = parsearDelimitado(texto);
        if (!filas.length) { mostrarToast('No se encontraron filas para importar', 'warning'); return; }

        const det = detectarColumnas(filas);
        state.esEncabezado = det.esEncabezado;
        state.mapa = det.mapa;
        state.filasBruto = det.esEncabezado ? filas.slice(1) : filas;
        state.colCount = Math.max(...state.filasBruto.map(f => f.length).concat(0), 0);
        state.resumenImport = null;
        state.importado = false;
        renderPreparacion();
    }

    function filaACliente(fila) {
        const get = (campo) => {
            const idx = state.mapa[campo];
            return idx !== undefined && idx !== -1 && idx < fila.length ? String(fila[idx] || '').trim() : '';
        };
        let nombre = get('nombre');
        const telefono = get('telefono');
        let email = get('email').toLowerCase();
        const direccion = get('direccion');
        if (!email && telefono) email = emailSintetico(telefono);
        if (!nombre && email) nombre = email.split('@')[0].replace(/[._-]+/g, ' ').trim();
        if (nombre) nombre = nombre.replace(/\s+/g, ' ').trim();
        return { nombre, telefono, email, direccion };
    }

    function renderPreparacion() {
        const clientes = state.filasBruto.map(filaACliente);
        const conNombre = clientes.filter(c => c.nombre);
        const sinDatos = clientes.filter(c => !c.nombre && !c.email && !c.telefono).length;
        const totalValidas = conNombre.length;
        const preview = clientes.slice(0, 5);

        // Columnas disponibles para el mapeo manual
        const campos = [
            { key: 'nombre', etiqueta: 'Nombre del cliente', icono: 'fa-user' },
            { key: 'telefono', etiqueta: 'Teléfono', icono: 'fa-phone-alt' },
            { key: 'email', etiqueta: 'Correo', icono: 'fa-envelope' },
            { key: 'direccion', etiqueta: 'Dirección', icono: 'fa-map-marker-alt' }
        ];

        let html = `
            <div style="${CARD_STYLE};border-color:rgba(157,78,221,0.3);">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
                    <i class="fas fa-list-check" style="color:var(--primary-color,#9d4edd);"></i>
                    <strong style="font-size:0.9rem;">Vista previa de la importación</strong>
                    <span style="margin-left:auto;font-size:0.8rem;color:var(--text-muted,#999);">${state.filasBruto.length} fila(s) leídas</span>
                </div>
                <p style="margin:0 0 10px;font-size:0.76rem;color:var(--text-muted,#aaa);">
                    ${state.esEncabezado
                        ? 'Detectamos los encabezados de tu planilla y asignamos las columnas solos. Ajustá si hace falta:'
                        : 'Tu planilla no tenía encabezados reconocibles: asumimos el orden nombre, teléfono, correo, dirección. Ajustá si hace falta:'}
                </p>
                <div id="mud1-mapeo" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:12px;">
                    ${campos.map(campo => `
                        <div>
                            <label style="display:block;font-size:0.72rem;color:var(--text-muted,#aaa);margin-bottom:4px;"><i class="fas ${campo.icono}"></i> ${campo.etiqueta}</label>
                            <select data-campo="${campo.key}" style="${INPUT_STYLE};padding:7px 10px;font-size:0.8rem;">
                                <option value="-1">— No usar —</option>
                ${Array.from({ length: state.colCount }, (_, i) => {
                                    const ej = state.filasBruto[0] ? (state.filasBruto[0][i] || '') : '';
                                    return `<option value="${i}" ${state.mapa[campo.key] === i ? 'selected' : ''}>Columna ${i + 1}${ej ? `: ${String(ej).slice(0, 18)}` : ''}</option>`;
                                }).join('')}
                            </select>
                        </div>`).join('')}
                </div>

                ${preview.length ? `
                <div style="overflow-x:auto;border-radius:10px;border:1px solid rgba(255,255,255,0.08);margin-bottom:8px;">
                    <table style="width:100%;border-collapse:collapse;font-size:0.76rem;">
                        <thead><tr style="background:rgba(255,255,255,0.03);color:var(--text-muted,#999);">
                            <th style="padding:7px 10px;text-align:left;">Nombre</th><th style="padding:7px 10px;text-align:left;">Teléfono</th>
                            <th style="padding:7px 10px;text-align:left;">Correo</th><th style="padding:7px 10px;text-align:left;">Dirección</th>
                        </tr></thead>
                <tbody>${preview.map(c => {
                    const nombreHtml = c.nombre ? escapeHtml(c.nombre) : '<span style="color:#ff6b6b;">sin nombre</span>';
                    return `
                        <tr style="border-top:1px solid rgba(255,255,255,0.05);">
                            <td style="padding:6px 10px;">${nombreHtml}</td>
                            <td style="padding:6px 10px;color:var(--text-muted,#bbb);">${escapeHtml(c.telefono)}</td>
                            <td style="padding:6px 10px;color:var(--text-muted,#bbb);">${escapeHtml(c.email)}</td>
                            <td style="padding:6px 10px;color:var(--text-muted,#bbb);">${escapeHtml(c.direccion)}</td>
                        </tr>`;
                }).join('')}
                        </tbody>
                    </table>
                </div>` : ''}

                <p id="mud1-resumen-p" style="margin:8px 0 0;font-size:0.78rem;color:var(--text-muted,#bbb);">
                    <i class="fas fa-info-circle"></i>
                    <strong>${totalValidas}</strong> cliente(s) se importarán${sinDatos ? ` · <span style="color:#ffc107;">${sinDatos} fila(s) vacías se ignorarán</span>` : ''}.
                    Sin correo no hay problema: generamos uno interno para que el cliente quede igual.
                </p>
                <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;flex-wrap:wrap;">
                    <button class="btn-secondary" id="mud1-volver" style="${BTN_SEC}">Volver a pegar</button>
                    <button class="btn-primary" id="mud1-importar" style="${BTN_PRI}" ${totalValidas ? '' : 'disabled'}><i class="fas fa-user-plus"></i> Importar ${totalValidas} cliente(s)</button>
                </div>
                <div id="mud1-progreso" style="display:none;margin-top:10px;"></div>
            </div>
        `;
        const $res = $('mud1-resultado');
        $res.innerHTML = html;

        // Mapeo manual → re-render preview simplificada con el nuevo mapeo
        $res.querySelectorAll('select[data-campo]').forEach(sel => {
            sel.addEventListener('change', () => {
                state.mapa[sel.dataset.campo] = Number(sel.value);
                const filas = state.filasBruto.map(filaACliente);
                const total = filas.filter(c => c.nombre).length;
                const btn = $res.querySelector('#mud1-importar');
                if (btn) { btn.disabled = !total; btn.innerHTML = `<i class="fas fa-user-plus"></i> Importar ${total} cliente(s)`; }
                const resumenP = $res.querySelector('#mud1-resumen-p');
                if (resumenP) {
                    resumenP.innerHTML = `<i class="fas fa-info-circle"></i> <strong>${total}</strong> cliente(s) listo(s) para importar. Sin correo no hay problema: generamos uno interno.`;
                }
            });
        });
        const volverBtn = $res.querySelector('#mud1-volver');
        if (volverBtn) volverBtn.addEventListener('click', renderPaso1);
        $res.querySelector('#mud1-importar').addEventListener('click', () => importarClientes());
    }

    async function importarClientes() {
        const filas = state.filasBruto.map(filaACliente).filter(c => c.nombre);
        if (!filas.length) { mostrarToast('No hay clientes para importar', 'warning'); return; }
        ocupado = true;
        pintarFooter();
        const $prog = $('mud1-progreso');
        $prog.style.display = 'block';
        $prog.innerHTML = `
            <div style="padding:10px 12px;border-radius:10px;background:rgba(157,78,221,0.07);border:1px solid rgba(157,78,221,0.2);">
                <div style="display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:6px;">
                    <span><i class="fas fa-spinner fa-spin"></i> Importando clientes...</span>
                    <span id="mud1-prog-pct" style="color:var(--text-muted,#999);">0/${filas.length}</span>
                </div>
                <div style="height:7px;border-radius:4px;background:rgba(255,255,255,0.08);overflow:hidden;">
                    <div id="mud1-prog-bar" style="height:100%;width:0%;border-radius:4px;background:linear-gradient(90deg,var(--primary-color,#9d4edd),#00b894);transition:width .15s;"></div>
                </div>
                <div id="mud1-prog-detalle" style="font-size:0.72rem;color:var(--text-muted,#999);margin-top:6px;"></div>
            </div>`;
        const $barra = $('mud1-prog-bar');
        const $pct = $('mud1-prog-pct');
        const $det = $('mud1-prog-detalle');

        const resumen = { nuevos: 0, actualizados: 0, omitidos: [] };
        let hechos = 0;
        const visor = (cliente) => { if ($det) $det.textContent = cliente.nombre; };

        await poolLimit(filas, 3, async (cliente) => {
            try {
                const { data, error } = await supabase.rpc('admin_agregar_cliente', {
                    p_tenant_id: tenantId,
                    p_nombre: cliente.nombre,
                    p_telefono: cliente.telefono || '',
                    p_email: cliente.email || emailSintetico(cliente.telefono),
                    p_direccion: cliente.direccion || ''
                });
                if (error || !data || data.ok !== true) {
                    resumen.omitidos.push({ nombre: cliente.nombre, motivo: (data && data.error) || (error && error.message) || 'error' });
                } else if (data.ya_existia) {
                    resumen.actualizados++;
                } else {
                    resumen.nuevos++;
                    const email = String(cliente.email || emailSintetico(cliente.telefono)).toLowerCase().trim();
                    if (!state.clientesTrabajo.some(c => c.email === email)) {
                        state.clientesTrabajo.push({ nombre: cliente.nombre, email, telefono: cliente.telefono || '' });
                    }
                }
            } catch (e) {
                resumen.omitidos.push({ nombre: cliente.nombre, motivo: 'error de conexión' });
            } finally {
                hechos++;
                if ($barra) $barra.style.width = `${Math.round((hechos / filas.length) * 100)}%`;
                if ($pct) $pct.textContent = `${hechos}/${filas.length}`;
            }
        });

        resumen.terminado = true;
        state.resumenImport = resumen;
        state.importado = true;
        ocupado = false;
        pintarPasos();
        pintarFooter();
        renderResumenImport(resumen);
    }

    function renderResumenImport(resumen) {
        $('mud1-resultado').innerHTML = `
            <div style="${CARD_STYLE};border-color:rgba(0,184,148,0.3);">
                <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
                    <div style="width:44px;height:44px;border-radius:50%;background:rgba(0,184,148,0.15);display:flex;align-items:center;justify-content:center;color:#00b894;font-size:1.2rem;flex-shrink:0;"><i class="fas fa-check"></i></div>
                    <div style="flex:1;min-width:180px;">
                        <strong style="font-size:0.95rem;">¡Listo! Tus clientes ya están en la web</strong>
                        <p style="margin:2px 0 0;font-size:0.78rem;color:var(--text-muted,#aaa);">Se fueron agregando a Mis Clientes. Los que reserven desde la web se suman solos de ahora en adelante.</p>
                    </div>
                    <div style="display:flex;gap:6px;flex-wrap:wrap;">
                        <div style="padding:6px 12px;border-radius:10px;background:rgba(0,184,148,0.1);color:#00b894;font-size:0.78rem;text-align:center;"><strong style="font-size:1rem;display:block;">${resumen.nuevos}</strong>nuevos</div>
                        <div style="padding:6px 12px;border-radius:10px;background:rgba(157,78,221,0.1);color:var(--primary-color,#9d4edd);font-size:0.78rem;text-align:center;"><strong style="font-size:1rem;display:block;">${resumen.actualizados}</strong>ya existían</div>
                        <div style="padding:6px 12px;border-radius:10px;background:rgba(255,193,7,0.08);color:#ffc107;font-size:0.78rem;text-align:center;"><strong style="font-size:1rem;display:block;">${resumen.omitidos.length}</strong>omitidos</div>
                    </div>
                </div>
                ${resumen.omitidos.length ? `
                <details style="margin-top:10px;font-size:0.76rem;color:var(--text-muted,#aaa);">
                    <summary style="cursor:pointer;">Ver qué filas se omitieron</summary>
                    <ul style="margin:8px 0 0;padding-left:18px;line-height:1.6;">
                        ${resumen.omitidos.slice(0, 10).map(o => `<li>${escapeHtml(o.nombre || 'Fila')}: ${escapeHtml(o.motivo)}</li>`).join('')}
                        ${resumen.omitidos.length > 10 ? `<li>... y ${resumen.omitidos.length - 10} más</li>` : ''}
                    </ul>
                </details>` : ''}
                <div style="display:flex;justify-content:flex-end;margin-top:10px;">
                    <button class="btn-primary" id="mud1-siguiente2" style="${BTN_PRI}">Seguir con los archivos <i class="fas fa-arrow-right"></i></button>
                </div>
            </div>`;
        const btn = $('mud1-siguiente2');
        if (btn) btn.addEventListener('click', () => irPaso(2));
    }

    // ---------- PASO 2 · Subir archivos en montón ----------
    function renderPaso2() {
        const sinDuenoCount = state.archivos.filter(a => a.estado === 'sin_dueño').length;
        const registrados = state.archivos.filter(a => a.estado === 'registrado');
        const pendientes = state.archivos.filter(a => a.estado === 'pendiente');

        let html = `
            <div style="${CARD_STYLE}">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">
                    <i class="fas fa-cloud-upload-alt" style="color:var(--primary-color,#9d4edd);font-size:1rem;"></i>
                    <strong style="font-size:0.9rem;">Subí todos los archivos juntos</strong>
                </div>
                <p style="margin:0 0 12px;font-size:0.78rem;color:var(--text-muted,#aaa);line-height:1.5;">
                    Arrastrá (o elegí) todos los archivos de tus clientes a la vez: Word, Excel, PDF, fotos...
                    Si el nombre del archivo tiene el nombre del cliente (<em>"María - historia.docx"</em>), la web lo manda solo a su carpeta.
                    Lo que no reconozca, lo asignás en el paso siguiente con un toque.
                </p>
                <div id="mud2-drop" style="border:2px dashed rgba(157,78,221,0.35);border-radius:14px;padding:22px 14px;text-align:center;cursor:pointer;background:rgba(157,78,221,0.04);transition:border-color .15s;margin-bottom:12px;">
                    <i class="fas fa-cloud-upload-alt" style="font-size:1.5rem;color:var(--primary-color,#9d4edd);display:block;margin-bottom:8px;"></i>
                    <span style="font-size:0.85rem;">Tocá para elegir archivos</span>
                    <span style="display:block;font-size:0.72rem;color:var(--text-muted,#999);margin-top:4px;">Podés elegir varios a la vez · Word, Excel, PDF, imágenes, zip</span>
                    <input type="file" id="mud2-files" multiple style="display:none;" accept="${MIME_ACEPTADOS.join(',')}">
                </div>
                <div id="mud2-lista"></div>
                <div id="mud2-progreso" style="display:none;margin-top:10px;"></div>
            </div>
            <div id="mud2-resultado"></div>
        `;
        $cuerpo.innerHTML = html;

        const $drop = $('mud2-drop');
        const $input = $('mud2-files');
        $drop.addEventListener('click', () => $input.click());
        $drop.addEventListener('dragover', (e) => { e.preventDefault(); $drop.style.borderColor = '#00b894'; });
        $drop.addEventListener('dragleave', () => { $drop.style.borderColor = 'rgba(157,78,221,0.35)'; });
        $drop.addEventListener('drop', (e) => {
            e.preventDefault();
            $drop.style.borderColor = 'rgba(157,78,221,0.35)';
            if (e.dataTransfer.files && e.dataTransfer.files.length) agregarArchivos(Array.from(e.dataTransfer.files));
        });
        $input.addEventListener('change', () => {
            if ($input.files && $input.files.length) agregarArchivos(Array.from($input.files));
            $input.value = '';
        });

        // Distribución automática por nombre
        distribuirPendientes();
        pintarListaArchivosPaso2();
        pintarResultadoDistribucion();
    }

    function agregarArchivos(files) {
        const validos = files.filter(f => MIME_ACEPTADOS.includes((f.type || '').toLowerCase()));
        const invalidos = files.length - validos.length;
        if (!validos.length) { mostrarToast('Formato no soportado (Word, Excel, PDF, imágenes, zip, csv)', 'warning'); return; }
        if (invalidos) mostrarToast(`${invalidos} archivo(s) omitidos por formato no soportado`, 'warning');
        validos.forEach(file => {
            if (state.archivos.some(a => a.file.name === file.name && a.file.size === file.size)) return;
            state.archivos.push({ id: ++idSeq, file, clienteEmail: null, storagePath: null, estado: 'pendiente' });
        });
        distribuirPendientes();
        pintarListaArchivosPaso2();
        pintarResultadoDistribucion();
    }

    /** Asigna clienteEmail a los archivos pendientes leyendo el nombre del archivo. */
    function distribuirPendientes() {
        const pendientes = state.archivos.filter(a => a.estado === 'pendiente' && !a.clienteEmail);
        pendientes.forEach(a => {
            const stem = normalizar(String(a.file.name).replace(/\.[^.]+$/, ''));
            if (!stem) return;
            let mejor = null;
            state.clientesTrabajo.forEach(c => {
                const cn = normalizar(c.nombre);
                if (cn.length >= 3 && stem.includes(cn)) {
                    if (!mejor || cn.length > mejor.cn.length) mejor = { email: c.email, cn };
                }
            });
            a.clienteEmail = mejor ? mejor.email : null;
        });
    }

    function pintarListaArchivosPaso2() {
        const $lista = $('mud2-lista');
        if (!state.archivos.length) {
            $lista.innerHTML = '<p style="margin:0;font-size:0.76rem;color:var(--text-muted,#888);text-align:center;"><i class="fas fa-inbox"></i> Todavía no agregaste archivos.</p>';
            return;
        }
        $lista.innerHTML = state.archivos.map(a => {
            const cliente = a.clienteEmail ? state.clientesTrabajo.find(c => c.email === a.clienteEmail) : null;
            const estadoHtml = a.estado === 'registrado'
                ? `<span style="color:#00b894;font-size:0.72rem;"><i class="fas fa-check-circle"></i> En la carpeta de ${escapeHtml(cliente ? cliente.nombre : a.clienteEmail)}</span>`
                : a.estado === 'sin_dueño'
                    ? `<span style="color:#ffc107;font-size:0.72rem;"><i class="fas fa-question-circle"></i> Sin dueño (paso 3)</span>`
                    : cliente
                        ? `<span style="color:var(--primary-color,#9d4edd);font-size:0.72rem;"><i class="fas fa-arrow-right"></i> Va a la carpeta de <strong>${escapeHtml(cliente.nombre)}</strong></span>`
                        : `<span style="color:var(--text-muted,#999);font-size:0.72rem;"><i class="fas fa-question-circle"></i> Sin dueño detectado</span>`;
            return `
                <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.02);margin-bottom:6px;flex-wrap:wrap;">
                    <div style="width:30px;height:30px;border-radius:8px;background:rgba(157,78,221,0.12);display:flex;align-items:center;justify-content:center;color:var(--primary-color,#9d4edd);flex-shrink:0;"><i class="fas ${iconoPorArchivo(a.file.name)}"></i></div>
                    <div style="flex:1;min-width:140px;">
                        <div style="font-size:0.82rem;word-break:break-word;">${escapeHtml(a.file.name)}</div>
                        <div style="font-size:0.7rem;color:var(--text-muted,#999);">${formatearTamano(a.file.size)}</div>
                    </div>
                    <div style="min-width:150px;">${estadoHtml}</div>
                    <button class="mud2-quitar" data-id="${a.id}" style="${BTN_SEC};padding:5px 9px;font-size:0.72rem;"><i class="fas fa-times"></i> Quitar</button>
                </div>`;
        }).join('');
        $lista.querySelectorAll('.mud2-quitar').forEach(btn => {
            btn.addEventListener('click', () => {
                const a = state.archivos.find(x => x.id === Number(btn.dataset.id));
                if (!a) return;
                if (a.estado === 'sin_dueño' && a.storagePath) {
                    supabase.storage.from('kanban-adjuntos').remove([a.storagePath]).catch(() => {});
                }
                state.archivos = state.archivos.filter(x => x.id !== a.id);
                pintarListaArchivosPaso2();
                pintarResultadoDistribucion();
                pintarPasos();
                pintarFooter();
            });
        });
    }

    function pintarResultadoDistribucion() {
        const $res = $('mud2-resultado');
        const pendientes = state.archivos.filter(a => a.estado === 'pendiente');
        const sinDueno = state.archivos.filter(a => a.estado === 'sin_dueño');
        const registrados = state.archivos.filter(a => a.estado === 'registrado');

        if (state.subidaConfirmada) {
            $res.innerHTML = `
                <div style="${CARD_STYLE};border-color:rgba(0,184,148,0.3);">
                    <p style="margin:0;font-size:0.84rem;">
                        <i class="fas fa-check-circle" style="color:#00b894;"></i>
                        <strong>${registrados.length} archivo(s) subido(s) a la carpeta de sus clientes.</strong>
                        ${sinDueno.length ? `<br><span style="font-size:0.78rem;color:var(--text-muted,#aaa);">${sinDueno.length} quedaron sin dueño: los asignás en el paso 3.</span>` : '<br><span style="font-size:0.78rem;color:var(--text-muted,#aaa);">¡Todos los archivos encontraron a su cliente!</span>'}
                    </p>
                </div>`;
            return;
        }

        if (!state.archivos.length) {
            $res.innerHTML = '';
            return;
        }
        const agrupados = {};
        pendientes.forEach(a => {
            if (!a.clienteEmail) return;
            if (!agrupados[a.clienteEmail]) agrupados[a.clienteEmail] = 0;
            agrupados[a.clienteEmail]++;
        });
        const nClientes = Object.keys(agrupados).length;
        const nSinDueno = pendientes.filter(a => !a.clienteEmail).length + sinDueno.length;
        const conDueno = pendientes.filter(a => a.clienteEmail).length;

        $res.innerHTML = `
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
                ${conDueno ? `<span style="padding:5px 11px;border-radius:999px;background:rgba(0,184,148,0.1);color:#00b894;font-size:0.74rem;"><i class="fas fa-check"></i> ${conDueno} archivo(s) van a la carpeta de ${nClientes} cliente(s)</span>` : ''}
                ${nSinDueno ? `<span style="padding:5px 11px;border-radius:999px;background:rgba(255,193,7,0.1);color:#ffc107;font-size:0.74rem;"><i class="fas fa-question-circle"></i> ${nSinDueno} sin dueño → paso 3</span>` : ''}
            </div>
            ${conDueno ? `
            <div style="margin-bottom:12px;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,0.07);background:rgba(255,255,255,0.02);">
                <div style="font-size:0.74rem;color:var(--text-muted,#999);margin-bottom:6px;"><i class="fas fa-folder-open"></i> Quién recibe qué:</div>
                ${Object.entries(agrupados).map(([email, n]) => {
                    const cl = state.clientesTrabajo.find(c => c.email === email);
                    return `<div style="font-size:0.8rem;padding:2px 0;"><i class="fas fa-user" style="color:var(--primary-color,#9d4edd);width:14px;"></i> <strong>${escapeHtml(cl ? cl.nombre : email)}</strong> <span style="color:var(--text-muted,#999);">recibe ${n} archivo(s)</span></div>`;
                }).join('')}
            </div>` : ''}
            ${conDueno || nSinDueno ? `
            <div style="display:flex;justify-content:flex-end;">
                <button class="btn-primary" id="mud2-confirmar" style="${BTN_PRI}"><i class="fas fa-cloud-upload-alt"></i> Confirmar y subir ${state.archivos.length} archivo(s)</button>
            </div>` : ''}
        `;
        const btn = $('mud2-confirmar');
        if (btn) btn.addEventListener('click', confirmarSubida);
    }

    async function confirmarSubida() {
        const pendientes = state.archivos.filter(a => a.estado === 'pendiente');
        if (!pendientes.length) return;
        ocupado = true;
        pintarFooter();
        const $prog = $('mud2-progreso');
        $prog.style.display = 'block';
        $prog.innerHTML = `
            <div style="padding:10px 12px;border-radius:10px;background:rgba(157,78,221,0.07);border:1px solid rgba(157,78,221,0.2);">
                <div style="display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:6px;">
                    <span><i class="fas fa-spinner fa-spin"></i> Subiendo archivos...</span>
                    <span id="mud2-prog-pct" style="color:var(--text-muted,#999);">0/${pendientes.length}</span>
                </div>
                <div style="height:7px;border-radius:4px;background:rgba(255,255,255,0.08);overflow:hidden;">
                    <div id="mud2-prog-bar" style="height:100%;width:0%;border-radius:4px;background:linear-gradient(90deg,var(--primary-color,#9d4edd),#00b894);transition:width .15s;"></div>
                </div>
                <div id="mud2-prog-detalle" style="font-size:0.72rem;color:var(--text-muted,#999);margin-top:6px;"></div>
            </div>`;
        const $barra = $('mud2-prog-bar');
        const $pct = $('mud2-prog-pct');
        const $det = $('mud2-prog-detalle');

        let hechos = 0;
        let ok = 0, errores = 0;
        for (const a of pendientes) {
            try {
                if ($det) $det.textContent = a.file.name;
                const storagePath = await subirBinario(a.file, tenantId);
                a.storagePath = storagePath;
                if (a.clienteEmail) {
                    const { data, error } = await supabase.rpc('admin_archivo_crear_subido', {
                        p_tenant_id: tenantId,
                        p_cliente_email: a.clienteEmail,
                        p_nombre: a.file.name,
                        p_nombre_archivo: a.file.name,
                        p_tipo_mime: a.file.type || 'application/octet-stream',
                        p_tamano: a.file.size || 0,
                        p_storage_path: storagePath
                    });
                    if (error || !data || data.ok !== true) {
                        a.estado = 'sin_dueño';
                        errores++;
                    } else {
                        a.estado = 'registrado';
                        ok++;
                    }
                } else {
                    a.estado = 'sin_dueño';
                }
            } catch (e) {
                console.error('[Mudanza] Error subiendo', a.file.name, e);
                a.estado = 'sin_dueño';
                a.storagePath = null;
                errores++;
            } finally {
                hechos++;
                if ($barra) $barra.style.width = `${Math.round((hechos / pendientes.length) * 100)}%`;
                if ($pct) $pct.textContent = `${hechos}/${pendientes.length}`;
            }
        }
        state.subidaConfirmada = true;
        ocupado = false;
        $prog.style.display = 'none';
        pintarListaArchivosPaso2();
        pintarResultadoDistribucion();
        pintarPasos();
        pintarFooter();
        const sinDueno = state.archivos.filter(a => a.estado === 'sin_dueño').length;
        if (errores) mostrarToast(`${ok} subido(s). ${errores} con problemas: revisalos en el paso 3`, 'warning');
        else if (sinDueno) mostrarToast(`${ok} archivo(s) subidos. ${sinDueno} sin dueño: asignalos en el paso 3`, 'success');
        else mostrarToast('¡Todos los archivos encontraron a su cliente!', 'success');
    }

    // ---------- PASO 3 · Archivos sin dueño ----------
    function renderPaso3() {
        const sinDueno = state.archivos.filter(a => a.estado === 'sin_dueño');
        const opciones = state.clientesTrabajo
            .slice()
            .sort((a, b) => a.nombre.localeCompare(b.nombre))
            .map(c => `<option value="${escapeHtml(c.email)}">${escapeHtml(c.nombre)}${c.email.includes('sinemail.local') ? ' (sin correo)' : ''}</option>`)
            .join('');

        let html = `
            <div style="${CARD_STYLE}">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">
                    <i class="fas fa-question-circle" style="color:#ffc107;font-size:1rem;"></i>
                    <strong style="font-size:0.9rem;">Archivos sin dueño</strong>
                    <span id="mud3-contador" style="margin-left:auto;background:rgba(255,193,7,0.12);color:#ffc107;border-radius:999px;padding:2px 10px;font-size:0.76rem;">${sinDueno.length} pendiente(s)</span>
                </div>
                <p style="margin:0 0 12px;font-size:0.78rem;color:var(--text-muted,#aaa);line-height:1.5;">
                    Estos archivos no tenían el nombre del cliente en el archivo. Mandalos con un toque a su carpeta,
                    o descartalos si ya no hacen falta.
                </p>
                <div id="mud3-lista" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px;"></div>
                <div id="mud3-vacio" style="display:none;text-align:center;padding:16px;border-radius:12px;border:1px dashed rgba(0,184,148,0.35);color:#00b894;font-size:0.86rem;">
                    <i class="fas fa-party-horn" style="display:block;font-size:1.4rem;margin-bottom:6px;"></i>
                    ¡Todo asignado! No quedan archivos sin dueño. Tocá "Finalizar mudanza".
                </div>
                <div id="mud3-nuevo-form" style="display:none;margin-top:10px;padding:12px;border-radius:12px;border:1px solid rgba(157,78,221,0.25);background:rgba(157,78,221,0.06);">
                    <p style="margin:0 0 8px;font-size:0.8rem;"><i class="fas fa-user-plus" style="color:var(--primary-color,#9d4edd);"></i> Crear cliente nuevo para recibir este archivo</p>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                        <input id="mud3-nuevo-nombre" type="text" placeholder="Nombre del cliente *" style="${INPUT_STYLE}">
                        <input id="mud3-nuevo-telefono" type="tel" placeholder="Teléfono (ej: +56 9...)" style="${INPUT_STYLE}">
                    </div>
                    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;">
                        <button class="btn-secondary" id="mud3-nuevo-cancelar" style="${BTN_SEC}">Cancelar</button>
                        <button class="btn-primary" id="mud3-nuevo-guardar" style="${BTN_PRI}"><i class="fas fa-save"></i> Crear y mandar archivo</button>
                    </div>
                </div>
            </div>
        `;
        $cuerpo.innerHTML = html;
        pintarBandejaPaso3();
        const $lista = $('mud3-lista');
        if ($lista) {
            const fab = document.createElement('div');
            fab.style.cssText = 'display:flex;justify-content:center;margin-top:4px;';
            fab.innerHTML = `<button class="btn-secondary" id="mud3-nuevo-btn" style="${BTN_SEC}"><i class="fas fa-user-plus"></i> Crear cliente nuevo para asignarle archivos</button>`;
            $lista.parentNode.insertBefore(fab, $lista.nextSibling);
            fab.querySelector('#mud3-nuevo-btn').addEventListener('click', () => {
                $('mud3-nuevo-form').style.display = 'block';
            });
        }
        const canc = $('mud3-nuevo-cancelar');
        if (canc) canc.addEventListener('click', () => { $('mud3-nuevo-form').style.display = 'none'; });
        const guardar = $('mud3-nuevo-guardar');
        if (guardar) guardar.addEventListener('click', crearClienteYAsignar);
    }

    function pintarBandejaPaso3() {
        const sinDueno = state.archivos.filter(a => a.estado === 'sin_dueño');
        const $lista = $('mud3-lista');
        const $vacio = $('mud3-vacio');
        const $contador = $('mud3-contador');
        if ($contador) $contador.textContent = `${sinDueno.length} pendiente(s)`;
        if ($vacio) $vacio.style.display = sinDueno.length ? 'none' : 'block';
        if (!$lista) return;

        const opciones = state.clientesTrabajo
            .slice()
            .sort((a, b) => a.nombre.localeCompare(b.nombre))
            .map(c => `<option value="${escapeHtml(c.email)}">${escapeHtml(c.nombre)}</option>`)
            .join('');

        if (!sinDueno.length) {
            $lista.innerHTML = '';
            pintarFooter();
            return;
        }
        $lista.innerHTML = sinDueno.map(a => `
            <div style="display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:10px;border:1px solid rgba(255,193,7,0.15);background:rgba(255,193,7,0.03);flex-wrap:wrap;">
                <div style="width:30px;height:30px;border-radius:8px;background:rgba(255,193,7,0.1);display:flex;align-items:center;justify-content:center;color:#ffc107;flex-shrink:0;"><i class="fas ${iconoPorArchivo(a.file.name)}"></i></div>
                <div style="flex:1;min-width:130px;">
                    <div style="font-size:0.82rem;word-break:break-word;">${escapeHtml(a.file.name)}</div>
                    <div style="font-size:0.7rem;color:var(--text-muted,#999);">${formatearTamano(a.file.size)}</div>
                </div>
                <select class="mud3-mandar-cliente" data-id="${a.id}" style="${INPUT_STYLE};width:auto;max-width:200px;padding:7px 10px;font-size:0.8rem;">
                    <option value="">Mandar a...</option>
                    ${opciones}
                </select>
                <button class="mud3-descartar" data-id="${a.id}" style="${BTN_PELIGRO}"><i class="fas fa-trash"></i> Descartar</button>
            </div>`).join('');
        $lista.querySelectorAll('.mud3-mandar-cliente').forEach(sel => {
            sel.addEventListener('change', () => {
                if (!sel.value) return;
                asignarArchivo(Number(sel.dataset.id), sel.value, sel);
            });
        });
        $lista.querySelectorAll('.mud3-descartar').forEach(btn => {
            btn.addEventListener('click', () => descartarArchivo(Number(btn.dataset.id)));
        });
    }

    async function asignarArchivo(id, clienteEmail, sel) {
        const a = state.archivos.find(x => x.id === id);
        if (!a) return;
        ocupado = true;
        if (sel) { sel.disabled = true; sel.innerHTML = '<option>Guardando...</option>'; }
        try {
            if (!a.storagePath) {
                a.storagePath = await subirBinario(a.file, tenantId);
            }
            const { data, error } = await supabase.rpc('admin_archivo_crear_subido', {
                p_tenant_id: tenantId,
                p_cliente_email: clienteEmail,
                p_nombre: a.file.name,
                p_nombre_archivo: a.file.name,
                p_tipo_mime: a.file.type || 'application/octet-stream',
                p_tamano: a.file.size || 0,
                p_storage_path: a.storagePath
            });
            if (error || !data || data.ok !== true) {
                mostrarToast((data && data.error) || 'No se pudo asignar el archivo', 'error');
                if (sel) pintarBandejaPaso3();
                return;
            }
            const cl = state.clientesTrabajo.find(c => c.email === clienteEmail);
            a.estado = 'registrado';
            a.clienteEmail = clienteEmail;
            mostrarToast(`Archivo enviado a la carpeta de ${cl ? cl.nombre : clienteEmail}`, 'success');
            pintarBandejaPaso3();
            pintarPasos();
            pintarFooter();
        } catch (e) {
            console.error('[Mudanza] Error asignando archivo:', e);
            mostrarToast('No se pudo asignar el archivo', 'error');
            if (sel) pintarBandejaPaso3();
        } finally {
            ocupado = false;
            pintarFooter();
        }
    }

    async function descartarArchivo(id) {
        const a = state.archivos.find(x => x.id === id);
        if (!a) return;
        if (!window.confirm(`¿Descartar "${a.file.name}"? No se guardará en ningún cliente.`)) return;
        if (a.storagePath) {
            await supabase.storage.from('kanban-adjuntos').remove([a.storagePath]).catch(() => {});
        }
        state.archivos = state.archivos.filter(x => x.id !== id);
        pintarBandejaPaso3();
        pintarPasos();
        pintarFooter();
        mostrarToast('Archivo descartado', 'info');
    }

    async function crearClienteYAsignar() {
        const nombre = ($('mud3-nuevo-nombre').value || '').trim();
        const telefono = ($('mud3-nuevo-telefono').value || '').trim();
        if (!nombre) { mostrarToast('El nombre del cliente es requerido', 'warning'); return; }
        const email = emailSintetico(telefono);
        if (!email) { mostrarToast('Necesitás un teléfono para crear el cliente (o ya existe con correo)', 'warning'); return; }
        try {
            const { data, error } = await supabase.rpc('admin_agregar_cliente', {
                p_tenant_id: tenantId, p_nombre: nombre, p_telefono: telefono, p_email: email, p_direccion: ''
            });
            if (error || !data || data.ok !== true) {
                mostrarToast((data && data.error) || 'No se pudo crear el cliente', 'error');
                return;
            }
            state.clientesTrabajo.push({ nombre, email, telefono });
            $('mud3-nuevo-form').style.display = 'none';
            $('mud3-nuevo-nombre').value = '';
            $('mud3-nuevo-telefono').value = '';
            mostrarToast(data.ya_existia ? 'El cliente ya existía: podés mandarle archivos' : 'Cliente creado: podés mandarle archivos', 'success');
            pintarBandejaPaso3();
        } catch (e) {
            console.error('[Mudanza] Error creando cliente:', e);
            mostrarToast('No se pudo crear el cliente', 'error');
        }
    }

    // ---------- Finalizar ----------
    function finalizarMudanza() {
        const sinDueno = state.archivos.filter(a => a.estado === 'sin_dueño').length;
        if (sinDueno) { mostrarToast('Todavía hay archivos sin dueño: asignalos o descartalos', 'warning'); return; }
        cerrar();
        if (typeof onTerminado === 'function') onTerminado();
        mostrarToast(state.subidaConfirmada || state.importado
            ? '¡Mudanza completa! Tus clientes y archivos ya están en la web'
            : 'Listo', 'success');
    }

    // ========== Arranque ==========
    pintarPasos();
    renderCuerpo();
    pintarFooter();
}
