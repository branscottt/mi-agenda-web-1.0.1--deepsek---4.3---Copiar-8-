// directory/ui/DirectoryView.js
// Sección "PYMEs" del login: directorio público con categorías,
// tarjetas de pymes (nombre, dirección, fotos, estrellas) y modal
// de reseñas con formulario opcional (estrellas/comentarios).
//
// La página cliente de cada pyme se abre en cliente.html?tenant_id=X
// (misma URL que genera el botón "Compartir" del admin).

import { getDirectorio, crearResena } from '../application/DirectoryService.js';
import { CATEGORIAS_DIRECTORIO, getCategoria } from '../domain/categorias.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';

let _pymes = [];
let _filtroCategoria = 'todas';
let _terminoBusqueda = '';
let _modalActivo = null; // pyme actual en el modal

export async function initDirectorio() {
    const container = document.getElementById('directorio-container');
    if (!container) return;

    let data = [];
    try {
        data = await getDirectorio();
    } catch (e) {
        console.warn('[Directorio] No se pudo cargar:', e.message);
    }
    _pymes = Array.isArray(data) ? data : [];

    renderSeccion(container);
    bindEventos(container);
}

// ============================================================
// RENDER
// ============================================================
function renderSeccion(container) {
    const visibles = filtrarPymes();

    container.innerHTML = `
        <div class="directorio-section" id="directorio">
            <div class="directorio-header">
                <span class="directorio-eyebrow"><i class="fas fa-store"></i> Directorio Público</span>
                <h2 class="directorio-title">PYMEs que ya confían en Organify</h2>
                <p class="directorio-subtitle">Descubre negocios locales, mira sus reseñas y agenda tu hora con un clic.</p>
            </div>

            <div class="directorio-controls">
                <div class="directorio-chips" id="directorio-chips">
                    <button class="directorio-chip active" data-cat="todas">Todas</button>
                    ${CATEGORIAS_DIRECTORIO.map(c => `
                        <button class="directorio-chip" data-cat="${escapeAttr(c.id)}" title="${escapeAttr(c.descripcion)}">
                            <i class="fas ${c.icono}"></i> ${escapeHtml(c.nombre)}
                        </button>
                    `).join('')}
                </div>
                <div class="directorio-search">
                    <i class="fas fa-search"></i>
                    <input type="text" id="directorio-buscar" placeholder="Buscar pyme o tipo de servicio..." autocomplete="off">
                </div>
            </div>

            <div class="directorio-grid" id="directorio-grid">
                ${renderGrid(visibles)}
            </div>
        </div>
    `;
}

function filtrarPymes() {
    const term = _terminoBusqueda.trim().toLowerCase();
    return _pymes.filter(p => {
        const okCat = _filtroCategoria === 'todas' || p.categoria === _filtroCategoria;
        if (!okCat) return false;
        if (!term) return true;
        const hay = [p.nombre_negocio, p.tipo_pyme, p.categoria, p.direccion]
            .filter(Boolean)
            .some(v => String(v).toLowerCase().includes(term));
        return hay;
    });
}

function renderGrid(visibles) {
    if (!_pymes.length) {
        return `
            <div class="directorio-empty">
                <i class="fas fa-store-alt"></i>
                <p><strong>Aún no hay pymes en el directorio.</strong></p>
                <p class="muted">¿Tienes un negocio? Crea tu cuenta y aparece aquí para que nuevos clientes te descubran.</p>
                <a href="#register" class="btn-grad btn-small" onclick="document.getElementById('register-mode')?.click(); return false;">
                    <i class="fas fa-rocket"></i> Crear mi pyme gratis
                </a>
            </div>
        `;
    }
    if (!visibles.length) {
        return `
            <div class="directorio-empty">
                <i class="fas fa-filter"></i>
                <p><strong>No encontramos pymes con ese filtro.</strong></p>
                <p class="muted">Prueba con otra categoría o término de búsqueda.</p>
            </div>
        `;
    }
    return visibles.map(renderCard).join('');
}

function renderCard(p) {
    const cat = getCategoria(p.categoria);
    const fotos = Array.isArray(p.fotos) ? p.fotos.filter(Boolean) : [];
    const portada = fotos[0] || p.logo_url || '';
    const tieneResenas = p.total_resenas > 0;

    return `
        <article class="pyme-card" data-tenant="${escapeAttr(p.tenant_id)}">
            <div class="pyme-card-cover">
                ${portada
                    ? `<img src="${escapeAttr(portada)}" alt="${escapeAttr(p.nombre_negocio)}" loading="lazy" onerror="this.style.display='none'">`
                    : `<div class="pyme-card-placeholder"><i class="fas ${cat ? cat.icono : 'fa-store'}"></i></div>`}
                ${p.tipo_pyme ? `<span class="pyme-card-badge">${escapeHtml(p.tipo_pyme)}</span>` : ''}
            </div>
            <div class="pyme-card-body">
                <h3 class="pyme-card-nombre">${escapeHtml(p.nombre_negocio)}</h3>
                <div class="pyme-card-cat">
                    <i class="fas ${cat ? cat.icono : 'fa-tag'}"></i>
                    ${cat ? escapeHtml(cat.nombre) : 'Pyme'}
                </div>
                ${p.direccion ? `
                    <div class="pyme-card-direccion" title="${escapeAttr(p.direccion)}">
                        <i class="fas fa-map-marker-alt"></i> ${escapeHtml(p.direccion)}
                    </div>
                ` : ''}
                <div class="pyme-card-resenas">
                    ${p.estrellas_activas
                        ? renderEstrellas(p.promedio, tieneResenas)
                        : '<span class="muted small">Sin puntuación</span>'}
                    ${tieneResenas ? `<span class="pyme-card-count">${p.total_resenas} reseña${p.total_resenas === 1 ? '' : 's'}</span>` : ''}
                </div>
                <div class="pyme-card-actions">
                    <a class="btn-grad btn-small pyme-btn-reservar" href="cliente.html?tenant_id=${encodeURIComponent(p.tenant_id)}" target="_blank" rel="noopener">
                        <i class="fas fa-calendar-check"></i> Reservar
                    </a>
                    <button type="button" class="btn-secondary btn-small pyme-btn-resenas" data-tenant="${escapeAttr(p.tenant_id)}">
                        <i class="fas fa-comments"></i> Reseñas
                    </button>
                </div>
            </div>
        </article>
    `;
}

function renderEstrellas(promedio, tieneResenas) {
    const prom = Math.round((Number(promedio) || 0) * 2) / 2; // 0.5 steps
    let html = '<span class="pyme-card-stars">';
    for (let i = 1; i <= 5; i++) {
        if (prom >= i) html += '<i class="fas fa-star"></i>';
        else if (prom >= i - 0.5) html += '<i class="fas fa-star-half-alt"></i>';
        else html += '<i class="far fa-star"></i>';
    }
    html += '</span>';
    if (tieneResenas) html += `<span class="pyme-card-puntaje">${(Number(promedio) || 0).toFixed(1)}</span>`;
    return html;
}

// ============================================================
// EVENTOS
// ============================================================
function bindEventos(container) {
    container.querySelector('#directorio-chips')?.addEventListener('click', (e) => {
        const chip = e.target.closest('.directorio-chip');
        if (!chip) return;
        container.querySelectorAll('.directorio-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        _filtroCategoria = chip.dataset.cat;
        rerenderGrid(container);
    });

    const buscar = container.querySelector('#directorio-buscar');
    if (buscar) {
        buscar.addEventListener('input', () => {
            _terminoBusqueda = buscar.value;
            rerenderGrid(container);
        });
    }

    container.querySelector('#directorio-grid')?.addEventListener('click', async (e) => {
        const btn = e.target.closest('.pyme-btn-resenas');
        if (!btn) return;
        const tenantId = btn.dataset.tenant;
        const pyme = _pymes.find(p => p.tenant_id === tenantId);
        if (pyme) await abrirModal(pyme, container);
    });
}

function rerenderGrid(container) {
    const grid = container.querySelector('#directorio-grid');
    if (grid) grid.innerHTML = renderGrid(filtrarPymes());
}

// ============================================================
// MODAL DE RESEÑAS
// ============================================================
async function abrirModal(pyme, container) {
    _modalActivo = pyme;
    const fotos = Array.isArray(pyme.fotos) ? pyme.fotos.filter(Boolean) : [];
    const cat = getCategoria(pyme.categoria);
    const resenas = Array.isArray(pyme.resenas) ? pyme.resenas : [];

    let modal = document.getElementById('directorio-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'directorio-modal';
        modal.className = 'directorio-modal-overlay';
        modal.innerHTML = `
            <div class="directorio-modal" role="dialog" aria-modal="true" aria-labelledby="directorio-modal-nombre">
                <button type="button" class="directorio-modal-close" aria-label="Cerrar">&times;</button>
                <div class="directorio-modal-content"></div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal || e.target.closest('.directorio-modal-close')) cerrarModal();
        });
    }

    const content = modal.querySelector('.directorio-modal-content');
    content.innerHTML = `
        <div class="directorio-modal-head">
            <h3 id="directorio-modal-nombre">${escapeHtml(pyme.nombre_negocio)}</h3>
            <div class="pyme-card-cat">
                <i class="fas ${cat ? cat.icono : 'fa-tag'}"></i>
                ${cat ? escapeHtml(cat.nombre) : 'Pyme'}${pyme.tipo_pyme ? ` · ${escapeHtml(pyme.tipo_pyme)}` : ''}
            </div>
            ${pyme.direccion ? `
                <div class="pyme-card-direccion"><i class="fas fa-map-marker-alt"></i> ${escapeHtml(pyme.direccion)}</div>
            ` : ''}
            ${pyme.estrellas_activas ? `
                <div class="directorio-modal-rating">
                    ${renderEstrellas(pyme.promedio, pyme.total_resenas > 0)}
                    ${pyme.total_resenas > 0 ? `<span class="pyme-card-puntaje">${(Number(pyme.promedio) || 0).toFixed(1)}</span><span class="muted small"> · ${pyme.total_resenas} reseña${pyme.total_resenas === 1 ? '' : 's'}</span>` : '<span class="muted small">Aún sin puntuaciones</span>'}
                </div>
            ` : ''}
        </div>

        ${fotos.length ? `
            <div class="directorio-modal-fotos">
                ${fotos.map(f => `<img src="${escapeAttr(f)}" alt="Foto de ${escapeAttr(pyme.nombre_negocio)}" loading="lazy" onerror="this.style.display='none'">`).join('')}
            </div>
        ` : ''}

        <div class="directorio-modal-resenas" id="directorio-modal-resenas">
            <h4><i class="fas fa-comments"></i> Reseñas</h4>
            ${resenas.length ? resenas.map(renderResenaItem).join('') : '<p class="muted small">Aún no hay reseñas públicas. ¡Sé el primero en opinar!</p>'}
        </div>

        ${(pyme.estrellas_activas || pyme.comentarios_activos) ? `
            <div class="directorio-modal-form">
                <h4><i class="fas fa-pen"></i> Deja tu reseña</h4>
                <div class="directorio-form-row">
                    <input type="text" id="directorio-form-nombre" placeholder="Tu nombre*" maxlength="60" autocomplete="off">
                </div>
                ${pyme.estrellas_activas ? `
                    <div class="directorio-form-row">
                        <span class="directorio-form-label">Tu puntuación:</span>
                        <div class="directorio-star-picker" id="directorio-star-picker">
                            ${[1,2,3,4,5].map(i => `<button type="button" data-val="${i}" aria-label="${i} estrellas"><i class="far fa-star"></i></button>`).join('')}
                        </div>
                    </div>
                ` : ''}
                ${pyme.comentarios_activos ? `
                    <div class="directorio-form-row">
                        <textarea id="directorio-form-comentario" placeholder="Cuéntanos tu experiencia (opcional)" maxlength="500" rows="3"></textarea>
                        <span class="muted small" id="directorio-form-contador">0/500</span>
                    </div>
                ` : ''}
                <button type="button" class="btn-grad btn-small" id="directorio-form-enviar">
                    <i class="fas fa-paper-plane"></i> Enviar reseña
                </button>
                <p class="muted small" style="margin-top:8px;"><i class="fas fa-shield-alt"></i> Tu reseña se publicará después de la moderación del negocio.</p>
            </div>
        ` : '<p class="muted small" style="margin-top:14px;"><i class="fas fa-info-circle"></i> Esta pyme no recibe reseñas por ahora.</p>'}
    `;

    modal.style.display = 'flex';

    // Star picker
    const picker = content.querySelector('#directorio-star-picker');
    let valorPuntuacion = 0;
    if (picker) {
        const pintar = (n) => {
            picker.querySelectorAll('button').forEach(b => {
                const on = Number(b.dataset.val) <= n;
                b.innerHTML = on ? '<i class="fas fa-star"></i>' : '<i class="far fa-star"></i>';
                b.classList.toggle('selected', on);
            });
        };
        picker.addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            valorPuntuacion = Number(btn.dataset.val);
            pintar(valorPuntuacion);
        });
        picker.addEventListener('mouseover', (e) => {
            const btn = e.target.closest('button');
            if (btn) pintar(Number(btn.dataset.val));
        });
        picker.addEventListener('mouseleave', () => pintar(valorPuntuacion));
    }

    // Contador de comentario
    const ta = content.querySelector('#directorio-form-comentario');
    const contador = content.querySelector('#directorio-form-contador');
    if (ta && contador) {
        ta.addEventListener('input', () => { contador.textContent = `${ta.value.length}/500`; });
    }

    // Enviar reseña
    content.querySelector('#directorio-form-enviar')?.addEventListener('click', async () => {
        const nombre = content.querySelector('#directorio-form-nombre')?.value.trim() || '';
        const comentario = ta ? ta.value.trim() : '';
        const puntuacion = valorPuntuacion;
        if (nombre.length < 2) {
            mostrarToast('Escribe tu nombre para dejar la reseña', 'warning');
            return;
        }
        if (!puntuacion && !comentario) {
            mostrarToast('Agrega una puntuación o un comentario', 'warning');
            return;
        }
        const btn = content.querySelector('#directorio-form-enviar');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enviando...'; }
        try {
            await crearResena(pyme.tenant_id, nombre, puntuacion || null, comentario || null);
            mostrarToast('✅ ¡Gracias! Tu reseña se publicará tras la moderación del negocio.', 'success');
            cerrarModal();
        } catch (err) {
            mostrarToast('❌ ' + (err.message || 'No se pudo enviar la reseña'), 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Enviar reseña'; }
        }
    });
}

function renderResenaItem(r) {
    const fecha = r.creado_en ? new Date(r.creado_en).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    let estrellas = '';
    if (r.puntuacion) {
        estrellas = `<span class="pyme-card-stars small">${[1,2,3,4,5].map(i =>
            `<i class="${i <= r.puntuacion ? 'fas' : 'far'} fa-star"></i>`
        ).join('')}</span>`;
    }
    return `
        <div class="directorio-resena">
            <div class="directorio-resena-head">
                <span class="directorio-resena-nombre"><i class="fas fa-user-circle"></i> ${escapeHtml(r.nombre_cliente)}</span>
                ${estrellas}
                ${fecha ? `<span class="muted small">${fecha}</span>` : ''}
            </div>
            ${r.comentario ? `<p class="directorio-resena-texto">${escapeHtml(r.comentario)}</p>` : ''}
        </div>
    `;
}

function cerrarModal() {
    const modal = document.getElementById('directorio-modal');
    if (modal) modal.style.display = 'none';
    _modalActivo = null;
}

// ============================================================
// HELPERS
// ============================================================
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttr(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

window.initDirectorio = initDirectorio;
