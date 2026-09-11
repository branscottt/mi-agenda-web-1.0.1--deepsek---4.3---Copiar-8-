// clients/ui/SinDuenoModal.js
// BANDEJA "SIN CLIENTE" — archivos que se subieron en la Mudanza y todavía no
// tienen dueño. A diferencia de la vieja bandeja del asistente (que vivía en
// memoria y se borraba al cerrar), estos archivos YA están guardados en el
// servidor: no se pierden nunca.
//
// Acá el admin puede:
//   · VER el archivo (enlace firmado).
//   · VER de quién podría ser (sugerencia por nombre, mismo criterio que el
//     motor SQL: si hay dos "Camila" no adivina, te muestra las dos).
//   · MANDARLO a un cliente, de a uno o varios juntos.
//   · CREAR el cliente y mandárselo en el momento.
//   · BUSCAR COINCIDENCIAS: corre el motor del servidor — los archivos cuyo
//     dueño apareció (por ejemplo porque reservó) se asignan solos.
//   · DESCARTAR (doble confirmación: es lo único que borra).
import { getCurrentTenantId } from '../../shared/infrastructure/router.js';
import { getSupabase } from '../../shared/infrastructure/supabase.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { evaluarMatch } from './matchArchivos.js';

const INPUT_STYLE = 'width:100%;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.10);color:var(--text-color,#e0e0e0);box-sizing:border-box;font-size:0.9rem;outline:none;font-family:inherit;';
const BTN_PRI = 'padding:9px 16px;border-radius:10px;background:linear-gradient(135deg,var(--primary-color,#9d4edd),#7b2cbf);border:none;color:#fff;cursor:pointer;font-size:0.85rem;font-weight:600;display:inline-flex;align-items:center;gap:7px;box-shadow:0 4px 14px rgba(157,78,221,0.3);';
const BTN_SEC = 'padding:8px 14px;border-radius:10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:var(--text-color,#e0e0e0);cursor:pointer;font-size:0.82rem;display:inline-flex;align-items:center;gap:6px;';
const BTN_PELIGRO = 'padding:7px 12px;border-radius:10px;background:rgba(255,80,80,0.12);border:1px solid rgba(255,80,80,0.25);color:#ff6b6b;cursor:pointer;font-size:0.78rem;display:inline-flex;align-items:center;gap:6px;';
const CARD_STYLE = 'border-radius:12px;border:1px solid rgba(255,255,255,0.06);background:linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01));padding:14px;margin-bottom:14px;';

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

/**
 * Abre la bandeja "Sin cliente".
 * @param {Object}   opts
 * @param {Array}    opts.clientes   Clientes del tenant [{nombre,email,telefono}]
 * @param {Function} opts.onCambio   Se llama al cerrar si hubo cambios.
 */
export async function abrirSinDueno({ clientes = [], onCambio } = {}) {
    const tenantId = await getCurrentTenantId();
    if (!tenantId) { mostrarToast('No se pudo identificar el negocio', 'error'); return; }
    const supabase = getSupabase();

    const state = {
        items: [],
        seleccion: new Set(),
        cargando: true,
        ocupado: false
    };
    let cerrado = false;

    const overlay = document.createElement('div');
    overlay.className = 'kanban-card-overlay';
    overlay.style.zIndex = '2500';
    overlay.innerHTML = `
        <div class="glass-panel" style="max-width:820px;width:95%;max-height:94vh;overflow-y:auto;padding:0;border-radius:16px;display:flex;flex-direction:column;">
            <header style="padding:16px 20px 12px;border-bottom:1px solid rgba(255,255,255,0.08);position:sticky;top:0;background:linear-gradient(135deg, rgba(255,193,7,0.14), rgba(157,78,221,0.08));z-index:1;border-radius:16px 16px 0 0;">
                <div style="display:flex;align-items:center;gap:12px;">
                    <div style="width:42px;height:42px;border-radius:12px;background:linear-gradient(135deg,#ffc107,var(--primary-color,#9d4edd));display:flex;align-items:center;justify-content:center;color:#fff;font-size:1.05rem;flex-shrink:0;box-shadow:0 4px 14px rgba(255,193,7,0.3);">
                        <i class="fas fa-folder-question"></i>
                    </div>
                    <div style="flex:1;min-width:0;">
                        <h4 style="margin:0;font-size:1.02rem;"><strong>Sin cliente</strong> <span id="sd-contador" style="font-size:0.8rem;color:var(--text-muted,#aaa);"></span></h4>
                        <p style="margin:2px 0 0;font-size:0.76rem;color:var(--text-muted,#aaa);">Archivos que ya subiste y todavía no tienen dueño. No se pierden: si el cliente reserva o aparece, se le mandan solos.</p>
                    </div>
                    <button class="kanban-btn-close" id="sd-cerrar" title="Cerrar">&times;</button>
                </div>
            </header>

            <div style="padding:16px 20px;flex:1;" id="sd-cuerpo">
                <div style="text-align:center;padding:24px;color:var(--text-muted,#999);"><i class="fas fa-spinner fa-spin"></i> Cargando...</div>
            </div>

            <footer style="display:flex;gap:10px;justify-content:space-between;align-items:center;padding:12px 20px;border-top:1px solid rgba(255,255,255,0.08);position:sticky;bottom:0;background:var(--card-bg,#1a1a2e);border-radius:0 0 16px 16px;flex-wrap:wrap;">
                <div id="sd-footer-acciones" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;"></div>
                <button class="btn-secondary" id="sd-cerrar2" style="${BTN_SEC}">Cerrar</button>
            </footer>
        </div>
    `;
    document.body.appendChild(overlay);

    const $ = (id) => overlay.querySelector('#' + id);
    const $cuerpo = $('sd-cuerpo');

    function cerrar() {
        if (cerrado) return;
        cerrado = true;
        document.removeEventListener('keydown', escHandler, true);
        overlay.remove();
        if (typeof onCambio === 'function') onCambio();
    }
    function escHandler(e) {
        if (e.key !== 'Escape') return;
        e.stopImmediatePropagation();
        if (state.seleccion.size) return; // el Escape no debe descartar la selección sin querer
        cerrar();
    }
    $('sd-cerrar').addEventListener('click', cerrar);
    $('sd-cerrar2').addEventListener('click', cerrar);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) cerrar(); });
    document.addEventListener('keydown', escHandler, true);

    // ---------- Carga ----------
    async function cargar() {
        state.cargando = true;
        try {
            const { data, error } = await supabase.rpc('admin_huerfanos_listar', { p_tenant_id: tenantId });
            if (error || !data || data.ok !== true) {
                mostrarToast((data && data.error) || 'No se pudieron cargar los archivos sin cliente', 'error');
                state.items = [];
            } else {
                state.items = data.items || [];
            }
        } catch (e) {
            console.error('[SinDueno] Error cargando:', e);
            state.items = [];
        }
        // Sugerencia de dueño (mismo criterio que el motor del servidor).
        state.items.forEach(it => {
            const r = evaluarMatch(it.nombre_original, clientes);
            it.sugerido = r.email;
            it.ambiguo = r.ambiguo;
            it.nombresAmbiguos = r.nombresTop || [];
        });
        state.seleccion.clear();
        state.cargando = false;
        render();
    }

    // ---------- Render ----------
    function render() {
        if (state.cargando) return;
        if (!state.items.length) {
            $cuerpo.innerHTML = `
                <div style="text-align:center;padding:26px 16px;border-radius:12px;border:1px dashed rgba(0,184,148,0.35);color:#00b894;font-size:0.9rem;">
                    <i class="fas fa-check-circle" style="display:block;font-size:1.6rem;margin-bottom:8px;"></i>
                    <strong>No hay archivos sin cliente.</strong>
                    <div style="font-size:0.78rem;color:var(--text-muted,#999);margin-top:6px;">Todos los archivos que subiste ya están en la carpeta de su cliente.</div>
                </div>`;
            $('sd-contador').textContent = '';
            pintarFooter();
            return;
        }
        $('sd-contador').textContent = `· ${state.items.length} archivo${state.items.length !== 1 ? 's' : ''}`;
        $cuerpo.innerHTML = `
            <div style="${CARD_STYLE}">
                <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px;">
                    <button class="btn-primary" id="sd-auto" style="${BTN_PRI};padding:7px 13px;font-size:0.8rem;">
                        <i class="fas fa-wand-magic-sparkles"></i> Buscar coincidencias
                    </button>
                    <button class="btn-secondary" id="sd-nuevo" style="${BTN_SEC};padding:7px 13px;font-size:0.8rem;">
                        <i class="fas fa-user-plus"></i> Crear cliente y mandarle
                    </button>
                    <span style="font-size:0.75rem;color:var(--text-muted,#999);margin-left:auto;">
                        <i class="fas fa-circle-info"></i> Si el archivo dice el nombre y algo más, se sugiere solo.
                    </span>
                </div>
                <div id="sd-lista" style="display:flex;flex-direction:column;gap:8px;"></div>
            </div>
        `;
        pintarLista();
        $('sd-auto').addEventListener('click', buscarCoincidencias);
        $('sd-nuevo').addEventListener('click', crearClienteYAsignar);
        pintarFooter();
    }

    function opcionesClientes(seleccionado) {
        return clientes
            .slice()
            .sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || '')))
            .map(c => `<option value="${escapeHtml(c.email)}"${seleccionado === c.email ? ' selected' : ''}>${escapeHtml(c.nombre || c.email)}</option>`)
            .join('');
    }

    function sugerenciaHtml(it) {
        if (it.ambiguo && it.nombresAmbiguos.length) {
            return `<span style="color:#ffc107;font-size:0.72rem;"><i class="fas fa-code-branch"></i> Puede ser ${escapeHtml(it.nombresAmbiguos.join(' o '))} — elegí abajo</span>`;
        }
        if (it.sugerido) {
            const cl = clientes.find(c => c.email === it.sugerido);
            return `<span style="color:var(--primary-color,#9d4edd);font-size:0.72rem;"><i class="fas fa-lightbulb"></i> Parece de <strong>${escapeHtml(cl ? cl.nombre : it.sugerido)}</strong></span>`;
        }
        return `<span style="color:var(--text-muted,#999);font-size:0.72rem;"><i class="fas fa-question-circle"></i> No reconozco el nombre</span>`;
    }

    function pintarLista() {
        const $lista = $('sd-lista');
        $lista.innerHTML = state.items.map(it => `
            <div style="display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:10px;border:1px solid rgba(255,193,7,0.15);background:rgba(255,193,7,0.03);flex-wrap:wrap;">
                <input type="checkbox" class="sd-check" data-id="${it.id}" ${state.seleccion.has(it.id) ? 'checked' : ''} style="width:17px;height:17px;flex-shrink:0;cursor:pointer;" title="Elegir para mandar varios juntos">
                <div style="width:30px;height:30px;border-radius:8px;background:rgba(255,193,7,0.1);display:flex;align-items:center;justify-content:center;color:#ffc107;flex-shrink:0;"><i class="fas ${iconoPorArchivo(it.nombre_original)}"></i></div>
                <div style="flex:1;min-width:140px;">
                    <div style="font-size:0.82rem;word-break:break-word;">${escapeHtml(it.nombre_original)}</div>
                    <div style="font-size:0.7rem;color:var(--text-muted,#999);">${formatearTamano(it.tamano)}</div>
                </div>
                <div style="min-width:170px;">${sugerenciaHtml(it)}</div>
                <button class="sd-ver" data-id="${it.id}" style="${BTN_SEC};padding:5px 10px;font-size:0.72rem;"><i class="fas fa-eye"></i> Ver</button>
                <select class="sd-mandar" data-id="${it.id}" style="${INPUT_STYLE};width:auto;max-width:190px;padding:7px 10px;font-size:0.78rem;">
                    <option value="">Mandar a...</option>
                    ${opcionesClientes(it.sugerido)}
                </select>
                <button class="sd-descartar" data-id="${it.id}" style="${BTN_PELIGRO}"><i class="fas fa-trash"></i></button>
            </div>`).join('');

        $lista.querySelectorAll('.sd-check').forEach(chk => {
            chk.addEventListener('change', () => {
                const id = chk.dataset.id;
                if (chk.checked) state.seleccion.add(id); else state.seleccion.delete(id);
                pintarFooter();
            });
        });
        $lista.querySelectorAll('.sd-mandar').forEach(sel => {
            sel.addEventListener('change', () => {
                if (!sel.value) return;
                mandarA([sel.dataset.id], sel.value, sel);
            });
        });
        $lista.querySelectorAll('.sd-ver').forEach(btn => {
            btn.addEventListener('click', () => verArchivo(btn.dataset.id, btn));
        });
        $lista.querySelectorAll('.sd-descartar').forEach(btn => {
            btn.addEventListener('click', () => descartar(btn.dataset.id));
        });
    }

    function pintarFooter() {
        const cont = $('sd-footer-acciones');
        const n = state.seleccion.size;
        if (!n) { cont.innerHTML = ''; return; }
        cont.innerHTML = `
            <span style="font-size:0.8rem;color:var(--text-color,#e0e0e0);"><strong>${n}</strong> elegido(s)</span>
            <select id="sd-mandar-lote" style="${INPUT_STYLE};width:auto;max-width:210px;padding:7px 10px;font-size:0.8rem;">
                <option value="">Mandar los ${n} a...</option>
                ${opcionesClientes('')}
            </select>
            <button class="btn-secondary" id="sd-limpiar-sel" style="${BTN_SEC};padding:6px 11px;font-size:0.76rem;">Quitar selección</button>
        `;
        const sel = $('sd-mandar-lote');
        if (sel) sel.addEventListener('change', () => {
            if (!sel.value) return;
            mandarA([...state.seleccion], sel.value, null);
        });
        const limpiar = $('sd-limpiar-sel');
        if (limpiar) limpiar.addEventListener('click', () => {
            state.seleccion.clear();
            pintarLista();
            pintarFooter();
        });
    }

    // ---------- Acciones ----------
    async function verArchivo(id, btn) {
        const it = state.items.find(x => String(x.id) === String(id));
        if (!it || !it.storage_path) { mostrarToast('No encontré el archivo', 'error'); return; }
        btn.disabled = true;
        try {
            // Mismo patrón que kanbanApi.getAttachmentUrl: enlace firmado
            // temporal del bucket privado (nunca se expone el bucket).
            const { data, error } = await supabase.storage
                .from('kanban-adjuntos')
                .createSignedUrl(it.storage_path, 3600);
            if (error || !data || !data.signedUrl) {
                mostrarToast('No se pudo abrir el archivo', 'error');
                return;
            }
            window.open(data.signedUrl, '_blank', 'noopener');
        } catch (e) {
            console.error('[SinDueno] Error abriendo archivo:', e);
            mostrarToast('No se pudo abrir el archivo', 'error');
        } finally {
            btn.disabled = false;
        }
    }

    async function mandarA(ids, clienteEmail, sel) {
        if (state.ocupado) return;
        if (!clienteEmail) return;
        state.ocupado = true;
        if (sel) { sel.disabled = true; }
        try {
            const { data, error } = await supabase.rpc('admin_huerfanos_asignar_lote', {
                p_tenant_id: tenantId,
                p_huerfano_ids: ids,
                p_cliente_email: clienteEmail
            });
            if (error || !data || data.ok !== true) {
                mostrarToast((data && data.error) || 'No se pudieron mandar los archivos', 'error');
                return;
            }
            const cl = clientes.find(c => c.email === clienteEmail);
            const destino = cl ? cl.nombre : clienteEmail;
            const ok = Number(data.asignados || 0);
            if (data.con_error) {
                mostrarToast(`${ok} enviado(s) a ${destino}. ${data.con_error} no se pudo(ieron) mandar`, 'warning');
            } else {
                mostrarToast(`${ok} archivo(s) enviado(s) a la carpeta de ${destino}`, 'success');
            }
            await cargar();
        } catch (e) {
            console.error('[SinDueno] Error mandando archivos:', e);
            mostrarToast('No se pudieron mandar los archivos', 'error');
        } finally {
            state.ocupado = false;
            if (sel) sel.disabled = false;
        }
    }

    async function descartar(id) {
        const it = state.items.find(x => String(x.id) === String(id));
        if (!it) return;
        if (!window.confirm(`¿Descartar "${it.nombre_original}"?\n\nSe borra el archivo y no se guardará en ningún cliente.`)) return;
        if (!window.confirm('Esta acción no se puede deshacer. ¿Confirmás descartarlo?')) return;
        try {
            const { data, error } = await supabase.rpc('admin_huerfano_descartar', {
                p_tenant_id: tenantId,
                p_huerfano_id: it.id
            });
            if (error || !data || data.ok !== true) {
                mostrarToast((data && data.error) || 'No se pudo descartar el archivo', 'error');
                return;
            }
            if (data.storage_path) {
                await supabase.storage.from('kanban-adjuntos').remove([data.storage_path]).catch(() => {});
            }
            mostrarToast('Archivo descartado', 'info');
            await cargar();
        } catch (e) {
            console.error('[SinDueno] Error descartando:', e);
            mostrarToast('No se pudo descartar el archivo', 'error');
        }
    }

    async function buscarCoincidencias() {
        if (state.ocupado) return;
        state.ocupado = true;
        const btn = $('sd-auto');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Buscando...'; }
        try {
            const { data, error } = await supabase.rpc('admin_huerfanos_reconciliar', { p_tenant_id: tenantId });
            if (error || !data || data.ok !== true) {
                mostrarToast((data && data.error) || 'No se pudo buscar coincidencias', 'error');
            } else {
                const a = Number(data.auto_asignados || 0);
                const amb = Number(data.ambiguos || 0);
                const sin = Number(data.sin_match || 0);
                if (!a && !amb && !sin) mostrarToast('No hay archivos sin cliente pendientes', 'info');
                else if (a) mostrarToast(`${a} archivo(s) se mandaron solos a su cliente${amb ? ` · ${amb} con más de un candidato (elegí vos)` : ''}`, 'success');
                else mostrarToast(`Ninguna coincidencia todavía${amb ? ` · ${amb} con más de un candidato` : ''}. Cuando ese cliente reserve o lo agregues, se le manda solo`, 'info');
            }
            await cargar();
        } catch (e) {
            console.error('[SinDueno] Error buscando coincidencias:', e);
            mostrarToast('No se pudo buscar coincidencias', 'error');
        } finally {
            state.ocupado = false;
        }
    }

    async function crearClienteYAsignar() {
        if (!state.seleccion.size) {
            mostrarToast('Elegí primero el/los archivo(s) con el casillero de la izquierda', 'warning');
            return;
        }
        const nombre = window.prompt('Nombre del cliente (el archivo se le mandará a él):');
        if (!nombre || !nombre.trim()) return;
        const telefono = window.prompt('Teléfono del cliente (así queda guardado y podrá reservar):') || '';
        const dig = String(telefono).replace(/\D/g, '');
        if (!dig) { mostrarToast('Necesito un teléfono para crear el cliente', 'warning'); return; }
        const email = `walkin.${dig}@sinemail.local`;
        try {
            const { data, error } = await supabase.rpc('admin_agregar_cliente', {
                p_tenant_id: tenantId,
                p_nombre: nombre.trim(),
                p_telefono: telefono,
                p_email: email,
                p_direccion: ''
            });
            if (error || !data || data.ok !== true) {
                mostrarToast((data && data.error) || 'No se pudo crear el cliente', 'error');
                return;
            }
            // El cliente nuevo entra al listado local para poder mandarle ya.
            if (!clientes.some(c => c.email === data.email)) {
                clientes.push({ nombre: nombre.trim(), email: data.email, telefono });
            }
            await mandarA([...state.seleccion], data.email, null);
        } catch (e) {
            console.error('[SinDueno] Error creando cliente:', e);
            mostrarToast('No se pudo crear el cliente', 'error');
        }
    }

    await cargar();
}
