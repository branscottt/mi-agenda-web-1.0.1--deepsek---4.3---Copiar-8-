// catalog/ui/CatalogPage.js
// Grid visual de servicios para la vista cliente
// Muestra catalogo con popup de detalle y seleccion de fecha/hora + trabajador

import { getCatalogoServicios, getFechasDisponibles, getHorariosDisponibles, agregarAlCarrito } from '../application/CatalogService.js';
import { formatearDinero, formatFechaCorta, formatTimeDisplay } from '../../shared/infrastructure/formatters.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { getTrabajadoresByServicio } from '../../api/serviciosTrabajadoresApi.js';
import { getSemanaISO, getHorarioParaSemana } from '../../workers/domain/horarioValidation.js';
import { getCurrentTenantId } from '../../shared/infrastructure/router.js';

let _workersPorServicio = [];
let _workerCitasCache = {};

export async function renderCatalogo(containerId = 'catalogo-grid') {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = '<div class="loading-spinner"><i class="fas fa-spinner fa-spin"></i> Cargando servicios...</div>';

    const servicios = await getCatalogoServicios();
    if (!servicios.length) {
        container.innerHTML = '<div class="empty-state"><i class="fas fa-store-slash"></i><p>No hay servicios disponibles por el momento</p></div>';
        return;
    }

    // Precargar trabajadores para todos los servicios
    _workersPorServicio = {};
    for (const s of servicios) {
        try {
            const workers = await getTrabajadoresByServicio(s.id);
            if (workers && workers.length) {
                _workersPorServicio[s.id] = workers.filter(w => w.activo !== false);
            }
        } catch (e) {
            // Silencioso
        }
    }

    let html = '<div class="catalogo-grid">';
    servicios.forEach(s => {
        const imgUrl = s.imagen || 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874';
        html += `
            <div class="catalogo-card" data-id="${s.id}">
                <div class="catalogo-img" style="background-image: url('${escapeAttr(imgUrl)}')">
                    ${s.destacado ? '<span class="badge-destacado">Destacado</span>' : ''}
                </div>
                <div class="catalogo-body">
                    <h3>${escapeHtml(s.nombre)}</h3>
                    <span class="catalogo-categoria">${escapeHtml(s.categoria)}</span>
                    <p class="catalogo-descripcion">${escapeHtml(truncar(s.descripcion, 80))}</p>
                    <div class="catalogo-footer">
                        <span class="catalogo-precio">${formatearDinero(s.precio)}</span>
                        <button class="btn-catalogo-reservar" data-id="${s.id}">
                            <i class="fas fa-calendar-plus"></i> Reservar
                        </button>
                    </div>
                </div>
            </div>
        `;
    });
    html += '</div>';
    container.innerHTML = html;

    // Event listeners
    container.querySelectorAll('.btn-catalogo-reservar').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.id;
            const servicio = servicios.find(s => s.id === id);
            if (servicio) abrirPopupReserva(servicio);
        });
    });
}

async function abrirPopupReserva(servicio) {
    const overlay = document.getElementById('popup-reserva-overlay') || crearPopupReserva();
    overlay.style.display = 'flex';
    overlay.dataset.servicioId = servicio.id;

    document.getElementById('popup-titulo').textContent = servicio.nombre;
    document.getElementById('popup-precio').textContent = formatearDinero(servicio.precio);
    document.getElementById('popup-descripcion').textContent = servicio.descripcion || 'Sin descripcion';

    // Limpiar estado
    document.getElementById('popup-reservar-btn').dataset.fecha = '';
    document.getElementById('popup-reservar-btn').dataset.hora = '';
    document.getElementById('popup-reservar-btn').dataset.trabajadorId = '';

    // Cargar trabajadores para este servicio
    const workers = _workersPorServicio[servicio.id] || [];
    const workerSection = document.getElementById('popup-trabajadores');
    if (workerSection) {
        if (workers.length) {
            workerSection.style.display = 'block';
            workerSection.innerHTML = `
                <h4><i class="fas fa-user"></i> Elige tu trabajador</h4>
                <div class="trabajadores-grid">
                    ${workers.map(w => `
                        <button class="btn-trabajador" data-id="${w.id}">
                            <span class="trabajador-avatar" style="background:${w.color || '#9d4edd'}">
                                ${w.nombre.charAt(0).toUpperCase()}
                            </span>
                            <span class="trabajador-nombre">${escapeHtml(w.nombre)}</span>
                            ${w.habilidades ? `<span class="trabajador-habilidades">${escapeHtml(w.habilidades)}</span>` : ''}
                        </button>
                    `).join('')}
                </div>
            `;
            workerSection.querySelectorAll('.btn-trabajador').forEach(btn => {
                btn.addEventListener('click', () => {
                    workerSection.querySelectorAll('.btn-trabajador').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    const wid = btn.dataset.id;
                    document.getElementById('popup-reservar-btn').dataset.trabajadorId = wid;
                    // Refrescar horarios con el worker seleccionado
                    const fechaActiva = document.querySelector('.btn-fecha.active');
                    if (fechaActiva) {
                        const fecha = fechaActiva.dataset.fecha;
                        cargarHorarios(servicio, fecha, wid);
                    }
                });
            });
        } else {
            workerSection.style.display = 'none';
            workerSection.innerHTML = '';
        }
    }

    // Fechas disponibles
    const fechas = getFechasDisponibles(servicio);
    const fechasContainer = document.getElementById('popup-fechas');
    if (!fechas.length) {
        fechasContainer.innerHTML = '<p class="empty-state-small">No hay fechas disponibles</p>';
        return;
    }
    fechasContainer.innerHTML = '<div class="fechas-grid">' +
        fechas.map(f => `<button class="btn-fecha" data-fecha="${f}">${formatFechaCorta(f)}</button>`).join('') +
        '</div>';

    document.getElementById('popup-horarios').innerHTML = '';

    // Event listeners fechas
    fechasContainer.querySelectorAll('.btn-fecha').forEach(btn => {
        btn.addEventListener('click', async () => {
            fechasContainer.querySelectorAll('.btn-fecha').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const fecha = btn.dataset.fecha;
            const wid = document.getElementById('popup-reservar-btn').dataset.trabajadorId;
            cargarHorarios(servicio, fecha, wid);
            // Actualizar disponibilidad de trabajadores para esta fecha
            if (workers.length) {
                await actualizarDisponibilidadTrabajadores(workers, fecha);
                // Si el trabajador seleccionado ya no está disponible, deseleccionar
                const widActual = document.getElementById('popup-reservar-btn').dataset.trabajadorId;
                if (widActual) {
                    const btnActual = document.querySelector(`.btn-trabajador[data-id="${widActual}"]`);
                    if (btnActual && btnActual.disabled) {
                        btnActual.classList.remove('active');
                        document.getElementById('popup-reservar-btn').dataset.trabajadorId = '';
                        document.getElementById('popup-horarios').innerHTML = '<p class="empty-state-small">Trabajador no disponible esta fecha, selecciona otro</p>';
                    }
                }
            }
        });
    });

    // Boton reservar
    document.getElementById('popup-reservar-btn').onclick = () => {
        const fecha = document.getElementById('popup-reservar-btn').dataset.fecha;
        const hora = document.getElementById('popup-reservar-btn').dataset.hora;
        if (!fecha || !hora) {
            mostrarToast('Selecciona fecha y horario', 'warning');
            return;
        }
        const trabajadorId = document.getElementById('popup-reservar-btn').dataset.trabajadorId || null;
        const item = {
            id: servicio.id,
            nombre: servicio.nombre,
            precio: servicio.precio,
            fecha,
            hora,
            trabajadorId
        };
        if (agregarAlCarrito(item)) {
            const workers = _workersPorServicio[servicio.id] || [];
            const worker = workers.find(w => w.id === trabajadorId);
            const msg = worker ? `${servicio.nombre} con ${worker.nombre}` : servicio.nombre;
            mostrarToast(`Agregado: ${msg}`, 'success');
            cerrarPopupReserva();
        }
    };
}

async function cargarHorarios(servicio, fecha, trabajadorId) {
    const horarios = getHorariosDisponibles(servicio, fecha);
    const horariosContainer = document.getElementById('popup-horarios');

    if (!horarios.length) {
        horariosContainer.innerHTML = '<p class="empty-state-small">Sin horarios disponibles</p>';
        return;
    }

    // Si hay trabajador seleccionado, filtrar horarios donde ya tenga reservas
    let horariosFiltrados = horarios;
    if (trabajadorId) {
        const ocupados = await getHorasOcupadasTrabajador(trabajadorId, fecha);
        horariosFiltrados = horarios.filter(h => {
            return !ocupados.some(o => o.hora === h.startTime);
        });
    }

    if (!horariosFiltrados.length) {
        horariosContainer.innerHTML = '<p class="empty-state-small">Sin horarios disponibles para este trabajador</p>';
        return;
    }

    horariosContainer.innerHTML = '<div class="horarios-grid">' +
        horariosFiltrados.map(h => `<button class="btn-horario" data-hora="${h.startTime}" data-cupos="${h.cupos}">
            ${formatTimeDisplay(h.startTime)} <small>${h.cupos} cupo${h.cupos !== 1 ? 's' : ''}</small>
        </button>`).join('') +
        '</div>';

    horariosContainer.querySelectorAll('.btn-horario').forEach(hb => {
        hb.addEventListener('click', () => {
            horariosContainer.querySelectorAll('.btn-horario').forEach(b => b.classList.remove('active'));
            hb.classList.add('active');
            document.getElementById('popup-reservar-btn').dataset.fecha = fecha;
            document.getElementById('popup-reservar-btn').dataset.hora = hb.dataset.hora;
        });
    });
}

async function getHorasOcupadasTrabajador(trabajadorId, fecha) {
    const cacheKey = `${trabajadorId}_${fecha}`;
    if (_workerCitasCache[cacheKey]) return _workerCitasCache[cacheKey];

    try {
        const supabase = window.supabaseClient;
        if (!supabase) return [];
        const { data, error } = await supabase
            .from('citas')
            .select('hora')
            .eq('trabajador_id', trabajadorId)
            .eq('fecha', fecha);
        if (error) throw error;
        const result = (data || []).map(c => ({ hora: c.hora }));
        _workerCitasCache[cacheKey] = result;
        return result;
    } catch (e) {
        console.error('Error getHorasOcupadasTrabajador:', e);
        return [];
    }
}

/**
 * Verifica si un trabajador tiene disponibilidad en una fecha específica.
 * Considera: horario semanal (plantilla o excepción) + citas ya agendadas.
 * @returns {{ disponible: boolean, slotsLibres: number, slotsTotal: number, mensaje: string }}
 */
async function getDisponibilidadTrabajador(worker, fecha) {
    try {
        // Resolver horario del trabajador para la semana de la fecha
        const weekKey = getSemanaISO(new Date(fecha + 'T12:00:00'));
        const hrInfo = getHorarioParaSemana(worker, weekKey);
        const hr = hrInfo.horario;

        // Obtener día de la semana (1=Lunes...7=Domingo)
        const d = new Date(fecha + 'T12:00:00');
        const dk = String(d.getDay() === 0 ? 7 : d.getDay());
        const dia = hr[dk];

        // Si no trabaja ese día
        if (!dia || !dia.activo) {
            return { disponible: false, slotsLibres: 0, slotsTotal: 0, mensaje: 'No laboral' };
        }

        // Calcular slots disponibles basados en horas efectivas
        const [h1, m1] = (dia.inicio || '00:00').split(':').map(Number);
        const [h2, m2] = (dia.fin || '00:00').split(':').map(Number);
        let minutos = (h2 * 60 + m2) - (h1 * 60 + m1);
        const ci = (dia.colacion_inicio || '00:00').split(':').map(Number);
        const cf = (dia.colacion_fin || '00:00').split(':').map(Number);
        if (ci[0] + ci[1] > 0 && cf[0] + cf[1] > ci[0] + ci[1]) {
            minutos -= (cf[0] * 60 + cf[1]) - (ci[0] * 60 + ci[1]);
        }
        const horasEfectivas = Math.max(0, minutos / 60);
        const slotsTotal = Math.max(1, Math.ceil(horasEfectivas * 2));

        // Obtener citas ya agendadas
        const ocupados = await getHorasOcupadasTrabajador(worker.id, fecha);
        const slotsLibres = Math.max(0, slotsTotal - ocupados.length);

        return {
            disponible: slotsLibres > 0,
            slotsLibres,
            slotsTotal,
            mensaje: slotsLibres <= 0 ? 'Completo' : `${slotsLibres} disponible${slotsLibres !== 1 ? 's' : ''}`
        };
    } catch (e) {
        console.warn('[Disponibilidad] Error:', e.message);
        return { disponible: true, slotsLibres: 1, slotsTotal: 1, mensaje: '' };
    }
}

/**
 * Actualiza los botones de trabajador con información de disponibilidad para una fecha.
 */
async function actualizarDisponibilidadTrabajadores(workers, fecha) {
    for (const w of workers) {
        const btn = document.querySelector(`.btn-trabajador[data-id="${w.id}"]`);
        if (!btn) continue;
        const disp = await getDisponibilidadTrabajador(w, fecha);
        if (!disp.disponible) {
            btn.classList.add('completo');
            btn.disabled = true;
            btn.title = `${w.nombre} — Sin disponibilidad (${disp.mensaje})`;
            const statusEl = btn.querySelector('.trabajador-status') || document.createElement('span');
            statusEl.className = 'trabajador-status completo-status';
            statusEl.textContent = '🔴 Completo';
            btn.appendChild(statusEl);
        } else {
            btn.classList.remove('completo');
            btn.disabled = false;
            btn.title = `${w.nombre} — ${disp.mensaje}`;
            const oldStatus = btn.querySelector('.trabajador-status');
            if (oldStatus) oldStatus.remove();
        }
    }
}

function crearPopupReserva() {
    const overlay = document.createElement('div');
    overlay.id = 'popup-reserva-overlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-content popup-reserva">
            <button class="modal-close" id="popup-cerrar">&times;</button>
            <h2 id="popup-titulo"></h2>
            <p class="popup-precio" id="popup-precio"></p>
            <p id="popup-descripcion" class="popup-descripcion"></p>
            <div class="popup-section" id="popup-trabajadores" style="display:none;">
                <!-- Renderizado dinámico de trabajadores -->
            </div>
            <div class="popup-section">
                <h4><i class="fas fa-calendar"></i> Selecciona fecha</h4>
                <div id="popup-fechas"></div>
            </div>
            <div class="popup-section">
                <h4><i class="fas fa-clock"></i> Selecciona horario</h4>
                <div id="popup-horarios"></div>
            </div>
            <button class="btn-primary btn-full" id="popup-reservar-btn">
                <i class="fas fa-cart-plus"></i> Agregar al carrito
            </button>
        </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('popup-cerrar').addEventListener('click', cerrarPopupReserva);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) cerrarPopupReserva();
    });

    return overlay;
}

function cerrarPopupReserva() {
    const overlay = document.getElementById('popup-reserva-overlay');
    if (overlay) overlay.style.display = 'none';
}

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(str) {
    if (!str) return '';
    return String(str).replace(/\"/g, '&quot;').replace(/'/g, '&#39;');
}

function truncar(str, max) {
    if (!str) return '';
    return str.length > max ? str.slice(0, max) + '...' : str;
}
