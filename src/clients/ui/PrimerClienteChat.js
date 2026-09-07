// clients/ui/PrimerClienteChat.js
// "Conoce a tu primer cliente" — chat guiado que aparece cuando Mis
// Clientes está vacío. Pregunta nombre y teléfono, ofrece guardar
// fotos/archivos desde el primer día y CREA el cliente real con el
// mismo RPC que el modal (admin_agregar_cliente). Si el usuario elige
// guardar archivos, crea la ficha (tablero) con una sección "Archivos"
// y sube ahí lo elegido: la tarjeta del cliente queda con badges reales.
// Cero lecturas: se aprende usándolo una vez.
import { getCurrentTenantId } from '../../shared/infrastructure/router.js';
import { getSupabase } from '../../shared/infrastructure/supabase.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import * as kanbanApi from '../../api/kanbanApi.js';

const ACCEPT = [
    'image/*', 'application/pdf', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain', 'application/zip', 'video/*', 'audio/*'
].join(',');

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function soloDigitos(tel) {
    return String(tel || '').replace(/[^0-9]/g, '');
}

/**
 * Abre el chat.
 * @param {object} opts
 * @param {Function} [opts.onGuardado] callback al crear el cliente (refresca la lista)
 */
export async function abrirPrimerClienteChat({ onGuardado } = {}) {
    const tenantId = await getCurrentTenantId();
    if (!tenantId) { mostrarToast('No se pudo identificar el negocio', 'error'); return; }

    const state = { tenantId, nombre: '', telefono: '', archivos: [], guardando: false, cerrado: false };

    // ========== HTML ==========
    const overlay = document.createElement('div');
    overlay.className = 'pcc-overlay';
    overlay.innerHTML = `
        <div class="pcc-modal">
            <header class="pcc-head">
                <div class="pcc-head-icono"><i class="fas fa-comments"></i></div>
                <div class="pcc-head-txt">
                    <strong>Conoce a tu primer cliente</strong>
                    <span>Respondes un par de preguntas y queda guardado</span>
                </div>
                <button type="button" class="pcc-cerrar" id="pcc-cerrar" title="Cerrar (cancela la conversación)" aria-label="Cerrar">&times;</button>
            </header>
            <div class="pcc-chat" id="pcc-chat"></div>
            <div class="pcc-zona" id="pcc-zona"></div>
        </div>
    `;
    document.body.appendChild(overlay);

    const chat = document.getElementById('pcc-chat');
    const zona = document.getElementById('pcc-zona');

    const cerrar = () => {
        if (state.cerrado) return;
        // Protección: si ya escribió el nombre, preguntar antes de descartar.
        if (state.nombre && !state.guardando) {
            if (!window.confirm('La conversación no se ha guardado. ¿Descartarla? El cliente no se creará.')) return;
        }
        state.cerrado = true;
        overlay.remove();
    };
    document.getElementById('pcc-cerrar').addEventListener('click', cerrar);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) cerrar(); });

    function scrollAbajo() { chat.scrollTop = chat.scrollHeight; }

    function burbujaBot(html) {
        const div = document.createElement('div');
        div.className = 'pcc-msg pcc-bot';
        div.innerHTML = `<span class="pcc-burbuja">${html}</span>`;
        chat.appendChild(div);
        scrollAbajo();
        return div;
    }

    function burbujaUser(html) {
        const div = document.createElement('div');
        div.className = 'pcc-msg pcc-user';
        div.innerHTML = `<span class="pcc-burbuja">${html}</span>`;
        chat.appendChild(div);
        scrollAbajo();
    }

    function setZona(html) {
        zona.innerHTML = html;
        zona.style.display = 'block';
    }

    // ========== PASO 1: nombre ==========
    burbujaBot(`¡Hola! 👋 Soy el asistente para guardar clientes.<br><br><strong>¿Cómo se llama tu cliente más habitual?</strong>`);
    setZona(`
        <div class="pcc-fila">
            <input type="text" id="pcc-nombre" class="pcc-input" placeholder="Ej: María González" maxlength="80" autocomplete="off">
            <button type="button" class="pcc-btn" id="pcc-nombre-ok"><i class="fas fa-arrow-right"></i></button>
        </div>
    `);
    const inputNombre = document.getElementById('pcc-nombre');
    inputNombre.focus();
    const okNombre = () => {
        const v = inputNombre.value.trim();
        if (!v) { mostrarToast('Escribe el nombre del cliente', 'warning'); return; }
        state.nombre = v;
        burbujaUser(escapeHtml(v));
        pasoTelefono();
    };
    document.getElementById('pcc-nombre-ok').addEventListener('click', okNombre);
    inputNombre.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); okNombre(); } });

    // ========== PASO 2: teléfono ==========
    function pasoTelefono() {
        const conContactos = typeof navigator !== 'undefined' && navigator.contacts && navigator.contacts.select;
        burbujaBot(`Perfecto. <strong>¿Y su teléfono?</strong> Así puedes escribirle por WhatsApp desde su ficha.`);
        setZona(`
            <div class="pcc-fila">
                <input type="tel" id="pcc-telefono" class="pcc-input" placeholder="Ej: +56 9 1234 5678" autocomplete="off">
                <button type="button" class="pcc-btn" id="pcc-tel-ok"><i class="fas fa-arrow-right"></i></button>
            </div>
            ${conContactos ? '<button type="button" class="pcc-opcion pcc-opcion-ancha" id="pcc-importar"><i class="fas fa-address-book"></i> Importar de contactos</button>' : ''}
        `);
        const inputTel = document.getElementById('pcc-telefono');
        inputTel.focus();
        const okTel = () => {
            const v = inputTel.value.trim();
            if (!v) { mostrarToast('Escribe el número de teléfono', 'warning'); return; }
            if (soloDigitos(v).length < 6) { mostrarToast('Ese número parece incompleto', 'warning'); return; }
            state.telefono = v;
            burbujaUser(escapeHtml(v));
            pasoArchivos();
        };
        document.getElementById('pcc-tel-ok').addEventListener('click', okTel);
        inputTel.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); okTel(); } });
        const importar = document.getElementById('pcc-importar');
        if (importar) {
            importar.addEventListener('click', async () => {
                try {
                    const props = ['name', 'tel'];
                    const contactos = await navigator.contacts.select(props);
                    const c = contactos && contactos[0];
                    if (c) {
                        if (c.name) state.nombre = c.name;
                        const tel = (c.tel && c.tel[0]) || '';
                        if (tel) {
                            state.telefono = tel;
                            burbujaBot(`¡Listo! Guardé <strong>${escapeHtml(c.name || 'tu contacto')}</strong> con su teléfono.`);
                            inputTel.value = '';
                            pasoArchivos();
                            return;
                        }
                    }
                    mostrarToast('No se pudo leer el contacto', 'warning');
                } catch (e) {
                    mostrarToast('No se pudo acceder a los contactos', 'warning');
                }
            });
        }
    }

    // ========== PASO 3: ¿fotos/archivos? ==========
    function pasoArchivos() {
        const primerNombre = state.nombre.split(' ')[0];
        burbujaBot(`Última pregunta: <strong>¿le tomas fotos o le pasas archivos?</strong> Muchos guardan el progreso, la rutina o el contrato.`);
        setZona(`
            <button type="button" class="pcc-opcion" data-files="1"><i class="fas fa-paperclip"></i> Sí, quiero guardarle cosas</button>
            <button type="button" class="pcc-opcion" data-files="0"><i class="fas fa-user"></i> Solo su información</button>
        `);
        zona.querySelectorAll('.pcc-opcion').forEach(btn => {
            btn.addEventListener('click', () => {
                burbujaUser(btn.dataset.files === '1'
                    ? 'Sí, quiero guardarle cosas'
                    : 'Solo su información');
                if (btn.dataset.files === '1') pasoSubirArchivos(); else pasoFinal(true);
            });
        });
    }

    // ========== PASO 4: subir archivos (opcional) ==========
    function pasoSubirArchivos() {
        burbujaBot(`¡Buena idea! Toca el botón y elige una foto o un archivo de <strong>${escapeHtml(state.nombre.split(' ')[0])}</strong>: quedará guardado en su ficha desde el primer día.`);
        setZona(`
            <label class="pcc-file-btn" for="pcc-file">
                <i class="fas fa-cloud-upload-alt"></i> Subir foto o archivo
            </label>
            <input type="file" id="pcc-file" multiple accept="${ACCEPT}" style="display:none;">
            <div class="pcc-lista" id="pcc-lista"></div>
            <div class="pcc-fila">
                <button type="button" class="pcc-btn-secundario" id="pcc-saltar">Continuar sin archivos</button>
                <button type="button" class="pcc-btn" id="pcc-archivos-ok" style="display:none;"><i class="fas fa-check"></i> Guardar ${escapeHtml(state.nombre.split(' ')[0])}</button>
            </div>
        `);
        const lista = document.getElementById('pcc-lista');
        const btnOk = document.getElementById('pcc-archivos-ok');
        const fileInput = document.getElementById('pcc-file');
        const pintarLista = () => {
            lista.innerHTML = state.archivos.map((f, i) => `
                <span class="pcc-chip">${escapeHtml(f.name)} <button type="button" data-i="${i}" title="Quitar" class="pcc-chip-x">&times;</button></span>
            `).join('');
            lista.querySelectorAll('.pcc-chip-x').forEach(x => {
                x.addEventListener('click', () => {
                    state.archivos.splice(Number(x.dataset.i), 1);
                    pintarLista();
                    btnOk.style.display = state.archivos.length ? 'inline-flex' : 'none';
                });
            });
            btnOk.style.display = state.archivos.length ? 'inline-flex' : 'none';
        };
        fileInput.addEventListener('change', () => {
            const elegidos = Array.from(fileInput.files || []);
            fileInput.value = '';
            elegidos.forEach(f => {
                if (f.size > 100 * 1024 * 1024) {
                    mostrarToast(`"${f.name}" supera los 100 MB`, 'warning');
                    return;
                }
                state.archivos.push(f);
            });
            pintarLista();
            if (state.archivos.length) burbujaUser(`Subiré ${state.archivos.length} archivo(s) a su ficha`);
        });
        document.getElementById('pcc-saltar').addEventListener('click', () => pasoFinal(true));
        btnOk.addEventListener('click', () => pasoFinal(false));
    }

    // ========== PASO 5: guardar (real) ==========
    async function pasoFinal(sinArchivos) {
        if (state.guardando) return;
        state.guardando = true;
        burbujaBot(`<i class="fas fa-spinner fa-spin"></i> Guardando a <strong>${escapeHtml(state.nombre.split(' ')[0])}</strong>…`);
        setZona('');
        try {
            const email = `walkin.${soloDigitos(state.telefono).slice(0, 12)}@sinemail.local`;
            const { data: r, error: e } = await getSupabase().rpc('admin_agregar_cliente', {
                p_tenant_id: state.tenantId,
                p_nombre: state.nombre,
                p_telefono: state.telefono,
                p_email: email,
                p_direccion: ''
            });
            if (e || !r || r.ok !== true) {
                burbujaBot(`⚠️ No se pudo guardar: ${escapeHtml((r && r.error) || (e && e.message) || 'error desconocido')}.`);
                state.guardando = false;
                return;
            }

            let nSubidos = 0;
            if (!sinArchivos && state.archivos.length) {
                try {
                    const board = await kanbanApi.getOrCreateBoard(state.tenantId, email, state.nombre);
                    const datos = await kanbanApi.getBoardData(board.id);
                    let lista = (datos.lists || []).find(l => l.titulo === 'Archivos');
                    if (!lista) lista = await kanbanApi.createList(board.id, 'Archivos', (datos.lists || []).length);
                    let card = (lista.cards || []).find(c => c.titulo === 'Adjuntos');
                    if (!card) {
                        card = await kanbanApi.createCard(lista.id, {
                            titulo: 'Adjuntos',
                            descripcion: 'Archivos subidos al crear este cliente'
                        });
                    }
                    for (let i = 0; i < state.archivos.length; i++) {
                        const file = state.archivos[i];
                        const status = burbujaBot(`Subiendo <strong>${escapeHtml(file.name)}</strong> (${i + 1} de ${state.archivos.length})…`);
                        try {
                            const storagePath = await kanbanApi.uploadAttachment(file, board.id, card.id);
                            await kanbanApi.addAttachment(card.id, {
                                nombre: file.name,
                                tipo_mime: file.type || 'application/octet-stream',
                                tamano: file.size || 0,
                                storage_path: storagePath
                            });
                            status.querySelector('.pcc-burbuja').innerHTML = `✅ <strong>${escapeHtml(file.name)}</strong> guardado en su ficha`;
                            nSubidos++;
                        } catch (err) {
                            console.error('[PrimerClienteChat] Error subiendo adjunto:', err);
                            status.querySelector('.pcc-burbuja').innerHTML = `⚠️ <strong>${escapeHtml(file.name)}</strong> no se pudo subir`;
                        }
                    }
                } catch (err) {
                    console.error('[PrimerClienteChat] Error creando ficha/archivos:', err);
                    burbujaBot('⚠️ El cliente quedó guardado, pero no se pudieron subir los archivos. Puedes agregarlos después desde su ficha.');
                }
            }

            if (typeof onGuardado === 'function') onGuardado();
            const detalles = r.ya_existia
                ? 'Ya existía: se actualizaron sus datos.'
                : 'Quedó guardado en Mis Clientes.';
            const resumen = nSubidos
                ? ` con <strong>${nSubidos} archivo(s)</strong> en su ficha`
                : (state.archivos.length ? ' (sin archivos por ahora)' : '');
            burbujaBot(`🎉 <strong>${escapeHtml(state.nombre.split(' ')[0])} listo!</strong> ${escapeHtml(detalles)} Su tarjeta aparece${resumen}.<br><br>La próxima vez que venga, toca su nombre y tendrás todo a mano: su historia, sus archivos y el botón para compartirle lo que quieras.`);
            setZona(`
                <div class="pcc-fila">
                    <button type="button" class="pcc-btn-secundario" id="pcc-ver-lista">Ver Mis Clientes</button>
                </div>
            `);
            document.getElementById('pcc-ver-lista').addEventListener('click', () => {
                state.cerrado = true;
                overlay.remove();
            });
            mostrarToast(`Cliente "${state.nombre}" agregado${nSubidos ? ` con ${nSubidos} archivo(s)` : ''}`, 'success');
        } catch (err) {
            console.error('[PrimerClienteChat] Error guardando cliente:', err);
            burbujaBot('⚠️ Ocurrió un error al guardar. Inténtalo de nuevo.');
            state.guardando = false;
        }
    }
}
