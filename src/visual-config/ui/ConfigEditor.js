// visual-config/ui/ConfigEditor.js
// Editor de personalizacion visual para admin.html
// Permite cambiar colores, logo y previsualizar en vivo

import { getVisualConfig, saveVisualConfig, aplicarConfigVisual, TEMAS_PREDEFINIDOS } from '../application/VisualConfigService.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { getCurrentTenantId } from '../../shared/infrastructure/router.js';

export async function initConfigEditor(containerId = 'visual-config-editor') {
    const container = document.getElementById(containerId);
    if (!container) return;

    const config = await getVisualConfig();

    container.innerHTML = `
        <div class="config-editor">

            <!-- GUÍA RÁPIDA PASO A PASO -->
            <div class="step-guide">
                <i class="fas fa-info-circle"></i>
                <span><strong>Así funciona:</strong> Elige un <strong>tema rápido</strong> (paso 1) para cambiar todo al instante, o personaliza colores, tipografía y logo uno por uno (pasos 2–5). Usa <strong>"Guardar Cambios"</strong> solo cuando estés conforme.</span>
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
                </div>
            </div>

            <!-- PASO 3: TIPOGRAFÍA Y ESTILO -->
            <div class="config-section">
                <h4 class="config-section-title"><i class="fas fa-font"></i> 3. Tipografía y Estilo</h4>
                <p class="field-hint" style="margin-bottom:10px;">Define la fuente, el redondeo de esquinas y la velocidad de animación.</p>
                <div class="form-row two-cols">
                    <div class="input-with-label">
                        <label><i class="fas fa-text-height"></i> Fuente</label>
                        <select id="cfg-font" class="config-select">
                            <option value="'Poppins', sans-serif" ${config.font_family.includes('Poppins') ? 'selected' : ''}>Poppins</option>
                            <option value="'Inter', sans-serif" ${config.font_family.includes('Inter') ? 'selected' : ''}>Inter</option>
                            <option value="'Montserrat', sans-serif" ${config.font_family.includes('Montserrat') ? 'selected' : ''}>Montserrat</option>
                            <option value="'Playfair Display', serif" ${config.font_family.includes('Playfair') ? 'selected' : ''}>Playfair Display</option>
                            <option value="'Roboto', sans-serif" ${config.font_family.includes('Roboto') ? 'selected' : ''}>Roboto</option>
                        </select>
                    </div>
                    <div class="input-with-label">
                        <label><i class="fas fa-square"></i> Borde redondo</label>
                        <select id="cfg-radius" class="config-select">
                            <option value="4px" ${config.border_radius === '4px' || config.border_radius == 4 ? 'selected' : ''}>Cuadrado (4px)</option>
                            <option value="8px" ${config.border_radius === '8px' || config.border_radius == 8 ? 'selected' : ''}>Suave (8px)</option>
                            <option value="12px" ${config.border_radius === '12px' || config.border_radius == 12 ? 'selected' : ''}>Redondeado (12px)</option>
                            <option value="16px" ${config.border_radius === '16px' || config.border_radius == 16 ? 'selected' : ''}>Muy redondeado (16px)</option>
                            <option value="50%" ${config.border_radius === '50%' ? 'selected' : ''}>Píldora (50%)</option>
                        </select>
                    </div>
                </div>
                <div class="form-row two-cols" style="margin-top:10px;">
                    <div class="input-with-label">
                        <label><i class="fas fa-hourglass-half"></i> Velocidad animación</label>
                        <select id="cfg-anim-speed" class="config-select">
                            <option value="0.15" ${config.animation_speed == 0.15 ? 'selected' : ''}>Rápido</option>
                            <option value="0.3" ${config.animation_speed == 0.3 ? 'selected' : ''}>Normal</option>
                            <option value="0.5" ${config.animation_speed == 0.5 ? 'selected' : ''}>Lento</option>
                        </select>
                    </div>
                    <div class="input-with-label">
                        <label><i class="fas fa-moon"></i> Modo</label>
                        <select id="cfg-theme-mode" class="config-select">
                            <option value="dark" ${config.theme_mode !== 'light' ? 'selected' : ''}>Oscuro</option>
                            <option value="light" ${config.theme_mode === 'light' ? 'selected' : ''}>Claro</option>
                        </select>
                    </div>
                </div>
            </div>

            <!-- PASO 4: LOGO -->
            <div class="config-section">
                <h4 class="config-section-title"><i class="fas fa-image"></i> 4. Logo</h4>
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

            <!-- PASO 5: PORTADA / BANNER -->
            <div class="config-section">
                <h4 class="config-section-title"><i class="fas fa-panorama"></i> 5. Portada / Banner</h4>
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
            font_family: "'Inter', sans-serif",
            logo_url: '',
            cover_url: '',
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

        const tenantId = window.currentTenantId || window.__clientTenantId || (await getCurrentTenantId()) || 'public';
        const fileName = `${tipo}-${Date.now()}.jpg`;
        const filePath = `logos/${tenantId}/${fileName}`;
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
        font_family: document.getElementById('cfg-font')?.value || "'Inter', sans-serif",
        logo_url: document.getElementById('cfg-logo')?.value || '',
        cover_url: document.getElementById('cfg-cover')?.value || '',
        border_radius: parseInt(document.getElementById('cfg-radius')?.value) || 12,
        animation_speed: parseFloat(document.getElementById('cfg-anim-speed')?.value) || 0.3,
        custom_css: ''
    };
}

function aplicarTema(tema) {
    const inputs = {
        'cfg-primary': tema.primary_color,
        'cfg-secondary': tema.secondary_color,
        'cfg-bg': tema.background_color || tema.bg_color,
        'cfg-card': tema.card_color || tema.card_bg,
        'cfg-text': tema.text_color
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
