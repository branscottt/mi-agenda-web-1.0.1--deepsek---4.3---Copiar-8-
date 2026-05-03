// visual-config/ui/ConfigEditor.js
// Editor de personalizacion visual para admin.html
// Permite cambiar colores, logo y previsualizar en vivo

import { getVisualConfig, saveVisualConfig, aplicarConfigVisual, TEMAS_PREDEFINIDOS } from '../application/VisualConfigService.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';

export async function initConfigEditor(containerId = 'visual-config-editor') {
    const container = document.getElementById(containerId);
    if (!container) return;

    const config = await getVisualConfig();

    container.innerHTML = `
        <div class="config-editor">
            <h3><i class="fas fa-palette"></i> Personalizar Apariencia</h3>

            <div class="config-section">
                <h4>Temas rapidos</h4>
                <div class="temas-grid" id="temas-grid">
                    ${Object.entries(TEMAS_PREDEFINIDOS).map(([key, t]) => `
                        <button class="tema-btn" data-tema="${key}" title="${escapeAttr(t.nombre)}">
                            <span class="tema-preview" style="background:${t.primary_color}"></span>
                            <span>${escapeHtml(t.nombre)}</span>
                        </button>
                    `).join('')}
                </div>
            </div>

            <div class="config-section">
                <h4>Colores</h4>
                <div class="config-grid">
                    <label>Color primario
                        <input type="color" id="cfg-primary" value="${config.primary_color}">
                    </label>
                    <label>Color secundario
                        <input type="color" id="cfg-secondary" value="${config.secondary_color}">
                    </label>
                    <label>Fondo
                        <input type="color" id="cfg-bg" value="${config.background_color}">
                    </label>
                    <label>Tarjetas
                        <input type="color" id="cfg-card" value="${config.card_color}">
                    </label>
                    <label>Texto
                        <input type="color" id="cfg-text" value="${config.text_color}">
                    </label>
                </div>
            </div>

            <div class="config-section">
                <h4>Tipografia</h4>
                <select id="cfg-font" class="config-select">
                    <option value="'Poppins', sans-serif" ${config.font_family.includes('Poppins') ? 'selected' : ''}>Poppins</option>
                    <option value="'Inter', sans-serif" ${config.font_family.includes('Inter') ? 'selected' : ''}>Inter</option>
                    <option value="'Montserrat', sans-serif" ${config.font_family.includes('Montserrat') ? 'selected' : ''}>Montserrat</option>
                    <option value="'Playfair Display', serif" ${config.font_family.includes('Playfair') ? 'selected' : ''}>Playfair Display</option>
                    <option value="'Roboto', sans-serif" ${config.font_family.includes('Roboto') ? 'selected' : ''}>Roboto</option>
                </select>
            </div>

            <div class="config-section">
                <h4>Logo y favicon</h4>
                <label>URL del logo
                    <input type="url" id="cfg-logo" class="config-input" value="${escapeAttr(config.logo_url || '')}" placeholder="https://ejemplo.com/logo.png">
                </label>
                <label>URL del favicon
                    <input type="url" id="cfg-favicon" class="config-input" value="${escapeAttr(config.favicon_url || '')}" placeholder="https://ejemplo.com/favicon.ico">
                </label>
            </div>

            <div class="config-section">
                <h4>Bordes y animaciones</h4>
                <label>Radio de bordes
                    <select id="cfg-radius" class="config-select">
                        <option value="4px" ${config.border_radius === '4px' ? 'selected' : ''}>Cuadrado (4px)</option>
                        <option value="8px" ${config.border_radius === '8px' ? 'selected' : ''}>Suave (8px)</option>
                        <option value="12px" ${config.border_radius === '12px' ? 'selected' : ''}>Redondeado (12px)</option>
                        <option value="16px" ${config.border_radius === '16px' ? 'selected' : ''}>Muy redondeado (16px)</option>
                        <option value="50%" ${config.border_radius === '50%' ? 'selected' : ''}>Pildora (50%)</option>
                    </select>
                </label>
                <label>Velocidad animaciones
                    <select id="cfg-anim-speed" class="config-select">
                        <option value="rapido" ${config.animation_velocidad === 'rapido' ? 'selected' : ''}>Rapido</option>
                        <option value="normal" ${config.animation_velocidad === 'normal' ? 'selected' : ''}>Normal</option>
                        <option value="lento" ${config.animation_velocidad === 'lento' ? 'selected' : ''}>Lento</option>
                    </select>
                </label>
            </div>

            <div class="config-actions">
                <button id="cfg-preview-btn" class="btn-secondary">
                    <i class="fas fa-eye"></i> Previsualizar
                </button>
                <button id="cfg-save-btn" class="btn-primary">
                    <i class="fas fa-save"></i> Guardar cambios
                </button>
                <button id="cfg-reset-btn" class="btn-text">
                    <i class="fas fa-undo"></i> Restaurar default
                </button>
            </div>
        </div>
    `;

    // Event listeners
    document.getElementById('temas-grid')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.tema-btn');
        if (!btn) return;
        const tema = TEMAS_PREDEFINIDOS[btn.dataset.tema];
        if (!tema) return;
        aplicarTema(tema);
    });

    document.getElementById('cfg-preview-btn')?.addEventListener('click', () => {
        const configActual = leerConfigForm();
        aplicarConfigVisual(configActual);
        mostrarToast('Previsualizando cambios', 'info');
    });

    document.getElementById('cfg-save-btn')?.addEventListener('click', async () => {
        const configActual = leerConfigForm();
        const btn = document.getElementById('cfg-save-btn');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...'; }
        try {
            await saveVisualConfig(configActual);
            aplicarConfigVisual(configActual);
            mostrarToast('Configuracion visual guardada', 'success');
        } catch (err) {
            mostrarToast('Error: ' + err.message, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-save"></i> Guardar cambios'; }
        }
    });

    document.getElementById('cfg-reset-btn')?.addEventListener('click', async () => {
        if (!confirm('Restaurar configuracion visual por defecto?')) return;
        const defaults = {
            primary_color: '#9d4edd',
            secondary_color: '#ff6d00',
            background_color: '#0a0a0f',
            card_color: '#1a1a2e',
            text_color: '#ffffff',
            font_family: "'Poppins', sans-serif",
            logo_url: '',
            favicon_url: '',
            border_radius: '12px',
            animation_velocidad: 'normal'
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
}

function leerConfigForm() {
    return {
        primary_color: document.getElementById('cfg-primary')?.value || '#9d4edd',
        secondary_color: document.getElementById('cfg-secondary')?.value || '#ff6d00',
        background_color: document.getElementById('cfg-bg')?.value || '#0a0a0f',
        card_color: document.getElementById('cfg-card')?.value || '#1a1a2e',
        text_color: document.getElementById('cfg-text')?.value || '#ffffff',
        font_family: document.getElementById('cfg-font')?.value || "'Poppins', sans-serif",
        logo_url: document.getElementById('cfg-logo')?.value || '',
        favicon_url: document.getElementById('cfg-favicon')?.value || '',
        border_radius: document.getElementById('cfg-radius')?.value || '12px',
        animation_velocidad: document.getElementById('cfg-anim-speed')?.value || 'normal'
    };
}

function aplicarTema(tema) {
    const inputs = {
        'cfg-primary': tema.primary_color,
        'cfg-secondary': tema.secondary_color,
        'cfg-bg': tema.background_color,
        'cfg-card': tema.card_color,
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
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(str) {
    if (!str) return '';
    return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}