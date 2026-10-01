// src/clients/ui/PredeterminadosPanel.js
// "Predeterminados" del tablero — panel del admin en Mis Clientes.
//
// Explica y ejecuta: guardar las listas/tarjetas/checklists que se repiten en
// TODOS los clientes (anamnesis, sesión base de ejercicios, datos importantes)
// y ponerlas solas en cada tablero —nuevo o existente— en blanco, para rellenar.
//
// Diseño: overlay propio (z-index alto) sobre ClientBoard. Escape en CAPTURE +
// stopImmediatePropagation para NO cerrar el tablero de atrás (pitfall conocido).
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { getCurrentTenantId } from '../../shared/infrastructure/router.js';
import {
    getPredeterminados,
    guardarDesdeBoard,
    borrarPredeterminados,
    setAutoAplicar,
    aplicarATodos,
    aplicarAClientes
} from '../../api/predeterminadosApi.js';

const BTN_PRI = 'padding:11px 18px;border-radius:12px;background:linear-gradient(135deg,var(--primary-color,#9d4edd),#7b2cbf);border:none;color:#fff;cursor:pointer;font-size:0.88rem;font-weight:700;display:inline-flex;align-items:center;gap:8px;box-shadow:0 6px 18px rgba(157,78,221,0.32);';
const BTN_SEC = 'padding:10px 16px;border-radius:12px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.14);color:var(--text-color,#e0e0e0);cursor:pointer;font-size:0.84rem;font-weight:600;display:inline-flex;align-items:center;gap:8px;';
const BTN_PEL = 'padding:10px 16px;border-radius:12px;background:rgba(255,80,80,0.12);border:1px solid rgba(255,80,80,0.28);color:#ff6b6b;cursor:pointer;font-size:0.84rem;font-weight:600;display:inline-flex;align-items:center;gap:8px;';
const CARD = 'background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:14px 16px;margin-bottom:12px;';

function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * @param {object} opts
 * @param {string} opts.boardId        tablero abierto (para "guardar lo que ves")
 * @param {string} [opts.clienteNombre]
 * @param {number} [opts.totalClientes] cantidad de clientes del negocio
 * @param {Function} [opts.onCambio]   refresca el tablero después de aplicar
 */
export async function abrirPredeterminados({ boardId, clienteNombre = '', totalClientes = 0, clientes = [], onCambio } = {}) {
    const tenantId = await getCurrentTenantId();
    if (!tenantId || !boardId) {
        mostrarToast('No se pudo identificar el negocio o el cliente', 'error');
        return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'kanban-card-overlay';
    overlay.style.zIndex = '2600';
    overlay.innerHTML = `
        <div class="glass-panel" style="max-width:720px;width:96%;max-height:94vh;overflow-y:auto;padding:0;border-radius:16px;display:flex;flex-direction:column;">
            <header style="padding:16px 18px 12px;border-bottom:1px solid rgba(255,255,255,0.08);position:sticky;top:0;background:linear-gradient(135deg, rgba(157,78,221,0.18), rgba(0,184,148,0.06));z-index:2;border-radius:16px 16px 0 0;">
                <div style="display:flex;align-items:center;gap:12px;">
                    <div style="width:42px;height:42px;border-radius:12px;background:linear-gradient(135deg,var(--primary-color,#9d4edd),#00b894);display:flex;align-items:center;justify-content:center;color:#fff;font-size:1.05rem;flex-shrink:0;box-shadow:0 4px 14px rgba(157,78,221,0.35);">
                        <i class="fas fa-clipboard-list"></i>
                    </div>
                    <div style="flex:1;min-width:0;">
                        <h4 style="margin:0;font-size:1.02rem;"><strong>Predeterminados: lo que le pides a TODOS tus clientes</strong></h4>
                        <p style="margin:2px 0 0;font-size:0.76rem;color:var(--text-muted,#aaa);">Lo armas una vez y aparece solo en el tablero de cada cliente, en blanco, para rellenar.</p>
                    </div>
                    <button class="kanban-btn-close" id="pd-cerrar" title="Cerrar">&times;</button>
                </div>
            </header>
            <div style="padding:16px 18px;" id="pd-cuerpo"></div>
            <footer style="padding:12px 18px 16px;border-top:1px solid rgba(255,255,255,0.07);display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;position:sticky;bottom:0;background:linear-gradient(180deg, rgba(20,20,30,0.88), rgba(20,20,30,0.99));backdrop-filter:blur(8px);z-index:2;">
                <button id="pd-quitar" style="${BTN_PEL};display:none;"><i class="fas fa-trash"></i> Quitar predeterminados</button>
                <button id="pd-todos" style="${BTN_SEC}flex:1 1 200px;justify-content:center;display:none;"><i class="fas fa-users"></i> Ponerlos a TODOS mis clientes</button>
                <button id="pd-guardar" style="${BTN_PRI}flex:1 1 240px;justify-content:center;"><i class="fas fa-bookmark"></i> Guardar este tablero como predeterminado</button>
                <button id="pd-cerrar2" style="${BTN_SEC}">Cerrar</button>
            </footer>
        </div>
    `;
    document.body.appendChild(overlay);

    let cerrado = false;
    const cerrar = () => {
        if (cerrado) return;
        cerrado = true;
        document.removeEventListener('keydown', onEsc, true);
        overlay.remove();
    };
    // CAPTURE + stopImmediatePropagation: si no, Escape cerraría el tablero de atrás
    const onEsc = (e) => {
        if (e.key === 'Escape') { e.stopImmediatePropagation(); cerrar(); }
    };
    document.addEventListener('keydown', onEsc, true);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) cerrar(); });
    // Anti doble apertura/cierre fantasma del click que abrió el panel
    const creadoEn = Date.now();
    overlay.addEventListener('click', (e) => { if (e.target === overlay && Date.now() - creadoEn > 450) cerrar(); });

    const $cuerpo = overlay.querySelector('#pd-cuerpo');
    const $btnQuitar = overlay.querySelector('#pd-quitar');
    const $btnTodos = overlay.querySelector('#pd-todos');
    const $btnGuardar = overlay.querySelector('#pd-guardar');
    overlay.querySelector('#pd-cerrar').addEventListener('click', cerrar);
    overlay.querySelector('#pd-cerrar2').addEventListener('click', cerrar);

    let ocupado = false;
    const bloquear = (v) => {
        ocupado = v;
        [$btnQuitar, $btnTodos, $btnGuardar].forEach(b => { if (b) b.disabled = v; });
        [$btnQuitar, $btnTodos, $btnGuardar].forEach(b => { if (b) b.style.opacity = v ? '0.55' : '1'; });
    };

    function resumenListas(contenido) {
        const listas = (contenido && contenido.listas) || [];
        if (!listas.length) return '';
        return listas.map(l => {
            const nTar = (l.tarjetas || []).length;
            const nItems = (l.tarjetas || []).reduce((a, t) => a + ((t.checklist || []).length), 0);
            return `<span style="display:inline-flex;align-items:center;gap:6px;padding:6px 11px;border-radius:999px;background:rgba(0,184,148,0.10);border:1px solid rgba(0,184,148,0.25);color:#3ddc97;font-size:0.76rem;font-weight:600;margin:0 6px 6px 0;">
                <i class="fas fa-layer-group"></i> ${escapeHtml(l.titulo)}
                <span style="color:var(--text-muted,#999);font-weight:500;">${nTar ? nTar + ' tarjeta(s)' : ''}${nItems ? (nTar ? ' · ' : '') + nItems + ' punto(s)' : ''}</span>
            </span>`;
        }).join('');
    }

    async function pintar() {
        const pre = await getPredeterminados(tenantId);
        const tiene = !!(pre && pre.contenido && Array.isArray(pre.contenido.listas) && pre.contenido.listas.length);
        $btnTodos.style.display = tiene ? '' : 'none';
        $btnQuitar.style.display = tiene ? '' : 'none';
        if (pre) { $btnGuardar.innerHTML = '<i class="fas fa-bookmark"></i> Actualizar predeterminados con ESTE tablero'; }

        $cuerpo.innerHTML = `
            <div style="${CARD}border-color:rgba(0,184,148,0.28);background:linear-gradient(135deg, rgba(0,184,148,0.07), rgba(157,78,221,0.04));">
                <div style="display:flex;gap:10px;align-items:flex-start;">
                    <i class="fas fa-lightbulb" style="color:#ffc107;font-size:1.05rem;margin-top:2px;"></i>
                    <div style="font-size:0.84rem;line-height:1.55;">
                        <strong>¿Para qué sirve?</strong> Para lo que le pides a <strong>todos</strong> tus clientes y ya te da flojera escribir de nuevo en cada uno.
                        <div style="margin-top:8px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);">
                            <strong style="color:#c77dff;">Ejemplo (entrenador):</strong> armas una lista <strong>“Anamnesis”</strong> con las preguntas fijas que le haces a todos
                            y una lista <strong>“Entrenamientos”</strong> con la sesión base de <strong>6 ejercicios</strong>. Las guardas como predeterminadas
                            (quedan <em>en blanco</em>, sin datos de nadie) y la web las pone solas en cada cliente: te queda solo rellenar.
                        </div>
                        <div style="margin-top:8px;font-size:0.8rem;color:var(--text-muted,#aaa);">
                            Lo mismo sirve para un profesor, una nutricionista, una estilista, un taller: <strong>“Ficha de ingreso”</strong>,
                            <strong>“Datos importantes del alumno”</strong>, <strong>“Historial de tratamientos”</strong>…
                        </div>
                    </div>
                </div>
            </div>

            <div style="${CARD}">
                <div style="font-weight:700;font-size:0.86rem;margin-bottom:8px;"><i class="fas fa-list-ol" style="color:var(--primary-color,#9d4edd);"></i> Cómo se usa (3 pasos)</div>
                <ol style="margin:0;padding-left:20px;font-size:0.82rem;line-height:1.75;color:var(--text-color,#e0e0e0);">
                    <li>En <strong>este</strong> tablero deja las listas y tarjetas como quieras que salgan todos (aquí en blanco, sin datos de ${escapeHtml(clienteNombre || 'este cliente')}).</li>
                    <li>Toca <strong>“Guardar este tablero como predeterminado”</strong>.</li>
                    <li>Toca <strong>“Ponerlos a TODOS mis clientes”</strong>. Los clientes nuevos ya los reciben solos. Si a alguien no le sirven, borra esas listas de su tablero: los demás no cambian.</li>
                </ol>
            </div>

            <div style="${CARD}">
                <div style="font-weight:700;font-size:0.86rem;margin-bottom:8px;"><i class="fas fa-check-circle" style="color:${tiene ? '#00b894' : '#8b8fa3'};"></i> ${tiene ? 'Tus predeterminados guardados' : 'Todavía no guardaste predeterminados'}</div>
                ${tiene
                    ? `<div>${resumenListas(pre.contenido)}</div>
                       ${pre.aplicado_en ? `<div style="font-size:0.76rem;color:var(--text-muted,#999);margin-top:4px;">Última vez puesto a ${pre.aplicado_a || 0} tablero(s): ${new Date(pre.aplicado_en).toLocaleDateString('es-CL')}.</div>` : ''}`
                    : `<div style="font-size:0.82rem;color:var(--text-muted,#aaa);">Deja listas y tarjetas acá y toca el botón violeta de abajo: lo que ves se convierte en la base de todos tus clientes.</div>`}
                <label style="display:flex;align-items:center;gap:10px;margin-top:12px;font-size:0.82rem;cursor:pointer;${tiene ? '' : 'opacity:0.5;'}">
                    <input type="checkbox" id="pd-auto" ${pre && pre.auto_aplicar === true ? 'checked' : ''} ${tiene ? '' : 'disabled'} style="width:18px;height:18px;accent-color:#9d4edd;cursor:pointer;">
                    <span>Ponerlos <strong>solos</strong> cuando entra un cliente nuevo al tablero</span>
                </label>
            </div>

            <div style="font-size:0.78rem;color:var(--text-muted,#999);line-height:1.6;">
                <i class="fas fa-circle-info"></i> Se guardan las <strong>listas</strong>, sus <strong>tarjetas</strong> y sus <strong>checklists</strong>.
                No se copian citas, etiquetas de pago ni archivos: eso es de cada cliente.
                ${totalClientes ? ` Ahora tenés <strong>${totalClientes}</strong> cliente(s) en Mis Clientes.` : ''}
            </div>
        `;

        const $auto = overlay.querySelector('#pd-auto');
        if ($auto && tiene) {
            $auto.addEventListener('change', async () => {
                try {
                    await setAutoAplicar(tenantId, $auto.checked);
                    mostrarToast($auto.checked ? 'Listo: se pondrán solos en los clientes nuevos' : 'Desactivado: ya no se ponen solos', 'success');
                } catch (e) {
                    console.error('[predeterminados] no se pudo cambiar auto:', e);
                    $auto.checked = !$auto.checked;
                    mostrarToast('No se pudo guardar la preferencia', 'error');
                }
            });
        }
    }

    // ---- Guardar (snapshot del tablero abierto) ----
    $btnGuardar.addEventListener('click', async () => {
        if (ocupado) return;
        bloquear(true);
        try {
            const contenido = await guardarDesdeBoard(tenantId, boardId, 'Predeterminados');
            const n = (contenido.listas || []).length;
            mostrarToast(n
                ? `Guardados ${n} predeterminado(s) con lo de este tablero`
                : 'No hay listas en este tablero para guardar', n ? 'success' : 'warning');
            await pintar();
        } catch (e) {
            console.error('[predeterminados] error guardando:', e);
            mostrarToast('No se pudieron guardar los predeterminados', 'error');
        } finally { bloquear(false); }
    });

    // ---- Aplicar a TODOS ----
    $btnTodos.addEventListener('click', async () => {
        if (ocupado) return;
        const pre = await getPredeterminados(tenantId);
        const listas = (pre && pre.contenido && pre.contenido.listas) || [];
        if (!listas.length) { mostrarToast('Primero guarda los predeterminados', 'warning'); return; }
        const nombres = listas.map(l => `• ${l.titulo}`).join('\n');
        if (!window.confirm(`Se van a poner estas listas en el tablero de TODOS tus clientes:\n\n${nombres}\n\nLas listas que ya tengan no se duplican. ¿Seguir?`)) return;

        bloquear(true);
        const $prog = document.createElement('div');
        $prog.style.cssText = 'margin-top:12px;font-size:0.8rem;color:var(--text-muted,#aaa);';
        $prog.textContent = 'Poniendo a todos los clientes…';
        $cuerpo.appendChild($prog);
        try {
            const r = (Array.isArray(clientes) && clientes.length)
                ? await aplicarAClientes(tenantId, clientes, (hechos, total, nombre) => { $prog.textContent = `${hechos}/${total} · ${nombre || ''}`; })
                : await aplicarATodos(tenantId, (hechos, total, nombre) => { $prog.textContent = `${hechos}/${total} · ${nombre || ''}`; });
            if (!r.ok) { mostrarToast('No se pudo aplicar', 'warning'); return; }
            mostrarToast(`Listo: ${r.tableros} tablero(s) · ${r.listas_creadas} lista(s) y ${r.tarjetas_creadas} tarjeta(s) nuevas${r.items_creados ? ' · ' + r.items_creados + ' punto(s) de checklist' : ''}`, 'success');
            if (typeof onCambio === 'function') { try { await onCambio(); } catch (e) { /* no crítico */ } }
            await pintar();
        } catch (e) {
            console.error('[predeterminados] error aplicando a todos:', e);
            mostrarToast('Hubo un error al aplicar a todos', 'error');
        } finally { bloquear(false); $prog.remove(); }
    });

    // ---- Quitar predeterminados (doble confirmación: no toca los tableros ya hechos) ----
    $btnQuitar.addEventListener('click', async () => {
        if (ocupado) return;
        if (!window.confirm('¿Quitar los predeterminados?\n\nNo borra nada de los tableros ya creados: solo deja de ponerlos en los próximos clientes.')) return;
        if (!window.confirm('Confirmá una vez más: quitar los predeterminados del negocio.')) return;
        bloquear(true);
        try {
            await borrarPredeterminados(tenantId);
            mostrarToast('Predeterminados quitados', 'success');
            await pintar();
        } catch (e) {
            console.error('[predeterminados] error quitando:', e);
            mostrarToast('No se pudieron quitar', 'error');
        } finally { bloquear(false); }
    });

    await pintar();
}
