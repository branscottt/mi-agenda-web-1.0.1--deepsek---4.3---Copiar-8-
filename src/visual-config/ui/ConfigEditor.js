// visual-config/ui/ConfigEditor.js
// Editor de personalizacion visual para admin.html
// Permite cambiar colores, logo y previsualizar en vivo

import { getVisualConfig, saveVisualConfig, aplicarConfigVisual, TEMAS_PREDEFINIDOS } from '../application/VisualConfigService.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { getCurrentTenantId } from '../../shared/infrastructure/router.js';
import { initDireccionAutocomplete } from '../../shared/ui/direccionAutocomplete.js';
import { CATEGORIAS_DIRECTORIO, getTiposDeCategoria, TIPO_PYME_OTRO } from '../../directory/domain/categorias.js';
import { getResenasAdmin, moderarResena } from '../../directory/application/DirectoryService.js';

// Snapshot de la config cargada: conserva valores de campos ya no editables
// (tipografía, CSS personalizado) para que guardar NO los borre.
let _configSnapshot = null;

// Datos del tenant (nombre del negocio + fecha del último cambio de nombre)
let _tenantData = null;

// Fotos elegidas para la tarjeta del directorio (URLs públicas)
let _fotosDirectorio = [];

// Días mínimos entre cambios de nombre del negocio (anti-abuso: el nombre se
// muestra en la vista cliente y en el directorio; Google OAuth deja el prefijo
// del email como nombre, así que el admin puede corregirlo, pero no spam).
const DIAS_MIN_CAMBIO_NOMBRE = 14;

export async function initConfigEditor(containerId = 'visual-config-editor') {
    const container = document.getElementById(containerId);
    if (!container) return;

    const config = await getVisualConfig();
    _configSnapshot = config;

    // Cargar datos del tenant (nombre_negocio + configuracion jsonb para el límite)
    try {
        const tenantId = await getCurrentTenantId();
        if (tenantId && window.supabaseClient) {
            const { data: tenantRow } = await window.supabaseClient
                .from('tenants')
                .select('id, nombre_negocio, configuracion')
                .eq('id', tenantId)
                .maybeSingle();
            if (tenantRow) _tenantData = tenantRow;
        }
    } catch (e) {
        console.warn('[ConfigEditor] No se pudo cargar datos del tenant:', e.message);
    }

    const nombreActual = _tenantData?.nombre_negocio || '';
    const ultimoCambio = _tenantData?.configuracion?.admin_nombre_updated_at || null;
    const diasRestantes = ultimoCambio
        ? Math.ceil((DIAS_MIN_CAMBIO_NOMBRE * 24 * 60 * 60 * 1000 - (Date.now() - new Date(ultimoCambio).getTime())) / (24 * 60 * 60 * 1000))
        : 0;
    const nombreBloqueado = diasRestantes > 0;

    container.innerHTML = `
        <div class="config-editor">

            <!-- GUÍA RÁPIDA PASO A PASO -->
            <div class="step-guide">
                <i class="fas fa-info-circle"></i>
                <span><strong>Así funciona:</strong> Elige un <strong>tema rápido</strong> (paso 1) para cambiar todo al instante, o personaliza colores y logo uno por uno (pasos 2–5). Usa <strong>"Guardar Cambios"</strong> solo cuando estés conforme.</span>
            </div>

            <!-- Acciones rápidas: chat "Dale vida a tu web" + vitrina en móvil -->
            <div class="cfg-acciones-rapidas">
                <button type="button" id="cfg-chat-btn" class="cfg-chat-btn" title="Responde 5 preguntas y tu página queda lista. Nada se publica hasta que tocas Guardar Cambios">
                    <i class="fas fa-wand-magic-sparkles"></i> Dale vida a tu web <small>(2 min)</small>
                </button>
                <button type="button" id="cfg-vitrina-btn" class="cfg-vitrina-btn">
                    <i class="fas fa-mobile-alt"></i> Ver cómo queda
                </button>
            </div>

            <div class="config-layout">
            <div class="config-controls">

            <!-- PASO 0: DATOS DEL NEGOCIO (nombre editable con límite anti-abuso) -->
            <div class="config-section">
                <h4 class="config-section-title"><i class="fas fa-store"></i> 0. Datos del Negocio</h4>
                <p class="config-section-tagline">El nombre que ven tus clientes cuando reservan y en el directorio.</p>
                <p class="field-hint" style="margin-bottom:10px;">El nombre aparece en la vista de tus clientes y en el Directorio Público. Si te registraste con Google, aquí puedes corregir el nombre automático (prefijo de tu email).</p>
                <div class="input-with-label">
                    <label><i class="fas fa-tag"></i> Nombre del negocio</label>
                    <input type="text" id="cfg-nombre-negocio" class="config-input" value="${escapeAttr(nombreActual)}" maxlength="60" placeholder="Ej: Peluquería Estilo" ${nombreBloqueado ? 'disabled' : ''}>
                    ${nombreBloqueado
                        ? `<p class="field-hint" style="color:#ffc107;margin-top:6px;"><i class="fas fa-clock"></i> Podrás cambiar el nombre en ${diasRestantes} día(s).</p>`
                        : `<p class="field-hint" style="margin-top:6px;">Puedes cambiarlo una vez cada ${DIAS_MIN_CAMBIO_NOMBRE} días.</p>`}
                    <button id="cfg-guardar-nombre-btn" class="btn-save-primary" style="margin-top:10px;${nombreBloqueado ? 'opacity:0.5;pointer-events:none;' : ''}">
                        <i class="fas fa-save"></i> Guardar Nombre
                    </button>
                </div>
            </div>

            <!-- PASO 1: TEMAS RÁPIDOS -->
            <div class="config-section">
                <h4 class="config-section-title"><i class="fas fa-paint-roller"></i> 1. Temas Rápidos</h4>
                <p class="config-section-tagline">Prueba looks completos al instante, sin tocar nada más.</p>
                <p class="field-hint" style="margin-bottom:10px;">Selecciona un tema para previsualizarlo al instante. Todos los colores se ajustarán automáticamente.</p>
                <div class="temas-grid" id="temas-grid">
                    ${Object.entries(TEMAS_PREDEFINIDOS).map(([key, t]) => `
                        <button class="tema-btn" data-tema="${key}" title="${escapeAttr(t.nombre)}">
                            <span class="tema-preview" style="background:${t.primary_color}"></span>
                            <span class="tema-name">${escapeHtml(t.nombre)}</span>
                        </button>
                    `).join('')}
                </div>
            </div>

            <!-- PASO 2: COLORES -->
            <div class="config-section">
                <h4 class="config-section-title"><i class="fas fa-fill-drip"></i> 2. Colores</h4>
                <p class="config-section-tagline">Cada color se ve en vivo mientras lo eliges.</p>
                <p class="field-hint" style="margin-bottom:10px;">Ajusta los colores principales de tu negocio. Cada color se aplica en tiempo real.</p>
                <div class="config-grid">
                    <div class="color-swatch">
                        <label>Primario</label>
                        <input type="color" id="cfg-primary" value="${config.primary_color}">
                        <span class="swatch-hint">Botones, enlaces</span>
                    </div>
                    <div class="color-swatch">
                        <label>Secundario</label>
                        <input type="color" id="cfg-secondary" value="${config.secondary_color}">
                        <span class="swatch-hint">Gradientes, hover</span>
                    </div>
                    <div class="color-swatch">
                        <label>Fondo</label>
                        <input type="color" id="cfg-bg" value="${config.bg_color || config.background_color || '#0d0d0d'}">
                        <span class="swatch-hint">Fondo general</span>
                    </div>
                    <div class="color-swatch">
                        <label>Tarjetas</label>
                        <input type="color" id="cfg-card" value="${config.card_bg || config.card_color || '#1a1a2e'}">
                        <span class="swatch-hint">Paneles, tarjetas</span>
                    </div>
                    <div class="color-swatch">
                        <label>Texto</label>
                        <input type="color" id="cfg-text" value="${config.text_color}">
                        <span class="swatch-hint">Textos principales</span>
                    </div>
                    <div class="color-swatch">
                        <label>Bordes</label>
                        <input type="color" id="cfg-border" value="${config.border_color || '#2a2a4a'}">
                        <span class="swatch-hint">Separadores, contornos</span>
                    </div>
                </div>
            </div>

            <!-- PASO 3: LOGO -->
            <div class="config-section">
                <h4 class="config-section-title"><i class="fas fa-image"></i> 3. Logo</h4>
                <p class="config-section-tagline">Tu marca en tu página y en tu tarjeta del directorio.</p>
                <p class="field-hint" style="margin-bottom:10px;">Sube el logo de tu negocio. Aparecerá en la vista de tus clientes.</p>
                <div class="logo-input-row">
                    <input type="url" id="cfg-logo" class="config-input" value="${escapeAttr(config.logo_url || '')}" placeholder="https://ejemplo.com/logo.png" style="flex:1;">
                    <div class="file-upload-wrapper logo-file-upload">
                        <input type="file" id="cfg-logo-file" accept="image/*">
                        <label for="cfg-logo-file" class="file-upload-btn logo-upload-btn">
                            <i class="fas fa-upload"></i>
                        </label>
                    </div>
                </div>
                <div class="logo-upload-progress" id="logo-upload-progress" style="display:none;">
                    <div class="progress-bar"><div class="progress-fill" id="logo-upload-fill"></div></div>
                    <span class="progress-text" id="logo-upload-text">Subiendo...</span>
                </div>
                <div class="logo-preview" id="logo-preview" style="margin-top:8px;display:none;">
                    <img id="logo-preview-img" src="" alt="Vista previa logo" style="max-height:40px;border-radius:6px;">
                </div>
            </div>

            <!-- PASO 4: PORTADA / BANNER -->
            <div class="config-section">
                <h4 class="config-section-title"><i class="fas fa-panorama"></i> 4. Portada / Banner</h4>
                <p class="config-section-tagline">La primera imagen que ven al entrar a tu página.</p>
                <p class="field-hint" style="margin-bottom:10px;">Imagen de portada que se muestra en la parte superior de tu perfil.</p>
                <div class="logo-input-row">
                    <input type="url" id="cfg-cover" class="config-input" value="${escapeAttr(config.cover_url || '')}" placeholder="https://ejemplo.com/portada.jpg" style="flex:1;">
                    <div class="file-upload-wrapper logo-file-upload">
                        <input type="file" id="cfg-cover-file" accept="image/*">
                        <label for="cfg-cover-file" class="file-upload-btn logo-upload-btn">
                            <i class="fas fa-upload"></i>
                        </label>
                    </div>
                </div>
                <div class="logo-upload-progress" id="cover-upload-progress" style="display:none;">
                    <div class="progress-bar"><div class="progress-fill" id="cover-upload-fill"></div></div>
                    <span class="progress-text" id="cover-upload-text">Subiendo...</span>
                </div>
                <div class="cover-preview" id="cover-preview" style="margin-top:8px;display:none;width:100%;aspect-ratio:3/1;border-radius:12px;overflow:hidden;background:rgba(0,0,0,0.05);">
                    <img id="cover-preview-img" src="" alt="Vista previa portada" style="width:100%;height:100%;object-fit:cover;display:block;">
                </div>
            </div>

            <!-- PASO 5: REDES SOCIALES -->
            <div class="config-section">
                <h4 class="config-section-title"><i class="fas fa-share-alt"></i> 5. Redes Sociales</h4>
                <p class="config-section-tagline">Que te sigan con un toque desde tu página.</p>
                <p class="field-hint" style="margin-bottom:10px;">Agrega los enlaces a tus redes sociales para que tus clientes puedan ver tus trabajos desde la sección "Mis Reservas".</p>
                <div class="form-row two-cols">
                    <div class="input-with-label">
                        <label><i class="fab fa-instagram"></i> Instagram</label>
                        <input type="url" id="cfg-instagram" class="config-input" value="${escapeAttr(config.instagram_url || '')}" placeholder="https://instagram.com/tu-perfil" style="flex:1;">
                        <span class="field-hint" style="font-size:0.75rem;">Enlace completo a tu perfil de Instagram</span>
                    </div>
                    <div class="input-with-label">
                        <label><i class="fab fa-tiktok"></i> TikTok</label>
                        <input type="url" id="cfg-tiktok" class="config-input" value="${escapeAttr(config.tiktok_url || '')}" placeholder="https://tiktok.com/@tu-perfil" style="flex:1;">
                        <span class="field-hint" style="font-size:0.75rem;">Enlace completo a tu perfil de TikTok</span>
                    </div>
                </div>
            </div>

            <!-- PASO 6: UBICACIÓN DE LA PYME -->
            <div class="config-section">
                <h4 class="config-section-title"><i class="fas fa-map-marker-alt"></i> 6. Ubicación de tu negocio</h4>
                <p class="config-section-tagline">Que lleguen sin preguntar: dirección y mapa en tu página.</p>
                <p class="field-hint" style="margin-bottom:10px;">Elige cómo funciona tu pyme: si tus clientes vienen a tu local, muestra tu ubicación con un mapa; si tú llevas el servicio al domicilio del cliente, pídele su dirección al reservar.</p>
                <div class="ubicacion-opciones">
                    <label class="ubicacion-option">
                        <input type="radio" name="cfg-ubicacion-tipo" value="local" ${config.ubicacion_tipo === 'local' ? 'checked' : ''}>
                        <span class="ubicacion-option-content">
                            <strong><i class="fas fa-store"></i> Muestro mi ubicación</strong>
                            <small>Los clientes vienen a mi local. En la vista cliente se mostrará la dirección con un mapa y un enlace a Google Maps.</small>
                        </span>
                    </label>
                    <label class="ubicacion-option">
                        <input type="radio" name="cfg-ubicacion-tipo" value="domicilio" ${config.ubicacion_tipo === 'domicilio' ? 'checked' : ''}>
                        <span class="ubicacion-option-content">
                            <strong><i class="fas fa-truck"></i> Voy al domicilio del cliente</strong>
                            <small>El cliente debe escribir su dirección para completar la reserva y la verás en tus citas (ideal para plomeros, técnicos, delivery, etc.).</small>
                        </span>
                    </label>
                </div>
                <div class="input-with-label" id="cfg-ubicacion-direccion-wrap" style="margin-top:12px;${config.ubicacion_tipo === 'local' ? '' : 'display:none;'}">
                    <label><i class="fas fa-map-pin"></i> Dirección de mi local</label>
                    <input type="text" id="cfg-direccion" class="config-input" value="${escapeAttr(config.direccion || '')}" placeholder="Ej: Av. Siempre Viva 123, Santiago" style="flex:1;">
                    <span class="field-hint">Se mostrará en la vista de tus clientes con un mapa pequeño y un botón "Cómo llegar" que abre Google Maps. Escribe y elige de las sugerencias para una dirección más precisa (ciudad, región, país).</span>
                </div>
            </div>

            <!-- PASO 7: DIRECTORIO PÚBLICO Y RESEÑAS -->
            <div class="config-section">
                <h4 class="config-section-title"><i class="fas fa-store"></i> 7. Directorio Público y Reseñas <span id="cfg-directorio-badge" class="cfg-directorio-badge" style="display:none;"></span></h4>
                <p class="config-section-tagline">Que clientes nuevos te encuentren sin conocerte.</p>
                <p class="field-hint" style="margin-bottom:10px;">Aparece en la página de inicio junto a otras pymes para que nuevos clientes te descubran y reserven contigo. Disponible en planes <strong>Pro, Premium Anual y Freemium</strong>.</p>

                <label class="directorio-switch">
                    <input type="checkbox" id="cfg-directorio-activo" ${config.directorio_activo ? 'checked' : ''}>
                    <span class="directorio-switch-slider"></span>
                    <span class="directorio-switch-label">
                        <strong>Quiero aparecer en el Directorio Público de Organify</strong>
                        <small>para que nuevos clientes me descubran</small>
                    </span>
                </label>

                <div id="cfg-directorio-opciones" style="margin-top:14px;${config.directorio_activo ? '' : 'display:none;'}">
                    <div class="form-row two-cols">
                        <div class="input-with-label">
                            <label><i class="fas fa-th-large"></i> Categoría de mi negocio</label>
                            <select id="cfg-directorio-categoria" class="config-input">
                                <option value="">Selecciona una categoría...</option>
                                ${CATEGORIAS_DIRECTORIO.map(c => `
                                    <option value="${c.id}" ${config.directorio_categoria === c.id ? 'selected' : ''}>${c.nombre}</option>
                                `).join('')}
                            </select>
                        </div>
                        <div class="input-with-label">
                            <label><i class="fas fa-tag"></i> Tipo de pyme</label>
                            <select id="cfg-directorio-tipo" class="config-input">
                                ${renderOpcionesTipo(config.directorio_categoria, config.directorio_tipo_pyme)}
                            </select>
                        </div>
                    </div>

                    <div class="input-with-label" style="margin-top:12px;">
                        <label><i class="fas fa-images"></i> Fotos para tu tarjeta (elige hasta 3)</label>
                        <p class="field-hint" style="font-size:0.75rem;">Se mostrarán en tu tarjeta del directorio. Si no subes fotos, se usará tu logo.</p>
                        <div class="directorio-fotos-row">
                            <div class="directorio-fotos-preview" id="directorio-fotos-preview"></div>
                            <div class="file-upload-wrapper logo-file-upload">
                                <input type="file" id="cfg-directorio-fotos-file" accept="image/jpeg,image/png,image/webp" multiple>
                                <label for="cfg-directorio-fotos-file" class="file-upload-btn logo-upload-btn" title="Subir fotos">
                                    <i class="fas fa-upload"></i>
                                </label>
                            </div>
                        </div>
                        <span class="field-hint" id="directorio-fotos-hint" style="font-size:0.75rem;"></span>
                    </div>

                    <div class="form-row two-cols" style="margin-top:12px;">
                        <label class="directorio-switch">
                            <input type="checkbox" id="cfg-directorio-estrellas" ${config.directorio_estrellas ? 'checked' : ''}>
                            <span class="directorio-switch-slider"></span>
                            <span class="directorio-switch-label">
                                <strong><i class="fas fa-star"></i> Puntuación con estrellas</strong>
                                <small>Los clientes califican del 1 al 5</small>
                            </span>
                        </label>
                        <label class="directorio-switch">
                            <input type="checkbox" id="cfg-directorio-comentarios" ${config.directorio_comentarios ? 'checked' : ''}>
                            <span class="directorio-switch-slider"></span>
                            <span class="directorio-switch-label">
                                <strong><i class="fas fa-comment-dots"></i> Comentarios públicos</strong>
                                <small>Los clientes dejan su opinión (moderada)</small>
                            </span>
                        </label>
                    </div>

                    <!-- Moderación de reseñas -->
                    <div class="input-with-label" style="margin-top:14px;">
                        <label><i class="fas fa-shield-alt"></i> Moderación de reseñas</label>
                        <p class="field-hint" style="font-size:0.75rem;">Las reseñas llegan como "pendientes" y solo se publican cuando las apruebas.</p>
                        <div id="directorio-moderacion">
                            <p class="muted small"><i class="fas fa-spinner fa-spin"></i> Cargando reseñas...</p>
                        </div>
                    </div>
                </div>
            </div>

            <!-- FINALIZAR -->
            <div class="config-section finalizar">
                <h4 class="config-section-title"><i class="fas fa-check-circle"></i> Finalizar</h4>
                <p class="field-hint" style="margin-bottom:12px;">Cuando estés listo, presiona <strong>Guardar Cambios</strong> para aplicar todo. Si te arrepientes, <strong>Restablecer Valores</strong> vuelve a la configuración original.</p>
                <div class="config-actions">
                    <button id="cfg-reset-btn" class="btn-reset-styled">
                        <i class="fas fa-undo-alt"></i> Restablecer Valores
                    </button>
                    <button id="cfg-preview-btn" class="btn-save-primary">
                        <i class="fas fa-save"></i> Guardar Cambios
                    </button>
                </div>
            </div>
            </div><!-- /config-controls -->

            <!-- VITRINA EN VIVO: cómo ven tus clientes tu página -->
            <aside class="config-vitrina" aria-label="Vista previa: así ven tus clientes tu página">
                <div class="config-vitrina-inner">
                    <div class="config-vitrina-head">
                        <i class="fas fa-mobile-alt"></i>
                        <span>Así la ven tus clientes</span>
                    </div>
                    <div id="cfg-vitrina" class="cfg-vitrina"></div>
                    <p class="config-vitrina-foot"><i class="fas fa-info-circle"></i> Cambia algo arriba y míralo aquí. Nada se publica hasta que tocas <strong>Guardar Cambios</strong>.</p>
                </div>
            </aside>
            </div><!-- /config-layout -->
        </div>
    `;

    // Mostrar preview de logo y cover si ya hay URLs guardadas
    mostrarPreviewGuardado('logo-preview', 'logo-preview-img', config.logo_url);
    mostrarPreviewCover(config.cover_url);

    // --- DIRECTORIO: estado inicial ---
    _fotosDirectorio = Array.isArray(config.directorio_fotos) ? config.directorio_fotos.filter(Boolean) : [];
    renderFotosDirectorio();
    cargarModeracion();

    // Event listeners
    document.getElementById('temas-grid')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.tema-btn');
        if (!btn) return;
        const tema = TEMAS_PREDEFINIDOS[btn.dataset.tema];
        if (!tema) return;
        aplicarTema(tema);
    });

    // --- GUARDAR NOMBRE DEL NEGOCIO (con límite de 14 días) ---
    document.getElementById('cfg-guardar-nombre-btn')?.addEventListener('click', async () => {
        const input = document.getElementById('cfg-nombre-negocio');
        const btn = document.getElementById('cfg-guardar-nombre-btn');
        const nuevoNombre = (input?.value || '').trim();
        if (!nuevoNombre) {
            mostrarToast('Escribe el nombre del negocio', 'error');
            return;
        }
        if (nuevoNombre.length > 60) {
            mostrarToast('El nombre no puede superar los 60 caracteres', 'error');
            return;
        }

        // Re-verificar límite en cliente (defensa en profundidad; la BD también lo protege)
        const ultimoCambio = _tenantData?.configuracion?.admin_nombre_updated_at || null;
        if (ultimoCambio) {
            const dias = (Date.now() - new Date(ultimoCambio).getTime()) / (24 * 60 * 60 * 1000);
            if (dias < DIAS_MIN_CAMBIO_NOMBRE) {
                mostrarToast(`Puedes cambiar el nombre cada ${DIAS_MIN_CAMBIO_NOMBRE} días. Intenta más tarde.`, 'error');
                return;
            }
        }

        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...'; }
        try {
            const tenantId = await getCurrentTenantId();
            if (!tenantId) throw new Error('No tenant ID');

            // Guardar nombre + fecha del cambio en la columna configuracion (jsonb)
            const configActual = (_tenantData?.configuracion) || {};
            const { error } = await window.supabaseClient
                .from('tenants')
                .update({
                    nombre_negocio: nuevoNombre,
                    configuracion: { ...configActual, admin_nombre_updated_at: new Date().toISOString() }
                })
                .eq('id', tenantId);
            if (error) throw error;

            _tenantData = { ..._tenantData, nombre_negocio: nuevoNombre, configuracion: { ...configActual, admin_nombre_updated_at: new Date().toISOString() } };
            mostrarToast('✅ Nombre del negocio actualizado', 'success');

            // Refrescar UI: bloquear el campo por 14 días
            setTimeout(() => initConfigEditor(), 800);
        } catch (err) {
            console.error('[ConfigEditor] Error guardando nombre:', err);
            mostrarToast('⚠️ Error al guardar el nombre: ' + (err.message || 'Desconocido'), 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-save"></i> Guardar Nombre'; }
        }
    });

    document.getElementById('cfg-preview-btn')?.addEventListener('click', async () => {
        const configActual = leerConfigForm();
        const btn = document.getElementById('cfg-preview-btn');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...'; }
        try {
            await saveVisualConfig(configActual);
            aplicarConfigVisual(configActual);
            mostrarToast('✅ Cambios guardados y aplicados', 'success');
        } catch (err) {
            // Aunque falle la BD, aplicar visualmente igual
            aplicarConfigVisual(configActual);
            mostrarToast('⚠️ Cambios aplicados visualmente, pero hubo error al guardar: ' + err.message, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-save"></i> Guardar Cambios'; }
        }
    });

    document.getElementById('cfg-reset-btn')?.addEventListener('click', async () => {
        if (!confirm('Restaurar configuracion visual por defecto?')) return;
        const defaults = {
            primary_color: '#9d4edd',
            secondary_color: '#ff6d00',
            bg_color: '#0d0d0d',
            card_bg: '#1a1a2e',
            text_color: '#e0e0e0',
            border_color: '#2a2a4a',
            theme_mode: 'dark',
            font_family: "'Inter', sans-serif",
            logo_url: '',
            cover_url: '',
            instagram_url: '',
            tiktok_url: '',
            ubicacion_tipo: '',
            direccion: '',
            directorio_activo: false,
            directorio_categoria: '',
            directorio_tipo_pyme: '',
            directorio_fotos: [],
            directorio_estrellas: false,
            directorio_comentarios: false,
            border_radius: 12,
            animation_speed: 0.3,
            custom_css: ''
        };
        try {
            await saveVisualConfig(defaults);
            aplicarConfigVisual(defaults);
            initConfigEditor(containerId);
            mostrarToast('Configuracion restaurada', 'success');
        } catch (err) {
            mostrarToast('Error: ' + err.message, 'error');
        }
    });

    // Preview en vivo al cambiar color
    document.querySelectorAll('.config-grid input[type="color"]').forEach(input => {
        input.addEventListener('input', () => {
            const configActual = leerConfigForm();
            aplicarConfigVisual(configActual);
        });
    });

    // Preview en vivo para logo URL
    const logoInput = document.getElementById('cfg-logo');
    if (logoInput) {
        logoInput.addEventListener('input', () => {
            const url = logoInput.value;
            mostrarPreviewGuardado('logo-preview', 'logo-preview-img', url);
            aplicarConfigVisual(leerConfigForm());
        });
    }

    // Preview en vivo para cover URL
    const coverInput = document.getElementById('cfg-cover');
    if (coverInput) {
        coverInput.addEventListener('input', () => {
            mostrarPreviewCover(coverInput.value);
            aplicarConfigVisual(leerConfigForm());
        });
    }

    // Toggle del campo dirección según la opción de ubicación elegida
    const direccionWrap = document.getElementById('cfg-ubicacion-direccion-wrap');
    document.querySelectorAll('input[name="cfg-ubicacion-tipo"]').forEach(radio => {
        radio.addEventListener('change', () => {
            if (direccionWrap) {
                direccionWrap.style.display = (radio.value === 'local' && radio.checked) ? '' : 'none';
            }
        });
    });

    // Autocompletado de direcciones (Nominatim/OSM) — sugerencias precisas
    const direccionInput = document.getElementById('cfg-direccion');
    if (direccionInput) initDireccionAutocomplete(direccionInput);

    // File upload para logo
    const logoFileInput = document.getElementById('cfg-logo-file');
    if (logoFileInput) {
        logoFileInput.addEventListener('change', async function() {
            const file = this.files[0];
            if (!file) return;
            if (!file.type.startsWith('image/')) {
                mostrarToast('❌ Solo se permiten archivos de imagen.', 'error');
                return;
            }
            if (file.size > 5 * 1024 * 1024) {
                mostrarToast('❌ La imagen es muy grande. Máximo 5MB.', 'error');
                return;
            }
            await subirImagenStorage(file, 'logo', 'logo');
        });
    }

    // File upload para cover/portada
    const coverFileInput = document.getElementById('cfg-cover-file');
    if (coverFileInput) {
        coverFileInput.addEventListener('change', async function() {
            const file = this.files[0];
            if (!file) return;
            if (!file.type.startsWith('image/')) {
                mostrarToast('❌ Solo se permiten archivos de imagen.', 'error');
                return;
            }
            if (file.size > 10 * 1024 * 1024) {
                mostrarToast('❌ La imagen es muy grande. Máximo 10MB.', 'error');
                return;
            }
            await subirImagenStorage(file, 'cover', 'cover');
        });
    }

    // --- DIRECTORIO: listeners ---
    const directorioActivo = document.getElementById('cfg-directorio-activo');
    const directorioOpciones = document.getElementById('cfg-directorio-opciones');
    if (directorioActivo && directorioOpciones) {
        directorioActivo.addEventListener('change', () => {
            directorioOpciones.style.display = directorioActivo.checked ? '' : 'none';
            if (directorioActivo.checked) cargarModeracion();
        });
    }

    const catSelect = document.getElementById('cfg-directorio-categoria');
    const tipoSelect = document.getElementById('cfg-directorio-tipo');
    if (catSelect && tipoSelect) {
        catSelect.addEventListener('change', () => {
            const seleccionado = tipoSelect.value;
            tipoSelect.innerHTML = renderOpcionesTipo(catSelect.value, seleccionado);
        });
    }

    const fotosFileInput = document.getElementById('cfg-directorio-fotos-file');
    if (fotosFileInput) {
        fotosFileInput.addEventListener('change', async function() {
            const files = Array.from(this.files || []);
            this.value = '';
            const disponibles = Math.max(0, 3 - _fotosDirectorio.length);
            if (!files.length) return;
            if (_fotosDirectorio.length + files.length > 3) {
                mostrarToast(`❌ Máximo 3 fotos para tu tarjeta (te quedan ${disponibles} espacio${disponibles === 1 ? '' : 's'}).`, 'warning');
            }
            const aSubir = files.slice(0, disponibles);
            for (const file of aSubir) {
                await subirFotoDirectorio(file);
            }
            renderFotosDirectorio();
            actualizarVitrina();
        });
    }

    const fotosPreview = document.getElementById('directorio-fotos-preview');
    if (fotosPreview) {
        fotosPreview.addEventListener('click', (e) => {
            const btn = e.target.closest('.directorio-foto-remove');
            if (!btn) return;
            const idx = Number(btn.dataset.idx);
            if (!Number.isNaN(idx) && _fotosDirectorio[idx]) {
                _fotosDirectorio.splice(idx, 1);
                renderFotosDirectorio();
                actualizarVitrina();
            }
        });
    }

    // --- VITRINA EN VIVO: el formulario se refleja en la maqueta de celular ---
    actualizarVitrina();
    if (!container.dataset.vitrinaBound) {
        container.dataset.vitrinaBound = '1';
        const refrescoVitrina = debounceVitrina(actualizarVitrina, 250);
        container.addEventListener('input', refrescoVitrina);
        container.addEventListener('change', refrescoVitrina);
    }
    document.getElementById('cfg-vitrina-btn')?.addEventListener('click', abrirVitrinaOverlay);
    document.getElementById('cfg-chat-btn')?.addEventListener('click', abrirCfgChat);
}

// ============================================================
// VITRINA EN VIVO (maqueta de celular con la página pública)
// ============================================================

function debounceVitrina(fn, ms) {
    let t = null;
    return (...args) => {
        if (t) clearTimeout(t);
        t = setTimeout(() => { t = null; fn(...args); }, ms);
    };
}

function nombreNegocioActual() {
    const input = document.getElementById('cfg-nombre-negocio');
    const valor = input && input.value ? input.value.trim() : '';
    if (valor) return valor;
    return _tenantData && _tenantData.nombre_negocio ? String(_tenantData.nombre_negocio) : 'Tu negocio';
}

function categoriaNombreDirectorio(categoriaId) {
    if (!categoriaId) return '';
    const cat = CATEGORIAS_DIRECTORIO.find(c => c.id === categoriaId);
    return cat ? cat.nombre : '';
}

/** Lista de lo que falta para que la tarjeta del directorio luzca completa. */
function faltantesTarjetaDirectorio(cfg) {
    const faltantes = [];
    if (!(cfg.logo_url || '').trim()) faltantes.push('el logo');
    if (!cfg.directorio_categoria) faltantes.push('el rubro');
    if (cfg.ubicacion_tipo === 'local' && !(cfg.direccion || '').trim()) faltantes.push('la dirección');
    if (!(cfg.directorio_fotos || []).filter(Boolean).length && !(cfg.logo_url || '').trim()) faltantes.push('una foto');
    return faltantes;
}

function renderVitrinaHtml(cfg) {
    const nombre = nombreNegocioActual();
    const tieneLocal = cfg.ubicacion_tipo === 'local';
    const direccion = (cfg.direccion || '').trim();
    const logoUrl = (cfg.logo_url || '').trim();
    const coverUrl = (cfg.cover_url || '').trim();
    const sinLogo = !logoUrl;
    const tieneRedes = Boolean((cfg.instagram_url || '').trim() || (cfg.tiktok_url || '').trim());
    const categoria = categoriaNombreDirectorio(cfg.directorio_categoria);
    const tipoPyme = (cfg.directorio_tipo_pyme || '').trim();
    const fotosDir = (Array.isArray(cfg.directorio_fotos) ? cfg.directorio_fotos : []).filter(Boolean);
    const portadaDir = fotosDir[0] || logoUrl || '';
    const dirActivo = cfg.directorio_activo === true;
    const faltantes = faltantesTarjetaDirectorio(cfg);

    let redesHtml = '';
    if ((cfg.instagram_url || '').trim()) {
        redesHtml += `<a class="pv-red" href="${escapeAttr(cfg.instagram_url.trim())}" target="_blank" rel="noopener noreferrer" title="Instagram"><i class="fab fa-instagram"></i></a>`;
    }
    if ((cfg.tiktok_url || '').trim()) {
        redesHtml += `<a class="pv-red" href="${escapeAttr(cfg.tiktok_url.trim())}" target="_blank" rel="noopener noreferrer" title="TikTok"><i class="fab fa-tiktok"></i></a>`;
    }

    let ubicacionHtml = '';
    if (tieneLocal) {
        ubicacionHtml = direccion
            ? `<div class="pv-card">
                    <div class="pv-card-titulo"><i class="fas fa-map-marker-alt"></i> Cómo llegar</div>
                    <div class="pv-mapa-slot"></div>
                    <a class="pv-btn" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(direccion)}" target="_blank" rel="noopener noreferrer"><i class="fas fa-directions"></i> Cómo llegar</a>
                </div>`
            : `<button type="button" class="pv-ghost pv-ghost-block" data-ghost="direccion" title="Escribe tu dirección en el paso 6">
                    <i class="fas fa-map-marked-alt"></i> Aquí iría el mapa con tu dirección
                    <small>Toca para escribirla</small>
                </button>`;
    } else if (cfg.ubicacion_tipo === 'domicilio') {
        ubicacionHtml = `<div class="pv-card pv-card-muted"><i class="fas fa-truck"></i> Atiendes a domicilio: tus clientes te escriben su dirección al reservar.</div>`;
    } else {
        ubicacionHtml = `<button type="button" class="pv-ghost pv-ghost-block" data-ghost="ubicacion" title="Elige cómo atiendes en el paso 6">
                <i class="fas fa-store"></i> ¿Dónde te encuentra la gente?
                <small>Local o a domicilio: se ve en tu página</small>
            </button>`;
    }

    let directorioHtml;
    if (!dirActivo) {
        directorioHtml = `<button type="button" class="pv-ghost pv-dir-lock" data-ghost="directorio" title="Actívalo en el paso 7">
                <i class="fas fa-lock"></i> Aparece en el directorio
                <small>Completa logo, rubro y ubicación y actívalo en el paso 7</small>
            </button>`;
    } else {
        const aviso = faltantes.length
            ? `<div class="pv-dir-nota"><i class="fas fa-info-circle"></i> Ya estás en el directorio. Para que tu tarjeta luzca completa falta: ${escapeHtml(faltantes.join(', '))}.</div>`
            : `<div class="pv-dir-ok"><i class="fas fa-check-circle"></i> ¡Apareces en el directorio!</div>`;
        directorioHtml = `${aviso}
            <div class="pv-dir-card">
                ${portadaDir ? `<div class="pv-dir-card-img"><img class="pv-img" src="${escapeAttr(portadaDir)}" alt=""></div>` : ''}
                <div class="pv-dir-card-body">
                    <strong>${escapeHtml(nombre)}</strong>
                    <span>${escapeHtml(tipoPyme || categoria || 'Pyme')}</span>
                    ${tieneLocal && direccion ? `<small><i class="fas fa-map-marker-alt"></i> ${escapeHtml(direccion)}</small>` : ''}
                    <span class="pv-btn pv-btn-mini">Reservar hora</span>
                </div>
            </div>`;
    }

    return `
        <div class="pv-phone" style="--pv-primary:${escapeAttr(cfg.primary_color)};--pv-secondary:${escapeAttr(cfg.secondary_color)};--pv-bg:${escapeAttr(cfg.bg_color)};--pv-card:${escapeAttr(cfg.card_bg)};--pv-text:${escapeAttr(cfg.text_color)};--pv-border:${escapeAttr(cfg.border_color)}">
            <div class="pv-notch"></div>
            <div class="pv-screen">
                <div class="pv-cover">
                    ${coverUrl ? `<img class="pv-img" src="${escapeAttr(coverUrl)}" alt="Portada">` : '<div class="pv-cover-ph"><i class="fas fa-store"></i></div>'}
                </div>
                <div class="pv-content">
                    <div class="pv-brand">
                        ${sinLogo
                            ? `<button type="button" class="pv-ghost pv-ghost-logo" data-ghost="logo" title="Sube tu logo en el paso 3"><i class="fas fa-image"></i> Tu logo</button>`
                            : `<img class="pv-img pv-logo" src="${escapeAttr(logoUrl)}" alt="Logo de ${escapeAttr(nombre)}">`}
                        <div class="pv-brand-txt">
                            <strong>${escapeHtml(nombre)}</strong>
                            ${categoria
                                ? `<span>${escapeHtml(categoria)}</span>`
                                : `<button type="button" class="pv-ghost pv-ghost-cat" data-ghost="categoria" title="Elige tu rubro en el paso 7"><i class="fas fa-tag"></i> Tu rubro</button>`}
                        </div>
                    </div>
                    <div class="pv-redes">
                        ${redesHtml}
                        ${tieneRedes ? '' : `<button type="button" class="pv-ghost pv-ghost-redes" data-ghost="redes" title="Agrega tus redes en el paso 5"><i class="fab fa-instagram"></i> Tus redes</button>`}
                    </div>
                    <div class="pv-card">
                        <div class="pv-card-titulo"><i class="fas fa-calendar-check"></i> Reserva con nosotros</div>
                        <div class="pv-linea"></div>
                        <div class="pv-linea corta"></div>
                        <div class="pv-btn pv-btn-primario"><i class="fas fa-calendar-plus"></i> Reservar hora</div>
                    </div>
                    ${ubicacionHtml}
                    <div class="pv-card pv-dir">${directorioHtml}</div>
                    <p class="pv-marca">Organify</p>
                </div>
            </div>
        </div>`;
}

let _mapaIframeNode = null;
let _mapaIframeDir = '';
let _vitrinaDirPrevio = null;

/** Oculta imágenes rotas (sin handlers inline: CSP de hashes). */
function poblarImagenes(cont) {
    cont.querySelectorAll('img.pv-img').forEach(img => {
        img.addEventListener('error', () => { img.style.display = 'none'; }, { once: true });
    });
}

/** Reutiliza UN iframe de mapa: re-renderizar no lo recarga si la dirección no cambió. */
function poblarMapa(cont, direccion) {
    const slot = cont.querySelector('.pv-mapa-slot');
    if (!slot) return;
    const dir = (direccion || '').trim();
    if (dir.length < 6) return;
    if (_mapaIframeNode && _mapaIframeDir === dir) {
        slot.appendChild(_mapaIframeNode);
        return;
    }
    const iframe = document.createElement('iframe');
    iframe.className = 'pv-mapa-frame';
    iframe.loading = 'lazy';
    iframe.title = 'Mapa de la dirección del negocio';
    iframe.src = `https://www.google.com/maps?q=${encodeURIComponent(dir)}&output=embed`;
    _mapaIframeNode = iframe;
    _mapaIframeDir = dir;
    slot.appendChild(iframe);
}

/** Click en un "fantasma" → lleva al control real y lo resalta. */
function ghostTargetEl(tipo) {
    const porId = {
        logo: 'cfg-logo',
        cover: 'cfg-cover',
        redes: 'cfg-instagram',
        categoria: 'cfg-directorio-categoria',
        direccion: 'cfg-direccion',
        directorio: 'cfg-directorio-activo'
    };
    if (porId[tipo]) return document.getElementById(porId[tipo]);
    if (tipo === 'ubicacion') return document.querySelector('input[name="cfg-ubicacion-tipo"]');
    return null;
}

function bindGhosts(cont) {
    cont.querySelectorAll('[data-ghost]').forEach(ghost => {
        ghost.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const target = ghostTargetEl(ghost.dataset.ghost);
            if (!target) return;
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const seccion = target.closest('.config-section');
            if (seccion) {
                seccion.classList.remove('cfg-flash');
                void seccion.offsetWidth; // reinicia la animación
                seccion.classList.add('cfg-flash');
                setTimeout(() => seccion.classList.remove('cfg-flash'), 2400);
            }
            if (typeof target.focus === 'function') {
                try { target.focus({ preventScroll: true }); } catch (err) { /* no aplica */ }
            }
        });
    });
}

/** Re-renderiza la maqueta desde el estado REAL del formulario. */
function actualizarVitrina() {
    const cont = document.getElementById('cfg-vitrina');
    if (!cont) return;
    const cfg = leerConfigForm();
    const direccion = (cfg.direccion || '').trim();
    const dirActivo = cfg.directorio_activo === true;

    cont.innerHTML = renderVitrinaHtml(cfg);
    poblarImagenes(cont);
    poblarMapa(cont, direccion);
    bindGhosts(cont);

    if (_vitrinaDirPrevio === null) {
        _vitrinaDirPrevio = dirActivo; // primera vez: sin celebración al abrir
    } else if (dirActivo && !_vitrinaDirPrevio) {
        const dirCard = cont.querySelector('.pv-dir');
        if (dirCard) {
            dirCard.classList.add('pv-pop');
            setTimeout(() => dirCard.classList.remove('pv-pop'), 2400);
        }
        mostrarToast('🎉 ¡Tu negocio ya aparece en el Directorio Público!', 'success');
    }
    _vitrinaDirPrevio = dirActivo;
}

// --- Overlay para móvil/tablet (el aside solo se ve en pantallas anchas) ---

function abrirVitrinaOverlay() {
    cerrarVitrinaOverlay();
    const cont = document.getElementById('cfg-vitrina');
    if (!cont) return;
    // Recordar el contenedor original (aside) para devolverlo al cerrar.
    cont.__vitrinaOrigen = cont.parentNode;
    const overlay = document.createElement('div');
    overlay.className = 'cfg-vitrina-overlay';
    overlay.innerHTML = `
        <div class="cfg-vitrina-modal">
            <header class="cfg-vitrina-modal-head">
                <strong><i class="fas fa-mobile-alt"></i> Así la ven tus clientes</strong>
                <button type="button" id="cfg-vitrina-cerrar" title="Cerrar" aria-label="Cerrar vista previa">&times;</button>
            </header>
            <div class="cfg-vitrina-modal-body"></div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.cfg-vitrina-modal-body').appendChild(cont);
    actualizarVitrina();
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) cerrarVitrinaOverlay(); });
    document.getElementById('cfg-vitrina-cerrar')?.addEventListener('click', cerrarVitrinaOverlay);
}

function cerrarVitrinaOverlay() {
    const overlay = document.querySelector('.cfg-vitrina-overlay');
    if (!overlay) return;
    const body = overlay.querySelector('.cfg-vitrina-modal-body');
    const cont = body && body.firstElementChild;
    const origen = (cont && cont.__vitrinaOrigen) || document.querySelector('.config-vitrina .cfg-vitrina');
    if (cont && origen && cont !== origen) origen.appendChild(cont);
    overlay.remove();
    actualizarVitrina();
}

// ============================================================
// MINI-CHAT "DALE VIDA A TU WEB" (2 minutos, patrón conversación)
// Cada respuesta enciende algo en la vitrina en vivo. Nada se guarda:
// el usuario decide con "Guardar Cambios".
// ============================================================

function abrirCfgChat() {
    const overlay = document.createElement('div');
    overlay.className = 'cfgchat-overlay';
    overlay.innerHTML = `
        <div class="cfgchat-modal">
            <header class="cfgchat-head">
                <div class="cfgchat-head-icono"><i class="fas fa-wand-magic-sparkles"></i></div>
                <div class="cfgchat-head-txt">
                    <strong>Dale vida a tu web</strong>
                    <span>5 preguntas y ves el resultado al instante (nada se publica hasta Guardar Cambios)</span>
                </div>
                <button type="button" class="cfgchat-cerrar" id="cfgchat-cerrar" title="Cerrar" aria-label="Cerrar">&times;</button>
            </header>
            <div class="cfgchat-chat" id="cfgchat-chat"></div>
            <div class="cfgchat-zona" id="cfgchat-zona"></div>
        </div>
    `;
    document.body.appendChild(overlay);
    const chat = document.getElementById('cfgchat-chat');
    const zona = document.getElementById('cfgchat-zona');

    const cerrar = () => overlay.remove();
    document.getElementById('cfgchat-cerrar').addEventListener('click', cerrar);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) cerrar(); });

    const scrollAbajo = () => { chat.scrollTop = chat.scrollHeight; };

    function bot(html) {
        const div = document.createElement('div');
        div.className = 'cfgchat-msg cfgchat-bot';
        div.innerHTML = `<span class="cfgchat-burbuja">${html}</span>`;
        chat.appendChild(div);
        scrollAbajo();
        return div;
    }
    function user(html) {
        const div = document.createElement('div');
        div.className = 'cfgchat-msg cfgchat-user';
        div.innerHTML = `<span class="cfgchat-burbuja">${html}</span>`;
        chat.appendChild(div);
        scrollAbajo();
    }
    function zonaHtml(html) {
        zona.innerHTML = html;
        zona.style.display = 'block';
        scrollAbajo();
    }

    /** Escribe en un control real del formulario y refresca la vitrina. */
    function aplicarCampo(id, valor, evento = 'input') {
        const el = document.getElementById(id);
        if (!el) return false;
        el.value = valor;
        el.dispatchEvent(new Event(evento, { bubbles: true }));
        actualizarVitrina();
        return true;
    }

    const inputConEnter = (inputId, btnId, fn) => {
        document.getElementById(btnId).addEventListener('click', fn);
        const inp = document.getElementById(inputId);
        if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fn(); } });
    };

    // ── 1) Nombre ──
    bot(`¡Hola! 👋 Voy a dejar tu página lista en 2 minutos.<br><br><strong>¿Qué nombre verán tus clientes?</strong>`);
    const nombreInput = document.getElementById('cfg-nombre-negocio');
    const nombreActual = (nombreInput && !nombreInput.disabled) ? nombreInput.value : (_tenantData && _tenantData.nombre_negocio) || '';
    zonaHtml(`
        <div class="cfgchat-fila">
            <input type="text" id="cfgchat-nombre" class="cfgchat-input" value="${escapeAttr(nombreActual)}" maxlength="60" placeholder="Nombre de tu negocio">
            <button type="button" class="cfgchat-btn" id="cfgchat-nombre-ok"><i class="fas fa-arrow-right"></i></button>
        </div>
        ${nombreInput && nombreInput.disabled ? '<p class="cfgchat-nota"><i class="fas fa-clock"></i> El nombre se cambia cada 14 días: lo dejamos como está.</p>' : ''}
    `);
    const inpNombre = document.getElementById('cfgchat-nombre');
    if (inpNombre) inpNombre.focus();
    inputConEnter('cfgchat-nombre', 'cfgchat-nombre-ok', () => {
        const v = (inpNombre.value || '').trim();
        if (nombreInput && !nombreInput.disabled) {
            if (!v) { mostrarToast('Escribe el nombre del negocio', 'warning'); return; }
            aplicarCampo('cfg-nombre-negocio', v);
        }
        user(escapeHtml(v || nombreActual || 'El nombre actual'));
        setTimeout(pasoColor, 250);
    });

    // ── 2) Look / colores ──
    function pasoColor() {
        bot(`<strong>¿Qué color te representa?</strong> Toca uno y mira la maqueta a la derecha (o arriba en el celular).`);
        zonaHtml(`
            <div class="cfgchat-temas">
                ${Object.entries(TEMAS_PREDEFINIDOS).map(([key, t]) => `
                    <button type="button" class="cfgchat-tema" data-tema="${key}" title="${escapeAttr(t.nombre)}">
                        <span class="cfgchat-tema-dots"><i style="background:${t.primary_color}"></i><i style="background:${t.secondary_color}"></i><i style="background:${t.background_color}"></i></span>
                        <span>${escapeHtml(t.nombre)}</span>
                    </button>`).join('')}
            </div>
        `);
        zona.querySelectorAll('.cfgchat-tema').forEach(btn => {
            btn.addEventListener('click', () => {
                const tema = TEMAS_PREDEFINIDOS[btn.dataset.tema];
                if (!tema) return;
                aplicarTema(tema);
                actualizarVitrina();
                user(`Look: <strong>${escapeHtml(tema.nombre)}</strong> aplicado en vivo`);
                setTimeout(pasoUbicacion, 300);
            });
        });
    }

    // ── 3) Ubicación ──
    function pasoUbicacion() {
        bot(`<strong>¿Dónde te encuentra la gente?</strong>`);
        zonaHtml(`
            <button type="button" class="cfgchat-opcion" data-ubi="local"><i class="fas fa-store"></i> Tengo local: que me ubiquen</button>
            <button type="button" class="cfgchat-opcion" data-ubi="domicilio"><i class="fas fa-truck"></i> Voy al domicilio del cliente</button>
            <button type="button" class="cfgchat-opcion" data-ubi=""><i class="fas fa-hourglass-half"></i> Lo decido después</button>
        `);
        zona.querySelectorAll('.cfgchat-opcion').forEach(btn => {
            btn.addEventListener('click', () => {
                const ubi = btn.dataset.ubi;
                if (ubi) {
                    const radio = document.querySelector(`input[name="cfg-ubicacion-tipo"][value="${ubi}"]`);
                    if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
                    actualizarVitrina();
                }
                user(ubi === 'local' ? 'Tengo local' : ubi === 'domicilio' ? 'Voy al domicilio' : 'Lo decido después');
                if (ubi === 'local') setTimeout(pasoDireccion, 300);
                else setTimeout(pasoRedes, 300);
            });
        });
    }

    function pasoDireccion() {
        bot(`<strong>Escribe la dirección de tu local:</strong> en la maqueta verás aparecer el mapa.`);
        zonaHtml(`
            <div class="cfgchat-fila">
                <input type="text" id="cfgchat-dir" class="cfgchat-input" placeholder="Ej: Av. Providencia 1234, Santiago" value="${escapeAttr((leerConfigForm().direccion || '').trim())}">
                <button type="button" class="cfgchat-btn" id="cfgchat-dir-ok"><i class="fas fa-arrow-right"></i></button>
            </div>
        `);
        const inpDir = document.getElementById('cfgchat-dir');
        inpDir.focus();
        inputConEnter('cfgchat-dir', 'cfgchat-dir-ok', () => {
            const v = (inpDir.value || '').trim();
            if (v.length < 6) { mostrarToast('Escribe una dirección para mostrar el mapa', 'warning'); return; }
            aplicarCampo('cfg-direccion', v);
            user(`Dirección guardada: <strong>${escapeHtml(v)}</strong>`);
            setTimeout(pasoRedes, 350);
        });
    }

    // ── 4) Redes ──
    function pasoRedes(redAnterior) {
        if (redAnterior === 'instagram') {
            bot(`<strong>¿Y tu TikTok?</strong> (o elige "No por ahora")`);
        } else {
            bot(`<strong>¿Tienes redes para que te sigan desde tu página?</strong>`);
        }
        zonaHtml(`
            <button type="button" class="cfgchat-opcion" data-red="instagram"><i class="fab fa-instagram"></i> Instagram</button>
            <button type="button" class="cfgchat-opcion" data-red="tiktok"><i class="fab fa-tiktok"></i> TikTok</button>
            <button type="button" class="cfgchat-opcion" data-red="no"><i class="fas fa-check"></i> No por ahora</button>
        `);
        zona.querySelectorAll('.cfgchat-opcion').forEach(btn => {
            btn.addEventListener('click', () => {
                const red = btn.dataset.red;
                if (red === 'no') {
                    user('No por ahora');
                    bot('Cuando quieras las agregas en el paso 5 (Redes Sociales). 😉');
                    setTimeout(pasoDirectorio, 400);
                    return;
                }
                user(red === 'instagram' ? 'Sí, tengo Instagram' : 'Sí, tengo TikTok');
                const campo = red === 'instagram' ? 'cfg-instagram' : 'cfg-tiktok';
                bot(red === 'instagram'
                    ? '<strong>Pega aquí el enlace de tu Instagram:</strong>'
                    : '<strong>Pega aquí el enlace de tu TikTok:</strong>');
                zonaHtml(`
                    <div class="cfgchat-fila">
                        <input type="url" id="cfgchat-red" class="cfgchat-input" placeholder="${red === 'instagram' ? 'https://instagram.com/tu-perfil' : 'https://tiktok.com/@tu-perfil'}" value="${escapeAttr((leerConfigForm()[red === 'instagram' ? 'instagram_url' : 'tiktok_url'] || '').trim())}">
                        <button type="button" class="cfgchat-btn" id="cfgchat-red-ok"><i class="fas fa-arrow-right"></i></button>
                    </div>
                `);
                const inpRed = document.getElementById('cfgchat-red');
                inpRed.focus();
                inputConEnter('cfgchat-red', 'cfgchat-red-ok', () => {
                    const v = (inpRed.value || '').trim();
                    if (!/^https?:\/\/.+\..+/.test(v)) { mostrarToast('Pega el enlace completo (empieza con https://)', 'warning'); return; }
                    aplicarCampo(campo, v);
                    user(`Listo, enlace guardado`);
                    if (redAnterior !== 'instagram' && red === 'instagram') setTimeout(() => pasoRedes('instagram'), 350);
                    else setTimeout(pasoDirectorio, 350);
                });
            });
        });
    }

    // ── 5) Directorio ──
    function pasoDirectorio() {
        bot(`<strong>¿Quieres que clientes nuevos te encuentren?</strong> Aparecer en el Directorio Público de Organify es gratis según tu plan.`);
        zonaHtml(`
            <button type="button" class="cfgchat-opcion" data-dir="1"><i class="fas fa-store"></i> Sí, quiero aparecer</button>
            <button type="button" class="cfgchat-opcion" data-dir="0"><i class="fas fa-hourglass-half"></i> Luego lo veo</button>
        `);
        zona.querySelectorAll('.cfgchat-opcion').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.dataset.dir === '1') {
                    const sw = document.getElementById('cfg-directorio-activo');
                    if (sw && !sw.checked) {
                        sw.checked = true;
                        sw.dispatchEvent(new Event('change', { bubbles: true }));
                        actualizarVitrina();
                    }
                    user('Sí, quiero aparecer en el directorio');
                    const faltan = faltantesTarjetaDirectorio(leerConfigForm());
                    bot(faltan.length
                        ? `¡Activado! 🎉 Para que tu tarjeta luzca completa te falta: <strong>${escapeHtml(faltan.join(', '))}</strong>. Tócalos en la maqueta y se completan solos.`
                        : '¡Activado! 🎉 Tu tarjeta está completa: mira cómo te ven los clientes nuevos en la maqueta.');
                } else {
                    user('Luego lo veo');
                    bot('Queda como pendiente: verás el candado 🔒 en la maqueta hasta que lo actives.');
                }
                setTimeout(pasoFinal, 600);
            });
        });
    }

    function pasoFinal() {
        bot(`¡Tu web quedó así! 🎉 Mírala en la maqueta${window.innerWidth < 1100 ? ' tocando "Ver cómo queda"' : ' a la derecha'}.<br><br>Puedes cambiarlo cuando quieras. Cuando estés conforme, toca <strong>Guardar Cambios</strong> para publicarlo.`);
        zonaHtml(`
            <button type="button" class="cfgchat-btn-ancho" id="cfgchat-fin">Entendido, ¡gracias!</button>
        `);
        document.getElementById('cfgchat-fin').addEventListener('click', cerrar);
    }
}

// ============================================================
// DIRECTORIO: helpers (opciones de tipo, fotos, moderación)
// ============================================================
function renderOpcionesTipo(categoriaId, seleccionado) {
    if (!categoriaId) return '<option value="">Primero elige una categoría...</option>';
    return getTiposDeCategoria(categoriaId).map(t =>
        `<option value="${escapeAttr(t)}" ${seleccionado === t ? 'selected' : ''}>${escapeHtml(t)}</option>`
    ).join('');
}

function renderFotosDirectorio() {
    const preview = document.getElementById('directorio-fotos-preview');
    const hint = document.getElementById('directorio-fotos-hint');
    if (preview) {
        preview.innerHTML = _fotosDirectorio.map((url, i) => `
            <div class="directorio-foto">
                <img src="${escapeAttr(url)}" alt="Foto ${i + 1}" loading="lazy">
                <button type="button" class="directorio-foto-remove" data-idx="${i}" title="Quitar foto" aria-label="Quitar foto">&times;</button>
            </div>
        `).join('');
    }
    if (hint) {
        hint.textContent = _fotosDirectorio.length
            ? `${_fotosDirectorio.length}/3 fotos elegidas.`
            : 'Sin fotos todavía.';
    }
}

async function subirFotoDirectorio(file) {
    if (!file || !file.type) { mostrarToast('❌ No se pudo leer el archivo', 'error'); return; }
    const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
    if (!ALLOWED.includes(file.type)) { mostrarToast('❌ Formato no permitido. Usa JPG, PNG o WebP', 'error'); return; }
    if (file.size > 5 * 1024 * 1024) { mostrarToast('❌ La imagen excede 5MB', 'error'); return; }

    try {
        const imagen = await optimizarImagen(file, 800, 0.82);
        let tenantId = null;
        try {
            if (window.supabaseClient) {
                const { data: t } = await window.supabaseClient.rpc('get_user_tenant_id');
                tenantId = t || null;
            }
        } catch (e) {
            console.warn('[Directorio] tenant canónico no disponible:', e);
        }
        tenantId = tenantId || window.currentTenantId || window.__clientTenantId || (await getCurrentTenantId()) || 'public';
        const filePath = `${tenantId}/directorio/foto-${Date.now()}.jpg`;
        const supabase = window.supabaseClient;
        if (!supabase) throw new Error('Cliente no disponible');

        const { error } = await supabase.storage
            .from('service-images')
            .upload(filePath, imagen, { contentType: 'image/jpeg', upsert: true });
        if (error) throw error;

        const { data: urlData } = supabase.storage
            .from('service-images')
            .getPublicUrl(filePath);
        if (urlData?.publicUrl) {
            _fotosDirectorio.push(urlData.publicUrl);
            mostrarToast('✅ Foto agregada a tu tarjeta', 'success');
        }
    } catch (e) {
        console.error('[Directorio] Error subiendo foto:', e);
        mostrarToast('❌ Error al subir foto: ' + (e.message || 'Desconocido'), 'error');
    }
}

async function cargarModeracion() {
    const cont = document.getElementById('directorio-moderacion');
    if (!cont) return;
    let resenas = [];
    try {
        resenas = await getResenasAdmin();
    } catch (e) {
        console.warn('[Directorio] No se pudieron cargar las reseñas:', e.message);
        cont.innerHTML = '<p class="muted small">No se pudieron cargar las reseñas.</p>';
        return;
    }
    const lista = Array.isArray(resenas) ? resenas : [];
    cont.innerHTML = renderModeracion(lista);
    cont.querySelectorAll('[data-moderar]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.moderar;
            const estado = btn.dataset.accion;
            if (estado === 'rechazado' && !confirm('¿Rechazar esta reseña? Dejará de verse en tu página pública. Puedes publicarla de nuevo cuando quieras.')) {
                return;
            }
            btn.disabled = true;
            try {
                await moderarResena(id, estado);
                mostrarToast(estado === 'aprobado' ? '✅ Reseña aprobada y publicada' : 'Reseña rechazada', estado === 'aprobado' ? 'success' : 'info');
                cargarModeracion();
            } catch (e) {
                mostrarToast('❌ ' + (e.message || 'No se pudo moderar'), 'error');
                btn.disabled = false;
            }
        });
    });
    // Badge de pendientes en el título del paso 7 (visible aunque la sección esté plegada)
    const badge = document.getElementById('cfg-directorio-badge');
    if (badge) {
        const n = lista.filter(r => r.estado === 'pendiente').length;
        if (n > 0) {
            badge.textContent = `🔔 ${n} reseña${n === 1 ? '' : 's'} pendiente${n === 1 ? '' : 's'} de moderar`;
            badge.style.display = 'inline-block';
        } else {
            badge.style.display = 'none';
        }
    }
}

function renderModeracion(resenas) {
    if (!resenas.length) {
        return '<p class="muted small"><i class="fas fa-inbox"></i> Aún no hay reseñas. Comparte tu página pública para que tus clientes opinen de tu negocio.</p>';
    }
    const pendientes = resenas.filter(r => r.estado === 'pendiente');
    const aprobadas = resenas.filter(r => r.estado === 'aprobado');
    const rechazadas = resenas.filter(r => r.estado === 'rechazado');
    const header = `<p class="muted small" style="margin-bottom:8px;">Pendientes: <strong>${pendientes.length}</strong> · Publicadas: ${aprobadas.length} · Rechazadas: ${rechazadas.length}</p>`;

    const bloques = [];
    if (pendientes.length) {
        bloques.push(`<p class="muted small" style="margin:10px 0 4px;"><strong><i class="fas fa-hourglass-half"></i> Por moderar</strong></p>` +
            pendientes.map(r => renderResenaAdminItem(r)).join(''));
    }
    if (aprobadas.length) {
        bloques.push(`<p class="muted small" style="margin:10px 0 4px;"><strong><i class="fas fa-check-circle" style="color:#00b894;"></i> Publicadas en tu página</strong></p>` +
            aprobadas.map(r => renderResenaAdminItem(r)).join(''));
    }
    if (rechazadas.length) {
        bloques.push(`<p class="muted small" style="margin:10px 0 4px;"><strong><i class="fas fa-times-circle" style="color:#e74c3c;"></i> Rechazadas</strong></p>` +
            rechazadas.map(r => renderResenaAdminItem(r)).join(''));
    }
    return header + bloques.join('');
}

function renderResenaAdminItem(r) {
    const estrellas = r.puntuacion
        ? `<span class="pyme-card-stars small">${[1,2,3,4,5].map(i => `<i class="${i <= r.puntuacion ? 'fas' : 'far'} fa-star"></i>`).join('')}</span>`
        : '<span class="muted small">Sin puntuación</span>';
    const fecha = r.creado_en ? new Date(r.creado_en).toLocaleString('es-ES') : '';

    let acciones = '';
    if (r.estado === 'pendiente') {
        acciones = `
            <button type="button" class="btn-small" data-moderar="${r.id}" data-accion="aprobado" style="background:linear-gradient(135deg,#00b894,#00a381);border:none;color:#fff;box-shadow:0 4px 12px rgba(0,184,148,0.3);">
                <i class="fas fa-check"></i> Aprobar y publicar
            </button>
            <button type="button" class="btn-small" data-moderar="${r.id}" data-accion="rechazado" style="background:rgba(231,76,60,0.12);border:1px solid rgba(231,76,60,0.35);color:#e74c3c;">
                <i class="fas fa-times"></i> Rechazar
            </button>`;
    } else if (r.estado === 'aprobado') {
        acciones = `
            <span class="muted small" style="margin-right:6px;"><i class="fas fa-globe-americas" style="color:#00b894;"></i> Visible en tu página pública</span>
            <button type="button" class="btn-small" data-moderar="${r.id}" data-accion="rechazado" style="background:rgba(231,76,60,0.12);border:1px solid rgba(231,76,60,0.35);color:#e74c3c;">
                <i class="fas fa-eye-slash"></i> Quitar de mi página
            </button>`;
    } else {
        acciones = `
            <span class="muted small" style="margin-right:6px;">Oculta para el público</span>
            <button type="button" class="btn-small" data-moderar="${r.id}" data-accion="aprobado" style="background:linear-gradient(135deg,#00b894,#00a381);border:none;color:#fff;box-shadow:0 4px 12px rgba(0,184,148,0.3);">
                <i class="fas fa-redo"></i> Publicar de nuevo
            </button>`;
    }

    return `
        <div class="directorio-resena-admin">
            <div class="directorio-resena-admin-head">
                <strong>${escapeHtml(r.nombre_cliente)}</strong>
                ${estrellas}
                ${fecha ? `<span class="muted small">${fecha}</span>` : ''}
            </div>
            ${r.comentario ? `<p class="directorio-resena-texto">${escapeHtml(r.comentario)}</p>` : ''}
            <div class="directorio-resena-admin-acciones">${acciones}</div>
        </div>`;
}

async function subirImagenStorage(file, tipo, inputId) {
    // tipo: 'logo' o 'cover'
    const nameMap = { logo: 'Logo', cover: 'Portada' };
    const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
    const MAX_SIZE_MB = 5;
    const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;

    // Validación estricta de tipo MIME (client-side)
    if (!file || !file.type) {
        mostrarToast('❌ No se pudo leer el archivo', 'error');
        return;
    }
    if (!ALLOWED_TYPES.includes(file.type)) {
        mostrarToast(`❌ Formato no permitido: ${file.type}. Usa JPG, PNG o WebP`, 'error');
        return;
    }

    // Validación de tamaño máximo
    if (file.size > MAX_SIZE_BYTES) {
        const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
        mostrarToast(`❌ La imagen excede ${MAX_SIZE_MB}MB (tamaño: ${sizeMB}MB)`, 'error');
        return;
    }
    const barId = tipo === 'logo' ? 'logo-upload-progress' : 'cover-upload-progress';
    const fillId = tipo === 'logo' ? 'logo-upload-fill' : 'cover-upload-fill';
    const textId = tipo === 'logo' ? 'logo-upload-text' : 'cover-upload-text';
    const previewId = tipo === 'logo' ? 'logo-preview' : 'cover-preview';
    const previewImgId = tipo === 'logo' ? 'logo-preview-img' : 'cover-preview-img';
    const cfgInputId = tipo === 'logo' ? 'cfg-logo' : 'cfg-cover';

    const bar = document.getElementById(barId);
    const fill = document.getElementById(fillId);
    const text = document.getElementById(textId);

    if (bar) bar.style.display = 'flex';
    if (fill) fill.style.width = '20%';
    if (text) text.textContent = 'Optimizando...';

    try {
        const maxWidth = tipo === 'cover' ? 1200 : (tipo === 'logo' ? 400 : 256);
        const imagenOptimizada = await optimizarImagen(file, maxWidth, 0.85);
        if (fill) fill.style.width = '50%';
        if (text) text.textContent = 'Subiendo...';

        // La política RLS del bucket exige que la PRIMERA carpeta del path sea
        // el tenant de user_roles (get_user_tenant_id), no el del JWT.
        // Por eso el path es {tenant}/logos/{file} (antes logos/{tenant} daba 403).
        let tenantId = null;
        try {
            if (window.supabaseClient) {
                const { data: tenantCanonico } = await window.supabaseClient.rpc('get_user_tenant_id');
                tenantId = tenantCanonico || null;
            }
        } catch (e) {
            console.warn(`[${tipo} upload] tenant canónico no disponible, uso JWT:`, e);
        }
        tenantId = tenantId || window.currentTenantId || window.__clientTenantId || (await getCurrentTenantId()) || 'public';
        const fileName = `${tipo}-${Date.now()}.jpg`;
        const filePath = `${tenantId}/logos/${fileName}`;
        const supabase = window.supabaseClient;
        if (!supabase) throw new Error('Cliente no disponible');

        const { data, error } = await supabase.storage
            .from('service-images')
            .upload(filePath, imagenOptimizada, { contentType: 'image/jpeg', upsert: true });
        if (error) throw error;

        if (fill) fill.style.width = '80%';
        if (text) text.textContent = 'Procesando...';

        const { data: urlData } = supabase.storage
            .from('service-images')
            .getPublicUrl(filePath);
        const publicUrl = urlData?.publicUrl;

        if (publicUrl) {
            const cfgInput = document.getElementById(cfgInputId);
            if (cfgInput) cfgInput.value = publicUrl;
            if (tipo === 'cover') {
                mostrarPreviewCover(publicUrl);
            } else {
                mostrarPreviewGuardado(previewId, previewImgId, publicUrl);
            }
            // Aplicar preview visual
            const config = leerConfigForm();
            aplicarConfigVisual(config);
            const nombre = nameMap[tipo] || tipo;
            mostrarToast(`✅ ${nombre} subido exitosamente`, 'success');
        }
        if (bar) bar.style.display = 'none';
    } catch (e) {
        const nombre = nameMap[tipo] || tipo;
        console.error(`[${tipo} upload] Error:`, e);
        mostrarToast(`❌ Error al subir ${nombre}: ${e.message || 'Desconocido'}`, 'error');
        if (bar) bar.style.display = 'none';
    }
}

function optimizarImagen(file, maxWidth, quality) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = function(e) {
            const img = new Image();
            img.onload = function() {
                const canvas = document.createElement('canvas');
                let w = img.width, h = img.height;
                if (w > maxWidth) {
                    h = h * maxWidth / w;
                    w = maxWidth;
                }
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                canvas.toBlob(function(blob) {
                    if (blob) resolve(blob);
                    else reject(new Error('Fallo al comprimir imagen'));
                }, 'image/jpeg', quality);
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function mostrarPreviewGuardado(previewId, imgId, url) {
    const preview = document.getElementById(previewId);
    const previewImg = document.getElementById(imgId);
    if (preview && previewImg) {
        if (url && url.trim()) {
            previewImg.src = url;
            preview.style.display = 'block';
        } else {
            preview.style.display = 'none';
        }
    }
}

function mostrarPreviewCover(url) {
    const preview = document.getElementById('cover-preview');
    const previewImg = document.getElementById('cover-preview-img');
    if (preview && previewImg) {
        if (url && url.trim()) {
            previewImg.src = url;
            preview.style.display = 'block';
        } else {
            preview.style.display = 'none';
        }
    }
}

function leerConfigForm() {
    return {
        primary_color: document.getElementById('cfg-primary')?.value || '#9d4edd',
        secondary_color: document.getElementById('cfg-secondary')?.value || '#ff6d00',
        bg_color: document.getElementById('cfg-bg')?.value || '#0d0d0d',
        card_bg: document.getElementById('cfg-card')?.value || '#1a1a2e',
        text_color: document.getElementById('cfg-text')?.value || '#e0e0e0',
        border_color: document.getElementById('cfg-border')?.value || '#2a2a4a',
        // Campos sin UI (tipografía y CSS ya no son editables): conservar el valor guardado
        font_family: document.getElementById('cfg-font')?.value || _configSnapshot?.font_family || "'Inter', sans-serif",
        logo_url: document.getElementById('cfg-logo')?.value || '',
        cover_url: document.getElementById('cfg-cover')?.value || '',
        instagram_url: document.getElementById('cfg-instagram')?.value || '',
        tiktok_url: document.getElementById('cfg-tiktok')?.value || '',
        ubicacion_tipo: document.querySelector('input[name="cfg-ubicacion-tipo"]:checked')?.value || '',
        direccion: document.getElementById('cfg-direccion')?.value || '',
        // Directorio público y reseñas
        directorio_activo: document.getElementById('cfg-directorio-activo')?.checked || false,
        directorio_categoria: document.getElementById('cfg-directorio-categoria')?.value || '',
        directorio_tipo_pyme: document.getElementById('cfg-directorio-tipo')?.value || '',
        directorio_fotos: Array.isArray(_fotosDirectorio) ? _fotosDirectorio : [],
        directorio_estrellas: document.getElementById('cfg-directorio-estrellas')?.checked || false,
        directorio_comentarios: document.getElementById('cfg-directorio-comentarios')?.checked || false,
        border_radius: parseInt(document.getElementById('cfg-radius')?.value) || _configSnapshot?.border_radius || 12,
        animation_speed: parseFloat(document.getElementById('cfg-anim-speed')?.value) || _configSnapshot?.animation_speed || 0.3,
        custom_css: document.getElementById('custom-css')?.value || _configSnapshot?.custom_css || ''
    };
}

function aplicarTema(tema) {
    const inputs = {
        'cfg-primary': tema.primary_color,
        'cfg-secondary': tema.secondary_color,
        'cfg-bg': tema.background_color || tema.bg_color,
        'cfg-card': tema.card_color || tema.card_bg,
        'cfg-text': tema.text_color,
        'cfg-border': tema.border_color
    };
    Object.entries(inputs).forEach(([id, val]) => {
        const el = document.getElementById(id);
        if (el) el.value = val;
    });
    aplicarConfigVisual(tema);
    mostrarToast(`Tema "${tema.nombre}" aplicado`, 'info');
}

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(str) {
    if (!str) return '';
    return String(str).replace(/\"/g, '&quot;').replace(/'/g, '&#39;');
}
