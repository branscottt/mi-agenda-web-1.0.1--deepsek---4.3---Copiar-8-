// clients/ui/ArchivosCliente.js
// "Archivos" de la Carpeta del Cliente (botón en el header del tablero,
// solo vista admin). Cada cliente tiene sus archivos a nivel cliente:
//   - tipo 'subido': binario en el bucket privado 'kanban-adjuntos',
//     con HISTORIAL DE VERSIONES (cada actualización conserva la anterior).
//   - tipo 'drive': enlace externo (Google Drive, etc.) que vive en la
//     nube del negocio; la web guarda solo el acceso.
// Avisos honestos de guardado: la web SIEMPRE dice dónde vive cada
// archivo (Drive = se actualiza solo; Web = al volver de editarlo,
// subí la versión nueva con un toque).
import { getCurrentTenantId } from '../../shared/infrastructure/router.js';
import { getSupabase } from '../../shared/infrastructure/supabase.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';

// ========== ESTILOS (coherentes con los overlays del panel admin) ==========
const INPUT_STYLE = 'width:100%;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.10);color:var(--text-color,#e0e0e0);box-sizing:border-box;font-size:0.9rem;outline:none;transition:border-color .15s ease;';
const BTN_SEC = 'padding:8px 14px;border-radius:10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:var(--text-color,#e0e0e0);cursor:pointer;font-size:0.82rem;display:inline-flex;align-items:center;gap:6px;';
const BTN_PRI = 'padding:9px 16px;border-radius:10px;background:linear-gradient(135deg,var(--primary-color,#9d4edd),#7b2cbf);border:none;color:#fff;cursor:pointer;font-size:0.85rem;font-weight:600;display:inline-flex;align-items:center;gap:7px;box-shadow:0 4px 14px rgba(157,78,221,0.3);';
const BTN_PELIGRO = 'padding:7px 12px;border-radius:10px;background:rgba(255,80,80,0.12);border:1px solid rgba(255,80,80,0.25);color:#ff6b6b;cursor:pointer;font-size:0.78rem;display:inline-flex;align-items:center;gap:6px;';
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

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatearTamano(bytes) {
    if (!bytes && bytes !== 0) return '';
    const n = Number(bytes);
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatearFecha(iso) {
    if (!iso) return '';
    try {
        const d = new Date(iso);
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const mi = String(d.getMinutes()).padStart(2, '0');
        return `${dd}/${mm}/${d.getFullYear()} ${hh}:${mi}`;
    } catch (e) { return iso; }
}

function iconoPorArchivo(nombre, tipo) {
    const n = String(nombre || '').toLowerCase();
    if (tipo === 'drive') return 'fa-cloud';
    if (/\.(png|jpe?g|gif|webp|svg)$/.test(n)) return 'fa-image';
    if (/\.pdf$/.test(n)) return 'fa-file-pdf';
    if (/\.(docx?|rtf|odt)$/.test(n)) return 'fa-file-word';
    if (/\.(xlsx?|ods|csv)$/.test(n)) return 'fa-file-excel';
    if (/\.(pptx?|odp)$/.test(n)) return 'fa-file-powerpoint';
    if (/\.zip$/.test(n)) return 'fa-file-archive';
    return 'fa-file';
}

/** Sube un binario al bucket privado con progreso real (XHR, mismo patrón que kanbanApi). */
function subirBinario(file, tenantId, prefijo, onProgress) {
    const supabase = getSupabase();
    const nombreLimpio = (file.name || 'archivo')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    const storagePath = `${tenantId}/entrada/${prefijo}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${nombreLimpio}`;

    return (async () => {
        let token = null;
        try {
            const { data } = await supabase.auth.getSession();
            token = data?.session?.access_token || null;
        } catch (e) { /* sin token: el XHR fallará con 401 */ }
        const url = `${supabase.supabaseUrl}/storage/v1/object/kanban-adjuntos/${storagePath}`;
        const key = supabase.supabaseKey;

        await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', url);
            if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
            if (key) xhr.setRequestHeader('apikey', key);
            xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
            xhr.setRequestHeader('x-upsert', 'false');
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable && typeof onProgress === 'function') onProgress({ loaded: e.loaded, total: e.total });
            };
            xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload falló (${xhr.status})`)));
            xhr.onerror = () => reject(new Error('Error de red al subir'));
            xhr.send(file);
        });
        return storagePath;
    })();
}

/**
 * Abre el overlay "Archivos de {cliente}".
 * @param {object} opts
 * @param {object} opts.cliente  { email, nombre, telefono }
 * @param {Function} [opts.onCambio]  callback tras cualquier cambio (para refrescar la vista padre)
 */
export async function abrirArchivosCliente({ cliente, onCambio } = {}) {
    if (!cliente || !cliente.email) {
        mostrarToast('El cliente no tiene email para abrir sus archivos', 'warning');
        return;
    }
    const tenantId = await getCurrentTenantId();
    if (!tenantId) {
        mostrarToast('No se pudo identificar el negocio', 'error');
        return;
    }

    const supabase = getSupabase();
    const email = String(cliente.email).trim().toLowerCase();
    let archivos = []; // { id, nombre, tipo, drive_url, created_at, versiones: [...] }
    let cerrado = false;
    let subiendo = false;
    let subAbierto = false; // overlay de versiones encima (captura su propio Escape)

    // ========== Overlay ==========
    const overlay = document.createElement('div');
    overlay.className = 'kanban-card-overlay';
    overlay.style.zIndex = '2500';
    overlay.innerHTML = `
        <div class="glass-panel" style="max-width:720px;width:94%;max-height:92vh;overflow-y:auto;padding:0;border-radius:16px;display:flex;flex-direction:column;">
            <header style="display:flex;align-items:center;gap:14px;padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.08);position:sticky;top:0;background:linear-gradient(135deg, rgba(157,78,221,0.16), rgba(0,184,148,0.06));z-index:1;border-radius:16px 16px 0 0;">
                <div style="width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,var(--primary-color,#9d4edd),#7b2cbf);display:flex;align-items:center;justify-content:center;color:#fff;font-size:1rem;flex-shrink:0;box-shadow:0 4px 14px rgba(157,78,221,0.35);">
                    <i class="fas fa-folder-open"></i>
                </div>
                <div style="flex:1;min-width:0;">
                    <h4 style="margin:0;font-size:1rem;"><strong>Archivos de ${escapeHtml(cliente.nombre || 'este cliente')}</strong></h4>
                    <p style="margin:2px 0 0;font-size:0.75rem;color:var(--text-muted,#aaa);">Todo lo del cliente en un solo lugar · sus archivos, su tablero y su historial</p>
                </div>
                <button class="kanban-btn-close" id="acf-cerrar" title="Cerrar">&times;</button>
            </header>

            <div style="padding:16px 20px;flex:1;">
                <div id="acf-contenido"><div class="loading-spinner"><i class="fas fa-spinner fa-spin"></i><p>Cargando archivos...</p></div></div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const $ = (id) => overlay.querySelector('#' + id);
    const $contenido = $('acf-contenido');

    function cerrar() {
        if (cerrado) return;
        cerrado = true;
        document.removeEventListener('keydown', escHandler, true);
        overlay.remove();
    }
    // Escape en CAPTURE + stopImmediatePropagation: evita que el handler del
    // tablero (document, bubble) cierre el board cuando este overlay está abierto.
    function escHandler(e) {
        if (e.key !== 'Escape') return;
        if (subAbierto) return; // lo resuelve el overlay de versiones (capture propio)
        if (subiendo) { mostrarToast('Esperá a que termine la subida', 'warning'); return; }
        e.stopImmediatePropagation();
        cerrar();
    }
    $('acf-cerrar').addEventListener('click', () => { if (!subiendo) cerrar(); });
    overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay && !subiendo) cerrar();
    });
    document.addEventListener('keydown', escHandler, true);

    // ========== Datos ==========
    async function cargarArchivos() {
        const { data, error } = await supabase
            .from('clientes_archivos')
            .select('*, clientes_archivo_versiones(*)')
            .eq('tenant_id', tenantId)
            .eq('cliente_email', email)
            .order('created_at', { ascending: false });
        if (error) throw error;
        archivos = (data || []).map(a => {
            const versiones = (a.clientes_archivo_versiones || []).slice().sort((x, y) => y.numero - x.numero);
            return { ...a, versiones };
        });
    }

    function renderArchivos() {
        const ultima = (a) => (a.versiones && a.versiones.length ? a.versiones[0] : null);

        let html = `
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">
                <button class="btn-primary btn-small" id="acf-subir" style="gap:6px;"><i class="fas fa-upload"></i> Subir archivo(s)</button>
                <button class="btn-secondary btn-small" id="acf-drive" style="gap:6px;"><i class="fas fa-cloud"></i> Agregar enlace de Drive</button>
                <input type="file" id="acf-file-input" multiple style="display:none;">
            </div>

            <div id="acf-subiendo" style="display:none;"></div>

            <div id="acf-drive-form" style="display:none;margin-bottom:14px;padding:14px;border-radius:12px;border:1px solid rgba(157,78,221,0.25);background:rgba(157,78,221,0.06);">
                <p style="margin:0 0 10px;font-size:0.82rem;color:var(--text-muted,#aaa);"><i class="fas fa-info-circle"></i> El archivo sigue viviendo en <strong>tu Drive</strong>: lo editás ahí (Google Sheets, Word, Docs...) y acá se ve la versión nueva solo. La web guarda solo el acceso.</p>
                <div class="form-group" style="margin-bottom:10px;">
                    <label style="display:block;font-size:0.78rem;color:var(--text-muted,#aaa);margin-bottom:5px;">Nombre con el que lo verás acá *</label>
                    <input id="acf-drive-nombre" type="text" placeholder="Ej: Seguimiento del cliente" style="${INPUT_STYLE}">
                </div>
                <div class="form-group" style="margin-bottom:12px;">
                    <label style="display:block;font-size:0.78rem;color:var(--text-muted,#aaa);margin-bottom:5px;">Enlace de Google Drive *</label>
                    <input id="acf-drive-url" type="url" placeholder="https://drive.google.com/..." style="${INPUT_STYLE}">
                </div>
                <div style="display:flex;gap:8px;justify-content:flex-end;">
                    <button class="btn-secondary" id="acf-drive-cancelar" style="${BTN_SEC}">Cancelar</button>
                    <button class="btn-primary" id="acf-drive-guardar" style="${BTN_PRI}"><i class="fas fa-cloud"></i> Guardar enlace</button>
                </div>
            </div>

            <div style="margin-bottom:12px;">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                    <i class="fas fa-folder-open" style="color:var(--primary-color,#9d4edd);"></i>
                    <strong style="font-size:0.88rem;">${archivos.length} archivo${archivos.length !== 1 ? 's' : ''}</strong>
                </div>
                <p style="margin:0 0 8px;font-size:0.75rem;color:var(--text-muted,#999);">
                    <i class="fas fa-cloud" style="margin-right:3px;"></i> En Drive: se actualiza solo al editarlo.
                    <i class="fas fa-upload" style="margin:0 3px 0 10px;"></i> Subido a la web: editá el archivo en tu celu/computadora y, al volver, subí la versión nueva (queda la anterior guardada).
                </p>
            </div>

            <div id="acf-lista" style="display:flex;flex-direction:column;gap:8px;"></div>
        `;
        $contenido.innerHTML = html;

        // ---- lista ----
        const $lista = $('acf-lista');
        if (!archivos.length) {
            $lista.innerHTML = `
                <div style="padding:18px;text-align:center;border-radius:12px;border:1px dashed rgba(255,255,255,0.15);color:var(--text-muted,#999);">
                    <i class="fas fa-inbox" style="font-size:1.3rem;display:block;margin-bottom:6px;"></i>
                    Todavía no hay archivos. Subí los que ya tenés (Word, Excel, PDF...) o agregá el enlace de su carpeta de Drive.
                </div>`;
        } else {
            archivos.forEach(a => {
                const esDrive = a.tipo === 'drive';
                const v = esDrive ? null : ultima(a);
                const nVersiones = (a.versiones || []).length;
                const fila = document.createElement('div');
                fila.style.cssText = 'display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,0.07);background:linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01));flex-wrap:wrap;';
                fila.innerHTML = `
                    <div style="width:36px;height:36px;border-radius:10px;background:${esDrive ? 'rgba(0,184,148,0.15)' : 'rgba(157,78,221,0.15)'};display:flex;align-items:center;justify-content:center;color:${esDrive ? '#00b894' : 'var(--primary-color,#9d4edd)'};flex-shrink:0;">
                        <i class="fas ${iconoPorArchivo(a.nombre, a.tipo)}"></i>
                    </div>
                    <div style="flex:1;min-width:160px;">
                        <div style="font-size:0.88rem;font-weight:600;word-break:break-word;">${escapeHtml(a.nombre)}
                            ${esDrive ? '' : (nVersiones > 1 ? `<span style="font-size:0.7rem;color:var(--text-muted,#999);font-weight:400;"> · v${nVersiones}</span>` : '')}
                        </div>
                        <div style="font-size:0.72rem;color:var(--text-muted,#999);margin-top:2px;display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
                            ${esDrive
                                ? '<span style="color:#00b894;"><i class="fas fa-cloud"></i> Vive en tu Drive · los cambios se ven solos acá</span>'
                                : `<span><i class="fas fa-upload"></i> Vive en la web${v ? ` · ${formatearTamano(v.tamano)}` : ''}${v ? ` · ${formatearFecha(v.created_at)}` : ''}</span>`}
                        </div>
                        ${esDrive ? '' : `<div style="font-size:0.72rem;color:var(--text-muted,#999);margin-top:2px;"><i class="fas fa-redo-alt"></i> ¿Volviste de editarlo? Subí la versión nueva y la anterior queda guardada.</div>`}
                    </div>
                    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
                        ${esDrive
                            ? `<a href="${escapeHtml(a.drive_url)}" target="_blank" rel="noopener noreferrer" style="${BTN_PRI};text-decoration:none;padding:7px 12px;font-size:0.78rem;"><i class="fas fa-external-link-alt"></i> Abrir y editar en Drive</a>`
                            : `<button class="acf-accion" data-accion="descargar" data-id="${a.id}" style="${BTN_SEC};padding:7px 12px;font-size:0.78rem;"><i class="fas fa-download"></i> Editar / Descargar</button>
                               <button class="acf-accion" data-accion="version" data-id="${a.id}" style="${BTN_SEC};padding:7px 12px;font-size:0.78rem;"><i class="fas fa-redo-alt"></i> Subir versión nueva</button>
                               ${nVersiones > 1 ? `<button class="acf-accion" data-accion="versiones" data-id="${a.id}" style="${BTN_SEC};padding:7px 12px;font-size:0.78rem;"><i class="fas fa-history"></i> Versiones (${nVersiones})</button>` : ''}`}
                        <button class="acf-accion" data-accion="eliminar" data-id="${a.id}" style="${BTN_PELIGRO};"><i class="fas fa-trash"></i></button>
                    </div>
                `;
                $lista.appendChild(fila);
            });
            $lista.querySelectorAll('.acf-accion').forEach(btn => {
                btn.addEventListener('click', () => manejarAccion(btn.dataset.accion, btn.dataset.id, btn));
            });
        }

        // ---- binds ----
        const subirBtn = $('acf-subir');
        if (subirBtn) subirBtn.addEventListener('click', () => $('acf-file-input').click());
        const fileInput = $('acf-file-input');
        if (fileInput) fileInput.addEventListener('change', () => {
            if (fileInput.files && fileInput.files.length) subirArchivos(Array.from(fileInput.files));
            fileInput.value = '';
        });
        const driveBtn = $('acf-drive');
        if (driveBtn) driveBtn.addEventListener('click', () => {
            $('acf-drive-form').style.display = 'block';
            driveBtn.style.display = 'none';
        });
        const drvCancelar = $('acf-drive-cancelar');
        if (drvCancelar) drvCancelar.addEventListener('click', () => {
            $('acf-drive-form').style.display = 'none';
            driveBtn.style.display = '';
        });
        const drvGuardar = $('acf-drive-guardar');
        if (drvGuardar) drvGuardar.addEventListener('click', guardarEnlaceDrive);
    }

    async function manejarAccion(accion, id, btn) {
        const archivo = archivos.find(a => a.id === id);
        if (!archivo) return;
        if (accion === 'descargar') await descargarArchivo(archivo);
        else if (accion === 'version') await pedirNuevaVersion(archivo, btn);
        else if (accion === 'versiones') verVersiones(archivo);
        else if (accion === 'eliminar') await eliminarArchivo(archivo);
    }

    async function descargarArchivo(archivo) {
        const v = archivo.versiones && archivo.versiones.length ? archivo.versiones[0] : null;
        if (!v || !v.storage_path) { mostrarToast('Este archivo no tiene versión descargable', 'warning'); return; }
        try {
            const { data, error } = await supabase.storage.from('kanban-adjuntos').createSignedUrl(v.storage_path, 3600);
            if (error || !data?.signedUrl) throw error || new Error('sin url');
            const a = document.createElement('a');
            a.href = data.signedUrl;
            a.target = '_blank';
            a.rel = 'noopener';
            a.download = v.nombre_archivo || archivo.nombre;
            document.body.appendChild(a);
            a.click();
            a.remove();
            mostrarToast('Se abrió el archivo. Cuando termines de editarlo, tocá "Subir versión nueva" para guardarlo acá', 'info');
        } catch (e) {
            console.error('[ArchivosCliente] Error descargando:', e);
            mostrarToast('No se pudo abrir el archivo', 'error');
        }
    }

    function pedirNuevaVersion(archivo, btn) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = MIME_ACEPTADOS.join(',');
        input.style.display = 'none';
        document.body.appendChild(input);
        input.addEventListener('change', async () => {
            const file = input.files && input.files[0];
            input.remove();
            if (!file) return;
            if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Subiendo...'; }
            await subirArchivos([file], archivo.nombre, btn);
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-redo-alt"></i> Subir versión nueva'; }
        });
        input.click();
    }

    function verVersiones(archivo) {
        const lista = (archivo.versiones || []).slice().sort((a, b) => b.numero - a.numero);
        const sub = document.createElement('div');
        sub.className = 'kanban-card-overlay';
        sub.style.zIndex = '2600';
        sub.innerHTML = `
            <div class="glass-panel" style="max-width:520px;width:92%;max-height:86vh;overflow-y:auto;padding:0;border-radius:16px;">
                <header style="display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.08);position:sticky;top:0;background:var(--card-bg,#1a1a2e);border-radius:16px 16px 0 0;">
                    <div style="flex:1;"><h4 style="margin:0;font-size:0.95rem;"><strong>Versiones de ${escapeHtml(archivo.nombre)}</strong></h4>
                    <p style="margin:2px 0 0;font-size:0.75rem;color:var(--text-muted,#aaa);">Cada actualización guarda la anterior: nada se pierde.</p></div>
                    <button class="kanban-btn-close" data-cerrar="1" title="Cerrar">&times;</button>
                </header>
                <div style="padding:14px 20px;display:flex;flex-direction:column;gap:8px;">
                    ${lista.map(v => `
                        <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,0.07);">
                            <div style="width:30px;height:30px;border-radius:8px;background:rgba(157,78,221,0.15);display:flex;align-items:center;justify-content:center;color:var(--primary-color,#9d4edd);flex-shrink:0;"><i class="fas fa-file"></i></div>
                            <div style="flex:1;">
                                <div style="font-size:0.85rem;"><strong>Versión ${v.numero}</strong> ${v.numero === 1 ? '<span style="font-size:0.7rem;color:var(--text-muted,#999);">(original)</span>' : ''}</div>
                                <div style="font-size:0.72rem;color:var(--text-muted,#999);">${escapeHtml(v.nombre_archivo)} · ${formatearTamano(v.tamano)} · ${formatearFecha(v.created_at)}</div>
                            </div>
                            <button class="acf-version-descargar" data-id="${v.id}" style="${BTN_SEC};padding:6px 10px;font-size:0.75rem;"><i class="fas fa-download"></i> Descargar</button>
                        </div>`).join('')}
                </div>
            </div>`;
        document.body.appendChild(sub);
        subAbierto = true;
        const cerrarSub = () => {
            subAbierto = false;
            document.removeEventListener('keydown', subEsc, true);
            sub.remove();
        };
        const subEsc = (e) => {
            if (e.key !== 'Escape') return;
            e.stopImmediatePropagation();
            cerrarSub();
        };
        sub.querySelectorAll('[data-cerrar]').forEach(b => b.addEventListener('click', cerrarSub));
        sub.addEventListener('mousedown', (e) => { if (e.target === sub) cerrarSub(); });
        document.addEventListener('keydown', subEsc, true);
        sub.querySelectorAll('.acf-version-descargar').forEach(btn => {
            btn.addEventListener('click', async () => {
                const v = lista.find(x => x.id === btn.dataset.id);
                if (!v) return;
                const { data, error } = await supabase.storage.from('kanban-adjuntos').createSignedUrl(v.storage_path, 3600);
                if (error || !data?.signedUrl) { mostrarToast('No se pudo descargar esta versión', 'error'); return; }
                const a = document.createElement('a');
                a.href = data.signedUrl; a.target = '_blank'; a.rel = 'noopener';
                a.download = v.nombre_archivo || archivo.nombre;
                document.body.appendChild(a); a.click(); a.remove();
            });
        });
    }

    async function eliminarArchivo(archivo) {
        const nV = (archivo.versiones || []).length;
        if (!window.confirm(`¿Eliminar "${archivo.nombre}" de la carpeta de este cliente?`)) return;
        if (!window.confirm(nV > 1
            ? `Se borrarán también sus ${nV} versiones guardadas. Esta acción no se puede deshacer. ¿Eliminar definitivamente?`
            : 'Esta acción no se puede deshacer. ¿Eliminar definitivamente?')) return;
        try {
            // 1) Binarios de Storage (best effort, mismo orden que kanbanApi)
            const paths = (archivo.versiones || []).map(v => v.storage_path).filter(Boolean);
            if (paths.length) await supabase.storage.from('kanban-adjuntos').remove(paths).catch(() => {});
            // 2) Registro + versiones (cascade)
            const { data, error } = await supabase.rpc('admin_archivo_eliminar', { p_tenant_id: tenantId, p_archivo_id: archivo.id });
            if (error || !data || data.ok !== true) {
                mostrarToast((data && data.error) || 'No se pudo eliminar el archivo', 'error');
                return;
            }
            archivos = archivos.filter(a => a.id !== archivo.id);
            renderArchivos();
            if (typeof onCambio === 'function') onCambio();
            mostrarToast('Archivo eliminado', 'success');
        } catch (e) {
            console.error('[ArchivosCliente] Error eliminando:', e);
            mostrarToast('No se pudo eliminar el archivo', 'error');
        }
    }

    async function guardarEnlaceDrive() {
        const nombre = ($('acf-drive-nombre').value || '').trim();
        const url = ($('acf-drive-url').value || '').trim();
        if (!nombre) { mostrarToast('Poné un nombre para el enlace', 'warning'); return; }
        if (!/^https?:\/\/.+/.test(url)) { mostrarToast('El enlace debe empezar con http:// o https://', 'warning'); return; }
        try {
            const { data, error } = await supabase.rpc('admin_archivo_crear_drive', {
                p_tenant_id: tenantId, p_cliente_email: email, p_nombre: nombre, p_drive_url: url
            });
            if (error || !data || data.ok !== true) {
                mostrarToast((data && data.error) || 'No se pudo guardar el enlace', 'error');
                return;
            }
            mostrarToast(data.ya_existia ? 'Enlace actualizado' : 'Enlace guardado', 'success');
            $('acf-drive-form').style.display = 'none';
            $('acf-drive').style.display = '';
            $('acf-drive-nombre').value = '';
            $('acf-drive-url').value = '';
            await recargar();
            if (typeof onCambio === 'function') onCambio();
        } catch (e) {
            console.error('[ArchivosCliente] Error guardando enlace:', e);
            mostrarToast('No se pudo guardar el enlace', 'error');
        }
    }

    async function subirArchivos(files, nombreLogicoFijo, btn) {
        const validos = files.filter(f => MIME_ACEPTADOS.includes((f.type || '').toLowerCase()));
        const invalidos = files.length - validos.length;
        if (!validos.length) { mostrarToast('Formato no soportado', 'warning'); return; }
        if (invalidos) mostrarToast(`${invalidos} archivo(s) omitidos por formato no soportado`, 'warning');

        subiendo = true;
        const zona = $('acf-subiendo');
        zona.style.display = 'block';
        zona.innerHTML = validos.map((f, i) => `
            <div class="acf-progreso-item" data-idx="${i}" style="margin-bottom:8px;padding:8px 12px;border-radius:10px;border:1px solid rgba(255,255,255,0.07);background:rgba(255,255,255,0.02);">
                <div style="display:flex;justify-content:space-between;font-size:0.78rem;margin-bottom:5px;">
                    <span style="word-break:break-word;padding-right:8px;">${escapeHtml(f.name)}</span>
                    <span class="acf-progreso-pct" style="color:var(--text-muted,#999);flex-shrink:0;">0%</span>
                </div>
                <div style="height:6px;border-radius:4px;background:rgba(255,255,255,0.08);overflow:hidden;">
                    <div class="acf-progreso-bar" style="height:100%;width:0%;border-radius:4px;background:linear-gradient(90deg,var(--primary-color,#9d4edd),#00b894);transition:width .15s;"></div>
                </div>
            </div>`).join('');

        const resultados = { nuevos: 0, versiones: 0, errores: [] };
        for (let i = 0; i < validos.length; i++) {
            const file = validos[i];
            const item = zona.querySelector(`[data-idx="${i}"]`);
            const barra = item ? item.querySelector('.acf-progreso-bar') : null;
            const pct = item ? item.querySelector('.acf-progreso-pct') : null;
            try {
                const storagePath = await subirBinario(file, tenantId, 'cliente', (p) => {
                    if (barra && p.total) {
                        const porc = Math.round((p.loaded / p.total) * 100);
                        barra.style.width = `${porc}%`;
                        if (pct) pct.textContent = `${porc}%`;
                    }
                });
                if (barra) barra.style.width = '100%';
                if (pct) pct.textContent = 'guardando...';
                const nombreLogico = nombreLogicoFijo || file.name;
                const { data, error } = await supabase.rpc('admin_archivo_crear_subido', {
                    p_tenant_id: tenantId,
                    p_cliente_email: email,
                    p_nombre: nombreLogico,
                    p_nombre_archivo: file.name,
                    p_tipo_mime: file.type || 'application/octet-stream',
                    p_tamano: file.size || 0,
                    p_storage_path: storagePath
                });
                if (error || !data || data.ok !== true) {
                    resultados.errores.push(`${file.name}: ${(data && data.error) || (error && error.message) || 'error'}`);
                    if (pct) pct.textContent = 'error';
                } else {
                    if (data.ya_existia) resultados.versiones++;
                    else resultados.nuevos++;
                    if (pct) pct.textContent = '✓';
                }
            } catch (err) {
                console.error('[ArchivosCliente] Error subiendo:', err);
                resultados.errores.push(`${file.name}: error de subida`);
                if (pct) pct.textContent = 'error';
            }
        }
        subiendo = false;
        zona.style.display = 'none';
        await recargar();
        if (typeof onCambio === 'function') onCambio();
        if (resultados.errores.length) {
            mostrarToast(`${resultados.errores.length} archivo(s) con error: ${resultados.errores[0]}`, 'error');
        } else {
            mostrarToast(nombreLogicoFijo
                ? `Versión nueva guardada (queda la anterior en "Versiones")`
                : `${resultados.nuevos} archivo(s) subido(s), ${resultados.versiones} actualizado(s)`, 'success');
        }
    }

    async function recargar() {
        try {
            await cargarArchivos();
            renderArchivos();
        } catch (e) {
            console.error('[ArchivosCliente] Error recargando:', e);
            $contenido.innerHTML = '<p class="empty-state"><i class="fas fa-exclamation-triangle"></i> No se pudieron cargar los archivos</p>';
        }
    }

    try {
        await cargarArchivos();
        renderArchivos();
    } catch (e) {
        console.error('[ArchivosCliente] Error inicial:', e);
        $contenido.innerHTML = '<p class="empty-state"><i class="fas fa-exclamation-triangle"></i> No se pudieron cargar los archivos</p>';
    }
}
