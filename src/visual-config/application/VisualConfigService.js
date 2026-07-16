// visual-config/application/VisualConfigService.js
// Configuracion visual personalizada por tenant
// SOLO guarda columnas reales de tenant_config en BD
// Los campos extras (fondo, texto, bordes, etc) van a localStorage
// Compatible con VisualConfigManager legacy (script.js) - mismos keys en localStorage

import { getCurrentTenantId } from '../../shared/infrastructure/router.js';
import { getConfigByTenantId, upsertConfig } from '../../api/tenantConfigApi.js';

// ============================================================
// CONFIG DEFAULT (completo)
// NB: Los nombres de los extras DEBEN coincidir con script.js legacy
//     para que ambos sistemas compartan el mismo cache
// ============================================================
const CONFIG_DEFAULT = {
    primary_color: '#9d4edd',
    secondary_color: '#ff6d00',
    bg_color: '#0d0d0d',
    text_color: '#e0e0e0',
    card_bg: '#1a1a2e',
    border_color: '#2a2a4a',
    theme_mode: 'dark',
    font_family: "'Inter', sans-serif",
    border_radius: 12,
    animation_speed: 0.3,
    logo_url: '',
    favicon_url: '',
    cover_url: '',
    custom_css: ''
};

// Mapa de nombres modulares → legacy (para compatibilidad)
const MODULAR_TO_LEGACY = {
    background_color: 'bg_color',
    card_color: 'card_bg',
    animation_velocidad: 'animation_speed'
};

// ============================================================
// HELPERS
// ============================================================
function _extKey(tenantId) {
    return `tenant_config_ext_${tenantId}`;
}

function _cacheKey(tenantId) {
    return `tenant_config_${tenantId}`;
}

function _loadExtrasFromLS(tenantId) {
    try {
        const raw = localStorage.getItem(_extKey(tenantId));
        if (raw) return JSON.parse(raw);
    } catch (e) {}
    return {};
}

function _saveExtrasToLS(tenantId, extras) {
    localStorage.setItem(_extKey(tenantId), JSON.stringify(extras));
}

function _saveCacheToLS(tenantId, fullConfig) {
    localStorage.setItem(_cacheKey(tenantId), JSON.stringify(fullConfig));
}

function _loadCacheFromLS(tenantId) {
    try {
        const raw = localStorage.getItem(_cacheKey(tenantId));
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.primary_color) return parsed;
        }
    } catch (e) {}
    return null;
}

function _mergeWithDefaults(config) {
    const merged = {};
    for (const key of Object.keys(CONFIG_DEFAULT)) {
        const v = config[key];
        merged[key] = (v !== undefined && v !== null && v !== '') ? v : CONFIG_DEFAULT[key];
    }
    merged.border_radius = parseInt(merged.border_radius) || CONFIG_DEFAULT.border_radius;
    merged.animation_speed = parseFloat(merged.animation_speed) || CONFIG_DEFAULT.animation_speed;
    return merged;
}

/** Convierte nombres modulares a nombres legacy */
function _normalizeKeys(config) {
    const normalized = { ...config };
    for (const [modKey, legKey] of Object.entries(MODULAR_TO_LEGACY)) {
        if (normalized[modKey] !== undefined) {
            normalized[legKey] = normalized[modKey];
            delete normalized[modKey];
        }
    }
    // animation_velocidad -> animation_speed (los valores rapido/normal/lento también se convierten)
    if (config.animation_velocidad !== undefined) {
        const speedMap = { rapido: 0.15, normal: 0.3, lento: 0.5 };
        normalized.animation_speed = speedMap[config.animation_velocidad] || 0.3;
    }
    return normalized;
}

// ============================================================
// CARGAR config desde BD + localStorage
// ============================================================
export async function getVisualConfig(optionalTenantId) {
    const tenantId = optionalTenantId || await getCurrentTenantId();
    if (!tenantId) return { ...CONFIG_DEFAULT };

    try {
        // 1. Intentar desde cache completo en localStorage
        const cached = _loadCacheFromLS(tenantId);
        if (cached) return cached;

        // 2. Cargar columnas desde BD
        let dbData = null;
        try {
            dbData = await getConfigByTenantId(tenantId);
        } catch (e) {
            console.warn('[VisualConfig] Error BD, usando localStorage:', e.message);
        }

        // 3. Cargar extras desde localStorage
        const extras = _loadExtrasFromLS(tenantId);

        // 4. Merge: defaults + extras + datos BD
        let config = { ...CONFIG_DEFAULT, ...extras };
        if (dbData) {
            if (dbData.primary_color) config.primary_color = dbData.primary_color;
            if (dbData.secondary_color) config.secondary_color = dbData.secondary_color;
            config.logo_url = dbData.logo_url || '';
            config.favicon_url = dbData.favicon_url || '';
            config.cover_url = dbData.cover_url || '';
            config.custom_css = dbData.custom_css || '';
        }

        // Guardar cache completo
        _saveCacheToLS(tenantId, config);
        return config;
    } catch (e) {
        console.error('[VisualConfig] Error getVisualConfig:', e);
        return { ...CONFIG_DEFAULT };
    }
}

// ============================================================
// GUARDAR config: columnas reales a BD, extras a localStorage
// ============================================================
export async function saveVisualConfig(config) {
    const tenantId = await getCurrentTenantId();
    if (!tenantId) throw new Error('No tenant ID');

    // 1. Normalizar nombres modulares -> legacy
    const normalized = _normalizeKeys(config);
    const full = _mergeWithDefaults(normalized);

    // 2. PRIMERO guardar en localStorage (SIEMPRE funciona)
    //    Esto asegura que aunque la BD falle, los cambios persisten
    const extras = {
        bg_color: full.bg_color,
        text_color: full.text_color,
        card_bg: full.card_bg,
        border_color: full.border_color,
        theme_mode: full.theme_mode,
        font_family: full.font_family,
        border_radius: full.border_radius,
        animation_speed: full.animation_speed,
        favicon_url: full.favicon_url,
        cover_url: full.cover_url
    };
    _saveExtrasToLS(tenantId, extras);
    _saveCacheToLS(tenantId, full);

    // 3. LUEGO intentar guardar a BD (best-effort)
    let dbSuccess = false;
    const dbPayload = {
        tenant_id: String(tenantId).trim(),
        primary_color: full.primary_color,
        secondary_color: full.secondary_color,
        logo_url: full.logo_url || null,
        favicon_url: full.favicon_url || null,
        cover_url: full.cover_url || null,
        custom_css: full.custom_css || null
    };

    try {
        await upsertConfig(tenantId, dbPayload);
        dbSuccess = true;
    } catch (e) {
        // Si falla por favicon_url o cover_url (schema cache desactualizado), reintentar sin ellos
        if (e.code === 'PGRST204' && (e.message?.includes('favicon_url') || e.message?.includes('cover_url'))) {
            console.warn('[VisualConfig] Columna faltante en BD, guardando sin ella');
            const payloadSin = { ...dbPayload };
            delete payloadSin[e.message?.includes('favicon_url') ? 'favicon_url' : 'cover_url'];
            try {
                await upsertConfig(tenantId, payloadSin);
                dbSuccess = true;
            } catch (e2) {
                console.error('[VisualConfig] Error guardando a BD (sin favicon):', e2);
                throw new Error('Error al guardar en BD: ' + e2.message);
            }
        } else {
            console.error('[VisualConfig] Error guardando a BD:', e);
            throw new Error('Error al guardar en BD: ' + e.message);
        }
    }

    // 4. Log success
    console.log('[VisualConfig] Config guardada: localStorage ✅ | BD:', dbSuccess ? '✅' : '⚠️ omitida');
    return true;
}

// ============================================================
// TRANSFORMAR URL DE IMAGEN (Supabase Storage -> Render optimizado)
// Si la URL pertenece a nuestro Storage, aplica transformacion
// con parámetros de redimensionamiento. Si es externa, la deja igual.
// ============================================================
const SUPABASE_STORAGE_BASE = 'https://dfcfimipkfhitlsyixqu.supabase.co/storage/v1/object/public/service-images/';

function transformImageUrl(url, options = {}) {
    if (!url || typeof url !== 'string') return url;
    const { width, height, resize = 'contain', quality = 80, format = 'auto' } = options;
    // Detectar si es URL de nuestro Storage
    if (url.startsWith(SUPABASE_STORAGE_BASE)) {
        const filePath = url.substring(SUPABASE_STORAGE_BASE.length);
        let transformedUrl = `https://dfcfimipkfhitlsyixqu.supabase.co/storage/v1/render/image/public/service-images/${filePath}`;
        const params = [];
        if (width) params.push(`width=${width}`);
        if (height) params.push(`height=${height}`);
        if (resize) params.push(`resize=${resize}`);
        if (quality) params.push(`quality=${quality}`);
        if (format) params.push(`format=${format}`);
        if (params.length) transformedUrl += '?' + params.join('&');
        return transformedUrl;
    }
    // URL externa o de otro origen: devolver tal cual
    return url;
}

// ============================================================
// APLICAR config al DOM
// ============================================================
export function aplicarConfigVisual(config) {
    if (!config) return;

    const c = _mergeWithDefaults(_normalizeKeys(config));
    const root = document.documentElement;

    // CSS Variables
    root.style.setProperty('--primary-color', c.primary_color);
    root.style.setProperty('--primary', c.primary_color);
    root.style.setProperty('--secondary-color', c.secondary_color);
    root.style.setProperty('--secondary', c.secondary_color);
    root.style.setProperty('--bg-color', c.bg_color);
    root.style.setProperty('--bg', c.bg_color);
    root.style.setProperty('--card-bg', c.card_bg);
    root.style.setProperty('--card_bg', c.card_bg);
    root.style.setProperty('--text-color', c.text_color);
    root.style.setProperty('--text', c.text_color);
    root.style.setProperty('--border-color', c.border_color);
    root.style.setProperty('--font-family', c.font_family);
    root.style.setProperty('--border-radius', c.border_radius + 'px');
    root.style.setProperty('--anim-speed', c.animation_speed + 's');

    // --- LOGO ---
    const logoUrl = transformImageUrl(c.logo_url, { width: 400, resize: 'contain', format: 'auto' });
    if (c.logo_url && c.logo_url.trim()) {
        // Header admin/cliente: #tenant-logo
        const headerLogo = document.getElementById('tenant-logo');
        if (headerLogo) {
            headerLogo.src = logoUrl;
            headerLogo.style.display = 'inline-block';
        }
        // .tenant-logo (generic)
        document.querySelectorAll('.tenant-logo img, img.tenant-logo').forEach(img => {
            img.src = logoUrl;
            img.style.display = 'inline-block';
        });
        // .tenant-logo-bg (background-image)
        document.querySelectorAll('.tenant-logo-bg').forEach(el => {
            el.style.backgroundImage = `url('${logoUrl}')`;
            el.style.backgroundSize = 'contain';
            el.style.backgroundRepeat = 'no-repeat';
            el.style.backgroundPosition = 'center';
        });
        // .logo-img (modular fallback)
        const logoImg = document.querySelector('.logo-img');
        if (logoImg) logoImg.src = logoUrl;
        const logoImgMobile = document.querySelector('.logo-img-mobile');
        if (logoImgMobile) logoImgMobile.src = logoUrl;
    } else {
        // Ocultar logos si no hay URL
        const headerLogo = document.getElementById('tenant-logo');
        if (headerLogo) headerLogo.style.display = 'none';
        document.querySelectorAll('.tenant-logo img, img.tenant-logo').forEach(img => {
            img.style.display = 'none';
        });
        document.querySelectorAll('.tenant-logo-bg').forEach(el => {
            el.style.backgroundImage = 'none';
        });
    }

    // --- FAVICON ---
    if (c.favicon_url && c.favicon_url.trim()) {
        let link = document.querySelector('link[rel="icon"]');
        if (!link) {
            link = document.createElement('link');
            link.rel = 'icon';
            document.head.appendChild(link);
        }
        link.href = c.favicon_url;
    } else {
        const link = document.querySelector('link[rel="icon"]');
        if (link) link.remove();
    }

    // --- CUSTOM CSS ---
    const oldStyle = document.getElementById('tenant-custom-styles');
    if (oldStyle) oldStyle.remove();
    if (c.custom_css && c.custom_css.trim()) {
        const styleEl = document.createElement('style');
        styleEl.id = 'tenant-custom-styles';
        styleEl.textContent = c.custom_css;
        document.head.appendChild(styleEl);
    }

    // --- COVER BANNER ---
    const coverUrl = transformImageUrl(c.cover_url, { width: 1200, height: 400, resize: 'cover', format: 'auto' });
    const coverImg = document.getElementById('cover-banner-img');
    const coverContainer = document.getElementById('cover-banner-container');
    if (c.cover_url && c.cover_url.trim()) {
        if (coverImg) {
            coverImg.src = coverUrl;
            coverImg.style.display = 'block';
        }
        if (coverContainer) {
            coverContainer.style.display = 'block';
            coverContainer.style.backgroundImage = `url('${coverUrl}')`;
        }
        // Clase para ajustar el header cuando hay portada
        document.querySelectorAll('.profile-header').forEach(el => el.classList.add('has-cover'));
    } else {
        if (coverImg) coverImg.style.display = 'none';
        if (coverContainer) {
            coverContainer.style.display = 'none';
            coverContainer.style.backgroundImage = 'none';
        }
        document.querySelectorAll('.profile-header').forEach(el => el.classList.remove('has-cover'));
    }

    console.log('[VisualConfig] Tema aplicado:', c.primary_color, '| Logo:', c.logo_url ? '✅' : '❌', '| Cover:', c.cover_url ? '✅' : '❌');
}

// ============================================================
// CARGA + APLICA en un solo paso
// ============================================================
export async function cargarYAplicarConfig() {
    const config = await getVisualConfig();
    aplicarConfigVisual(config);
    return config;
}

// ============================================================
// TEMAS PREDEFINIDOS
// ============================================================
export const TEMAS_PREDEFINIDOS = {
    oscuro: {
        nombre: 'Oscuro por defecto',
        primary_color: '#9d4edd',
        secondary_color: '#ff6d00',
        background_color: '#0d0d0d',
        card_color: '#1a1a2e',
        text_color: '#e0e0e0'
    },
    claro: {
        nombre: 'Claro',
        primary_color: '#7b2cbf',
        secondary_color: '#e65100',
        background_color: '#f5f5f5',
        card_color: '#ffffff',
        text_color: '#1a1a2e'
    },
    naturaleza: {
        nombre: 'Naturaleza',
        primary_color: '#2d6a4f',
        secondary_color: '#d4a373',
        background_color: '#fefae0',
        card_color: '#ffffff',
        text_color: '#283618'
    },
    tech: {
        nombre: 'Tech',
        primary_color: '#00d4ff',
        secondary_color: '#ff0080',
        background_color: '#0d1117',
        card_color: '#161b22',
        text_color: '#c9d1d9'
    },
    elegante: {
        nombre: 'Elegante',
        primary_color: '#c9a84c',
        secondary_color: '#8b4513',
        background_color: '#1c1c1c',
        card_color: '#2d2d2d',
        text_color: '#f0e6d3'
    }
};
