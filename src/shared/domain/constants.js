// shared/domain/constants.js
// Constantes del dominio compartidas entre todos los modulos
//
// NOTA: La fuente de verdad es window.planesData (definido en script.js).
// Si script.js ya cargó, usamos su objeto para evitar duplicación.
// Si no (raro, porque script.js carga antes que los ES modules),
// usamos nuestra propia definición como fallback.

const _PLANES = (typeof window !== 'undefined' && window.planesData) ? window.planesData : {
    freemium: {
        nombre: 'Freemium',
        precio: 'Gratis',
        periodo: 'siempre',
        features: ['Hasta 10 servicios', 'Hasta 50 citas/mes', 'Soporte email'],
        color: '#00b894',
        soloSuperAdmin: true
    },
    free_trial: {
        nombre: 'Free Trial',
        precio: 'Gratis',
        periodo: '14 días',
        features: ['Acceso completo', 'Sin límites', 'Sin tarjeta', 'Soporte email'],
        color: '#00b894',
        soloNuevos: true,
        duracionDias: 14
    },
    pro: {
        nombre: 'Pro',
        precio: '$15.000',
        periodo: '/mes',
        features: ['Servicios ilimitados', 'Citas ilimitadas', 'Estadísticas avanzadas', 'Soporte prioritario'],
        color: '#b300ff',
        duracionMeses: 1
    },
    premium_anual: {
        nombre: 'Premium',
        precio: '$140.000',
        periodo: '/año',
        features: ['Todo lo de Pro', 'Personalización de diseño (admin y cliente)', 'Onboarding dedicado', 'SLA 99.9%'],
        color: '#ffd700',
        duracionMeses: 12
    }
};

export const PLANES = _PLANES;

export const COLORS = {
    primary: '#9d4edd',
    primaryDark: '#7b2cbf',
    primaryLight: '#c77dff',
    secondary: '#ff6d00',
    success: '#00b894',
    warning: '#fdcb6e',
    danger: '#e74c3c'
};
