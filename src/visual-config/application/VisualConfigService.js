// visual-config/application/VisualConfigService.js
// Configuracion visual personalizada por tenant
// Permite al admin cambiar colores, logo, tipografia, etc.

import { getSupabase } from '../../shared/infrastructure/supabase.js';
import { getCurrentTenantId } from '../../shared/infrastructure/router.js';

const CONFIG_DEFAULT = {
    primary_color: '#9d4edd',
    secondary_color: '#ff6d00',
    background_color: '#0a0a0f',
    card_color: '#1a1a2e',
    text_color: '#ffffff',
    font_family: "'Poppins', sans-serif",
    logo_url: '',
    favicon_url: '',
    border_radius: '12px',
    animation_velocidad: 'normal' // 'rapido', 'normal', 'lento'
};

export async function getVisualConfig(optionalTenantId) {
    const tenantId = optionalTenantId || await getCurrentTenantId();
    if (!tenantId) return { ...CONFIG_DEFAULT };
    try {
        const { data, error } = await getSupabase()
            .from('tenant_config')
            .select('tenant_id, primary_color, secondary_color, logo_url, custom_css')
            .eq('tenant_id', String(tenantId).trim())
            .limit(1)
            .single();
        if (error && error.code !== 'PGRST116') throw error;
        return data ? { ...CONFIG_DEFAULT, ...data, config: data.config || {} } : { ...CONFIG_DEFAULT };
    } catch (e) {
        console.error('Error getVisualConfig:', e);
        return { ...CONFIG_DEFAULT };
    }
}

export async function saveVisualConfig(config) {
    const tenantId = await getCurrentTenantId();
    if (!tenantId) throw new Error('No tenant ID');

    const data = {
        tenant_id: String(tenantId).trim(),
        primary_color: config.primary_color || CONFIG_DEFAULT.primary_color,
        secondary_color: config.secondary_color || CONFIG_DEFAULT.secondary_color,
        background_color: config.background_color || CONFIG_DEFAULT.background_color,
        card_color: config.card_color || CONFIG_DEFAULT.card_color,
        text_color: config.text_color || CONFIG_DEFAULT.text_color,
        font_family: config.font_family || CONFIG_DEFAULT.font_family,
        logo_url: config.logo_url || '',
        favicon_url: config.favicon_url || '',
        border_radius: config.border_radius || CONFIG_DEFAULT.border_radius,
        animation_velocidad: config.animation_velocidad || CONFIG_DEFAULT.animation_velocidad
    };

    const { data: result, error } = await getSupabase()
        .from('tenant_config')
        .upsert(data)
        .select()
        .single();

    if (error) throw new Error('Error al guardar config visual: ' + error.message);
    return result;
}

// --- Aplicar config al DOM ---

export function aplicarConfigVisual(config) {
    if (!config) return;

    const root = document.documentElement;
    root.style.setProperty('--primary', config.primary_color || CONFIG_DEFAULT.primary_color);
    root.style.setProperty('--secondary', config.secondary_color || CONFIG_DEFAULT.secondary_color);
    root.style.setProperty('--bg', config.background_color || CONFIG_DEFAULT.background_color);
    root.style.setProperty('--card-bg', config.card_color || CONFIG_DEFAULT.card_color);
    root.style.setProperty('--text', config.text_color || CONFIG_DEFAULT.text_color);
    root.style.setProperty('--font-family', config.font_family || CONFIG_DEFAULT.font_family);
    root.style.setProperty('--border-radius', config.border_radius || CONFIG_DEFAULT.border_radius);

    // Velocidad animacion
    const velocidades = { rapido: '0.15s', normal: '0.3s', lento: '0.5s' };
    root.style.setProperty('--anim-speed', velocidades[config.animation_velocidad] || '0.3s');

    // Logo
    if (config.logo_url) {
        const logo = document.querySelector('.logo-img');
        if (logo) logo.src = config.logo_url;
        const logoMobile = document.querySelector('.logo-img-mobile');
        if (logoMobile) logoMobile.src = config.logo_url;
    }

    // Favicon
    if (config.favicon_url) {
        let link = document.querySelector('link[rel="icon"]');
        if (!link) {
            link = document.createElement('link');
            link.rel = 'icon';
            document.head.appendChild(link);
        }
        link.href = config.favicon_url;
    }

    console.log('[VisualConfig] Tema aplicado:', config.primary_color);
}

export async function cargarYAplicarConfig() {
    const config = await getVisualConfig();
    aplicarConfigVisual(config);
    return config;
}

// --- Temas predefinidos ---

export const TEMAS_PREDEFINIDOS = {
    oscuro: {
        nombre: 'Oscuro por defecto',
        primary_color: '#9d4edd',
        secondary_color: '#ff6d00',
        background_color: '#0a0a0f',
        card_color: '#1a1a2e',
        text_color: '#ffffff'
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