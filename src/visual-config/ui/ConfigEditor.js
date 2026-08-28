// visual-config/ui/ConfigEditor.js
// Editor de personalizacion visual para admin.html
// Permite cambiar colores, logo y previsualizar en vivo

import { getVisualConfig, saveVisualConfig, aplicarConfigVisual, TEMAS_PREDEFINIDOS } from '../application/VisualConfigService.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { getCurrentTenantId } from '../../shared/infrastructure/router.js';
import { initDireccionAutocomplete } from '../../shared/ui/direccionAutocomplete.js';

// Snapshot de la config cargada: conserva valores de campos ya no editables
// (tipografía, CSS personalizado) para que guardar NO los borre.
let _configSnapshot = null;

export async function initConfigEditor(containerId = 'visual-config-editor') {
    const container = document.getElementById(containerId);
    if (!container) return;

    const config = await getVisualConfig();
    _configSnapshot = config;

    container.innerHTML = `
        <div class="config-editor">

            <!-- GUÍA RÁPIDA PASO A PASO -->
            <div class="step-guide">
                <i class="fas fa-info-circle"></i>
                <span><strong>Así funciona:</strong> Elige un <strong>tema rápido</strong> (paso 1) para cambiar todo al instante, o personaliza colores y logo uno por uno (pasos 2–5). Usa <strong>"Guardar Cambios"</strong> solo cuando estés conforme.</span>
            </div>

            <!-- PASO 1: TEMAS RÁPIDOS -->
            <div class="config-section">
                <h4 class="config-section-title"><i class="fas fa-paint-roller"></i> 1. Temas Rápidos</h4>
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
        </div>
    `;

    // Mostrar preview de logo y cover si ya hay URLs guardadas
    mostrarPreviewGuardado('logo-preview', 'logo-preview-img', config.logo_url);
    mostrarPreviewCover(config.cover_url);

    // Event listeners
    document.getElementById('temas-grid')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.tema-btn');
        if (!btn) return;
        const tema = TEMAS_PREDEFINIDOS[btn.dataset.tema];
        if (!tema) return;
        aplicarTema(tema);
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
