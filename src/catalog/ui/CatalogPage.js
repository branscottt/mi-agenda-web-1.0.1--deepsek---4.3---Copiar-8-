// catalog/ui/CatalogPage.js
// Grid visual de servicios para la vista cliente
// Muestra catalogo con popup de detalle y seleccion de fecha/hora

import { getCatalogoServicios, getFechasDisponibles, getHorariosDisponibles, agregarAlCarrito } from '../application/CatalogService.js';
import { formatearDinero, formatFechaCorta, formatTimeDisplay } from '../../shared/infrastructure/formatters.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';

export async function renderCatalogo(containerId = 'catalogo-grid') {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = '<div class="loading-spinner"><i class="fas fa-spinner fa-spin"></i> Cargando servicios...</div>';

    const servicios = await getCatalogoServicios();
    if (!servicios.length) {
        container.innerHTML = '<div class="empty-state"><i class="fas fa-store-slash"></i><p>No hay servicios disponibles por el momento</p></div>';
        return;
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

function abrirPopupReserva(servicio) {
    const overlay = document.getElementById('popup-reserva-overlay') || crearPopupReserva();
    overlay.style.display = 'flex';
    overlay.dataset.servicioId = servicio.id;

    document.getElementById('popup-titulo').textContent = servicio.nombre;
    document.getElementById('popup-precio').textContent = formatearDinero(servicio.precio);
    document.getElementById('popup-descripcion').textContent = servicio.descripcion || 'Sin descripcion';

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

    // Limpiar horarios previos
    document.getElementById('popup-horarios').innerHTML = '';
    document.getElementById('popup-reservar-btn').dataset.servicioId = servicio.id;

    // Event listeners fechas
    fechasContainer.querySelectorAll('.btn-fecha').forEach(btn => {
        btn.addEventListener('click', () => {
            fechasContainer.querySelectorAll('.btn-fecha').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const fecha = btn.dataset.fecha;
            const horarios = getHorariosDisponibles(servicio, fecha);
            const horariosContainer = document.getElementById('popup-horarios');
            if (!horarios.length) {
                horariosContainer.innerHTML = '<p class="empty-state-small">Sin horarios disponibles</p>';
                return;
            }
            horariosContainer.innerHTML = '<div class="horarios-grid">' +
                horarios.map(h => `<button class="btn-horario" data-hora="${h.startTime}" data-cupos="${h.cupos}">
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
        const item = {
            id: servicio.id,
            nombre: servicio.nombre,
            precio: servicio.precio,
            fecha,
            hora
        };
        if (agregarAlCarrito(item)) {
            mostrarToast(`Agregado: ${servicio.nombre}`, 'success');
            cerrarPopupReserva();
        }
    };
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
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(str) {
    if (!str) return '';
    return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function truncar(str, max) {
    if (!str) return '';
    return str.length > max ? str.slice(0, max) + '...' : str;
}