// services/ui/ServiceForm.js
// Formulario de creacion/edicion de servicio en admin.html

import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { formatearDinero } from '../../shared/infrastructure/formatters.js';
import { getAllTrabajadores, getTrabajadoresDelServicio, asignarTrabajadoresAlServicio } from '../../workers/application/WorkersService.js';
import { calcularHorasEfectivas } from '../../workers/domain/horarioValidation.js';

/**
 * Un trabajador "tiene tiempo disponible" si su horario semanal tiene
 * al menos un día activo con horas efectivas > 0.
 */
function tieneDisponibilidad(w) {
    const hs = w && w.horario_semanal;
    if (!hs || typeof hs !== 'object') return false;
    for (let k = 1; k <= 7; k++) {
        const dia = hs[String(k)];
        if (dia && dia.activo && calcularHorasEfectivas(dia) > 0) return true;
    }
    return false;
}

export function configurarFormularioServicio() {
    const form = document.getElementById('service-form');
    if (!form) return;

    // Botón "Ver tutorial" + reproductor que se fija arriba al reproducir
    initTutorialServicio();

    // Contador de caracteres en descripcion
    const textarea = document.getElementById('srv-desc');
    const contador = document.getElementById('char-count');
    if (textarea && contador) {
        textarea.addEventListener('input', function() { contador.textContent = this.value.length; });
    }

    document.getElementById('reset-form')?.addEventListener('click', () => {
        delete form.dataset.editId;
    });

    document.getElementById('clear-image')?.addEventListener('click', function() {
        document.getElementById('srv-image-url').value = '';
        const fi = document.getElementById('srv-image-file');
        if (fi) fi.value = '';
        const fnd = document.getElementById('file-name-display');
        if (fnd) fnd.textContent = 'Elegir imagen';
    });

    // Sincronizar duración con el hint del generador de módulos
    const durInput = document.getElementById('srv-duration');
    const genDurDisplay = document.getElementById('gen-duration-display');
    if (durInput && genDurDisplay) {
        const actualizarHintDuracion = () => {
            genDurDisplay.textContent = durInput.value || '60';
        };
        durInput.addEventListener('input', actualizarHintDuracion);
        durInput.addEventListener('change', actualizarHintDuracion);
        actualizarHintDuracion();
    }

    // Cargar checkboxes de trabajadores
    cargarWorkersCheckboxes();

    // Guardar trabajadores al hacer submit del form
    // El submit lo maneja el legacy script.js, pero interceptamos para
    // guardar la relación servicio↔trabajadores
    const existingSubmit = form.querySelector('button[type="submit"]');
    if (existingSubmit) {
        existingSubmit.addEventListener('click', async (e) => {
            const editId = form.dataset.editId;
            if (!editId) return; // Solo en edición se necesita guardar la relación
    
            // Obtener workers seleccionados
            const checkboxes = document.querySelectorAll('#service-workers-list input[type="checkbox"]:checked');
            const selectedIds = Array.from(checkboxes).map(cb => cb.value);
            try {
                await asignarTrabajadoresAlServicio(editId, selectedIds);
            } catch (err) {
                console.error('Error guardando trabajadores del servicio:', err);
            }
        });
    }
}

// Expuesta globalmente para que script.js legacy pueda llamarla al crear/editar
export async function guardarWorkersDelServicio(servicioId) {
    const checkboxes = document.querySelectorAll('#service-workers-list input[type="checkbox"]:checked');
    const selectedIds = Array.from(checkboxes).map(cb => cb.value);
    try {
        await asignarTrabajadoresAlServicio(servicioId, selectedIds);
    } catch (err) {
        console.error('Error guardando trabajadores del servicio:', err);
    }
}

async function cargarWorkersCheckboxes() {
    const container = document.getElementById('service-workers-list');
    if (!container) return;

    // El paso 4 del formulario (details.form-step) se oculta por completo
    // cuando no hay trabajadores activos: crear el servicio no debe exigir nada.
    const paso = container.closest('details.form-step') || container.closest('details');

    try {
        const workers = await getAllTrabajadores();
        const activos = workers.filter(w => w.activo);

        if (!activos.length) {
            container.innerHTML = '';
            container.dataset.requiereTrabajador = '0';
            if (paso) paso.style.display = 'none';
            return;
        }
        if (paso) paso.style.display = '';

        // Determinar workers ya seleccionados (modo edición)
        const editId = document.getElementById('service-form')?.dataset?.editId;
        let selectedIds = [];
        if (editId) {
            try {
                const existing = await getTrabajadoresDelServicio(editId);
                selectedIds = (existing || []).map(w => w.id);
            } catch (e) {
                // Silencioso
            }
        }

        // Separar: solo los que tienen horario configurado son seleccionables
        const disponibles = activos.filter(tieneDisponibilidad);
        const sinHorario = activos.filter(w => !tieneDisponibilidad(w));
        // En edición, los ya asignados se mantienen habilitados aunque no tengan horario
        const sinHorarioYaAsignados = sinHorario.filter(w => selectedIds.includes(w.id));
        const sinHorarioBloqueados = sinHorario.filter(w => !selectedIds.includes(w.id));

        container.dataset.requiereTrabajador = disponibles.length > 0 ? '1' : '0';

        const renderWorker = (w, bloqueado) => {
            const checked = selectedIds.includes(w.id);
            const disabled = bloqueado ? 'disabled' : '';
            const cls = `worker-checkbox-label ${checked ? 'checked' : ''} ${bloqueado ? 'worker-checkbox-disabled' : ''}`;
            return `
                <label class="${cls}" title="${bloqueado ? 'Sin horario configurado — define su horario en la sección Horarios antes de asignarlo' : ''}">
                    <input type="checkbox" value="${w.id}" ${checked ? 'checked' : ''} ${disabled}>
                    <span class="worker-check-avatar" style="background:${w.color || '#9d4edd'};${bloqueado ? 'filter:grayscale(1);opacity:0.5;' : ''}">
                        ${w.nombre.charAt(0).toUpperCase()}
                    </span>
                    <span class="worker-check-name">${escapeHtml(w.nombre)}</span>
                    <span class="worker-check-skills">
                        ${bloqueado
                            ? '<span style="color:#ff9f43;">⛔ Sin horario</span>'
                            : (w.habilidades ? escapeHtml(w.habilidades) : 'Disponible')}
                    </span>
                </label>
            `;
        };

        container.innerHTML = `
            <div class="workers-checkbox-grid">
                ${disponibles.map(w => renderWorker(w, false)).join('')}
                ${sinHorarioYaAsignados.map(w => renderWorker(w, false)).join('')}
                ${sinHorarioBloqueados.map(w => renderWorker(w, true)).join('')}
            </div>
            ${disponibles.length > 0 ? `
                <p class="field-hint" style="margin-top:6px;color:#ffd700;">
                    <i class="fas fa-exclamation-triangle"></i> Obligatorio: selecciona al menos un trabajador con disponibilidad para este servicio.
                </p>
            ` : `
                <p class="field-hint" style="margin-top:6px;">
                    Ningún trabajador tiene horario configurado aún. Puedes crear el servicio sin asignar trabajadores, o configurar horarios en la sección Horarios.
                </p>
            `}
        `;

        // Event listeners para toggle class
        container.querySelectorAll('.worker-checkbox-label input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', () => {
                cb.closest('.worker-checkbox-label').classList.toggle('checked', cb.checked);
            });
        });

    } catch (e) {
        console.error('Error cargando workers checkboxes:', e);
        container.innerHTML = '';
        container.dataset.requiereTrabajador = '0';
        if (paso) paso.style.display = 'none';
    }
}

/**
 * Validación usada por legacy script.js al CREAR un servicio.
 * Solo exige seleccionar trabajador si existen trabajadores con disponibilidad horaria.
 * @returns {{valido: boolean, mensaje: string}}
 */
export function validarWorkersServicio() {
    const container = document.getElementById('service-workers-list');
    if (!container || container.dataset.requiereTrabajador !== '1') {
        return { valido: true, mensaje: '' };
    }
    const checkboxes = container.querySelectorAll('input[type="checkbox"]:checked');
    if (!checkboxes.length) {
        return {
            valido: false,
            mensaje: '⚠️ Hay trabajadores con disponibilidad horaria. Selecciona al menos uno para este servicio (o quita el horario a todos en la sección Horarios si quieres crearlo sin asignación).'
        };
    }
    return { valido: true, mensaje: '' };
}

export async function editarServicioForm(id, servicio) {
    const form = document.getElementById('service-form');
    if (!form) return;
    form.dataset.editId = id;
    document.getElementById('srv-name').value = servicio.nombre || '';
    document.getElementById('srv-price').value = servicio.precio || 0;
    document.getElementById('srv-desc').value = servicio.descripcion || '';
    document.getElementById('srv-image-url').value = servicio.imagen || '';
    const fi2 = document.getElementById('srv-image-file');
    if (fi2) fi2.value = '';
    const fnd2 = document.getElementById('file-name-display');
    if (fnd2) fnd2.textContent = 'Elegir imagen';
    document.getElementById('srv-featured').checked = servicio.destacado || false;
    document.getElementById('srv-active').checked = servicio.activo !== false;
    // Cargar fechas
    const fechas = servicio.fechas || Object.keys(servicio.disponibilidad || {});
    window.selectedDates = new Set(fechas);
    if (typeof renderCalendar === 'function') renderCalendar();
    // Cargar modulos
    const modulos = Object.values(servicio.disponibilidad || {})[0] || [];
    window.serviceModules = modulos.map((m, i) => ({ ...m, id: window.generateModuleId() }));
    if (typeof renderModulesList === 'function') renderModulesList();
    // Recargar checkboxes de trabajadores
    await cargarWorkersCheckboxes();
    // Scrollear al formulario
    form.scrollIntoView({ behavior: 'smooth' });
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.textContent = 'ACTUALIZAR SERVICIO';
}

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ============================================================
// TUTORIAL EN VIDEO — sección Crear Servicio (admin)
// Botón "Ver tutorial" junto al título; al presionar play el
// video se fija en la parte superior y queda visible mientras
// se scrollea y se rellena el formulario.
// El video se sirve desde Supabase Storage (bucket público
// 'tutoriales'). CSP: media-src incluye el origen de Supabase
// (vercel.json + server.py).
// ============================================================
const VIDEO_TUTORIAL_URL = 'https://dfcfimipkfhitlsyixqu.supabase.co/storage/v1/object/public/tutoriales/tutorial-crear-servicio.mp4?v=1';

function initTutorialServicio() {
    const header = document.getElementById('section-title-servicio');
    const form = document.getElementById('service-form');
    if (!header || !form) return;

    const section = form.closest('.section-content') || document.getElementById('section-crear-servicio');

    // ---- Contenedor del reproductor (entre el título y el formulario) ----
    const wrap = document.createElement('div');
    wrap.className = 'tutorial-video-wrap';
    wrap.id = 'tutorial-video-wrap';
    wrap.innerHTML = `
        <div class="tutorial-bar">
            <video id="tutorial-video" controls playsinline preload="metadata"></video>
        </div>
        <p class="tutorial-fixed-hint"><i class="fas fa-arrow-down"></i> Completá el formulario acá abajo — el tutorial sigue arriba</p>
        <button type="button" class="tutorial-close-btn" id="tutorial-close-btn" title="Cerrar tutorial" aria-label="Cerrar tutorial"><i class="fas fa-times"></i></button>
        <div class="tutorial-msg" id="tutorial-msg"></div>
    `;
    form.parentNode.insertBefore(wrap, form);

    const video = wrap.querySelector('video');
    const closeBtn = wrap.querySelector('.tutorial-close-btn');
    const msg = wrap.querySelector('.tutorial-msg');

    // ---- Botón "Ver tutorial" junto al título (wrapper flex) ----
    const headerFlex = document.createElement('div');
    headerFlex.className = 'section-header-flex';
    header.parentNode.insertBefore(headerFlex, header);
    headerFlex.appendChild(header);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'btn-ver-tutorial';
    btn.className = 'tutorial-btn';
    btn.innerHTML = '<i class="fas fa-play-circle"></i> Ver tutorial';
    headerFlex.appendChild(btn);

    let fijo = false;
    // Posición original del wrap (para restaurarlo al cerrar)
    let wrapParent = null;
    let wrapNext = null;

    function abrirTutorial() {
        if (!video.src) video.src = VIDEO_TUTORIAL_URL;
        wrap.classList.add('tutorial-open');
        btn.innerHTML = '<i class="fas fa-times-circle"></i> Cerrar tutorial';
        btn.classList.add('tutorial-btn-activo');
    }

    function cerrarTutorial() {
        video.pause();
        wrap.classList.remove('tutorial-open', 'tutorial-fixed');
        // Restaurar el wrap a su lugar original (entre el título y el form)
        if (wrapParent) {
            if (wrapNext) wrapParent.insertBefore(wrap, wrapNext);
            else wrapParent.appendChild(wrap);
            wrapParent = null;
            wrapNext = null;
        }
        if (section) section.style.paddingTop = '';
        fijo = false;
        btn.innerHTML = '<i class="fas fa-play-circle"></i> Ver tutorial';
        btn.classList.remove('tutorial-btn-activo');
    }

    function activarFijo() {
        if (fijo) return;
        fijo = true;
        // ⚠️ .glass-panel tiene backdrop-filter, que crea un containing block
        // y rompe position:fixed → mover el reproductor a <body> mientras esté fijo
        wrapParent = wrap.parentNode;
        wrapNext = wrap.nextSibling;
        document.body.appendChild(wrap);
        wrap.classList.add('tutorial-fixed');
        // Espacio bajo el video fijo para poder rellenar el formulario sin que quede tapado
        const h = wrap.offsetHeight;
        if (section) section.style.paddingTop = (h + 16) + 'px';
    }

    btn.addEventListener('click', () => {
        if (wrap.classList.contains('tutorial-open')) cerrarTutorial();
        else abrirTutorial();
    });
    closeBtn.addEventListener('click', cerrarTutorial);

    // Al presionar play → el video se fija arriba y queda visible mientras se scrollea
    video.addEventListener('play', activarFijo);

    // Si el video aún no está subido a Supabase → mensaje visible (nada silencioso)
    video.addEventListener('error', () => {
        msg.textContent = '⚠️ Tutorial aún no disponible. Subí el video al bucket "tutoriales" de Supabase (pasos en el chat) y recargá la página.';
        msg.style.display = 'block';
    });
    video.addEventListener('canplay', () => { msg.style.display = 'none'; });

    // Al navegar a otra sección del admin → cerrar el tutorial (evita audio fantasma)
    document.addEventListener('click', (e) => {
        const item = e.target.closest('.sidebar-item');
        if (item && item.dataset.section && item.dataset.section !== 'crear-servicio') {
            cerrarTutorial();
        }
    });

    // Recalcular el espacio si cambia el tamaño de pantalla con el video fijo (rotación)
    window.addEventListener('resize', () => {
        if (fijo && section) {
            section.style.paddingTop = (wrap.offsetHeight + 16) + 'px';
        }
    });
}
