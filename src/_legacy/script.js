// ============================================
// CONFIGURACIÓN DE SUPABASE - VERSIÓN CORREGIDA
// ============================================
// Prioridad: window.__APP_CONFIG (server.py lo inyecta) > hardcoded dev defaults
import { initDireccionAutocomplete } from '../shared/ui/direccionAutocomplete.js';
const _cfg = window.__APP_CONFIG || {
    supabaseUrl: 'https://dfcfimipkfhitlsyixqu.supabase.co',
    supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRmY2ZpbWlwa2ZoaXRsc3lpeHF1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxNzczMzAsImV4cCI6MjA4ODc1MzMzMH0.1OviTiPxYIK83bbmrYVY1nUR2o0bxn_wfqnWqK4Ccw0',
};
const supabaseUrl = _cfg.supabaseUrl;
const supabaseKey = _cfg.supabaseKey;

let supabaseClient = null;

// ========== FALLBACK para JwtManager (si los modulos ES no cargan) ==========
if (!window.JwtManager) {
    window.JwtManager = {
        getSession() {
            try {
                if (!supabaseClient) return { data: { session: null } };
                if (!supabaseClient.auth) return { data: { session: null } };
                return supabaseClient.auth.getSession();
            } catch (e) {
                console.warn('[JwtManager fallback] getSession falló:', e.message);
                return { data: { session: null } };
            }
        },
        setTokens(accessToken, refreshToken) {
            if (supabaseClient) {
                supabaseClient.auth.setSession({ 
                    access_token: accessToken, 
                    refresh_token: refreshToken 
                });
            }
        },
        getAccessToken() {
            const { data: { session } } = this.getSession();
            return session?.access_token || null;
        },
        getUserData() {
            try {
                const raw = localStorage.getItem('agendapro_user_data');
                if (raw) return JSON.parse(raw);
            } catch (e) {}
            try {
                const stored = localStorage.getItem('supabase.auth.token');
                if (stored) {
                    const parsed = JSON.parse(stored);
                    const token = parsed?.currentSession?.access_token;
                    if (token) {
                        const payload = JSON.parse(atob(token.split('.')[1]));
                        const meta = payload.user_metadata || {};
                        return {
                            id: payload.sub,
                            email: payload.email || '',
                            rol: meta.rol || 'cliente',
                            tenant_id: meta.tenant_id,
                            nombre: meta.nombre || (payload.email ? payload.email.split('@')[0] : 'Usuario'),
                            whatsapp: meta.whatsapp || ''
                        };
                    }
                }
            } catch (e) {}
            return null;
        },
        isTokenExpired() { return false; },
        clear() {},
        startAutoRefresh() {}
    };
    console.log('[script.js] JwtManager fallback creado (modulos ES no disponibles)');
}
// =====================================================================

// Inicializar Supabase reutilizando el cliente de main.js (única instancia)
async function initSupabase() {
    const timeout = 2000;
    const start = Date.now();
    while (!window.supabaseClient && (Date.now() - start) < timeout) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (window.supabaseClient) {
        supabaseClient = window.supabaseClient;
        console.log('[initSupabase] Cliente reutilizado correctamente después de espera');
        return true;
    }
    // Fallback: crear cliente propio si main.js no se ejecutó (ej. client.html sin main.js)
    try {
        if (window.supabase) {
            supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey);
            window.supabaseClient = supabaseClient;
            console.log('[initSupabase] Cliente creado como fallback (main.js no disponible)');
            return true;
        }
    } catch (e) {
        console.error('[initSupabase] Error creando cliente fallback:', e);
    }
    console.error('[initSupabase] No se pudo obtener/crear supabaseClient');
    return false;
}

// Inicializar inmediatamente (espera hasta 2s a que main.js asigne window.supabaseClient)
(async () => { await initSupabase(); })();

// Función para obtener el tenant_id actual - VERSIÓN CORREGIDA
async function getCurrentTenantId() {
    // Fallback rápido: si ya tenemos currentTenantId, usarlo
    if (window.currentTenantId) return window.currentTenantId;

    try {
        if (!supabaseClient) {
            console.error('Supabase no inicializado');
            return null;
        }
        const result = JwtManager.getSession();
        const session = result?.data?.session || null;
        if (!session) return null;
        
        const tenantId = session.user?.user_metadata?.tenant_id;
        
        // IMPORTANTE: Verificar que sea un UUID válido
        if (tenantId) {
            // Si es string, asegurar formato UUID
            if (typeof tenantId === 'string') {
                // Limpiar el string (quitar espacios, etc)
                const cleanTenantId = tenantId.trim();
                
                // Verificar formato UUID
                const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                if (uuidRegex.test(cleanTenantId)) {
                    window.currentTenantId = cleanTenantId;
                    return cleanTenantId;
                } else {
                    console.error('❌ tenant_id no tiene formato UUID válido:', cleanTenantId);
                    return null;
                }
            }
            window.currentTenantId = tenantId;
            return tenantId;
        }
        return null;
    } catch (e) {
        console.error('Error getCurrentTenantId:', e);
        // Último fallback
        if (window.currentTenantId) return window.currentTenantId;
        return null;
    }
}

// Agrega después de getCurrentTenantId()
async function verificarPermisosAdmin() {
    try {
        const session = await getSession();
        if (!session) return false;
        
        console.log('Verificando permisos admin:', session);
        
        // Verificar si puede insertar en servicios
        const { data, error } = await supabaseClient
            .from('servicios')
            .insert({
                tenant_id: session.tenant_id,
                nombre: 'test-permissions',
                categoria: 'test',
                precio: 0,
                disponibilidad: {}
            })
            .select();
            
        if (error) {
            console.error('Error de permisos:', error);
            mostrarToast('Error de permisos en Supabase: ' + error.message, 'error');
            return false;
        } else {
            // Limpiar el registro de prueba
            await window.__serviciosApi.delete(data[0].id);
            console.log('✅ Permisos correctos');
            return true;
        }
    } catch (e) {
        console.error('Error verificando permisos:', e);
        return false;
    }
}

async function cargarSuscripcionTenant() {
    const container = document.getElementById('tenant-subscription-info');
    if (!container) return;
    try {
        const suscripcion = await SuscripcionManager.getCurrent();
        if (!suscripcion) {
            container.innerHTML = '<div class="glass-panel" style="padding:15px;"><i class="fas fa-exclamation-triangle"></i> No hay suscripción activa. Contacta al administrador.</div>';
            return;
        }
        document.getElementById('sub-plan-display').textContent = suscripcion.plan.toUpperCase();
        const start = new Date(suscripcion.start_date).toLocaleDateString();
        const end = suscripcion.end_date ? new Date(suscripcion.end_date).toLocaleDateString() : 'Indefinido';
        document.getElementById('sub-dates-display').textContent = `${start} → ${end}`;
        const statusSpan = document.getElementById('sub-status-display');
        statusSpan.textContent = suscripcion.status.toUpperCase();
        statusSpan.className = `status-badge ${suscripcion.status}`;
    } catch (e) {
        console.error('Error cargando suscripción:', e);
        container.innerHTML = '<div class="glass-panel" style="padding:15px;"><i class="fas fa-exclamation-triangle"></i> Error al cargar suscripción.</div>';
    }
}

// Función para crear usuarios de prueba
async function crearUsuariosPrueba() {
    try {
        if (!supabaseClient) {
            console.error('Supabase no inicializado');
            return;
        }
        
        console.log('Creando usuarios de prueba...');
        
        // Primero, verificar si ya existe un tenant
        let { data: tenants } = await supabaseClient
            .from('tenants')
            .select('id')
            .eq('email_contacto', 'demo@agendapro.com')
            .limit(1);
            
        let tenantId = tenants?.[0]?.id;
        
        if (!tenantId) {
            // Crear tenant si no existe
            const { data: newTenant, error: createError } = await supabaseClient
                .from('tenants')
                .insert({ 
                    nombre_negocio: 'Demo Business',
                    email_contacto: 'demo@agendapro.com',
                    plan: 'freemium'
                })
                .select()
                .single();
            
            if (createError) {
                console.error('Error creando tenant:', createError);
                return;
            }
            
            tenantId = newTenant.id;
            console.log('Tenant creado:', tenantId);
        }
        
        // Crear admin
        const { error: adminError } = await supabaseClient.auth.signUp({
            email: 'admin@demo.com',
            password: 'demo123',
            options: {
                data: {
                    nombre: 'Administrador',
                    rol: 'admin',
                    tenant_id: tenantId
                }
            }
        });
        
        if (adminError) {
            console.log('Admin ya existe o error:', adminError.message);
        } else {
            console.log('✅ Admin creado');
        }
        
        // Crear cliente
        const { error: clienteError } = await supabaseClient.auth.signUp({
            email: 'cliente@demo.com',
            password: 'demo123',
            options: {
                data: {
                    nombre: 'Cliente Demo',
                    rol: 'cliente',
                    tenant_id: tenantId
                }
            }
        });
        
        if (clienteError) {
            console.log('Cliente ya existe o error:', clienteError.message);
        } else {
            console.log('✅ Cliente creado');
        }
        
        console.log('✅ Proceso de usuarios de prueba completado');
    } catch (e) {
        console.log('Error en creación de usuarios:', e);
    }
}


// Llamar a crear usuarios después de un pequeño delay
// setTimeout(crearUsuariosPrueba, 1000);

// Llamarla después de crear usuarios
// setTimeout(() => {
//     verificarUsuarios();
// }, 2000);


// ============================================
// VARIABLES GLOBALES (originales, sin cambios)
// ============================================
let currentDate = new Date();
let selectedDates = new Set();
let popupEl = null;

// Estado para reprogramación
let esReprogramacion = false;
let reprogramInfo = { citaId: null, serviceId: null, citaActual: null };
let idCitaEnEdicion = null;

// Módulos de horario (admin)
window.serviceModules = [];
window.moduleDateCupos = {};
// Almacena módulos específicos por día de la semana
// Filtros (cliente)
let currentFilterTerm = '';
let currentFilterDate = '';
let currentFilterCategory = 'todos';

// ============================================
// UTILIDADES DE FORMATO (originales, sin cambios)
// ============================================
function limpiarHora(h) {
    if (!h) return '';
    let str = String(h).trim();
    const m = str.match(/(\d{1,2}):(\d{2})(?:\s*(AM|PM))?/i);
    if (!m) return str;
    let hrs = parseInt(m[1], 10);
    const mins = m[2];
    const mer = m[3];
    if (mer) {
        if (mer.toUpperCase() === 'PM' && hrs !== 12) hrs += 12;
        if (mer.toUpperCase() === 'AM' && hrs === 12) hrs = 0;
    }
    return `${String(hrs).padStart(2, '0')}:${mins}`;
}
function normalizarHora(timeStr) {
    return limpiarHora(timeStr);
}

// Generador de IDs únicos para módulos (cliente-side, sin crypto API)
let _moduleIdCounter = 0;
function generateModuleId() {
    return 'mod_' + (++_moduleIdCounter) + '_' + Date.now();
}
window.generateModuleId = generateModuleId;

function formatTimeDisplay(time24) {
    if (!time24) return '';
    const [hour, minute] = time24.split(':');
    const h = parseInt(hour, 10) || 0;
    const m = String(minute || '').padStart(2, '0');
    const hh = String(h).padStart(2, '0');
    return `${hh}:${m}`;
}

function formatDate(date) {
    const utcDate = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const year = utcDate.getUTCFullYear();
    const month = String(utcDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(utcDate.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function parseDate(dateStr) {
    const parts = dateStr.split('-');
    if (parts.length !== 3) return new Date(dateStr);
    return new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 12));
}

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatearDinero(numero) {
    try {
        if (numero == null || numero === '') return '$0';
        const n = Number(numero);
        if (isNaN(n)) return String(numero);
        return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(Math.round(n));
    } catch (e) {
        return '$' + Number(numero).toFixed(0);
    }
}
const formatearPeso = formatearDinero;
// Expuestos a window: el modal de detalle (verDetalleServicio) los espera con
// guards typeof y sin ellos muestra precios sin separador y fechas crudas.
window.formatearPeso = formatearPeso;
window.formatTimeDisplay = formatTimeDisplay;
window.formatFechaCorta = formatFechaCorta;

// Ajusta el font-size de una estadística para que la cifra completa quepa en
// una línea: mide el desbordamiento real y reduce el tamaño según la cantidad
// de dígitos (usado en Ventas del Mes / Este Mes del dashboard admin).
function ajustarTamanoStat(el, minRem) {
    if (!el || !el.textContent) return;
    const minPx = (minRem || 0.85) * 16;
    el.style.setProperty('font-size', '', 'important'); // reset inline previo
    el.style.whiteSpace = 'nowrap';
    let px = parseFloat(getComputedStyle(el).fontSize);
    if (!px || isNaN(px) || px <= 0) px = 28;
    el.style.setProperty('font-size', px + 'px', 'important');
    let guard = 0;
    while (el.scrollWidth > el.clientWidth + 1 && px > minPx && guard < 40) {
        px -= 1;
        el.style.setProperty('font-size', px + 'px', 'important');
        guard++;
    }
}

// Re-aplica el ajuste al redimensionar/rotar para que la cifra siga completa
let resizeStatTimer = null;
window.addEventListener('resize', function () {
    clearTimeout(resizeStatTimer);
    resizeStatTimer = setTimeout(function () {
        ['valor-diario', 'valor-semanal', 'valor-mensual', 'statVentas'].forEach(function (id) {
            ajustarTamanoStat(document.getElementById(id));
        });
    }, 150);
});

function formatFechaCorta(dateStr) {
    try {
        const date = parseDate(dateStr);
        return date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
    } catch (e) {
        return dateStr;
    }
}

function formatFechaConDiaSemana(dateStr) {
    try {
        const date = parseDate(dateStr);
        const dd = String(date.getUTCDate()).padStart(2, '0');
        const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
        const yyyy = date.getUTCFullYear();
        const diaSemana = date.toLocaleDateString('es-ES', { weekday: 'long', timeZone: 'UTC' });
        return `${dd}-${mm}-${yyyy} ${diaSemana}`;
    } catch (e) {
        return dateStr;
    }
}

// ============================================
// GESTIÓN DE CITAS - VERSIÓN CORREGIDA (SIN servicio_nombre)
// ============================================
const CitasManager = {
    async getAll(optionalTenantId = null) {
        try {
            // Usar API unificada si main.js la expuso
            if (window.__appointmentsApi) {
                let tenantId = optionalTenantId;
                if (!tenantId) tenantId = await getCurrentTenantId();
                if (!tenantId) return [];
                const data = await window.__appointmentsApi.getAllCitas(tenantId);
                return (data || []).map(c => ({
                    id: c.id,
                    servicioId: c.servicio_id,
                    nombre: 'Servicio',
                    fecha: c.fecha,
                    hora: c.hora,
                    precio: c.precio,
                    contacto: c.contacto || {},
                    notificaciones: c.notificaciones || { emailEnviado: false, whatsappEnviado: false },
                    creadoEn: c.created_at,
                    estado_pago: c.estado_pago
                }));
            }
            // Fallback legacy
            let tenantId = optionalTenantId;
            if (!tenantId) {
                tenantId = await getCurrentTenantId();
            }
            if (!tenantId) {
                console.log('No hay tenant_id, devolviendo array vacío');
                return [];
            }

            console.log('Buscando citas para tenant:', tenantId);

            const cleanTenantId = String(tenantId).trim();

            const { data, error } = await supabaseClient
                .from('citas')
                .select('id, servicio_id, fecha, hora, precio, contacto, notificaciones, created_at, estado_pago')
                .eq('tenant_id', cleanTenantId)
                .order('created_at', { ascending: false });

            if (error) {
                console.error('Error en getAll citas:', error);
                return [];
            }

            console.log(`✅ Encontradas ${data?.length || 0} citas`);

            return (data || []).map(c => ({
                id: c.id,
                servicioId: c.servicio_id,
                nombre: 'Servicio',
                fecha: c.fecha,
                hora: c.hora,
                precio: c.precio,
                contacto: c.contacto || {},
                notificaciones: c.notificaciones || { emailEnviado: false, whatsappEnviado: false },
                creadoEn: c.created_at,
                estado_pago: c.estado_pago
            }));
        } catch (e) {
            console.error('Error en getAll citas:', e);
            return [];
        }
    },
    
    async save(citas) {
        console.warn('save() no implementado directamente en Supabase, usar upsert');
    },
    
    async upsert(cita, optionalTenantId = null) {
        // Usar API unificada si main.js la expuso
        if (window.__appointmentsApi) {
            try {
                const tenantId = optionalTenantId || await getCurrentTenantId();
                if (!tenantId) throw new Error('No tenant ID');
                const citaData = {
                    id: cita.id,
                    tenant_id: String(tenantId).trim(),
                    servicio_id: cita.servicioId,
                    fecha: cita.fecha,
                    hora: cita.hora,
                    precio: cita.precio,
                    contacto: cita.contacto || {},
                    notificaciones: cita.notificaciones || { emailEnviado: false, whatsappEnviado: false }
                };
                await window.__appointmentsApi.upsertCita(citaData);
                return true;
            } catch (e) {
                console.error('Error en upsert cita:', e);
                return false;
            }
        }
        // Fallback legacy
        try {
            const tenantId = optionalTenantId || await getCurrentTenantId();
            if (!tenantId) throw new Error('No tenant ID');
            
            console.log('Guardando cita para tenant:', tenantId);
            
            // Asegurar que tenant_id es string limpio
            const cleanTenantId = String(tenantId).trim();
            
            // IMPORTANTE: SOLO las columnas que existen en la tabla
            const citaData = {
                id: cita.id,
                tenant_id: cleanTenantId,
                servicio_id: cita.servicioId,      // Esta columna SÍ existe
                // servicio_nombre: cita.nombre,   // <-- ESTA COLUMNA NO EXISTE - COMENTADA
                fecha: cita.fecha,
                hora: cita.hora,
                precio: cita.precio,
                contacto: cita.contacto || {},
                notificaciones: cita.notificaciones || { emailEnviado: false, whatsappEnviado: false }
            };
            
            console.log('Datos a guardar:', citaData);
            
            const { error } = await supabaseClient
                .from('citas')
                .upsert(citaData);
                
            if (error) {
                console.error('Error en upsert cita:', error);
                return false;
            }
            
            console.log('✅ Cita guardada:', cita.id);
            return true;
        } catch (e) {
            console.error('Error en upsert cita:', e);
            return false;
        }
    },
    
    async delete(citaId) {
        // Usar API unificada si main.js la expuso
        if (window.__appointmentsApi) {
            try {
                await window.__appointmentsApi.deleteCita(citaId);
                return true;
            } catch (e) {
                console.error('Error eliminando cita:', e);
                return false;
            }
        }
        // Fallback legacy
        try {
            const { error } = await supabaseClient
                .from('citas')
                .delete()
                .eq('id', citaId);
                
            if (error) throw error;
            return true;
        } catch (e) {
            console.error('Error eliminando cita:', e);
            return false;
        }
    },
    
    async limpiar(opciones = {}) {
        return false;
    },
    
    async sanear() {
        return;
    },
    
    async limpiarExpiradas() {
        // Usar API unificada si main.js la expuso
        if (window.__appointmentsApi) {
            try {
                const tenantId = await getCurrentTenantId();
                if (!tenantId) return 0;
                return await window.__appointmentsApi.limpiarCitasExpiradas(tenantId);
            } catch (e) {
                console.error('Error limpiando expiradas:', e);
                return 0;
            }
        }
        // Fallback legacy
        try {
            const tenantId = await getCurrentTenantId();
            if (!tenantId) return 0;
            
            const cleanTenantId = String(tenantId).trim();
            const hoy = new Date().toISOString().split('T')[0];
            
            const { data, error } = await supabaseClient
                .from('citas')
                .delete()
                .eq('tenant_id', cleanTenantId)
                .lt('fecha', hoy)
                .select('id');
                
            if (error) throw error;
            return data?.length || 0;
        } catch (e) {
            console.error('Error limpiando expiradas:', e);
            return 0;
        }
    },
    
    async finalizar(citaId) {
        return this.delete(citaId);
    }
};

// ============================================
// CONFIGURAR LIMPIEZA AUTOMÁTICA
// ============================================
function configurarLimpiezaAutomatica() {
    // La limpieza de citas expiradas es tarea del admin con sesión. En el flujo
    // anónimo (cliente externo, /p/:slug) el RLS deniega el DELETE y solo genera
    // errores 42501/401 en consola — mismo guard que usa NotificacionesAdminManager.
    const accessToken = localStorage.getItem('agendapro_access_token');
    if (!accessToken) return;

    setInterval(async () => {
        const eliminadas = await CitasManager.limpiarExpiradas();
        
        if (eliminadas > 0) {
            if (typeof renderAdminAppointments === 'function') renderAdminAppointments();
            if (typeof renderMisReservas === 'function') renderMisReservas();
            if (typeof renderCarrito === 'function') renderCarrito();
            if (typeof updateProjectedRevenue === 'function') updateProjectedRevenue();
        }
    }, 10 * 60 * 1000);
    
    setTimeout(async () => {
        await CitasManager.limpiarExpiradas();
    }, 1000);
}

// ============================================
// GESTIÓN DE VENTAS (modificado para Supabase)
// ============================================
const VentasManager = {
    _cachedVentas: null,
    _cacheTime: 0,
    _CACHE_TTL: 60000, // 1 minuto
    _LOCAL_KEY: 'agendapro_ventas',

    _getVentasLocales() {
        try {
            const data = localStorage.getItem(this._LOCAL_KEY);
            return data ? JSON.parse(data) : [];
        } catch { return []; }
    },

    guardarVentaLocal(venta) {
        try {
            const ventas = this._getVentasLocales();
            ventas.push(venta);
            localStorage.setItem(this._LOCAL_KEY, JSON.stringify(ventas));
            this.invalidateCache();
        } catch (e) {
            console.warn('Error guardando venta local:', e);
        }
    },

    async getAll(forceRefresh = false) {
        try {
            // Cache en memoria (valido 1 minuto)
            const ahora = Date.now();
            if (!forceRefresh && this._cachedVentas && (ahora - this._cacheTime) < this._CACHE_TTL) {
                return this._cachedVentas;
            }

            const tenantId = await getCurrentTenantId();
            if (!tenantId) return [];

            // Citas vigentes (misma fuente de siempre)
            const { data, error } = await supabaseClient
                .from('citas')
                .select('id, servicio_id, precio, contacto, created_at, fecha, hora')
                .eq('tenant_id', String(tenantId).trim())
                .order('created_at', { ascending: false });

            if (error) {
                console.error('Error en VentasManager.getAll:', error);
                return [];
            }

            // Histórico archivado: la limpieza borra las citas con fecha
            // pasada, pero el trigger trg_archivar_venta las conserva en
            // `ventas` para que el dashboard no pierda el acumulado.
            // Las "No Asistió" se conservan en la tabla pero NO cuentan
            // como ingreso (resultado <> 'no_asistio').
            const { data: archivadas, error: errArchivadas } = await supabaseClient
                .from('ventas')
                .select('cita_id, servicio_id, precio, contacto, fecha, hora, fecha_venta')
                .eq('tenant_id', String(tenantId).trim())
                .neq('resultado', 'no_asistio')
                .order('fecha_venta', { ascending: false });

            if (errArchivadas) {
                console.warn('No se pudieron leer ventas archivadas:', errArchivadas);
            }

            // Obtener nombres reales de servicios (para Top Servicios legible)
            let nombresServicios = {};
            try {
                const { data: serviciosData, error: serviciosError } = await supabaseClient
                    .from('servicios')
                    .select('id, nombre')
                    .eq('tenant_id', String(tenantId).trim());
                if (!serviciosError) {
                    (serviciosData || []).forEach(s => { nombresServicios[s.id] = s.nombre; });
                }
            } catch (e) {
                console.warn('No se pudieron obtener nombres de servicios:', e);
            }

            // Mapeo único para citas vigentes y ventas archivadas
            const mapearVenta = (c, citaId) => {
                const fechaVenta = c.fecha_venta || c.created_at;
                const createdDate = new Date(fechaVenta);
                return {
                    id: `VENTA-${citaId}`,
                    citaId: citaId,
                    servicioId: c.servicio_id,
                    servicioNombre: nombresServicios[c.servicio_id] || 'Servicio',
                    clienteNombre: c.contacto?.nombre || 'Cliente',
                    clienteEmail: c.contacto?.email || '',
                    clienteTelefono: c.contacto?.telefono || '',
                    fecha: c.fecha,
                    hora: c.hora,
                    monto: Number(c.precio) || 0,
                    fechaVenta: fechaVenta,
                    mes: createdDate.getMonth() + 1,
                    año: createdDate.getFullYear(),
                    diaSemana: createdDate.getDay()
                };
            };

            const ventas = [
                ...(data || []).map(c => mapearVenta(c, c.id)),
                ...(archivadas || []).map(v => mapearVenta(v, v.cita_id))
            ];

            this._cachedVentas = ventas;
            this._cacheTime = ahora;
            return ventas;
        } catch (e) {
            console.error('Error en getAll ventas:', e);
            return [];
        }
    },

    invalidateCache() {
        this._cachedVentas = null;
        this._cacheTime = 0;
    },
    
    async registrarDesdeCita(cita) {
        // En Supabase, las ventas se derivan de citas, no guardamos duplicado
        const venta = {
            id: 'VENTA-' + Date.now(),
            citaId: cita.id,
            servicioId: cita.servicioId,
            servicioNombre: cita.nombre || 'Servicio',
            clienteNombre: cita.contacto?.nombre || 'Cliente',
            clienteEmail: cita.contacto?.email || '',
            clienteTelefono: cita.contacto?.telefono || '',
            fecha: cita.fecha,
            hora: cita.hora,
            monto: Number(cita.precio) || 0,
            fechaVenta: new Date().toISOString(),
            mes: new Date().getMonth() + 1,
            año: new Date().getFullYear(),
            diaSemana: new Date().getDay()
        };
        return venta;
    },
    
    async getPorRango(fechaInicio, fechaFin) {
        const ventas = await this.getAll();
        const inicio = new Date(fechaInicio).getTime();
        const fin = new Date(fechaFin).getTime();
        
        return ventas.filter(v => {
            const fechaVenta = new Date(v.fechaVenta).getTime();
            return fechaVenta >= inicio && fechaVenta <= fin;
        });
    },
    
    async getHoy() {
        const hoy = new Date();
        hoy.setHours(0, 0, 0, 0);
        const mañana = new Date(hoy);
        mañana.setDate(mañana.getDate() + 1);
        
        return this.getPorRango(hoy.toISOString(), mañana.toISOString());
    },
    
    async getSemana() {
        const hoy = new Date();
        const inicioSemana = new Date(hoy);
        inicioSemana.setDate(hoy.getDate() - hoy.getDay() + (hoy.getDay() === 0 ? -6 : 1));
        inicioSemana.setHours(0, 0, 0, 0);
        
        const finSemana = new Date(inicioSemana);
        finSemana.setDate(inicioSemana.getDate() + 7);
        
        return this.getPorRango(inicioSemana.toISOString(), finSemana.toISOString());
    },
    
    async getMes() {
        const hoy = new Date();
        const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
        const finMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 1);
        
        return this.getPorRango(inicioMes.toISOString(), finMes.toISOString());
    },
    
    calcularTotal(ventas) {
        return ventas.reduce((sum, v) => sum + (v.monto || 0), 0);
    },
    
    async getTopServicios(limite = 5) {
        const ventas = await this.getAll();
        const conteo = {};
        
        ventas.forEach(v => {
            const id = v.servicioId;
            if (!conteo[id]) {
                conteo[id] = {
                    id: id,
                    nombre: v.servicioNombre,
                    cantidad: 0,
                    total: 0
                };
            }
            conteo[id].cantidad++;
            conteo[id].total += v.monto;
        });
        
        return Object.values(conteo)
            .sort((a, b) => b.cantidad - a.cantidad)
            .slice(0, limite);
    }
};

window.VentasManager = VentasManager;

// ============================================
// SISTEMA DE URGENCIAS VISUAL (sin cambios)
// ============================================
const UrgenciaManager = {
    calcularEstado(fecha, hora) {
        if (!fecha) return 'normal';
        
        try {
            const ahora = new Date();
            
            let citaDate;
            const partes = String(fecha).split('-');
            if (partes.length === 3) {
                citaDate = new Date(partes[0], partes[1] - 1, partes[2]);
            } else {
                citaDate = new Date(fecha);
            }
            
            if (hora) {
                const horaParts = String(hora).match(/(\d{1,2}):(\d{2})/);
                if (horaParts) {
                    citaDate.setHours(parseInt(horaParts[1]), parseInt(horaParts[2]), 0, 0);
                }
            } else {
                citaDate.setHours(12, 0, 0, 0);
            }
            
            if (isNaN(citaDate.getTime())) {
                return 'normal';
            }
            
            const diferenciaMs = citaDate - ahora;
            const diferenciaHoras = diferenciaMs / (1000 * 60 * 60);
            
            if (diferenciaMs < 0) {
                return 'expirado';
            } else if (diferenciaHoras < 2) {
                return 'urgent-now';
            } else if (diferenciaHoras <= 24) {
                return 'urgent-soon';
            } else {
                return 'normal';
            }
        } catch (e) {
            console.warn('Error calculando urgencia:', e);
            return 'normal';
        }
    },
    
    async filtrarServiciosConFuturo(servicios) {
        if (!Array.isArray(servicios)) return [];
        
        const ahora = new Date();
        
        return servicios.filter(servicio => {
            if (!servicio.disponibilidad || typeof servicio.disponibilidad !== 'object') {
                return false;
            }
            
            const fechas = Object.keys(servicio.disponibilidad).filter(f => {
                const partes = f.split('-');
                if (partes.length !== 3) return false;
                
                const fechaServicio = new Date(partes[0], partes[1] - 1, partes[2], 12, 0, 0);
                
                if (fechaServicio < ahora.setHours(0, 0, 0, 0)) {
                    return false;
                }
                
                const modulos = servicio.disponibilidad[f] || [];
                return modulos.some(m => {
                    if (Number(m.cupos || 0) <= 0) return false;
                    
                    if (fechaServicio.toDateString() === new Date().toDateString()) {
                        const hora = m.hora || m.startTime || '00:00';
                        const horaParts = hora.match(/(\d{1,2}):(\d{2})/);
                        if (!horaParts) return true;
                        
                        const fechaHora = new Date();
                        fechaHora.setHours(parseInt(horaParts[1]), parseInt(horaParts[2]), 0, 0);
                        
                        return fechaHora > new Date();
                    }
                    
                    return true;
                });
            });
            
            return fechas.length > 0;
        });
    },
    
    async limpiarServiciosExpirados() {
        // En Supabase esto se maneja con triggers o consultas
        return 0;
    },
    
    aplicarClaseUrgencia(elemento, fecha, hora) {
        if (!elemento) return;
        
        elemento.classList.remove('urgent-soon', 'urgent-now', 'expirado');
        
        const estado = this.calcularEstado(fecha, hora);
        
        if (estado === 'urgent-soon' || estado === 'urgent-now') {
            elemento.classList.add(estado);
        } else if (estado === 'expirado') {
            elemento.classList.add('expirado');
        }
    }
};

window.UrgenciaManager = UrgenciaManager;

// ============================================
// HELPER: Pantalla de expiración de suscripción
// ============================================
/**
 * Muestra la pantalla de bloqueo cuando la suscripción ha expirado.
 * @param {Object} suscripcion - La suscripción (activa pero vencida o inactive)
 * @param {Date} fin - Fecha de fin de la suscripción
 */
function mostrarPantallaExpiracion(suscripcion, fin) {
    // Flag global para que el DOMContentLoaded sepa que el admin está bloqueado
    window._subscriptionExpired = true;
    const adminContent = document.querySelector('.admin-screen') || document.querySelector('.glass-panel');
    if (adminContent) {
        const planNombre = suscripcion.plan === 'pro' ? 'Pro'
            : suscripcion.plan === 'premium_anual' ? 'Premium'
            : suscripcion.plan === 'free_trial' ? 'Free Trial'
            : suscripcion.plan || 'contratado';
        adminContent.innerHTML = `
            <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:60vh; text-align:center; padding:40px;">
                <i class="fas fa-exclamation-triangle" style="font-size:5rem; color:#ffc107; margin-bottom:20px;"></i>
                <h2 style="color:white; margin-bottom:10px;">Tu suscripción ha expirado</h2>
                <p style="color:#b0b0b0; font-size:1.1rem; max-width:500px; margin-bottom:10px;">
                    El plan <strong>${planNombre}</strong> finalizó el ${fin.toLocaleDateString()}.
                </p>
                <p style="color:#ff6b6b; font-size:1rem; max-width:500px; margin-bottom:25px;">
                    <i class="fas fa-ban"></i> No podrás crear ni editar servicios hasta que renueves tu plan.
                </p>
                <p style="color:#b0b0b0; font-size:0.95rem; max-width:500px; margin-bottom:25px;">
                    Elige <strong>Pro ($15.000/mes)</strong> o <strong>Premium ($140.000/año)</strong> para reactivar tu negocio.
                </p>
                <a href="planes.html" class="btn-grad" style="padding:14px 40px; font-size:1.1rem; text-decoration:none;">
                    <i class="fas fa-credit-card"></i> Ver planes disponibles
                </a>
            </div>
        `;
    }
    // Ocultar navegación del admin
    const sidebar = document.querySelector('.admin-sidebar, .sidebar');
    if (sidebar) sidebar.style.display = 'none';
}

// ============================================
// HELPER: Verificar suscripción activa antes de crear/editar servicios
// ============================================
/**
 * Verifica que el tenant actual tenga una suscripción activa y no vencida.
 * @returns {Promise<{valida: boolean, mensaje: string}>}
 */
async function verificarSuscripcionActiva() {
    try {
        const suscripcion = await SuscripcionManager.getCurrent();
        if (!suscripcion) {
            return { valida: false, mensaje: 'Tu suscripción ha expirado. Para crear o editar servicios, debes elegir un plan en la sección de planes.' };
        }
        if (suscripcion.end_date) {
            const ahora = new Date();
            const fin = new Date(suscripcion.end_date);
            if (fin < ahora) {
                return { valida: false, mensaje: 'Tu suscripción expiró el ' + fin.toLocaleDateString() + '. Para seguir usando el sistema, renueva tu plan en la sección de planes.' };
            }
        }
        return { valida: true, mensaje: '' };
    } catch (e) {
        console.error('Error verificando suscripción:', e);
        return { valida: false, mensaje: 'Error al verificar tu suscripción. Intenta recargar la página.' };
    }
}

// ============================================
// GESTIÓN DE SERVICIOS - VERSIÓN CORREGIDA
// ============================================
const ServiciosManager = {
    async getAll(optionalTenantId = null) {
        try {
            let tenantId = optionalTenantId;
            if (!tenantId) {
                tenantId = await getCurrentTenantId();
            }
            if (!tenantId) return [];

            console.log('Buscando servicios para tenant:', tenantId);
            const cleanTenantId = String(tenantId).trim();

            const { data, error } = await supabaseClient
                .from('servicios')
                .select('id, nombre, categoria, precio, duracion, descripcion, imagen, destacado, activo, disponibilidad, fechas, created_at, assignment_mode, weekday_modules, date_specific_modules, module_date_cupos, tipo_venta, precio_individual, num_sesiones, precio_promocion')
                .eq('tenant_id', cleanTenantId)
                .order('created_at', { ascending: false });

            if (error) {
                console.error('Error en getAll servicios:', error);
                return [];
            }

            console.log(`✅ Encontrados ${data?.length || 0} servicios`);

            return (data || []).map(s => ({
                id: s.id,
                nombre: s.nombre,
                categoria: s.categoria,
                precio: s.precio,
                duracion: s.duracion || 60,
                descripcion: s.descripcion || '',
                imagen: s.imagen || 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874',
                destacado: s.destacado || false,
                activo: s.activo !== false,
                disponibilidad: s.disponibilidad || {},
                fechas: s.fechas || Object.keys(s.disponibilidad || {}),
                fechaCreacion: s.created_at,
                // Campos de modo de asignación avanzada
                assignment_mode: s.assignment_mode || 'all',
                weekday_modules: s.weekday_modules || {},
                date_specific_modules: s.date_specific_modules || {},
                module_date_cupos: s.module_date_cupos || {},
                // Tipo de venta: por sesión / por promoción
                tipo_venta: s.tipo_venta || 'sesion',
                precio_individual: (typeof s.precio_individual !== 'undefined' && s.precio_individual !== null) ? s.precio_individual : s.precio,
                num_sesiones: s.num_sesiones ?? null,
                precio_promocion: s.precio_promocion ?? null
            }));
        } catch (e) {
            console.error('Error en getAll servicios:', e);
            return [];
        }
    },
    
    async save(servicio) {
        try {
            // Verificar suscripción activa antes de permitir guardar
            const subCheck = await verificarSuscripcionActiva();
            if (!subCheck.valida) {
                mostrarToast('❌ ' + subCheck.mensaje, 'error');
                // Redirigir a planes después de 3 segundos
                setTimeout(() => {
                    window.location.href = 'planes.html';
                }, 3000);
                throw new Error(subCheck.mensaje);
            }

            const tenantId = await getCurrentTenantId(); // <-- NOMBRE CORRECTO
            if (!tenantId) throw new Error('No tenant ID');
            
            console.log('Guardando servicio para tenant:', tenantId);
            
            const cleanTenantId = String(tenantId).trim();
            
            const servicioData = {
                tenant_id: cleanTenantId,
                nombre: servicio.nombre,
                categoria: servicio.categoria,
                precio: servicio.precio,
                descripcion: servicio.descripcion || '',
                imagen: servicio.imagen,
                destacado: servicio.destacado || false,
                activo: servicio.activo !== false,
                duracion: typeof servicio.duracion !== 'undefined' ? servicio.duracion : 60,
                disponibilidad: servicio.disponibilidad || {},
                fechas: Object.keys(servicio.disponibilidad || {}),
                // Campos de modo de asignación avanzada
                assignment_mode: servicio.assignment_mode || 'all',
                weekday_modules: servicio.weekday_modules || {},
                date_specific_modules: servicio.date_specific_modules || {},
                module_date_cupos: servicio.module_date_cupos || {},
                // Tipo de venta: por sesión / por promoción
                tipo_venta: servicio.tipo_venta || 'sesion',
                precio_individual: (typeof servicio.precio_individual !== 'undefined' ? servicio.precio_individual : servicio.precio) ?? null,
                num_sesiones: servicio.num_sesiones ?? null,
                precio_promocion: servicio.precio_promocion ?? null
            };
            
            let result;
            if (servicio.id) {
                result = await supabaseClient
                    .from('servicios')
                    .update(servicioData)
                    .eq('id', servicio.id)
                    .select();
            } else {
                result = await supabaseClient
                    .from('servicios')
                    .insert(servicioData)
                    .select();
            }
            
            if (result.error) throw result.error;
            
            console.log('✅ Servicio guardado:', result.data?.[0]?.id);
            
            // Guardar asignación de trabajadores (si existe la función)
            const savedId = result.data?.[0]?.id;
            if (savedId && window.__guardarWorkersDelServicio) {
                try {
                    await window.__guardarWorkersDelServicio(savedId);
                } catch (e) {
                    console.warn('Error guardando trabajadores del servicio:', e);
                }
            }
            
            return result.data?.[0] || null;
        } catch (e) {
            console.error('Error guardando servicio:', e);
            throw e;
        }
    },
    
    async delete(id) {
        try {
            const { error } = await supabaseClient
                .from('servicios')
                .delete()
                .eq('id', id);
                
            if (error) throw error;
            return true;
        } catch (e) {
            console.error('Error eliminando servicio:', e);
            return false;
        }
    },
    
    async toggleActivo(id, activo) {
        try {
            const { error } = await supabaseClient
                .from('servicios')
                .update({ activo })
                .eq('id', id);
                
            if (error) throw error;
            return true;
        } catch (e) {
            console.error('Error toggling activo:', e);
            return false;
        }
    }
};

window.ServiciosManager = ServiciosManager;

// ============================================
// NOTIFICACIONES DE CAMBIOS ADMIN - VERSIÓN CORREGIDA
// ============================================
const NotificacionesAdminManager = {
    async getAll() {
        try {
            const tenantId = await getCurrentTenantId(); // <-- NOMBRE CORRECTO
            if (!tenantId) return [];
            
            const cleanTenantId = String(tenantId).trim();
            
            const { data, error } = await supabaseClient
                .from('notificaciones_admin')
                .select('id, tipo, cita_id, fecha_original, hora_original, fecha_nueva, hora_nueva, cliente, leido, creado_en, metadata')
                .eq('tenant_id', cleanTenantId)
                .order('creado_en', { ascending: false });
                
            if (error) throw error;
            
            return (data || []).map(n => ({
                id: n.id,
                tipo: n.tipo,
                citaId: n.cita_id,
                fechaOriginal: n.fecha_original,
                horaOriginal: n.hora_original,
                fechaNueva: n.fecha_nueva,
                horaNueva: n.hora_nueva,
                cliente: n.cliente,
                metadata: n.metadata || {},
                leido: n.leido || false,
                creadoEn: n.creado_en
            }));
        } catch (e) {
            console.error('Error en getAll notificaciones admin:', e);
            return [];
        }
    },
    
    async save(notificaciones) {
        console.warn('save() no implementado directamente');
    },
    
    async marcarComoLeido(id) {
        try {
            const { error } = await supabaseClient
                .from('notificaciones_admin')
                .update({ leido: true })
                .eq('id', id);
                
            if (error) throw error;
            return true;
        } catch (e) {
            console.error('Error marcando como leído:', e);
            return false;
        }
    },

    async eliminar(id) {
        try {
            const { error } = await supabaseClient
                .from('notificaciones_admin')
                .delete()
                .eq('id', id);

            if (error) throw error;
            return true;
        } catch (e) {
            console.error('Error eliminando notificación:', e);
            return false;
        }
    },
    
    async eliminarViejos(dias = 7) {
        try {
            const fechaLimite = new Date();
            fechaLimite.setDate(fechaLimite.getDate() - dias);
            
            const { error } = await supabaseClient
                .from('notificaciones_admin')
                .delete()
                .lt('creado_en', fechaLimite.toISOString());
                
            if (error) throw error;
            return true;
        } catch (e) {
            console.error('Error eliminando viejos:', e);
            return false;
        }
    }
};

window.NotificacionesAdminManager = NotificacionesAdminManager;

const SuscripcionManager = {
    /**
     * Obtiene la suscripción activa más reciente del tenant actual
     * @returns {Promise<Object|null>}
     */
    async getCurrent() {
        try {
            const tenantId = await getCurrentTenantId();
            if (!tenantId) return null;
            const { data, error } = await supabaseClient
                .from('subscriptions')
                .select('id, tenant_id, plan, status, start_date, end_date, stripe_session_id, created_at')
                .eq('tenant_id', tenantId)
                .eq('status', 'active')
                .order('start_date', { ascending: false })
                .limit(1);
            if (error) throw error;
            if (data?.[0]) return data[0];
            // No encontró suscripción activa → refrescar sesión por si hay datos nuevos
            console.log('SuscripcionManager.getCurrent: sin suscripción activa, refrescando sesión...');
            const { data: sessionData } = JwtManager.getSession();
            if (sessionData?.session) {
                // Reintentar después de refrescar
                const { data: retry, error: retryError } = await supabaseClient
                    .from('subscriptions')
                    .select('id, tenant_id, plan, status, start_date, end_date, stripe_session_id, created_at')
                    .eq('tenant_id', tenantId)
                    .eq('status', 'active')
                    .order('start_date', { ascending: false })
                    .limit(1);
                if (retryError) throw retryError;
                if (retry?.[0]) return retry[0];
            }
            return null;
        } catch (e) {
            console.error('SuscripcionManager.getCurrent error:', e);
            return null;
        }
    },

    /**
     * Obtiene todas las suscripciones de un tenant (histórico)
     * @param {string} tenantId - UUID del tenant
     * @returns {Promise<Array>}
     */
    async getAllForTenant(tenantId) {
        try {
            const { data, error } = await supabaseClient
                .from('subscriptions')
                .select('id, tenant_id, plan, status, start_date, end_date, stripe_session_id, created_at')
                .eq('tenant_id', tenantId)
                .order('start_date', { ascending: false });
            if (error) throw error;
            return data || [];
        } catch (e) {
            console.error('SuscripcionManager.getAllForTenant error:', e);
            return [];
        }
    },

    /**
     * Crea una nueva suscripción
     * @param {Object} data - { tenant_id, plan, status, start_date, end_date?, stripe_session_id? }
     * @returns {Promise<Object|null>} La suscripción creada o null si error
     */
    async create(data) {
    try {
        // Validar tenant_id
        if (!data.tenant_id) {
            console.error('SuscripcionManager.create: tenant_id es requerido');
            mostrarToast('Error: no se pudo identificar el negocio', 'error');
            return null;
        }
        // Validar status permitido
        const status = data.status || 'active';
        if (!['active', 'inactive', 'trial'].includes(status)) {
            console.error('SuscripcionManager.create: status inválido:', status);
            mostrarToast('Error: estado de suscripción inválido', 'error');
            return null;
        }
        // Calcular end_date si no viene explícito y el plan tiene duración
        let endDate = data.end_date;
        if (!endDate && data.plan) {
            if (planesData[data.plan]?.duracionMeses) {
                const duracionMeses = planesData[data.plan].duracionMeses;
                const calculatedEnd = new Date();
                calculatedEnd.setMonth(calculatedEnd.getMonth() + duracionMeses);
                endDate = calculatedEnd.toISOString();
            } else if (planesData[data.plan]?.duracionDias) {
                const duracionDias = planesData[data.plan].duracionDias;
                endDate = new Date(Date.now() + duracionDias * 24 * 60 * 60 * 1000).toISOString();
            }
        }
        const newData = { ...data, end_date: endDate, status };
        // UPSERT: si ya existe una suscripción activa para este tenant, la actualiza
        // Esto evita duplicados y garantiza que siempre haya una sola activa
        const { data: existing, error: lookupError } = await supabaseClient
            .from('subscriptions')
            .select('id')
            .eq('tenant_id', data.tenant_id)
            .eq('status', 'active')
            .limit(1);
        if (lookupError) throw lookupError;
        if (existing && existing.length > 0) {
            // Actualizar la suscripción existente
            const { data: updatedSub, error: updateError } = await supabaseClient
                .from('subscriptions')
                .update(newData)
                .eq('id', existing[0].id)
                .select()
                .single();
            if (updateError) throw updateError;
            return updatedSub;
        }
        // No existe: insertar nueva
        const { data: newSub, error } = await supabaseClient
            .from('subscriptions')
            .insert(newData)
            .select()
            .single();
        if (error) throw error;
        return newSub;
    } catch (e) {
        console.error('SuscripcionManager.create error:', e);
        mostrarToast('Error al crear suscripción: ' + e.message, 'error');
        return null;
    }
},

    /**
     * Actualiza una suscripción existente
     * @param {string} id - UUID de la suscripción
     * @param {Object} updates - Campos a modificar
     * @returns {Promise<boolean>}
     */
    async update(id, updates) {
        try {
            const { error } = await supabaseClient
                .from('subscriptions')
                .update(updates)
                .eq('id', id);
            if (error) throw error;
            return true;
        } catch (e) {
            console.error('SuscripcionManager.update error:', e);
            mostrarToast('Error al actualizar suscripción', 'error');
            return false;
        }
    },

    /**
     * Cancela una suscripción (cambia estado a 'inactive')
     * @param {string} id 
     * @returns {Promise<boolean>}
     */
    async cancel(id) {
        return this.update(id, { status: 'inactive' });
    },

    /**
     * Renueva una suscripción creando un nuevo registro con estado 'active'
     * @param {string} oldSubscriptionId - ID de la suscripción anterior (se dejará como 'inactive')
     * @param {Object} renewalData - { tenant_id, plan, start_date, end_date?, stripe_session_id? }
     * @returns {Promise<Object|null>} Nueva suscripción
     */
    async renew(oldSubscriptionId, renewalData) {
        try {
            // Primero desactivar la anterior
            await this.update(oldSubscriptionId, { status: 'inactive' });
            // Crear la nueva
            const newSub = await this.create({
                ...renewalData,
                status: 'active'
            });
            return newSub;
        } catch (e) {
            console.error('SuscripcionManager.renew error:', e);
            mostrarToast('Error al renovar suscripción', 'error');
            return null;
        }
    }
};
window.SuscripcionManager = SuscripcionManager;

// ============================================
// GESTIÓN DE CONFIGURACIÓN VISUAL POR TENANT
// ============================================
const VisualConfigManager = {
    // Temas predefinidos
    TEMAS: [
        {
            id: 'clasico',
            name: 'Clásico',
            config: {
                primary_color: '#9d4edd', secondary_color: '#ff6d00',
                bg_color: '#0d0d0d', text_color: '#e0e0e0',
                card_bg: '#1a1a2e', border_color: '#2a2a4a',
                theme_mode: 'dark', font_family: "'Inter', sans-serif",
                border_radius: 12, animation_speed: 0.3
            }
        },
        {
            id: 'oscuro',
            name: 'Oscuro',
            config: {
               primary_color: '#00b894', secondary_color: '#00cec9',
                bg_color: '#000000', text_color: '#dfe6e9',
                card_bg: '#111111', border_color: '#2d2d2d',
                theme_mode: 'dark', font_family: "'Inter', sans-serif",
                border_radius: 8, animation_speed: 0.2
            }
        },
        {
            id: 'minimalista',
            name: 'Minimalista',
            config: {
                primary_color: '#0984e3', secondary_color: '#74b9ff',
                bg_color: '#0a0a0f', text_color: '#f5f5f5',
                card_bg: '#141420', border_color: '#2a2a3a',
                theme_mode: 'dark', font_family: "'Inter', sans-serif",
                border_radius: 4, animation_speed: 0.15
            }
        },
        {
            id: 'naturaleza',
            name: 'Naturaleza',
            config: {
                primary_color: '#27ae60', secondary_color: '#2ecc71',
                bg_color: '#0a120a', text_color: '#e8f5e9',
                card_bg: '#0f1a0f', border_color: '#1e3a1e',
                theme_mode: 'dark', font_family: "'Inter', sans-serif",
                border_radius: 16, animation_speed: 0.35
            }
        },
        {
            id: 'atardecer',
            name: 'Atardecer',
            config: {
                primary_color: '#e17055', secondary_color: '#fdcb6e',
                bg_color: '#1a0f0a', text_color: '#fce4d6',
                card_bg: '#25150d', border_color: '#4a2a1a',
                theme_mode: 'dark', font_family: "'Inter', sans-serif",
                border_radius: 10, animation_speed: 0.25
            }
        },
        {
            id: 'claro',
            name: 'Claro',
            config: {
                primary_color: '#6c5ce7', secondary_color: '#a29bfe',
                bg_color: '#f8f9fa', text_color: '#2d3436',
                card_bg: '#ffffff', border_color: '#dfe6e9',
                theme_mode: 'light', font_family: "'Inter', sans-serif",
                border_radius: 12, animation_speed: 0.3
            }
        }
    ],

    FONTS: [
        "'Inter', sans-serif",
        "'Poppins', sans-serif",
        "'Roboto', sans-serif",
        "'Open Sans', sans-serif",
        "'Montserrat', sans-serif",
        "'Nunito', sans-serif",
        "'Playfair Display', serif",
        "'Merriweather', serif",
        "'JetBrains Mono', monospace"
    ],

    /**
     * Retorna la configuración por defecto completa
     */
    getDefaultConfig() {
        return {
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
            instagram_url: '',
            tiktok_url: '',
            ubicacion_tipo: '',
            direccion: '',
            custom_css: ''
        };
    },

    /** Obtener key de localStorage para tenant */
    _cacheKey(tenantId) {
        return `tenant_config_${tenantId}`;
    },

    /** Obtener key de localStorage para campos extendidos */
    _extKey(tenantId) {
        return `tenant_config_ext_${tenantId}`;
    },

    /**
     * Carga configuración completa: columnas BD + campos extendidos desde localStorage
     */
    async loadConfig() {
        try {
            const tenantId = await getCurrentTenantId();
            if (!tenantId) return this.getDefaultConfig();

            const def = this.getDefaultConfig();

            // 1. Cargar desde localStorage (caché completo)
            const fullCache = localStorage.getItem(this._cacheKey(tenantId));
            if (fullCache) {
                try {
                    const parsed = JSON.parse(fullCache);
                    if (parsed && parsed.primary_color) return this._mergeWithDefaults(parsed);
                } catch (e) {}
            }

            // 2. Cargar columnas desde BD
            let dbData = null;
            let dbError = null;
            try {
                const res = await supabaseClient
                    .from('tenant_config')
                    .select('primary_color, secondary_color, logo_url, favicon_url, cover_url, instagram_url, tiktok_url, ubicacion_tipo, direccion, custom_css')
                    .eq('tenant_id', tenantId)
                    .maybeSingle();
                dbData = res.data;
                dbError = res.error;
                // Si falla por columna faltante (PGRST204), reintentar sin las nuevas
                if (dbError && dbError.code === 'PGRST204') {
                    console.warn('[VisualConfig] columnas nuevas no existen en BD, cargando sin ellas');
                    const retry = await supabaseClient
                        .from('tenant_config')
                        .select('primary_color, secondary_color, logo_url, favicon_url, cover_url, custom_css')
                        .eq('tenant_id', tenantId)
                        .maybeSingle();
                    dbData = retry.data;
                    dbError = retry.error;
                }
            } catch (e) {
                dbError = e;
            }
            if (dbError && dbError.code !== 'PGRST116') {
                // PGRST116 = no rows, no es error
                console.warn('[VisualConfig] Error BD, usando localStorage:', dbError.message);
                dbData = null;
            }

            // 3. Cargar campos extendidos desde localStorage
            let extras = {};
            try {
                const extRaw = localStorage.getItem(this._extKey(tenantId));
                if (extRaw) extras = JSON.parse(extRaw);
            } catch (e) {}

            let config = { ...def, ...extras };
            if (dbData) {
                config.primary_color = dbData.primary_color || def.primary_color;
                config.secondary_color = dbData.secondary_color || def.secondary_color;
                config.logo_url = dbData.logo_url || '';
                config.favicon_url = dbData.favicon_url || '';
                config.cover_url = dbData.cover_url || '';
                config.instagram_url = dbData.instagram_url || '';
                config.tiktok_url = dbData.tiktok_url || '';
                config.ubicacion_tipo = dbData.ubicacion_tipo || '';
                config.direccion = dbData.direccion || '';
                config.custom_css = dbData.custom_css || '';
            }

            // Guardar en caché completa
            localStorage.setItem(this._cacheKey(tenantId), JSON.stringify(config));
            return config;
        } catch (e) {
            console.error('Error cargando configuración visual:', e);
            return this.getDefaultConfig();
        }
    },

    /**
     * Guarda configuración: columnas BD + campos extendidos en localStorage
     */
    async saveConfig(config) {
        try {
            const suscripcion = await SuscripcionManager.getCurrent();
            if (!suscripcion || (suscripcion.plan !== 'pro' && suscripcion.plan !== 'premium_anual' && suscripcion.plan !== 'freemium')) {
                mostrarToast('No tienes permisos para personalizar. Actualiza a un plan de pago.', 'error');
                return false;
            }

            const tenantId = await getCurrentTenantId();
            if (!tenantId) throw new Error('No tenant ID');

            const full = this._mergeWithDefaults(config);

            // Columnas que siempre existen en tenant_config
            const CORE = {
                tenant_id: tenantId,
                primary_color: full.primary_color,
                secondary_color: full.secondary_color,
                logo_url: full.logo_url || null,
                custom_css: full.custom_css || null
            };
            const OPTIONAL = {
                favicon_url: full.favicon_url || null,
                cover_url: full.cover_url || null,
                instagram_url: full.instagram_url || null,
                tiktok_url: full.tiktok_url || null,
                ubicacion_tipo: full.ubicacion_tipo || null,
                direccion: full.direccion || null
            };

            // Intentar con todas las columnas
            const dbPayload = { ...CORE, ...OPTIONAL };
            let { error } = await supabaseClient
                .from('tenant_config')
                .upsert(dbPayload, { onConflict: 'tenant_id' });
            // Si falla por columnas opcionales, reintentar solo con core
            if (error && error.code === 'PGRST204') {
                console.warn('[VisualConfig] Columnas opcionales no existen en BD, guardando solo columnas base (saveConfig)');
                const retry = await supabaseClient
                    .from('tenant_config')
                    .upsert(CORE, { onConflict: 'tenant_id' });
                error = retry.error;
            }
            if (error) throw error;

            // Guardar campos extendidos en localStorage
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
            localStorage.setItem(this._extKey(tenantId), JSON.stringify(extras));

            // Guardar caché completa
            localStorage.setItem(this._cacheKey(tenantId), JSON.stringify(full));

            // Aplicar estilos inmediatamente
            this.applyStyles(full);
            return true;
        } catch (e) {
            console.error('Error guardando configuración visual:', e);
            return false;
        }
    },

    /**
     * Aplica estilos completos al documento
     */
    applyStyles(config) {
        const c = this._mergeWithDefaults(config);

        // Remover bloque anterior
        const oldStyle = document.getElementById('tenant-custom-styles');
        if (oldStyle) oldStyle.remove();

        const styleEl = document.createElement('style');
        styleEl.id = 'tenant-custom-styles';

        const primaryGlow = c.primary_color + '80';
        const isDark = c.theme_mode === 'dark';

        let css = `
:root {
    --primary-color: ${c.primary_color};
    --secondary-color: ${c.secondary_color};
    --primary-glow: ${primaryGlow};
    --bg-color: ${c.bg_color};
    --text-color: ${c.text_color};
    --card-bg: ${c.card_bg};
    --border-color: ${c.border_color};
    --border-radius: ${c.border_radius}px;
    --transition-speed: ${c.animation_speed}s;
    font-family: ${c.font_family};
}

/* Tema */
body, .admin-screen, .client-screen {
    background: ${c.bg_color} !important;
    color: ${c.text_color} !important;
}
.glass-panel {
    background: ${c.card_bg}e6 !important;
    border-color: ${c.border_color} !important;
}
.glass-panel:hover {
    border-color: ${primaryGlow} !important;
}
.admin-header, .client-header {
    background: ${c.card_bg} !important;
    border-bottom-color: ${c.border_color} !important;
}

/* Botones */
.btn-grad {
    background: linear-gradient(90deg, ${c.primary_color}, ${c.secondary_color}) !important;
}
.btn-grad:hover {
    background: linear-gradient(90deg, ${c.secondary_color}, ${c.primary_color}) !important;
}

/* Stats */
.stat-box::before {
    background: linear-gradient(to bottom, ${c.primary_color}, ${c.secondary_color});
}

/* Calendar */
.calendar-day.selected {
    background: ${c.primary_color} !important;
}

/* Service cards */
.service-card-category.belleza,
.service-card-category.bienestar,
.service-card-category.salud {
    border-color: ${c.primary_color} !important;
    color: ${c.primary_color} !important;
}

/* Border radius */
.glass-panel, .btn-grad, .btn-secondary, btn-small,
.admin-panel, .stat-box, .sidebar-nav, .sidebar-item,
input, select, textarea, .tema-card, .notification-item,
.nav-card, .modal-content, .popup-inner {
    border-radius: ${c.border_radius}px !important;
}

/* Transitions */
* {
    transition-duration: ${c.animation_speed}s !important;
}

/* Modo claro */
${!isDark ? `
.glass-panel { backdrop-filter: none !important; }
input, select, textarea {
    background: rgba(0,0,0,0.04) !important;
    color: #2d3436 !important;
    border-color: #dfe6e9 !important;
}
.form-section { border-bottom-color: rgba(0,0,0,0.06) !important; }
` : ''}
`;
        if (c.custom_css && c.custom_css.trim()) {
            css += `\n/* Custom CSS */\n${c.custom_css}`;
        }

        styleEl.textContent = css;
        document.head.appendChild(styleEl);

        // Aplicar logo, favicon y cover
        this.updateLogo(c.logo_url);
        this.updateFavicon(c.favicon_url);
        this.updateCover(c.cover_url);
    },

    /** Aplica cambios en tiempo real (preview sin guardar) */
    applyPreview(config) {
        this.applyStyles(config);
    },

    /** Actualiza el logo en DOM (reparado: también busca #tenant-logo) */
    updateLogo(logoUrl) {
        // Clase .tenant-logo
        const logoImages = document.querySelectorAll('.tenant-logo img, img.tenant-logo');
        logoImages.forEach(img => {
            if (logoUrl && logoUrl.trim()) {
                img.src = logoUrl;
                img.style.display = 'inline-block';
            } else {
                img.style.display = 'none';
            }
        });

        // ID #tenant-logo (el del admin header)
        const headerLogo = document.getElementById('tenant-logo');
        if (headerLogo) {
            if (logoUrl && logoUrl.trim()) {
                headerLogo.src = logoUrl;
                headerLogo.style.display = 'inline-block';
            } else {
                headerLogo.style.display = 'none';
            }
        }

        // Background-image
        document.querySelectorAll('.tenant-logo-bg').forEach(el => {
            if (logoUrl && logoUrl.trim()) {
                el.style.backgroundImage = `url('${logoUrl}')`;
                el.style.backgroundSize = 'contain';
                el.style.backgroundRepeat = 'no-repeat';
                el.style.backgroundPosition = 'center';
            } else {
                el.style.backgroundImage = 'none';
            }
        });
    },

    /** Actualiza el favicon */
    updateFavicon(faviconUrl) {
        let link = document.querySelector('link[rel="icon"]');
        if (faviconUrl && faviconUrl.trim()) {
            if (!link) {
                link = document.createElement('link');
                link.rel = 'icon';
                document.head.appendChild(link);
            }
            link.href = faviconUrl;
        } else {
            if (link) link.remove();
        }
    },

    /** Actualiza la imagen de portada/cover */
    updateCover(coverUrl) {
        const coverImg = document.getElementById('cover-banner-img');
        const coverContainer = document.getElementById('cover-banner-container');
        if (coverUrl && coverUrl.trim()) {
            if (coverImg) {
                coverImg.src = coverUrl;
                coverImg.style.display = 'block';
            }
            if (coverContainer) {
                coverContainer.style.display = 'block';
                coverContainer.style.backgroundImage = `url('${coverUrl}')`;
            }
            document.querySelectorAll('.profile-header').forEach(el => el.classList.add('has-cover'));
        } else {
            if (coverImg) coverImg.style.display = 'none';
            if (coverContainer) {
                coverContainer.style.display = 'none';
                coverContainer.style.backgroundImage = 'none';
            }
            document.querySelectorAll('.profile-header').forEach(el => el.classList.remove('has-cover'));
        }
    },

    /** Renderiza los temas predefinidos en el grid — cada card es un espejo del tema */
    renderThemePresets() {
        const grid = document.getElementById('temas-grid');
        if (!grid) return;
        grid.innerHTML = '';
        this.TEMAS.forEach(tema => {
            const card = document.createElement('div');
            card.className = 'tema-card';
            card.dataset.temaId = tema.id;
            const cfg = tema.config;
            // Extraer colores para los puntitos
            const dots = Object.values(cfg).filter(v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)).slice(0, 5);
            const dotsHtml = dots.map(c => `<span style="background:${c}"></span>`).join('');
            // Render: la card usa bg_color como fondo y text_color para el texto de muestra
            card.innerHTML = `
                <div class="tema-check"><i class="fas fa-check-circle"></i></div>
                <div class="tema-preview" style="background:${cfg.bg_color}; color:${cfg.text_color}; border-color:${cfg.border_color};">
                    <div class="tema-preview-header" style="background:${cfg.card_bg}; border-bottom-color:${cfg.border_color};">
                        <span class="tema-preview-dot" style="background:${cfg.primary_color};"></span>
                        <span class="tema-pseudo-text" style="background:${cfg.text_color}40;"></span>
                    </div>
                    <div class="tema-preview-body">
                        <div class="tema-pseudo-line" style="background:${cfg.text_color}30;"></div>
                        <div class="tema-pseudo-line short" style="background:${cfg.text_color}20;"></div>
                        <div class="tema-preview-btn" style="background:${cfg.primary_color}; color:${cfg.text_color};">
                            ${tema.name}
                        </div>
                    </div>
                </div>
                <div class="tema-colors">${dotsHtml}</div>
                <div class="tema-meta">Botones · Tarjetas · Fondo · Textos</div>
            `;
            card.addEventListener('click', () => this.applyTheme(tema.id));
            grid.appendChild(card);
        });
    },

    /** Aplica un tema por ID */
    applyTheme(temaId) {
        const tema = this.TEMAS.find(t => t.id === temaId);
        if (!tema) return;
        this.applyConfigToForm(tema.config);
        this.applyPreview(tema.config);

        // Marcar card activa
        document.querySelectorAll('.tema-card').forEach(c => c.classList.remove('active'));
        const card = document.querySelector(`.tema-card[data-tema-id="${temaId}"]`);
        if (card) card.classList.add('active');
    },

    /** Inicializa el selector de fuentes — dropdown visual con preview real */
    initFontSelector() {
        const sel = document.getElementById('cfg-font');
        const dropdown = document.getElementById('font-select-dropdown');
        const trigger = document.getElementById('font-select-trigger');
        const valueEl = document.getElementById('font-select-value');
        if (!sel || !dropdown) return;

        // Poblar <select> oculto (para que gatherFormConfig() siga funcionando)
        sel.innerHTML = '';
        this.FONTS.forEach(f => {
            const opt = document.createElement('option');
            opt.value = f;
            opt.textContent = f.replace(/['"]/g, '').split(',')[0];
            opt.style.fontFamily = f;
            sel.appendChild(opt);
        });

        // Construir items del dropdown visual
        dropdown.innerHTML = '';
        this.FONTS.forEach(f => {
            const name = f.replace(/['"]/g, '').split(',')[0];
            const item = document.createElement('div');
            item.className = 'font-select-item';
            item.dataset.value = f;
            item.style.fontFamily = f;
            item.textContent = name;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                // Actualizar select oculto
                sel.value = f;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                // Actualizar trigger
                valueEl.textContent = name;
                valueEl.style.fontFamily = f;
                // Cerrar dropdown
                dropdown.classList.remove('open');
                trigger.classList.remove('open');
            });
            dropdown.appendChild(item);
        });

        // Abrir/cerrar dropdown
        if (trigger) {
            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOpen = dropdown.classList.contains('open');
                // Cerrar todos los demás dropdowns abiertos
                document.querySelectorAll('.font-select-dropdown.open').forEach(d => d.classList.remove('open'));
                document.querySelectorAll('.font-select-trigger.open').forEach(t => t.classList.remove('open'));
                if (!isOpen) {
                    dropdown.classList.add('open');
                    trigger.classList.add('open');
                }
            });
        }

        // Cerrar al hacer clic fuera
        document.addEventListener('click', () => {
            dropdown.classList.remove('open');
            trigger.classList.remove('open');
        });

        // Sincronizar trigger con el valor inicial del select
        if (sel.value && valueEl) {
            const name = sel.options[sel.selectedIndex]?.textContent || sel.value.replace(/['"]/g, '').split(',')[0];
            valueEl.textContent = name;
            valueEl.style.fontFamily = sel.value;
        }
    },

    /** Recolecta la configuración actual del formulario */
    gatherFormConfig() {
        const g = id => {
            const el = document.getElementById(id);
            return el ? el.value : null;
        };
        const parseFloatSafe = (id, def) => {
            const el = document.getElementById(id);
            return el ? parseFloat(el.value) || def : def;
        };
        return this._mergeWithDefaults({
            primary_color: g('cfg-primary'),
            secondary_color: g('cfg-secondary'),
            bg_color: g('cfg-bg'),
            text_color: g('cfg-text'),
            card_bg: g('cfg-card'),
            border_color: g('cfg-border'),
            theme_mode: g('cfg-theme-mode'),
            font_family: g('cfg-font'),
            border_radius: parseFloatSafe('cfg-radius', 12),
            animation_speed: parseFloatSafe('cfg-anim-speed', 0.3),
            logo_url: g('cfg-logo'),
            favicon_url: g('cfg-favicon'),
            custom_css: g('custom-css')
        });
    },

    /** Rellena el formulario con una configuración */
    applyConfigToForm(config) {
        const s = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.value = val;
        };
        const c = this._mergeWithDefaults(config);
        s('cfg-primary', c.primary_color);
        s('cfg-secondary', c.secondary_color);
        s('cfg-bg', c.bg_color);
        s('cfg-text', c.text_color);
        s('cfg-card', c.card_bg);
        s('cfg-border', c.border_color);
        s('cfg-theme-mode', c.theme_mode);
        s('cfg-font', c.font_family);
        // Sincronizar trigger visual del dropdown de fuentes
        const valEl = document.getElementById('font-select-value');
        if (valEl) {
            const name = c.font_family.replace(/['"]/g, '').split(',')[0];
            valEl.textContent = name;
            valEl.style.fontFamily = c.font_family;
        }

        const r = document.getElementById('cfg-radius');
        if (r) { r.value = c.border_radius; this._updateRangeLabel('cfg-radius', 'cfg-radius-value', 'px');
            // Sincronizar preview border-radius
            const box = document.getElementById('radius-demo-box');
            if (box) box.style.borderRadius = c.border_radius + 'px';
            const txt = document.getElementById('radius-preview-text');
            if (txt) txt.textContent = c.border_radius + 'px';
        }

        const a = document.getElementById('cfg-anim-speed');
        if (a) { a.value = c.animation_speed; this._updateRangeLabel('cfg-anim-speed', 'cfg-anim-speed-value', 's');
            // Sincronizar preview velocidad
            const ball = document.getElementById('speed-demo-box');
            if (ball) ball.style.animationDuration = (c.animation_speed * 0.8 + 0.2) + 's';
            const stxt = document.getElementById('speed-preview-text');
            if (stxt) stxt.textContent = c.animation_speed + 's';
        }

        s('cfg-logo', c.logo_url || '');
        s('cfg-favicon', c.favicon_url || '');
        s('custom-css', c.custom_css || '');

        // Mostrar preview del logo si hay URL guardada
        const logoPreview = document.getElementById('logo-preview');
        const logoPreviewImg = document.getElementById('logo-preview-img');
        if (logoPreview && logoPreviewImg) {
            if (c.logo_url && c.logo_url.trim()) {
                logoPreviewImg.src = c.logo_url;
                logoPreview.style.display = 'block';
            } else {
                logoPreview.style.display = 'none';
            }
        }

        // Mostrar preview del favicon si hay URL guardada
        const favPreview = document.getElementById('favicon-preview');
        const favPreviewImg = document.getElementById('favicon-preview-img');
        if (favPreview && favPreviewImg) {
            if (c.favicon_url && c.favicon_url.trim()) {
                favPreviewImg.src = c.favicon_url;
                favPreview.style.display = 'block';
            } else {
                favPreview.style.display = 'none';
            }
        }

        // Marcar tema activo si coincide
        this._highlightMatchingTheme(c);

        // Actualizar badge
        this._updateRangeLabel('cfg-radius', 'cfg-radius-value', 'px');
        this._updateRangeLabel('cfg-anim-speed', 'cfg-anim-speed-value', 's');
    },

    /** Marca la card del tema que coincide, si hay match */
    _highlightMatchingTheme(config) {
        document.querySelectorAll('.tema-card').forEach(c => c.classList.remove('active'));
        for (const tema of this.TEMAS) {
            const tc = tema.config;
            const match = Object.keys(tc).every(k => {
                const v = config[k];
                return v !== undefined && String(v) === String(tc[k]);
            });
            if (match) {
                const card = document.querySelector(`.tema-card[data-tema-id="${tema.id}"]`);
                if (card) card.classList.add('active');
                return;
            }
        }
    },

    /** Actualiza el label de un range slider */
    _updateRangeLabel(rangeId, labelId, suffix) {
        const range = document.getElementById(rangeId);
        const label = document.getElementById(labelId);
        if (range && label) {
            label.textContent = parseFloat(range.value) + suffix;
        }
    },

    /** Conecta listeners en tiempo real a todos los controles del formulario */
    connectLivePreview() {
        const onChange = () => {
            this.applyPreview(this.gatherFormConfig());
        };
        const onChangeWithThemeClear = () => {
            document.querySelectorAll('.tema-card').forEach(c => c.classList.remove('active'));
            onChange();
        };

        // Color pickers
        ['cfg-primary', 'cfg-secondary', 'cfg-bg', 'cfg-text', 'cfg-card', 'cfg-border'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', onChangeWithThemeClear);
        });

        // Selects
        ['cfg-font', 'cfg-theme-mode'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', onChangeWithThemeClear);
        });

        // Range sliders
        const onRange = (id, labelId, suffix) => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('input', () => {
                    const val = parseFloat(el.value);
                    const label = document.getElementById(labelId);
                    if (label) label.textContent = val + suffix;
                    // Sincronizar preview contextual
                    if (id === 'cfg-radius') {
                        const box = document.getElementById('radius-demo-box');
                        if (box) box.style.borderRadius = val + 'px';
                        const txt = document.getElementById('radius-preview-text');
                        if (txt) txt.textContent = val + 'px';
                    }
                    if (id === 'cfg-anim-speed') {
                        const ball = document.getElementById('speed-demo-box');
                        if (ball) {
                            ball.style.animationDuration = (val * 0.8 + 0.2) + 's';
                        }
                        const txt = document.getElementById('speed-preview-text');
                        if (txt) txt.textContent = val + 's';
                    }
                    onChangeWithThemeClear();
                });
            }
        };
        onRange('cfg-radius', 'cfg-radius-value', 'px');
        onRange('cfg-anim-speed', 'cfg-anim-speed-value', 's');

        // Logo / favicon
        const onInput = (id, fn) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', fn);
        };
        onInput('cfg-logo', () => {
            const url = document.getElementById('cfg-logo').value;
            this.updateLogo(url);
            // Mostrar preview del logo
            const preview = document.getElementById('logo-preview');
            const previewImg = document.getElementById('logo-preview-img');
            if (preview && previewImg) {
                if (url && url.trim()) {
                    previewImg.src = url;
                    preview.style.display = 'block';
                } else {
                    preview.style.display = 'none';
                }
            }
        });
        // File upload para logo
        const logoFileInput = document.getElementById('cfg-logo-file');
        if (logoFileInput) {
            logoFileInput.addEventListener('change', async function() {
                const file = this.files[0];
                if (!file) return;
                // Validar tipo
                if (!file.type.startsWith('image/')) {
                    mostrarMensaje('❌ Solo se permiten archivos de imagen.', 'error');
                    return;
                }
                if (file.size > 5 * 1024 * 1024) {
                    mostrarMensaje('❌ La imagen es muy grande. Máximo 5MB.', 'error');
                    return;
                }
                // Mostrar progreso
                const bar = document.getElementById('logo-upload-progress');
                const fill = document.getElementById('logo-upload-fill');
                const text = document.getElementById('logo-upload-text');
                if (bar) bar.style.display = 'flex';
                if (fill) fill.style.width = '20%';
                if (text) text.textContent = 'Optimizando...';
                try {
                    const imagenOptimizada = await optimizarImagen(file, 400, 0.85);
                    if (fill) fill.style.width = '50%';
                    if (text) text.textContent = 'Subiendo...';
                    const tenantId = window.currentTenantId || 'public';
                    const fileName = `logo-${Date.now()}.jpg`;
                    const filePath = `logos/${tenantId}/${fileName}`;
                    if (!supabaseClient) throw new Error('Cliente no disponible');
                    const { data, error } = await supabaseClient.storage
                        .from('service-images')
                        .upload(filePath, imagenOptimizada, { contentType: 'image/jpeg', upsert: true });
                    if (error) throw error;
                    if (fill) fill.style.width = '80%';
                    if (text) text.textContent = 'Procesando...';
                    const { data: urlData } = supabaseClient.storage
                        .from('service-images')
                        .getPublicUrl(filePath);
                    const publicUrl = urlData?.publicUrl;
                    if (publicUrl) {
                        document.getElementById('cfg-logo').value = publicUrl;
                        VisualConfigManager.updateLogo(publicUrl);
                        // Mostrar preview
                        const preview = document.getElementById('logo-preview');
                        const previewImg = document.getElementById('logo-preview-img');
                        if (preview && previewImg) { previewImg.src = publicUrl; preview.style.display = 'block'; }
                        mostrarMensaje('✅ Logo subido exitosamente', 'success');
                    }
                    if (bar) bar.style.display = 'none';
                } catch (e) {
                    console.error('[logo upload] Error:', e);
                    mostrarMensaje('❌ Error al subir logo: ' + (e.message || 'Desconocido'), 'error');
                    if (bar) bar.style.display = 'none';
                }
            });
        }

        // Custom CSS
        const cssEl = document.getElementById('custom-css');
        if (cssEl) cssEl.addEventListener('input', onChangeWithThemeClear);
    },

    /** Interno: merge con defaults */
    _mergeWithDefaults(config) {
        const def = this.getDefaultConfig();
        const merged = {};
        for (const key of Object.keys(def)) {
            const v = config[key];
            merged[key] = (v !== undefined && v !== null && v !== '') ? v : def[key];
        }
        return merged;
    },

    // ============================================================
    // SUPERADMIN: load/save para tenant específico
    // ============================================================
    async loadConfigForTenant(tenantId) {
        if (!tenantId) return this.getDefaultConfig();
        try {
            const fullCache = localStorage.getItem(this._cacheKey(tenantId));
            if (fullCache) {
                try {
                    const parsed = JSON.parse(fullCache);
                    if (parsed && parsed.primary_color) return this._mergeWithDefaults(parsed);
                } catch (e) {}
            }
            let dbData = null;
            let dbError = null;
            try {
                const res = await supabaseClient
                    .from('tenant_config')
                    .select('primary_color, secondary_color, logo_url, favicon_url, cover_url, custom_css')
                    .eq('tenant_id', tenantId)
                    .maybeSingle();
                dbData = res.data;
                dbError = res.error;
                if (dbError && dbError.code === 'PGRST204') {
                    console.warn('[VisualConfig] cover_url no existe en BD, cargando sin ella');
                    const retry = await supabaseClient
                        .from('tenant_config')
                        .select('primary_color, secondary_color, logo_url, favicon_url, custom_css')
                        .eq('tenant_id', tenantId)
                        .maybeSingle();
                    dbData = retry.data;
                    dbError = retry.error;
                }
            } catch (e) {
                dbError = e;
            }
            if (dbError && dbError.code !== 'PGRST116') {
                console.warn('[VisualConfig] Error BD loadConfigForTenant:', dbError.message);
                dbData = null;
            }
            let extras = {};
            try {
                const extRaw = localStorage.getItem(this._extKey(tenantId));
                if (extRaw) extras = JSON.parse(extRaw);
            } catch (e) {}
            let config = { ...this.getDefaultConfig(), ...extras };
            if (dbData) {
                config.primary_color = dbData.primary_color || config.primary_color;
                config.secondary_color = dbData.secondary_color || config.secondary_color;
                config.logo_url = dbData.logo_url || '';
                config.favicon_url = dbData.favicon_url || '';
                config.cover_url = dbData.cover_url || '';
                config.custom_css = dbData.custom_css || '';
            }
            localStorage.setItem(this._cacheKey(tenantId), JSON.stringify(config));
            return config;
        } catch (e) {
            console.error('Error loadConfigForTenant', tenantId, e);
            return this.getDefaultConfig();
        }
    },

    async saveConfigForTenant(tenantId, config) {
        if (!tenantId) throw new Error('Tenant ID requerido');
        try {
            const full = this._mergeWithDefaults(config);

            // Columnas que siempre existen en tenant_config
            const CORE = {
                tenant_id: tenantId,
                primary_color: full.primary_color,
                secondary_color: full.secondary_color,
                logo_url: full.logo_url || null,
                custom_css: full.custom_css || null
            };
            const OPTIONAL = {
                favicon_url: full.favicon_url || null,
                cover_url: full.cover_url || null,
                instagram_url: full.instagram_url || null,
                tiktok_url: full.tiktok_url || null,
                ubicacion_tipo: full.ubicacion_tipo || null,
                direccion: full.direccion || null
            };

            // Intentar con todas las columnas
            const dbPayload = { ...CORE, ...OPTIONAL };
            let { error } = await supabaseClient
                .from('tenant_config')
                .upsert(dbPayload, { onConflict: 'tenant_id' });

            // Si falla por columnas opcionales, reintentar solo con core
            if (error && error.code === 'PGRST204') {
                console.warn('[VisualConfig] Columnas opcionales no existen en BD, guardando solo columnas base (saveConfigForTenant)');
                const retry = await supabaseClient
                    .from('tenant_config')
                    .upsert(CORE, { onConflict: 'tenant_id' });
                error = retry.error;
            }
            if (error) throw error;
            const extras = {
                bg_color: full.bg_color, text_color: full.text_color,
                card_bg: full.card_bg, border_color: full.border_color,
                theme_mode: full.theme_mode, font_family: full.font_family,
                border_radius: full.border_radius, animation_speed: full.animation_speed,
                favicon_url: full.favicon_url,
                cover_url: full.cover_url
            };
            localStorage.setItem(this._extKey(tenantId), JSON.stringify(extras));
            localStorage.setItem(this._cacheKey(tenantId), JSON.stringify(full));
            return true;
        } catch (e) {
            console.error('Error saveConfigForTenant', tenantId, e);
            return false;
        }
    }
};

async function enviarSolicitudCSS() {
    const descripcion = document.getElementById('solicitud-descripcion').value.trim();
    if (!descripcion) {
        mostrarToast('Por favor, describe lo que deseas.', 'warning');
        return false;
    }
    const tenantId = await getCurrentTenantId();
    if (!tenantId) {
        mostrarToast('Error: no se pudo identificar el tenant.', 'error');
        return false;
    }
    // Obtener datos del tenant (nombre)
    const { data: tenant, error: tenantError } = await supabaseClient
        .from('tenants')
        .select('nombre_negocio, email_contacto')
        .eq('id', tenantId)
        .single();
    if (tenantError) {
        console.error(tenantError);
        mostrarToast('Error al obtener datos del tenant.', 'error');
        return false;
    }
    const notif = {
        tenant_id: tenantId,
        tipo: 'solicitud_css_profesional',
        cita_id: null,
        fecha_original: null,
        hora_original: null,
        fecha_nueva: null,
        hora_nueva: null,
        cliente: { nombre: tenant.nombre_negocio, email: tenant.email_contacto },
        leido: false,
        creado_en: new Date().toISOString(),
        metadata: { descripcion: descripcion }
    };
    const { error } = await window.__notificacionesApi.create(notif);
    if (error) console.error('Error crear notificacion:', error);
    if (error) {
        console.error(error);
        mostrarToast('Error al enviar la solicitud.', 'error');
        return false;
    }
    mostrarToast('Solicitud enviada. Un asesor se pondrá en contacto.', 'success');
    return true;
}

// ============================================
// PLANES Y SUSCRIPCIONES (para página planes.html)
// ============================================
const planesData = {
    freemium: { 
        nombre: 'Freemium', 
        precio: 'Gratis', 
        periodo: 'siempre', 
        features: ['Acceso completo a todas las funciones', 'Sin límite de servicios ni citas', 'Personalización de diseño incluida', 'Soporte email'], 
        color: '#00b894',
        soloSuperAdmin: true
    },
    free_trial: {
        nombre: 'Free Trial',
        precio: 'Gratis',
        periodo: '14 días',
        features: ['Acceso completo a todas las funciones', 'Sin límite de servicios ni citas', 'Sin necesidad de tarjeta', 'Soporte email prioritario'],
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
        nombre: 'Premium Anual', 
        precio: '$140.000', 
        periodo: '/año', 
        features: [
            'Mismas funciones que Pro',
            'Personalización de diseño (admin y cliente)',
            'Onboarding personalizado',
            'Ahorras $40.000 vs plan mensual ($180.000/año)',
            'Factura anual en un solo pago'
        ], 
        color: '#ffd700',
        duracionMeses: 12,
        ahorro: true
    }
};

// Exponer globalmente para que constants.js (ES module) pueda usarlo como fuente única
window.planesData = planesData;

async function cargarPlanes() {
    const container = document.getElementById('planes-container');
    if (!container) return;

    // Esperar a que supabaseClient esté listo
    if (!supabaseClient) {
        await initSupabase();
    }

    // Obtener parámetros de URL
    const urlParams = new URLSearchParams(window.location.search);
    const tenantIdFromUrl = urlParams.get('tenant_id');

    // Manejar retorno de Mercado Pago (planes.html?status=success|failure|pending)
    const mpReturnStatus = urlParams.get('status');
    if (mpReturnStatus === 'success') {
        const couponId = sessionStorage.getItem('promo_coupon_used');
        if (couponId && window.__subscriptionsApi?.markCouponUsed) {
            try {
                await window.__subscriptionsApi.markCouponUsed(couponId);
                sessionStorage.removeItem('promo_coupon_used');
                console.log('[Planes] Cupón marcado como usado:', couponId);
            } catch (e) {
                console.warn('[Planes] Error marcando cupón usado:', e);
            }
        }
        mostrarToast('¡Pago exitoso! Tu suscripción se activará en segundos...', 'success');
        setTimeout(() => window.location.replace('admin.html'), 2500);
    } else if (mpReturnStatus === 'failure') {
        mostrarToast('El pago fue rechazado. Intenta con otro método de pago.', 'error');
    } else if (mpReturnStatus === 'pending') {
        mostrarToast('El pago está pendiente. Te notificaremos cuando se confirme.', 'warning');
    }

    // Ocultar navegación para nuevos registros (se evalúa tras calcular isNewAdmin)

    // Obtener sesión fresca con retry (similar a iniciarAdmin)
    let sessionData = null;
    for (let i = 0; i < 10; i++) {
        sessionData = await getSession();
        // Si encontramos sesión con tenant_id, salir
        if (sessionData && sessionData.tenant_id) break;
        // Si no hay sesión pero hay pending_whatsapp en URL, también seguir
        if (sessionData && urlParams.get('pending_whatsapp') === 'true') break;
        await new Promise(r => setTimeout(r, 200));
    }

    let rol = sessionData?.rol || null;
    // tenantId: priorizar URL sobre sesión (la URL es la fuente de verdad después de crear tenant)
    let tenantId = tenantIdFromUrl || sessionData?.tenant_id || null;
    let suscripcionActual = null;
    const esSuperAdmin = sessionData?.user?.email === 'super@demo.com';

    console.log('[Planes] sesión:', sessionData ? '✅' : '❌', '| rol:', rol, '| tenantId:', tenantId, '| pending_ww:', urlParams.get('pending_whatsapp'));

    // Si no hay sesión ni tenant (ni siquiera de URL), redirigir
    if (!sessionData && !tenantIdFromUrl) {
        console.log('[Planes] Sin sesión ni tenant, redirigiendo a login');
        window.location.href = 'login.html';
        return;
    }

    // Obtener suscripción si tenemos tenantId y rol admin
    if (rol === 'admin' && tenantId) {
        try {
            suscripcionActual = await SuscripcionManager.getCurrent();
            console.log('[Planes] suscripcionActual:', suscripcionActual?.status || 'ninguna');
        } catch (e) {
            console.warn('[cargarPlanes] Error obteniendo suscripción:', e.message);
        }
    }

    // ¿Este tenant tuvo ALGUNA VEZ un plan real (no freemium)? Se mira el HISTORIAL
    // completo (cualquier status), no solo la sub activa. Motivo: la sub freemium/inactive
    // que crea el trigger al registrar el tenant no cuenta (es el estado inicial), pero un
    // free_trial o pro ANTERIOR (aunque ya esté vencido/inactive) SÍ debe impedir un nuevo
    // Free Trial. Sin esto, cualquiera podría dejar vencer su trial y tomarlo otra vez.
    let tuvoPlanAlgunaVez = false;
    if (rol === 'admin' && tenantId) {
        try {
            const { data: historial } = await supabaseClient
                .from('subscriptions')
                .select('id')
                .eq('tenant_id', tenantId)
                .neq('plan', 'freemium')
                .limit(1);
            tuvoPlanAlgunaVez = !!(historial && historial.length > 0);
            console.log('[Planes] historial de plan no-freemium:', tuvoPlanAlgunaVez ? 'SÍ (no es primerizo)' : 'no (primerizo)');
        } catch (e) {
            console.warn('[cargarPlanes] Error verificando historial de plan:', e.message);
        }
    }

    // "Nuevo admin" (ve Free Trial) = vino con new=true (registro normal o Google CASO A)
    // O es PRIMERIZO de verdad: sin suscripción activa Y sin historial de plan no-freemium.
    // Un tenant que ya tuvo free_trial/pro/premium (aunque vencido) NO es nuevo → solo ve
    // planes de pago. El Free Trial es una única oportunidad por negocio.
    const isNewAdmin = urlParams.get('new') === 'true' || (!suscripcionActual && !tuvoPlanAlgunaVez);

    // Ocultar navegación para nuevos registros
    if (isNewAdmin) {
        const nav = document.querySelector('.screen-navigation');
        if (nav) nav.style.display = 'none';
    }

    let html = '<div class="step-guide" style="margin-bottom:20px;"><i class="fas fa-info-circle"></i><span><strong>Compara los planes:</strong> Todos los planes incluyen servicios ilimitados y citas ilimitadas. La diferencia es la <strong>forma de pago</strong>: Pro es mensual ($15.000/mes), Premium Anual es un solo pago por 12 meses con descuento incluido ($140.000/año = ahorras $40.000).</span></div>';
    html += '<div class="stats-container" style="grid-template-columns: repeat(3,1fr); gap: 25px;">';
    
    for (const [key, plan] of Object.entries(planesData)) {
        if (plan.soloSuperAdmin && !esSuperAdmin) continue;
        if (plan.soloNuevos && !isNewAdmin) continue;
        
        const isCurrent = suscripcionActual && suscripcionActual.plan === key;
        html += `
            <div class="stat-box plan-card" data-plan="${key}" style="text-align: center; border-top: 4px solid ${plan.color}; position: relative;">
                ${plan.ahorro ? '<span style="position:absolute;top:-10px;right:-10px;background:#ffd700;color:#1a1a2e;font-size:0.7rem;font-weight:700;padding:4px 10px;border-radius:20px;box-shadow:0 2px 10px rgba(255,215,0,0.4);">AHORRO</span>' : ''}
                <h3 style="color: ${plan.color};">${plan.nombre}</h3>
                <div class="plan-price"><span style="font-size: 2rem; font-weight: bold;">${plan.precio}</span> ${plan.periodo}</div>
                <ul style="list-style: none; padding: 0; margin: 20px 0; text-align: left;">
                    ${plan.features.map(f => `<li><i class="fas fa-check" style="color: ${plan.color}; margin-right: 8px;"></i> ${f}</li>`).join('')}
                </ul>
                <button class="btn-grad select-plan-btn" data-plan="${key}" ${isCurrent ? 'disabled' : ''} style="${isCurrent ? 'opacity:0.6; cursor:not-allowed;' : ''}">
                    ${isCurrent ? 'Plan actual' : 'Seleccionar plan'}
                </button>
            </div>
        `;
    }
    html += '</div>';
    container.innerHTML = html;

    // Manejar clic en botones según el modo
    document.querySelectorAll('.select-plan-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const planKey = btn.dataset.plan;
            if (isNewAdmin && tenantIdFromUrl) {
                await crearSuscripcionInicial(planKey, tenantIdFromUrl);
            } else if (!suscripcionActual && rol === 'admin' && tenantId) {
                await crearSuscripcionInicial(planKey, tenantId);
            } else if (suscripcionActual || rol === 'admin') {
                await solicitarCambioPlan(planKey);
            } else {
                mostrarToast('Debes iniciar sesión como administrador para seleccionar un plan', 'warning');
            }
        });
    });

    // ================================================================
    // WHATSAPP MODAL — SISTEMA ANTIFRAUDE (Google OAuth)
    // Aparece cuando se detecta ?pending_whatsapp=true en la URL
    // VALIDACIÓN + VERIFICACIÓN CRUZADA en BD antes de guardar:
    //   a) Si WhatsApp ya existe en tenants → VINCULAR al tenant existente
    //   b) Si email ya tiene tenant → ACTUALIZAR su WhatsApp
    //   c) Si es todo nuevo → CREAR y persistir (doble save: Auth + BD)
    // ================================================================
    const pendingWhatsapp = urlParams.get('pending_whatsapp') === 'true';

    if (pendingWhatsapp) {
        // BYPASS SUPERADMIN: super@demo.com no necesita WhatsApp
        if (esSuperAdmin) {
            console.log('[Planes] Superadmin detectado, saltando modal WhatsApp → superadmin.html');
            window.location.replace('superadmin.html');
            return;
        }

        let modal = document.getElementById('whatsapp-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'whatsapp-modal';
            modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;';
            modal.innerHTML = `
                <div class="glass-panel" style="max-width:420px;padding:30px;position:relative;">
                    <h3 style="margin-bottom:15px;"><i class="fab fa-whatsapp"></i> Completa tu número de WhatsApp</h3>
                    <p style="margin-bottom:15px;color:#b0b0b0;font-size:0.9rem;">
                        Necesitamos tu WhatsApp para que tus clientes puedan contactarte.<br>
                        <strong>Importante:</strong> Si ya tienes un negocio registrado, inicia sesión con tu correo electrónico para administrarlo.
                    </p>
                    <input type="tel" id="whatsapp-input" class="form-input"
                           placeholder="Ej: +56912345678" maxlength="16"
                           style="width:100%;margin-bottom:10px;padding:12px;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:white;font-size:1rem;">
                    <p id="whatsapp-info" style="display:none;color:#ffd700;margin-bottom:10px;font-size:0.85rem;"></p>
                    <p id="whatsapp-error" style="display:none;color:#e74c3c;margin-bottom:10px;font-size:0.85rem;"></p>
                    <button id="btn-guardar-whatsapp" class="btn-grad" style="width:100%;padding:12px;">
                        <i class="fas fa-check"></i> Guardar WhatsApp
                    </button>
                </div>
            `;
            document.body.appendChild(modal);
            // CSP FIX (2026-08-27): el oninput inline queda bloqueado por CSP → listener
            const whatsappInput = document.getElementById('whatsapp-input');
            if (whatsappInput) {
                whatsappInput.addEventListener('input', function () {
                    this.value = this.value.replace(/[^0-9+]/g, '');
                });
            }
        }

        const input = document.getElementById('whatsapp-input');
        const errorMsg = document.getElementById('whatsapp-error');
        const infoMsg = document.getElementById('whatsapp-info');
        const btn = document.getElementById('btn-guardar-whatsapp');
        const userEmail = sessionData?.user?.email || '';

        // Trapar tecla Escape (modal forzoso)
        const trapEscape = (e) => { if (e.key === 'Escape') e.preventDefault(); };
        document.addEventListener('keydown', trapEscape);

        if (btn) {
            btn.addEventListener('click', async function guardarWhatsapp() {
                const raw = input.value.trim();
                errorMsg.style.display = 'none';
                infoMsg.style.display = 'none';

                // ============================================================
                // VALIDACIÓN RELAJADA (MODO TEST): mínimo 8 dígitos
                // Permite números ficticios como '123456789' para pruebas.
                // ============================================================
                if (!raw) {
                    errorMsg.textContent = 'Ingresa tu número de WhatsApp.';
                    errorMsg.style.display = 'block'; return;
                }
                const digits = raw.replace(/\D/g, '');
                if (digits.length < 8) {
                    errorMsg.textContent = 'Número inválido. Debe tener al menos 8 dígitos.';
                    errorMsg.style.display = 'block'; return;
                }
                const whatsapp = raw.startsWith('+') ? '+' + digits : digits;

                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verificando...';

                try {
                    // ============================================================
                    // PASO A (SEGURIDAD): ¿el número ya lo usa OTRO negocio?
                    // ANTES: este bloque vinculaba automáticamente al tenant cuyo
                    // whatsapp coincidía (toma de control con solo conocer el número).
                    // AHORA: se consulta disponibilidad vía RPC (sin exponer datos)
                    // y se bloquea si el número pertenece a otro negocio.
                    // ============================================================
                    let whatsappEnUso = false;
                    try {
                        const { data: waEnUso } = await supabaseClient.rpc('whatsapp_en_uso', { p_whatsapp: whatsapp });
                        whatsappEnUso = !!waEnUso;
                    } catch (e) {
                        console.warn('[WhatsApp] No se pudo verificar disponibilidad del número:', e);
                    }

                    // ¿El número es del tenant actual (propio negocio)? → permitido
                    let esMiWhatsapp = false;
                    if (tenantId) {
                        try {
                            const { data: miTenant } = await supabaseClient
                                .from('tenants')
                                .select('whatsapp')
                                .eq('id', tenantId)
                                .maybeSingle();
                            esMiWhatsapp = !!(miTenant && miTenant.whatsapp && String(miTenant.whatsapp).trim() === String(whatsapp).trim());
                        } catch (e) {
                            console.warn('[WhatsApp] No se pudo leer el whatsapp de mi tenant:', e);
                        }
                    }

                    if (whatsappEnUso && !esMiWhatsapp) {
                        // Número registrado por otro negocio → NO vincular (seguridad)
                        errorMsg.textContent = 'Este número de WhatsApp ya está registrado a otro negocio. Si es tuyo, inicia sesión con tu correo electrónico para administrarlo.';
                        errorMsg.style.display = 'block';
                        btn.disabled = false;
                        btn.innerHTML = '<i class="fas fa-check"></i> Guardar WhatsApp';
                        return;
                    }

                    // ============================================================
                    // PASO B: BUSCAR POR EMAIL — ¿este correo ya tiene un tenant?
                    // ============================================================
                    let tenantIdActual = tenantId; // tenantId de la URL o sesión

                    if (!tenantIdActual && userEmail) {
                        const { data: tenantPorEmail } = await supabaseClient
                            .from('tenants')
                            .select('id')
                            .eq('email_contacto', userEmail)
                            // Mismo fix de duplicados: con 2+ tenants del mismo email,
                            // maybeSingle() fallaría; tomar el más reciente.
                            .order('fecha_registro', { ascending: false })
                            .limit(1)
                            .maybeSingle();

                        if (tenantPorEmail) {
                            // Email ya tiene tenant → actualizar su WhatsApp (no crear nuevo)
                            tenantIdActual = tenantPorEmail.id;
                            console.log('[WhatsApp] Email ya tiene tenant, actualizando WhatsApp');
                        }
                    }

                    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...';

                    // ============================================================
                    // PERSISTENCIA #1: Auth metadata (JWT/sesión del cliente)
                    // ============================================================
                    const { error: authError } = await supabaseClient.auth.updateUser({
                        data: { whatsapp: whatsapp }
                    });
                    if (authError) throw authError;

                    // ============================================================
                    // PERSISTENCIA #2: Base de datos (tabla public.tenants)
                    // ============================================================
                    if (tenantIdActual) {
                        const { error: dbError } = await supabaseClient
                            .from('tenants')
                            .update({ whatsapp: whatsapp })
                            .eq('id', tenantIdActual);
                        if (dbError) throw dbError;
                    } else {
                        // Sin tenant asociado — es un caso borde, crear uno
                        // Vía RPC crear_tenant_completo (SECURITY DEFINER) para que
                        // también se registre el rol server-side (user_roles).
                        const nombreNegocio = userEmail.split('@')[0];
                        const { data: newTenant, error: createError } = await supabaseClient
                            .rpc('crear_tenant_completo', {
                                p_nombre_negocio: nombreNegocio,
                                p_email_contacto: userEmail,
                                p_whatsapp: whatsapp
                            });
                        if (createError) throw createError;
                        if (!newTenant || !newTenant.id) throw new Error('No se pudo crear el negocio. Intenta nuevamente.');
                        tenantIdActual = newTenant.id;

                        // Actualizar metadata con el nuevo tenant
                        await supabaseClient.auth.updateUser({
                            data: { tenant_id: newTenant.id, rol: 'admin', whatsapp: whatsapp }
                        });
                    }

                    console.log('[WhatsApp] Guardado en Auth metadata y BD:', whatsapp);

                    await supabaseClient.auth.refreshSession();

                    // Sincronizar JwtManager
                    const { data: { session: freshSession } } = await supabaseClient.auth.getSession();
                    if (freshSession && window.JwtManager) {
                        window.JwtManager.setTokens(freshSession.access_token, freshSession.refresh_token);
                    }

                    // Verificar datos frescos en JwtManager
                    const freshUserData = window.JwtManager?.getUserData();
                    console.log('[WhatsApp] JwtManager post-refresh:', {
                        rol: freshUserData?.rol,
                        tenant_id: freshUserData?.tenant_id,
                        whatsapp: freshUserData?.whatsapp
                    });

                    modal.style.display = 'none';
                    document.removeEventListener('keydown', trapEscape);

                    // Determinar tenantId (desde URL o desde sesión)
                    const tenantIdFinal = urlParams.get('tenant_id') || tenantIdActual || '';

                    // Verificar si ya tiene suscripción activa (usando SuscripcionManager)
                    let tienePlan = false;
                    if (tenantIdFinal) {
                        try {
                            const sub = await SuscripcionManager.getCurrent();
                            tienePlan = !!(sub && sub.status === 'active');
                        } catch (e) {
                            console.warn('[WhatsApp] Error verificando suscripción:', e.message);
                        }
                    }

                    mostrarToast('WhatsApp guardado correctamente', 'success');

                    // Preservar new=true si venía en la URL (cuenta nueva vía Google:
                    // CASO A pasó planes.html?...&new=true). Sin esto, el Free Trial
                    // (soloNuevos) desaparecería al recargar tras guardar WhatsApp.
                    const esNuevo = urlParams.get('new') === 'true';

                    if (tienePlan) {
                        // Ya tiene plan → dashboard
                        window.location.replace('admin.html');
                    } else if (tenantIdFinal) {
                        // Tiene tenant pero no plan → elegir plan
                        window.location.replace(`planes.html?tenant_id=${tenantIdFinal}${esNuevo ? '&new=true' : ''}`);
                    } else {
                        // Sin tenant conocido → admin.html (iniciarAdmin manejará)
                        window.location.replace('admin.html');
                    }

                } catch (err) {
                    console.error('[WhatsApp] Error:', err);
                    errorMsg.textContent = err.message || 'Error al guardar. Intenta de nuevo.';
                    errorMsg.style.display = 'block';
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fas fa-check"></i> Guardar WhatsApp';
                }
            });
        }
    }
}

// Inicia el pago de un plan pagado con Mercado Pago (usa el cliente moderno expuesto por main.js)
async function iniciarPagoMercadoPago(planKey, tenantId) {
    const mp = window.__mercadopago;
    if (!mp || typeof mp.createPreference !== 'function') {
        mostrarToast('El módulo de pagos no está disponible. Recarga la página.', 'error');
        return;
    }

    // Defensa: si no llegó tenantId, obtenerlo de la sesión actual
    if (!tenantId) {
        try {
            tenantId = await getCurrentTenantId();
        } catch (e) {}
    }
    if (!tenantId) {
        mostrarToast('No se pudo identificar tu negocio. Recarga la página.', 'error');
        return;
    }

    // Obtener email del usuario autenticado
    let email = '';
    try {
        const userData = window.JwtManager?.getUserData?.();
        email = userData?.email || '';
    } catch (e) {}
    if (!email) {
        try {
            const stored = JSON.parse(localStorage.getItem('agendapro_user_data') || '{}');
            email = stored.email || '';
        } catch (e) {}
    }
    if (!email) {
        try {
            const sessionData = await getSession();
            email = sessionData?.user?.email || '';
        } catch (e) {}
    }

    // SIEMPRE suscripción recurrente (cobro automático $15.000/mes). El cupón
    // 50% (aprobado por superadmin, cada 3 meses) descuenta AUTOMÁTICAMENTE un
    // cobro mensual vía reembolso parcial en el webhook — NO afecta este pago.
    // NUNCA degradar a pago único (bug verificado 2026-08-31: el fallback
    // creaba preferencias de pago único de $15.000 sin suscripción recurrente).
    try {
        let esperaMs = 0;
        while (typeof mp.createPreapproval !== 'function' && esperaMs < 3000) {
            await new Promise(r => setTimeout(r, 300));
            esperaMs += 300;
        }
        if (typeof mp.createPreapproval !== 'function') {
            console.error('[Planes] createPreapproval no disponible tras 3s — no se degrada a pago único');
            mostrarToast('El módulo de suscripciones aún está cargando. Recarga la página e inténtalo de nuevo.', 'error');
            return;
        }
        const pref = await mp.createPreapproval({
            plan: planKey,
            tenantId: tenantId,
            email: email,
            nombre: email,
        });
        mp.redirect(pref.init_point);
    } catch (err) {
        console.error('[Planes] Error iniciando pago MP:', err);
        mostrarToast('Error al iniciar pago: ' + err.message, 'error');
    }
}

// Nueva función para crear suscripción inicial (alta de nuevo admin)
async function crearSuscripcionInicial(planKey, tenantId) {
    if (planKey === 'freemium') {
        mostrarToast('El plan Freemium no está disponible para nuevos administradores', 'error');
        return;
    }

    // Planes de pago → Mercado Pago (nunca activar sin pago)
    if (planKey === 'pro' || planKey === 'premium_anual') {
        await iniciarPagoMercadoPago(planKey, tenantId);
        return;
    }
    
    // ========== VALIDACIÓN ANTIFRAUDE: verificar que NO haya tenido plan NUNCA ==========
    // Se mira el HISTORIAL COMPLETO (cualquier status): un free_trial o plan pagado
    // ANTERIOR, aunque esté vencido/inactive, impide un nuevo Free Trial. Solo se
    // excluye la sub 'freemium/inactive' que crea el trigger al registrar el tenant
    // (estado inicial, no es un plan elegido por el usuario).
    if (planKey === 'free_trial') {
        try {
            const { data: existingSubs } = await supabaseClient
                .from('subscriptions')
                .select('id, plan, status')
                .eq('tenant_id', tenantId)
                .neq('plan', 'freemium')
                .limit(1);
            if (existingSubs && existingSubs.length > 0) {
                mostrarToast('Este negocio ya tuvo un plan anteriormente. El Free Trial es solo para negocios nuevos.', 'error');
                return;
            }
        } catch (e) {
            console.warn('[crearSuscripcionInicial] Error verificando suscripciones previas:', e);
            // Si falla la verificación, bloqueamos por seguridad
            mostrarToast('Error de verificación. Intenta de nuevo.', 'error');
            return;
        }
    }
    // ===================================================================================
    
    const planInfo = planesData[planKey];
    let endDate = null;
    if (planInfo?.duracionDias) {
        endDate = new Date(Date.now() + planInfo.duracionDias * 24 * 60 * 60 * 1000).toISOString();
    } else if (planInfo?.duracionMeses) {
        endDate = new Date();
        endDate.setMonth(endDate.getMonth() + planInfo.duracionMeses);
        endDate = endDate.toISOString();
    }
    const newSub = {
        tenant_id: tenantId,
        plan: planKey,
        status: 'active',
        start_date: new Date().toISOString(),
        end_date: endDate
    };
    const result = await SuscripcionManager.create(newSub);
    if (result) {
        mostrarToast(`Plan ${planInfo.nombre} activado correctamente`, 'success');
        window.location.replace('admin.html?subscription_created=true');
    } else {
        mostrarToast('Error al activar el plan. Intenta de nuevo.', 'error');
    }
}

async function solicitarCambioPlan(planKey) {
    const { data: { session } } = JwtManager.getSession();
    if (!session) {
        mostrarToast('Debes iniciar sesión como administrador', 'warning');
        setTimeout(() => window.location.href = 'login.html?redirect=planes', 1500);
        return;
    }
    const rol = session.user.user_metadata?.rol;
    if (rol !== 'admin' && rol !== 'super_admin') {
        mostrarToast('Solo los administradores del negocio pueden cambiar el plan', 'error');
        return;
    }

    // Restricción: Freemium solo para superadmin
    if (planKey === 'freemium' && rol !== 'super_admin') {
        mostrarToast('El plan Freemium solo puede ser asignado por el Super Administrador', 'error');
        return;
    }

    // Restricción: Free Trial solo para negocios nuevos
    if (planKey === 'free_trial') {
        mostrarToast('El plan Free Trial solo está disponible para negocios nuevos', 'error');
        return;
    }

    const suscripcion = await SuscripcionManager.getCurrent();
    if (!suscripcion) {
        mostrarToast('No se encontró suscripción activa. Crea una nueva.', 'error');
        return;
    }

    const nuevoPlan = planKey; // 'freemium', 'pro', 'premium_anual'
    const planAnterior = suscripcion.plan;
    const tenantId = suscripcion.tenant_id;

    // Planes de pago → Mercado Pago (nunca cambiar de plan sin pago)
    if (nuevoPlan === 'pro' || nuevoPlan === 'premium_anual') {
        await iniciarPagoMercadoPago(nuevoPlan, tenantId);
        return;
    }

    // Calcular end_date según el nuevo plan
    let endDate = null;
    const duracionMeses = planesData[nuevoPlan]?.duracionMeses;
    if (duracionMeses) {
        endDate = new Date();
        endDate.setMonth(endDate.getMonth() + duracionMeses);
        endDate = endDate.toISOString();
    }

    const updates = { 
        plan: nuevoPlan, 
        status: 'active',
        end_date: endDate
    };
    // También actualizar start_date si se requiere (opcional, se mantiene la actual)
    // Para mantener historial, se podría crear una nueva suscripción en vez de actualizar.
    // Pero por simplicidad, actualizamos la existente.
    const ok = await SuscripcionManager.update(suscripcion.id, updates);
    if (ok) {
        await crearNotificacionCambioPlan(tenantId, planAnterior, nuevoPlan);
        mostrarToast(`Plan actualizado a ${planesData[nuevoPlan].nombre}`, 'success');
        await cargarPlanes();
        if (typeof cargarSuscripcionTenant === 'function') cargarSuscripcionTenant();
    } else {
        mostrarToast('Error al cambiar el plan', 'error');
    }
}

// ============================================
// NOTIFICACIÓN DE CAMBIO DE PLAN (para superadmin)
// ============================================
async function crearNotificacionCambioPlan(tenantId, planAnterior, planNuevo) {
    try {
        // Obtener nombre del negocio
        const { data: tenant, error: tenantError } = await supabaseClient
            .from('tenants')
            .select('nombre_negocio')
            .eq('id', tenantId)
            .single();

        if (tenantError) {
            console.error('Error obteniendo tenant para notificación:', tenantError);
            return;
        }

        const notif = {
            tenant_id: tenantId,
            tipo: 'cambio_plan',
            cita_id: null,
            fecha_original: null,
            hora_original: null,
            fecha_nueva: null,
            hora_nueva: null,
            cliente: { nombre: tenant?.nombre_negocio || 'Tenant' },
            leido: false,
            creado_en: new Date().toISOString(),
            metadata: { plan_anterior: planAnterior, plan_nuevo: planNuevo }
        };

        const { error: insertError } = await supabaseClient
            .from('notificaciones_admin')
            .insert(notif);

        if (insertError) {
            console.error('Error insertando notificación de cambio de plan:', insertError);
        } else {
            console.log(`✅ Notificación de cambio de plan creada para tenant ${tenantId}`);
        }
    } catch (e) {
        console.error('Error en crearNotificacionCambioPlan:', e);
    }
}
// Función para crear notificación de cambio admin
async function crearNotificacionCambioAdmin(citaOriginal, citaNueva) {
    try {
        const tenantId = await getCurrentTenantId();
        if (!tenantId) return null;
        
        let cliente = citaOriginal.contacto || { 
            nombre: citaOriginal.nombreCliente || 'Cliente',
            telefono: citaOriginal.telefonoCliente || citaOriginal.contacto?.telefono || '',
            email: citaOriginal.contacto?.email || ''
        };
        
        if (!cliente.nombre) {
            cliente.nombre = citaOriginal.nombreCliente || 'Cliente';
        }
        
        const notif = {
            id: 'notif-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
            tenant_id: tenantId,
            tipo: 'cambio-admin',
            cita_id: citaNueva.id || citaOriginal.id,
            fecha_original: citaOriginal.fecha || '',
            hora_original: citaOriginal.hora || '',
            fecha_nueva: citaNueva.fecha || '',
            hora_nueva: citaNueva.hora || '',
            cliente: cliente,
            leido: false,
            creado_en: new Date().toISOString()
        };
        
        const { error } = await supabaseClient
            .from('notificaciones_admin')
            .insert(notif);
            
        if (error) throw error;
        return notif;
    } catch (e) {
        console.error('Error creando notificación:', e);
        return null;
    }
}

async function actualizarDashboardFinanzas() {
    try {
        // Asegurar que supabaseClient esté listo antes de consultar (evita carrera con main.js)
        if (!supabaseClient) {
            await initSupabase();
        }
        console.log('🔄 Actualizando dashboard...');
        await actualizarEstadisticasTriples();
        await actualizarTopServicios();
        await actualizarKPIs();
        
        // Pequeño delay para asegurar que todo esté listo
        setTimeout(() => {
            renderizarGraficoVentas();
        }, 100);
        
        console.log('✅ Dashboard actualizado');
    } catch (error) {
        console.error('❌ Error en actualizarDashboardFinanzas:', error);
    }
}

async function actualizarEstadisticasTriples() {
    const ventasHoy = await VentasManager.getHoy();
    const totalHoy = VentasManager.calcularTotal(ventasHoy);
    document.getElementById('valor-diario').textContent = formatearPeso(totalHoy);
    document.getElementById('detalle-diario').textContent = `${ventasHoy.length} venta${ventasHoy.length !== 1 ? 's' : ''}`;
    ajustarTamanoStat(document.getElementById('valor-diario'));
    
    const ventasSemana = await VentasManager.getSemana();
    const totalSemana = VentasManager.calcularTotal(ventasSemana);
    document.getElementById('valor-semanal').textContent = formatearPeso(totalSemana);
    document.getElementById('detalle-semanal').textContent = `${ventasSemana.length} venta${ventasSemana.length !== 1 ? 's' : ''}`;
    ajustarTamanoStat(document.getElementById('valor-semanal'));
    
    const ventasMes = await VentasManager.getMes();
    const totalMes = VentasManager.calcularTotal(ventasMes);
    document.getElementById('valor-mensual').textContent = formatearPeso(totalMes);
    document.getElementById('detalle-mensual').textContent = `${ventasMes.length} venta${ventasMes.length !== 1 ? 's' : ''}`;
    ajustarTamanoStat(document.getElementById('valor-mensual'));
}

async function actualizarTopServicios() {
    const container = document.getElementById('top-servicios');
    if (!container) return;
    
    const topServicios = await VentasManager.getTopServicios(5);
    
    if (topServicios.length === 0) {
        container.innerHTML = '<div class="empty-state small">No hay ventas registradas</div>';
        return;
    }
    
    let html = '';
    topServicios.forEach((serv, index) => {
        const rankIcon = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
        
        html += `
            <div class="top-service-item">
                <div class="top-service-rank">${rankIcon}</div>
                <div class="top-service-info">
                    <span class="top-service-name">${escapeHtml(serv.nombre)}</span>
                    <div class="top-service-stats">
                        <span><i class="fas fa-shopping-bag"></i> ${serv.cantidad} ventas</span>
                        <span><i class="fas fa-dollar-sign"></i> ${formatearPeso(serv.total)}</span>
                    </div>
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
}

async function actualizarKPIs() {
    const ventas = await VentasManager.getAll();
    
    const totalVentas = ventas.length;
    const montoTotal = VentasManager.calcularTotal(ventas);
    const ticketPromedio = totalVentas > 0 ? montoTotal / totalVentas : 0;
    document.getElementById('kpi-ticket-promedio').textContent = formatearPeso(ticketPromedio);
    document.getElementById('kpi-total-ventas').textContent = totalVentas;
    
    const clientesUnicos = new Set(ventas.map(v => v.clienteEmail).filter(Boolean)).size;
    document.getElementById('kpi-clientes-unicos').textContent = clientesUnicos || '0';
    
    const diasSemana = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const conteoDias = [0, 0, 0, 0, 0, 0, 0];
    
    ventas.forEach(v => {
        const fecha = new Date(v.fechaVenta);
        const dia = fecha.getDay();
        conteoDias[dia]++;
    });
    
    let diaMax = 0;
    let maxVentas = 0;
    conteoDias.forEach((count, idx) => {
        if (count > maxVentas) {
            maxVentas = count;
            diaMax = idx;
        }
    });
    
    document.getElementById('kpi-dia-pico').textContent = maxVentas > 0 ? `${diasSemana[diaMax]}` : '-';
}

// ============================================
// GRÁFICO DE VENTAS - VERSIÓN CORREGIDA
// ============================================
let ventasChart = null;

// Cargar Chart.js bajo demanda (lazy) — el HTML solo deja el comentario
let _chartJsPromise = null;
function cargarChartJS() {
    if (window.Chart) return Promise.resolve();
    if (_chartJsPromise) return _chartJsPromise;
    _chartJsPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';
        s.onload = () => resolve();
        s.onerror = () => { _chartJsPromise = null; reject(new Error('No se pudo cargar Chart.js')); };
        document.head.appendChild(s);
    });
    return _chartJsPromise;
}

async function renderizarGraficoVentas() {
    const canvas = document.getElementById('ventas-chart');
    if (!canvas) {
        console.error('Canvas no encontrado');
        return;
    }

    // Asegurar que Chart.js esté disponible antes de dibujar
    try {
        await cargarChartJS();
    } catch (e) {
        console.error('[renderizarGraficoVentas] Error cargando Chart.js:', e);
        return;
    }
    
    // Destruir gráfico anterior si existe (API oficial de Chart.js v4: busca por canvas,
    // no por variable global — evita el error "Canvas is already in use" cuando el
    // dashboard se actualiza dos veces en paralelo)
    const chartExistente = window.Chart && window.Chart.getChart ? window.Chart.getChart(canvas) : null;
    if (chartExistente) {
        chartExistente.destroy();
    } else if (window.ventasChart) {
        window.ventasChart.destroy();
    }
    
    // Obtener ventas reales del tenant actual (VentasManager ya filtra por tenant_id)
    const ventas = await VentasManager.getAll(true);
    
    // Agrupar por día de la semana
    const diasSemana = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const ventasPorDia = [0, 0, 0, 0, 0, 0, 0];
    const conteoPorDia = [0, 0, 0, 0, 0, 0, 0];
    
    ventas.forEach(v => {
        const fecha = v.fecha || v.fechaVenta;
        if (!fecha) return;
        const dia = new Date(fecha).getDay(); // 0=Dom, 1=Lun...
        const precio = Number(v.monto || v.precio) || 0;
        ventasPorDia[dia] += precio;
        conteoPorDia[dia]++;
    });
    
    // Montos REALES por día de la semana (antes se multiplicaba el promedio
    // por 3 para "suavizar", lo que distorsionaba las barras; ahora cada
    // barra muestra el total real recaudado ese día de la semana)
    const datosGrafico = ventasPorDia.map((total) => Math.round(total));
    
    const ctx = canvas.getContext('2d');
    // Fix: el dashboard se renderiza 2 veces al iniciar; Chart.js exige
    // destruir el chart anterior antes de reusar el mismo canvas.
    if (window.ventasChart) {
        window.ventasChart.destroy();
    }
    window.ventasChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: diasSemana,
            datasets: [{
                label: 'Ventas ($)',
                data: datosGrafico,
                backgroundColor: 'rgba(179, 0, 255, 0.3)',
                borderColor: '#b300ff',
                borderWidth: 2,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        callback: v => '$' + v.toLocaleString('es-CL')
                    }
                }
            }
        }
    });
    
    console.log('✅ Gráfico de ventas actualizado con datos reales del tenant');
}
async function diagnosticarVentas() {
    console.log('🔍 DIAGNÓSTICO DE VENTAS');
    
    const ventas = await VentasManager.getAll();
    console.log('Total ventas:', ventas.length);
    
    if (ventas.length > 0) {
        console.log('Primera venta:', ventas[0]);
        console.log('Campos disponibles:', Object.keys(ventas[0]));
        
        // Verificar fechas
        ventas.forEach((v, i) => {
            console.log(`Venta ${i}: fechaVenta=${v.fechaVenta}, tipo=${typeof v.fechaVenta}`);
        });
    }
    
    return ventas;
}

// Ejecutar en consola: diagnosticarVentas()
window.diagnosticarVentas = diagnosticarVentas;

function aplicarFiltroFechas() {
    const fechaInicio = document.getElementById('fecha-inicio')?.value;
    const fechaFin = document.getElementById('fecha-fin')?.value;
    
    if (!fechaInicio || !fechaFin) {
        mostrarToast('Selecciona ambas fechas', 'warning');
        return;
    }
    
    const finDate = new Date(fechaFin);
    finDate.setHours(23, 59, 59, 999);
    
    VentasManager.getPorRango(fechaInicio, finDate.toISOString()).then(ventasFiltradas => {
        const totalFiltrado = VentasManager.calcularTotal(ventasFiltradas);
        mostrarToast(`${ventasFiltradas.length} ventas en el período: ${formatearPeso(totalFiltrado)}`, 'info');
        document.getElementById('valor-mensual').textContent = formatearPeso(totalFiltrado);
        document.getElementById('detalle-mensual').textContent = `${ventasFiltradas.length} ventas (filtradas)`;
    });
}

async function exportarVentasCSV() {
    const ventas = await VentasManager.getAll();
    
    if (ventas.length === 0) {
        mostrarToast('No hay ventas para exportar', 'warning');
        return;
    }
    
    const cabeceras = ['ID', 'Fecha Venta', 'Servicio', 'Cliente', 'Monto', 'Fecha Cita', 'Hora'];
    
    const filas = ventas.map(v => [
        v.id,
        new Date(v.fechaVenta).toLocaleDateString('es-CL'),
        v.servicioNombre,
        v.clienteNombre,
        v.monto,
        v.fecha,
        v.hora
    ]);
    
    const csvContent = [
        cabeceras.join(','),
        ...filas.map(f => f.map(cell => `"${cell}"`).join(','))
    ].join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    link.setAttribute('href', url);
    link.setAttribute('download', `ventas_${new Date().toISOString().slice(0,10)}.csv`);
    link.style.visibility = 'hidden';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    mostrarToast(`Exportadas ${ventas.length} ventas`, 'success');
}

function configurarDashboardEventos() {
    const btnAplicar = document.getElementById('btn-aplicar-filtro');
    const btnLimpiar = document.getElementById('btn-limpiar-filtro');
    const btnExportar = document.getElementById('btn-exportar-csv');
    const btnRefresh = document.getElementById('btn-refresh-dashboard');
    const btnGuia = document.getElementById('btn-guia-dashboard');

    if (btnGuia) {
        btnGuia.addEventListener('click', () => {
            const guia = document.getElementById('guia-dashboard');
            if (!guia) return;
            const visible = guia.style.display !== 'none';
            guia.style.display = visible ? 'none' : 'block';
            btnGuia.classList.toggle('active', !visible);
        });
    }
    
    if (btnAplicar) {
        btnAplicar.addEventListener('click', aplicarFiltroFechas);
    }
    
    if (btnLimpiar) {
        btnLimpiar.addEventListener('click', () => {
            document.getElementById('fecha-inicio').value = '';
            document.getElementById('fecha-fin').value = '';
            actualizarEstadisticasTriples();
        });
    }
    
    if (btnExportar) {
        btnExportar.addEventListener('click', exportarVentasCSV);
    }
    
    if (btnRefresh) {
        btnRefresh.addEventListener('click', () => {
            actualizarDashboardFinanzas();
            mostrarToast('Dashboard actualizado', 'success');
        });
    }
}

function inicializarFechasDashboard() {
    const hoy = new Date();
    const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    
    const inputInicio = document.getElementById('fecha-inicio');
    const inputFin = document.getElementById('fecha-fin');
    
    if (inputInicio) {
        inputInicio.value = inicioMes.toISOString().slice(0,10);
    }
    
    if (inputFin) {
        inputFin.value = hoy.toISOString().slice(0,10);
    }
}

// La inicialización del dashboard financiero ahora se hace en el
// handler DOMContentLoaded (bloque esAdminNormal), donde iniciarAdmin()
// ya está definido y la sesión está disponible.

window.actualizarDashboardFinanzas = actualizarDashboardFinanzas;
window.exportarVentasCSV = exportarVentasCSV;

// Funciones de limpieza (mantienen nombres)
async function limpiarCitasAntiguas() {
    await CitasManager.limpiar({ soloInvalidas: true });
}
window.limpiarCitasAntiguas = limpiarCitasAntiguas;

async function limpiarCitasCompletasYSinId() {
    await CitasManager.limpiar({ soloCompletadas: true, soloSinId: true });
}
window.limpiarCitasCompletasYSinId = limpiarCitasCompletasYSinId;

async function limpiarCitasVencidas() {
    await CitasManager.limpiar({ soloVencidas: true });
}
window.limpiarCitasVencidas = limpiarCitasVencidas;

async function sanearBaseDeDatos() {
    await CitasManager.sanear();
}
window.sanearBaseDeDatos = sanearBaseDeDatos;

/**
 * Finaliza una cita vía RPC `finalizar_cita`: archiva la venta en `ventas`
 * con el resultado ('completada' | 'no_asistio') SIEMPRE (cualquier fecha,
 * incluso hoy) y borra la cita. El check ✓ confirma la venta hecha; el X
 * (No Asistió) conserva el registro sin contar como ingreso.
 */
async function finalizarCitaConResultado(citaId, resultado) {
    try {
        const { data, error } = await supabaseClient.rpc('finalizar_cita', {
            p_cita_id: String(citaId),
            p_resultado: resultado
        });
        if (error) throw error;
        return !!(data && data.ok === true);
    } catch (e) {
        console.error('Error al finalizar la cita:', e);
        return false;
    }
}

async function finalizarCita(citaId) {
    const citas = await CitasManager.getAll();
    const cita = citas.find(c => String(c.id) === String(citaId));
    
    if (!cita) {
        mostrarToast('Cita no encontrada', 'error');
        return;
    }

    const nombreCliente = cita.contacto?.nombre || cita.nombreCliente || 'el cliente';
    if (!confirm(`¿Marcar como completada la cita de ${nombreCliente}? Se eliminará de la lista y se registrará la venta.`)) {
        return;
    }

    if (await finalizarCitaConResultado(citaId, 'completada')) {
        // El RPC finalizar_cita archivó la venta en `ventas` (resultado
        // 'completada') ANTES de borrar la cita — cualquier fecha, incluso
        // hoy. El trigger trg_archivar_venta ya no la duplica (guard de
        // idempotencia por cita_id).
        if (typeof renderAdminAppointments === 'function') renderAdminAppointments();
        if (typeof updateProjectedRevenue === 'function') updateProjectedRevenue();
        if (typeof actualizarDashboardFinanzas === 'function') actualizarDashboardFinanzas();
        
        mostrarToast('Servicio completado. Ingresos actualizados', 'success');
    }
}
window.finalizarCita = finalizarCita;

async function noAsistioCita(citaId) {
    const citas = await CitasManager.getAll();
    const cita = citas.find(c => String(c.id) === String(citaId));
    
    if (!cita) {
        mostrarToast('Cita no encontrada', 'error');
        return;
    }

    if (!confirm(`¿Confirmas que ${cita.contacto?.nombre || cita.nombreCliente || 'el cliente'} NO ASISTIÓ a su cita?`)) {
        return;
    }

    try {
        const servicios = await ServiciosManager.getAll();
        const sIdx = servicios.findIndex(s => s && String(s.id) === String(cita.servicioId));
        
        if (sIdx !== -1) {
            const servicio = servicios[sIdx];
            const fecha = cita.fecha;
            
            if (servicio.disponibilidad && servicio.disponibilidad[fecha]) {
                const targetHora = String(cita.hora || '').trim();
                
                for (let mi = 0; mi < servicio.disponibilidad[fecha].length; mi++) {
                    const m = servicio.disponibilidad[fecha][mi];
                    const horaText = formatTimeDisplay(m.hora || m.startTime || '00:00');
                    
                    if (horaText === targetHora) {
                        servicio.disponibilidad[fecha][mi].cupos = (Number(m.cupos || 0) + 1);
                        break;
                    }
                }
            }
            
            servicios[sIdx] = servicio;
            await ServiciosManager.save(servicio);
        }
    } catch (e) { 
        console.warn('No se pudo devolver cupo al servicio', e); 
    }

    if (await finalizarCitaConResultado(citaId, 'no_asistio')) {
        if (typeof renderAdminAppointments === 'function') renderAdminAppointments();
        if (typeof updateProjectedRevenue === 'function') updateProjectedRevenue();
        if (typeof renderCarrito === 'function') renderCarrito();
        // El registro queda archivado en `ventas` como 'no_asistio'
        // (conservado, pero NO cuenta como ingreso en el dashboard).
        
        mostrarToast('Cita marcada como No Asistió. Cupo liberado.', 'info');
    }
}
window.noAsistioCita = noAsistioCita;

// ============================================
// RENDERIZADO DE NOTIFICACIONES (modificado para async)
// ============================================
async function renderNotificaciones(lista, containerId, todasLasCitas) {
    // Usar el contenedor del popover por defecto, o el que se pase
    const targetId = containerId || 'notif-popover-list';
    const container = document.getElementById(targetId);
    if (!container) {
        // Fallback: intentar con el notifications-list legacy
        const legacy = document.getElementById('notifications-list');
        if (legacy) return renderNotificaciones(lista, 'notifications-list');
        console.warn('[renderNotificaciones] No hay contenedor disponible');
        return;
    }

    const notifsAdmin = await NotificacionesAdminManager.getAll();
    // Filtrar notificaciones cuya cita ya no existe (ej. servicio eliminado en
    // admin: sus citas se borran y la notificacion de reserva queda huerfana).
    const citasValidas = todasLasCitas || await CitasManager.getAll();
    const idsCitasValidas = new Set(citasValidas.map(c => String(c.id)));
    const noLeidas = notifsAdmin.filter(n => !n.leido && (!n.citaId || idsCitasValidas.has(String(n.citaId))));

    // Dedupe defensivo: si una cita ya tiene su notificación en notificaciones_admin,
    // no mostrar el item morado "Nueva reserva" derivado de cita (evita el mismo
    // aviso 2 veces). Los recordatorios verdes de 24h (tipo 'proxima') se mantienen.
    const idsCitasConNotif = new Set(
        notifsAdmin
            .filter(n => n.tipo === 'nueva_reserva' && n.citaId)
            .map(n => String(n.citaId))
    );

    const todas = [
        ...lista.filter(c => !(c.tipo === 'nueva' && idsCitasConNotif.has(String(c.id)))).map(c => ({ ...c, tipoOrigen: 'reserva' })),
        ...noLeidas.map(n => ({ ...n, tipoOrigen: 'cambio' }))
    ];

    if (todas.length === 0) {
        container.innerHTML = '<p class="empty">✨ No hay notificaciones pendientes</p>';
        return;
    }

    // Servicios expirados PRIMERO, como bloque aparte ("Tus servicios");
    // el resto ordenado por fecha (más reciente arriba).
    todas.sort((a, b) => {
        const aExp = a.tipo === 'servicio-expirado' ? 1 : 0;
        const bExp = b.tipo === 'servicio-expirado' ? 1 : 0;
        if (aExp !== bExp) return bExp - aExp;
        return new Date(b.creadoEn || 0) - new Date(a.creadoEn || 0);
    });

    let html = '';
    let headerServiciosPuesto = false;
    todas.forEach(item => {
        if (item.tipo === 'servicio-expirado' && !headerServiciosPuesto) {
            headerServiciosPuesto = true;
            const cantExpirados = todas.filter(i => i.tipo === 'servicio-expirado').length;
            html += `
                <div style="display:flex;align-items:center;gap:6px;padding:8px 12px;background:rgba(255,23,68,0.12);border-bottom:1px solid rgba(255,23,68,0.25);font-size:0.72rem;font-weight:700;color:#ff6b81;text-transform:uppercase;letter-spacing:0.4px;">
                    <i class="fas fa-hourglass-end"></i> Tus servicios — ${cantExpirados} expirado(s)
                </div>
            `;
        }
        if (item.tipoOrigen === 'reserva') {
            const nombre = item.contacto?.nombre || item.nombreCliente || 'Cliente';
            const telefono = item.contacto?.telefono || item.telefonoCliente || '';
            const email = item.contacto?.email || '';
            const servicio = item.nombre || item.servicioNombre || 'Servicio';
            const fecha = item.fecha || '—';
            const hora = item.hora || '—';
            const tieneFechaHora = fecha !== '—' && hora !== '—';

            const tipoTexto = item.tipo === 'nueva' ? '🆕 Nueva reserva' : '⏰ Próxima cita (24h)';
            const claseTipo = item.tipo === 'nueva' ? 'new-reservation' : 'upcoming';

            const asuntoEmail = encodeURIComponent(`Confirmación de reserva: ${servicio}`);
            const cuerpoEmail = encodeURIComponent(`Hola ${nombre},\n\nTe confirmamos tu reserva para ${servicio} el ${fecha} a las ${hora}.\n\nGracias.`);
            const mailtoLink = `mailto:${email}?subject=${asuntoEmail}&body=${cuerpoEmail}`;

            const mensajeWhatsApp = encodeURIComponent(`Hola ${nombre}, recordatorio: tienes una cita de ${servicio} el ${fecha} a las ${hora}.`);
            const waLink = `https://wa.me/${telefono.replace(/\D/g, '')}?text=${mensajeWhatsApp}`;

            html += `
                <div class="notification-item ${claseTipo} ${item.tipo === 'nueva' ? 'notif-email' : 'notif-whatsapp'}" data-cita-id="${item.id}" data-origen="reserva">
                    <div class="notification-info">
                        <strong>${tipoTexto}</strong>
                        <span>${nombre} - ${servicio} - ${fecha} ${hora}</span>
                    </div>
                    <div class="notification-actions">
                        ${tieneFechaHora && email ? `<a href="${mailtoLink}" target="_blank" class="btn-notify email" data-tipo="email"><i class="fas fa-envelope"></i> Email</a>` : ''}
                        ${tieneFechaHora && telefono ? `<a href="${waLink}" target="_blank" class="btn-notify whatsapp" data-tipo="whatsapp"><i class="fab fa-whatsapp"></i> WhatsApp</a>` : ''}
                        <button class="btn-notify eliminar" data-accion="eliminar-cita" title="Quitar de notificaciones"><i class="fas fa-trash"></i></button>
                    </div>
                </div>
            `;
        } else if (item.tipo === 'nueva_reserva') {
            const cliente = item.cliente || {};
            const nombre = cliente.nombre || 'Cliente';
            const telefono = cliente.telefono || '';
            const email = cliente.email || '';
            const meta = item.metadata || {};
            const servicio = meta.servicio || 'Servicio';
            const fecha = meta.fecha || item.fecha_original || '—';
            const hora = meta.hora || item.hora_original || '—';
            const tieneFechaHora = fecha !== '—' && hora !== '—';

            // Ocultar reservas cuya fecha/hora ya ocurrió: solo quedan tareas pendientes
            if (tieneFechaHora) {
                try {
                    const partes = fecha.split('-');
                    if (partes.length === 3) {
                        const fd = new Date(parseInt(partes[0]), parseInt(partes[1]) - 1, parseInt(partes[2]));
                        const hp = String(hora).match(/(\d{1,2}):(\d{2})/);
                        if (hp) fd.setHours(parseInt(hp[1]), parseInt(hp[2]), 0, 0);
                        if (fd - new Date() <= 0) return;
                    }
                } catch (e) { /* si no se puede parsear, se muestra igual */ }
            }

            const asuntoEmail = encodeURIComponent(`Confirmación de reserva: ${servicio}`);
            const cuerpoEmail = encodeURIComponent(`Hola ${nombre},\n\nTe confirmamos tu reserva para ${servicio} el ${fecha} a las ${hora}.\n\nGracias.`);
            const mailtoLink = `mailto:${email}?subject=${asuntoEmail}&body=${cuerpoEmail}`;

            const mensajeWhatsApp = encodeURIComponent(`Hola ${nombre}, recordatorio: tienes una cita de ${servicio} el ${fecha} a las ${hora}.`);
            const waLink = `https://wa.me/${telefono.replace(/\D/g, '')}?text=${mensajeWhatsApp}`;

            html += `
                <div class="notification-item new-reservation notif-email" data-notif-id="${item.id}" data-origen="cambio">
                    <div class="notification-info">
                        <strong>🆕 Nueva reserva</strong>
                        <span>${nombre} - ${servicio} - ${fecha} ${hora}</span>
                    </div>
                    <div class="notification-actions">
                        ${tieneFechaHora && email ? `<a href="${mailtoLink}" target="_blank" class="btn-notify email" data-tipo="email"><i class="fas fa-envelope"></i> Email</a>` : ''}
                        ${tieneFechaHora && telefono ? `<a href="${waLink}" target="_blank" class="btn-notify whatsapp" data-tipo="whatsapp"><i class="fab fa-whatsapp"></i> WhatsApp</a>` : ''}
                        <button class="btn-notify eliminar" data-accion="eliminar" title="Eliminar notificación"><i class="fas fa-trash"></i></button>
                    </div>
                </div>
            `;
        } else if (item.tipo === 'servicio-expirado') {
            // Aviso de servicio expirado: la card desapareció del listado,
            // el admin puede agregar nuevas fechas desde aquí.
            const meta = item.metadata || {};
            const nombreServ = meta.servicio_nombre || (item.cliente && item.cliente.nombre) || 'Servicio';

            html += `
                <div class="notification-item admin-change" style="border-left:3px solid #ff1744;" data-notif-id="${item.id}" data-origen="cambio">
                    <div class="notification-info">
                        <strong><i class="fas fa-hourglass-end"></i> Servicio expirado</strong>
                        <span>${escapeHtml(nombreServ)}</span>
                        <small style="display:block; font-size:0.8rem; opacity:0.8;">Todas sus fechas y horarios ya pasaron. Agrega nuevas fechas para que vuelva a estar disponible.</small>
                    </div>
                    <div class="notification-actions">
                        <button class="btn-notify editar-servicio" data-accion="editar-servicio" data-servicio-db-id="${meta.servicio_id || ''}"><i class="fas fa-calendar-plus"></i> Dar más fechas</button>
                        <button class="btn-notify eliminar" data-accion="eliminar-servicio" data-servicio-db-id="${meta.servicio_id || ''}" title="Eliminar servicio"><i class="fas fa-trash"></i> Eliminar</button>
                    </div>
                </div>
            `;
        } else {
            // Cambio admin
            const cliente = item.cliente || {};
            const nombre = cliente.nombre || 'Cliente';
            const telefono = cliente.telefono || '';
            const email = cliente.email || '';
            
            const fechaOrig = item.fechaOriginal || '—';
            const horaOrig = item.horaOriginal || '—';
            const fechaNueva = item.fechaNueva || '—';
            const horaNueva = item.horaNueva || '—';

            const mensajeWhatsApp = encodeURIComponent(`Hola ${nombre}, te informamos que tu cita ha sido reprogramada por el administrador.\n\nNueva fecha: ${fechaNueva} a las ${horaNueva}\n\nSi tienes dudas, contáctanos.`);
            const waLink = `https://wa.me/${telefono.replace(/\D/g, '')}?text=${mensajeWhatsApp}`;

            const asuntoEmail = encodeURIComponent('Cambio en tu cita - Organify');
            const cuerpoEmail = encodeURIComponent(`Hola ${nombre},\n\nTe informamos que tu cita ha sido reprogramada por el administrador.\n\n📅 Fecha anterior: ${fechaOrig} ${horaOrig}\n📅 Nueva fecha: ${fechaNueva} ${horaNueva}\n\nSi tienes dudas, contáctanos.\n\nSaludos cordiales.`);
            const mailtoLink = `mailto:${email}?subject=${asuntoEmail}&body=${cuerpoEmail}`;

            html += `
                <div class="notification-item admin-change" data-notif-id="${item.id}" data-origen="cambio">
                    <div class="notification-info">
                        <strong><i class="fas fa-pen"></i> Cambio por administrador</strong>
                        <span>${nombre} - Cita reprogramada</span>
                        <small style="display:block; font-size:0.8rem; opacity:0.8;">
                            De: ${fechaOrig} ${horaOrig} → A: ${fechaNueva} ${horaNueva}
                        </small>
                    </div>
                    <div class="notification-actions">
                        ${email ? `<a href="${mailtoLink}" target="_blank" class="btn-notify email" data-tipo="email"><i class="fas fa-envelope"></i> Email</a>` : ''}
                        ${telefono ? `<a href="${waLink}" target="_blank" class="btn-notify whatsapp" data-tipo="whatsapp"><i class="fab fa-whatsapp"></i> WhatsApp</a>` : ''}
                        <button class="btn-notify eliminar" data-accion="eliminar" title="Eliminar notificación"><i class="fas fa-trash"></i></button>
                    </div>
                </div>
            `;
        }
    });

    container.innerHTML = html;

    // Garantizar scroll interno de la lista (estilos inline, gana a CSS cacheado)
    if (typeof window.forzarScrollNotifPopover === 'function') {
        window.forzarScrollNotifPopover();
    }

    // También actualizar el popover de notificaciones si existe
    const popoverList = document.getElementById('notif-popover-list');
    if (popoverList) {
        popoverList.innerHTML = html;
    }
    
    // Actualizar badge del popover
    const badge = document.getElementById('notif-badge-count');
    if (badge) {
        const noLeidas = todas.filter(n => !n.leido).length;
        const cantidad = noLeidas || todas.filter(n => n.tipoOrigen === 'reserva').length;
        if (cantidad > 0) {
            badge.textContent = cantidad;
            badge.style.display = 'flex';
        } else {
            badge.style.display = 'none';
        }
    }
}

function setupNotificacionesListeners() {
    // Intentar el contenedor del popover (actual)
    let container = document.getElementById('notif-popover-list');
    // Fallback al legacy
    if (!container) container = document.getElementById('notifications-list');
    if (!container) return;
    
    container.addEventListener('click', async function(e) {
        const btn = e.target.closest('.btn-notify');
        if (!btn) return;
        
        e.preventDefault();
        
        const notificacion = btn.closest('.notification-item');
        if (!notificacion) return;
        
        const origen = notificacion.dataset.origen;
        const citaId = notificacion.dataset.citaId;
        const notifId = notificacion.dataset.notifId;
        const tipo = btn.dataset.tipo;
        const accion = btn.dataset.accion;

        // ── Eliminar con DOBLE CONFIRMACIÓN (evita borrados por error) ──
        if (accion === 'eliminar' || accion === 'eliminar-cita') {
            // 1er clic: pedir confirmación inline (se cancela sola a los 4s)
            if (btn.dataset.confirmando !== '1') {
                btn.dataset.confirmando = '1';
                btn.classList.add('confirmando');
                btn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> ¿Seguro?';
                clearTimeout(btn._confirmTimeout);
                btn._confirmTimeout = setTimeout(() => {
                    delete btn.dataset.confirmando;
                    btn.classList.remove('confirmando');
                    btn.innerHTML = '<i class="fas fa-trash"></i>';
                }, 4000);
                return;
            }
            // 2do clic: ejecutar la eliminación
            clearTimeout(btn._confirmTimeout);
            delete btn.dataset.confirmando;
            btn.classList.remove('confirmando');
            btn.innerHTML = '<i class="fas fa-trash"></i>';

            if (accion === 'eliminar' && notifId) {
                await NotificacionesAdminManager.eliminar(notifId);
                if (typeof actualizarContadorNotificacionesAdmin === 'function') actualizarContadorNotificacionesAdmin();
                if (typeof generarNotificaciones === 'function') generarNotificaciones();
            } else if (accion === 'eliminar-cita' && citaId) {
                try {
                    const { error: updErr } = await supabaseClient
                        .from('citas')
                        .update({ notificaciones: { emailEnviado: true, whatsappEnviado: true } })
                        .eq('id', citaId);
                    if (updErr) console.error('Error ocultando cita de notificaciones:', updErr);
                } catch (e) {
                    console.error('Error ocultando cita de notificaciones:', e);
                }
                if (typeof generarNotificaciones === 'function') generarNotificaciones();
            }
            return;
        }

        // ── Acción: agregar fechas a un servicio expirado ──
        if (accion === 'editar-servicio') {
            const servicioId = btn.dataset.servicioDbId;
            if (servicioId && typeof editarServicio === 'function') {
                if (typeof closeNotifPopover === 'function') closeNotifPopover();
                editarServicio(servicioId);
            }
            return;
        }

        // ── Acción: eliminar el servicio expirado (DOBLE CONFIRMACIÓN) ──
        if (accion === 'eliminar-servicio') {
            const servicioId = btn.dataset.servicioDbId;
            if (!servicioId) return;
            // 1er clic: confirmación inline (se cancela sola a los 4s)
            if (btn.dataset.confirmando !== '1') {
                btn.dataset.confirmando = '1';
                btn.classList.add('confirmando');
                btn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> ¿Seguro?';
                clearTimeout(btn._confirmTimeout);
                btn._confirmTimeout = setTimeout(() => {
                    delete btn.dataset.confirmando;
                    btn.classList.remove('confirmando');
                    btn.innerHTML = '<i class="fas fa-trash"></i> Eliminar';
                }, 4000);
                return;
            }
            // 2do clic: ejecutar la eliminación (eliminarServicio pide su propio confirm)
            clearTimeout(btn._confirmTimeout);
            delete btn.dataset.confirmando;
            btn.classList.remove('confirmando');
            if (typeof closeNotifPopover === 'function') closeNotifPopover();
            if (typeof eliminarServicio === 'function') eliminarServicio(servicioId);
            return;
        }

        if (origen === 'reserva' && citaId) {
            // Notificación de cita desde tabla citas
            let citas = await CitasManager.getAll();
            const citaIndex = citas.findIndex(c => String(c.id) === String(citaId));
            if (citaIndex === -1) return;
            
            const cita = citas[citaIndex];
            const esNueva = notificacion.classList.contains('new-reservation');
            const esProxima = notificacion.classList.contains('upcoming');
            
            if (!cita.notificaciones) {
                cita.notificaciones = { emailEnviado: false, whatsappEnviado: false };
            }
            
            if (tipo === 'email' && esNueva) {
                cita.notificaciones.emailEnviado = true;
            } else if (tipo === 'whatsapp' && esProxima) {
                cita.notificaciones.whatsappEnviado = true;
            }
            
            citas[citaIndex] = cita;
            // UPDATE puro de notificaciones (20260901): el INSERT directo a
            // citas está cerrado en el servidor (las citas solo se crean vía
            // RPCs reservar_cita/reservar_citas_bulk). Aquí la cita YA existe,
            // solo se marca la notificación como enviada.
            const { error: updErr } = await supabaseClient
                .from('citas')
                .update({ notificaciones: cita.notificaciones })
                .eq('id', cita.id);
            if (updErr) {
                console.error('Error actualizando notificaciones de cita:', updErr);
            }
            
        } else if (origen === 'reserva' && notifId) {
            // Notificación de nueva_reserva desde tabla notificaciones_admin
            try {
                await supabaseClient
                    .from('notificaciones_admin')
                    .update({ leido: true })
                    .eq('id', notifId);
            } catch (e) {
                console.error('Error marcando notificación como leída:', e);
            }
        } else if (origen === 'cambio' && notifId) {
            await NotificacionesAdminManager.marcarComoLeido(notifId);
            
            if (typeof actualizarContadorNotificacionesAdmin === 'function') {
                actualizarContadorNotificacionesAdmin();
            }
        }
        
        const href = btn.getAttribute('href');
        if (href) {
            window.open(href, '_blank');
        }
        
        if (typeof generarNotificaciones === 'function') {
            generarNotificaciones();
        }
    });
}

async function generarNotificaciones() {
    // Sincronizar avisos de servicios expirados (idempotente): así la campana
    // muestra el bloque "Tus servicios" aunque el admin no haya abierto Mis Servicios.
    try {
        const serviciosSync = await ServiciosManager.getAll();
        const expiradosSync = (serviciosSync || [])
            .filter(s => calcularEstadoUrgenciaServicio(s).estado === 'expirado')
            .map(s => ({ id: s.id, nombre: s.nombre, activo: s.activo !== false }));
        await notificarServiciosExpirados(expiradosSync, true);
    } catch (e) {
        console.warn('Sync servicios expirados en campana:', e);
    }

    const citas = await CitasManager.getAll();
    const ahora = new Date();
    const limiteNuevas = 24 * 60 * 60 * 1000;

    const notifsAdmin = await NotificacionesAdminManager.getAll();
    const noLeidas = notifsAdmin.filter(n => !n.leido);

    // Las reservas confirmadas ya tienen su fila en notificaciones_admin
    // (creada por el RPC junto a la cita, con nombre real del servicio y
    // fecha/hora en metadata). Las citas con notificación propia se muestran
    // UNA sola vez (la de notificaciones_admin) — evita duplicados e items
    // sin datos en el popover.
    const citasConNotificacion = new Set(
        notifsAdmin
            .filter(n => n.tipo === 'nueva_reserva' && n.citaId)
            .map(n => String(n.citaId))
    );

    const nuevas = citas.filter(c => {
        const emailNoEnviado = !c.notificaciones || c.notificaciones.emailEnviado === false;
        if (!emailNoEnviado) return false;

        const creado = new Date(c.creadoEn || 0);
        if ((ahora - creado) > limiteNuevas) return false;

        // Solo reservas CONFIRMADAS: con cita y fecha/hora válidas (aún no ocurridas)
        if (citasConNotificacion.has(String(c.id))) return false;
        if (!c.fecha || !c.hora) return false;
        try {
            const citaDate = parseDate(c.fecha);
            const [h, m] = c.hora.split(':').map(Number);
            citaDate.setHours(h, m, 0, 0);
            if (citaDate - ahora <= 0) return false; // ya ocurrió → no notificar
        } catch {
            return false;
        }
        return true;
    });

    const proximas = citas.filter(c => {
        try {
            const whatsappNoEnviado = !c.notificaciones || c.notificaciones.whatsappEnviado === false;
            if (!whatsappNoEnviado) return false;
            
            let citaDate = parseDate(c.fecha);
            if (c.hora) {
                const [h, m] = c.hora.split(':').map(Number);
                citaDate.setHours(h, m, 0, 0);
            }
            const diff = citaDate - ahora;
            return diff > 0 && diff <= limiteNuevas;
        } catch {
            return false;
        }
    });

    const notificaciones = [
        ...nuevas.map(c => ({ ...c, tipo: 'nueva' })),
        ...proximas.map(c => ({ ...c, tipo: 'proxima' }))
    ];

    renderNotificaciones(notificaciones, null, citas);
}

// ============================================
// RENDERIZADO DE NOTIFICACIONES CAMBIOS ADMIN
// ============================================
async function renderNotificacionesCambiosAdmin() {
    const container = document.getElementById('admin-changes-list');
    if (!container) return;
    
    const notificaciones = await NotificacionesAdminManager.getAll();
    const noLeidas = notificaciones.filter(n => !n.leido);
    
    if (noLeidas.length === 0) {
        container.innerHTML = '<p class="empty">✨ No hay cambios pendientes de revisión</p>';
        return;
    }
    
    let html = '';
    noLeidas.sort((a, b) => new Date(b.creadoEn) - new Date(a.creadoEn));
    
    noLeidas.forEach(notif => {
        const fechaOriginal = new Date(notif.fechaOriginal).toLocaleDateString('es-ES');
        const fechaNueva = new Date(notif.fechaNueva).toLocaleDateString('es-ES');
        const clienteNombre = notif.cliente?.nombre || 'Cliente';
        
        html += `
            <div class="notification-item cambio-admin" data-notif-id="${notif.id}">
                <div class="notification-info">
                    <strong>🔄 Cambio de reserva</strong>
                    <span>${clienteNombre}</span>
                    <small>Original: ${fechaOriginal} ${notif.horaOriginal} → Nueva: ${fechaNueva} ${notif.horaNueva}</small>
                </div>
                <div class="notification-actions">
                    <button class="btn-notify mark-read" data-id="${notif.id}">
                        <i class="fas fa-check"></i> Marcar leído
                    </button>
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
    
    container.querySelectorAll('.mark-read').forEach(btn => {
        btn.addEventListener('click', async function() {
            const id = this.dataset.id;
            await NotificacionesAdminManager.marcarComoLeido(id);
            renderNotificacionesCambiosAdmin();
            actualizarContadorNotificacionesAdmin();
        });
    });
}

async function actualizarContadorNotificacionesAdmin() {
    const badge = document.getElementById('admin-notif-badge');
    if (!badge) return;
    
    const notificaciones = await NotificacionesAdminManager.getAll();
    const noLeidas = notificaciones.filter(n => !n.leido).length;
    
    if (noLeidas > 0) {
        badge.textContent = noLeidas;
        badge.style.display = 'flex';
    } else {
        badge.style.display = 'none';
    }
}

window.NotificacionesAdminManager = NotificacionesAdminManager;
window.crearNotificacionCambioAdmin = crearNotificacionCambioAdmin;
window.renderNotificacionesCambiosAdmin = renderNotificacionesCambiosAdmin;
window.actualizarContadorNotificacionesAdmin = actualizarContadorNotificacionesAdmin;

// Limpiar notificaciones antiguas al iniciar (se ejecuta en DOMContentLoaded con supabaseClient listo)

// ============================================
// SESIÓN Y PROTECCIÓN DE RUTAS (modificado para Supabase Auth)
// ============================================
async function getSession() {
    // PRIMERO: intentar leer desde JwtManager (localStorage, instantaneo)
    // Si hay JWT valido, no hacemos llamada HTTP a Supabase
    if (window.JwtManager) {
        const session = window.JwtManager.getSession();
        if (session && session.user) {
            // Sincronizar JWT con Supabase para que RLS funcionen
            if (window.supabaseClient && window.JwtManager.isTokenExpired()) {
                const refreshed = await window.JwtManager.refreshToken(window.supabaseClient);
                if (refreshed) {
                    const newToken = window.JwtManager.getAccessToken();
                    try {
                        await window.supabaseClient.auth.setSession({
                            access_token: newToken,
                            refresh_token: window.JwtManager.getRefreshToken() || newToken
                        });
                    } catch(e) {}
                } else {
                    return null;
                }
            } else if (window.supabaseClient && !window.JwtManager.isTokenExpired()) {
                try {
                    await window.supabaseClient.auth.setSession({
                        access_token: window.JwtManager.getAccessToken(),
                        refresh_token: window.JwtManager.getRefreshToken() || window.JwtManager.getAccessToken()
                    });
                } catch(e) {}
            }
            return session.user;
        }
    }

    // FALLBACK: llamada tradicional a Supabase (comportamiento original)
    try {
        console.log('Obteniendo sesión de Supabase...');
        console.log('supabaseClient existe:', !!supabaseClient);
        
        if (!supabaseClient) {
            console.error('supabaseClient no está inicializado');
            return null;
        }
        
        const { data: { session } } = await supabaseClient.auth.getSession();
        console.log('Sesión obtenida:', session ? {
            id: session.user.id,
            email: session.user.email,
            rol: session.user.user_metadata?.rol,
            nombre: session.user.user_metadata?.nombre
        } : '❌ No hay sesión');
        
        if (!session) return null;
        
        // Al obtener sesion de Supabase, tambien guardar en JwtManager
        if (window.JwtManager) {
            window.JwtManager.setTokens(session.access_token, session.refresh_token);
        }
        
        const userData = {
            id: session.user.id,
            nombre: session.user.user_metadata?.nombre || session.user.email?.split('@')[0] || 'Usuario',
            email: session.user.email,
            // Rol exclusivamente desde user_metadata (sin override por email)
            rol: session.user.user_metadata?.rol || 'cliente',
            tenant_id: session.user.user_metadata?.tenant_id,
            whatsapp: session.user.user_metadata?.whatsapp || ''
        };
        
        console.log('Datos de usuario procesados:', userData);
        return userData;
    } catch (e) {
        console.error('Error en getSession:', e);
        return null;
    }
}

async function verificarProteccionRutas() {
    try {
        const session = await getSession();
        const fullPath = window.location.pathname || '';
        const pathname = fullPath.split('/').pop() || '';

        console.log('Verificando ruta:', pathname, 'Sesión:', session ? '✅' : '❌', 'Rol:', session?.rol);

        // Si NO hay sesión
        if (!session) {
            // Permitir acceso a login.html, la raíz y cliente.html (link compartido).
            // cliente.html sin sesión es el flujo legítimo del cliente externo: entra
            // con ?tenant=XXX, el RPC set_tenant_anon valida que el tenant exista y
            // esté activo, y el RLS protege los datos. Antes se redirigía a login.html
            // y el catálogo + formulario de registro quedaban inalcanzables para
            // clientes externos (bug crítico verificado en prod).
            // También se permiten las URLs amigables SEO /p/:slug (rewrite de Vercel
            // sirve cliente.html pero el navegador mantiene /p/<slug> en la barra).
            const esRutaPublica = pathname === 'login.html' || pathname === '' || pathname === 'cliente.html' || /^\/p\//.test(fullPath);
            if (!esRutaPublica) {
                console.log('No hay sesión, redirigiendo a login');
                window.location.href = 'login.html';
            }
            return;
        }

        // Si HAY sesión
        if (session) {

            // ========== PLANES (SIEMPRE PERMITIDO) ==========
            // La página de planes es parte del onboarding (WhatsApp + plan).
            // Nunca redirigir desde aquí, independientemente del rol.
            if (pathname === 'planes.html') {
                console.log('[Rutas] planes.html — acceso libre');
                return;
            }
           
            // ========== ADMIN ==========
            if (pathname === 'admin.html') {
                // Permitir acceso si el usuario no tiene tenant_id (para que pueda asignarse)
                // Si ya tiene tenant_id y no es admin, redirigir a cliente
                if (session.tenant_id && session.rol !== 'admin') {
                    window.location.href = 'cliente.html';
                }
                // Si no tiene tenant_id, permitir que entre a admin.html (aunque sea cliente)
                return;
            }

            // ========== SUPERADMIN (rol "super_admin") ==========
            if (pathname === 'superadmin.html') {
                if (session.rol !== 'super_admin') {
                    console.log('No eres superadmin, redirigiendo a cliente');
                    window.location.href = 'cliente.html';
                }
                return;
            }

            // Si es super_admin, solo puede ver superadmin.html — PERO las rutas
            // públicas del cliente (cliente.html y /p/:slug) quedan accesibles:
            // son la página que ven los clientes externos y el superadmin debe
            // poder abrirla desde las cards del directorio/portada (botón
            // "Reservar hora"). Sin esto, /p/:slug redirige a superadmin.html y
            // el pathname ya cambiado hace que iniciarCliente lea "superadmin.html"
            // como slug → "Negocio no encontrado".
            if (session.rol === 'super_admin') {
                const esRutaPublicaCliente = pathname === 'cliente.html' || /^\/p\//.test(fullPath);
                if (pathname !== 'superadmin.html' && pathname !== 'login.html' && !esRutaPublicaCliente) {
                    window.location.href = 'superadmin.html';
                }
                return;
            }

            // ========== LOGIN / RAÍZ ==========
            if (pathname === 'login.html' || pathname === '') {
                if (session.rol === 'super_admin') {
                    console.log('Sesión activa como superadmin, redirigiendo a superadmin');
                    window.location.href = 'superadmin.html';
                } else if (session.rol === 'admin') {
                    console.log('Sesión activa como admin, redirigiendo a admin');
                    window.location.href = 'admin.html';
                } else {
                    console.log('Sesión activa como cliente, redirigiendo a cliente');
                    window.location.href = 'cliente.html';
                }
            }
        }

    } catch (err) {
        console.error('verificarProteccionRutas error', err);
    }
}
window.verificarProteccionRutas = verificarProteccionRutas;

// ============================================
// SISTEMA DE NOTIFICACIONES (Toast) - sin cambios
// ============================================
function mostrarToast(mensaje, tipo = 'info') {
    try {
        let container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            container.style.cssText = 'position:fixed;top:16px;right:16px;display:flex;flex-direction:column;gap:10px;z-index:10000;max-width:380px;pointer-events:none;';
            document.body.appendChild(container);
        }

        if (!document.getElementById('toast-styles')) {
            const s = document.createElement('style');
            s.id = 'toast-styles';
            s.innerHTML = `
                @keyframes toastFadeIn { from { transform: translateX(12px); opacity: 0 } to { transform: translateX(0); opacity: 1 } }
                @keyframes toastFadeOut { from { transform: translateX(0); opacity: 1 } to { transform: translateX(12px); opacity: 0 } }
                .toast-item { transition: transform 260ms ease, opacity 260ms ease; }
            `;
            document.head.appendChild(s);
        }

        const palette = {
            success: { bg: 'linear-gradient(180deg, rgba(0,184,148,0.10), rgba(0,184,148,0.04))', border: 'rgba(0,184,148,0.9)', color: '#0f5132' },
            error: { bg: 'linear-gradient(180deg, rgba(231,76,60,0.10), rgba(231,76,60,0.04))', border: 'rgba(231,76,60,0.9)', color: '#5f1412' },
            info: { bg: 'linear-gradient(180deg, rgba(30,30,40,0.08), rgba(30,30,40,0.03))', border: 'rgba(30,30,40,0.7)', color: '#ffffff' }
        };
        const style = palette[tipo] || palette.info;

        const toast = document.createElement('div');
        toast.className = 'toast-item';
        toast.style.cssText = `pointer-events:auto;display:flex;gap:12px;align-items:center;padding:12px 14px;border-radius:12px;background:${style.bg};color:${style.color};backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid ${style.border};box-shadow:0 10px 30px rgba(8,12,20,0.12);max-width:360px;opacity:0;transform:translateX(12px);`;

        const icons = { success: 'check-circle', error: 'exclamation-circle', info: 'info-circle' };
        const icon = icons[tipo] || icons.info;

        const iconEl = document.createElement('i');
        iconEl.className = `fas fa-${icon}`;
        iconEl.style.cssText = 'font-size:18px;opacity:0.95;min-width:20px;text-align:center;';

        const content = document.createElement('div');
        content.style.cssText = 'flex:1;font-size:14px;line-height:1.25;';
        content.innerHTML = escapeHtml(String(mensaje));

        toast.appendChild(iconEl);
        toast.appendChild(content);
        container.appendChild(toast);

        requestAnimationFrame(() => {
            toast.style.opacity = '1';
            toast.style.transform = 'translateX(0)';
        });

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(12px)';
            setTimeout(() => toast.remove(), 260);
        }, 3500);

        return toast;
    } catch (err) {
        console.error('mostrarToast error', err);
    }
}
window.mostrarToast = mostrarToast;
window.mostrarMensaje = function (mensaje, tipo = 'info') { return mostrarToast(mensaje, tipo); };
window.alert = function (mensaje) { return mostrarToast(mensaje, 'info'); };

// ============================================
// FUNCIONES DE ADMIN (modificadas para async)
// ============================================
function diagnosticarDatos() {
    // No necesario en Supabase
}
window.diagnosticarDatos = diagnosticarDatos;

async function iniciarAdmin() {
    console.log('Iniciando admin...');

    // ========== ESPERAR SESIÓN ACTIVA ==========
    // Supabase a veces tarda en restaurar la sesión desde localStorage.
    // Este bucle espera hasta 5 segundos a que la sesión esté disponible.
    let sessionData = null;
    for (let i = 0; i < 10; i++) {
        sessionData = await getSession();
        if (sessionData && sessionData.id) {
            break;
        }
        console.log(`⏳ Esperando sesión... intento ${i + 1}/10`);
        await new Promise(r => setTimeout(r, 500));
    }
    if (!sessionData) {
        console.error('❌ No se pudo restaurar la sesión después de 5 segundos');
        window.location.href = 'login.html';
        return;
    }
    console.log('✅ Sesión restaurada correctamente');
    
    // Asignar currentTenantId para que ServiciosManager etc. lo usen
    if (sessionData.tenant_id) {
        window.currentTenantId = sessionData.tenant_id;
        console.log('✅ currentTenantId asignado:', window.currentTenantId);
    }
    // =============================================

    // ========== NUEVO: Cargar configuración visual del tenant ==========
    let visualConfig = null;
    try {
        visualConfig = await VisualConfigManager.loadConfig();
        VisualConfigManager.applyStyles(visualConfig);
    } catch (err) {
        console.warn('Error al cargar configuración visual:', err);
        visualConfig = VisualConfigManager.getDefaultConfig();
    }

    // ========== CONFIGURACIÓN VISUAL: inicializar panel completo ==========
    VisualConfigManager.initFontSelector();
    VisualConfigManager.renderThemePresets();
    VisualConfigManager.applyConfigToForm(visualConfig);
    VisualConfigManager.connectLivePreview();

    // ========== Verificar plan de suscripción y restringir personalización ==========
    let suscripcion = null;
    let esPlanPago = false;
    try {
        suscripcion = await SuscripcionManager.getCurrent();
        esPlanPago = suscripcion && (suscripcion.plan === 'pro' || suscripcion.plan === 'premium_anual' || suscripcion.plan === 'freemium');
    } catch(e) {
        console.warn('Error obteniendo suscripción:', e);
    }

    // ========== VERIFICAR EXPIRACIÓN DE SUSCRIPCIÓN ==========
    // Si la suscripción tiene end_date en el pasado, el tenant queda bloqueado
    // hasta que el superadmin o el usuario renueve.
    if (suscripcion && suscripcion.end_date) {
        const ahora = new Date();
        const fin = new Date(suscripcion.end_date);
        if (fin < ahora) {
            console.log('[Admin] Suscripción expirada el', suscripcion.end_date);
            mostrarPantallaExpiracion(suscripcion, fin);
            return; // Detener toda la inicialización del admin
        }
    }

    // Caso 2: Sin suscripción activa (el cron ya marcó como 'inactive')
    // Verificar si había una suscripción que expiró
    if (!suscripcion) {
        try {
            const tenantId = await getCurrentTenantId();
            if (tenantId) {
                const historial = await SuscripcionManager.getAllForTenant(tenantId);
                const ultima = historial?.[0]; // ORDER BY start_date DESC
                if (ultima && ultima.status === 'inactive' && ultima.end_date && new Date(ultima.end_date) < new Date()) {
                    console.log('[Admin] Suscripción expirada (ya marcada como inactive):', ultima.end_date);
                    mostrarPantallaExpiracion(ultima, new Date(ultima.end_date));
                    return;
                }
            }
        } catch (e) {
            console.warn('[Admin] Error verificando historial de suscripción:', e);
        }
    }
    // ==========================================================

    const allCustomFields = [
        'cfg-primary', 'cfg-secondary', 'cfg-bg', 'cfg-text', 'cfg-card', 'cfg-border',
        'cfg-theme-mode', 'cfg-font', 'cfg-radius', 'cfg-anim-speed',
        'cfg-logo', 'cfg-favicon', 'cfg-cover', 'custom-css'
    ];

    if (!esPlanPago) {
        // Deshabilitar todos los campos y botones
        allCustomFields.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.disabled = true;
        });
        const saveBtn = document.getElementById('cfg-save-btn');
        const resetBtn = document.getElementById('cfg-reset-btn');
        const previewBtn = document.getElementById('cfg-preview-btn');
        if (saveBtn) saveBtn.disabled = true;
        if (resetBtn) resetBtn.disabled = true;
        if (previewBtn) previewBtn.disabled = true;
        // Temas también deshabilitados visualmente
        document.querySelectorAll('.tema-card, .tema-btn').forEach(c => {
            c.style.opacity = '0.4';
            c.style.pointerEvents = 'none';
        });
        // Mostrar mensaje de upgrade
        let upgradeMsg = document.getElementById('upgrade-message');
        if (!upgradeMsg) {
            upgradeMsg = document.createElement('div');
            upgradeMsg.id = 'upgrade-message';
            upgradeMsg.className = 'warning-message';
            upgradeMsg.style.cssText = 'background: rgba(255,193,7,0.2); border-left: 4px solid #ffc107; padding: 12px; margin: 0 0 15px 0; border-radius: 8px;';
            upgradeMsg.innerHTML = `⚠️ <strong>Personalización visual disponible en planes Pro y Premium.</strong> <a href="planes.html" style="color: #ffc107;">Actualiza tu plan aquí</a>`;
            const form = document.getElementById('customization-form');
            if (form) form.parentNode.insertBefore(upgradeMsg, form);
        }
    } else {
        allCustomFields.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.disabled = false;
        });
        const saveBtn = document.getElementById('cfg-save-btn');
        const resetBtn = document.getElementById('cfg-reset-btn');
        const previewBtn = document.getElementById('cfg-preview-btn');
        if (saveBtn) saveBtn.disabled = false;
        if (resetBtn) resetBtn.disabled = false;
        if (previewBtn) previewBtn.disabled = false;
        document.querySelectorAll('.tema-card, .tema-btn').forEach(c => {
            c.style.opacity = '1';
            c.style.pointerEvents = 'auto';
        });
        const existingMsg = document.getElementById('upgrade-message');
        if (existingMsg) existingMsg.remove();
    }

    // ========== Mostrar/ocultar botón de solicitud CSS según plan ==========
    const solicitarContainer = document.getElementById('solicitar-css-container');
    if (solicitarContainer) {
        solicitarContainer.style.display = esPlanPago ? 'block' : 'none';
    }
    // Configurar evento del botón
    const btnSolicitar = document.getElementById('btn-solicitar-css');
    const modalSolicitud = document.getElementById('modal-solicitud-css');
    const closeModal = document.getElementById('close-solicitud-modal');
    const cancelarSolicitud = document.getElementById('cancelar-solicitud');
    const enviarBtn = document.getElementById('enviar-solicitud');

    if (btnSolicitar && modalSolicitud) {
        btnSolicitar.onclick = () => { modalSolicitud.style.display = 'flex'; };
        if (closeModal) closeModal.onclick = () => { modalSolicitud.style.display = 'none'; };
        if (cancelarSolicitud) cancelarSolicitud.onclick = () => { modalSolicitud.style.display = 'none'; };
        if (enviarBtn) {
            enviarBtn.onclick = async () => {
                const ok = await enviarSolicitudCSS();
                if (ok) modalSolicitud.style.display = 'none';
                const descInput = document.getElementById('solicitud-descripcion');
                if (descInput) descInput.value = '';
            };
        }
    }

    // ================================================================
    // PASO 1: OBTENER SESIÓN
    // ================================================================
    let session = await getSession();

    // Retry OAuth (hasta 3s)
    if (!session) {
        console.log('[AuthGuard] Sin sesión inmediata. Esperando OAuth...');
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 200));
            session = await getSession();
            if (session) { console.log('[AuthGuard] Sesión obtenida tras espera:', session.rol); break; }
        }
    }

    if (!session) {
        console.log('[AuthGuard] No hay sesión, redirigiendo...');
        window.location.href = 'login.html';
        return;
    }

    // ================================================================
    // BYPASS SUPERADMIN: super@demo.com NO necesita WhatsApp ni tenant
    // ================================================================
    if (session.email === 'super@demo.com') {
        console.log('[AuthGuard] Superadmin detectado, redirigiendo a superadmin.html');
        // Asegurar JWT con rol super_admin
        await supabaseClient.auth.updateUser({
            data: { rol: 'super_admin', tenant_id: null, whatsapp: '' }
        }).catch(() => {});
        await supabaseClient.auth.refreshSession();
        const { data: { session: freshS } } = await supabaseClient.auth.getSession();
        if (freshS && window.JwtManager) window.JwtManager.setTokens(freshS.access_token, freshS.refresh_token);
        window.location.href = 'superadmin.html';
        return;
    }

    // ================================================================
    // PASO 2: BUSCAR TENANT EN BD (siempre priorizando BD sobre JWT)
    // ================================================================
    let tenantBD = null;
    let tenantError = null;

    try {
        const result = await supabaseClient
            .from('tenants')
            .select('id, whatsapp, nombre_negocio')
            .eq('email_contacto', session.email)
            // Si hay tenants duplicados del mismo email (pruebas/errores), tomar el
            // más reciente en vez de fallar: maybeSingle() con 2+ filas devuelve error
            // 406 y el usuario ve "Error al verificar tu cuenta" sin poder entrar.
            .order('fecha_registro', { ascending: false })
            .limit(1)
            .maybeSingle();
        tenantBD = result.data;
        tenantError = result.error;
    } catch (e) {
        console.error('[ERROR SUPABASE FLUJO TENANT SELECT]:', e.message || e);
        tenantError = e;
    }

    if (tenantError) {
        console.error('[AuthGuard] Error buscando tenant:', tenantError);
        mostrarToast('Error al verificar tu cuenta.', 'error');
        await supabaseClient.auth.signOut();
        window.location.href = 'login.html';
        return;
    }

    // ================================================================
    // PASO 3: DECIDIR SEGÚN EXISTENCIA DEL TENANT
    // ================================================================

    // --- CASO A: NO EXISTE TENANT → CREAR NUEVO ---
    if (!tenantBD) {
        console.log('[AuthGuard] CASO A: No existe tenant. Creando uno nuevo...');
        const nombreNegocio = session.nombre || session.email.split('@')[0];

        let newTenant = null;
        try {
            // Usar RPC con SECURITY DEFINER para bypassear bloqueo ES256
            const { data: rpcResult, error: rpcError } = await supabaseClient
                .rpc('crear_tenant_completo', {
                    p_nombre_negocio: nombreNegocio,
                    p_email_contacto: session.email,
                    p_whatsapp: null
                });
            if (rpcError) throw rpcError;
            if (!rpcResult || !rpcResult.id) throw new Error('RPC no retornó tenant');
            newTenant = rpcResult;
        } catch (e) {
            console.error('[ERROR SUPABASE FLUJO TENANT INSERT]:', e.message || e);
            mostrarToast('Error al crear tu negocio.', 'error');
            await supabaseClient.auth.signOut();
            window.location.href = 'login.html';
            return;
        }

        // Actualizar JWT con tenant_id + rol admin
        const { error: upErr } = await supabaseClient.auth.updateUser({
            data: { tenant_id: newTenant.id, rol: 'admin', nombre: session.nombre || session.email.split('@')[0] }
        });
        if (upErr) { console.error('[AuthGuard] Error updateUser:', upErr); /* non-fatal */ }

        await supabaseClient.auth.refreshSession();
        // Sincronizar JwtManager
        const { data: { session: freshS } } = await supabaseClient.auth.getSession();
        if (freshS && window.JwtManager) window.JwtManager.setTokens(freshS.access_token, freshS.refresh_token);

        console.log('[AuthGuard] CASO A → redirect a planes.html (WhatsApp)');
        // new=true es OBLIGATORIO: cargarPlanes oculta el Free Trial (soloNuevos)
        // si la URL no trae new=true. El registro normal lo pasa; el retorno OAuth
        // de Google (cuenta nueva) debe pasarlo también para que el usuario vea
        // el plan Free Trial (14 días) y no solo los planes de pago.
        window.location.href = `planes.html?tenant_id=${newTenant.id}&pending_whatsapp=true&new=true`;
        return;
    }

    // --- CASO B: EXISTE TENANT → sincronizar JWT con datos reales de BD ---
    console.log('[AuthGuard] CASO B: Tenant existe en BD. whatsapp:', tenantBD.whatsapp ? '✅' : '❌');

    // Mostrar el nombre del negocio en el header
    const tenantNameEl = document.getElementById('tenant-name-display');
    if (tenantNameEl && tenantBD.nombre_negocio) {
        tenantNameEl.textContent = tenantBD.nombre_negocio;
    }

    // Sincronizar JWT con datos reales del tenant (whatsapp desde BD)
    const { error: syncErr } = await supabaseClient.auth.updateUser({
        data: {
            tenant_id: tenantBD.id,
            rol: 'admin',
            whatsapp: tenantBD.whatsapp || '',
            nombre: session.nombre || session.email.split('@')[0]
        }
    });
    if (syncErr) console.warn('[AuthGuard] Error sincronizando JWT:', syncErr);

    await supabaseClient.auth.refreshSession();
    const { data: { session: freshS2 } } = await supabaseClient.auth.getSession();
    if (freshS2 && window.JwtManager) window.JwtManager.setTokens(freshS2.access_token, freshS2.refresh_token);

    // Releer sesión fresca
    session = await getSession();

    // --- SUBCASO B1: SIN WHATSAPP → redirigir a planes.html para ingresarlo ---
    if (!tenantBD.whatsapp) {
        console.log('[AuthGuard] CASO B1: Sin WhatsApp → planes.html');
        window.location.href = `planes.html?tenant_id=${tenantBD.id}&pending_whatsapp=true`;
        return;
    }

    // --- SUBCASO B0: TENANT DESACTIVADO por superadmin ---
    if (tenantBD.estado === 'inactivo') {
        console.log('[AuthGuard] CASO B0: Tenant desactivado → planes.html');
        window.location.href = `planes.html?tenant_id=${tenantBD.id}&suspended=true`;
        return;
    }

    // --- SUBCASO B2: CON WHATSAPP → verificar suscripción activa ---
    let suscripcionActiva = null;
    try {
        suscripcionActiva = await SuscripcionManager.getCurrent();
    } catch (e) {
        console.warn('[AuthGuard] Error verificando suscripción:', e.message);
    }

    if (!suscripcionActiva || suscripcionActiva.status !== 'active') {
        console.log('[AuthGuard] CASO B2: Sin plan activo → planes.html');
        window.location.href = `planes.html?tenant_id=${tenantBD.id}`;
        return;
    }

    // Verificar fecha de expiración
    if (suscripcionActiva.end_date && new Date(suscripcionActiva.end_date) < new Date()) {
        console.log('[AuthGuard] CASO B2: Suscripción expirada → planes.html');
        // Marcar como inactiva
        try {
            await supabaseClient
                .from('subscriptions')
                .update({ status: 'inactive' })
                .eq('id', suscripcionActiva.id);
            await supabaseClient
                .from('tenants')
                .update({ estado: 'inactivo' })
                .eq('id', tenantBD.id);
        } catch (e) {
            console.warn('[AuthGuard] Error desactivando suscripción expirada:', e);
        }
        window.location.href = `planes.html?tenant_id=${tenantBD.id}&expired=true`;
        return;
    }

    // --- B2 con todo OK → DASHBOARD ---
    console.log('[AuthGuard] CASO B2: WhatsApp + plan activo → DASHBOARD');
    // ================================================================

    console.log('[AuthGuard] Permisos: OK (test de inserción desactivado)');
    
    diagnosticarDatos();
    await limpiarCitasAntiguas();
    probarEventosBasicos();
    configurarFormulario();
    configurarPrevisualizacionImagen();
    configurarContadorCaracteres();
    configurarFiltros();
    configurarBotonesEspeciales();
    iniciarReloj();
    if (typeof renderAdminAppointments === 'function') await renderAdminAppointments();
    initCalendar();
    initModules();
    if (typeof generarNotificaciones === 'function') await generarNotificaciones();
    if (typeof setupNotificacionesListeners === 'function') setupNotificacionesListeners();
    
    await cargarSuscripcionTenant();
    
    // Cargar dashboard al inicio
    if (typeof actualizarDashboardFinanzas === 'function') {
        setTimeout(() => actualizarDashboardFinanzas(), 200);
    }

    // ========== BOTÓN CANCELAR SUSCRIPCIÓN (doble confirmación) ==========
    // Cancela DE VERDAD en Mercado Pago (PUT /preapproval → detiene los
    // cobros automáticos) y desactiva el plan en la base de datos, vía la
    // Edge Function cancelar-suscripcion. El UPDATE directo anterior solo
    // marcaba 'inactive' en la DB y los cobros mensuales seguían.
    const cancelBtn = document.getElementById('cancel-subscription-btn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', async () => {
            // Primera confirmación
            if (!confirm('¿Estás seguro de cancelar tu suscripción activa?')) return;
            // Segunda confirmación
            if (!confirm('⚠️ Esta acción CANCELARÁ tu suscripción en Mercado Pago: se detendrán los cobros automáticos y tu plan pasará a inactivo. ¿Confirmas?\n\nTus datos se conservarán y podrás reactivar tu suscripción en cualquier momento desde "Cambiar plan".')) return;
            const suscripcion = await SuscripcionManager.getCurrent();
            if (!suscripcion) {
                mostrarToast('No hay suscripción activa', 'error');
                return;
            }
            const mp = window.__mercadopago;
            if (!mp || typeof mp.cancelSuscripcion !== 'function') {
                mostrarToast('El módulo de cancelación aún está cargando. Recarga la página e inténtalo de nuevo.', 'error');
                return;
            }
            try {
                const result = await mp.cancelSuscripcion({ tenantId: suscripcion.tenant_id });
                if (result && result.ok) {
                    if (result.mp_cancelled) {
                        mostrarToast('Suscripción cancelada. Cobros automáticos detenidos.', 'success');
                    } else {
                        mostrarToast('Suscripción cancelada. No había cobro automático activo.', 'success');
                    }
                    await cargarSuscripcionTenant();
                    if (typeof cargarPlanes === 'function') cargarPlanes();
                } else {
                    mostrarToast('Error al cancelar suscripción', 'error');
                }
            } catch (e) {
                console.error('[CancelarSuscripcion] Error:', e);
                mostrarToast('Error al cancelar en Mercado Pago: ' + (e.message || 'intenta de nuevo'), 'error');
            }
        });
    }
    
    // ========== PERSONALIZACIÓN VISUAL → delegada al sistema modular (ConfigEditor en main.js) ==========
    // El sistema legacy ya no gestiona eventos del formulario de personalización.
    // ConfigEditor (src/visual-config/ui/ConfigEditor.js) reemplaza el innerHTML
    // de #customization-form y maneja: guardar, restablecer, preview en vivo y check de plan.
    // Ver VisualConfigService.saveVisualConfig() para la validación de plan (Pro/Premium).

    // Inicializar sección de compartir enlace
    configurarCompartirEnlace();

    // Inicializar sección de Promoción Video (cupón 50% descuento)
    initPromoVideoSection();

    console.log('Admin/SuperAdmin iniciado correctamente');
}
window.iniciarAdmin = iniciarAdmin;

// ============================================
// PROMO VIDEO — Cupón 50% descuento por video promocional
// ============================================

/**
 * Inicializa la sección de Promoción Video en el panel admin.
 * Verifica el estado del cupón cada 2 meses y muestra el formulario.
 */
async function initPromoVideoSection() {
    const sidebarItem = document.getElementById('sidebar-promo-video');
    const statusContainer = document.getElementById('promo-video-status');
    const formContainer = document.getElementById('promo-video-form-container');
    if (!statusContainer || !formContainer) return;

    const tenantId = await getCurrentTenantId();
    if (!tenantId) return;

    // Verificar que sea plan Pro mensual
    let esProMensual = false;
    try {
        const suscripcion = await SuscripcionManager.getCurrent();
        esProMensual = suscripcion && suscripcion.plan === 'pro';
    } catch (e) {
        console.warn('[PromoVideo] Error verificando plan:', e);
    }

    if (!esProMensual) {
        // Ocultar sidebar item
        if (sidebarItem) sidebarItem.style.display = 'none';
        return;
    }

    // Mostrar sidebar item
    if (sidebarItem) sidebarItem.style.display = '';

    // Verificar estado del cupón via RPC
    try {
        const { checkPromoCouponStatus } = await import('../api/subscriptionsApi.js');
        const status = await checkPromoCouponStatus(tenantId);

        if (!status || status.error) {
            renderPromoError(statusContainer, 'No se pudo verificar el estado del cupón.');
            return;
        }

        const data = Array.isArray(status) ? status[0] : status;

        // Si es demasiado pronto (menos de 2 meses desde la suscripción)
        // o no tiene suscripción activa: ocultar sidebar y mostrar mensaje
        if (data.current_period === 'too-early') {
            if (sidebarItem) sidebarItem.style.display = 'none';
            statusContainer.innerHTML = `
                <div class="promo-banner used" style="border-color:rgba(52,152,219,0.3);">
                    <i class="fas fa-clock"></i>
                    <span><strong>Próximamente disponible</strong> — El cupón de 50% estará disponible después de 2 meses desde tu suscripción Pro.</span>
                </div>
            `;
            formContainer.innerHTML = '';
            return;
        }

        if (data.current_period === 'no-subscription' || data.current_period === 'no-tenant') {
            if (sidebarItem) sidebarItem.style.display = 'none';
            statusContainer.innerHTML = `
                <div class="promo-banner used" style="border-color:rgba(52,152,219,0.3);">
                    <i class="fas fa-info-circle"></i>
                    <span><strong>Solo para plan Pro mensual</strong> — Activa una suscripción Pro para acceder a los cupones de descuento.</span>
                </div>
            `;
            formContainer.innerHTML = '';
            return;
        }

        if (data.can_use) {
            // Cupón disponible: mostrar formulario
            if (sidebarItem) sidebarItem.classList.add('promo-glow');
            renderPromoForm(statusContainer, formContainer, tenantId, data.current_period);
        } else if (data.discount_available) {
            // Cupón aprobado no usado: mostrar botón para ir a planes
            if (sidebarItem) sidebarItem.classList.add('promo-glow');
            renderPromoApproved(statusContainer, formContainer, data);
        } else if (data.existing_status === 'pending') {
            // En revisión
            if (sidebarItem) sidebarItem.classList.remove('promo-glow');
            renderPromoPending(statusContainer, formContainer);
        } else if (data.existing_status === 'rejected') {
            // Rechazado: puede re-enviar
            if (sidebarItem) sidebarItem.classList.add('promo-glow');
            renderPromoRejected(statusContainer, formContainer, tenantId, data.current_period, data.existing_admin_comment);
        } else if (data.existing_status === 'approved' && data.discount_applied) {
            // Ya usado este período
            if (sidebarItem) sidebarItem.classList.remove('promo-glow');
            renderPromoUsed(statusContainer, formContainer);
        } else {
            // Sin cupón en este período (can_use false sin existing)
            if (sidebarItem) sidebarItem.classList.add('promo-glow');
            renderPromoForm(statusContainer, formContainer, tenantId, data.current_period);
        }
    } catch (e) {
        console.warn('[PromoVideo] Error:', e);
        renderPromoError(statusContainer, 'Error al cargar: ' + e.message);
    }
}

function renderPromoForm(statusContainer, formContainer, tenantId, period) {
    statusContainer.innerHTML = `
        <div class="promo-banner available">
            <i class="fas fa-gift"></i>
            <span><strong>¡Cupón disponible!</strong> Período ${period}. Graba tu video y obtén 50% de descuento.</span>
        </div>
    `;
    formContainer.innerHTML = `
        <div class="promo-form" style="margin-top:16px;">
            <h4 style="font-size:0.9rem;margin-bottom:12px;"><i class="fas fa-upload"></i> Enviar video promocional</h4>
            <div class="form-group" style="margin-bottom:12px;">
                <label style="display:block;font-size:0.82rem;margin-bottom:4px;color:var(--text-color,#ccc);">
                    <i class="fab fa-instagram"></i> / <i class="fab fa-tiktok"></i> Link del video
                </label>
                <input type="url" id="promo-video-url" class="config-input" placeholder="https://instagram.com/p/... o https://tiktok.com/@..." style="width:100%;">
            </div>
            <div class="form-group" style="margin-bottom:12px;">
                <label style="display:block;font-size:0.82rem;margin-bottom:4px;color:var(--text-color,#ccc);">
                    <i class="fas fa-store"></i> Descripción de tu negocio
                </label>
                <textarea id="promo-business-desc" class="config-input" rows="4" placeholder="Cuéntanos de qué trata tu negocio, qué servicios ofreces, cómo te ayudó Organify..." style="width:100%;resize:vertical;"></textarea>
            </div>
            <button id="promo-submit-btn" class="btn-save-primary" style="width:100%;">
                <i class="fas fa-paper-plane"></i> Enviar para revisión
            </button>
            <div id="promo-submit-feedback" style="margin-top:10px;"></div>
        </div>
    `;

    document.getElementById('promo-submit-btn')?.addEventListener('click', async () => {
        const videoUrl = document.getElementById('promo-video-url')?.value?.trim();
        const desc = document.getElementById('promo-business-desc')?.value?.trim();
        const feedback = document.getElementById('promo-submit-feedback');
        if (!feedback) return;

        if (!videoUrl) { feedback.innerHTML = '<p style="color:#e74c3c;font-size:0.82rem;">❌ Ingresa el link del video.</p>'; return; }
        if (!desc || desc.length < 20) { feedback.innerHTML = '<p style="color:#e74c3c;font-size:0.82rem;">❌ Describe tu negocio (mínimo 20 caracteres).</p>'; return; }

        const btn = document.getElementById('promo-submit-btn');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enviando...'; }

        try {
            const { createPromoCoupon } = await import('../api/subscriptionsApi.js');
            await createPromoCoupon({
                tenantId,
                videoUrl,
                businessDescription: desc,
                couponPeriod: period
            });
            feedback.innerHTML = '<p style="color:#2ecc71;font-size:0.82rem;">✅ ¡Enviado! El equipo revisará tu video y te notificaremos.</p>';
            if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-check"></i> Enviado'; }
            // Recargar estado después de 2s
            setTimeout(() => initPromoVideoSection(), 2000);
        } catch (e) {
            feedback.innerHTML = `<p style="color:#e74c3c;font-size:0.82rem;">❌ Error: ${escapeHtml(e.message)}</p>`;
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Enviar para revisión'; }
        }
    });
}

function renderPromoApproved(statusContainer, formContainer, data) {
    statusContainer.innerHTML = `
        <div class="promo-banner approved">
            <i class="fas fa-check-circle"></i>
            <span><strong>¡Video aprobado!</strong> Tu cupón de 50% descuento está listo. 
            <a href="planes.html" style="color:#ffc107;font-weight:600;text-decoration:underline;">Ir a pagar con descuento →</a></span>
        </div>
    `;
    formContainer.innerHTML = `
        <div class="promo-detail" style="margin-top:12px;padding:14px;background:rgba(46,204,113,0.08);border-radius:10px;border:1px solid rgba(46,204,113,0.2);">
            <p style="font-size:0.82rem;margin-bottom:6px;"><strong>Video:</strong> <a href="${escapeHtml(data.existing_video_url)}" target="_blank" rel="noopener">${escapeHtml(data.existing_video_url)}</a></p>
            <p style="font-size:0.82rem;margin-bottom:0;"><strong>Tu negocio:</strong> ${escapeHtml(data.existing_description)}</p>
            <p style="font-size:0.82rem;margin-top:10px;color:#2ecc71;"><i class="fas fa-tag"></i> Descuento del 50% en tu próximo pago Pro mensual.</p>
        </div>
    `;
}

function renderPromoPending(statusContainer, formContainer) {
    statusContainer.innerHTML = `
        <div class="promo-banner pending">
            <i class="fas fa-clock"></i>
            <span><strong>Video en revisión</strong> — El equipo está revisando tu video. Te notificaremos cuando esté aprobado.</span>
        </div>
    `;
    formContainer.innerHTML = '';
}

function renderPromoRejected(statusContainer, formContainer, tenantId, period, comment) {
    const commentHtml = comment ? `<p style="color:#e74c3c;font-size:0.82rem;margin-top:8px;padding:10px;background:rgba(231,76,60,0.1);border-radius:8px;"><strong>Comentario:</strong> ${escapeHtml(comment)}</p>` : '';
    statusContainer.innerHTML = `
        <div class="promo-banner rejected">
            <i class="fas fa-times-circle"></i>
            <span><strong>Video no aprobado</strong> — Puedes enviar uno nuevo siguiendo las condiciones.</span>
            ${commentHtml}
        </div>
    `;
    // Mostrar formulario para re-enviar
    renderPromoForm(statusContainer, formContainer, tenantId, period);
}

function renderPromoUsed(statusContainer, formContainer) {
    statusContainer.innerHTML = `
        <div class="promo-banner used">
            <i class="fas fa-check-double"></i>
            <span><strong>Cupón usado</strong> — Ya utilizaste tu descuento en este período. Vuelve en el próximo bimestre.</span>
        </div>
    `;
    formContainer.innerHTML = '';
}

function renderPromoError(statusContainer, msg) {
    statusContainer.innerHTML = `<p style="color:#e74c3c;font-size:0.85rem;"><i class="fas fa-exclamation-triangle"></i> ${escapeHtml(msg)}</p>`;
}

// Alias para superadmin.html (evita modificar el HTML)
// ============================================
// FUNCIONES DE SUPER ADMIN (Panel de Tenants)
// ============================================
async function iniciarSuperAdmin() {
    console.log('Iniciando Super Admin...');
    
    // Intentar cargar módulos ES; si fallan, usar fallback legacy
    try {
        const container = document.getElementById('main-container') || document.querySelector('.container');
        if (container) {
            const { renderSuperAdmin } = await import('./src/super-admin/ui/SuperAdminView.js');
            await renderSuperAdmin(container, window.__apis || {});
            return;
        }
    } catch (e) {
        console.warn('[superadmin] Modulos ES no disponibles, usando fallback legacy');
    }
    
    // Fallback legacy: cargar todo con supabaseClient directo
    // NOTA: Este código se ejecuta siempre, incluso si el import de ES modulos
    // tuvo éxito pero no encontró el contenedor adecuado
    await cargarTenants();
    await cargarEstadisticasGlobales();
    await cargarMetricasGlobales();
    const fnSetup = window.setupSuperAdminTabs || setupSuperAdminTabs;
    if (typeof fnSetup === 'function') fnSetup();
    
    // Configurar botones del modal de tenant
    configurarModalTenant();
    
    // Configurar botón de logout
    const logoutBtn = document.getElementById('logout-super');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            cerrarSesion();
        });
    }
    
    console.log('Super Admin iniciado correctamente');
}



async function cargarTenants() {
    if (!supabaseClient) return;
    const container = document.getElementById('tenants-list');
    if (!container) return;

    // Regla de negocio (2026-08): un tenant SOLO es visible en superadmin si
    // tiene una suscripción VIGENTE (free_trial/pro/premium_anual/freemium en
    // status active/trial). Los registros sin trial ni pago confirmado no
    // aparecen (información no verídica).
    const PLANES_VISIBLES = ['free_trial', 'pro', 'premium_anual', 'freemium'];
    const STATUS_VISIBLES = ['active', 'trial'];

    try {
        const { data: tenants, error } = await supabaseClient
            .from('tenants')
            .select(`
                *,
                subscriptions ( id, plan, status, start_date, end_date )
            `)
            .order('fecha_registro', { ascending: false });
        
        if (error) throw error;
        const visibles = (tenants || []).filter(t =>
            (t.subscriptions || []).some(s =>
                PLANES_VISIBLES.includes(s.plan) && STATUS_VISIBLES.includes(s.status)
            )
        );
        if (visibles.length === 0) {
            container.innerHTML = '<p>No hay tenants con suscripción activa (trial o plan pagado).</p>';
            return;
        }
        
        const planDisplayNames = {
            'freemium': 'Freemium',
            'free_trial': 'Free Trial',
            'pro': 'Pro',
            'premium_anual': 'Premium'
        };
        
        let html = '';

        // Actividad real de cada tenant (citas 7 días, última cita, último acceso)
        let actividad = {};
        try {
            const { data: actData, error: actError } = await supabaseClient.rpc('get_tenant_activity');
            if (!actError && Array.isArray(actData)) {
                actData.forEach(a => { actividad[a.tenant_id] = a; });
            } else if (actError) {
                console.warn('[SuperAdmin] Error cargando actividad:', actError.message);
            }
        } catch (e) {
            console.warn('[SuperAdmin] Excepción cargando actividad:', e);
        }

        visibles.forEach(t => {
            let activeSub = t.subscriptions?.find(sub => sub.status === 'active') || t.subscriptions?.[0];
            const planKey = activeSub ? activeSub.plan : (t.plan || 'freemium');
            const planDisplay = planDisplayNames[planKey] || planKey;
            const statusSub = activeSub ? activeSub.status : 'inactive';
            const endDate = activeSub?.end_date ? new Date(activeSub.end_date).toLocaleDateString() : 'N/A';
            const subExpirada = activeSub?.end_date && new Date(activeSub.end_date) < new Date();
            const activo = t.estado !== 'inactivo';

            const subStatusColor = subExpirada ? '#e74c3c' : (statusSub === 'active' ? '#2ecc71' : '#f39c12');
            const subStatusLabel = subExpirada ? 'expirada' : statusSub;

            html += `
                <div class="tenant-card glass-panel" style="padding:20px;position:relative;${!activo ? 'opacity:0.6;border-color:#e74c3c;' : ''}">
                    ${!activo ? '<div style="position:absolute;top:8px;right:8px;background:#e74c3c;color:#fff;padding:2px 10px;border-radius:4px;font-size:0.75rem;font-weight:600;">DESACTIVADO</div>' : ''}
                    <div class="tenant-header">
                        <h4>${escapeHtml(t.nombre_negocio)}</h4>
                        <span class="badge ${planKey}">${planDisplay}</span>
                    </div>
                    <p><i class="fas fa-envelope"></i> ${escapeHtml(t.email_contacto || 'N/A')}</p>
                    <p><i class="fas fa-calendar"></i> Registro: ${new Date(t.fecha_registro).toLocaleDateString()}</p>
                    <p><i class="fas fa-ticket-alt"></i> Suscripción: <strong style="color:${subStatusColor}">${subStatusLabel}</strong> ${endDate !== 'N/A' ? `(hasta ${endDate})` : ''}</p>
                    ${actividad[t.id] ? `
                    <p style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08);"><i class="fas fa-chart-line"></i> Actividad: <strong style="color:#c77dff;">${actividad[t.id].citas_7d} citas</strong> en los últimos 7 días</p>
                    ${actividad[t.id].ultima_cita ? `<p><i class="fas fa-calendar-check"></i> Última cita: ${new Date(actividad[t.id].ultima_cita).toLocaleDateString()}</p>` : ''}
                    ${actividad[t.id].ultimo_login
                        ? `<p><i class="fas fa-sign-in-alt"></i> Último acceso: ${new Date(actividad[t.id].ultimo_login).toLocaleDateString()}</p>`
                        : '<p><i class="fas fa-sign-in-alt"></i> Sin accesos registrados</p>'}
                    ` : ''}
                    <div style="margin-top:12px;">
                        <button type="button" class="btn-ver-resumen" data-id="${t.id}" data-nombre="${escapeHtml(t.nombre_negocio)}" style="width:100%;background:rgba(157,78,221,0.15);border:1px solid rgba(199,125,255,0.4);color:#c77dff;padding:8px 14px;border-radius:8px;cursor:pointer;font-weight:600;font-size:0.8rem;transition:all .15s ease;">
                            <i class="fas fa-chart-bar"></i> Ver resumen de uso
                        </button>
                    </div>
                    <div class="tenant-actions" style="margin-top:15px;">
                        <i class="fas fa-edit edit-tenant" data-id="${t.id}" style="cursor:pointer; color:#ffc107; margin-right:10px;" title="Editar"></i>
                        ${activo
                            ? `<i class="fas fa-pause-circle toggle-tenant" data-id="${t.id}" data-activo="false" style="cursor:pointer; color:#f39c12; margin-right:10px;" title="Desactivar"></i>`
                            : `<i class="fas fa-play-circle toggle-tenant" data-id="${t.id}" data-activo="true" style="cursor:pointer; color:#2ecc71; margin-right:10px;" title="Reactivar"></i>`
                        }
                        <i class="fas fa-trash delete-tenant" data-id="${t.id}" style="cursor:pointer; color:#e74c3c; margin-right:10px;" title="Eliminar (solo si está desactivado)"></i>
                        <i class="fas fa-credit-card manage-sub" data-id="${t.id}" style="cursor:pointer; color:#b300ff;" title="Gestionar suscripción"></i>
                    </div>
                </div>
            `;
        });
        
        container.innerHTML = html;
        
        // Eventos
        document.querySelectorAll('.edit-tenant').forEach(icon => {
            icon.addEventListener('click', () => abrirModalEditarTenant(icon.dataset.id));
        });
        document.querySelectorAll('.toggle-tenant').forEach(icon => {
            icon.addEventListener('click', () => superAdminToggleActivo(icon.dataset.id, icon.dataset.activo === 'true'));
        });
        document.querySelectorAll('.delete-tenant').forEach(icon => {
            icon.addEventListener('click', () => superAdminEliminarInactivo(icon.dataset.id));
        });
        document.querySelectorAll('.manage-sub').forEach(icon => {
            icon.addEventListener('click', () => abrirModalGestionSuscripcion(icon.dataset.id));
        });
        document.querySelectorAll('.btn-ver-resumen').forEach(btn => {
            btn.addEventListener('click', () => abrirResumenTenant(btn.dataset.id, btn.dataset.nombre));
        });
        
    } catch (error) {
        console.error('Error en cargarTenants:', error);
    }
}

// Asegurar que la función sea global
window.cargarTenants = cargarTenants;

/**
 * Modal de RESumen de USO de un tenant (superadmin): servicios creados,
 * citas (totales y 7 días), notificaciones (totales y leídas), último
 * acceso, última actividad registrada y un veredicto de uso.
 */
async function abrirResumenTenant(tenantId, nombreNegocio) {
    let data;
    try {
        const { data: res, error } = await supabaseClient.rpc('get_tenant_resumen', { p_tenant_id: tenantId });
        if (error) throw error;
        data = Array.isArray(res) ? res[0] : res;
    } catch (e) {
        alert('Error cargando el resumen: ' + (e.message || 'intenta de nuevo'));
        return;
    }
    if (!data) { alert('Sin datos para este tenant'); return; }

    const fmt = (d) => d ? new Date(d).toLocaleDateString() : '—';
    const r = data;

    // Veredicto de uso (simple y claro)
    let veredicto, vColor;
    if (r.citas_7d > 0) { veredicto = `SÍ lo está usando: ${r.citas_7d} cita(s) esta semana`; vColor = '#2ecc71'; }
    else if (r.citas_count > 0) { veredicto = 'Ha agendado citas, pero ninguna esta semana'; vColor = '#f39c12'; }
    else if (r.servicios_count > 0) { veredicto = 'Configuró servicios, aún sin citas'; vColor = '#f39c12'; }
    else { veredicto = 'Sin uso registrado (no ha creado nada todavía)'; vColor = '#e74c3c'; }

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(5,5,8,0.85);backdrop-filter:blur(4px);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.innerHTML = `
        <div style="background:rgba(20,20,30,0.95);border:1px solid rgba(199,125,255,0.35);border-radius:16px;max-width:480px;width:100%;padding:26px;box-shadow:0 24px 70px rgba(0,0,0,0.6);max-height:90vh;overflow-y:auto;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h3 style="margin:0;font-size:1.1rem;"><i class="fas fa-chart-bar" style="color:#c77dff;"></i> ${escapeHtml(nombreNegocio || 'Tenant')}</h3>
                <button type="button" class="btn-cerrar-resumen" style="background:transparent;border:none;color:#adb5bd;font-size:1.4rem;cursor:pointer;line-height:1;">×</button>
            </div>
            <div style="background:${vColor}1a;border:1px solid ${vColor}55;color:${vColor};border-radius:10px;padding:10px 14px;font-weight:700;font-size:0.9rem;margin-bottom:16px;">
                <i class="fas ${r.citas_7d > 0 ? 'fa-check-circle' : (r.servicios_count > 0 || r.citas_count > 0 ? 'fa-exclamation-circle' : 'fa-times-circle')}"></i> ${veredicto}
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:0.88rem;">
                <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:12px;">
                    <div style="color:#8b8fa3;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.5px;">Servicios creados</div>
                    <div style="font-size:1.3rem;font-weight:800;color:#c77dff;">${r.servicios_count}</div>
                </div>
                <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:12px;">
                    <div style="color:#8b8fa3;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.5px;">Citas totales</div>
                    <div style="font-size:1.3rem;font-weight:800;color:#c77dff;">${r.citas_count}</div>
                </div>
                <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:12px;">
                    <div style="color:#8b8fa3;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.5px;">Citas (7 días)</div>
                    <div style="font-size:1.3rem;font-weight:800;color:${r.citas_7d > 0 ? '#2ecc71' : '#8b8fa3'};">${r.citas_7d}</div>
                </div>
                <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:12px;">
                    <div style="color:#8b8fa3;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.5px;">Notificaciones</div>
                    <div style="font-size:1.3rem;font-weight:800;color:#c77dff;">${r.notif_count} <span style="font-size:0.75rem;color:#8b8fa3;font-weight:500;">(${r.notif_leidas} leídas)</span></div>
                </div>
            </div>
            <div style="margin-top:14px;border-top:1px solid rgba(255,255,255,0.08);padding-top:12px;font-size:0.85rem;color:#adb5bd;line-height:1.9;">
                <div><i class="fas fa-sign-in-alt" style="width:18px;color:#c77dff;"></i> Último acceso: <strong style="color:#f8f9fa;">${fmt(r.ultimo_login)}</strong></div>
                <div><i class="fas fa-calendar-check" style="width:18px;color:#c77dff;"></i> Última cita: <strong style="color:#f8f9fa;">${fmt(r.ultima_cita)}</strong></div>
                <div><i class="fas fa-history" style="width:18px;color:#c77dff;"></i> Última actividad registrada: <strong style="color:#f8f9fa;">${fmt(r.ultima_actividad)}</strong></div>
                <div><i class="fas fa-calendar" style="width:18px;color:#c77dff;"></i> Registrado: <strong style="color:#f8f9fa;">${fmt(r.registrado)}</strong></div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('.btn-cerrar-resumen').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}
window.abrirResumenTenant = abrirResumenTenant;

// Variable global para el modal
let currentSubTenantId = null;

async function abrirModalGestionSuscripcion(tenantId) {
    currentSubTenantId = tenantId;
    document.getElementById('subscription-modal-title').textContent = 'Gestionar Suscripción';
    document.getElementById('sub-tenant-id').value = tenantId;
    
    // === NUEVO: actualizar las opciones del select con los planes correctos ===
    document.getElementById('sub-plan').innerHTML = `
        <option value="freemium">Freemium</option>
        <option value="free_trial">Free Trial (14 días)</option>
        <option value="pro">Pro ($15.000/mes)</option>
        <option value="premium_anual">Premium ($140.000/año)</option>
    `;
    // ================================================================
    
    document.getElementById('sub-status').value = 'active';
    document.getElementById('sub-start-date').value = '';
    document.getElementById('sub-end-date').value = '';
    document.getElementById('sub-stripe-id').value = '';
    
    // Cargar suscripción activa existente
    await cargarDatosSuscripcion(tenantId);
    document.getElementById('subscription-modal').style.display = 'flex';
}

async function cargarDatosSuscripcion(tenantId) {
    const suscripciones = await SuscripcionManager.getAllForTenant(tenantId);
    const activa = suscripciones.find(s => s.status === 'active');
    if (activa) {
        document.getElementById('sub-plan').value = activa.plan;
        document.getElementById('sub-status').value = activa.status;
        if (activa.start_date) {
            const startLocal = new Date(activa.start_date).toISOString().slice(0,16);
            document.getElementById('sub-start-date').value = startLocal;
        }
        if (activa.end_date) {
            const endLocal = new Date(activa.end_date).toISOString().slice(0,16);
            document.getElementById('sub-end-date').value = endLocal;
        }
        if (activa.stripe_session_id) {
            document.getElementById('sub-stripe-id').value = activa.stripe_session_id;
        }
    }
}

async function guardarSuscripcion() {
    const tenantId = document.getElementById('sub-tenant-id').value;
    const plan = document.getElementById('sub-plan').value;
    const status = document.getElementById('sub-status').value;
    const startDate = document.getElementById('sub-start-date').value;
    const endDate = document.getElementById('sub-end-date').value || null;
    const stripeId = document.getElementById('sub-stripe-id').value || null;

    if (!startDate) {
        mostrarToast('La fecha de inicio es obligatoria', 'error');
        return;
    }

    const newSub = {
        tenant_id: tenantId,
        plan: plan,
        status: status,
        start_date: new Date(startDate).toISOString(),
        end_date: endDate ? new Date(endDate).toISOString() : null,
        stripe_session_id: stripeId
    };

    const result = await SuscripcionManager.create(newSub);
    if (result) {
        mostrarToast('Suscripción actualizada correctamente', 'success');
        document.getElementById('subscription-modal').style.display = 'none';
        await cargarTenants(); // refrescar lista
        await cargarEstadisticasGlobales(); // refrescar contadores
        await cargarMetricasGlobales(); // refrescar MRR y gráfico
    }
}

// Event listeners del modal suscripción
document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('subscription-modal');
    if (modal) {
        modal.querySelector('.modal-close').addEventListener('click', () => modal.style.display = 'none');
        document.getElementById('cancel-sub-modal')?.addEventListener('click', () => modal.style.display = 'none');
        document.getElementById('save-subscription')?.addEventListener('click', guardarSuscripcion);
        // Cerrar al hacer clic fuera del contenido
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.style.display = 'none';
        });
    }
});

function renderTenants(tenants) {
    const container = document.getElementById('tenants-list');
    if (!container) return;
    if (!tenants.length) {
        container.innerHTML = '<div class="empty-state">No hay tenants registrados</div>';
        return;
    }
    let html = `
        <table class="tenants-table">
            <thead>
                <tr>
                    <th>Nombre del negocio</th>
                    <th>Email contacto</th>
                    <th>Plan</th>
                    <th>Fecha registro</th>
                    <th>Estado</th>
                    <th>Acciones</th>
                </tr>
            </thead>
            <tbody>
    `;
    tenants.forEach(t => {
        const fecha = new Date(t.fecha_registro).toLocaleDateString('es-ES');
        html += `
            <tr data-id="${t.id}">
                <td>${escapeHtml(t.nombre_negocio)}</td>
                <td>${escapeHtml(t.email_contacto || '—')}</td>
                <td><span class="badge ${t.plan}">${t.plan || 'freemium'}</span></td>
                <td>${fecha}</td>
                <td>${escapeHtml(t.estado || 'activo')}</td>
                <td class="tenant-actions">
                    <button class="btn-small edit-tenant" data-id="${t.id}"><i class="fas fa-edit"></i> Editar</button>
                    <button class="btn-small danger delete-tenant" data-id="${t.id}"><i class="fas fa-trash"></i> Eliminar</button>
                </td>
            </tr>
        `;
    });
    html += `</tbody></table>`;
    container.innerHTML = html;

    // Re-asignar eventos (los eventos globales ya existen, pero por si acaso)
    document.querySelectorAll('.edit-tenant').forEach(btn => {
        btn.removeEventListener('click', window._editHandler);
        const handler = (e) => editarTenant(btn.dataset.id);
        btn.addEventListener('click', handler);
        window._editHandler = handler;
    });
    document.querySelectorAll('.delete-tenant').forEach(btn => {
        btn.removeEventListener('click', window._deleteHandler);
        const handler = (e) => eliminarTenant(btn.dataset.id);
        btn.addEventListener('click', handler);
        window._deleteHandler = handler;
    });
}

// Cargar lista de usuarios (solo lectura)
async function cargarUsuarios() {
    let data;
    try {
        data = await window.__usuariosApi.getAll();
    } catch (e) {
        console.error(e);
        document.getElementById('users-list-body').innerHTML = '<tr><td colspan="5">Error cargando usuarios. Verifica la RPC get_all_users_for_superadmin.</td></tr>';
        return;
    }
    currentUsers = data;
    renderUsuarios(data);
}

function renderUsuarios(users) {
    const tbody = document.getElementById('users-list-body');
    if (!tbody) return;
    if (!users.length) {
        tbody.innerHTML = '<tr><td colspan="5">No hay usuarios</td></tr>';
        return;
    }
    let html = '';
    users.forEach(u => {
        let rolClass = '';
        if (u.rol === 'super_admin') rolClass = 'role-badge-super';
        else if (u.rol === 'admin') rolClass = 'role-badge-admin';
        else rolClass = 'role-badge-cliente';
        
        html += `<tr>
            <td>${escapeHtml(u.email)}</td>
            <td>${escapeHtml(u.nombre || '-')}</td>
            <td><span class="${rolClass}">${escapeHtml(u.rol)}</span></td>
            <td>${escapeHtml(u.tenant_id || '-')}</td>
            <td>
                <select class="filter-select rol-select-usuario" data-user-id="${u.id}" style="padding:4px;">
                    <option value="cliente" ${u.rol === 'cliente' ? 'selected' : ''}>Cliente</option>
                    <option value="admin" ${u.rol === 'admin' ? 'selected' : ''}>Admin</option>
                    <option value="super_admin" ${u.rol === 'super_admin' ? 'selected' : ''}>Super Admin</option>
                </select>
                ${u.rol !== 'super_admin' ? `<button class="btn-small danger btn-eliminar-usuario" data-user-id="${u.id}" style="margin-left:8px;"><i class="fas fa-trash"></i></button>` : ''}
            </td>
        </tr>`;
    });
    tbody.innerHTML = html;

    // CSP FIX (2026-08-27): handlers inline bloqueados por CSP → addEventListener
    tbody.querySelectorAll('.rol-select-usuario').forEach(sel => {
        sel.addEventListener('change', () => cambiarRol(sel.dataset.userId, sel.value));
    });
    tbody.querySelectorAll('.btn-eliminar-usuario').forEach(btn => {
        btn.addEventListener('click', () => eliminarUsuario(btn.dataset.userId));
    });
}

// ============================================
// CONFIGURACIÓN MODAL TENANT - VERSIÓN CORREGIDA
// ============================================
let modalTenantInitialized = false;

function configurarModalTenant() {
    const modal = document.getElementById('tenant-modal');
    if (!modal) {
        console.warn('[configurarModalTenant] Modal no encontrado');
        return;
    }

    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = document.getElementById('cancel-modal');
    const form = document.getElementById('tenant-form');
    const btnNew = document.getElementById('btn-new-tenant');
    const guardarBtn = document.getElementById('btn-guardar-tenant');

    // Función de cierre (única, reutilizable)
    const cerrarModal = () => {
        modal.style.display = 'none';
        modal.removeAttribute('data-current-id');
        if (form) form.reset();
    };

    // Eliminar eventos antiguos para evitar duplicados
    const removeOldEvents = (element, eventType) => {
        if (element && element._listener) {
            element.removeEventListener(eventType, element._listener);
            delete element._listener;
        }
    };

    removeOldEvents(closeBtn, 'click');
    removeOldEvents(cancelBtn, 'click');

    // Asignar nuevos eventos con handler guardado
    if (closeBtn) {
        closeBtn._listener = cerrarModal;
        closeBtn.addEventListener('click', closeBtn._listener);
    }
    if (cancelBtn) {
        cancelBtn._listener = cerrarModal;
        cancelBtn.addEventListener('click', cancelBtn._listener);
    }

    // Cerrar al hacer clic fuera del contenido del modal (en el overlay)
    removeOldEvents(modal, 'click');
    modal._listener = (e) => {
        if (e.target === modal) cerrarModal();
    };
    modal.addEventListener('click', modal._listener);

    // Abrir modal para nuevo tenant
    if (btnNew && !btnNew._listener) {
        const abrirNuevo = () => {
            modal.removeAttribute('data-current-id');
            document.getElementById('modal-title').textContent = 'Nuevo Tenant';
            document.getElementById('tenant-id').value = '';
            document.getElementById('tenant-nombre').value = '';
            document.getElementById('tenant-email').value = '';
            document.getElementById('tenant-plan').value = 'freemium';
            document.getElementById('tenant-estado').value = 'activo';
            modal.style.display = 'flex';
        };
        btnNew._listener = abrirNuevo;
        btnNew.addEventListener('click', btnNew._listener);
    }

    // Manejo del botón Guardar (type="button" — no hay submit del form)
    if (guardarBtn && !guardarBtn._listener) {
        guardarBtn._listener = async () => {
            const modal = document.getElementById('tenant-modal');
            const id = document.getElementById('tenant-id').value || modal.dataset.currentId || '';
            
            // Validar ID antes de cualquier operación
            console.log('[Guardar Tenant] ID:', id, '| modal.dataset.currentId:', modal.dataset.currentId);
            // Si es nuevo tenant (sin ID), se crea en el bloque else (INSERT) más abajo
            // No retornar con error — dejar que fluya al INSERT
            
            const data = {
                nombre_negocio: document.getElementById('tenant-nombre').value,
                email_contacto: document.getElementById('tenant-email').value,
                plan: document.getElementById('tenant-plan').value,
                estado: document.getElementById('tenant-estado').value
            };

            let result;
            try {
                if (id) {
                    if (window.__tenantsApi?.update) {
                        result = await window.__tenantsApi.update(id, data);
                    } else {
                        const { error } = await supabaseClient
                            .from('tenants')
                            .update(data)
                            .eq('id', id);
                        result = error ? { error } : { data: true };
                    }
                } else {
                    data.fecha_registro = new Date().toISOString();
                    if (window.__tenantsApi?.create) {
                        result = await window.__tenantsApi.create(data);
                    } else {
                        const { error } = await supabaseClient
                            .from('tenants')
                            .insert(data);
                        result = error ? { error } : { data: true };
                    }
                }
            } catch (e) {
                console.error('[configurarModalTenant] Excepción:', e);
                mostrarToast('Error de red: ' + (e.message || 'Error inesperado'), 'error');
                return;
            }

            if (result?.error) {
                console.error('[Guardar Tenant] Error en UPDATE:', result.error);
                mostrarToast('Error: ' + (result.error.message || 'Error desconocido'), 'error');
            } else {
                // Si se cambió el plan, sincronizar también la suscripción activa
                if (id && data.plan) {
                    try {
                        // Buscar suscripción activa existente
                        const { data: existingSubs } = await supabaseClient
                            .from('subscriptions')
                            .select('id, plan, status')
                            .eq('tenant_id', id)
                            .eq('status', 'active');
                        const activeSub = existingSubs?.[0];
                        
                        if (activeSub && activeSub.plan !== data.plan) {
                            // Actualizar plan de la suscripción activa
                            await supabaseClient
                                .from('subscriptions')
                                .update({ plan: data.plan })
                                .eq('id', activeSub.id);
                            console.log('[Guardar Tenant] Subscripción sincronizada al plan:', data.plan);
                        } else if (!activeSub) {
                            // Crear nueva suscripción si no hay una activa
                            await supabaseClient
                                .from('subscriptions')
                                .insert({
                                    tenant_id: id,
                                    plan: data.plan,
                                    status: 'active',
                                    start_date: new Date().toISOString()
                                });
                            console.log('[Guardar Tenant] Nueva subscripción creada:', data.plan);
                        }
                    } catch (subError) {
                        console.warn('[Guardar Tenant] Error sincronizando subscripción:', subError);
                        // No bloqueamos el flujo principal por un error de suscripción
                    }
                }
                
                mostrarToast(id ? 'Tenant actualizado correctamente' : 'Tenant creado correctamente', 'success');
                cerrarModal();
                // Refrescar datos — cada función con try/catch individual para no propagar errores
                try { if (typeof cargarTenants === 'function') await cargarTenants(); } catch (e) { console.warn('[refresh] cargarTenants falló:', e); }
                try { if (typeof cargarUsuarios === 'function') await cargarUsuarios(); } catch (e) { console.warn('[refresh] cargarUsuarios falló:', e); }
                try { if (typeof cargarEstadisticasGlobales === 'function') await cargarEstadisticasGlobales(); } catch (e) { console.warn('[refresh] cargarEstadisticasGlobales falló:', e); }
                try { if (typeof cargarMetricasGlobales === 'function') await cargarMetricasGlobales(); } catch (e) { console.warn('[refresh] cargarMetricasGlobales falló:', e); }
            }
        };
        guardarBtn.addEventListener('click', guardarBtn._listener);
    }

    modalTenantInitialized = true;
}

async function editarTenant(id) {
    let data;
    try {
        if (window.__tenantsApi?.getById) {
            data = await window.__tenantsApi.getById(id);
        } else {
            const { data: result, error } = await supabaseClient
                .from('tenants')
                .select('*')
                .eq('id', id)
                .single();
            if (error) throw error;
            data = result;
        }
    } catch (e) {
        mostrarToast('Error cargando tenant: ' + e.message, 'error');
        return;
    }
    // asegurar eventos
    const modal = document.getElementById('tenant-modal');
    if (modal) {
        document.getElementById('modal-title').textContent = 'Editar Tenant';
        document.getElementById('tenant-id').value = data.id;
        document.getElementById('tenant-nombre').value = data.nombre_negocio;
        document.getElementById('tenant-email').value = data.email_contacto;
        document.getElementById('tenant-plan').value = data.plan;
        document.getElementById('tenant-estado').value = data.estado;
        modal.style.display = 'flex';
    }
}

async function eliminarTenant(id) {
    if (!id) return;
    if (!confirm('¿Eliminar este tenant? Se perderán todos sus servicios, citas y suscripciones. Esta acción no se puede deshacer.')) return;
    
    let error = null;
    try {
        if (window.__tenantsApi?.delete) {
            const result = await window.__tenantsApi.delete(id);
            error = result?.error || null;
        } else {
            const { error: err } = await supabaseClient
                .from('tenants')
                .delete()
                .eq('id', id);
            error = err || null;
        }
    } catch (e) {
        console.error('[eliminarTenant] Excepción:', e);
        mostrarToast('Error al eliminar: ' + (e.message || 'Error de red'), 'error');
        return;
    }
    
    if (error) {
        console.error('[eliminarTenant] Error de BD:', error);
        mostrarToast('Error: ' + (error.message || 'Permiso denegado por RLS'), 'error');
    } else {
        mostrarToast('Tenant eliminado correctamente', 'success');
        await cargarTenants();
        await cargarEstadisticasGlobales();
        await cargarMetricasGlobales();
        if (typeof cargarUsuarios === 'function') await cargarUsuarios();
    }
}

// ============================================
// SUPER ADMIN: TOGGLE ACTIVO/INACTIVO (doble confirmacion)
// ============================================
async function superAdminToggleActivo(tenantId, activar) {
    if (!tenantId) return;
    const accion = activar ? 'REACTIVAR' : 'DESACTIVAR';
    const mensaje = activar
        ? `¿Reactivar este tenant?

El negocio volverá a tener acceso al panel de administración.`
        : `⚠️ ¿DESACTIVAR este tenant?

El negocio NO podrá acceder al panel de administración ni al portal de clientes.

Sus datos se conservarán intactos y podrá reactivarse después.

¿Estás seguro?`;

    // Primera confirmacion
    if (!confirm(mensaje)) return;

    // Segunda confirmacion (solo para desactivar)
    if (!activar) {
        if (!confirm('⚠️ CONFIRMACIÓN FINAL\n\nEste tenant perderá el acceso inmediatamente.\n¿Confirmas la desactivación?')) return;
    }

    try {
        if (window.__tenantsApi?.update) {
            await window.__tenantsApi.update(tenantId, { estado: activar ? 'activo' : 'inactivo' });
        } else {
            const { error } = await supabaseClient
                .from('tenants')
                .update({ estado: activar ? 'activo' : 'inactivo' })
                .eq('id', tenantId);
            if (error) throw error;
        }

        // Si se desactiva, suspender suscripciones activas
        if (!activar) {
            try {
                const { data: subs } = await supabaseClient
                    .from('subscriptions')
                    .select('id, status')
                    .eq('tenant_id', tenantId)
                    .eq('status', 'active');
                for (const sub of subs || []) {
                    await supabaseClient
                        .from('subscriptions')
                        .update({ status: 'suspended', end_date: new Date().toISOString() })
                        .eq('id', sub.id);
                }
            } catch (subError) {
                console.warn('[superAdminToggleActivo] Error suspendiendo suscripciones:', subError);
            }
        } else {
            // Si se reactiva, restaurar suscripciones suspendidas
            try {
                const { data: subs } = await supabaseClient
                    .from('subscriptions')
                    .select('id, plan')
                    .eq('tenant_id', tenantId)
                    .eq('status', 'suspended');
                for (const sub of subs || []) {
                    await supabaseClient
                        .from('subscriptions')
                        .update({
                            status: 'active',
                            end_date: sub.plan === 'pro'
                                ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
                                : sub.plan === 'premium_anual'
                                    ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
                                    : undefined
                        })
                        .eq('id', sub.id);
                }
            } catch (subError) {
                console.warn('[superAdminToggleActivo] Error restaurando suscripciones:', subError);
            }
        }

        mostrarToast(activar ? 'Tenant reactivado correctamente' : 'Tenant desactivado correctamente', 'success');
        await cargarTenants();
        await cargarEstadisticasGlobales();
        await cargarMetricasGlobales();
    } catch (e) {
        console.error('[superAdminToggleActivo] Error:', e);
        mostrarToast('Error: ' + (e.message || 'Error de red'), 'error');
    }
}
window.superAdminToggleActivo = superAdminToggleActivo;

// ============================================
// SUPER ADMIN: ELIMINAR SOLO SI ESTA DESACTIVADO
// ============================================
async function superAdminEliminarInactivo(tenantId) {
    console.log('[superAdminEliminarInactivo] Click en eliminar, tenantId:', tenantId);
    if (!tenantId) {
        console.warn('[superAdminEliminarInactivo] tenantId vacío');
        return;
    }

    try {
        // Verificar que el tenant este desactivado
        let tenant = null;
        if (window.__tenantsApi?.getById) {
            tenant = await window.__tenantsApi.getById(tenantId);
        } else {
            const { data, error } = await supabaseClient
                .from('tenants')
                .select('estado, nombre_negocio')
                .eq('id', tenantId)
                .single();
            if (error) throw error;
            tenant = data;
        }
        console.log('[superAdminEliminarInactivo] Tenant:', tenant);

        if (tenant && tenant.estado !== 'inactivo') {
            mostrarToast('❌ No se puede eliminar un tenant activo. Debes desactivarlo primero.', 'error');
            return;
        }

        // Confirmación única mediante modal HTML (evita bloqueo de Firefox)
        const confirmResult = await new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';
            
            const modal = document.createElement('div');
            modal.style.cssText = 'background:#1a1a2e;color:#fff;padding:32px;border-radius:16px;max-width:500px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.5);text-align:center;';
            
            const title = document.createElement('h3');
            title.style.cssText = 'margin:0 0 16px;font-size:1.3rem;color:#e74c3c;';
            title.innerHTML = '<i class="fas fa-exclamation-triangle"></i> ELIMINAR PERMANENTEMENTE';
            
            const body = document.createElement('p');
            body.style.cssText = 'margin:0 0 8px;font-size:0.95rem;line-height:1.6;';
            body.innerHTML = `<strong>Negocio:</strong> ${escapeHtml(tenant?.nombre_negocio || 'Sin nombre')}<br><br>Se borrarán todos sus servicios, citas, suscripciones y datos.<br><br><strong style="color:#e74c3c;">Esta acción NO SE PUEDE DESHACER.</strong>`;
            
            const question = document.createElement('p');
            question.style.cssText = 'margin:16px 0 24px;font-size:1.05rem;font-weight:600;';
            question.textContent = '¿Estás seguro?';
            
            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex;gap:12px;justify-content:center;';
            
            const btnCancel = document.createElement('button');
            btnCancel.textContent = 'Cancelar';
            btnCancel.style.cssText = 'padding:10px 24px;border:none;border-radius:8px;background:#555;color:#fff;cursor:pointer;font-size:0.95rem;';
            
            const btnConfirm = document.createElement('button');
            btnConfirm.textContent = 'Sí, eliminar';
            btnConfirm.style.cssText = 'padding:10px 24px;border:none;border-radius:8px;background:#e74c3c;color:#fff;cursor:pointer;font-size:0.95rem;font-weight:600;';
            
            btnRow.appendChild(btnCancel);
            btnRow.appendChild(btnConfirm);
            modal.appendChild(title);
            modal.appendChild(body);
            modal.appendChild(question);
            modal.appendChild(btnRow);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);
            
            const cleanup = () => {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            };
            
            btnCancel.addEventListener('click', () => { cleanup(); resolve(false); });
            btnConfirm.addEventListener('click', () => { cleanup(); resolve(true); });
            overlay.addEventListener('click', (e) => { if (e.target === overlay) { cleanup(); resolve(false); } });
        });
        
        if (!confirmResult) {
            console.log('[superAdminEliminarInactivo] Usuario canceló');
            return;
        }
        console.log('[superAdminEliminarInactivo] Usuario confirmó, procediendo a eliminar...');

    } catch (e) {
        console.error('[superAdminEliminarInactivo] Error verificando tenant:', e);
        mostrarToast('Error: ' + (e.message || 'Error de red'), 'error');
        return;
    }

    // Proceder con la eliminación
    let error = null;
    try {
        // Primero eliminar datos relacionados para evitar FK constraints
        const tablesToClean = [
            { table: 'appointments', col: 'tenant_id' },
            { table: 'services', col: 'tenant_id' },
            { table: 'subscriptions', col: 'tenant_id' },
            { table: 'tenant_config', col: 'tenant_id' },
            { table: 'notificaciones', col: 'tenant_id' },
            { table: 'trabajadores', col: 'tenant_id' },
            { table: 'servicios_trabajadores', col: 'tenant_id' }
        ];
        for (const { table, col } of tablesToClean) {
            try {
                await supabaseClient.from(table).delete().eq(col, tenantId);
            } catch (_) {
                // La tabla puede no existir, ignorar
            }
        }

        if (window.__tenantsApi?.delete) {
            const result = await window.__tenantsApi.delete(tenantId);
            error = result?.error || null;
        } else {
            const { error: err } = await supabaseClient
                .from('tenants')
                .delete()
                .eq('id', tenantId);
            error = err || null;
        }
    } catch (e) {
        console.error('[superAdminEliminarInactivo] Excepción:', e);
        mostrarToast('Error al eliminar: ' + (e.message || 'Error de red'), 'error');
        return;
    }

    if (error) {
        console.error('[superAdminEliminarInactivo] Error de BD:', error);
        mostrarToast('Error: ' + (error.message || 'Permiso denegado por RLS'), 'error');
    } else {
        mostrarToast('Tenant eliminado permanentemente', 'success');
        await cargarTenants();
        await cargarEstadisticasGlobales();
        await cargarMetricasGlobales();
        if (typeof cargarUsuarios === 'function') await cargarUsuarios();
    }
}
window.superAdminEliminarInactivo = superAdminEliminarInactivo;

function probarEventosBasicos() {
    const btnVolver = document.querySelector('.btn-back');
    if (btnVolver) btnVolver.addEventListener('click', function() {});
    const btnCliente = document.querySelector('a[href="cliente.html"]');
    if (btnCliente) btnCliente.addEventListener('click', function(e) {});
}
window.probarEventosBasicos = probarEventosBasicos;

function configurarFormulario() {
    const form = document.getElementById('service-form');
    if (!form) { console.error("❌ ERROR: No se encontró el formulario"); return; }
    const textarea = document.getElementById('srv-desc');
    const contador = document.getElementById('char-count');
    if (textarea && contador) {
        textarea.addEventListener('input', function() { contador.textContent = this.value.length; });
    }
    form.addEventListener('submit', function(evento) {
        evento.preventDefault();
        if (editServiceId !== null) {
            actualizarServicio();
        } else {
            crearServicio();
        }
    });
    const btnLimpiarImg = document.getElementById('clear-image');
    if (btnLimpiarImg) {
        btnLimpiarImg.addEventListener('click', function() {
            document.getElementById('srv-image-url').value = '';
            const fi = document.getElementById('srv-image-file');
            if (fi) fi.value = '';
            const fnd = document.getElementById('file-name-display');
            if (fnd) fnd.textContent = 'Elegir imagen';
        });
    }
    const capInput = document.getElementById('srv-capacity');
    if (capInput) capInput.disabled = false;

    // === Tipo de venta: por sesión / por promoción ===
    document.querySelectorAll('input[name="srv-tipo-venta"]').forEach(r => {
        r.addEventListener('change', actualizarUIFormularioServicio);
    });
    ['srv-price', 'srv-promo-sesiones', 'srv-promo-precio'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', actualizarCalculoPromocion);
    });
    actualizarUIFormularioServicio();
}
window.configurarFormulario = configurarFormulario;

// ============================================
// TIPO DE VENTA: POR SESIÓN / POR PROMOCIÓN
// ============================================
// 'sesion' (actual): un precio por sesión, el cliente reserva 1 fecha.
// 'promocion': el cliente elige 1 sesión (precio individual) o el
// paquete de N sesiones (precio_promocion total).
function getTipoVentaSeleccionado() {
    const sel = document.querySelector('input[name="srv-tipo-venta"]:checked');
    return sel ? sel.value : 'sesion';
}

function actualizarUIFormularioServicio() {
    const tipo = getTipoVentaSeleccionado();
    const promoFields = document.getElementById('promo-fields');
    const priceInput = document.getElementById('srv-price');
    document.querySelectorAll('.tipo-venta-option').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.tipo === tipo);
    });
    if (promoFields) promoFields.style.display = tipo === 'promocion' ? 'block' : 'none';
    if (priceInput) {
        priceInput.placeholder = tipo === 'promocion' ? 'Precio sesión individual ($)*' : 'Precio ($)*';
    }
    if (tipo === 'promocion') actualizarCalculoPromocion();
}

function actualizarCalculoPromocion() {
    const ind = parseFloat(document.getElementById('srv-price')?.value) || 0;
    const n = parseInt(document.getElementById('srv-promo-sesiones')?.value, 10) || 0;
    const promo = parseFloat(document.getElementById('srv-promo-precio')?.value) || 0;
    const calc = document.getElementById('promo-calc-hint');
    if (!calc) return;
    if (ind > 0 && n > 0 && promo > 0) {
        const valorReal = ind * n;
        const ahorro = valorReal - promo;
        calc.innerHTML = `Valor real de ${n} sesiones: <strong>${formatearPeso(valorReal)}</strong> · Pagas: <strong>${formatearPeso(promo)}</strong> · `
            + (ahorro > 0
                ? `<span style="color:#4ade80;">Ahorras ${formatearPeso(ahorro)}</span>`
                : ahorro === 0
                    ? '<span style="color:#ff9f43;">Sin descuento</span>'
                    : '<span style="color:#ff9f43;">⚠️ Mayor que el valor real (precio sesión × N)</span>');
    } else if (ind > 0 && n > 0) {
        calc.textContent = `El valor real de ${n} sesiones es ${formatearPeso(ind * n)}. Agrega el precio total del paquete para ver el ahorro.`;
    } else {
        calc.textContent = 'Completa los precios y el número de sesiones para ver el cálculo del ahorro.';
    }
}

function leerCamposPromocion() {
    const tipo = getTipoVentaSeleccionado();
    if (tipo !== 'promocion') {
        return { tipo_venta: 'sesion', num_sesiones: null, precio_promocion: null };
    }
    return {
        tipo_venta: 'promocion',
        num_sesiones: parseInt(document.getElementById('srv-promo-sesiones')?.value, 10) || null,
        precio_promocion: parseFloat(document.getElementById('srv-promo-precio')?.value) || null
    };
}

function validarCamposPromocion() {
    const tipo = getTipoVentaSeleccionado();
    if (tipo !== 'promocion') return null;
    const ind = parseFloat(document.getElementById('srv-price')?.value) || 0;
    const n = parseInt(document.getElementById('srv-promo-sesiones')?.value, 10) || 0;
    const promo = parseFloat(document.getElementById('srv-promo-precio')?.value) || 0;
    if (!n || n < 2) return '⚠️ La promoción debe incluir al menos 2 sesiones.';
    if (!promo || promo <= 0) return '⚠️ Ingresa el precio total de la promoción.';
    if (ind > 0 && promo > ind * n) return '⚠️ El precio de la promoción supera el valor real (precio sesión × N). Revisa los valores.';
    return null;
}

async function crearServicio() {
    const submitBtn = document.querySelector('#service-form button[type="submit"]');

    const nombre = (document.getElementById('srv-name').value || '').trim();
    const precio = document.getElementById('srv-price').value;
    const activo = document.getElementById('srv-active').checked;

    if (!nombre || !precio) {
        mostrarMensaje("Por favor completa todos los campos obligatorios", "error");
        return;
    }

    if (nombre.length < 2) {
        mostrarMensaje("⚠️ El nombre del servicio debe tener al menos 2 caracteres.", "warning");
        document.getElementById('srv-name')?.focus();
        return;
    }

    if (activo && selectedDates.size === 0) {
        mostrarMensaje("⚠️ El servicio está marcado como activo pero no tiene fechas seleccionadas. Selecciona al menos una fecha en el calendario.", "warning");
        return;
    }

    if (activo && (!window.serviceModules || window.serviceModules.length === 0)) {
        mostrarMensaje("⚠️ El servicio está marcado como activo pero no tiene horarios configurados. Agrega al menos un horario.", "warning");
        return;
    }

    // Validar asignación completa en modos 'weekday' o 'date'
    if (activo && (_assignmentMode === 'weekday' || _assignmentMode === 'date')) {
        const estado = obtenerEstadoAsignacion();
        if (!estado.completo) {
            const faltan = estado.pendientes.join(', ');
            mostrarMensaje(`⚠️ Faltan módulos por asignar: ${faltan}. Usa "Guardar asignación" para completar antes de crear el servicio.`, "warning");
            const saveArea = document.getElementById('assignment-save-area');
            if (saveArea) saveArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }
    }

    // Validar trabajadores: solo obligatorio si existen trabajadores con disponibilidad horaria
    if (window.__validarWorkersServicio) {
        const r = window.__validarWorkersServicio();
        if (r && !r.valido) {
            mostrarMensaje(r.mensaje, "warning");
            const workersSection = document.getElementById('service-workers-list');
            if (workersSection) workersSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }
    }

    // Leer duración (con validación y fallback)
    const duracion = getServiceDuration();

    const disponibilidad = buildDisponibilidadFromForm();

    // Validar cobertura: si seleccionó trabajadores pero ninguno cubre los
    // horarios, avisa con opciones (otro trabajador o continuar sin asignación).
    if (window.__validarCoberturaWorkersServicio) {
        const cov = window.__validarCoberturaWorkersServicio(disponibilidad);
        if (cov && !cov.valido) {
            mostrarMensaje(cov.mensaje, 'warning');
            return;
        }
    }

    // Validar campos de promoción (si el tipo de venta es promoción)
    const errPromo = validarCamposPromocion();
    if (errPromo) {
        mostrarMensaje(errPromo, 'warning');
        document.getElementById('srv-promo-sesiones')?.focus();
        return;
    }
    const camposPromo = leerCamposPromocion();

    const nuevoServicio = {
        nombre: nombre,
        precio: parseFloat(precio),
        duracion: duracion,
        imagen: document.getElementById('srv-image-url').value || null,
        descripcion: document.getElementById('srv-desc').value || '',
        destacado: document.getElementById('srv-featured').checked,
        activo: activo,
        disponibilidad: disponibilidad,
        fechas: Object.keys(disponibilidad).sort(),
        // Tipo de venta: 'sesion' (default) | 'promocion' (paquete N sesiones)
        tipo_venta: camposPromo.tipo_venta,
        precio_individual: parseFloat(precio),
        num_sesiones: camposPromo.num_sesiones,
        precio_promocion: camposPromo.precio_promocion
    };

    try {
        if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creando...'; }

        await ServiciosManager.save(nuevoServicio);
        mostrarMensaje(`✅ Servicio "${nombre}" creado con ${selectedDates.size} fecha(s) y ${serviceModules.length} horario(s)`, "success");

        limpiarEstadoEdicion();
        cargarServiciosExistentes();
        if (typeof navigateTo === 'function') {
            navigateTo('mis-servicios');
        } else {
            document.getElementById('service-form').scrollIntoView({ behavior: 'smooth' });
        }
    } catch (e) {
        console.error('Error creando servicio:', e);
        mostrarMensaje('❌ Error al crear el servicio: ' + (e.message || 'Desconocido'), 'error');
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-plus-circle"></i> CREAR SERVICIO'; }
    }
}
window.crearServicio = crearServicio;

function buildDisponibilidadFromForm() {
    // Primero recolectar cupos desde la matriz/cards actual
    const modulesList = document.getElementById('modules-list');
    if (modulesList) {
        const inputs = modulesList.querySelectorAll('.module-cupos-input');
        inputs.forEach(inp => {
            const fecha = inp.dataset.fecha;
            const hora = inp.dataset.hora;
            if (!fecha || !hora) return;
            if (!window.moduleDateCupos) window.moduleDateCupos = {};
            if (!window.moduleDateCupos[fecha]) window.moduleDateCupos[fecha] = {};
            window.moduleDateCupos[fecha][hora] = Number(inp.value || 0);
        });
    }
    
    // Generar la disponibilidad final respetando jerarquía (date > weekday > general)
    const disponibilidad = generarDisponibilidadFinal();
    
    // Sobre-escribir cupos con los valores editados en la matriz/cards
    if (window.moduleDateCupos) {
        Object.keys(disponibilidad).forEach(fecha => {
            disponibilidad[fecha] = disponibilidad[fecha].map(m => {
                const hora = m.hora || m.startTime || '00:00';
                if (window.moduleDateCupos[fecha] && typeof window.moduleDateCupos[fecha][hora] !== 'undefined') {
                    m.cupos = Number(window.moduleDateCupos[fecha][hora]);
                }
                return m;
            });
        });
    }
    
    return disponibilidad;
}
window.buildDisponibilidadFromForm = buildDisponibilidadFromForm;

function guardarServicio(servicio) {
    // Usar ServiciosManager.save en su lugar
    return ServiciosManager.save(servicio);
}
window.guardarServicio = guardarServicio;

// ============================================
// CÁLCULO DE ESTADO DE URGENCIA DE UN SERVICIO
// Devuelve { estado, fechaMasCercana, horaMasCercana }.
// estado: 'normal' | 'urgent-soon' | 'urgent-now' | 'expirado'
// ('expirado' = sin fecha futura con cupos > 0: todas las fechas/horarios pasaron)
// ============================================
function calcularEstadoUrgenciaServicio(servicio) {
    let estadoUrgencia = 'normal';
    let fechaMasCercana = null;
    let horaMasCercana = null;

    const tieneDisponibilidad = servicio.disponibilidad && typeof servicio.disponibilidad === 'object' && Object.keys(servicio.disponibilidad).length > 0;
    if (tieneDisponibilidad) {
        const ahora = new Date();
        const fechas = Object.keys(servicio.disponibilidad).sort();

        for (const fecha of fechas) {
            const modulos = servicio.disponibilidad[fecha] || [];
            const modulosConCupos = modulos.filter(m => Number(m.cupos || 0) > 0);

            if (modulosConCupos.length === 0) continue;

            const partes = fecha.split('-');
            if (partes.length !== 3) continue;

            const fechaObj = new Date(partes[0], partes[1] - 1, partes[2]);

            if (fechaObj < new Date(ahora.setHours(0, 0, 0, 0))) continue;

            if (fechaObj.toDateString() === new Date().toDateString()) {
                for (const mod of modulosConCupos) {
                    const hora = mod.hora || mod.startTime || '00:00';
                    const horaParts = hora.match(/(\d{1,2}):(\d{2})/);
                    if (!horaParts) continue;

                    const fechaHora = new Date();
                    fechaHora.setHours(parseInt(horaParts[1]), parseInt(horaParts[2]), 0, 0);

                    if (fechaHora > new Date()) {
                        fechaMasCercana = fecha;
                        horaMasCercana = hora;
                        break;
                    }
                }
            } else {
                fechaMasCercana = fecha;
                horaMasCercana = modulosConCupos[0].hora || modulosConCupos[0].startTime || '00:00';
            }

            if (fechaMasCercana) break;
        }
    } else if (servicio.modulos && servicio.modulos.length > 0 && servicio.fechas && servicio.fechas.length > 0) {
        // Forma legacy (servicios previos al refactor de disponibilidad):
        // modulos con hora/cupos + lista de fechas. Misma lógica de semáforo.
        const ahora = new Date();
        const fechas = servicio.fechas.slice().sort();

        for (const fecha of fechas) {
            const modulosConCupos = servicio.modulos.filter(m => {
                const cupo = typeof m.cupos !== 'undefined' ? Number(m.cupos) : (typeof m.capacidad !== 'undefined' ? Number(m.capacidad) : 0);
                return cupo > 0;
            });
            if (modulosConCupos.length === 0) continue;

            const partes = fecha.split('-');
            if (partes.length !== 3) continue;

            const fechaObj = new Date(partes[0], partes[1] - 1, partes[2]);
            if (fechaObj < new Date(ahora.setHours(0, 0, 0, 0))) continue;

            if (fechaObj.toDateString() === new Date().toDateString()) {
                for (const mod of modulosConCupos) {
                    const hora = mod.hora || mod.startTime || '00:00';
                    const horaParts = hora.match(/(\d{1,2}):(\d{2})/);
                    if (!horaParts) continue;

                    const fechaHora = new Date();
                    fechaHora.setHours(parseInt(horaParts[1]), parseInt(horaParts[2]), 0, 0);

                    if (fechaHora > new Date()) {
                        fechaMasCercana = fecha;
                        horaMasCercana = hora;
                        break;
                    }
                }
            } else {
                fechaMasCercana = fecha;
                horaMasCercana = modulosConCupos[0].hora || modulosConCupos[0].startTime || '00:00';
            }

            if (fechaMasCercana) break;
        }
    }

    if (fechaMasCercana) {
        estadoUrgencia = UrgenciaManager.calcularEstado(fechaMasCercana, horaMasCercana);
    } else {
        estadoUrgencia = 'expirado';
    }

    return { estado: estadoUrgencia, fechaMasCercana, horaMasCercana };
}
window.calcularEstadoUrgenciaServicio = calcularEstadoUrgenciaServicio;

// ============================================
// NOTIFICACIÓN DE SERVICIOS EXPIRADOS
// La card expirada se elimina del listado; aquí se avisa en la campana con
// acción "Agregar fechas" (idempotente) y se limpian avisos de servicios
// que volvieron a tener fechas futuras.
// ============================================
async function notificarServiciosExpirados(expirados, skipRefresh) {
    try {
        const tenantId = await getCurrentTenantId();
        if (!tenantId) return;

        const tipo = 'servicio-expirado';
        const notifs = await NotificacionesAdminManager.getAll();
        const existentes = notifs.filter(n => n.tipo === tipo);
        const idsExpirados = new Set((expirados || []).map(s => String(s.id)));

        let huboCambios = false;

        // 1) Crear aviso para servicios expirados ACTIVOS que aún no tienen notificación
        for (const s of (expirados || [])) {
            if (!s.activo) continue;
            const yaAvisado = existentes.some(n => n.metadata && String(n.metadata.servicio_id) === String(s.id));
            if (yaAvisado) continue;

            const { error } = await supabaseClient
                .from('notificaciones_admin')
                .insert({
                    id: 'notif-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
                    tenant_id: String(tenantId).trim(),
                    tipo,
                    cliente: { nombre: s.nombre },
                    leido: false,
                    creado_en: new Date().toISOString(),
                    metadata: {
                        mensaje: `El servicio "${s.nombre}" expiró: todas sus fechas y horarios ya pasaron.`,
                        servicio_id: String(s.id),
                        servicio_nombre: s.nombre,
                        accion: 'editar-servicio'
                    }
                });

            if (error) console.error('Error creando notificación de servicio expirado:', error);
            else huboCambios = true;
        }

        // 2) Limpiar avisos de servicios que ya no están expirados (recuperados)
        for (const n of existentes) {
            const sid = n.metadata && n.metadata.servicio_id;
            if (sid && !idsExpirados.has(String(sid))) {
                await NotificacionesAdminManager.eliminar(n.id);
                huboCambios = true;
            }
        }

        if (huboCambios && !skipRefresh && typeof generarNotificaciones === 'function') {
            generarNotificaciones();
        }
    } catch (e) {
        console.error('Error en notificarServiciosExpirados:', e);
    }
}
window.notificarServiciosExpirados = notificarServiciosExpirados;

async function cargarServiciosExistentes() {
    const container = document.getElementById('services-cards');
    if (!container) {
        console.error("❌ No se encontró el contenedor de servicios");
        return;
    }

    const servicios = await ServiciosManager.getAll();

    if (servicios.length === 0) {
        container.innerHTML = `
            <div class="empty-state" id="no-services">
                <i class="fas fa-box-open"></i>
                <h4>No hay servicios creados</h4>
                <p>Crea tu primer servicio usando el formulario a la izquierda</p>
                <button class="btn-grad" id="create-first-service">
                    <i class="fas fa-plus"></i> Crear primer servicio
                </button>
            </div>
        `;
        setTimeout(() => {
            const btn = document.getElementById('create-first-service');
            if (btn) {
                btn.addEventListener('click', function() {
                    if (typeof navigateTo === 'function') {
                        navigateTo('crear-servicio');
                    } else {
                        document.getElementById('service-form').scrollIntoView({ behavior: 'smooth' });
                    }
                });
            }
        }, 100);
        return;
    }

    function getCategoriaNombre(cat) {
        return 'General';
    }

    let html = '';
    const expirados = [];

    servicios.forEach(servicio => {
        const { estado: estadoUrgencia, fechaMasCercana, horaMasCercana } = calcularEstadoUrgenciaServicio(servicio);

        // Card expirada (todas sus fechas/horarios ya pasaron o cupos en 0):
        // se elimina del listado automáticamente. Se avisa por notificaciones
        // (solo servicios activos) para que el admin pueda agregar fechas.
        if (estadoUrgencia === 'expirado') {
            expirados.push({ id: servicio.id, nombre: servicio.nombre, activo: servicio.activo !== false });
            return;
        }
        
        const urgenciaClass = estadoUrgencia !== 'normal' && estadoUrgencia !== 'expirado' ? estadoUrgencia : '';
        const expiradoClass = estadoUrgencia === 'expirado' ? 'service-no-dates' : '';

        let fechasInfo = '';
        let fechasMeta = '';

        if (servicio.fechas && servicio.fechas.length > 0) {
            const fechasMostrar = servicio.fechas.slice(0, 3);
            const fechasFormateadas = fechasMostrar.map(f => formatFechaCorta(f));

            fechasInfo = `
                <div class="service-dates-info-card">
                    <i class="fas fa-calendar-alt"></i>
                    <div class="dates-list">
                        <strong>${servicio.fechas.length} fecha(s):</strong>
                        <span class="fechas-text">${fechasFormateadas.join(', ')}${servicio.fechas.length > 3 ? '...' : ''}</span>
                    </div>
                </div>
            `;

            fechasMeta = `
                <span class="fechas-count" title="${servicio.fechas.join('\n')}">
                    <i class="fas fa-calendar-check"></i> ${servicio.fechas.length} días
                </span>
            `;
        }

        let horariosInfo = '';
        let horariosMeta = '';

        if (servicio.disponibilidad && Object.keys(servicio.disponibilidad).length > 0) {
            const fechasKeys = Object.keys(servicio.disponibilidad).sort();
            const primeraFecha = fechasKeys[0];
            const modsPrimerFecha = servicio.disponibilidad[primeraFecha] || [];
            const horariosMostrar = modsPrimerFecha.slice(0,2);
            const horariosFormateados = horariosMostrar.map(m => `${formatTimeDisplay(m.hora || m.startTime || '00:00')}`);

            const totalTurnos = Object.values(servicio.disponibilidad).reduce((acc, arr) => acc + (arr ? arr.length : 0), 0);

            horariosInfo = `
                <div class="service-hours-info-card">
                    <i class="fas fa-clock"></i>
                    <div class="hours-list">
                        <strong>${totalTurnos} horario(s):</strong>
                        <span class="hours-text">${horariosFormateados.join(', ')}${totalTurnos > 2 ? '...' : ''}</span>
                    </div>
                </div>
            `;

            const tooltipHorarios = Object.keys(servicio.disponibilidad).map(f => {
                const lista = (servicio.disponibilidad[f] || []).map(m => {
                    const horaText = formatTimeDisplay(m.hora || m.startTime || '00:00');
                    const cupos = Number(m.cupos || 0);
                    return `${f} ${horaText} ${cupos <= 0 ? '(Agotado)' : `- ${cupos} cupos`}`;
                }).join('\n');
                return lista;
            }).join('\n');

            horariosMeta = `
                <span class="hours-count" title="${tooltipHorarios}">
                    <i class="fas fa-clock"></i> ${totalTurnos} turnos
                </span>
            `;
        } else if (servicio.modulos && servicio.modulos.length > 0) {
            const horariosMostrar = servicio.modulos.slice(0, 2);
            const horariosFormateados = horariosMostrar.map(m => `${formatTimeDisplay(m.hora || m.startTime || '00:00')}`);
            horariosInfo = `
                <div class="service-hours-info-card">
                    <i class="fas fa-clock"></i>
                    <div class="hours-list">
                        <strong>${servicio.modulos.length} horario(s):</strong>
                        <span class="hours-text">${horariosFormateados.join(', ')}${servicio.modulos.length > 2 ? '...' : ''}</span>
                    </div>
                </div>
            `;
            const tooltipHorarios = servicio.modulos.map(m => {
                const horaText = formatTimeDisplay(m.hora || m.startTime || '00:00');
                const cupos = (typeof m.cupos !== 'undefined') ? Number(m.cupos) : (typeof m.capacidad !== 'undefined' ? Number(m.capacidad) : 0);
                return `${horaText} ${cupos <= 0 ? '(Agotado)' : `- ${cupos} cupos`}`;
            }).join('\n');
            horariosMeta = `
                <span class="hours-count" title="${tooltipHorarios}">
                    <i class="fas fa-clock"></i> ${servicio.modulos.length} turnos
                </span>
            `;
        }

        html += `
        <div class="service-card-admin ${urgenciaClass} ${expiradoClass}" 
             data-service-id="${servicio.id}"
             data-urgencia="${estadoUrgencia}"
             data-fecha-cercana="${fechaMasCercana || ''}"
             data-hora-cercana="${horaMasCercana || ''}">
            <div class="service-card-header">
                ${renderImagenServicio(servicio, 'service-card-image')}
                
                ${servicio.destacado ? `
                <div class="service-card-featured">
                    <i class="fas fa-star"></i> Destacado
                </div>
                ` : ''}
                
                <div class="service-status ${servicio.activo ? 'active' : 'inactive'}">
                    ${servicio.activo ? 'Activo' : 'Inactivo'}
                </div>
                
                ${estadoUrgencia === 'urgent-now' ? '<span class="service-urgent-badge urgent-now"><i class="fas fa-exclamation-circle"></i> URGENTE</span>' : ''}
                ${estadoUrgencia === 'urgent-soon' ? '<span class="service-urgent-badge urgent-soon"><i class="fas fa-clock"></i> Próximo</span>' : ''}
                ${estadoUrgencia === 'expirado' ? '<span class="service-urgent-badge expirado"><i class="fas fa-hourglass-end"></i> Sin fechas</span>' : ''}
            </div>
            
            <div class="service-card-body">
                <div class="service-card-title">
                    <h4>${servicio.nombre} ${servicio.tipo_venta === 'promocion' ? `<span class="badge-promo-servicio"><i class="fas fa-gift"></i> PROMO · ${servicio.num_sesiones || 'N'} sesiones</span>` : ''}</h4>
                    <div class="service-card-price">
                        ${servicio.tipo_venta === 'promocion'
                            ? `${formatearPeso(servicio.precio)} <small style="font-size:0.72rem;color:rgba(255,255,255,0.55);font-weight:400;">sesión</small> · <span style="color:#4ade80;">${formatearPeso(servicio.precio_promocion)}</span> <small style="font-size:0.72rem;color:rgba(255,255,255,0.55);font-weight:400;">paquete ${servicio.num_sesiones || 'N'}</small>`
                            : formatearPeso(servicio.precio)}
                    </div>
                </div>
                
                <p class="service-card-desc">${servicio.descripcion || 'Sin descripción'}</p>
                
                ${fechasInfo}
                
                ${horariosInfo}
                
                <div class="service-card-meta">
                    <span title="Duración por turno">
                        <i class="fas fa-hourglass-half"></i> 
                        ${servicio.modulos && servicio.modulos.length > 0 
                            ? `${servicio.modulos[0].duration} min` 
                            : `${servicio.duracion || 60} min`}
                    </span>
                    
                    <span>
                        <i class="fas fa-users"></i>
                        ${(() => {
                            if (servicio.disponibilidad && Object.keys(servicio.disponibilidad).length > 0) {
                                const allMods = [].concat(...Object.values(servicio.disponibilidad).map(arr => arr || []));
                                const cuposArr = allMods.map(m => Number(m.cupos || 0));
                                const positives = cuposArr.filter(c => c > 0);
                                if (positives.length === 0) return 'Agotado';
                                const minPos = Math.min(...positives);
                                return `${minPos} por turno`;
                            }
                            if (servicio.modulos && servicio.modulos.length > 0) {
                                const cuposArr = servicio.modulos.map(m => (typeof m.cupos !== 'undefined') ? Number(m.cupos) : (typeof m.capacidad !== 'undefined' ? Number(m.capacidad) : 0));
                                const positives = cuposArr.filter(c => c > 0);
                                if (positives.length === 0) return 'Agotado';
                                const minPos = Math.min(...positives);
                                return `${minPos} por turno`;
                            }
                            return servicio.capacidad && servicio.capacidad > 0 ? servicio.capacidad + ' cupos' : 'Agotado';
                        })()}
                    </span>
                    
                    ${fechasMeta}
                    
                    ${horariosMeta}
                </div>
                
                <div class="service-card-actions">
                    <button class="btn-secondary btn-small" data-srv-action="editar" data-id="${servicio.id}">
                        <i class="fas fa-edit"></i> Editar
                    </button>
                    <button class="btn-small" data-srv-action="duplicar" data-id="${servicio.id}" title="Duplicar servicio">
                        <i class="fas fa-copy"></i>
                    </button>
                    <button class="btn-small danger" data-srv-action="eliminar" data-id="${servicio.id}">
                        <i class="fas fa-trash"></i> Eliminar
                    </button>
                    <button class="btn-grad btn-small" data-srv-action="toggle" data-id="${servicio.id}">
                        <i class="fas fa-eye${servicio.activo ? '' : '-slash'}"></i> ${servicio.activo ? 'Ocultar' : 'Mostrar'}
                    </button>
                </div>
            </div>
        </div>
        `;
    });

    if (html === '') {
        html = `
            <div class="empty-state" id="no-services-future">
                <i class="fas fa-hourglass-end"></i>
                <h4>No hay servicios con fechas futuras</h4>
                <p>Todos tus servicios expiraron. Agrega nuevas fechas desde la campana de notificaciones (⏳ Servicio expirado) o crea un servicio nuevo.</p>
            </div>
        `;
    }

    container.innerHTML = html;

    // CSP: los onclick inline quedan bloqueados (nonce/hash anulan 'unsafe-inline').
    // Se bindean con addEventListener tras renderizar, como WorkersListView.
    container.querySelectorAll('[data-srv-action]').forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            const id = this.dataset.id;
            const accion = this.dataset.srvAction;
            if (accion === 'editar') editarServicio(id);
            else if (accion === 'duplicar') duplicarServicio(id);
            else if (accion === 'eliminar') eliminarServicio(id);
            else if (accion === 'toggle') toggleActivoServicio(id);
        });
    });

    // Fallback de imagen CSP-safe: el onerror inline del <img> queda bloqueado
    // por la CSP de producción, así que el fallback se engancha por listener.
    container.querySelectorAll('img.service-card-image[data-fallback-inicial]').forEach(img => {
        img.addEventListener('error', function() {
            const inicial = this.dataset.fallbackInicial || 'S';
            const gIdx = parseInt(this.dataset.fallbackGradient || '0', 10) % SERVICE_GRADIENTS.length;
            const div = document.createElement('div');
            div.className = 'service-card-image service-image-fallback';
            div.style.cssText = 'background:' + SERVICE_GRADIENTS[gIdx] + ';display:flex;align-items:center;justify-content:center;';
            const span = document.createElement('span');
            span.className = 'service-fallback-inicial';
            span.textContent = inicial;
            div.appendChild(span);
            this.replaceWith(div);
        });
    });

    // Click handler: abrir detalle al hacer clic en la card (no en botones)
    container.querySelectorAll('.service-card-admin').forEach(card => {
        card.addEventListener('click', function(e) {
            if (e.target.closest('button') || e.target.closest('.service-card-actions')) return;
            const id = this.dataset.serviceId;
            if (id) verDetalleServicio(id);
        });
    });

    actualizarEstadisticas();

    // Avisar por notificaciones los servicios expirados (idempotente) y
    // limpiar avisos de servicios que ya volvieron a tener fechas futuras.
    notificarServiciosExpirados(expirados);

    const btnPrimerServicio = document.getElementById('create-first-service');
    if (btnPrimerServicio) {
        btnPrimerServicio.addEventListener('click', function() {
            if (typeof navigateTo === 'function') {
                navigateTo('crear-servicio');
            } else {
                document.getElementById('srv-name').focus();
                document.querySelector('.admin-panel').scrollIntoView({ behavior: 'smooth' });
            }
        });
    }
}
window.cargarServiciosExistentes = cargarServiciosExistentes;

// ── Modal de detalle de servicio ──
async function verDetalleServicio(id) {
    let servicios = await ServiciosManager.getAll();
    const s = servicios.find(sv => String(sv.id) === String(id));
    if (!s) { mostrarMensaje('Servicio no encontrado', 'error'); return; }

    const overlay = document.getElementById('modal-servicio-detalle');
    if (!overlay) return;

    // Header — imagen
    const imgContainer = document.getElementById('detalle-imagen');
    imgContainer.innerHTML = '';
    if (s.imagen) {
        imgContainer.style.background = 'none';
        const img = document.createElement('img');
        img.src = s.imagen;
        img.alt = s.nombre || '';
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'cover';
        img.onerror = () => { imgContainer.style.background = 'rgba(255,255,255,0.05)'; imgContainer.innerHTML = '<i class=\"fas fa-image\" style=\"font-size:1.5rem;color:var(--text-muted);\"></i>'; };
        imgContainer.appendChild(img);
    } else {
        imgContainer.innerHTML = '<i class=\"fas fa-image\" style=\"font-size:1.5rem;color:var(--text-muted);\"></i>';
    }

    document.getElementById('detalle-nombre').textContent = s.nombre || 'Sin nombre';
    document.getElementById('detalle-precio').textContent = window.formatearPeso ? formatearPeso(s.precio) : '$' + (s.precio || 0);

    const estadoEl = document.getElementById('detalle-estado');
    if (s.activo) {
        estadoEl.textContent = 'Activo';
        estadoEl.style.background = 'rgba(0,184,148,0.2)';
        estadoEl.style.color = '#00b894';
    } else {
        estadoEl.textContent = 'Inactivo';
        estadoEl.style.background = 'rgba(255,70,70,0.2)';
        estadoEl.style.color = '#ff6b6b';
    }

    const dur = s.modulos && s.modulos.length > 0 ? s.modulos[0].duration : (s.duracion || 60);
    document.getElementById('detalle-duracion').innerHTML = '<i class=\"fas fa-hourglass-half\"></i> ' + (typeof window.formatTimeDisplay === 'function' ? '' : '') + dur + ' min por turno';

    if (s.destacado) {
        const badge = document.createElement('span');
        badge.style.cssText = 'font-size:0.7rem;padding:2px 10px;border-radius:10px;background:rgba(255,204,0,0.2);color:#ffcc00;';
        badge.innerHTML = '<i class=\"fas fa-star\"></i> Destacado';
        document.querySelector('#detalle-header-info > div > div').appendChild(badge);
    }

    // Descripción
    const descEl = document.getElementById('detalle-descripcion');
    descEl.textContent = s.descripcion || 'Sin descripción';

    // Resumen de cupos
    const cuposResumen = document.getElementById('detalle-cupos-resumen');
    let totalCupos = 0;
    let fechasConCupos = 0;
    let totalTurnos = 0;
    let totalFechas = 0;

    if (s.disponibilidad && typeof s.disponibilidad === 'object') {
        const fechasKeys = Object.keys(s.disponibilidad).sort();
        totalFechas = fechasKeys.length;
        fechasKeys.forEach(f => {
            const mods = s.disponibilidad[f] || [];
            totalTurnos += mods.length;
            mods.forEach(m => {
                const cupo = Number(m.cupos || 0);
                totalCupos += cupo;
                if (cupo > 0) fechasConCupos++;
            });
        });
    } else if (s.modulos && s.modulos.length > 0) {
        totalTurnos = s.modulos.length;
        totalFechas = s.fechas ? s.fechas.length : 0;
        s.modulos.forEach(m => {
            const cupo = typeof m.cupos !== 'undefined' ? Number(m.cupos) : (typeof m.capacidad !== 'undefined' ? Number(m.capacidad) : 0);
            totalCupos += cupo;
        });
    } else {
        totalFechas = s.fechas ? s.fechas.length : 0;
        totalCupos = Number(s.capacidad || 0);
    }

    cuposResumen.innerHTML = `
        <span><i class=\"fas fa-calendar-alt\"></i> <strong>${totalFechas}</strong> fecha(s)</span>
        <span><i class=\"fas fa-clock\"></i> <strong>${totalTurnos}</strong> turno(s)</span>
        <span><i class=\"fas fa-users\"></i> <strong>${totalCupos}</strong> cupo(s) totales</span>
        <span><i class=\"fas fa-calendar-check\"></i> <strong>${fechasConCupos}</strong> fecha(s) con cupo</span>
    `;

    // Fechas y horarios detallados
    const fechasContainer = document.getElementById('detalle-fechas');
    fechasContainer.innerHTML = '';

    if (s.disponibilidad && typeof s.disponibilidad === 'object') {
        const fechasKeys = Object.keys(s.disponibilidad).sort();
        if (fechasKeys.length === 0) {
            fechasContainer.innerHTML = '<div style=\"padding:16px;text-align:center;color:var(--text-muted);\"><i class=\"fas fa-calendar-times\"></i> Sin fechas configuradas</div>';
        } else {
            fechasKeys.forEach(f => {
                const mods = s.disponibilidad[f] || [];
                const fechaFormateada = typeof window.formatFechaCorta === 'function' ? formatFechaCorta(f) : f;
                const dayNames2 = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
                const day = new Date(f + 'T12:00:00').getDay();
                const diaSemana = dayNames2[day];
                const cuposFecha = mods.reduce((sum, m) => sum + Number(m.cupos || 0), 0);

                let card = document.createElement('div');
                card.style.cssText = 'background:rgba(255,255,255,0.04);border-radius:8px;padding:10px 14px;border:1px solid rgba(255,255,255,0.07);';

                let headerHtml = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                    <strong style="font-size:0.9rem;">${fechaFormateada}</strong>
                    <span style="font-size:0.75rem;color:var(--text-muted);">${diaSemana}</span>
                </div>`;

                if (mods.length === 0) {
                    card.innerHTML = headerHtml + '<div style="font-size:0.8rem;color:#ff6b6b;padding:6px 0;"><i class="fas fa-exclamation-triangle"></i> Sin horarios asignados</div>';
                } else {
                    let horariosHtml = '';
                    mods.forEach(m => {
                        const hora = typeof window.formatTimeDisplay === 'function' ? formatTimeDisplay(m.hora || m.startTime || '--:--') : (m.hora || m.startTime || '--:--');
                        const endTime = m.endTime ? ' - ' + (typeof window.formatTimeDisplay === 'function' ? formatTimeDisplay(m.endTime) : m.endTime) : '';
                        const cupo = Number(m.cupos || 0);
                        const cupoColor = cupo <= 0 ? '#ff6b6b' : (cupo <= 3 ? '#ffaa00' : '#00b894');
                        const durMod = m.duration ? m.duration + ' min' : '';

                        horariosHtml += `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:rgba(255,255,255,0.02);border-radius:6px;margin-bottom:3px;${cupo <= 0 ? 'opacity:0.5;' : ''}">
                            <span style="font-size:0.85rem;font-weight:500;min-width:120px;">${hora}${endTime}</span>
                            ${durMod ? `<span style="font-size:0.75rem;color:var(--text-muted);">${durMod}</span>` : ''}
                            <span style="margin-left:auto;font-size:0.8rem;font-weight:600;color:${cupoColor};background:${cupoColor}15;padding:2px 10px;border-radius:10px;">${cupo <= 0 ? 'Agotado' : cupo + ' cupo' + (cupo !== 1 ? 's' : '')}</span>
                        </div>`;
                    });
                    card.innerHTML = headerHtml + horariosHtml;
                }
                fechasContainer.appendChild(card);
            });
        }
    } else if (s.modulos && s.modulos.length > 0 && s.fechas && s.fechas.length > 0) {
        s.fechas.sort().forEach(f => {
            const fechaFormateada = typeof window.formatFechaCorta === 'function' ? formatFechaCorta(f) : f;
            const dayNames2 = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
            const day = new Date(f + 'T12:00:00').getDay();
            const diaSemana = dayNames2[day];

            let card = document.createElement('div');
            card.style.cssText = 'background:rgba(255,255,255,0.04);border-radius:8px;padding:10px 14px;border:1px solid rgba(255,255,255,0.07);';
            let horariosHtml = '';
            s.modulos.forEach(m => {
                const hora = typeof window.formatTimeDisplay === 'function' ? formatTimeDisplay(m.hora || m.startTime || '--:--') : (m.hora || m.startTime || '--:--');
                const endTime = m.endTime ? ' - ' + (typeof window.formatTimeDisplay === 'function' ? formatTimeDisplay(m.endTime) : m.endTime) : '';
                const cupo = typeof m.cupos !== 'undefined' ? Number(m.cupos) : (typeof m.capacidad !== 'undefined' ? Number(m.capacidad) : 0);
                const cupoColor = cupo <= 0 ? '#ff6b6b' : (cupo <= 3 ? '#ffaa00' : '#00b894');
                const durMod = m.duration ? m.duration + ' min' : '';
                horariosHtml += `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:rgba(255,255,255,0.02);border-radius:6px;margin-bottom:3px;">
                    <span style="font-size:0.85rem;font-weight:500;min-width:120px;">${hora}${endTime}</span>
                    ${durMod ? `<span style="font-size:0.75rem;color:var(--text-muted);">${durMod}</span>` : ''}
                    <span style="margin-left:auto;font-size:0.8rem;font-weight:600;color:${cupoColor};background:${cupoColor}15;padding:2px 10px;border-radius:10px;">${cupo <= 0 ? 'Agotado' : cupo + ' cupo' + (cupo !== 1 ? 's' : '')}</span>
                </div>`;
            });
            card.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <strong style="font-size:0.9rem;">${fechaFormateada}</strong>
                <span style="font-size:0.75rem;color:var(--text-muted);">${diaSemana}</span>
            </div>` + horariosHtml;
            fechasContainer.appendChild(card);
        });
    } else if (s.fechas && s.fechas.length > 0) {
        s.fechas.sort().forEach(f => {
            const fechaFormateada = typeof window.formatFechaCorta === 'function' ? formatFechaCorta(f) : f;
            const dayNames2 = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
            const day = new Date(f + 'T12:00:00').getDay();
            const diaSemana = dayNames2[day];
            let card = document.createElement('div');
            card.style.cssText = 'background:rgba(255,255,255,0.04);border-radius:8px;padding:10px 14px;border:1px solid rgba(255,255,255,0.07);';
            card.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;">
                <strong style="font-size:0.9rem;">${fechaFormateada}</strong>
                <span style="font-size:0.75rem;color:var(--text-muted);">${diaSemana} · Cupo: ${s.capacidad || 10}</span>
            </div>`;
            fechasContainer.appendChild(card);
        });
    } else {
        fechasContainer.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);"><i class=\"fas fa-calendar-times\"></i> Sin fechas configuradas</div>';
    }

    // Mostrar modal
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}
window.verDetalleServicio = verDetalleServicio;

// Configurar cierre del modal
function configurarModalDetalleServicio() {
    const overlay = document.getElementById('modal-servicio-detalle');
    if (!overlay) return;
    const closeBtn = document.getElementById('close-servicio-detalle');
    if (closeBtn) {
        closeBtn.addEventListener('click', function() {
            overlay.style.display = 'none';
            document.body.style.overflow = '';
        });
    }
    overlay.addEventListener('click', function(e) {
        if (e.target === overlay) {
            overlay.style.display = 'none';
            document.body.style.overflow = '';
        }
    });
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && overlay.style.display === 'flex') {
            overlay.style.display = 'none';
            document.body.style.overflow = '';
        }
    });
}

// Inicializar modal cuando el DOM esté listo
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', configurarModalDetalleServicio);
} else {
    configurarModalDetalleServicio();
}

async function eliminarServicio(id) {
    if (!confirm("¿Estás seguro de eliminar este servicio?")) {
        return;
    }

    // Consultar citas asociadas para la doble confirmación (reservas futuras)
    let citas = [];
    try {
        const { data } = await supabaseClient
            .from('citas')
            .select('id, fecha')
            .eq('servicio_id', id);
        citas = data || [];
    } catch (e) {
        console.warn('No se pudieron consultar citas del servicio:', e);
    }

    const hoy = new Date().toISOString().slice(0, 10);
    const futuras = citas.filter(c => String(c.fecha) >= hoy);

    if (futuras.length > 0) {
        const msg = `⚠️ Esta card tiene ${futuras.length} reserva(s) futura(s). Si eliminas el servicio, esas reservas se cancelarán.\n\n¿Eliminar de todas formas?`;
        if (!confirm(msg)) return;
    } else if (citas.length > 0) {
        const msg = `ℹ️ Este servicio tiene ${citas.length} cita(s) en el historial. Se eliminarán junto con el servicio.\n\n¿Continuar?`;
        if (!confirm(msg)) return;
    }

    // 1. Liberar relaciones trabajador-servicio (si existen)
    try {
        await supabaseClient.from('servicios_trabajadores').delete().eq('servicio_id', id);
    } catch (e) {
        console.warn('Sin relaciones de trabajadores que limpiar:', e);
    }

    // 2. Eliminar citas asociadas (requisito de la FK citas_servicio_id_fkey)
    if (citas.length > 0) {
        const { error: errCitas } = await supabaseClient
            .from('citas')
            .delete()
            .eq('servicio_id', id);
        if (errCitas) {
            console.error('Error borrando citas:', errCitas);
            mostrarMensaje('❌ No se pudo eliminar: ' + (errCitas.message || 'error al borrar reservas'), 'error');
            return;
        }
    }

    // 3. Eliminar el servicio verificando el resultado real
    const ok = await ServiciosManager.delete(id);
    if (!ok) {
        mostrarMensaje('❌ No se pudo eliminar el servicio (puede tener datos asociados). Intenta de nuevo.', 'error');
        return;
    }
    cargarServicios();
    mostrarMensaje("Servicio eliminado correctamente", "success");
}
window.eliminarServicio = eliminarServicio;

function cargarServicios() {
    return cargarServiciosExistentes();
}
window.cargarServicios = cargarServicios;

async function toggleActivoServicio(id) {
    const servicios = await ServiciosManager.getAll();
    const servicio = servicios.find(s => String(s.id) === String(id));
    if (!servicio) {
        console.error("❌ Servicio no encontrado");
        return;
    }
    await ServiciosManager.toggleActivo(id, !servicio.activo);
    cargarServiciosExistentes();
    mostrarMensaje(
        `Servicio "${servicio.nombre}" ${!servicio.activo ? 'activado ✅' : 'desactivado ⚠️'}`,
        "success"
    );
}
window.toggleActivoServicio = toggleActivoServicio;

async function editarServicio(id) {
    let servicios = await ServiciosManager.getAll();
    const servicio = servicios.find(s => String(s.id) === String(id));

    if (!servicio) {
        mostrarMensaje("Servicio no encontrado", "error");
        return;
    }

    document.getElementById('srv-name').value = servicio.nombre;
    document.getElementById('srv-price').value = servicio.precio;
    const capInput = document.getElementById('srv-capacity');
    if (servicio.disponibilidad && Object.keys(servicio.disponibilidad).length > 0) {
        const firstFecha = Object.keys(servicio.disponibilidad)[0];
        const firstModulo = (servicio.disponibilidad[firstFecha] || [])[0];
        if(firstModulo && capInput){ capInput.value = Number(firstModulo.cupos || 0); capInput.disabled = false; }
        else if(capInput){ capInput.value = 10; capInput.disabled = false; }
    } else {
        if(capInput) capInput.value = (typeof servicio.capacidadConfigurada !== 'undefined') ? servicio.capacidadConfigurada : (servicio.capacidad || 10);
    }
    document.getElementById('srv-image-url').value = servicio.imagen || '';
    if (typeof window._actualizarPreview === 'function') {
        window._actualizarPreview(servicio.imagen || '');
    }
    // Resetear file input y display al editar
    const fileInputEdit = document.getElementById('srv-image-file');
    if (fileInputEdit) fileInputEdit.value = '';
    const fileNameDisplayEdit = document.getElementById('file-name-display');
    if (fileNameDisplayEdit) fileNameDisplayEdit.textContent = 'Elegir imagen';
    const progressBarEdit = document.getElementById('image-upload-progress');
    if (progressBarEdit) progressBarEdit.style.display = 'none';
    document.getElementById('srv-desc').value = servicio.descripcion || '';
    document.getElementById('srv-featured').checked = servicio.destacado;
    document.getElementById('srv-active').checked = servicio.activo;
    const durEl = document.getElementById('srv-duration');
    if (durEl) durEl.value = servicio.duracion || 60;

    // === Tipo de venta (por sesión / por promoción) ===
    // Permite convertir servicios antiguos (por sesión) a promoción y viceversa.
    const tipoVentaEdit = servicio.tipo_venta === 'promocion' ? 'promocion' : 'sesion';
    const radioTipo = document.querySelector(`input[name="srv-tipo-venta"][value="${tipoVentaEdit}"]`);
    if (radioTipo) radioTipo.checked = true;
    const srvPromoSes = document.getElementById('srv-promo-sesiones');
    if (srvPromoSes) srvPromoSes.value = servicio.num_sesiones || '';
    const srvPromoPrecio = document.getElementById('srv-promo-precio');
    if (srvPromoPrecio) srvPromoPrecio.value = servicio.precio_promocion || '';
    actualizarUIFormularioServicio();

    if (servicio.fechas && servicio.fechas.length > 0) {
        selectedDates = new Set(servicio.fechas);
    } else {
        selectedDates.clear();
    }

    renderCalendar();
    clearAllModules();

    // --- Cargar modo de asignación avanzado ---
    _assignmentMode = servicio.assignment_mode || 'all';
    _weekdayModules = servicio.weekday_modules || {};
    _dateSpecificModules = servicio.date_specific_modules || {};
    window.moduleDateCupos = servicio.module_date_cupos || {};

    // Reflejar el modo en la UI
    if (typeof setAssignmentMode === 'function') {
        setAssignmentMode(_assignmentMode);
    }
    if (_assignmentMode === 'date' && typeof actualizarSelectorFechas === 'function') {
        actualizarSelectorFechas();
    }
    if (typeof refrescarCheckboxesWeekday === 'function') {
        refrescarCheckboxesWeekday();
    }

    // Cargar módulos desde disponibilidad
    if (servicio.disponibilidad && Object.keys(servicio.disponibilidad).length > 0) {
        const horaMap = {};
        Object.keys(servicio.disponibilidad).forEach(f => {
            (servicio.disponibilidad[f] || []).forEach(module => {
                const h = module.hora || module.startTime || '00:00';
                if(!horaMap[h]){
                    horaMap[h] = {
                        id: module.id || generateModuleId(),
                        hora: h,
                        cupos: (typeof module.cupos !== 'undefined') ? Number(module.cupos) : 0,
                        duration: module.duration || 0
                    };
                }
            });
        });
        Object.values(horaMap).forEach(h => serviceModules.push(h));
        Object.keys(servicio.disponibilidad || {}).forEach(fecha => {
            if (!window.moduleDateCupos[fecha]) window.moduleDateCupos[fecha] = {};
            (servicio.disponibilidad[fecha] || []).forEach(mod => {
                const hora = mod.hora || mod.startTime || '00:00';
                window.moduleDateCupos[fecha][hora] = Number(mod.cupos || 0);
            });
        });
        renderModulesList();
        saveModulesToHiddenField();
        updateDurationDisplay();
    } else if (servicio.modulos && servicio.modulos.length > 0) {
        servicio.modulos.forEach(module => {
            serviceModules.push({
                id: module.id || generateModuleId(),
                hora: module.hora || module.startTime || '00:00',
                cupos: (typeof module.cupos !== 'undefined') ? Number(module.cupos) : (typeof module.capacidad !== 'undefined' ? Number(module.capacidad) : 0),
                duration: module.duration || 0
            });
        });
        renderModulesList();
        saveModulesToHiddenField();
        updateDurationDisplay();
    }

    // --- Establecer modo edición ---
    editServiceId = id;
    const formEdit = document.getElementById('service-form');
    if (formEdit) formEdit.dataset.editId = id;
    // Refrescar checkboxes de trabajadores: preselecciona los asignados y
    // marca cobertura según la disponibilidad cargada del servicio.
    if (typeof window.__refrescarWorkersServicio === 'function') {
        window.__refrescarWorkersServicio().catch(() => {});
    }

    // === UX: navegar a la sección del formulario ===
    if (typeof navigateTo === 'function') {
        navigateTo('crear-servicio');
    }
    // Scroll suave al formulario
    setTimeout(() => {
        const formEl = document.getElementById('service-form');
        if (formEl) formEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);

    // === UX: cambiar título de la sección ===
    const titleEl = document.getElementById('section-title-servicio');
    if (titleEl) {
        titleEl.innerHTML = `<i class="fas fa-edit"></i> ✏️ Editando Servicio: <span style="color:var(--primary-light);">${escapeHtml(servicio.nombre)}</span>`;
    }

    const form = document.getElementById('service-form');
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.innerHTML = '<i class="fas fa-save"></i> GUARDAR CAMBIOS';

    const formActions = document.querySelector('.form-actions');
    if (!document.getElementById('cancel-edit')) {
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.id = 'cancel-edit';
        cancelBtn.className = 'btn-secondary';
        cancelBtn.innerHTML = '<i class="fas fa-times"></i> Cancelar edición';
        cancelBtn.onclick = function() {
            cancelarEdicion();
        };
        formActions.appendChild(cancelBtn);
    }

    mostrarMensaje(`Editando servicio: "${servicio.nombre}"`, "info");
}
window.editarServicio = editarServicio;

async function actualizarServicio() {
    const id = editServiceId;
    if (!id) {
        mostrarMensaje("❌ No hay servicio en edición", "error");
        limpiarEstadoEdicion();
        return;
    }
    const submitBtn = document.querySelector('#service-form button[type="submit"]');

    const servicios = await ServiciosManager.getAll();
    const index = servicios.findIndex(s => String(s.id) === String(id));

    if (index === -1) {
        mostrarMensaje("Servicio no encontrado", "error");
        limpiarEstadoEdicion();
        return;
    }

    const nombre = (document.getElementById('srv-name').value || '').trim();
    const precio = document.getElementById('srv-price').value;
    const activo = document.getElementById('srv-active').checked;

    if (!nombre || !precio) {
        mostrarMensaje("Por favor completa todos los campos obligatorios", "error");
        return;
    }

    if (nombre.length < 2) {
        mostrarMensaje("⚠️ El nombre del servicio debe tener al menos 2 caracteres.", "warning");
        document.getElementById('srv-name')?.focus();
        return;
    }

    if (activo && selectedDates.size === 0) {
        mostrarMensaje("⚠️ El servicio está marcado como activo pero no tiene fechas seleccionadas.", "warning");
        return;
    }
    if (activo && serviceModules.length === 0) {
        mostrarMensaje("⚠️ El servicio está marcado como activo pero no tiene horarios configurados.", "warning");
        return;
    }

    const duracion = getServiceDuration();

    const disponibilidadNueva = buildDisponibilidadFromForm();

    // Validar cobertura: si seleccionó trabajadores pero ninguno cubre los
    // horarios, avisa con opciones (otro trabajador o continuar sin asignación).
    if (window.__validarCoberturaWorkersServicio) {
        const cov = window.__validarCoberturaWorkersServicio(disponibilidadNueva);
        if (cov && !cov.valido) {
            mostrarMensaje(cov.mensaje, 'warning');
            return;
        }
    }

    // Validar campos de promoción (si el tipo de venta es promoción)
    const errPromo = validarCamposPromocion();
    if (errPromo) {
        mostrarMensaje(errPromo, 'warning');
        document.getElementById('srv-promo-sesiones')?.focus();
        return;
    }
    const camposPromo = leerCamposPromocion();

    const servicioActualizado = {
        id: id,
        nombre: nombre,
        precio: parseFloat(precio),
        duracion: duracion,
        imagen: document.getElementById('srv-image-url').value || null,
        descripcion: document.getElementById('srv-desc').value || '',
        destacado: document.getElementById('srv-featured').checked,
        activo: activo,
        disponibilidad: disponibilidadNueva,
        fechas: Object.keys(disponibilidadNueva).sort(),
        fechaCreacion: servicios[index].fechaCreacion,
        fechaActualizacion: new Date().toISOString(),
        // Preservar modos de asignación avanzados
        assignment_mode: _assignmentMode,
        weekday_modules: _weekdayModules,
        date_specific_modules: _dateSpecificModules,
        module_date_cupos: window.moduleDateCupos || {},
        // Tipo de venta: 'sesion' (default) | 'promocion' (paquete N sesiones)
        tipo_venta: camposPromo.tipo_venta,
        precio_individual: parseFloat(precio),
        num_sesiones: camposPromo.num_sesiones,
        precio_promocion: camposPromo.precio_promocion
    };

    try {
        if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Actualizando...'; }

        await ServiciosManager.save(servicioActualizado);
        mostrarMensaje(`✅ Servicio "${servicioActualizado.nombre}" actualizado correctamente`, "success");

        limpiarEstadoEdicion();
        cargarServiciosExistentes();
        if (typeof navigateTo === 'function') {
            navigateTo('mis-servicios');
        }
    } catch (e) {
        console.error('Error actualizando servicio:', e);
        mostrarMensaje('❌ Error al actualizar el servicio: ' + (e.message || 'Desconocido'), 'error');
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-save"></i> GUARDAR CAMBIOS'; }
    }
}
window.actualizarServicio = actualizarServicio;

async function actualizarEstadisticas() {
    const servicios = await ServiciosManager.getAll();

    // Solo cuentan los servicios con fechas futuras (las cards expiradas ya
    // no se muestran en el listado; los contadores deben coincidir con lo visible)
    const visibles = servicios.filter(s => calcularEstadoUrgenciaServicio(s).estado !== 'expirado');

    const total = visibles.length;
    const activos = visibles.filter(s => s.activo).length;
    const destacados = visibles.filter(s => s.destacado && s.activo).length;
    const cuposTotales = visibles.reduce((sum, s) => {
        if(s.disponibilidad){
            const flat = [].concat(...Object.values(s.disponibilidad || {}));
            const ssum = flat.reduce((a,m) => a + (Number(m.cupos || 0)), 0);
            return sum + ssum;
        }
        return sum + (s.capacidad || 0);
    }, 0);

    const totalEl = document.getElementById('total-services');
    const activeEl = document.getElementById('active-services');
    const featuredEl = document.getElementById('featured-services');
    const capacityEl = document.getElementById('total-capacity');

    if (totalEl) totalEl.textContent = total;
    if (activeEl) activeEl.textContent = activos;
    if (featuredEl) featuredEl.textContent = destacados;
    if (capacityEl) capacityEl.textContent = cuposTotales;

    actualizarStatsHeader();

    // Refrescar "Ingresos Proyectados" al recargar Mis Servicios (antes solo
    // se actualizaba en el limpiado de 10 min o al crear una cita).
    await updateProjectedRevenue();
}
window.actualizarEstadisticas = actualizarEstadisticas;

async function actualizarStatsHeader() {
    const servicios = await ServiciosManager.getAll();
    // Citas reales del tenant (las completadas/vencidas se eliminan solas,
    // por lo que lo que queda en BD son las citas vigentes)
    const citas = await CitasManager.getAll();
    // Ventas reales del mes (misma fuente que el Dashboard Financiero)
    const ventasMes = await VentasManager.getMes();
    const totalVentasMes = VentasManager.calcularTotal(ventasMes);

    const statServicios = document.getElementById('statServicios');
    const statVentas = document.getElementById('statVentas');
    const statCitas = document.getElementById('statCitas');
    const statClientes = document.getElementById('statClientes');

    if (statServicios) {
        const activos = servicios.filter(s => s.activo && calcularEstadoUrgenciaServicio(s).estado !== 'expirado').length;
        statServicios.textContent = activos;
    }

    if (statVentas) {
        statVentas.textContent = formatearPeso(totalVentasMes);
        ajustarTamanoStat(statVentas);
    }

    if (statCitas) {
        statCitas.textContent = citas.length;
    }

    if (statClientes) {
        const clientesUnicos = new Set(citas.map(c => c.contacto?.email).filter(Boolean)).size;
        statClientes.textContent = clientesUnicos;
    }
}
window.actualizarStatsHeader = actualizarStatsHeader;

// Navegación desde tarjetas de estadísticas del header:
// Servicios Activos → Mis Servicios | Citas Activas → Citas Programadas | Clientes Registrados → Mis Clientes
function vincularNavegacionStatsHeader() {
    const destinos = {
        statServicios: 'mis-servicios',
        statCitas: 'citas',
        statClientes: 'clientes'
    };
    Object.keys(destinos).forEach(function(id) {
        const stat = document.getElementById(id);
        if (!stat) return;
        const box = stat.closest('.stat-box');
        if (!box || box.dataset.navVinculado) return;
        box.dataset.navVinculado = '1';
        box.classList.add('stat-box-clickable');
        box.addEventListener('click', function() {
            if (typeof navigateTo === 'function') navigateTo(destinos[id]);
        });
    });
}
window.vincularNavegacionStatsHeader = vincularNavegacionStatsHeader;

function configurarFiltros() {
    const filtroEstado = document.getElementById('filter-status');
    const filtroUrgencia = document.getElementById('filter-urgency');
    const btnActualizar = document.getElementById('refresh-services');

    if (filtroEstado) {
        filtroEstado.addEventListener('change', aplicarFiltros);
    }

    if (filtroUrgencia) {
        filtroUrgencia.addEventListener('change', aplicarFiltros);
    }

    if (btnActualizar) {
        btnActualizar.addEventListener('click', function() {
            cargarServiciosExistentes();
            mostrarMensaje("Lista de servicios actualizada", "info");
        });
    }

    // Etiqueta del filtro de urgencia: corregir "Todos los estados" → "Todas
    // las urgencias" (se hace por JS para no depender del HTML estático).
    if (filtroUrgencia && filtroUrgencia.options.length > 0 &&
        filtroUrgencia.options[0].textContent.trim() === 'Todos los estados') {
        filtroUrgencia.options[0].textContent = 'Todas las urgencias';
    }

    // Guía de Mis Servicios: toggle del panel explicativo (mismo patrón que guia-dashboard)
    const btnGuia = document.getElementById('btn-guia-servicios');
    if (btnGuia) {
        btnGuia.addEventListener('click', function(e) {
            e.stopPropagation();
            const guia = document.getElementById('guia-servicios');
            if (!guia) return;
            const visible = guia.style.display !== 'none';
            guia.style.display = visible ? 'none' : 'block';
            btnGuia.classList.toggle('active', !visible);
        });

        // Cerrar la guía al hacer click/tap FUERA del panel y del botón (PC y móvil)
        document.addEventListener('click', function(e) {
            const guia = document.getElementById('guia-servicios');
            if (!guia || guia.style.display === 'none') return;
            if (guia.contains(e.target) || btnGuia.contains(e.target)) return;
            guia.style.display = 'none';
            btnGuia.classList.remove('active');
        });
    }
}
window.configurarFiltros = configurarFiltros;

async function aplicarFiltros() {
    const categoria = document.getElementById('filter-category')?.value || 'all';
    const estado = document.getElementById('filter-status')?.value || 'all';
    const urgencia = document.getElementById('filter-urgency')?.value || 'all';

    const tarjetas = document.querySelectorAll('.service-card-admin');
    const servicios = await ServiciosManager.getAll();

    if (tarjetas.length === 0) return;

    let visibleCount = 0;

    tarjetas.forEach(tarjeta => {
        const serviceId = tarjeta.getAttribute('data-service-id');
        const servicio = servicios.find(s => String(s.id) === String(serviceId));

        if (!servicio) {
            tarjeta.style.display = 'none';
            return;
        }

        let mostrar = true;

        if (categoria !== 'all' && servicio.categoria !== categoria) {
            mostrar = false;
        }

        if (estado !== 'all') {
            const estaActivo = servicio.activo;
            if ((estado === 'active' && !estaActivo) || (estado === 'inactive' && estaActivo)) {
                mostrar = false;
            }
        }

        if (mostrar && urgencia !== 'all') {
            const urgenciaTarjeta = tarjeta.dataset.urgencia || 'normal';
            
            if (urgencia === 'urgent-soon' && urgenciaTarjeta !== 'urgent-soon') {
                mostrar = false;
            } else if (urgencia === 'urgent-now' && urgenciaTarjeta !== 'urgent-now') {
                mostrar = false;
            } else if (urgencia === 'normal' && (urgenciaTarjeta === 'urgent-soon' || urgenciaTarjeta === 'urgent-now')) {
                mostrar = false;
            }
        }

        tarjeta.style.display = mostrar ? 'block' : 'none';
        if (mostrar) visibleCount++;
    });

    if (visibleCount === 0 && tarjetas.length > 0) {
        mostrarMensaje("No hay servicios que coincidan con los filtros", "info");
    }
}
window.aplicarFiltros = aplicarFiltros;

// ============================================================
// SUBIR IMAGEN DEL SERVICIO (archivo local → Supabase Storage)
// ============================================================
function mostrarProgresoUpload(mostrar, progreso, texto) {
    const bar = document.getElementById('image-upload-progress');
    const fill = document.getElementById('upload-progress-fill');
    const statusText = document.getElementById('upload-status-text');
    if (!bar || !fill || !statusText) return;
    if (!mostrar) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    fill.style.width = progreso + '%';
    statusText.textContent = texto || 'Subiendo imagen...';
}

async function subirImagenServicio(file) {
    if (!file) return null;
    // Validar tamaño máx 10MB
    if (file.size > 10 * 1024 * 1024) {
        mostrarMensaje('❌ La imagen es muy grande. Máximo 10MB.', 'error');
        return null;
    }
    // Validar tipo
    if (!file.type.startsWith('image/')) {
        mostrarMensaje('❌ Solo se permiten archivos de imagen.', 'error');
        return null;
    }

    mostrarProgresoUpload(true, 10, 'Optimizando imagen...');

    try {
        // === 1. Redimensionar y optimizar con Canvas ===
        const imagenOptimizada = await optimizarImagen(file, 800, 0.8);
        mostrarProgresoUpload(true, 40, 'Subiendo a la nube...');

        // === 2. Subir a Supabase Storage ===
        // La política RLS del bucket exige que la carpeta sea el tenant de
        // user_roles (get_user_tenant_id), no el del JWT. Pedir el canónico
        // primero; si no hay, caer al JWT y por último 'public'.
        let tenantId = null;
        try {
            if (supabaseClient) {
                const { data: tenantCanonico } = await supabaseClient.rpc('get_user_tenant_id');
                tenantId = tenantCanonico || null;
            }
        } catch (e) {
            console.warn('[subirImagenServicio] tenant canónico no disponible, uso JWT:', e);
        }
        tenantId = tenantId || window.currentTenantId || 'public';
        const fileName = `servicio-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.jpg`;
        const filePath = `${tenantId}/${fileName}`;

        if (!supabaseClient) {
            mostrarMensaje('❌ Cliente de base de datos no disponible', 'error');
            mostrarProgresoUpload(false);
            return null;
        }

        // Subir a Supabase Storage
        // NOTA: El bucket 'service-images' debe crearse manualmente desde el SQL Editor.
        // Ejecuta el archivo supabase-storage-setup.sql en el SQL Editor de Supabase.
        const { data, error } = await supabaseClient.storage
            .from('service-images')
            .upload(filePath, imagenOptimizada, {
                contentType: 'image/jpeg',
                upsert: true
            });

        mostrarProgresoUpload(true, 80, 'Procesando...');

        if (error) {
            console.error('[subirImagenServicio] Error upload:', error);
            mostrarMensaje('❌ Error al subir imagen: ' + (error.message || 'Desconocido'), 'error');
            mostrarProgresoUpload(false);
            return null;
        }

        // === 3. Obtener URL pública ===
        const { data: urlData } = supabaseClient.storage
            .from('service-images')
            .getPublicUrl(filePath);

        const publicUrl = urlData?.publicUrl || null;
        mostrarProgresoUpload(false);

        if (publicUrl) {
            mostrarMensaje('✅ Imagen subida exitosamente', 'success');
        }
        return publicUrl;

    } catch (e) {
        console.error('[subirImagenServicio] Error:', e);
        mostrarMensaje('❌ Error al procesar la imagen: ' + (e.message || 'Desconocido'), 'error');
        mostrarProgresoUpload(false);
        return null;
    }
}
window.subirImagenServicio = subirImagenServicio;

function optimizarImagen(file, maxWidth, quality) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = function(e) {
            const img = new Image();
            img.onload = function() {
                // Calcular nuevas dimensiones manteniendo aspect ratio
                let width = img.width;
                let height = img.height;
                if (width > maxWidth) {
                    height = Math.round(height * maxWidth / width);
                    width = maxWidth;
                }
                // Dibujar en canvas redimensionado
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, 0, 0, width, height);
                // Convertir a Blob JPEG con calidad 0.8
                canvas.toBlob(function(blob) {
                    if (blob) {
                        resolve(blob);
                    } else {
                        reject(new Error('No se pudo convertir la imagen'));
                    }
                }, 'image/jpeg', quality);
            };
            img.onerror = function() {
                reject(new Error('No se pudo cargar la imagen'));
            };
            img.src = e.target.result;
        };
        reader.onerror = function() {
            reject(new Error('No se pudo leer el archivo'));
        };
        reader.readAsDataURL(file);
    });
}

// ============================================================
// HELPER: Renderizar imagen de servicio con fallback de nombre
// ============================================================
// Gradientes compartidos para el fallback de imagen (se usan también
// en el error handler CSP-safe de cargarServiciosExistentes).
const SERVICE_GRADIENTS = [
    'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
    'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
    'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
    'linear-gradient(135deg, #fa709a 0%, #fee140 100%)'
];

function renderImagenServicio(servicio, className) {
    if (!servicio) return '';
    const imgClass = className || 'service-card-image';
    const nombre = servicio.nombre || 'S';
    const inicial = nombre.trim().charAt(0).toUpperCase();
    const gradientIndex = (servicio.id ? String(servicio.id).length : 0) % SERVICE_GRADIENTS.length;

    if (servicio.imagen && servicio.imagen.trim()) {
        // Sin onerror inline (la CSP de producción lo bloquea): el fallback se
        // engancha con addEventListener tras el render (cargarServiciosExistentes).
        return `<img src="${escapeHtml(servicio.imagen)}" alt="${escapeHtml(nombre)}" class="${imgClass}"
                     data-fallback-inicial="${inicial}" data-fallback-gradient="${gradientIndex}">`;
    } else {
        return `<div class="${imgClass} service-image-fallback" style="background:${SERVICE_GRADIENTS[gradientIndex]};display:flex;align-items:center;justify-content:center;">
                    <span class="service-fallback-inicial">${inicial}</span>
                </div>`;
    }
}

function configurarPrevisualizacionImagen() {
    const inputImagen = document.getElementById('srv-image-url');
    const inputFile = document.getElementById('srv-image-file');
    const contenedorPreview = document.getElementById('image-preview');
    const btnLimpiar = document.getElementById('clear-image');
    const fileNameDisplay = document.getElementById('file-name-display');

    if (!inputImagen || !contenedorPreview) return;

    function actualizarPreview(url) {
        contenedorPreview.innerHTML = '';
        if (!url) {
            contenedorPreview.innerHTML = '<div class="image-placeholder"><i class="fas fa-image"></i><p>Vista previa aparecerá aquí</p></div>';
            contenedorPreview.classList.remove('has-image');
            return;
        }
        const img = document.createElement('img');
        img.src = url;
        img.alt = 'Previsualización del servicio';
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:8px;';
        img.onload = function() {
            contenedorPreview.appendChild(img);
            contenedorPreview.classList.add('has-image');
        };
        img.onerror = function() {
            contenedorPreview.innerHTML = '<div class="image-placeholder error"><i class="fas fa-exclamation-triangle"></i><p>No se pudo cargar la imagen</p><small>URL inválida o imagen no accesible</small></div>';
            contenedorPreview.classList.remove('has-image');
        };
    }

    // Exponer globalmente para que editarServicio() pueda llamarlo
    window._actualizarPreview = actualizarPreview;

    if (btnLimpiar) {
        btnLimpiar.addEventListener('click', function() {
            inputImagen.value = '';
            actualizarPreview('');
            if (inputFile) inputFile.value = '';
            if (fileNameDisplay) fileNameDisplay.textContent = 'Elegir imagen';
        });
    }

    // File upload handler
    if (inputFile) {
        inputFile.addEventListener('change', async function() {
            const file = this.files[0];
            if (!file) return;

            // Mostrar preview local inmediato
            const reader = new FileReader();
            reader.onload = function(e) {
                actualizarPreview(e.target.result);
            };
            reader.readAsDataURL(file);

            // Actualizar nombre del archivo
            if (fileNameDisplay) {
                fileNameDisplay.textContent = file.name;
            }

            // Subir y optimizar
            const publicUrl = await subirImagenServicio(file);
            if (publicUrl) {
                inputImagen.value = publicUrl;
            } else {
                // Si falló la subida, limpiar el input file
                this.value = '';
                if (fileNameDisplay) {
                    fileNameDisplay.textContent = 'Elegir imagen';
                }
                // Solo limpiar preview si no había URL previa
                if (!inputImagen.value) {
                    actualizarPreview('');
                }
            }
        });
    }
}
window.configurarPrevisualizacionImagen = configurarPrevisualizacionImagen;

function configurarContadorCaracteres() {
    const textarea = document.getElementById('srv-desc');
    const contador = document.getElementById('char-count');

    if (!textarea || !contador) {
        return;
    }

    function actualizarContador() {
        const longitud = textarea.value.length;
        contador.textContent = longitud;

        const elementoPadre = contador.parentElement;
        elementoPadre.classList.remove('warning', 'error');

        if (longitud > 400 && longitud <= 500) {
            elementoPadre.classList.add('warning');
        } else if (longitud > 500) {
            elementoPadre.classList.add('error');
            textarea.value = textarea.value.substring(0, 500);
            contador.textContent = 500;
        }
    }

    textarea.addEventListener('input', actualizarContador);
    actualizarContador();
}
window.configurarContadorCaracteres = configurarContadorCaracteres;

function configurarBotonesEspeciales() {
const btnPrimerServicio = document.getElementById('create-first-service');
    if (btnPrimerServicio) {
        btnPrimerServicio.addEventListener('click', function() {
            if (typeof navigateTo === 'function') {
                navigateTo('crear-servicio');
            } else {
                const formulario = document.getElementById('service-form');
                if (formulario) {
                    formulario.scrollIntoView({ 
                        behavior: 'smooth', 
                        block: 'start' 
                    });
                    formulario.style.boxShadow = '0 0 30px rgba(157, 78, 221, 0.5)';
                    formulario.style.transition = 'box-shadow 0.5s';
                    setTimeout(() => {
                        formulario.style.boxShadow = 'none';
                    }, 2000);
                }
            }
        });
    }

    const btnLimpiar = document.getElementById('discard-changes');
    if (btnLimpiar) {
        btnLimpiar.addEventListener('click', function() {
            cancelarEdicion();
        });
    }
}
window.configurarBotonesEspeciales = configurarBotonesEspeciales;

async function cargarProximasCitas() {
    const contenedor = document.getElementById('upcoming-appointments');
    if (!contenedor) {
        console.error("❌ ERROR: No se encontró #upcoming-appointments");
        return;
    }

    const hoy = new Date();
    const maniana = new Date(hoy);
    maniana.setDate(hoy.getDate() + 1);
    const pasadoManiana = new Date(hoy);
    pasadoManiana.setDate(hoy.getDate() + 2);

    function nombreDia(fecha) {
        const dias = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
        return dias[fecha.getDay()];
    }

    function formatDateYMD(fecha) {
        const y = fecha.getFullYear();
        const m = String(fecha.getMonth() + 1).padStart(2, '0');
        const d = String(fecha.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    // Contar citas reales por día
    let conteo = { hoy: 0, maniana: 0, pasadoManiana: 0 };
    let citasData = [];
    try {
        const tenantId = await getCurrentTenantId();
        console.log('[cargarProximasCitas] tenantId obtenido:', tenantId);
        if (tenantId && supabaseClient) {
            // Obtener las próximas citas (desde hoy en adelante, sin límite de días)
            const hoyStrQ = formatDateYMD(hoy);
            console.log('[cargarProximasCitas] Consultando citas desde', hoyStrQ, 'para tenant', tenantId);
            const { data: citas, error } = await supabaseClient
                .from('citas')
                .select('fecha, hora, servicio_id, servicios(nombre)')
                .eq('tenant_id', tenantId)
                .gte('fecha', hoyStrQ)
                .order('fecha', { ascending: true })
                .limit(10);
            if (error) {
                console.error('[cargarProximasCitas] Error de Supabase:', error.message, error.details, error.hint);
                throw error;
            }
            citasData = citas || [];
            if (citasData.length > 0) {
                console.log('[cargarProximasCitas] Citas encontradas:', citasData.length, citasData);
                const hoyStr = formatDateYMD(hoy);
                const manianaStr = formatDateYMD(maniana);
                const pasadoStr = formatDateYMD(pasadoManiana);
                citasData.forEach(c => {
                    const cFecha = c.fecha ? c.fecha.split('T')[0] : '';
                    if (cFecha === hoyStr) conteo.hoy++;
                    else if (cFecha === manianaStr) conteo.maniana++;
                    else if (cFecha === pasadoStr) conteo.pasadoManiana++;
                });
            } else {
                console.log('[cargarProximasCitas] No hay citas futuras');
            }
        } else {
            console.warn('[cargarProximasCitas] tenantId o supabaseClient no disponible', { tenantId, supabaseClient: !!supabaseClient });
        }
    } catch (e) {
        console.warn('[cargarProximasCitas] usando datos simulados por fallo de consulta:', e.message || e);
        const servicios = await ServiciosManager.getAll();
        const totalCitas = servicios.length * 2;
        conteo = {
            hoy: Math.min(totalCitas, 5),
            maniana: Math.min(totalCitas + 2, 8),
            pasadoManiana: Math.min(totalCitas - 1, 3)
        };
    }

    const total = conteo.hoy + conteo.maniana + conteo.pasadoManiana;
    if (total === 0) {
        // Si no hay citas en los próximos 3 días pero hay citas futuras, mostrar las próximas 3
        if (citasData && citasData.length > 0) {
            console.log('[cargarProximasCitas] Sin citas en 3 días pero hay', citasData.length, 'citas futuras. Mostrando las próximas 3.');
            const proximas = citasData.slice(0, 3);
            contenedor.innerHTML = `
                <div class="calendar-days">
                    ${proximas.map((cita, idx) => {
                        const fechaCita = new Date(cita.fecha);
                        const esHoy = formatDateYMD(fechaCita) === formatDateYMD(hoy);
                        return `
                            <div class="day ${esHoy ? 'today' : ''}">
                                <strong>${nombreDia(fechaCita)}</strong>
                                <div class="day-number">${fechaCita.getDate()}</div>
                                <div class="appointments-count">
                                    <i class="fas fa-calendar-check"></i>
                                    <span>${cita.hora ? cita.hora.substring(0,5) : '—'}</span>
                                </div>
                                <span class="day-label">${cita.servicios?.nombre || 'Reserva'}</span>
                            </div>
                        `;
                    }).join('')}
                </div>
            `;
            return;
        }
        contenedor.innerHTML = `
            <div class="calendar-days">
                <div class="day empty">
                    <i class="fas fa-calendar-times"></i>
                    <p>No hay citas programadas</p>
                    <small>Las citas aparecerán aquí cuando los clientes reserven</small>
                </div>
            </div>
        `;
        return;
    }

    contenedor.innerHTML = `
        <div class="calendar-days">
            <div class="day today">
                <strong>${nombreDia(hoy)}</strong>
                <div class="day-number">${hoy.getDate()}</div>
                <div class="appointments-count">
                    <i class="fas fa-users"></i>
                    <span>${conteo.hoy}</span>
                </div>
                <span class="day-label">Hoy</span>
            </div>
            <div class="day">
                <strong>${nombreDia(maniana)}</strong>
                <div class="day-number">${maniana.getDate()}</div>
                <div class="appointments-count">
                    <i class="fas fa-users"></i>
                    <span>${conteo.maniana}</span>
                </div>
                <span class="day-label">Mañana</span>
            </div>
            <div class="day">
                <strong>${nombreDia(pasadoManiana)}</strong>
                <div class="day-number">${pasadoManiana.getDate()}</div>
                <div class="appointments-count">
                    <i class="fas fa-users"></i>
                    <span>${conteo.pasadoManiana}</span>
                </div>
                <span class="day-label">${pasadoManiana.toLocaleDateString('es-ES', { weekday: 'long' })}</span>
            </div>
        </div>
    `;
}
window.cargarProximasCitas = cargarProximasCitas;

async function limpiarBaseDatos() {
    const confirmacion1 = confirm('¿Estás seguro de borrar TODAS las citas?');
    if(!confirmacion1) return;

    const confirmacion2 = confirm('Esta acción no se puede deshacer');
    if(!confirmacion2) return;

    try{
        const tenantId = await getCurrentTenantId();
        if (!tenantId) {
            mostrarToast('No se pudo identificar el negocio', 'error');
            return;
        }

        let eliminadas = 0;
        if (window.__appointmentsApi && typeof window.__appointmentsApi.deleteAllCitas === 'function') {
            eliminadas = await window.__appointmentsApi.deleteAllCitas(tenantId);
        } else {
            // Fallback legacy (sin API unificada)
            const { data, error } = await supabaseClient
                .from('citas')
                .delete()
                .eq('tenant_id', String(tenantId).trim())
                .select('id');
            if (error) throw error;
            eliminadas = data?.length || 0;
        }

        if(typeof renderAdminAppointments === 'function') renderAdminAppointments();
        if(typeof updateProjectedRevenue === 'function') updateProjectedRevenue();
        mostrarToast(`Base de datos de citas eliminada (${eliminadas} cita${eliminadas !== 1 ? 's' : ''})`, 'success');
    }catch(err){
        console.error('limpiarBaseDatos error', err);
        mostrarToast('Error al limpiar la base de datos', 'error');
    }
}
window.limpiarBaseDatos = limpiarBaseDatos;

// Botón "Limpiar Base de Datos" inyectado por JS (sin onclick inline: la CSP
// hash-based bloquea handlers inline dinámicos — patrón CitasTutorial).
// Se crea una sola vez dentro del glass-panel de la sección de citas.
function configurarBotonLimpiarCitas() {
    const cont = document.getElementById('appointments-container');
    if (!cont || document.getElementById('btn-limpiar-citas')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'btn-limpiar-citas';
    btn.className = 'btn-small danger';
    btn.style.cssText = 'margin-top:16px;display:inline-flex;align-items:center;gap:6px;';
    btn.innerHTML = '<i class="fas fa-broom"></i> Limpiar Base de Datos';
    btn.title = 'Elimina TODAS las citas de tu negocio. El historial de ventas del dashboard se conserva.';
    btn.addEventListener('click', limpiarBaseDatos);
    cont.appendChild(btn);
}
window.configurarBotonLimpiarCitas = configurarBotonLimpiarCitas;

async function updateProjectedRevenue() {
    const target = document.getElementById('projected-revenue');
    if(!target) return;

    const citas = await CitasManager.getAll();
    if(!Array.isArray(citas) || citas.length === 0){
        target.textContent = formatearPeso(0);
        return;
    }

    const visibles = citas.filter(c => {
        if(!c) return false;
        const estado = c.estado ? String(c.estado).toLowerCase() : '';
        if(estado === 'completada') return false;
        const id = c.id;
        const validId = (typeof id === 'number' && !isNaN(id)) || (typeof id === 'string' && String(id).trim() !== '');
        if(!validId) return false;
        const nombreRaw = (c.contacto && c.contacto.nombre) ? c.contacto.nombre : (c.nombreCliente || '');
        const servicioRaw = c.nombre || c.servicioNombre || '';
        if(!nombreRaw || !servicioRaw) return false;
        return true;
    });

    const keys = ['precio','price','amount','valor','total','servicioPrecio','costo'];
    const total = visibles.reduce((sum, c) => {
        let val = 0;
        for(const k of keys){
            if(c[k] != null && !isNaN(Number(c[k]))){ val = Number(c[k]); break; }
            if(c.servicio && c.servicio[k] != null && !isNaN(Number(c.servicio[k]))){ val = Number(c.servicio[k]); break; }
        }
        return sum + (isNaN(val) ? 0 : val);
    }, 0);

    target.textContent = formatearPeso(total);
}
window.updateProjectedRevenue = updateProjectedRevenue;

function iniciarReloj() {
    function actualizarHora() {
        const elementoHora = document.getElementById('current-time');
        if (!elementoHora) return;

        const ahora = new Date();
        const horaFormateada = ahora.toLocaleTimeString('es-ES', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });

        elementoHora.textContent = horaFormateada;
    }

    actualizarHora();
    setInterval(actualizarHora, 60000);
}
window.iniciarReloj = iniciarReloj;

// ============ CALENDARIO FUNCIONES (sin cambios) ============
function initCalendar() {
    renderCalendar();
    setupCalendarEvents();
}
window.initCalendar = initCalendar;

function renderCalendar() {
    const calendarDays = document.getElementById('calendar-days');
    const monthYear = document.getElementById('current-month');

    if (!calendarDays || !monthYear) {
        console.error("❌ Elementos del calendario no encontrados");
        return;
    }

    calendarDays.innerHTML = '';

    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();

    const monthNames = [
        'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
        'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
    ];
    monthYear.textContent = `${monthNames[month]} ${year}`;

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    let firstDayIndex = firstDay.getDay();
    firstDayIndex = firstDayIndex === 0 ? 6 : firstDayIndex - 1;

    const daysInMonth = lastDay.getDate();

    const prevMonthLastDay = new Date(year, month, 0).getDate();

    for (let i = firstDayIndex; i > 0; i--) {
        const day = document.createElement('div');
        day.className = 'calendar-day disabled';
        day.textContent = prevMonthLastDay - i + 1;
        calendarDays.appendChild(day);
    }

    const today = new Date();
    today.setHours(12, 0, 0, 0);

    for (let i = 1; i <= daysInMonth; i++) {
        const day = document.createElement('div');
        day.className = 'calendar-day';
        day.textContent = i;

        const dateObj = new Date(Date.UTC(year, month, i, 12, 0, 0, 0));
        const dateStr = formatDate(dateObj);
        day.dataset.date = dateStr;

        const todayStr = formatDate(today);
        if (dateStr === todayStr) {
            day.classList.add('today');
        }

        if (dateObj < today && dateStr !== todayStr) {
            day.classList.add('past');
            day.classList.add('disabled');
        }

        if (selectedDates.has(dateStr)) {
            day.classList.add('selected');
        }

        calendarDays.appendChild(day);
    }

    const totalDays = firstDayIndex + daysInMonth;
    const nextDays = 42 - totalDays;

    for (let i = 1; i <= nextDays; i++) {
        const day = document.createElement('div');
        day.className = 'calendar-day disabled';
        day.textContent = i;
        calendarDays.appendChild(day);
    }
}
window.renderCalendar = renderCalendar;

function setupCalendarEvents() {
    document.getElementById('prev-month')?.addEventListener('click', () => {
        currentDate.setMonth(currentDate.getMonth() - 1);
        renderCalendar();
    });

    document.getElementById('next-month')?.addEventListener('click', () => {
        currentDate.setMonth(currentDate.getMonth() + 1);
        renderCalendar();
    });

    document.getElementById('calendar-days')?.addEventListener('click', (e) => {
        const dayElement = e.target.closest('.calendar-day');
        if (!dayElement || dayElement.classList.contains('disabled')) return;

        const dateStr = dayElement.dataset.date;
        if (!dateStr) return;

        toggleDateSelection(dateStr, dayElement);
    });

    document.getElementById('clear-all-dates')?.addEventListener('click', () => {
        selectedDates.clear();
        renderCalendar();
        if (_assignmentMode === 'date' && typeof actualizarSelectorFechas === 'function') {
            actualizarSelectorFechas();
        }
        if (typeof renderModulesList === 'function') {
            renderModulesList();
        }
    });

    document.getElementById('select-weekends')?.addEventListener('click', () => {
        selectWeekendsOnly();
    });

    document.getElementById('select-weekdays')?.addEventListener('click', () => {
        selectWeekdaysOnly();
    });
}
window.setupCalendarEvents = setupCalendarEvents;

function toggleDateSelection(dateStr, dayElement = null) {
    if (selectedDates.has(dateStr)) {
        selectedDates.delete(dateStr);
        if (dayElement) dayElement.classList.remove('selected');
    } else {
        selectedDates.add(dateStr);
        if (dayElement) dayElement.classList.add('selected');
    }

    // Actualizar selector de fechas si está en modo date
    if (_assignmentMode === 'date' && typeof actualizarSelectorFechas === 'function') {
        actualizarSelectorFechas();
    }
    // Refrescar checkboxes weekday si está en modo weekday
    if (_assignmentMode === 'weekday' && typeof refrescarCheckboxesWeekday === 'function') {
        refrescarCheckboxesWeekday();
    }
    // Refrescar cards de horarios con las nuevas fechas seleccionadas
    if (typeof renderModulesList === 'function') {
        renderModulesList();
    }
}
window.toggleDateSelection = toggleDateSelection;

function selectWeekendsOnly() {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const endDate = new Date(today);
    endDate.setMonth(endDate.getMonth() + 3);

    selectedDates.clear();

    let current = new Date(today);
    while (current <= endDate) {
        const dayOfWeek = current.getDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) {
            const dateStr = formatDate(current);
            selectedDates.add(dateStr);
        }
        current.setDate(current.getDate() + 1);
    }

    renderCalendar();
    if (_assignmentMode === 'date' && typeof actualizarSelectorFechas === 'function') {
        actualizarSelectorFechas();
    }
    // Refrescar checkboxes weekday si está en modo weekday
    if (_assignmentMode === 'weekday' && typeof refrescarCheckboxesWeekday === 'function') {
        refrescarCheckboxesWeekday();
    }
    // Refrescar cards de horarios con las nuevas fechas seleccionadas
    if (typeof renderModulesList === 'function') {
        renderModulesList();
    }
}

function selectWeekdaysOnly() {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const endDate = new Date(today);
    endDate.setMonth(endDate.getMonth() + 3);

    selectedDates.clear();

    let current = new Date(today);
    while (current <= endDate) {
        const dayOfWeek = current.getDay();
        if (dayOfWeek >= 1 && dayOfWeek <= 5) {
            const dateStr = formatDate(current);
            selectedDates.add(dateStr);
        }
        current.setDate(current.getDate() + 1);
    }

    renderCalendar();
    if (_assignmentMode === 'date' && typeof actualizarSelectorFechas === 'function') {
        actualizarSelectorFechas();
    }
    // Refrescar checkboxes weekday si está en modo weekday
    if (_assignmentMode === 'weekday' && typeof refrescarCheckboxesWeekday === 'function') {
        refrescarCheckboxesWeekday();
    }
    // Refrescar cards de horarios con las nuevas fechas seleccionadas
    if (typeof renderModulesList === 'function') {
        renderModulesList();
    }
}
window.selectWeekdaysOnly = selectWeekdaysOnly;

// ============ VARIABLES GLOBALES PARA ASIGNACIÓN DE MÓDULOS POR FECHA/DÍA ============
// Modo de asignación: 'all' (default), 'weekday', 'date'
let _assignmentMode = 'all';
// Almacena módulos específicos por día de la semana: { 1: [...], 3: [...] }
let _weekdayModules = {};
// Almacena módulos específicos por fecha: { '2025-06-10': [...] }
let _dateSpecificModules = {};
// Fecha actualmente seleccionada en el panel de fecha específica
let _selectedDateForModules = null;
// Flag de cambios sin guardar
let _unsavedChanges = false;
// Día activo en modo weekday
let _currentEditingWeekday = null;
// ============ ESTADO DE EDICIÓN ============
// ID del servicio que se está editando (null = modo creación)
let editServiceId = null;
// Limpieza centralizada del estado de edición
function limpiarEstadoEdicion() {
    editServiceId = null;
    const form = document.getElementById('service-form');
    if (form) {
        delete form.dataset.editId;
        const submitBtn = form.querySelector('button[type="submit"]');
        if (submitBtn) {
            submitBtn.innerHTML = '<i class="fas fa-plus-circle"></i> CREAR SERVICIO';
            submitBtn.disabled = false;
        }
        form.reset();
        // Resetear tipo de venta a "por sesión" (ocultar campos promo)
        const promoFieldsReset = document.getElementById('promo-fields');
        if (promoFieldsReset) promoFieldsReset.style.display = 'none';
        const priceReset = document.getElementById('srv-price');
        if (priceReset) priceReset.placeholder = 'Precio ($)*';
        document.querySelectorAll('.tipo-venta-option').forEach(o => o.classList.toggle('active', o.dataset.tipo === 'sesion'));
        const calcReset = document.getElementById('promo-calc-hint');
        if (calcReset) calcReset.textContent = '';
    }
    // Resetear file input y display
    const fileInput = document.getElementById('srv-image-file');
    if (fileInput) fileInput.value = '';
    const fileNameDisplay = document.getElementById('file-name-display');
    if (fileNameDisplay) fileNameDisplay.textContent = 'Elegir imagen';
    const progressBar = document.getElementById('image-upload-progress');
    if (progressBar) progressBar.style.display = 'none';
    const cancelBtn = document.getElementById('cancel-edit');
    if (cancelBtn) cancelBtn.remove();
    // Restaurar variables globales de módulos a valores iniciales
    selectedDates.clear();
    _assignmentMode = 'all';
    _weekdayModules = {};
    _dateSpecificModules = {};
    window.moduleDateCupos = {};
    window.serviceModules = [];
    if (typeof renderCalendar === 'function') renderCalendar();
    if (typeof clearAllModules === 'function') clearAllModules();
    // === UX: restaurar título de la sección ===
    const titleEl = document.getElementById('section-title-servicio');
    if (titleEl) {
        titleEl.innerHTML = '<i class="fas fa-plus-circle"></i> Crear Nuevo Servicio';
    }
    // Refrescar checkboxes de trabajadores (form vacío → sin marcas de cobertura)
    window.dispatchEvent(new CustomEvent('servicio-modulos-actualizados'));
}
window.limpiarEstadoEdicion = limpiarEstadoEdicion;

/**
 * setAssignmentMode — cambia el modo de asignación de horarios
 * 'all': los mismos módulos para todas las fechas
 * 'weekday': módulos distintos según día de la semana
 * 'date': módulos distintos por fecha específica
 */
function setAssignmentMode(mode) {
    _assignmentMode = mode;
    // Actualizar botones
    document.querySelectorAll('.assignment-mode-selector .mode-btn').forEach(btn => {
        const btnMode = btn.dataset.mode;
        if (btnMode === mode) {
            btn.style.background = 'var(--primary-color)';
            btn.classList.add('active');
        } else {
            btn.style.background = 'rgba(255,255,255,0.1)';
            btn.classList.remove('active');
        }
    });
    // Mostrar/ocultar paneles
    document.getElementById('weekday-selector').style.display = mode === 'weekday' ? 'block' : 'none';
    document.getElementById('date-selector-panel').style.display = mode === 'date' ? 'block' : 'none';
    
    // En modo 'date', actualizar el selector de fechas
    if (mode === 'date') {
        actualizarSelectorFechas();
    }
    
    // En modo 'all', restaurar la base general en el editor
    if (mode === 'all') {
        if (window._weekdayBaseSnapshot && window._weekdayBaseSnapshot.length > 0) {
            window.serviceModules = structuredClone(window._weekdayBaseSnapshot);
        }
        if (typeof renderModulesEditable === 'function') {
            renderModulesEditable();
        }
    }
    
    // En modo 'weekday', refrescar checkboxes según las fechas reales
    // y tomar snapshot de la base general para reset inteligente
    if (mode === 'weekday') {
        if (typeof refrescarCheckboxesWeekday === 'function') {
            refrescarCheckboxesWeekday();
        }
        // Snapshot de la base general actual (deep clone) para reset inteligente
        window._weekdayBaseSnapshot = structuredClone(window.serviceModules || []);
    }
    
    // Refrescar la vista de módulos
    if (typeof renderModulesList === 'function') {
        renderModulesList();
    }
    
    // Si no es modo weekday, limpiar variable e indicador
    if (mode !== 'weekday') {
        _currentEditingWeekday = null;
    }
    
    console.log('[modo-asignacion] Cambiado a:', mode);
}
window.setAssignmentMode = setAssignmentMode;

/**
 * actualizarSelectorFechas — llena el <select> con las fechas del calendario
 */
function actualizarSelectorFechas() {
    const sel = document.getElementById('date-selector-select');
    if (!sel) return;
    const currentVal = sel.value;
    sel.innerHTML = '<option value="">— Selecciona una fecha —</option>';
    const sortedDates = Array.from(selectedDates || []).sort((a, b) => a.localeCompare(b));
    sortedDates.forEach(date => {
        const opt = document.createElement('option');
        opt.value = date;
        // Mostrar si tiene módulos personalizados
        const hasCustom = _dateSpecificModules[date] && _dateSpecificModules[date].length > 0;
        const diaSemana = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'][new Date(date + 'T12:00:00').getDay()];
        opt.textContent = `${date} (${diaSemana})${hasCustom ? ' ✏️' : ''}`;
        sel.appendChild(opt);
    });
    if (currentVal && [...sel.options].some(o => o.value === currentVal)) {
        sel.value = currentVal;
    }
    _selectedDateForModules = sel.value || null;
}

/**
 * onDateSelectorChange — cuando el usuario selecciona una fecha en modo 'date'
 */
function onDateSelectorChange(sel) {
    const newDate = sel.value || null;
    
    // Preguntar si hay cambios sin guardar
    if (_unsavedChanges && _selectedDateForModules && newDate !== _selectedDateForModules) {
        if (!confirm('Tienes cambios sin guardar en los módulos actuales. ¿Guardarlos antes de cambiar de fecha?')) {
            // No guardar, restaurar el valor anterior
            sel.value = _selectedDateForModules;
            return;
        }
        // Guardar antes de cambiar
        guardarAsignacionActual();
    }
    
    _selectedDateForModules = newDate;
    if (_selectedDateForModules) {
        cargarModulosDeFecha(_selectedDateForModules);
    }
    _unsavedChanges = false;
}
window.onDateSelectorChange = onDateSelectorChange;

/**
 * cargarModulosDeFecha — carga los módulos de una fecha específica al editor
 * Si la fecha no tiene módulos personalizados, carga los generales (window.serviceModules)
 */
function cargarModulosDeFecha(fecha) {
    if (!fecha) return;
    // Guardar módulos actuales en el almacén correspondiente antes de cambiar
    guardarModulosActuales();
    
    // Cargar módulos de la fecha (o generales si no tiene)
    const mods = _dateSpecificModules[fecha] || [];
    if (mods.length > 0) {
        // Reemplazar window.serviceModules con los de esta fecha (deep clone)
        window.serviceModules = structuredClone(mods);
    } else {
        // Sin módulos específicos → reset inteligente: cargar deep clone del snapshot base
        const base = window._weekdayBaseSnapshot || window.serviceModules || [];
        window.serviceModules = base.length > 0 ? structuredClone(base) : [];
    }
    
    renderModulesEditable();
    if (typeof renderModulesList === 'function') renderModulesList();
}

/**
 * guardarModulosActuales — guarda los módulos actuales del editor
 * en el almacén que corresponda según el modo activo
 */
function guardarModulosActuales() {
    if (!window.serviceModules) return;
    
    // Sincronizar cupos editados en cards antes de guardar
    // Esto evita que guardar pisos los cupos personalizados por fecha
    const modulesList = document.getElementById('modules-list');
    if (modulesList) {
        const inputs = modulesList.querySelectorAll('.module-cupos-input');
        inputs.forEach(inp => {
            const fecha = inp.dataset.fecha;
            const hora = inp.dataset.hora;
            if (!fecha || !hora) return;
            if (!window.moduleDateCupos) window.moduleDateCupos = {};
            if (!window.moduleDateCupos[fecha]) window.moduleDateCupos[fecha] = {};
            window.moduleDateCupos[fecha][hora] = Number(inp.value || 0);
        });
    }
    
    if (_assignmentMode === 'weekday') {
        // Guardar en día semana activo (los checkboxes marcados) — deep clone
        document.querySelectorAll('.weekday-cb:checked').forEach(cb => {
            const day = parseInt(cb.value);
            _weekdayModules[day] = structuredClone(window.serviceModules);
        });
    } else if (_assignmentMode === 'date' && _selectedDateForModules) {
        // Guardar en fecha específica — deep clone
        if (window.serviceModules.length > 0) {
            _dateSpecificModules[_selectedDateForModules] = structuredClone(window.serviceModules);
        } else {
            delete _dateSpecificModules[_selectedDateForModules];
        }
    }
}

/**
 * generarDisponibilidadFinal — Consolida los 3 almacenes actuales respetando jerarquía:
 *   1. _dateSpecificModules[fecha]   (máxima prioridad)
 *   2. _weekdayModules[dia]          (prioridad media)
 *   3. window.serviceModules         (base general)
 * 
 * Devuelve: { "2026-06-10": [{ hora:"09:00", cupos:5, duration:60, endTime:"10:00", ... }], ... }
 * Solo incluye las fechas que existen en selectedDates.
 */
function generarDisponibilidadFinal() {
    const resultado = {};
    
    const fechas = Array.from(selectedDates || []).sort();
    if (fechas.length === 0) return resultado;
    
    // Pre-coleccionar qué días de semana están presentes en selectedDates
    const diasConFechas = new Set();
    fechas.forEach(f => diasConFechas.add(new Date(f + 'T12:00:00').getDay()));
    
    fechas.forEach(fecha => {
        const day = new Date(fecha + 'T12:00:00').getDay();
        let mods = null;
        let fuente = 'ninguna';
        
        // 1. Prioridad máxima: fecha específica
        if (_dateSpecificModules[fecha] && _dateSpecificModules[fecha].length > 0) {
            mods = _dateSpecificModules[fecha];
            fuente = 'dateSpecific';
        }
        // 2. Prioridad media: día de la semana
        else if (_weekdayModules[day] && _weekdayModules[day].length > 0) {
            mods = _weekdayModules[day];
            fuente = 'weekday';
        }
        // 3. Prioridad base: generales
        else if (window.serviceModules && window.serviceModules.length > 0) {
            mods = window.serviceModules;
            fuente = 'general';
        }
        
        if (mods && mods.length > 0) {
            resultado[fecha] = mods.map(m => ({
                id: m.id || (generateModuleId()),
                hora: m.hora || m.startTime || '00:00',
                startTime: m.startTime || m.hora || '00:00',
                endTime: m.endTime || calcularFinModulo(m.hora || m.startTime || '00:00', m.duration || 60),
                cupos: typeof m.cupos !== 'undefined' ? Number(m.cupos) : 0,
                duration: m.duration || 60,
                editable: m.editable !== false,
                _fuente: fuente
            }));
        }
    });
    
    return resultado;
}
window.generarDisponibilidadFinal = generarDisponibilidadFinal;

/**
 * contarFechasEspecificasActivas — Cuenta y categoriza las configuraciones específicas activas
 * que tienen prioridad sobre la base general (all).
 */
function contarFechasEspecificasActivas() {
    const fechasEspecificas = Object.keys(_dateSpecificModules || {}).filter(f => {
        return _dateSpecificModules[f] && _dateSpecificModules[f].length > 0;
    }).length;

    const diasSemanaEspecificos = Object.keys(_weekdayModules || {}).filter(d => {
        return _weekdayModules[d] && _weekdayModules[d].length > 0;
    }).length;

    return {
        tieneEspecificos: fechasEspecificas > 0 || diasSemanaEspecificos > 0,
        fechasEspecificas,
        diasSemanaEspecificos
    };
}
window.contarFechasEspecificasActivas = contarFechasEspecificasActivas;

/**
 * Sobrescribe saveModulesToHiddenField para incluir datos de asignación
 */
const _originalSaveModules = window.saveModulesToHiddenField || function(){};
function saveModulesToHiddenField() {
    const hidden = document.getElementById('service-modules');
    if (!hidden) return;
    
    // Guardar módulos generales
    const payload = {
        mode: _assignmentMode,
        general: (window.serviceModules || []).map(m => ({
            id: m.id,
            hora: m.hora || m.startTime,
            startTime: m.startTime,
            endTime: m.endTime,
            cupos: m.cupos || 0,
            duration: m.duration || 60,
            editable: m.editable !== false
        })),
        weekday: {},
        dateSpecific: {}
    };
    
    // Guardar módulos por día de semana
    Object.keys(_weekdayModules).forEach(day => {
        payload.weekday[day] = _weekdayModules[day].map(m => ({
            id: m.id,
            hora: m.hora || m.startTime,
            startTime: m.startTime,
            endTime: m.endTime,
            cupos: m.cupos || 0,
            duration: m.duration || 60,
            editable: m.editable !== false
        }));
    });
    
    // Guardar módulos por fecha específica
    Object.keys(_dateSpecificModules).forEach(fecha => {
        payload.dateSpecific[fecha] = _dateSpecificModules[fecha].map(m => ({
            id: m.id,
            hora: m.hora || m.startTime,
            startTime: m.startTime,
            endTime: m.endTime,
            cupos: m.cupos || 0,
            duration: m.duration || 60,
            editable: m.editable !== false
        }));
    });
    
    hidden.value = JSON.stringify(payload);
    
    // También actualizar date-selector si está visible
    if (_assignmentMode === 'date') {
        const sel = document.getElementById('date-selector-select');
        if (sel) {
            const currentOpt = sel.options[sel.selectedIndex];
            if (currentOpt && currentOpt.value) {
                const hasCustom = _dateSpecificModules[currentOpt.value] && _dateSpecificModules[currentOpt.value].length > 0;
                const diaSemana = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'][new Date(currentOpt.value + 'T12:00:00').getDay()];
                currentOpt.textContent = `${currentOpt.value} (${diaSemana})${hasCustom ? ' ✏️' : ''}`;
            }
        }
    }
}
window.saveModulesToHiddenField = saveModulesToHiddenField;
function initModules() {
    // Inicializar modo de asignación (ocultar área de guardado si es 'all')
    if (typeof setAssignmentMode === 'function') {
        setAssignmentMode('all');
    }
    setupModuleEvents();
    setupWeekdayCheckboxEvents();
    setupClearAssignmentButton();
    updateDurationDisplay();
    loadModulesFromHiddenField();
}
window.initModules = initModules;

function setupWeekdayCheckboxEvents() {
    document.querySelectorAll('.weekday-cb').forEach(cb => {
        cb.addEventListener('change', function() {
            if (_assignmentMode !== 'weekday') return;
            const day = parseInt(this.value);
            
            // Guardar módulos actuales en el día que se estaba editando
            if (_currentEditingWeekday !== null && _currentEditingWeekday !== day) {
                guardarModulosActuales();
            }
            
            _currentEditingWeekday = this.checked ? day : null;
            
            if (this.checked && _weekdayModules[day] && _weekdayModules[day].length > 0) {
                // Cargar módulos guardados de este día (deep clone)
                window.serviceModules = structuredClone(_weekdayModules[day]);
                renderModulesEditable();
            } else if (this.checked && (!_weekdayModules[day] || _weekdayModules[day].length === 0)) {
                // Sin módulos guardados → reset inteligente: cargar deep clone de la base general
                const base = window._weekdayBaseSnapshot || window.serviceModules;
                window.serviceModules = structuredClone(base);
                renderModulesEditable();
            } else if (!this.checked) {
                // Desmarcó → solo pierde el foco de edición, NO borra módulos guardados
                // Si ya no hay checkboxes marcados, restaurar base general en el editor
                const anyChecked = !!document.querySelector('.weekday-cb:checked');
                if (!anyChecked && _currentEditingWeekday === null) {
                    const base = window._weekdayBaseSnapshot || window.serviceModules;
                    window.serviceModules = structuredClone(base);
                    renderModulesEditable();
                }
            }
            
            // Actualizar indicador visual
            actualizarIndicadorWeekday();
            
            if (typeof renderModulesList === 'function') {
                renderModulesList();
            }
            if (typeof actualizarEstadoAsignacion === 'function') {
                actualizarEstadoAsignacion();
            }
        });
    });
}
window.setupWeekdayCheckboxEvents = setupWeekdayCheckboxEvents;

/**
 * actualizarIndicadorWeekday — muestra/oculta el indicador de qué día se edita
 */
function actualizarIndicadorWeekday() {
    const indicator = document.getElementById('weekday-editing-indicator');
    const nameSpan = document.getElementById('weekday-editing-name');
    if (!indicator || !nameSpan) return;
    
    if (_assignmentMode === 'weekday' && _currentEditingWeekday !== null) {
        const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
        nameSpan.textContent = dayNames[_currentEditingWeekday];
        indicator.style.display = 'block';
    } else {
        indicator.style.display = 'none';
    }
}
window.actualizarIndicadorWeekday = actualizarIndicadorWeekday;

/**
 * refrescarCheckboxesWeekday — actualiza los checkboxes según las fechas del calendario
 * Solo muestra días que existen en selectedDates
 */
function refrescarCheckboxesWeekday() {
    const container = document.getElementById('weekday-checkboxes');
    if (!container) return;
    
    // Obtener días únicos presentes en selectedDates
    const diasEnCalendario = new Set();
    (selectedDates || []).forEach(f => {
        diasEnCalendario.add(new Date(f + 'T12:00:00').getDay());
    });
    
    const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const dayOrder = [1, 2, 3, 4, 5, 6, 0]; // Lun primero
    
    let html = '';
    dayOrder.forEach(d => {
        if (!diasEnCalendario.has(d)) return;
        
        const checked = _weekdayModules[d] && _weekdayModules[d].length > 0 ? ' checked' : '';
        html += '<label style="display:flex;align-items:center;gap:4px;padding:4px 8px;background:rgba(255,255,255,0.05);border-radius:4px;cursor:pointer;">' +
            '<input type="checkbox" class="weekday-cb" value="' + d + '"' + checked + '> ' + dayNames[d] +
            '</label>';
    });
    
    container.innerHTML = html;
    
    // Re-asignar eventos a los nuevos checkbox
    setupWeekdayCheckboxEvents();
    
    // Si el día que se estaba editando ya no existe en los checkboxes, limpiar
    if (_currentEditingWeekday !== null) {
        const dayExists = container.querySelector('.weekday-cb[value="' + _currentEditingWeekday + '"]');
        if (!dayExists) {
            _currentEditingWeekday = null;
        }
    }
    actualizarIndicadorWeekday();
}
window.refrescarCheckboxesWeekday = refrescarCheckboxesWeekday;

/**
 * guardarAsignacionActual — guarda los módulos actuales del editor
 * en los días/fechas seleccionados según el modo activo.
 * También actualiza los indicadores de estado.
 */
function guardarAsignacionActual() {
    if (!window.serviceModules || window.serviceModules.length === 0) {
        mostrarMensaje('No hay módulos para guardar. Genera algunos primero.', 'warning');
        return;
    }
    
    // Centralizar: delegar el guardado real a guardarModulosActuales()
    // que ya sincroniza cupos de cards y hace deep clone
    guardarModulosActuales();
    
    if (_assignmentMode === 'weekday') {
        if (_currentEditingWeekday === null) {
            mostrarMensaje('Selecciona un día de la semana para asignar los módulos.', 'warning');
            return;
        }
        // Refrescar checkboxes para mostrar checked correcto
        if (typeof refrescarCheckboxesWeekday === 'function') {
            refrescarCheckboxesWeekday();
        }
        const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
        mostrarMensaje(`✅ Módulos asignados a ${dayNames[_currentEditingWeekday]}`, 'success');
    } else if (_assignmentMode === 'date') {
        if (!_selectedDateForModules) {
            mostrarMensaje('Selecciona una fecha específica en el panel de arriba.', 'warning');
            return;
        }
        mostrarMensaje(`✅ Módulos asignados a la fecha ${_selectedDateForModules}`, 'success');
        // Actualizar el selector de fechas para mostrar ✏️
        if (typeof actualizarSelectorFechas === 'function') {
            actualizarSelectorFechas();
        }
    } else {
        mostrarMensaje('Cambia a modo "Por día de semana" o "Por fecha específica" para usar esta función.', 'info');
        return;
    }
    
    // Actualizar indicadores de estado
    actualizarEstadoAsignacion();
    _unsavedChanges = false;
    saveModulesToHiddenField();
    if (typeof renderModulesList === 'function') renderModulesList();
}
window.guardarAsignacionActual = guardarAsignacionActual;

/**
 * actualizarEstadoAsignacion — muestra qué días/fechas tienen módulos asignados y cuáles faltan
 */
function actualizarEstadoAsignacion() {
    const statusEl = document.getElementById('assignment-status');
    if (!statusEl) return;
    
    if (_assignmentMode === 'weekday') {
        const allDays = [0, 1, 2, 3, 4, 5, 6];
        const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
        let partes = [];
        let pendientes = [];
        allDays.forEach(d => {
            // Solo mostrar los días que tienen fechas en el calendario
            const fechaEjemplo = [...(selectedDates || [])].find(f => {
                return new Date(f + 'T12:00:00').getDay() === d;
            });
            if (!fechaEjemplo) return; // este día no tiene fechas en calendario
            
            const assigned = _weekdayModules[d] && _weekdayModules[d].length > 0;
            const icon = assigned ? '✅' : '⬜';
            partes.push(`${icon} ${dayNames[d]}`);
            if (!assigned) pendientes.push(dayNames[d]);
        });
        if (partes.length === 0) {
            statusEl.textContent = 'No hay fechas seleccionadas en el calendario para este modo.';
        } else if (pendientes.length === 0) {
            statusEl.innerHTML = partes.join(' · ') + ' — <strong style="color:#00b894;">Completo ✅</strong>';
        } else {
            statusEl.innerHTML = partes.join(' · ') + ` — <strong style="color:var(--warning-color);">Faltan: ${pendientes.join(', ')} ⬜</strong>`;
        }
    } else if (_assignmentMode === 'date') {
        const totalDates = selectedDates ? selectedDates.size : 0;
        if (totalDates === 0) {
            statusEl.textContent = 'No hay fechas seleccionadas en el calendario.';
            return;
        }
        let asignadas = 0;
        selectedDates.forEach(f => {
            if (_dateSpecificModules[f] && _dateSpecificModules[f].length > 0) asignadas++;
        });
        const pendientes = totalDates - asignadas;
        if (pendientes === 0) {
            statusEl.innerHTML = `${asignadas} de ${totalDates} fechas asignadas — <strong style="color:#00b894;">Completo ✅</strong>`;
        } else {
            statusEl.innerHTML = `${asignadas} de ${totalDates} fechas asignadas — <strong style="color:var(--warning-color);">${pendientes} pendientes ⬜</strong>`;
        }
    }
}
window.actualizarEstadoAsignacion = actualizarEstadoAsignacion;

/**
 * obtenerEstadoAsignacion — devuelve un objeto con el estado de asignación
 * para validación antes de crear servicio
 */
function obtenerEstadoAsignacion() {
    const result = { completo: true, pendientes: [] };
    if (_assignmentMode === 'all' || _assignmentMode === undefined) return result;
    
    if (_assignmentMode === 'weekday') {
        const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
        const diasEnCalendario = new Set();
        (selectedDates || []).forEach(f => {
            diasEnCalendario.add(new Date(f + 'T12:00:00').getDay());
        });
        diasEnCalendario.forEach(d => {
            if (!_weekdayModules[d] || _weekdayModules[d].length === 0) {
                result.completo = false;
                result.pendientes.push(dayNames[d]);
            }
        });
    } else if (_assignmentMode === 'date') {
        (selectedDates || []).forEach(f => {
            if (!_dateSpecificModules[f] || _dateSpecificModules[f].length === 0) {
                result.completo = false;
                result.pendientes.push(f);
            }
        });
    }
    return result;
}

/**
 * Modificar setAssignmentMode para mostrar/ocultar el área de guardado
 * y actualizar el estado
 */
const _originalSetAssignmentMode = window.setAssignmentMode;
/**
 * setupModuleEvents — addEventListener para generación y confirmación de módulos
 */
function setupModuleEvents() {
    document.getElementById('generate-modules-btn')?.addEventListener('click', generarModulosAutomaticos);
    document.getElementById('confirm-modules-btn')?.addEventListener('click', confirmarModulos);

    document.getElementById('service-modules')?.addEventListener('change', function() {
        loadModulesFromHiddenField();
    });
}
window.setupModuleEvents = setupModuleEvents;

/**
 * setupClearAssignmentButton — botón para limpiar la asignación del día/fecha activo
 */
function setupClearAssignmentButton() {
    document.getElementById('clear-current-assignment')?.addEventListener('click', function() {
        if (_assignmentMode === 'weekday') {
            if (_currentEditingWeekday === null) {
                mostrarMensaje('No hay un día seleccionado para limpiar.', 'warning');
                return;
            }
            if (!_weekdayModules[_currentEditingWeekday] || _weekdayModules[_currentEditingWeekday].length === 0) {
                mostrarMensaje('Este día no tiene módulos asignados.', 'info');
                return;
            }
            const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
            if (!confirm(`¿Limpiar módulos asignados para ${dayNames[_currentEditingWeekday]}?`)) return;
            delete _weekdayModules[_currentEditingWeekday];
            // Desmarcar checkbox
            const cb = document.querySelector('.weekday-cb[value="' + _currentEditingWeekday + '"]');
            if (cb) cb.checked = false;
            _currentEditingWeekday = null;
            mostrarMensaje('🧹 Asignación limpiada para ese día.', 'info');
            if (typeof refrescarCheckboxesWeekday === 'function') refrescarCheckboxesWeekday();
            actualizarIndicadorWeekday();
        } else if (_assignmentMode === 'date') {
            if (!_selectedDateForModules) {
                mostrarMensaje('No hay una fecha seleccionada para limpiar.', 'warning');
                return;
            }
            if (!_dateSpecificModules[_selectedDateForModules] || _dateSpecificModules[_selectedDateForModules].length === 0) {
                mostrarMensaje('Esta fecha no tiene módulos asignados.', 'info');
                return;
            }
            if (!confirm(`¿Limpiar módulos asignados para ${_selectedDateForModules}?`)) return;
            delete _dateSpecificModules[_selectedDateForModules];
            mostrarMensaje(`🧹 Asignación limpiada para ${_selectedDateForModules}.`, 'info');
            if (typeof actualizarSelectorFechas === 'function') actualizarSelectorFechas();
        } else {
            mostrarMensaje('Esta opción solo está disponible en modo "Por día de semana" o "Por fecha específica".', 'info');
            return;
        }
        _unsavedChanges = false;
        saveModulesToHiddenField();
        if (typeof renderModulesList === 'function') renderModulesList();
        if (typeof actualizarEstadoAsignacion === 'function') actualizarEstadoAsignacion();
    });
}
window.setupClearAssignmentButton = setupClearAssignmentButton;

// ============ FIN ASIGNACIÓN DE MÓDULOS ============

/**
 * updateDurationDisplay — muestra la duración total de todos los módulos configurados
 * Reimplementada porque fue eliminada por error (llamada desde varios lugares)
 */
function updateDurationDisplay() {
    if (!window.serviceModules || !window.serviceModules.length) return;
    const totalMin = window.serviceModules.reduce((acc, m) => {
        if (m.startTime && m.endTime) {
            const [h1, m1] = m.startTime.split(':').map(Number);
            const [h2, m2] = m.endTime.split(':').map(Number);
            return acc + ((h2 * 60 + m2) - (h1 * 60 + m1));
        }
        return acc + (m.duration || 60);
    }, 0);
    const horas = Math.floor(totalMin / 60);
    const mins = totalMin % 60;
    // Buscar un elemento existente para mostrar la duración, o mostrarlo en consola
    const durEl = document.getElementById('srv-duration-display') || document.querySelector('.duration-summary');
    if (durEl) {
        durEl.textContent = horas > 0 ? `${horas}h ${mins}min` : `${mins}min`;
    }
}
window.updateDurationDisplay = updateDurationDisplay;

/**
 * Calcula hora fin a partir de hora inicio + duración en minutos
 * @param {string} horaInicio - "HH:MM"
 * @param {number} duracionMin - minutos de duración
 * @returns {string} "HH:MM"
 */
function calcularFinModulo(horaInicio, duracionMin) {
    if (!horaInicio || !duracionMin) return horaInicio;
    const [h, m] = horaInicio.split(':').map(Number);
    const total = h * 60 + m + Number(duracionMin);
    const finH = Math.floor(total / 60) % 24;
    const finM = total % 60;
    return String(finH).padStart(2, '0') + ':' + String(finM).padStart(2, '0');
}

/**
 * Verifica si dos rangos horarios se solapan
 * @param {string} s1 - inicio rango 1 "HH:MM"
 * @param {string} e1 - fin rango 1 "HH:MM"  
 * @param {string} s2 - inicio rango 2 "HH:MM"
 * @param {string} e2 - fin rango 2 "HH:MM"
 * @returns {boolean} true si solapan
 */
function horariosSolapan(s1, e1, s2, e2) {
    const a = s1.split(':').map(Number);
    const b = e1.split(':').map(Number);
    const c = s2.split(':').map(Number);
    const d = e2.split(':').map(Number);
    const start1 = a[0]*60 + a[1];
    const end1 = b[0]*60 + b[1];
    const start2 = c[0]*60 + c[1];
    const end2 = d[0]*60 + d[1];
    return start1 < end2 && start2 < end1;
}

/**
 * haySolapamientoEnEditor — Verifica si un módulo se solapa con otro existente
 * @param {number} idx — índice del módulo que se está editando (se excluye de la comparación)
 * @param {string} startTime — "HH:MM" nuevo inicio
 * @param {string} endTime — "HH:MM" nuevo fin
 * @returns {boolean} true si hay solapamiento
 */
function haySolapamientoEnEditor(idx, startTime, endTime) {
    if (!window.serviceModules) return false;
    const [nsH, nsM] = startTime.split(':').map(Number);
    const [neH, neM] = endTime.split(':').map(Number);
    const nuevoInicio = nsH * 60 + nsM;
    const nuevoFin = neH * 60 + neM;

    for (let i = 0; i < window.serviceModules.length; i++) {
        if (i === idx) continue;
        const m = window.serviceModules[i];
        const eHora = m.hora || m.startTime || '00:00';
        const eFin = m.endTime || calcularFinModulo(eHora, m.duration || 60);
        const [esH, esM] = eHora.split(':').map(Number);
        const [eeH, eeM] = eFin.split(':').map(Number);
        const existenteInicio = esH * 60 + esM;
        const existenteFin = eeH * 60 + eeM;

        if (nuevoInicio < existenteFin && nuevoFin > existenteInicio) {
            mostrarMensaje('⚠️ El horario se solapa con otro módulo existente.', 'warning');
            return true;
        }
    }
    return false;
}

function generarModulosAutomaticos() {
    const count = parseInt(document.getElementById('module-count')?.value) || 3;
    const desde = document.getElementById('module-start-gen')?.value || '09:00';
    const DURACION = getServiceDuration();

    // Validar
    if (count < 1) {
        mostrarMensaje("Ingresa al menos 1 modulo", "warning");
        return;
    }

    // Confirmar si va a sobrescribir módulos existentes
    if (window.serviceModules && window.serviceModules.length > 0) {
        if (!confirm(`¿Reemplazar los ${window.serviceModules.length} módulo(s) existente(s) por ${count} nuevo(s)?`)) {
            return;
        }
    }

    // Guardar módulos actuales antes de sobrescribir (asignación por día/fecha)
    if (typeof guardarModulosActuales === 'function') {
        guardarModulosActuales();
    }

    // Limpiar modulos existentes
    window.serviceModules = [];

    const [h, m] = desde.split(':').map(Number);
    let minutosInicio = h * 60 + m;

    for (let i = 0; i < count; i++) {
        const inicio = String(Math.floor(minutosInicio / 60) % 24).padStart(2, '0') + ':' + String(minutosInicio % 60).padStart(2, '0');
        const finMinutos = minutosInicio + DURACION;
        const fin = String(Math.floor(finMinutos / 60) % 24).padStart(2, '0') + ':' + String(finMinutos % 60).padStart(2, '0');
        
        serviceModules.push({
            id: generateModuleId(),
            hora: inicio,
            cupos: 1,
            duration: DURACION,
            editable: true
        });
        
        minutosInicio += DURACION;
    }

    renderModulesEditable();
    saveModulesToHiddenField();
    _unsavedChanges = false;
    mostrarMensaje(`${count} modulo(s) generados`, "success");
}

function renderModulesEditable() {
    const container = document.getElementById('modules-list');
    if (!container) return;

    if (!window.serviceModules || window.serviceModules.length === 0) {
        container.innerHTML = '<div class="empty-modules"><i class="fas fa-clock"></i><p>No hay horarios configurados</p><small>Usa "Generar" para crear los módulos</small></div>';
        document.getElementById('confirm-modules-btn').style.display = 'none';
        return;
    }

    function buildTimeSelects(currentTime, baseClass, idx) {
        const [h, m] = currentTime.split(':').map(Number);
        const minRedondeado = Math.round(m / 5) * 5;
        let horas = '';
        for (let i = 0; i < 24; i++) {
            const val = String(i).padStart(2, '0');
            horas += '<option value="' + val + '"' + (i === h ? ' selected' : '') + '>' + val + '</option>';
        }
        let mins = '';
        for (let i = 0; i < 60; i += 5) {
            const val = String(i).padStart(2, '0');
            mins += '<option value="' + val + '"' + (i === minRedondeado ? ' selected' : '') + '>' + val + '</option>';
        }
        return '<div class="module-time-selects">' +
            '<select class="' + baseClass + '-hora" data-index="' + idx + '">' + horas + '</select>' +
            '<span class="time-select-sep">:</span>' +
            '<select class="' + baseClass + '-min" data-index="' + idx + '">' + mins + '</select>' +
            '</div>';
    }

    let html = '';
    window.serviceModules.forEach((mod, idx) => {
        const fin = calcularFinModulo(mod.hora, mod.duration || 60);
        html += '<div class="module-card">';
        html += '  <div class="module-card-header">';
        html += '    <span class="module-number">#' + (idx + 1) + '</span>';
        html += '    <button type="button" class="btn-icon-danger module-delete-btn" data-index="' + idx + '" title="Eliminar modulo">&times;</button>';
        html += '  </div>';
        html += '  <div class="module-card-body">';
        html += '    <div class="module-time-group">';
        html += '      <label><i class="fas fa-play"></i> Inicio</label>';
        html +=        buildTimeSelects(mod.hora, 'module-time-start', idx);
        html += '    </div>';
        html += '    <div class="module-time-group">';
        html += '      <label><i class="fas fa-stop"></i> Fin</label>';
        html +=        buildTimeSelects(fin, 'module-time-end', idx);
        html += '    </div>';
        html += '    <div class="module-cupos-group">';
        html += '      <label>Cupos</label>';
        html += '      <input type="number" class="module-cupos-input" data-index="' + idx + '" value="' + (mod.cupos || 1) + '" min="0">';
        html += '    </div>';
        html += '  </div>';
        html += '</div>';
    });

    container.innerHTML = html;

    // Mostrar u ocultar botón Confirmar según estado
    const confirmBtn = document.getElementById('confirm-modules-btn');
    if (confirmBtn) {
        const todosConfirmados = window.serviceModules.every(m => m.editable === false);
        confirmBtn.style.display = todosConfirmados ? 'none' : 'inline-block';
    }

    // Eventos para selects de hora
    function getTimeValue(group) {
        const h = group.querySelector('select').value;
        const m = group.querySelectorAll('select')[1].value;
        return h + ':' + m;
    }

    container.querySelectorAll('.module-time-group').forEach(group => {
        const isInicio = group.querySelector('.module-time-start-hora');
        const idx = parseInt((isInicio || group.querySelector('.module-time-end-hora')).dataset.index);

        group.querySelectorAll('select').forEach(sel => {
            sel.addEventListener('change', function() {
                if (!window.serviceModules || !window.serviceModules[idx]) return;

                const startGroup = container.querySelectorAll('.module-time-group')[Array.from(container.querySelectorAll('.module-time-group')).indexOf(group) - (isInicio ? 0 : 1)];
                const endGroup = isInicio
                    ? container.querySelectorAll('.module-time-group')[Array.from(container.querySelectorAll('.module-time-group')).indexOf(group) + 1]
                    : group;

                // Mejor: buscar por data-index en lugar de posición
                const allStartGroups = container.querySelectorAll('.module-time-start-hora');
                const allEndGroups = container.querySelectorAll('.module-time-end-hora');
                let startVal, endVal;

                allStartGroups.forEach(s => {
                    if (parseInt(s.dataset.index) === idx) {
                        const parent = s.closest('.module-time-group');
                        startVal = getTimeValue(parent);
                    }
                });
                allEndGroups.forEach(s => {
                    if (parseInt(s.dataset.index) === idx) {
                        const parent = s.closest('.module-time-group');
                        endVal = getTimeValue(parent);
                    }
                });

                if (isInicio) {
                    const newFin = calcularFinModulo(startVal, window.serviceModules[idx].duration || 60);
                    // Validar solapamiento antes de aplicar
                    if (haySolapamientoEnEditor(idx, startVal, newFin)) return;
                    window.serviceModules[idx].hora = startVal;
                    allEndGroups.forEach(s => {
                        if (parseInt(s.dataset.index) === idx) {
                            const parent = s.closest('.module-time-group');
                            const [nh, nm] = newFin.split(':').map(Number);
                            parent.querySelector('.module-time-end-hora').value = String(nh).padStart(2, '0');
                            parent.querySelector('.module-time-end-min').value = String(nm).padStart(2, '0');
                        }
                    });
                } else {
                    // Validar solapamiento antes de aplicar cambio de fin
                    if (haySolapamientoEnEditor(idx, startVal, endVal)) return;
                    // Calcular duracion
                    const [h1, m1] = startVal.split(':').map(Number);
                    const [h2, m2] = endVal.split(':').map(Number);
                    let diff = (h2 * 60 + m2) - (h1 * 60 + m1);
                    if (diff < 0) diff += 24 * 60;
                    window.serviceModules[idx].duration = diff;
                }
                _unsavedChanges = true;
                saveModulesToHiddenField();
            });
        });
    });

    container.querySelectorAll('.module-cupos-input').forEach(inp => {
        inp.addEventListener('change', function() {
            const idx = parseInt(this.dataset.index);
            if (window.serviceModules && window.serviceModules[idx]) {
                window.serviceModules[idx].cupos = parseInt(this.value) || 0;
                _unsavedChanges = true;
                saveModulesToHiddenField();
            }
        });
    });

    container.querySelectorAll('.module-delete-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const idx = parseInt(this.dataset.index);
            if (window.serviceModules) {
                window.serviceModules.splice(idx, 1);
                _unsavedChanges = true;
                if (window.serviceModules.length === 0) {
                    document.getElementById('confirm-modules-btn').style.display = 'none';
                }
                renderModulesEditable();
                saveModulesToHiddenField();
            }
        });
    });
    
    // ===== Boton Copiar desde en editor =====
    if (_assignmentMode === 'weekday') {
        const dayNames = ['Dom', 'Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab'];
        let opts = '<option value="">Seleccionar origen...</option>';
        opts += '<option value="general">General (todos los dias)</option>';
        for (let d = 0; d < 7; d++) {
            const tiene = _weekdayModules[d] && _weekdayModules[d].length > 0;
            if (tiene || d === _currentEditingWeekday) continue;
            opts += '<option value="' + d + '">' + dayNames[d] + '</option>';
        }
        const div = document.createElement('div');
        div.style.cssText = 'margin-top:12px;display:flex;align-items:center;gap:8px;';
        div.innerHTML = '<label style="font-size:0.8rem;color:var(--text-muted);">Copiar desde:</label>' +
            '<select id="copy-modules-from" style="padding:5px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:0.8rem;">' + opts + '</select>' +
            '<button type="button" class="btn-small" id="btn-copy-modules" style="padding:4px 10px;font-size:0.75rem;" disabled>Aplicar</button>';
        container.appendChild(div);
        
        document.getElementById('copy-modules-from')?.addEventListener('change', function() {
            document.getElementById('btn-copy-modules').disabled = !this.value;
        });
        document.getElementById('btn-copy-modules')?.addEventListener('click', function() {
            const src = document.getElementById('copy-modules-from').value;
            if (!src) return;
            if (copiarModulosDesde(src)) {
                mostrarMensaje('Modulos copiados al editor. Usa Guardar asignacion para fijarlos.', 'success');
                renderModulesEditable();
            }
        });
    } else if (_assignmentMode === 'date') {
        let opts = '<option value="">Seleccionar origen...</option>';
        opts += '<option value="general">General (todos los dias)</option>';
        const dayNames = ['Dom', 'Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab'];
        for (let d = 0; d < 7; d++) {
            const tiene = _weekdayModules[d] && _weekdayModules[d].length > 0;
            if (!tiene) continue;
            opts += '<option value="wd:' + d + '">' + dayNames[d] + '</option>';
        }
        Object.keys(_dateSpecificModules || {}).sort().forEach(f => {
            if (f === _selectedDateForModules) return;
            opts += '<option value="date:' + f + '">' + f + '</option>';
        });
        const div = document.createElement('div');
        div.style.cssText = 'margin-top:12px;display:flex;align-items:center;gap:8px;';
        div.innerHTML = '<label style="font-size:0.8rem;color:var(--text-muted);">Copiar desde:</label>' +
            '<select id="copy-modules-from" style="padding:5px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;font-size:0.8rem;">' + opts + '</select>' +
            '<button type="button" class="btn-small" id="btn-copy-modules" style="padding:4px 10px;font-size:0.75rem;" disabled>Aplicar</button>';
        container.appendChild(div);
        
        document.getElementById('copy-modules-from')?.addEventListener('change', function() {
            document.getElementById('btn-copy-modules').disabled = !this.value;
        });
        document.getElementById('btn-copy-modules')?.addEventListener('click', function() {
            const src = document.getElementById('copy-modules-from').value;
            if (!src) return;
            if (copiarModulosDesde(src)) {
                mostrarMensaje('Modulos copiados al editor. Usa Guardar asignacion para fijarlos.', 'success');
                renderModulesEditable();
            }
        });
    }
}
window.renderModulesEditable = renderModulesEditable;

// ===== Boton Copiar desde (logica) =====
function copiarModulosDesde(origen) {
    let sourceMods = null;
    if (origen === 'general') {
        sourceMods = window.serviceModules;
    } else if (origen.startsWith('wd:')) {
        const d = parseInt(origen.split(':')[1]);
        sourceMods = _weekdayModules[d];
    } else if (origen.startsWith('date:')) {
        const f = origen.split(':')[1];
        sourceMods = _dateSpecificModules[f];
    } else {
        const d = parseInt(origen);
        sourceMods = _weekdayModules[d];
    }
    if (!sourceMods || sourceMods.length === 0) {
        mostrarMensaje('El origen no tiene modulos para copiar.', 'warning');
        return false;
    }
    // Deep clone para romper toda referencia en memoria
    window.serviceModules = structuredClone(sourceMods);
    saveModulesToHiddenField();
    return true;
}
window.copiarModulosDesde = copiarModulosDesde;

function confirmarModulos() {
    if (!window.serviceModules || window.serviceModules.length === 0) {
        mostrarMensaje("No hay modulos para confirmar", "warning");
        return;
    }
    
    // Nivel 3
    if (_assignmentMode === 'all' || !_assignmentMode || _assignmentMode === 'default') {
        const jerarquia = contarFechasEspecificasActivas();
        if (jerarquia.tieneEspecificos) {
            mostrarMensaje(
                '⚠️ Al confirmar en modo global, recuerda que existen ' + jerarquia.fechasEspecificas + ' fechas específicas y ' + jerarquia.diasSemanaEspecificos + ' días personalizados que mantendrán sus propios horarios prioritarios.',
                'warning'
            );
        }
    }
    
    // Guardar módulos actuales según el modo de asignación
    if (typeof guardarAsignacionActual === 'function') {
        guardarAsignacionActual();
    }
    // Marcar como confirmados
    window.serviceModules.forEach(m => m.editable = false);
    renderModulesEditable();
    saveModulesToHiddenField();
    // Refrescar la matriz de cupos
    if (typeof renderModulesList === 'function') renderModulesList();
    // Avisar a ServiceForm para recalcular la cobertura de trabajadores
    window.dispatchEvent(new CustomEvent('servicio-modulos-actualizados'));
    mostrarMensaje("✅ Módulos confirmados y asignación guardada", "success");
}

/**
 * asignarDiaWeekday — carga un día específico en el editor en modo weekday
 */
function asignarDiaWeekday(day) {
    _assignmentMode = 'weekday';
    _currentEditingWeekday = day;
    // Marcar checkbox correspondiente
    refrescarCheckboxesWeekday();
    // Cargar módulos del día o mantener generales como plantilla
    if (_weekdayModules[day] && _weekdayModules[day].length > 0) {
        window.serviceModules = _weekdayModules[day].map(m => ({...m}));
    } else if (!window.serviceModules || window.serviceModules.length === 0) {
        window.serviceModules = [];
    }
    renderModulesEditable();
    actualizarIndicadorWeekday();
    // Hacer scroll al editor de módulos
    document.getElementById('service-modules')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (typeof setAssignmentMode === 'function') {
        document.querySelector('.btn-mode[data-mode="weekday"]')?.click();
    }
    renderModulesList();
}

/**
 * asignarFechaDate — carga una fecha específica en el editor en modo date
 */
function asignarFechaDate(fecha) {
    _assignmentMode = 'date';
    _selectedDateForModules = fecha;
    // Actualizar el selector de fechas
    actualizarSelectorFechas();
    // Seleccionar la fecha en el select
    const sel = document.getElementById('date-selector-select');
    if (sel) sel.value = fecha;
    // Cargar módulos de la fecha
    cargarModulosDeFecha(fecha);
    // Hacer scroll al editor de módulos
    document.getElementById('service-modules')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (typeof setAssignmentMode === 'function') {
        document.querySelector('.btn-mode[data-mode="date"]')?.click();
    }
}

/**
 * obtenerFechasPendientes — devuelve los días/fechas que faltan por asignar
 * Cada elemento: { label: string, onClick: string }
 */
function obtenerFechasPendientes() {
    const result = [];
    const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    
    if (_assignmentMode === 'weekday') {
        const diasEnCalendario = new Set();
        (selectedDates || []).forEach(f => {
            diasEnCalendario.add(new Date(f + 'T12:00:00').getDay());
        });
        dayOrder = [1, 2, 3, 4, 5, 6, 0];
        dayOrder.forEach(d => {
            if (!diasEnCalendario.has(d)) return;
            if (!_weekdayModules[d] || _weekdayModules[d].length === 0) {
                result.push({
                    label: dayNames[d],
                    accion: 'asignarDiaWeekday',
                    valor: d
                });
            }
        });
    } else if (_assignmentMode === 'date') {
        (selectedDates || []).sort().forEach(f => {
            if (!_dateSpecificModules[f] || _dateSpecificModules[f].length === 0) {
                result.push({
                    label: f,
                    accion: 'asignarFechaDate',
                    valor: f
                });
            }
        });
    }
    return result;
}
window.obtenerFechasPendientes = obtenerFechasPendientes;

function renderModulesList() {
    const modulesList = document.getElementById('modules-list');
    if (!modulesList) {
        console.error("❌ 'modules-list' no encontrado en el DOM");
        return;
    }

    const sortedDates = Array.from(selectedDates || []).sort((a, b) => a.localeCompare(b));
    if (sortedDates.length === 0) {
        modulesList.innerHTML = '<div class="empty-modules"><i class="fas fa-clock"></i><p>No hay fechas seleccionadas</p><small>Selecciona fechas en el calendario para ver los horarios</small></div>';
        return;
    }

    // Obtener disponibilidad completa con jerarquía (date > weekday > general)
    const disponibilidad = generarDisponibilidadFinal();

    // Inicializar window.moduleDateCupos para persistencia de cupos editados
    if (!window.moduleDateCupos) window.moduleDateCupos = {};
    sortedDates.forEach(date => {
        if (!window.moduleDateCupos[date]) window.moduleDateCupos[date] = {};
        const mods = disponibilidad[date] || [];
        mods.forEach(m => {
            const key = m.hora || m.startTime;
            if (typeof window.moduleDateCupos[date][key] === 'undefined') {
                window.moduleDateCupos[date][key] = typeof m.cupos !== 'undefined' ? Number(m.cupos) : 0;
            }
        });
    });

    const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const badgeColors = {
        dateSpecific: { bg: 'rgba(157,78,221,0.2)', color: '#c084fc', text: 'Fecha específica', title: 'Ignora configuración de día y general' },
        weekday:     { bg: 'rgba(0,184,148,0.2)', color: '#00b894', text: 'Por día de semana', title: 'Sigue configuración del día, ignora base general' },
        general:     { bg: 'rgba(116,185,255,0.2)', color: '#74b9ff', text: 'General', title: 'Usa configuración base general para todos los días' }
    };

    // Nivel 2 — Barra de estado del sistema (resumen de jerarquía)
    const jerarquia = contarFechasEspecificasActivas();
    const totalFechas = sortedDates.length;

    let html = '<div class="hierarchy-status-bar" style="margin-bottom:12px;padding:8px 12px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid rgba(255,255,255,0.06);font-size:0.8rem;color:var(--text-muted);display:flex;gap:12px;flex-wrap:wrap;align-items:center;">';
    html += '<span>📅 ' + totalFechas + ' fechas</span>';
    if (jerarquia.fechasEspecificas > 0) {
        html += '<span style="color:#c084fc;">🟣 ' + jerarquia.fechasEspecificas + ' con fecha específica</span>';
    }
    if (jerarquia.diasSemanaEspecificos > 0) {
        html += '<span style="color:#00b894;">🟢 ' + jerarquia.diasSemanaEspecificos + ' días de semana con configuración propia</span>';
    }
    const fechasSinDateSpec = totalFechas - jerarquia.fechasEspecificas;
    if (fechasSinDateSpec > 0) {
        html += '<span style="color:#74b9ff;">🔵 ' + fechasSinDateSpec + ' heredan de día/general</span>';
    }
    if (jerarquia.tieneEspecificos && (_assignmentMode === 'all' || !_assignmentMode || _assignmentMode === 'default')) {
        html += '<span style="color:#ffaa00;font-weight:500;">⚠️ Modo general activo — las configuraciones específicas se mantienen</span>';
    }
    html += '</div>';

    html += '<div class="modules-cards-container">';

    sortedDates.forEach((date) => {
        const day = new Date(date + 'T12:00:00').getDay();
        const mods = disponibilidad[date] || [];
        const tieneMods = mods.length > 0;
        const fuente = tieneMods ? (mods[0]._fuente || 'general') : 'ninguna';
        const badge = badgeColors[fuente] || badgeColors.general;

        // Calcular total de cupos para esta fecha
        const totalCuposFecha = tieneMods ? mods.reduce((sum, m) => {
            const key = m.hora || m.startTime;
            const cupo = (window.moduleDateCupos[date] && typeof window.moduleDateCupos[date][key] !== 'undefined')
                ? Number(window.moduleDateCupos[date][key])
                : (typeof m.cupos !== 'undefined' ? Number(m.cupos) : 0);
            return sum + cupo;
        }, 0) : 0;

        html += '<div class="fecha-card" style="background:rgba(255,255,255,0.04);border-radius:10px;padding:12px 14px;margin-bottom:10px;border:1px solid rgba(255,255,255,0.08);">';

        // Header de la card
        html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:6px;">';
        html += '<div>';
        html += '<strong style="font-size:0.95rem;">' + formatFechaCorta(date) + '</strong>';
        html += ' <span style="color:var(--text-muted);font-size:0.8rem;">(' + dayNames[day] + ')</span>';
        if (tieneMods) {
            html += ' <span style="display:inline-block;font-size:0.7rem;padding:1px 7px;border-radius:8px;background:' + badge.bg + ';color:' + badge.color + ';margin-left:6px;cursor:help;" title="' + badge.title + '">' + badge.text + '</span>';
        }
        html += '</div>';
        html += '<div style="display:flex;align-items:center;gap:8px;font-size:0.85rem;color:var(--text-muted);">';
        // Botón cupo masivo para esta fecha
        if (tieneMods) {
            html += '<button type="button" class="btn-small btn-cupo-masivo-fecha" data-fecha="' + date + '" style="font-size:0.7rem;padding:2px 8px;" title="Aplicar cupo a todos los horarios de esta fecha">↓ Cupo masivo</button>';
        }
        html += 'Total: <strong>' + totalCuposFecha + '</strong> cupos';
        html += '</div>';
        html += '</div>';

        if (!tieneMods) {
            // Sin módulos → indicador rojo
            html += '<div style="padding:14px;background:rgba(255,70,70,0.1);border-radius:6px;text-align:center;color:#ff6b6b;font-size:0.85rem;">';
            html += '<i class="fas fa-exclamation-triangle"></i> Sin módulos asignados para esta fecha';
            html += '</div>';
        } else {
            // Listado de módulos como filas compactas
            mods.forEach((m) => {
                const key = m.hora || m.startTime;
                const cupo = (window.moduleDateCupos[date] && typeof window.moduleDateCupos[date][key] !== 'undefined')
                    ? Number(window.moduleDateCupos[date][key])
                    : (typeof m.cupos !== 'undefined' ? Number(m.cupos) : 0);
                const zeroClass = cupo <= 0 ? 'opacity:0.5;' : '';

                html += '<div class="modulo-row" style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:rgba(255,255,255,0.03);border-radius:6px;margin-bottom:4px;' + zeroClass + '">';

                // Hora inicio - fin
                html += '<span style="font-size:0.85rem;font-weight:500;min-width:100px;">';
                html += m.hora || m.startTime || '--:--';
                if (m.endTime) html += ' - ' + m.endTime;
                html += '</span>';

                // Duración
                if (m.duration) {
                    html += '<span style="font-size:0.75rem;color:var(--text-muted);min-width:50px;">' + m.duration + 'min</span>';
                }

                // Cupo input
                html += '<div class="cupo-input-group" style="display:flex;align-items:center;gap:4px;margin-left:auto;">';
                html += '<label style="font-size:0.75rem;color:var(--text-muted);">Cupos:</label>';
                html += '<input type="number" class="module-cupos-input" data-date="' + date + '" data-hora="' + key + '" value="' + cupo + '" min="0" style="width:55px;padding:3px 6px;border-radius:4px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;text-align:center;">';
                html += '<button type="button" class="btn-disable-cupo" data-fecha="' + date + '" data-hora="' + key + '" style="background:none;border:none;color:#ff6b6b;cursor:pointer;font-size:1rem;padding:2px 4px;line-height:1;" title="Deshabilitar (cupo=0)">×</button>';
                html += '</div>';

                html += '</div>'; // fin modulo-row
            });
        }

        html += '</div>'; // fin fecha-card
    });

    html += '</div>'; // fin modules-cards-container

    // Sección de fechas/días pendientes (solo en modo weekday/date)
    if (_assignmentMode === 'weekday' || _assignmentMode === 'date') {
        const pendientes = obtenerFechasPendientes();
        if (pendientes.length > 0) {
            html += '<div class="pendientes-section" style="margin-top:14px;padding:12px;background:rgba(255,70,70,0.08);border-radius:8px;border:1px solid rgba(255,70,70,0.2);">';
            html += '<div style="margin-bottom:8px;font-size:0.85rem;color:#ff6b6b;font-weight:600;"><i class="fas fa-exclamation-triangle"></i> ' + pendientes.length + ' elemento(s) sin módulos asignados:</div>';
            html += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
            pendientes.forEach(item => {
                html += '<button type="button" class="btn-small btn-pendiente-asignar" data-accion="' + item.accion + '" data-valor="' + item.valor + '" style="background:rgba(255,70,70,0.2);color:#ff6b6b;border:1px solid rgba(255,70,70,0.3);padding:4px 12px;cursor:pointer;">➕ ' + item.label + '</button>';
            });
            html += '</div></div>';
        }
    }

    modulesList.innerHTML = html;

    // ============================================================
    // CSP FIX (2026-08-27): los onclick/onchange inline generados por JS
    // quedan BLOQUEADOS por el CSP hash-based (script-src-attr) porque
    // llevan valores interpolados (fecha/hora) que no se pueden listar
    // como hashes. Se bindean con addEventListener tras el render.
    // ============================================================
    modulesList.querySelectorAll('.btn-cupo-masivo-fecha').forEach(btn => {
        btn.addEventListener('click', () => aplicarCupoAHorarios(btn.dataset.fecha));
    });
    modulesList.querySelectorAll('.module-cupos-input').forEach(inp => {
        inp.addEventListener('change', () => actualizarCupo(inp));
    });
    modulesList.querySelectorAll('.btn-disable-cupo').forEach(btn => {
        btn.addEventListener('click', () => deshabilitarCupo(btn.dataset.fecha, btn.dataset.hora));
    });
    modulesList.querySelectorAll('.btn-pendiente-asignar').forEach(btn => {
        btn.addEventListener('click', () => {
            const accion = btn.dataset.accion;
            const valor = btn.dataset.valor;
            if (accion === 'asignarDiaWeekday') asignarDiaWeekday(Number(valor));
            else if (accion === 'asignarFechaDate') asignarFechaDate(valor);
        });
    });
}
window.renderModulesList = renderModulesList;

// Actualizar cupo individual desde input
function actualizarCupo(input) {
    const fecha = input.dataset.date;
    const hora = input.dataset.hora;
    const val = parseInt(input.value);
    if (isNaN(val) || val < 0) {
        input.value = 0;
    }
    if (!window.moduleDateCupos) window.moduleDateCupos = {};
    if (!window.moduleDateCupos[fecha]) window.moduleDateCupos[fecha] = {};
    window.moduleDateCupos[fecha][hora] = Number(input.value || 0);
}
window.actualizarCupo = actualizarCupo;

// ============================================
// Mejora #3 – Cupo masivo por fecha
// ============================================
function aplicarCupoAHorarios(fecha) {
    const cupoStr = prompt('Ingresa el cupo deseado para todos los horarios en ' + fecha + ':');
    if (cupoStr === null) return;
    const cupo = parseInt(cupoStr);
    if (isNaN(cupo) || cupo < 0) { mostrarMensaje('Ingresa un número válido', 'warning'); return; }
    if (!window.moduleDateCupos) window.moduleDateCupos = {};
    if (!window.moduleDateCupos[fecha]) window.moduleDateCupos[fecha] = {};
    serviceModules.forEach(mod => {
        window.moduleDateCupos[fecha][mod.hora] = cupo;
    });
    renderModulesList();
    mostrarMensaje(`Cupo ${cupo} aplicado a todos los horarios en ${fecha}`, 'success');
}
window.aplicarCupoAHorarios = aplicarCupoAHorarios;

// ============================================
// Mejora #10 – Deshabilitar un horario en una fecha específica
// ============================================
function deshabilitarCupo(fecha, hora) {
    if (!window.moduleDateCupos) window.moduleDateCupos = {};
    if (!window.moduleDateCupos[fecha]) window.moduleDateCupos[fecha] = {};
    window.moduleDateCupos[fecha][hora] = 0;
    renderModulesList();
    mostrarMensaje(`Horario ${hora} deshabilitado en ${fecha} (cupo=0)`, 'info');
}
window.deshabilitarCupo = deshabilitarCupo;

// ============================================
// Mejora #4 – Generar fechas por rango
// ============================================
function generarFechasPorRango() {
    const fechaInicio = document.getElementById('range-start')?.value;
    const fechaFin = document.getElementById('range-end')?.value;
    if (!fechaInicio || !fechaFin) {
        mostrarMensaje('Selecciona fecha inicio y fecha fin para el rango', 'warning');
        return;
    }
    if (fechaFin < fechaInicio) {
        mostrarMensaje('La fecha fin debe ser posterior a la fecha inicio', 'error');
        return;
    }
    const diasSeleccionados = [];
    document.querySelectorAll('.dia-semana-checkbox:checked').forEach(cb => {
        diasSeleccionados.push(parseInt(cb.value));
    });
    if (diasSeleccionados.length === 0) {
        mostrarMensaje('Selecciona al menos un día de la semana', 'warning');
        return;
    }
    const start = new Date(fechaInicio + 'T00:00:00');
    const end = new Date(fechaFin + 'T00:00:00');
    let count = 0;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        if (diasSeleccionados.includes(d.getDay())) {
            const fechaStr = d.toISOString().split('T')[0];
            if (!selectedDates.has(fechaStr)) {
                selectedDates.add(fechaStr);
                count++;
            }
        }
    }
    renderCalendar();
    if (serviceModules.length > 0) {
        // Propagar cupos actuales a las nuevas fechas
        const fechasNuevas = Array.from(selectedDates).sort();
        serviceModules.forEach(mod => {
            fechasNuevas.forEach(f => {
                window.moduleDateCupos[f] = window.moduleDateCupos[f] || {};
                if (typeof window.moduleDateCupos[f][mod.hora] === 'undefined') {
                    window.moduleDateCupos[f][mod.hora] = Number(mod.cupos || 0);
                }
            });
        });
    }
    renderModulesList();
    // Actualizar selector de fechas si está en modo date
    if (_assignmentMode === 'date' && typeof actualizarSelectorFechas === 'function') {
        actualizarSelectorFechas();
    }
    mostrarMensaje(`${count} fecha(s) agregada(s)`, 'success');
}
window.generarFechasPorRango = generarFechasPorRango;

// ============================================
// Mejora #7 – Duplicar servicio
// ============================================
async function duplicarServicio(id) {
    const servicios = await ServiciosManager.getAll();
    const original = servicios.find(s => String(s.id) === String(id));
    if (!original) { mostrarMensaje('Servicio no encontrado', 'error'); return; }
    // Cargar formulario con los datos del original pero sin ID (creación)
    document.getElementById('srv-name').value = original.nombre + ' (copia)';
    // categoría: 'general' (asignado por defecto al guardar)
    document.getElementById('srv-price').value = original.precio || '';
    document.getElementById('srv-image-url').value = original.imagen || '';
    // Resetear file input al duplicar
    const fileInputDup = document.getElementById('srv-image-file');
    if (fileInputDup) fileInputDup.value = '';
    const fileNameDisplayDup = document.getElementById('file-name-display');
    if (fileNameDisplayDup) fileNameDisplayDup.textContent = 'Elegir imagen';
    const progressBarDup = document.getElementById('image-upload-progress');
    if (progressBarDup) progressBarDup.style.display = 'none';
    document.getElementById('srv-desc').value = original.descripcion || '';
    document.getElementById('srv-featured').checked = !!original.destacado;
    document.getElementById('srv-active').checked = !!original.activo;
    // Restaurar fechas
    if (original.fechas && original.fechas.length > 0) {
        selectedDates = new Set(original.fechas);
    } else if (original.disponibilidad && Object.keys(original.disponibilidad).length > 0) {
        selectedDates = new Set(Object.keys(original.disponibilidad));
    }
    renderCalendar();
    // Restaurar módulos y cupos
    clearAllModules();
    if (original.disponibilidad && Object.keys(original.disponibilidad).length > 0) {
        const horaMap = {};
        Object.keys(original.disponibilidad).forEach(f => {
            (original.disponibilidad[f] || []).forEach(mod => {
                const h = mod.hora || mod.startTime || '00:00';
                if (!horaMap[h]) {
                    horaMap[h] = { id: generateModuleId(), hora: h, cupos: Number(mod.cupos || 0), duration: mod.duration || 0 };
                }
            });
        });
        Object.values(horaMap).forEach(h => window.serviceModules.push(h));
        window.moduleDateCupos = {};
        Object.keys(original.disponibilidad).forEach(fecha => {
            window.moduleDateCupos[fecha] = {};
            (original.disponibilidad[fecha] || []).forEach(mod => {
                window.moduleDateCupos[fecha][mod.hora || mod.startTime || '00:00'] = Number(mod.cupos || 0);
            });
        });
    }
    renderModulesList();
    saveModulesToHiddenField();
    _unsavedChanges = false;
    // Ir al formulario: navegar a la sección crear-servicio (el id real es
    // #section-crear-servicio; #service-creator no existe en admin.html)
    if (typeof navigateTo === 'function') {
        navigateTo('crear-servicio');
    }
    setTimeout(() => {
        const formEl = document.getElementById('service-form');
        if (formEl) formEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
    mostrarMensaje('Servicio duplicado — revisa y guarda', 'info');
}
window.duplicarServicio = duplicarServicio;

// ============================================
// Mejora #8 – Vista previa del servicio
// ============================================
function mostrarVistaPrevia() {
    const nombre = document.getElementById('srv-name')?.value || 'Nombre del servicio';
    const precio = document.getElementById('srv-price')?.value || '0';
    const descripcion = document.getElementById('srv-desc')?.value || '';
    const imagen = document.getElementById('srv-image-url')?.value || null;
    const activo = document.getElementById('srv-active')?.checked;

    const fechas = Array.from(selectedDates).sort();
    const horarios = serviceModules.map(m => formatTimeDisplay(m.hora)).join(', ');

    const modal = document.createElement('div');
    modal.className = 'preview-modal-overlay';
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:99999;';
    modal.innerHTML = `
        <div class="preview-modal" style="background:#1a1a2e;border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:30px;max-width:420px;width:90%;color:#fff;position:relative;">
            <button type="button" class="preview-modal-close" style="position:absolute;top:12px;right:16px;background:none;border:none;color:#888;font-size:24px;cursor:pointer;">×</button>
            <div class="service-card-preview" style="text-align:center;">
                <img src="${escapeHtml(imagen)}" alt="${escapeHtml(nombre)}" style="width:100%;height:200px;object-fit:cover;border-radius:12px;margin-bottom:16px;" onerror="this.style.display='none'">
                <h3 style="color:#fff;font-size:1.3rem;margin-bottom:8px;">${escapeHtml(nombre)}</h3>
                <div style="font-size:1.5rem;font-weight:bold;color:#9d4edd;margin-bottom:8px;">$ ${parseFloat(precio).toLocaleString('es-CL')}</div>
                ${descripcion ? `<p style="color:#aaa;font-size:0.9rem;margin-bottom:12px;">${escapeHtml(descripcion)}</p>` : ''}
                <div style="margin-top:12px;padding:12px;background:rgba(255,255,255,0.04);border-radius:8px;">
                    <div style="color:#888;font-size:0.8rem;margin-bottom:4px;">${fechas.length} fecha(s) · ${serviceModules.length} horario(s)</div>
                    <div style="color:#9d4edd;font-size:0.85rem;">${fechas.slice(0,3).join(', ')}${fechas.length > 3 ? '...' : ''}</div>
                    <div style="color:#aaa;font-size:0.85rem;">${horarios}</div>
                </div>
                <div style="margin-top:16px;padding:8px 0;border-top:1px solid rgba(255,255,255,0.06);color:#666;font-size:0.8rem;">
                    ${activo ? '✅ Servicio activo' : '⛔ Servicio inactivo'}
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    // CSP: los onclick inline quedan bloqueados (nonce/hash anulan 'unsafe-inline').
    // Se bindean con addEventListener tras el render (patrón del repo, ver DOCUMENTACION-CARDS-SERVICIOS.md).
    const btnCerrarPreview = modal.querySelector('.preview-modal-close');
    if (btnCerrarPreview) {
        btnCerrarPreview.addEventListener('click', function () {
            modal.remove();
        });
    }
    // Cerrar también al hacer clic fuera del modal (backdrop)
    modal.addEventListener('click', function (e) {
        if (e.target === modal) modal.remove();
    });
}
window.mostrarVistaPrevia = mostrarVistaPrevia;

// ============================================
// Mejora #5 – getServiceDuration mejorada (lee servicio.duracion si existe)
// ============================================
function getServiceDuration() {
    const durInput = document.getElementById('srv-duration');
    if (durInput && durInput.value) {
        const parsed = parseInt(durInput.value, 10);
        if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    // Fallback: duración del primer módulo o 60
    if (window.serviceModules && window.serviceModules.length > 0) {
        const modDur = parseInt(window.serviceModules[0].duration, 10);
        if (!isNaN(modDur) && modDur > 0) return modDur;
    }
    return 60;
}
window.getServiceDuration = getServiceDuration;

// ============================================
// Mejora #9 – Confirmación al cancelar edición
// ============================================
function cancelarEdicion() {
    // Verificar si hay datos en el formulario
    const nombre = document.getElementById('srv-name')?.value;
    const precio = document.getElementById('srv-price')?.value;
    if (nombre || precio || selectedDates.size > 0 || serviceModules.length > 0) {
        if (!confirm('¿Descartar cambios? Los datos ingresados se perderán.')) return;
    }
    limpiarEstadoEdicion();
    if (typeof navigateTo === 'function') {
        navigateTo('mis-servicios');
    }
    mostrarMensaje('Edición cancelada', 'info');
}
window.cancelarEdicion = cancelarEdicion;

function removeModule(moduleId) {
    // Guardar módulos actuales primero (asignación por día/fecha)
    if (typeof guardarModulosActuales === 'function') {
        guardarModulosActuales();
    }
    
    const modToRemove = window.serviceModules.find(m => String(m.id) === String(moduleId));
    const horaRemovida = modToRemove ? modToRemove.hora : null;

    window.serviceModules = window.serviceModules.filter(m => String(m.id) !== String(moduleId));

    if (horaRemovida) {
        Object.keys(window.moduleDateCupos).forEach(fecha => {
            if (window.moduleDateCupos[fecha] && Object.prototype.hasOwnProperty.call(window.moduleDateCupos[fecha], horaRemovida)) {
                delete window.moduleDateCupos[fecha][horaRemovida];
            }
            if (window.moduleDateCupos[fecha] && Object.keys(window.moduleDateCupos[fecha]).length === 0) {
                delete window.moduleDateCupos[fecha];
            }
        });
    }

    renderModulesList();
    saveModulesToHiddenField();
    updateDurationDisplay();
    mostrarMensaje("Horario eliminado", "info");
}
window.removeModule = removeModule;

function loadModulesFromHiddenField() {
    const hiddenField = document.getElementById('service-modules');
    if (hiddenField && hiddenField.value) {
        try {
            const raw = JSON.parse(hiddenField.value);
            
            // Nuevo formato: { mode, general, weekday, dateSpecific }
            if (raw && raw.mode) {
                _assignmentMode = raw.mode || 'all';
                _weekdayModules = raw.weekday || {};
                _dateSpecificModules = raw.dateSpecific || {};
                const generalMods = raw.general || [];
                window.serviceModules = generalMods.map(m => ({
                    id: m.id || generateModuleId(),
                    hora: m.hora || m.startTime,
                    startTime: m.startTime || m.hora,
                    endTime: m.endTime,
                    cupos: (typeof m.cupos !== 'undefined') ? Number(m.cupos) : 0,
                    duration: m.duration || 60,
                    editable: m.editable !== false
                }));
                // Sincronizar el selector de modo en el HTML
                if (typeof setAssignmentMode === 'function') {
                    setAssignmentMode(_assignmentMode);
                }
            } else {
                // Formato antiguo (array simple)
                _assignmentMode = 'all';
                _weekdayModules = {};
                _dateSpecificModules = {};
                window.serviceModules = (raw || []).map(m => {
                    if (m.hora || m.cupos) {
                        return {
                            id: m.id || generateModuleId(),
                            hora: m.hora || m.startTime,
                            cupos: (typeof m.cupos !== 'undefined') ? Number(m.cupos) : (typeof m.capacidad !== 'undefined' ? Number(m.capacidad) : 0),
                            duration: m.duration || 0
                        };
                    }
                    return {
                        id: m.id || generateModuleId(),
                        hora: m.startTime || m.hora || '00:00',
                        cupos: (typeof m.capacidad !== 'undefined') ? Number(m.capacidad) : 0,
                        duration: m.duration || 0
                    };
                });
            }
            renderModulesList();
        } catch (e) {
            console.error("Error cargando módulos:", e);
            window.serviceModules = [];
        }
    }
}
window.loadModulesFromHiddenField = loadModulesFromHiddenField;

function clearAllModules() {
    window.serviceModules = [];
    _weekdayModules = {};
    _dateSpecificModules = {};
    _assignmentMode = 'all';
    _selectedDateForModules = null;
    // Resetear UI del selector de modo
    const modeBtns = document.querySelectorAll('.assignment-mode-selector .mode-btn');
    if (modeBtns.length > 0) {
        setAssignmentMode('all');
    }
    renderModulesList();
    saveModulesToHiddenField();
    updateDurationDisplay();
}
window.clearAllModules = clearAllModules;


// ============================================
// RENDERIZADO DE CITAS (modificado para async)
// ============================================

async function _renderCitasBase(contenedorId, opciones = {}) {
    const container = document.getElementById(contenedorId);
    if (!container) return;

    const { soloUsuario = false, mostrarWhatsApp = false, mostrarFinalizar = false, mostrarCancelar = false, mostrarEditado = false, mostrarNoAsistio = false } = opciones;
    const session = await getSession();
    const todas = await CitasManager.getAll();

    let citas = todas;
    if (soloUsuario) {
        // PRIORIDAD 1: Sesión local (cliente del link compartido) — filtrar por email
        if (window.__clienteSession && window.__clienteSession.email) {
            const emailCliente = window.__clienteSession.email.toLowerCase().trim();
            citas = todas.filter(c => {
                const cEmail = (c.contacto?.email || '').toLowerCase().trim();
                return cEmail === emailCliente;
            });
        // PRIORIDAD 2: Sesión Supabase Auth
        } else if (session) {
            citas = todas.filter(c => {
                if (session.id && c.contacto?.userId) {
                    return String(c.contacto.userId) === String(session.id);
                }
                if (session.nombre && c.contacto?.nombre) {
                    return String(c.contacto.nombre).trim().toLowerCase() === String(session.nombre).trim().toLowerCase();
                }
                return false;
            });
        } else {
            // Sin sesión: no mostrar nada
            citas = [];
        }
    }

    // Mapa servicio_id -> nombre real (la cita solo guarda servicio_id)
    let mapaServicios = {};
    if (citas.length > 0) {
        try {
            const servicios = await ServiciosManager.getAll();
            (servicios || []).forEach(s => { if (s && s.id) mapaServicios[s.id] = s.nombre; });
        } catch (e) {
            console.warn('No se pudieron cargar nombres de servicios', e);
        }
    }

    if (citas.length === 0) {
        container.innerHTML = '<div class="empty-state"><i class="fas fa-calendar-times"></i><p>No hay citas programadas</p></div>';
        return;
    }

    let html = '<table class="appointments-table"><thead><tr>';
    html += '<th>Cliente</th><th>Teléfono</th><th>Servicio</th><th>Fecha</th><th>Hora</th><th>Acción</th>';
    html += '</tr></thead><tbody>';

    citas.forEach(c => {
        const nombre = c.contacto?.nombre || c.nombreCliente || '—';
        const telefono = c.contacto?.telefono || c.telefonoCliente || '—';
        const servicio = mapaServicios[c.servicioId] || c.servicioNombre || c.nombre || '—';
        let fechaDisplay = c.fecha || '—';
        try {
            const parsed = parseDate(c.fecha);
            if (parsed && !isNaN(parsed.getTime())) {
                fechaDisplay = parsed.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'short' });
                fechaDisplay = fechaDisplay.charAt(0).toUpperCase() + fechaDisplay.slice(1);
            }
        } catch (e) { }
        const hora = c.hora || '—';
        const editado = (c.editado) ? ' <span style="color:#ff9800;">(Editado)</span>' : '';
        
        const estadoUrgencia = UrgenciaManager.calcularEstado(c.fecha, c.hora);
        const urgenciaClass = (estadoUrgencia === 'urgent-soon' || estadoUrgencia === 'urgent-now') ? estadoUrgencia : '';
        
        const esAdmin = opciones.mostrarEditado || opciones.mostrarFinalizar;
        if (estadoUrgencia === 'expirado' && !esAdmin) {
            return;
        }
        
        html += `<tr data-id="${c.id}" class="${urgenciaClass}" data-urgencia="${estadoUrgencia}">`;
        html += `<td>${escapeHtml(nombre)}</td>`;
        html += `<td>${escapeHtml(telefono)}</td>`;
        html += `<td>${escapeHtml(servicio)}${editado}</td>`;
        html += `<td>${escapeHtml(fechaDisplay)}</td>`;
        html += `<td>${escapeHtml(hora)}</td>`;
        html += `<td class="action-buttons">`;

        if (mostrarWhatsApp && telefono !== '—') {
            html += `<button class="btn-small btn-whatsapp" data-phone="${escapeHtml(telefono)}" data-nombre="${escapeHtml(nombre)}" data-servicio="${escapeHtml(servicio)}" data-fecha="${escapeHtml(fechaDisplay)}" title="Contactar por WhatsApp"><i class="fab fa-whatsapp"></i></button> `;
        }
        
        if (mostrarEditado) {
            html += `<button class="btn-small btn-edit-admin" data-id="${c.id}" title="Editar fecha/hora de la cita"><i class="fas fa-pen"></i></button> `;
        }
        
        if (mostrarFinalizar) {
            html += `<button class="btn-small btn-complete" data-id="${c.id}" title="Marcar como completada (Asistió)"><i class="fas fa-check"></i></button> `;
        }
        
        if (mostrarNoAsistio) {
            html += `<button class="btn-small btn-no-asistio" data-id="${c.id}" title="Marcar como No Asistió"><i class="fas fa-times"></i></button> `;
        }
        
        if (mostrarCancelar) {
            html += `<button class="btn-small btn-cancel-res" data-id="${c.id}" title="Cancelar cita"><i class="fas fa-times"></i></button>`;
        }
        
        html += `</td></tr>`;
    });

    html += '</tbody></table>';
    container.innerHTML = html;

    container.querySelectorAll('.btn-whatsapp').forEach(btn => {
        btn.addEventListener('click', function () {
            const phone = this.dataset.phone.replace(/[^\d+]/g, '');
            if (!phone) return;
            const msg = `Hola ${this.dataset.nombre}, te contacto por tu cita de ${this.dataset.servicio} el ${this.dataset.fecha}`;
            window.open(`https://api.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(msg)}`);
        });
    });

    container.querySelectorAll('.btn-edit-admin').forEach(btn => {
        btn.addEventListener('click', function() {
            const id = this.dataset.id;
            abrirModalEdicionCitaAdmin(id);
        });
    });

    container.querySelectorAll('.btn-complete').forEach(btn => {
        btn.addEventListener('click', function () {
            const id = this.dataset.id;
            finalizarCita(id);
        });
    });
    
    container.querySelectorAll('.btn-no-asistio').forEach(btn => {
        btn.addEventListener('click', function () {
            const id = this.dataset.id;
            noAsistioCita(id);
        });
    });

    container.querySelectorAll('.btn-cancel-res').forEach(btn => {
        btn.addEventListener('click', function () {
            if (!confirm('¿Cancelar esta cita?')) return;
            cancelarCita(this.dataset.id);
        });
    });
}

// ============================================
// MODAL EDICIÓN CITA ADMIN
// ============================================
async function abrirModalEdicionCitaAdmin(citaId) {
    const citas = await CitasManager.getAll();
    const cita = citas.find(c => String(c.id) === String(citaId));
    
    if (!cita) {
        mostrarToast('Cita no encontrada', 'error');
        return;
    }

    const servicios = await ServiciosManager.getAll();
    const servicio = servicios.find(s => String(s.id) === String(cita.servicioId));
    
    if (!servicio) {
        mostrarToast('Servicio no encontrado', 'error');
        return;
    }

    if (!servicio.disponibilidad || Object.keys(servicio.disponibilidad).length === 0) {
        mostrarToast('El servicio no tiene horarios disponibles', 'warning');
        return;
    }

    let hayDisponibilidad = false;
    Object.keys(servicio.disponibilidad).forEach(fecha => {
        const modulos = servicio.disponibilidad[fecha] || [];
        if (modulos.some(m => Number(m.cupos || 0) > 0)) {
            hayDisponibilidad = true;
        }
    });

    if (!hayDisponibilidad) {
        mostrarToast('No hay horarios disponibles para reprogramar', 'warning');
        return;
    }

    window._modoEdicionAdmin = true;
    window._citaEnEdicionAdmin = cita;
    
    abrirModalCambioFecha(citaId, cita.servicioId, cita);
}
window.abrirModalEdicionCitaAdmin = abrirModalEdicionCitaAdmin;

// ============================================
// RENDER ADMIN APPOINTMENTS - Versión cards con botones
// ============================================
// Estados de pago sincronizados desde la tarjeta de "Información
// del cliente" (kanban_cards.etiquetas -> citas.estado_pago).
const ESTADOS_PAGO = {
    pagado:    { nombre: 'Pagado',        color: '#2ecc71' },
    abonado:   { nombre: 'Abonado',       color: '#3498db' },
    parcial:   { nombre: 'Se pagó algo',  color: '#f1c40f' },
    no_pagado: { nombre: 'No pagado',     color: '#e74c3c' }
};

async function renderAdminAppointments() {
    const container = document.getElementById('upcoming-appointments');
    if (!container) return;

    // Citas y servicios son lecturas independientes → en paralelo (antes:
    // secuenciales). Si las citas fallan, se propaga el error igual que antes.
    const [rTodas, rServicios] = await Promise.allSettled([
        CitasManager.getAll(),
        ServiciosManager.getAll()
    ]);
    if (rTodas.status === 'rejected') throw rTodas.reason;
    const todas = rTodas.value || [];
    if (!todas || todas.length === 0) {
        container.innerHTML = '<div class="empty-state" style="padding:40px;text-align:center;color:#aaa;"><i class="fas fa-calendar-times" style="font-size:48px;display:block;margin-bottom:15px;"></i><p>No hay citas programadas</p></div>';
        configurarBotonLimpiarCitas();
        return;
    }

    // Mapa servicio_id -> nombre real (la cita solo guarda servicio_id; el
    // campo c.nombre es el placeholder 'Servicio' del mapeo legacy).
    let mapaServicios = {};
    try {
        const servicios = rServicios.status === 'fulfilled' ? (rServicios.value || []) : [];
        servicios.forEach(s => { if (s && s.id) mapaServicios[s.id] = s.nombre; });
    } catch (e) {
        console.warn('No se pudieron cargar nombres de servicios', e);
    }

    // Ordenar por fecha más próxima (fecha + hora ascendente) — el orden
    // original era created_at DESC ("más recientes primero"), que no
    // coincidía con el hint de la sección.
    const ordenadas = [...todas].sort((a, b) => {
        const fa = (a.fecha || '') + 'T' + (a.hora || '00:00');
        const fb = (b.fecha || '') + 'T' + (b.hora || '00:00');
        return fa.localeCompare(fb);
    });

    let html = '<div class="appointments-list">';
    ordenadas.slice(0, 50).forEach(c => {
        const nombre = c.contacto?.nombre || c.nombreCliente || '—';
        const telefono = c.contacto?.telefono || c.telefonoCliente || '';
        const direccionCliente = c.contacto?.direccion || '';
        const servicio = mapaServicios[c.servicioId] || c.servicioNombre || c.nombre || '—';
        const fechaDisplay = c.fecha ? (() => {
            try {
                const parsed = new Date(c.fecha + (c.fecha.includes('T') ? '' : 'T12:00:00'));
                return parsed.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'short' });
            } catch(e) { return c.fecha; }
        })() : '—';
        const hora = c.hora || '—';
        const precio = c.precio ? `$${Number(c.precio).toLocaleString('es-ES')}` : '';
        const esHoy = c.fecha && new Date(c.fecha.split('T')[0]) <= new Date() && new Date(c.fecha.split('T')[0]) >= new Date(new Date().toDateString());
        const estadoUrgencia = typeof UrgenciaManager?.calcularEstado === 'function' ? UrgenciaManager.calcularEstado(c.fecha, c.hora) : 'normal';
        const estadoPago = ESTADOS_PAGO[c.estado_pago] || null;

        html += `
            <div class="appointment-card ${esHoy ? 'today-card' : ''} ${estadoUrgencia === 'urgent-now' ? 'urgent-now' : ''} ${estadoUrgencia === 'urgent-soon' ? 'urgent-soon' : ''}" data-id="${c.id}">
                <div class="apt-header">
                    <strong>${escapeHtml(nombre)}</strong>
                    <span class="apt-price">${precio}</span>
                </div>
                <div class="apt-details">
                    <span><i class="fas fa-calendar"></i> ${fechaDisplay.charAt(0).toUpperCase() + fechaDisplay.slice(1)}</span>
                    <span><i class="fas fa-clock"></i> ${hora}</span>
                    <span><i class="fas fa-tag"></i> ${escapeHtml(servicio)}</span>
                </div>
                ${direccionCliente ? `<a class="apt-direccion" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(direccionCliente)}" target="_blank" rel="noopener noreferrer" title="Ver dirección en Google Maps / Cómo llegar"><i class="fas fa-map-marker-alt"></i> ${escapeHtml(direccionCliente)}</a>` : ''}
                ${estadoPago ? `<div class="apt-estado-pago" title="Estado de pago"><span class="apt-estado-dot" style="background:${estadoPago.color}"></span> ${estadoPago.nombre}</div>` : ''}
                <div class="apt-actions">
                    ${telefono ? `<button class="btn-small btn-whatsapp" data-phone="${escapeHtml(telefono)}" data-nombre="${escapeHtml(nombre)}" data-servicio="${escapeHtml(servicio)}" data-fecha="${escapeHtml(fechaDisplay)}" title="Contactar por WhatsApp"><i class="fab fa-whatsapp"></i></button>` : ''}
                    <button class="btn-small btn-edit-admin" data-id="${c.id}" title="Editar fecha/hora"><i class="fas fa-pen"></i></button>
                    <button class="btn-small btn-complete" data-id="${c.id}" title="Marcar como completada (Asistió)"><i class="fas fa-check"></i></button>
                    <button class="btn-small btn-no-asistio" data-id="${c.id}" title="Marcar como No Asistió"><i class="fas fa-times"></i></button>
                </div>
            </div>
        `;
    });
    html += '</div>';
    container.innerHTML = html;
    configurarBotonLimpiarCitas();

    // Event listeners
    container.querySelectorAll('.btn-whatsapp').forEach(btn => {
        btn.addEventListener('click', function() {
            const phone = this.dataset.phone.replace(/[^\d+]/g, '');
            if (!phone) return;
            const msg = `Hola ${this.dataset.nombre}, te contacto por tu cita de ${this.dataset.servicio} el ${this.dataset.fecha}`;
            window.open(`https://api.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(msg)}`);
        });
    });

    container.querySelectorAll('.btn-edit-admin').forEach(btn => {
        btn.addEventListener('click', function() {
            const id = this.dataset.id;
            if (typeof abrirModalEdicionCitaAdmin === 'function') abrirModalEdicionCitaAdmin(id);
            else mostrarToast('Edición no disponible', 'warning');
        });
    });

    container.querySelectorAll('.btn-complete').forEach(btn => {
        btn.addEventListener('click', function() {
            const id = this.dataset.id;
            if (typeof finalizarCita === 'function') finalizarCita(id);
            else mostrarToast('Acción no disponible', 'warning');
        });
    });

    container.querySelectorAll('.btn-no-asistio').forEach(btn => {
        btn.addEventListener('click', function() {
            const id = this.dataset.id;
            if (typeof noAsistioCita === 'function') noAsistioCita(id);
            else mostrarToast('Acción no disponible', 'warning');
        });
    });
}
window.renderAdminAppointments = renderAdminAppointments;

async function renderMisReservas() {
    _renderCitasBase('mis-reservas-list', { soloUsuario: true, mostrarCancelar: true });
}
window.renderMisReservas = renderMisReservas;

/**
 * Renderiza enlaces de redes sociales del negocio
 * Lee desde la configuracion visual cargada (window.__lastVisualConfig)
 * o carga la configuracion si es necesario
 */
async function renderSocialLinks(containerId) {
    const container = document.getElementById(containerId || 'social-links-banner');
    if (!container) return;

    let config;
    try {
        const tenantId = await getCurrentTenantId();
        if (!tenantId) { container.style.display = 'none'; return; }
        const cached = localStorage.getItem(`tenant_config_${tenantId}`);
        if (cached) {
            config = JSON.parse(cached);
        } else {
            config = await VisualConfigManager.loadConfig();
        }
    } catch (e) {
        console.warn('[socialLinks] Error cargando config:', e);
        container.style.display = 'none';
        return;
    }

    const instagram = config.instagram_url || '';
    const tiktok = config.tiktok_url || '';

    if (!instagram && !tiktok) {
        container.style.display = 'none';
        return;
    }

    let html = '<div class="social-banner-inner">';
    html += '<span class="social-banner-label"><i class="fas fa-share-alt"></i> Síguenos</span>';
    html += '<div class="social-banner-links">';
    if (instagram) {
        html += `<a href="${escapeHtml(instagram)}" target="_blank" rel="noopener noreferrer" class="social-btn instagram-btn" title="Instagram">
            <i class="fab fa-instagram"></i> <span>Instagram</span>
        </a>`;
    }
    if (tiktok) {
        html += `<a href="${escapeHtml(tiktok)}" target="_blank" rel="noopener noreferrer" class="social-btn tiktok-btn" title="TikTok">
            <i class="fab fa-tiktok"></i> <span>TikTok</span>
        </a>`;
    }
    html += '</div></div>';
    container.innerHTML = html;
    container.style.display = 'block';
}
window.renderSocialLinks = renderSocialLinks;

/**
 * Renderiza la ubicación de la pyme en la vista cliente (modo 'local').
 * Lee desde la configuración visual cargada (localStorage tenant_config_<id>
 * o VisualConfigManager.loadConfig). Muestra dirección + mapa pequeño de
 * Google Maps (sin API key) + botón "Cómo llegar" que abre Google Maps.
 * Si el modo no es 'local' o no hay dirección, oculta el contenedor.
 */
async function renderUbicacion(containerId) {
    const container = document.getElementById(containerId || 'ubicacion-banner');
    if (!container) return;

    let config;
    try {
        const tenantId = await getCurrentTenantId();
        if (!tenantId) { container.style.display = 'none'; return; }
        const cached = localStorage.getItem(`tenant_config_${tenantId}`);
        if (cached) {
            config = JSON.parse(cached);
            // Cache antiguo (creado antes de la feature ubicación): recargar desde
            // BD para tener los campos nuevos (ubicacion_tipo/direccion).
            if (!config || config.ubicacion_tipo === undefined) {
                config = await VisualConfigManager.loadConfig();
            }
        } else {
            config = await VisualConfigManager.loadConfig();
        }
    } catch (e) {
        console.warn('[ubicacion] Error cargando config:', e);
        container.style.display = 'none';
        return;
    }

    const modo = config.ubicacion_tipo || '';
    const direccion = (config.direccion || '').trim();
    if (modo !== 'local' || !direccion) {
        container.style.display = 'none';
        return;
    }

    const q = encodeURIComponent(direccion);
    const embedUrl = `https://www.google.com/maps?q=${q}&output=embed`;
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${q}`;

    container.innerHTML = `
        <div class="ubicacion-banner-inner">
            <div class="ubicacion-info">
                <span class="ubicacion-label"><i class="fas fa-map-marker-alt"></i> Nuestra ubicación</span>
                <span class="ubicacion-direccion">${escapeHtml(direccion)}</span>
            </div>
            <a href="${mapsUrl}" target="_blank" rel="noopener noreferrer" class="ubicacion-mapa" title="Abrir en Google Maps y Cómo llegar">
                <iframe src="${embedUrl}" loading="lazy" title="Mapa de ${escapeHtml(direccion)}" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe>
            </a>
            <a href="${mapsUrl}" target="_blank" rel="noopener noreferrer" class="ubicacion-btn">
                <i class="fas fa-directions"></i> Cómo llegar (Google Maps)
            </a>
        </div>`;
    container.style.display = 'block';
}
window.renderUbicacion = renderUbicacion;

// ============================================
// FUNCIONES DE CLIENTE (modificadas para async)
// ============================================

// ── Sesión local del cliente (sessionStorage) ──
const SESSION_KEY = 'agenda_cliente_session';

function getClienteSession() {
    try {
        const raw = sessionStorage.getItem(SESSION_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
}

function setClienteSession(data) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(data));
}

function clearClienteSession() {
    sessionStorage.removeItem(SESSION_KEY);
}

/**
 * Muestra formulario de registro para clientes externos (sin Auth).
 */
function mostrarFormularioCliente(onCompletado) {
    const tenantId = window.currentTenantId || '';
    const storageKey = `agenda_cliente_saved_${tenantId}`;

    function cargarDatosGuardados() {
        try {
            const raw = localStorage.getItem(storageKey);
            return raw ? JSON.parse(raw) : null;
        } catch(e) { return null; }
    }

    function guardarDatosLocalmente(data) {
        try { localStorage.setItem(storageKey, JSON.stringify(data)); } catch(e) {}
    }

    let overlay = document.getElementById('cliente-registro-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'cliente-registro-overlay';
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-content glass-panel cliente-registro-modal">
                <div class="cliente-registro-icon">
                    <i class="fas fa-user-circle"></i>
                </div>
                <h2>¡Bienvenido!</h2>
                <p class="muted">Ingresa tus datos para comenzar a reservar servicios</p>
                <form id="cliente-registro-form" class="form-group" autocomplete="off">
                    <div class="input-with-icon">
                        <i class="fas fa-user"></i>
                        <input type="text" id="cliente-registro-nombre" placeholder="Tu nombre*" required>
                    </div>
                    <div class="input-with-icon">
                        <i class="fas fa-envelope"></i>
                        <input type="email" id="cliente-registro-email" placeholder="Tu correo electrónico*" required>
                    </div>
                    <div class="input-with-icon">
                        <i class="fab fa-whatsapp"></i>
                        <input type="tel" id="cliente-registro-whatsapp" placeholder="Tu WhatsApp (ej: +569****5678)">
                    </div>
                    <label class="checkbox-label" style="justify-content:center;margin-top:4px;font-size:0.82rem;">
                        <input type="checkbox" id="cliente-recordar" checked>
                        <span class="checkmark"></span>
                        <i class="fas fa-save"></i> Guardar mis datos para próximas visitas
                    </label>
                    <button type="submit" class="btn-grad btn-full">
                        <i class="fas fa-arrow-right"></i> Ingresar al catálogo
                    </button>
                </form>
                <p class="muted small" style="margin-top:12px;font-size:0.75rem;">
                    <i class="fas fa-shield-alt"></i> Tus datos solo se usan para tus reservas.
                    Si marcaste "Guardar mis datos", la próxima vez se cargarán automáticamente.
                </p>
            </div>
        `;
        document.body.appendChild(overlay);
    }

    overlay.style.display = 'flex';

    const form = document.getElementById('cliente-registro-form');
    const nombreInput = document.getElementById('cliente-registro-nombre');
    const emailInput = document.getElementById('cliente-registro-email');
    const whatsappInput = document.getElementById('cliente-registro-whatsapp');
    const recordarCheck = document.getElementById('cliente-recordar');

    // Pre-cargar datos guardados si existen
    const saved = cargarDatosGuardados();
    if (saved) {
        if (nombreInput) nombreInput.value = saved.nombre || '';
        if (emailInput) emailInput.value = saved.email || '';
        if (whatsappInput) whatsappInput.value = saved.whatsapp || '';
        if (recordarCheck) recordarCheck.checked = true;
    }

    form.onsubmit = (e) => {
        e.preventDefault();
        const nombre = nombreInput.value.trim();
        const email = emailInput.value.trim();
        const whatsapp = whatsappInput.value.trim();
        if (!nombre || !email) { mostrarToast('Completa nombre y correo', 'warning'); return; }

        const sessionData = { nombre, email, whatsapp };
        setClienteSession(sessionData);
        window.__clienteSession = sessionData;

        // Guardar en localStorage si el usuario marcó la opción
        if (recordarCheck && recordarCheck.checked) {
            guardarDatosLocalmente(sessionData);
        } else {
            // Si desmarcó, eliminar datos guardados previos
            try { localStorage.removeItem(storageKey); } catch(e) {}
        }

        overlay.style.display = 'none';

        // Pre-llenar campos del popup de reserva si ya existen
        const nombreField = document.getElementById('cliente-nombre');
        if (nombreField) nombreField.value = nombre;
        const telField = document.getElementById('cliente-tel');
        if (telField) telField.value = whatsapp;
        const emailField = document.getElementById('cliente-email');
        if (emailField) emailField.value = email;

        // Actualizar header
        const userSpan = document.querySelector('.user-info.client span');
        if (userSpan) userSpan.textContent = nombre;

        if (typeof onCompletado === 'function') onCompletado(sessionData);
    };

    setTimeout(() => nombreInput?.focus(), 300);
}
async function iniciarCliente() {
    console.log('[iniciarCliente] Inicializando vista cliente...');

    // 1. Obtener tenant_id (prioridad: currentTenantId > URL > slug pathname > sesion > primer tenant)
    let tenantId = window.currentTenantId || null;
    let nombreTenant = null; // nombre real desde el RPC slug (anon no puede leer tenants por RLS)
    const urlParams = new URLSearchParams(window.location.search);
    if (!tenantId) {
        tenantId = urlParams.get('tenant_id') || urlParams.get('tenant');
    }
    if (!tenantId) {
        // URL amigable SEO /p/:slug — el rewrite de Vercel sirve cliente.html pero el
        // navegador NO ve el query string (?tenant=) porque el rewrite es server-side.
        const pathMatch = (window.location.pathname || '').match(/^\/p\/([^/]+)\/?$/);
        if (pathMatch) {
            try {
                tenantId = decodeURIComponent(pathMatch[1]);
                console.log('[iniciarCliente] Slug desde pathname:', tenantId);
            } catch (e) {
                console.warn('[iniciarCliente] Slug inválido en pathname:', e);
            }
        }
    }
    if (!tenantId) {
        const session = await getSession();
        if (session && session.tenant_id) {
            tenantId = session.tenant_id;
        }
    }
    if (!tenantId && supabaseClient) {
        // Fallback: primer tenant de la BD (para clientes anonimos sin sesion)
        try {
            const { data, error } = await supabaseClient
                .from('tenants')
                .select('id')
                .limit(1);
            if (!error && data && data[0]) {
                tenantId = data[0].id;
                console.log('[iniciarCliente] Tenant por defecto asignado:', tenantId);
            }
        } catch (e) {
            console.warn('[iniciarCliente] Error obteniendo tenant por defecto:', e);
        }
    }

    if (!tenantId) {
        mostrarToast('Enlace inválido: no se especificó el negocio', 'error');
        console.error('❌ No se pudo determinar el tenant');
        return;
    }

    // Validar formato UUID; si NO es UUID, resolver slug (URL amigable SEO /p/:slug)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(tenantId.trim())) {
        try {
            const { data: slugTenant, error: slugError } = await supabaseClient.rpc('get_tenant_by_slug', { p_slug: tenantId.trim().toLowerCase() });
            // PostgREST devuelve un ARRAY para funciones RETURNS TABLE
            // (ej. [{id, nombre_negocio, slug}]) — no un objeto único.
            const filaSlug = Array.isArray(slugTenant) ? slugTenant[0] : slugTenant;
            if (slugError || !filaSlug?.id) {
                mostrarToast('Negocio no encontrado', 'error');
                console.error('❌ Slug no resuelto:', tenantId, slugError?.message || '');
                return;
            }
            tenantId = filaSlug.id;
            nombreTenant = filaSlug.nombre_negocio || null;
            console.log('[iniciarCliente] Slug resuelto → tenant:', tenantId);
        } catch (e) {
            mostrarToast('Enlace inválido: negocio no encontrado', 'error');
            console.error('❌ Excepción resolviendo slug:', e);
            return;
        }
    }

    // Establecer tenant en Supabase (para políticas anónimas RLS)
    // Usa set_tenant_anon que valida que el tenant exista y esté activo
    try {
        const { data: tenantValido, error: rpcError } = await supabaseClient.rpc('set_tenant_anon', { p_tenant_id: tenantId });
        if (rpcError) console.warn('[iniciarCliente] set_tenant_anon falló:', rpcError);
        else if (tenantValido === true) console.log('[iniciarCliente] Tenant validado y contexto establecido');
        else console.warn('[iniciarCliente] Tenant no válido o inactivo');
    } catch (e) {
        console.error('[iniciarCliente] Excepción en set_tenant_anon:', e);
    }
    window.currentTenantId = tenantId;

    // SEO: título de la pestaña con el nombre del negocio
    // (anon no puede SELECT directo a tenants por RLS → fallback al nombre del RPC)
    try {
        const { data: tData } = await supabaseClient
            .from('tenants')
            .select('nombre_negocio')
            .eq('id', tenantId)
            .maybeSingle();
        const nombreFinal = tData?.nombre_negocio || nombreTenant;
        if (nombreFinal) {
            document.title = `${nombreFinal} - Organify | Reserva online`;
        }
    } catch (e) {
        console.warn('[iniciarCliente] Error seteando title SEO:', e);
    }

    // Cargar configuración visual del tenant
    try {
        const visualConfig = await VisualConfigManager.loadConfig();
        VisualConfigManager.applyStyles(visualConfig);
        renderSocialLinks('social-links-banner');
        renderUbicacion('ubicacion-banner');
    } catch (e) {
        console.warn('[iniciarCliente] Error cargando config visual:', e);
    }

    // Reseñas del Directorio Público (solo si el negocio participa y las acepta)
    try {
        await cargarResenasCliente(tenantId);
    } catch (e) {
        console.warn('[iniciarCliente] Error cargando reseñas:', e);
    }

    // Cargar nombre del tenant (para mostrarlo en la esquina)
    try {
        const { data: tenantInfo } = await supabaseClient
            .from('tenants')
            .select('nombre_negocio')
            .eq('id', tenantId)
            .maybeSingle();
        const tenantNameEl = document.getElementById('tenant-name-display');
        if (tenantNameEl) {
            tenantNameEl.textContent = tenantInfo?.nombre_negocio || nombreTenant || 'Mi Negocio';
        }
    } catch (e) {
        console.warn('[iniciarCliente] Error cargando nombre del tenant:', e);
        const tenantNameEl = document.getElementById('tenant-name-display');
        if (tenantNameEl) tenantNameEl.textContent = nombreTenant || 'Mi Negocio';
    }

    // Cargar servicios (funciona con o sin sesión)
    currentFilterTerm = '';
    currentFilterDate = '';
    currentFilterCategory = 'todos';
    await cargarServiciosParaCliente(tenantId);
    configurarBuscadorCliente();
    configurarFiltroFecha();
    configurarBotonesExportacion();

    // Determinar si es cliente externo (viene del link compartido con ?tenant= o URL amigable /p/:slug)
    // El rewrite de Vercel sirve cliente.html para /p/:slug SIN query string, por eso también
    // se detecta la ruta amigable (commit 1b58715: el link de "Compartir a Clientes" ya genera /p/slug).
    const esRutaSlugAmigable = /^\/p\//.test(window.location.pathname || '');
    const vieneDeLinkCompartido = urlParams.has('tenant') || urlParams.has('tenant_id') || esRutaSlugAmigable;

    // Verificar sesión – cargar datos adicionales si el usuario está logueado
    const session = await getSession();

    // Si viene del link compartido (?tenant=XXX): SIEMPRE mostrar formulario de registro
    // Sin importar si hay sesión Supabase (el admin probando el link también debe ver el form)
    if (vieneDeLinkCompartido) {
        console.log('[iniciarCliente] Link compartido detectado. Activando sesión local...');

        // 🔄 Limpiar cualquier sesión anterior para empezar fresco
        clearClienteSession();
        window.__clienteSession = null;
        window.__skipClientRender = true; // Evitar que DOMContentLoaded renderice carrito/reservas

        // 🔒 Limpiar carrito y reservas VISIBLEMENTE
        const cartContainer = document.querySelector('.cart-items');
        if (cartContainer) cartContainer.innerHTML = '<div style="padding:10px;text-align:center;color:#666;font-size:0.85rem;">Completa tus datos para ver tus reservas</div>';
        const reservasContainer = document.getElementById('mis-reservas-list');
        if (reservasContainer) reservasContainer.innerHTML = '';
        // Resetear total del carrito a $0
        const totalElement = document.querySelector('.cart-total strong');
        if (totalElement) totalElement.textContent = '$0';

        // Ocultar botón de cerrar sesión
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) logoutBtn.style.display = 'none';

        // Mostrar formulario de registro
        mostrarFormularioCliente((datos) => {
            console.log('[iniciarCliente] Cliente registrado:', datos.nombre);
            window.__skipClientRender = false;
            if (typeof renderMisReservas === 'function') renderMisReservas();
            if (typeof renderCarrito === 'function') renderCarrito();
            if (typeof renderSocialLinks === 'function') renderSocialLinks('social-links-banner');
            if (typeof renderUbicacion === 'function') renderUbicacion('ubicacion-banner');
        });
        return;
    }

    // Sin sesión y sin ?tenant= — modo anónimo legacy
    if (!session) {
        console.log('[iniciarCliente] Sin sesión. Funcionando en modo anónimo legacy.');
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Iniciar Sesión / Registrarse';
            logoutBtn.onclick = () => window.location.href = 'login.html';
        }
        return;
    }

    // Usuario logueado: configuración adicional
    if (session && session.rol === 'invitado') {
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Iniciar Sesión / Registrarse';
            logoutBtn.onclick = () => window.location.href = 'login.html';
        }
    }
}
window.iniciarCliente = iniciarCliente;

// ============================================================
// RESEÑAS DEL DIRECTORIO PÚBLICO — vista cliente (/p/:slug)
// Solo se muestra si el negocio participa en el directorio con
// estrellas o comentarios activos. Lee reseñas aprobadas vía RPC
// whitelist get_resenas_pyme; el formulario inserta con
// crear_resena_pyme (queda 'pendiente' hasta moderación del admin).
// Sin inline handlers (CSP): todo se enlaza con addEventListener.
// ============================================================
async function cargarResenasCliente(tenantId) {
    const section = document.getElementById('client-resenas');
    if (!section || !tenantId || !supabaseClient) return;

    // Flags públicos del negocio vía RPC whitelist (anon NO puede leer
    // tenant_config por RLS; el directorio expone los flags whitelist).
    let filaDir = null;
    try {
        const { data, error } = await supabaseClient.rpc('get_directorio_pymes');
        if (!error && Array.isArray(data)) {
            filaDir = data.find(p => p && p.tenant_id === tenantId) || null;
        }
    } catch (e) {
        console.warn('[Resenas] Error leyendo directorio:', e);
    }
    if (!filaDir) {
        section.style.display = 'none';
        return;
    }
    const estrellas = filaDir.estrellas_activas === true;
    const comentarios = filaDir.comentarios_activos === true;
    if (!estrellas && !comentarios) {
        section.style.display = 'none';
        return;
    }

    let resenas = [];
    try {
        const { data, error } = await supabaseClient.rpc('get_resenas_pyme', { p_tenant_id: tenantId });
        if (!error && Array.isArray(data)) resenas = data;
    } catch (e) {
        console.warn('[Resenas] Error cargando reseñas:', e);
    }

    section.style.display = '';
    section.innerHTML = renderResenasCliente(resenas, estrellas, comentarios);
    bindResenasCliente(section, tenantId, estrellas, comentarios);
}

function renderResenasCliente(resenas, estrellas, comentarios) {
    const lista = Array.isArray(resenas) ? resenas : [];
    const conPuntos = lista.filter(r => Number(r.puntuacion) > 0);
    const promedio = conPuntos.length
        ? (conPuntos.reduce((acc, r) => acc + Number(r.puntuacion), 0) / conPuntos.length)
        : 0;
    const total = lista.length;

    let resumenHtml = '';
    if (estrellas && total > 0) {
        const redondeo = Math.round(promedio * 2) / 2;
        let stars = '<span class="client-resenas-stars big">';
        for (let i = 1; i <= 5; i++) {
            stars += (redondeo >= i || redondeo >= i - 0.5)
                ? '<i class="fas fa-star"></i>'
                : '<i class="far fa-star"></i>';
        }
        stars += '</span>';
        resumenHtml = `
            <div class="client-resenas-resumen">
                ${stars}
                <span class="client-resenas-promedio">${promedio.toFixed(1)}</span>
                <span class="client-resenas-total">${total} reseña${total === 1 ? '' : 's'}</span>
            </div>`;
    } else if (total === 0) {
        resumenHtml = '<p class="client-resenas-vacio">Aún no hay reseñas publicadas. ¡Sé el primero en opinar!</p>';
    }

    const itemsHtml = lista.length
        ? lista.map(r => {
            const fecha = resenaFechaCliente(r.creado_en);
            return `
                <div class="client-resena-item">
                    <div class="client-resena-head">
                        <span class="client-resena-nombre"><i class="fas fa-user-circle"></i> ${escapeHtml(r.nombre_cliente)}</span>
                        ${r.puntuacion ? resenaEstrellasCliente(r.puntuacion) : ''}
                        ${fecha ? `<span class="client-resena-fecha">${fecha}</span>` : ''}
                    </div>
                    ${r.comentario ? `<p class="client-resena-texto">${escapeHtml(r.comentario)}</p>` : ''}
                </div>`;
        }).join('')
        : '';

    const formHtml = (estrellas || comentarios) ? `
        <div class="client-resenas-form">
            <h4 class="client-resenas-form-title"><i class="fas fa-pen"></i> Deja tu reseña</h4>
            <div class="client-resenas-form-row">
                <input type="text" id="client-resenas-nombre" placeholder="Tu nombre *" maxlength="60" autocomplete="off" value="${escapeHtml((window.__clienteSession && window.__clienteSession.nombre) || '')}">
            </div>
            ${estrellas ? `
                <div class="client-resenas-form-row">
                    <span class="client-resenas-form-label">Tu puntuación:</span>
                    <div class="client-resenas-picker" id="client-resenas-picker" role="radiogroup" aria-label="Puntuación">
                        ${[1, 2, 3, 4, 5].map(i =>
                            `<button type="button" data-val="${i}" aria-label="${i} estrella${i === 1 ? '' : 's'}"><i class="far fa-star"></i></button>`
                        ).join('')}
                    </div>
                </div>` : ''}
            ${comentarios ? `
                <div class="client-resenas-form-row">
                    <textarea id="client-resenas-comentario" placeholder="Cuéntanos tu experiencia (opcional)" maxlength="500" rows="3"></textarea>
                    <span class="client-resenas-contador" id="client-resenas-contador">0/500</span>
                </div>` : ''}
            <button type="button" class="btn-grad client-resenas-enviar" id="client-resenas-enviar">
                <i class="fas fa-paper-plane"></i> Enviar reseña
            </button>
            <p class="client-resenas-nota"><i class="fas fa-shield-alt"></i> Tu reseña se publicará después de la moderación del negocio.</p>
        </div>` : '';

    return `
        <div class="client-resenas-inner glass-panel">
            <h3 class="client-resenas-title"><i class="fas fa-comments"></i> Reseñas de clientes</h3>
            ${resumenHtml}
            ${itemsHtml ? `<div class="client-resenas-lista">${itemsHtml}</div>` : ''}
            ${formHtml}
        </div>`;
}

function resenaEstrellasCliente(n) {
    const val = Number(n) || 0;
    let html = '<span class="client-resenas-stars" aria-label="' + val + ' de 5 estrellas">';
    for (let i = 1; i <= 5; i++) html += i <= val ? '<i class="fas fa-star"></i>' : '<i class="far fa-star"></i>';
    return html + '</span>';
}

function resenaFechaCliente(iso) {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch (e) {
        return '';
    }
}

function bindResenasCliente(section, tenantId, estrellas, comentarios) {
    let valorPuntuacion = 0;

    const picker = section.querySelector('#client-resenas-picker');
    if (picker) {
        const pintar = (n) => {
            picker.querySelectorAll('button').forEach(b => {
                const on = Number(b.dataset.val) <= n;
                b.innerHTML = on ? '<i class="fas fa-star"></i>' : '<i class="far fa-star"></i>';
                b.setAttribute('aria-checked', on ? 'true' : 'false');
            });
        };
        picker.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-val]');
            if (!btn) return;
            valorPuntuacion = Number(btn.dataset.val);
            pintar(valorPuntuacion);
        });
    }

    const ta = section.querySelector('#client-resenas-comentario');
    const contador = section.querySelector('#client-resenas-contador');
    if (ta && contador) {
        ta.addEventListener('input', () => { contador.textContent = ta.value.length + '/500'; });
    }

    const enviar = section.querySelector('#client-resenas-enviar');
    if (!enviar) return;
    enviar.addEventListener('click', async () => {
        const nombreEl = section.querySelector('#client-resenas-nombre');
        const nombre = (nombreEl ? nombreEl.value : '').trim();
        const comentario = ta ? ta.value.trim() : '';
        if (nombre.length < 2) {
            mostrarToast('Escribe tu nombre para dejar la reseña', 'warning');
            return;
        }
        if (estrellas && !valorPuntuacion && !(comentarios && comentario)) {
            mostrarToast('Selecciona una puntuación o escribe un comentario', 'warning');
            return;
        }
        if (!estrellas && !comentario) {
            mostrarToast('Escribe un comentario para dejar la reseña', 'warning');
            return;
        }
        enviar.disabled = true;
        const original = enviar.innerHTML;
        enviar.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enviando...';
        try {
            const { error } = await supabaseClient.rpc('crear_resena_pyme', {
                p_tenant_id: tenantId,
                p_nombre_cliente: nombre,
                p_puntuacion: valorPuntuacion || null,
                p_comentario: comentario || null
            });
            if (error) throw error;
            mostrarToast('✅ ¡Gracias! Tu reseña se publicará tras la moderación del negocio.', 'success');
            await cargarResenasCliente(tenantId);
        } catch (err) {
            const msg = (err && (err.message || err.error_description)) || 'No se pudo enviar la reseña';
            mostrarToast('❌ ' + msg, 'error');
            enviar.disabled = false;
            enviar.innerHTML = original;
        }
    });
}

async function cargarServiciosParaCliente(tenantId) {
    const gridContainer = document.getElementById('client-services-grid');
    if (!gridContainer) {
        console.error("❌ No se encontró el contenedor de servicios para cliente");
        return;
    }

    // Si no pasaron tenantId, obtenerlo de currentTenantId
    if (!tenantId && window.currentTenantId) {
        tenantId = window.currentTenantId;
    }
    if (!tenantId) {
        console.warn("⚠️ No hay tenantId para cargar servicios del cliente");
        return;
    }

    const servicios = await ServiciosManager.getAll(tenantId);
    const serviciosActivos = servicios.filter(s => s.activo === true);

    actualizarGridCliente(serviciosActivos);
}
window.cargarServiciosParaCliente = cargarServiciosParaCliente;

function configurarBuscadorCliente() {
    const searchInput = document.querySelector('.search-box input');
    if (!searchInput) {
        console.error("❌ No se encontró el input de búsqueda");
        return;
    }

    searchInput.addEventListener('input', debounce(function(e) {
        currentFilterTerm = e.target.value.toLowerCase().trim();
        aplicarFiltrosCombinados();
    }, 300));

    // Helper debounce para inputs de búsqueda en el scope global
    function debounce(fn, delay) {
        let timer;
        return function(...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), delay);
        };
    }

    const filterBtns = document.querySelectorAll('.filter-btn');
    filterBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            filterBtns.forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            
            const texto = this.textContent.trim();
            if (texto === 'Todos') {
                currentFilterCategory = 'todos';
            } else if (texto === 'Bienestar') {
                currentFilterCategory = 'bienestar';
            } else if (texto === 'Belleza') {
                currentFilterCategory = 'belleza';
            } else if (texto === 'Salud') {
                currentFilterCategory = 'salud';
            } else if (texto === 'Más filtros') {
                return;
            }
            
            aplicarFiltrosCombinados();
        });
    });
}
window.configurarBuscadorCliente = configurarBuscadorCliente;

function actualizarGridCliente(servicios) {
    const gridContainer = document.getElementById('client-services-grid');
    if (!gridContainer) return;

    if (servicios.length === 0) {
        gridContainer.innerHTML = `
            <div class="empty-state" style="grid-column: 1/-1; text-align: center; padding: 60px 20px;">
                <i class="fas fa-search" style="font-size: 48px; margin-bottom: 20px; opacity: 0.5;"></i>
                <h4 style="color: var(--text-light); margin-bottom: 10px;">No se encontraron servicios</h4>
                <p style="color: var(--text-muted);">Intenta con otra búsqueda</p>
            </div>
        `;
        return;
    }

    function getCategoriaNombre(cat) {
        const categorias = {
            'belleza': 'Belleza',
            'bienestar': 'Bienestar',
            'salud': 'Salud',
            'otros': 'Otros'
        };
        return categorias[cat] || 'General';
    }

    function formatTimeDisplay(time24) {
        if (!time24) return '';
        const [hour, minute] = time24.split(':');
        const h = parseInt(hour);
        const ampm = h >= 12 ? 'PM' : 'AM';
        const hour12 = h % 12 || 12;
        return `${hour12}:${minute} ${ampm}`;
    }

    function formatFechaCorta(dateStr) {
        try {
            const date = parseDate(dateStr);
            return date.toLocaleDateString('es-ES', {
                day: 'numeric',
                month: 'short'
            });
        } catch (e) {
            return dateStr;
        }
    }

    let html = '';

    servicios.forEach(servicio => {
        let fechasText = '';
        if (servicio.fechas && servicio.fechas.length > 0) {
            const fechasMostrar = servicio.fechas.slice(0, 3);
            const fechasFormateadas = fechasMostrar.map(f => formatFechaCorta(f));
            fechasText = fechasFormateadas.join(', ');
            if (servicio.fechas.length > 3) fechasText += '...';
        }

        let horariosText = '';
        if (servicio.disponibilidad && Object.keys(servicio.disponibilidad).length > 0) {
            const primeraFecha = Object.keys(servicio.disponibilidad)[0];
            const primerosHorarios = (servicio.disponibilidad[primeraFecha] || []).slice(0,2);
            horariosText = primerosHorarios.map(m => `${formatTimeDisplay(m.hora || m.startTime || '00:00')}`).join(', ');
            const totalTurnos = Object.values(servicio.disponibilidad || {}).reduce((acc, arr) => acc + (arr ? arr.length : 0), 0);
            if (totalTurnos > 2) horariosText += '...';
        } else if (servicio.modulos && servicio.modulos.length > 0) {
            const primerosHorarios = servicio.modulos.slice(0, 2);
            horariosText = primerosHorarios.map(m => `${formatTimeDisplay(m.hora || m.startTime || '00:00')}`).join(', ');
            if (servicio.modulos.length > 2) horariosText += '...';
        } else {
            horariosText = `${servicio.duracion} min`;
        }

        const todayStr = (new Date()).toISOString().slice(0,10);
        let totalCupos = 0;
        let fechasConCupos = 0;
        if (servicio.disponibilidad && Object.keys(servicio.disponibilidad).length > 0) {
            Object.keys(servicio.disponibilidad).forEach(f => {
                if (f < todayStr) return;
                const mods = servicio.disponibilidad[f] || [];
                const suma = (mods || []).reduce((a,b) => a + (Number(b.cupos||0)), 0);
                if (suma > 0) fechasConCupos += 1;
                totalCupos += suma;
            });
        }


        html += `
        <div class="service-card" data-service-id="${servicio.id}">
            <div class="service-image">
                ${renderImagenServicio(servicio)}
                <span class="service-category ${servicio.categoria}">
                    ${getCategoriaNombre(servicio.categoria)}
                </span>
                ${servicio.destacado ? '<span class="service-featured"><i class="fas fa-star"></i></span>' : ''}
                ${servicio.tipo_venta === 'promocion' ? '<span class="badge-promo-card"><i class="fas fa-gift"></i> PROMO</span>' : ''}
            </div>
            
            <div class="service-content">
                <h3>${escapeHtml(servicio.nombre)}</h3>
                <p class="service-description">${escapeHtml(servicio.descripcion) || 'Sin descripción disponible'}</p>
                
                ${servicio.fechas && servicio.fechas.length > 0 ? `
                <div class="service-dates-info-card">
                    <i class="fas fa-calendar-alt"></i>
                    <div class="dates-list">
                        <strong>${servicio.fechas.length} fecha(s):</strong>
                        <span class="fechas-text">${fechasText}</span>
                    </div>
                </div>
                ` : ''}
                
                <div class="service-meta">
                    <span class="duration" title="Horarios disponibles">
                        <i class="fas fa-clock"></i> ${horariosText}
                    </span>
                    <span class="capacity">
                        <i class="fas fa-users"></i>
                        ${ totalCupos > 0 ? `${totalCupos} cupos totales en ${fechasConCupos} fecha(s)` : '<span class="badge agotado">AGOTADO</span>' }
                    </span>
                </div>
                
                <div class="service-footer">
                    <div class="price">
                        ${servicio.tipo_venta === 'promocion'
                            ? `<span class="promo-card-price">${formatearPeso(servicio.precio_promocion)}</span> <small class="promo-card-ind">${formatearPeso(servicio.precio)} sesión · ${servicio.num_sesiones || 'N'} sesiones</small>`
                            : formatearPeso(servicio.precio)}
                    </div>
                    <button class="btn-grad btn-reservar" data-service-id="${servicio.id}" ${ totalCupos === 0 ? 'disabled style="opacity:0.6;cursor:not-allowed;"' : '' }>
                        <i class="fas fa-calendar-plus"></i> ${ totalCupos === 0 ? 'Agotado' : 'Reservar' }
                    </button>
                </div>
            </div>
        </div>
        `;
    });

    gridContainer.innerHTML = html;

    document.querySelectorAll('.btn-reservar').forEach(btn => {
        btn.addEventListener('click', function() {
            const serviceId = Number(this.dataset.serviceId);
            abrirModalReserva(serviceId);
        });
    });

    // Vista previa: clic en la card (fuera de botones) muestra la
    // disponibilidad (fechas, días y horarios) antes de reservar
    gridContainer.querySelectorAll('.service-card').forEach(card => {
        card.addEventListener('click', function(e) {
            if (e.target.closest('button') || e.target.closest('a')) return;
            const id = this.dataset.serviceId;
            if (id) verServicioCliente(id);
        });
    });
}
window.actualizarGridCliente = actualizarGridCliente;

// ── Vista previa de servicio (vista cliente) ──
// Al hacer clic en la card se muestra qué fechas, días y horarios están
// disponibles (mismo estilo que el detalle de "Mis Servicios"), antes de
// que el cliente decida reservar. "Reservar ahora" deriva al popup de reserva.
function _getPreviewModalCliente() {
    let overlay = document.getElementById('modal-servicio-cliente');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'modal-servicio-cliente';
    overlay.className = 'modal-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = `
        <div class="modal-content glass-panel" style="max-width:680px;padding:0;overflow:hidden;">
            <div style="position:relative;padding:24px 28px 18px;background:linear-gradient(135deg,rgba(157,78,221,0.15),rgba(0,184,148,0.08));border-bottom:1px solid rgba(255,255,255,0.08);">
                <button type="button" class="modal-close" id="close-servicio-cliente" aria-label="Cerrar" style="position:absolute;top:14px;right:18px;background:none;border:none;color:#fff;font-size:28px;cursor:pointer;line-height:1;opacity:0.7;transition:0.2s;">&times;</button>
                <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
                    <div id="cliente-detalle-imagen" style="width:72px;height:72px;border-radius:12px;background:rgba(255,255,255,0.05);display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;"></div>
                    <div style="min-width:0;">
                        <h3 id="cliente-detalle-nombre" style="margin:0;font-size:1.25rem;color:var(--text-light);"></h3>
                        <div style="display:flex;align-items:center;gap:12px;margin-top:6px;flex-wrap:wrap;">
                            <span id="cliente-detalle-precio" style="font-size:1.1rem;font-weight:700;color:#9d4edd;"></span>
                            <span id="cliente-detalle-duracion" style="font-size:0.8rem;color:var(--text-muted);"></span>
                        </div>
                    </div>
                </div>
            </div>
            <div style="padding:20px 28px 24px;max-height:60vh;overflow-y:auto;">
                <div id="cliente-detalle-descripcion" style="margin-bottom:20px;color:var(--text-muted);font-size:0.9rem;line-height:1.5;"></div>
                <div id="cliente-detalle-cupos-resumen" style="margin-bottom:16px;padding:12px 16px;background:rgba(0,184,148,0.08);border-radius:8px;border:1px solid rgba(0,184,148,0.15);display:flex;gap:16px;flex-wrap:wrap;"></div>
                <h4 style="margin:0 0 12px;color:var(--text-light);font-size:0.95rem;"><i class="fas fa-calendar-alt"></i> Fechas y horarios disponibles</h4>
                <div id="cliente-detalle-fechas" style="display:flex;flex-direction:column;gap:8px;"></div>
                <div style="margin-top:20px;display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;">
                    <button type="button" class="btn-secondary" id="btn-cerrar-preview-cliente"><i class="fas fa-times"></i> Cerrar</button>
                    <button type="button" class="btn-grad" id="btn-reservar-preview-cliente"><i class="fas fa-calendar-plus"></i> Reservar ahora</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const cerrar = () => { overlay.style.display = 'none'; };
    const closeBtn = overlay.querySelector('#close-servicio-cliente');
    if (closeBtn) closeBtn.addEventListener('click', cerrar);
    const btnCerrar = overlay.querySelector('#btn-cerrar-preview-cliente');
    if (btnCerrar) btnCerrar.addEventListener('click', cerrar);
    overlay.addEventListener('click', function(e) {
        if (e.target === overlay) cerrar();
    });
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && overlay.style.display === 'flex') cerrar();
    });
    const btnReservar = overlay.querySelector('#btn-reservar-preview-cliente');
    if (btnReservar) {
        btnReservar.addEventListener('click', function() {
            const sid = overlay.dataset.serviceId;
            overlay.style.display = 'none';
            if (sid) abrirModalReserva(sid);
        });
    }
    return overlay;
}

async function verServicioCliente(id) {
    const servicios = await ServiciosManager.getAll();
    const s = servicios.find(sv => String(sv.id) === String(id));
    if (!s) { mostrarMensaje('Servicio no encontrado', 'error'); return; }

    // Formato 12h (mismo que las cards del cliente, p.ej. "10:00 AM")
    function _fmt12h(time24) {
        if (!time24) return '';
        const [hour, minute] = time24.split(':');
        const h = parseInt(hour, 10) || 0;
        const ampm = h >= 12 ? 'PM' : 'AM';
        const hour12 = h % 12 || 12;
        return `${hour12}:${minute} ${ampm}`;
    }

    const overlay = _getPreviewModalCliente();
    overlay.dataset.serviceId = String(id);

    // Imagen
    const imgContainer = overlay.querySelector('#cliente-detalle-imagen');
    imgContainer.innerHTML = '';
    imgContainer.style.background = 'rgba(255,255,255,0.05)';
    if (s.imagen) {
        const img = document.createElement('img');
        img.src = s.imagen;
        img.alt = s.nombre || '';
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'cover';
        img.onerror = () => {
            imgContainer.style.background = 'rgba(255,255,255,0.05)';
            imgContainer.innerHTML = '<i class="fas fa-image" style="font-size:1.5rem;color:var(--text-muted);"></i>';
        };
        imgContainer.appendChild(img);
    } else {
        imgContainer.innerHTML = '<i class="fas fa-image" style="font-size:1.5rem;color:var(--text-muted);"></i>';
    }

    overlay.querySelector('#cliente-detalle-nombre').textContent = s.nombre || 'Sin nombre';
    overlay.querySelector('#cliente-detalle-precio').textContent = (typeof window.formatearPeso === 'function' ? formatearPeso(s.precio) : '$' + (s.precio || 0));
    const dur = s.modulos && s.modulos.length > 0 ? (s.modulos[0].duration || s.duracion || 60) : (s.duracion || 60);
    overlay.querySelector('#cliente-detalle-duracion').innerHTML = '<i class="fas fa-hourglass-half"></i> ' + dur + ' min por turno';

    overlay.querySelector('#cliente-detalle-descripcion').textContent = s.descripcion || 'Sin descripción';

    // Resumen: solo fechas desde hoy (mismo criterio que las cards del cliente)
    const hoy = (new Date()).toISOString().slice(0, 10);
    const fechasKeys = (s.disponibilidad && typeof s.disponibilidad === 'object')
        ? Object.keys(s.disponibilidad).sort().filter(f => f >= hoy)
        : ((s.fechas || []).slice().sort().filter(f => f >= hoy));

    let totalCupos = 0;
    let fechasConCupos = 0;
    let totalTurnos = 0;
    fechasKeys.forEach(f => {
        const mods = (s.disponibilidad && s.disponibilidad[f]) || s.modulos || [];
        totalTurnos += mods.length;
        mods.forEach(m => {
            const cupo = Number(m.cupos || 0);
            totalCupos += cupo;
            if (cupo > 0) fechasConCupos++;
        });
    });

    const cuposResumen = overlay.querySelector('#cliente-detalle-cupos-resumen');
    cuposResumen.innerHTML = `
        <span><i class="fas fa-calendar-alt"></i> <strong>${fechasKeys.length}</strong> fecha(s) disponibles</span>
        <span><i class="fas fa-clock"></i> <strong>${totalTurnos}</strong> turno(s)</span>
        <span><i class="fas fa-users"></i> <strong>${totalCupos}</strong> cupo(s) totales</span>
        <span><i class="fas fa-calendar-check"></i> <strong>${fechasConCupos}</strong> fecha(s) con cupo</span>
    `;

    // Desglose fecha por fecha: día de la semana + horarios + cupos
    const fechasContainer = overlay.querySelector('#cliente-detalle-fechas');
    fechasContainer.innerHTML = '';
    const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

    if (!fechasKeys.length) {
        fechasContainer.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);"><i class="fas fa-calendar-times"></i> Sin fechas disponibles próximamente</div>';
    } else {
        fechasKeys.forEach(f => {
            const mods = (s.disponibilidad && s.disponibilidad[f]) || s.modulos || [];
            const fechaFormateada = typeof window.formatFechaCorta === 'function' ? formatFechaCorta(f) : f;
            const diaSemana = dayNames[new Date(f + 'T12:00:00').getDay()];

            let card = document.createElement('div');
            card.style.cssText = 'background:rgba(255,255,255,0.04);border-radius:8px;padding:10px 14px;border:1px solid rgba(255,255,255,0.07);';

            const headerHtml = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <strong style="font-size:0.9rem;">${fechaFormateada}</strong>
                <span style="font-size:0.75rem;color:var(--text-muted);">${diaSemana}</span>
            </div>`;

            if (!mods.length) {
                card.innerHTML = headerHtml + '<div style="font-size:0.8rem;color:#ff6b6b;padding:6px 0;"><i class="fas fa-exclamation-triangle"></i> Sin horarios asignados</div>';
            } else {
                let horariosHtml = '';
                mods.forEach(m => {
                    const hora = _fmt12h(m.hora || m.startTime || '--:--');
                    const endTime = m.endTime ? ' - ' + _fmt12h(m.endTime) : '';
                    const cupo = Number(m.cupos || 0);
                    const cupoColor = cupo <= 0 ? '#ff6b6b' : (cupo <= 3 ? '#ffaa00' : '#00b894');
                    const durMod = m.duration ? m.duration + ' min' : '';
                    horariosHtml += `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:rgba(255,255,255,0.02);border-radius:6px;margin-bottom:3px;${cupo <= 0 ? 'opacity:0.5;' : ''}">
                        <span style="font-size:0.85rem;font-weight:500;min-width:120px;">${hora}${endTime}</span>
                        ${durMod ? `<span style="font-size:0.75rem;color:var(--text-muted);">${durMod}</span>` : ''}
                        <span style="margin-left:auto;font-size:0.8rem;font-weight:600;color:${cupoColor};background:${cupoColor}15;padding:2px 10px;border-radius:10px;">${cupo <= 0 ? 'Agotado' : cupo + ' cupo' + (cupo !== 1 ? 's' : '')}</span>
                    </div>`;
                });
                card.innerHTML = headerHtml + horariosHtml;
            }
            fechasContainer.appendChild(card);
        });
    }

    // Botón reservar: deshabilitado si no hay cupos (igual que la card)
    const btnReservar = overlay.querySelector('#btn-reservar-preview-cliente');
    if (totalCupos <= 0) {
        btnReservar.disabled = true;
        btnReservar.style.opacity = '0.6';
        btnReservar.style.cursor = 'not-allowed';
        btnReservar.innerHTML = '<i class="fas fa-calendar-times"></i> Agotado';
    } else {
        btnReservar.disabled = false;
        btnReservar.style.opacity = '';
        btnReservar.style.cursor = '';
        btnReservar.innerHTML = '<i class="fas fa-calendar-plus"></i> Reservar ahora';
    }

    overlay.style.display = 'flex';
}
window.verServicioCliente = verServicioCliente;

function configurarFiltroFecha() {
    const dateInput = document.getElementById('filter-date');
    const clearBtn = document.getElementById('clear-date-filter');

    if (!dateInput) {
        console.error("❌ No se encontró el input de fecha");
        return;
    }

    const hoy = new Date();
    const año = hoy.getFullYear();
    const mes = String(hoy.getMonth() + 1).padStart(2, '0');
    const dia = String(hoy.getDate()).padStart(2, '0');
    dateInput.min = `${año}-${mes}-${dia}`;

    dateInput.addEventListener('change', function(e) {
        currentFilterDate = e.target.value;

        if (currentFilterDate) {
            dateInput.classList.add('active-filter');
        } else {
            dateInput.classList.remove('active-filter');
        }

        aplicarFiltrosCombinados();
    });

    if (clearBtn) {
        clearBtn.addEventListener('click', function() {
            dateInput.value = '';
            currentFilterDate = '';
            dateInput.classList.remove('active-filter');

            aplicarFiltrosCombinados();
        });
    }
}
window.configurarFiltroFecha = configurarFiltroFecha;

async function aplicarFiltrosCombinados() {
    const servicios = await ServiciosManager.getAll();
    const serviciosActivos = servicios.filter(s => s.activo === true);

    let serviciosFiltrados = serviciosActivos;

    if (currentFilterTerm) {
        serviciosFiltrados = serviciosFiltrados.filter(servicio => 
            servicio.nombre.toLowerCase().includes(currentFilterTerm)
        );
    }

    if (currentFilterCategory && currentFilterCategory !== 'todos') {
        serviciosFiltrados = serviciosFiltrados.filter(servicio => 
            servicio.categoria === currentFilterCategory
        );
    }

    if (currentFilterDate) {
        serviciosFiltrados = serviciosFiltrados.filter(servicio => {
            return servicio.fechas && servicio.fechas.includes(currentFilterDate);
        });
    }

    actualizarGridCliente(serviciosFiltrados);

    if (serviciosFiltrados.length === 0 && serviciosActivos.length > 0) {
        const gridContainer = document.getElementById('client-services-grid');

        let mensaje = 'No se encontraron servicios';
        if (currentFilterTerm && currentFilterCategory !== 'todos' && currentFilterDate) {
            mensaje = `No hay servicios en "${currentFilterCategory}" que coincidan con "${currentFilterTerm}" para la fecha seleccionada`;
        } else if (currentFilterTerm && currentFilterCategory !== 'todos') {
            mensaje = `No hay servicios en "${currentFilterCategory}" que coincidan con "${currentFilterTerm}"`;
        } else if (currentFilterTerm && currentFilterDate) {
            mensaje = `No hay servicios con "${currentFilterTerm}" disponibles para la fecha seleccionada`;
        } else if (currentFilterCategory !== 'todos' && currentFilterDate) {
            mensaje = `No hay servicios en "${currentFilterCategory}" disponibles para la fecha seleccionada`;
        } else if (currentFilterTerm) {
            mensaje = `No hay servicios que coincidan con "${currentFilterTerm}"`;
        } else if (currentFilterCategory !== 'todos') {
            mensaje = `No hay servicios en la categoría "${currentFilterCategory}"`;
        } else if (currentFilterDate) {
            const fechaFormateada = new Date(currentFilterDate).toLocaleDateString('es-ES');
            mensaje = `No hay servicios disponibles para el ${fechaFormateada}`;
        }

        gridContainer.innerHTML = `
            <div class="empty-state" style="grid-column: 1/-1; text-align: center; padding: 60px 20px;">
                <i class="fas fa-calendar-times" style="font-size: 48px; margin-bottom: 20px; opacity: 0.5;"></i>
                <h4 style="color: var(--text-light); margin-bottom: 10px;">${mensaje}</h4>
                <button class="btn-grad" id="clear-all-filters">
                    <i class="fas fa-times"></i> Limpiar filtros
                </button>
            </div>
        `;

        document.getElementById('clear-all-filters')?.addEventListener('click', function() {
            currentFilterTerm = '';
            currentFilterDate = '';
            currentFilterCategory = 'todos';
            
            document.querySelector('.search-box input').value = '';
            document.getElementById('filter-date').value = '';
            document.getElementById('filter-date').classList.remove('active-filter');
            
            const filterBtns = document.querySelectorAll('.filter-btn');
            filterBtns.forEach(btn => {
                if (btn.textContent.trim() === 'Todos') {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            });
            
            aplicarFiltrosCombinados();
        });
    }
}
window.aplicarFiltrosCombinados = aplicarFiltrosCombinados;

// ============================================
// EXPORTACIÓN DE SERVICIOS A CSV
// ============================================

async function exportarServiciosCSV() {
    try {
        const servicios = await ServiciosManager.getAll();
        const serviciosActivos = servicios.filter(s => s.activo === true);
        
        let serviciosFiltrados = serviciosActivos;
        
        const searchInput = document.querySelector('.search-box input');
        if (searchInput && searchInput.value) {
            const term = searchInput.value.toLowerCase().trim();
            serviciosFiltrados = serviciosFiltrados.filter(s => 
                s.nombre.toLowerCase().includes(term)
            );
        }
        
        if (currentFilterCategory && currentFilterCategory !== 'todos') {
            serviciosFiltrados = serviciosFiltrados.filter(s => 
                s.categoria === currentFilterCategory
            );
        }
        
        if (currentFilterDate) {
            serviciosFiltrados = serviciosFiltrados.filter(s => 
                s.fechas && s.fechas.includes(currentFilterDate)
            );
        }
        
        if (serviciosFiltrados.length === 0) {
            mostrarToast('No hay servicios para exportar con los filtros actuales', 'warning');
            return;
        }
        
        const cabeceras = ['ID', 'Nombre', 'Categoría', 'Precio', 'Descripción', 'Fechas Disponibles', 'Horarios', 'Estado'];
        
        const filas = serviciosFiltrados.map(s => {
            let fechasStr = '';
            if (s.fechas && s.fechas.length > 0) {
                fechasStr = s.fechas.join('; ');
            }
            
            let horariosStr = '';
            if (s.disponibilidad && typeof s.disponibilidad === 'object') {
                const horariosUnicos = new Set();
                Object.values(s.disponibilidad).forEach(mods => {
                    (mods || []).forEach(m => {
                        if (m.hora) horariosUnicos.add(m.hora);
                    });
                });
                horariosStr = Array.from(horariosUnicos).join('; ');
            }
            
            return [
                s.id,
                s.nombre,
                s.categoria,
                s.precio,
                (s.descripcion || '').replace(/,/g, ';'),
                fechasStr,
                horariosStr,
                s.activo ? 'Activo' : 'Inactivo'
            ];
        });
        
        const csvContent = [
            cabeceras.join(','),
            ...filas.map(f => f.map(cell => {
                const escaped = String(cell).replace(/"/g, '""');
                return `"${escaped}"`;
            }).join(','))
        ].join('\n');
        
        const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        const fechaStr = new Date().toISOString().slice(0,10);
        
        link.setAttribute('href', url);
        link.setAttribute('download', `servicios_${fechaStr}_filtrados.csv`);
        link.style.visibility = 'hidden';
        
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        mostrarToast(`Exportados ${serviciosFiltrados.length} servicios`, 'success');
        
    } catch (e) {
        console.error('Error exportando CSV:', e);
        mostrarToast('Error al exportar CSV', 'error');
    }
}

function configurarBotonesExportacion() {
    // El botón "Exportar CSV" del panel admin (Mis Servicios) se eliminó en
    // admin.html: no aporta valor real para una pyme (la lista se ve en
    // pantalla y los datos viven en la web). Solo se conserva el export del
    // catálogo público del cliente.
    const btnCliente = document.getElementById('export-filtered-csv');
    if (btnCliente) {
        btnCliente.addEventListener('click', exportarServiciosCSV);
    }
}

// ============================================
// RESERVA Y REPROGRAMACIÓN (modificadas para async)
// ============================================
// --- Helpers de disponibilidad de trabajadores para la reserva ---
// (espejo de src/workers/domain/horarioValidation.js: excepción de
// semana ISO > plantilla semanal; día 1=Lun..7=Dom)
function getSemanaISOKey(fechaStr) {
    const d = new Date(Date.UTC(
        parseInt(fechaStr.slice(0, 4), 10),
        parseInt(fechaStr.slice(5, 7), 10) - 1,
        parseInt(fechaStr.slice(8, 10), 10)
    ));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return d.getUTCFullYear() + '-W' + String(weekNo).padStart(2, '0');
}

function horaAMinutos(hhmm) {
    if (!hhmm) return 0;
    const p = String(hhmm).split(':');
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
}

function normalizarHoraReserva(h) {
    const p = String(h || '').split(':');
    if (p.length < 2) return String(h || '');
    return String(parseInt(p[0], 10) || 0).padStart(2, '0') + ':' + String(parseInt(p[1], 10) || 0).padStart(2, '0');
}

// Devuelve el día de horario aplicable al trabajador en esa fecha
// ({activo, inicio, fin, colacion_inicio, colacion_fin}) o null.
function getHorarioTrabajadorParaFecha(worker, fechaStr) {
    if (!worker) return null;
    const weekKey = getSemanaISOKey(fechaStr);
    const excepciones = worker.horario_excepciones || {};
    const horario = (excepciones[weekKey] && Object.keys(excepciones[weekKey]).length > 0)
        ? excepciones[weekKey]
        : (worker.horario_semanal || {});
    const d = new Date(fechaStr + 'T12:00:00');
    const dk = String(d.getDay() === 0 ? 7 : d.getDay());
    return horario[dk] || null;
}

function trabajadorTrabajaEn(worker, fechaStr) {
    const dia = getHorarioTrabajadorParaFecha(worker, fechaStr);
    return Boolean(dia && dia.activo);
}

async function getHorasOcupadasTrabajador(trabajadorId, fecha) {
    try {
        if (!supabaseClient) return [];
        // RPC SECURITY DEFINER: no depende del GUC de sesión (bug 20260916)
        const { data, error } = await supabaseClient
            .rpc('get_horas_ocupadas_trabajador_publico', {
                p_trabajador_id: trabajadorId
            });
        if (error) throw error;
        const lista = Array.isArray(data) ? data : [];
        return lista
            .filter(c => String(c.fecha) === String(fecha))
            .map(c => normalizarHoraReserva(c.hora))
            .filter(Boolean);
    } catch (e) {
        console.error('Error getHorasOcupadasTrabajador:', e);
        return [];
    }
}

// ¿El trabajador puede atender en esa fecha a esa hora (HH:MM 24h)?
// Considera: horario del día (inicio/fin/colación) + citas ya agendadas.
async function trabajadorDisponibleEnHora(worker, fechaStr, horaRaw) {
    if (!worker || !horaRaw) return false;
    const dia = getHorarioTrabajadorParaFecha(worker, fechaStr);
    if (!dia || !dia.activo) return false;

    const hMin = horaAMinutos(horaRaw);
    if (hMin < horaAMinutos(dia.inicio) || hMin >= horaAMinutos(dia.fin)) return false;

    const ci = horaAMinutos(dia.colacion_inicio);
    const cf = horaAMinutos(dia.colacion_fin);
    if (ci > 0 && cf > 0 && ci < cf && hMin >= ci && hMin < cf) return false;

    const ocupadas = await getHorasOcupadasTrabajador(worker.id, fechaStr);
    return !ocupadas.includes(normalizarHoraReserva(horaRaw));
}

async function abrirModalReserva(serviceId) {
    const servicios = await ServiciosManager.getAll();
    const servicio = servicios.find(s => String(s.id) === String(serviceId));

    if(!servicio){ mostrarMensaje('Servicio no encontrado','error'); return; }

    if(!servicio.disponibilidad || Object.keys(servicio.disponibilidad).length === 0){
        alert('Este servicio no tiene horarios configurados');
        return;
    }

    const detallesDiv = document.querySelector('#popup-reserva .detalles-servicio');
    if(!detallesDiv){ mostrarMensaje('Contenedor de popup no encontrado','error'); return; }

    // Modo ubicación del negocio: 'domicilio' => el cliente DEBE escribir su dirección
    let modoUbicacion = '';
    try {
        const tenantCfgId = await getCurrentTenantId();
        if (tenantCfgId) {
            const cachedCfg = localStorage.getItem(`tenant_config_${tenantCfgId}`);
            if (cachedCfg) {
                const parsedCfg = JSON.parse(cachedCfg);
                if (parsedCfg && parsedCfg.ubicacion_tipo !== undefined) {
                    modoUbicacion = parsedCfg.ubicacion_tipo || '';
                } else {
                    // Cache antiguo (pre-ubicación): recargar desde BD
                    const cfg = await VisualConfigManager.loadConfig();
                    modoUbicacion = cfg.ubicacion_tipo || '';
                }
            } else {
                const cfg = await VisualConfigManager.loadConfig();
                modoUbicacion = cfg.ubicacion_tipo || '';
            }
        }
    } catch (e) {
        console.warn('[reserva] Error leyendo modo ubicación:', e);
    }
    const exigeDireccion = modoUbicacion === 'domicilio';

    // Solo fechas desde hoy en adelante (no permitir reservar en fechas pasadas)
    const hoyLocalStr = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
    const fechas = Object.keys(servicio.disponibilidad || {}).sort().filter(f => f >= hoyLocalStr);
    const fechasOptions = fechas.map(f => {
        const modulosForDate = servicio.disponibilidad[f] || [];
        const todosAgotadosEnFecha = modulosForDate.length > 0 && modulosForDate.every(m => (Number(m.cupos || 0) <= 0));
        return `<option value="${f}" ${todosAgotadosEnFecha ? 'disabled' : ''}>${formatFechaConDiaSemana(f)}${todosAgotadosEnFecha ? ' (Agotada)' : ''}</option>`;
    }).join('');

    // Fechas para los SLOTS de promoción: además de las agotadas, se
    // descartan las fechas sin NINGÚN horario futuro (ej. hoy con horas
    // ya pasadas) — si no, el slot queda sin horas y el botón nunca se
    // habilita ("no me deja guardar la promoción").
    const ahoraSlots = new Date();
    const slotsFechasOptions = fechas.map(f => {
        const modulosForDate = servicio.disponibilidad[f] || [];
        const esHoyF = f === hoyLocalStr;
        const disponible = modulosForDate.some(m => {
            if (Number(m.cupos || 0) <= 0) return false;
            if (!esHoyF) return true;
            const hp = String(m.hora || m.startTime || '').match(/(\d{1,2}):(\d{2})/);
            if (!hp) return true;
            const fh = new Date();
            fh.setHours(parseInt(hp[1]), parseInt(hp[2]), 0, 0);
            return fh > ahoraSlots;
        });
        return `<option value="${f}" ${disponible ? '' : 'disabled'}>${formatFechaConDiaSemana(f)}${disponible ? '' : ' (Agotada)'}</option>`;
    }).join('');

    // Cargar trabajadores asignados al servicio (selector opcional de reserva)
    // Vía RPC SECURITY DEFINER: no depende del GUC de sesión app.tenant_id
    // (bug 20260916: el pooler transaccional pierde el GUC entre requests).
    let workersServicio = [];
    try {
        if (supabaseClient) {
            const { data: wsData, error: wsError } = await supabaseClient
                .rpc('get_trabajadores_servicio_publico', {
                    p_servicio_id: servicio.id,
                    p_tenant_id: window.currentTenantId || null
                });
            if (!wsError && Array.isArray(wsData)) workersServicio = wsData;
        }
    } catch (e) {
        console.warn('Error cargando trabajadores del servicio:', e);
        workersServicio = [];
    }

    // Servicio por promoción: el cliente elige 1 sesión (precio individual)
    // o el paquete completo de num_sesiones (precio_promocion).
    const esPromo = servicio.tipo_venta === 'promocion' && Number(servicio.num_sesiones) >= 2 && Number(servicio.precio_promocion) > 0;
    const promoAhorro = esPromo ? (Number(servicio.precio) * Number(servicio.num_sesiones)) - Number(servicio.precio_promocion) : 0;

    detallesDiv.innerHTML = `
        <p><strong>Servicio:</strong> <span id="servicio-nombre">—</span></p>
        <p><strong>Precio:</strong> <span id="servicio-precio">—</span></p>

        ${esPromo ? `
        <div class="modalidad-options" id="modalidad-options">
            <button type="button" class="modalidad-option active" data-modalidad="sesion">
                <span class="modalidad-icon"><i class="fas fa-calendar-check"></i></span>
                <span class="modalidad-text"><strong>1 sesión</strong><small>${formatearPeso(servicio.precio)}</small></span>
            </button>
            <button type="button" class="modalidad-option" data-modalidad="promocion">
                <span class="modalidad-icon"><i class="fas fa-gift"></i></span>
                <span class="modalidad-text"><strong>Promoción ${servicio.num_sesiones} sesiones</strong><small>${formatearPeso(servicio.precio_promocion)}${promoAhorro > 0 ? ` · Ahorras ${formatearPeso(promoAhorro)}` : ''}</small></span>
            </button>
        </div>
        ` : ''}

        ${workersServicio.length ? `
        <div style="margin-top:10px;">
            <label style="display:block; color:#fff; font-size:13px; margin-bottom:6px;">Trabajador (opcional)</label>
            <select id="select-trabajador" style="width:100%; padding:8px; background:rgba(255,255,255,0.04); color:#fff; border:1px solid rgba(255,255,255,0.06); border-radius:8px;">
                <option value="">Sin preferencia</option>
                ${workersServicio.map(w => `<option value="${w.id}">${escapeHtml(w.nombre)}</option>`).join('')}
            </select>
        </div>
        ` : ''}

        <div id="zona-sesion-unica"><div style="margin-top:10px; display:flex; flex-direction:column; gap:8px;">
            <div style="display:flex; gap:8px;">
                <label style="flex:1; display:block; color:#fff;">
                    Fecha:
                    <select id="select-fecha" style="width:100%; padding:8px; background:rgba(255,255,255,0.04); color:#fff; border:1px solid rgba(255,255,255,0.06); border-radius:8px;">
                        <option value="">Seleccione fecha</option>
                        ${fechasOptions}
                    </select>
                </label>

                <label style="flex:1; display:block; color:#fff;">
                    Hora:
                    <select id="select-hora" disabled style="width:100%; padding:8px; background:rgba(255,255,255,0.04); color:#fff; border:1px solid rgba(255,255,255,0.06); border-radius:8px;">
                        <option value="">Seleccione hora</option>
                    </select>
                </label>
            </div>

            <div class="popup-client-form" style="margin-top:6px; padding:10px; background:linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01)); border:1px solid rgba(255,255,255,0.04); border-radius:10px;">
                <label style="display:block; color:#fff; font-size:13px; margin-bottom:6px;">Nombre completo</label>
                <input id="cliente-nombre" type="text" placeholder="Nombre completo" style="width:100%; padding:8px; border-radius:8px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); color:#fff; margin-bottom:8px;" />

                <label style="display:block; color:#fff; font-size:13px; margin-bottom:6px;">WhatsApp / Teléfono</label>
                <input id="cliente-tel" type="tel" placeholder="(+56) 9 1234 5678" style="width:100%; padding:8px; border-radius:8px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); color:#fff; margin-bottom:8px;" />

                <label style="display:block; color:#fff; font-size:13px; margin-bottom:6px;">Correo electrónico <span style='color:#ff4949;'>*</span></label>
                <input id="cliente-email" type="email" required placeholder="correo@ejemplo.com" style="width:100%; padding:8px; border-radius:8px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); color:#fff;" />

                ${exigeDireccion ? `
                <label style="display:block; color:#fff; font-size:13px; margin-bottom:6px;">Dirección del domicilio <span style='color:#ff4949;'>*</span></label>
                <input id="cliente-direccion" type="text" placeholder="Calle, número, ciudad, referencia" style="width:100%; padding:8px; border-radius:8px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); color:#fff;" />
                <span style="display:block; font-size:0.75rem; color:rgba(255,255,255,0.45); margin-top:4px;">El negocio va a tu domicilio: escribe la dirección donde quieres recibir el servicio.</span>` : ''}
            </div>
        </div>
        </div>

        ${esPromo ? `
        <div id="zona-promocion" style="display:none; margin-top:12px;">
            <p class="promo-titulo"><i class="fas fa-gift"></i> Elige las ${servicio.num_sesiones} sesiones de tu promoción:</p>
            <div id="promo-slots"></div>
            <div id="promo-resumen"></div>
        </div>
        ` : ''}
    `;

    const nombreSpan = document.getElementById('servicio-nombre'); if(nombreSpan) nombreSpan.textContent = servicio.nombre || '—';
    const precioSpan = document.getElementById('servicio-precio');
    if(precioSpan){
        precioSpan.textContent = esPromo
            ? `${formatearPeso(servicio.precio)} sesión · ${servicio.num_sesiones} sesiones: ${formatearPeso(servicio.precio_promocion)}${promoAhorro > 0 ? ` (ahorras ${formatearPeso(promoAhorro)})` : ''}`
            : formatearPeso(servicio.precio);
    }

    // ================================================================
    // PROMOCIÓN: selector 1 sesión vs paquete + slots de sesiones
    // ================================================================
    if (esPromo) {
        const slotsContainer = document.getElementById('promo-slots');
        let slotsHtml = '';
        for (let i = 1; i <= Number(servicio.num_sesiones); i++) {
            slotsHtml += `
            <div class="promo-slot" data-slot="${i}">
                <span class="promo-slot-num">Sesión ${i} de ${servicio.num_sesiones}</span>
                <select class="promo-slot-fecha" id="promo-fecha-${i}" data-slot="${i}" ${i > 1 ? 'disabled' : ''}>
                    <option value="">Seleccione fecha</option>
                    ${slotsFechasOptions}
                </select>
                <select class="promo-slot-hora" id="promo-hora-${i}" data-slot="${i}" disabled>
                    <option value="">Seleccione hora</option>
                </select>
            </div>`;
        }
        slotsContainer.innerHTML = slotsHtml;

        function actualizarResumenPromo() {
            const resumenEl = document.getElementById('promo-resumen');
            if (!resumenEl) return;
            const elegidas = [];
            slotsContainer.querySelectorAll('.promo-slot').forEach(s => {
                const f = s.querySelector('.promo-slot-fecha')?.value;
                const h = s.querySelector('.promo-slot-hora')?.value;
                if (f && h !== '') {
                    const mod = (servicio.disponibilidad[f] || [])[Number(h)];
                    elegidas.push(`${formatFechaConDiaSemana(f)} ${formatTimeDisplay(mod?.hora || mod?.startTime || '00:00')}`);
                }
            });
            resumenEl.innerHTML = elegidas.length === 0
                ? `<div class="popup-summary">Elige fecha y hora para cada una de las ${servicio.num_sesiones} sesiones.</div>`
                : `<div class="popup-summary"><strong>${elegidas.length} de ${servicio.num_sesiones} sesiones elegidas:</strong><br>${elegidas.map(e => `• ${escapeHtml(e)}`).join('<br>')}<br><strong>Total promoción: ${formatearPeso(servicio.precio_promocion)}</strong>${promoAhorro > 0 ? ` <span style="color:#4ade80;">(ahorras ${formatearPeso(promoAhorro)})</span>` : ''}</div>`;
        }

        // Selector de modalidad: 1 sesión ↔ promoción
        document.querySelectorAll('#modalidad-options .modalidad-option').forEach(opt => {
            opt.addEventListener('click', () => {
                document.querySelectorAll('#modalidad-options .modalidad-option').forEach(o => o.classList.remove('active'));
                opt.classList.add('active');
                const mod = opt.dataset.modalidad;
                const zonaUnica = document.getElementById('zona-sesion-unica');
                const zonaPromo = document.getElementById('zona-promocion');
                const resumenMain = document.getElementById('resumen-confirmacion');
                if (zonaUnica) zonaUnica.style.display = mod === 'sesion' ? '' : 'none';
                if (zonaPromo) zonaPromo.style.display = mod === 'promocion' ? '' : 'none';
                if (resumenMain) resumenMain.style.display = mod === 'sesion' ? '' : 'none';
                if (mod === 'promocion') actualizarResumenPromo();
                checkEnableConfirm();
                validarFormularioReserva();
            });
        });

        // Fecha de un slot → poblar sus horas + habilitar el siguiente slot
        slotsContainer.querySelectorAll('.promo-slot-fecha').forEach(sel => {
            sel.addEventListener('change', function() {
                const slot = Number(this.dataset.slot);
                const fechaSel = this.value;
                const horaSel = document.getElementById(`promo-hora-${slot}`);
                if (!fechaSel) {
                    if (horaSel) { horaSel.innerHTML = '<option value="">Seleccione hora</option>'; horaSel.disabled = true; }
                    const nextSel = document.getElementById(`promo-fecha-${slot + 1}`);
                    if (nextSel) nextSel.disabled = true;
                    actualizarResumenPromo();
                    checkEnableConfirm();
                    validarFormularioReserva();
                    return;
                }
                const modulosForDate = (servicio.disponibilidad && servicio.disponibilidad[fechaSel]) ? servicio.disponibilidad[fechaSel] : [];
                const esHoySlot = fechaSel === hoyLocalStr;
                const ahoraLocalSlot = new Date();
                // Horas ya elegidas en OTROS slots con la misma fecha: se
                // excluyen para no duplicar (fecha,hora) — con cupos bajos el
                // bulk todo-o-nada fallaría por "horario agotado".
                const horasUsadasOtrosSlots = new Set();
                slotsContainer.querySelectorAll('.promo-slot').forEach(s => {
                    if (s === sel.closest('.promo-slot')) return;
                    const f2 = s.querySelector('.promo-slot-fecha')?.value;
                    const h2 = s.querySelector('.promo-slot-hora')?.value;
                    if (f2 === fechaSel && h2) horasUsadasOtrosSlots.add(String(h2));
                });
                let options = '<option value="">Seleccione hora</option>';
                modulosForDate.forEach((m, index) => {
                    if (Number(m.cupos || 0) <= 0) return;
                    if (horasUsadasOtrosSlots.has(String(index))) return;
                    const horaRaw = normalizarHoraReserva(m.hora || m.startTime || '00:00');
                    const horaText = formatTimeDisplay(horaRaw);
                    if (esHoySlot) {
                        const hp = horaText.match(/(\d{1,2}):(\d{2})/);
                        if (hp) {
                            const fh = new Date();
                            fh.setHours(parseInt(hp[1]), parseInt(hp[2]), 0, 0);
                            if (fh <= ahoraLocalSlot) return;
                        }
                    }
                    options += `<option value="${index}" data-hora="${horaText}" data-cupos="${Number(m.cupos)}">${horaText} - ${Number(m.cupos)} cupos</option>`;
                });
                if (horaSel) {
                    horaSel.innerHTML = options;
                    horaSel.disabled = options === '<option value="">Seleccione hora</option>';
                    horaSel.value = '';
                }
                actualizarResumenPromo();
                checkEnableConfirm();
                validarFormularioReserva();
            });
        });

        // Hora de un slot → habilitar el siguiente slot de fecha
        slotsContainer.querySelectorAll('.promo-slot-hora').forEach(sel => {
            sel.addEventListener('change', function() {
                const slot = Number(this.dataset.slot);
                const fSel = document.getElementById(`promo-fecha-${slot}`);
                const nextSel = document.getElementById(`promo-fecha-${slot + 1}`);
                if (nextSel) nextSel.disabled = !(fSel && fSel.value && this.value);
                actualizarResumenPromo();
                checkEnableConfirm();
                validarFormularioReserva();
            });
        });

        actualizarResumenPromo();
    }

    const popupRef = popupEl || document.getElementById('popup-reserva');
    if(popupRef) popupRef.dataset.serviceId = String(serviceId);

    const checkbox = document.getElementById('acepto-condiciones');
    if(checkbox) checkbox.checked = false;
    esReprogramacion = false;
    reprogramInfo = { citaId: null, serviceId: null, citaActual: null };
    idCitaEnEdicion = null;
    let btnConfirm = document.getElementById('btn-confirmar-reserva');
    if(btnConfirm){
        btnConfirm.disabled = true;
        btnConfirm.style.cursor = 'not-allowed';
        btnConfirm.textContent = 'Confirmar Reserva';
        btnConfirm.onclick = function(e){
            e.preventDefault();
            e.stopPropagation();
            if(idCitaEnEdicion){
                confirmarCambioFecha(reprogramInfo.citaId, reprogramInfo.serviceId, reprogramInfo.citaActual);
            } else {
                confirmarReserva(e);
            }
        };
    }

    if(window.abrirPopupReserva) window.abrirPopupReserva({ nombre: servicio.nombre, fecha:'—', hora:'—', precio: esPromo ? `${formatearPeso(servicio.precio)} sesión · ${servicio.num_sesiones} sesiones: ${formatearPeso(servicio.precio_promocion)}${promoAhorro > 0 ? ` (ahorras ${formatearPeso(promoAhorro)})` : ''}` : formatearPeso(servicio.precio) });
    if(popupEl){
        popupEl.style.display = 'flex';
        popupEl.style.opacity = '1';
        popupEl.style.transition = '';
    }

    const resumenEl = document.getElementById('resumen-confirmacion');
    function updateResumen(){
        // En modo promoción el resumen de sesiones vive en #promo-resumen
        if (document.querySelector('#modalidad-options .modalidad-option.active')?.dataset?.modalidad === 'promocion') return;
        const selF = document.getElementById('select-fecha')?.value || '';
        const selH = document.getElementById('select-hora')?.value || '';
        let horaTextoLocal = '';
        if(selF && selH && servicio && servicio.disponibilidad && servicio.disponibilidad[selF]){
            const mod = servicio.disponibilidad[selF][Number(selH)];
            horaTextoLocal = formatTimeDisplay(mod?.hora || mod?.startTime || selH || '00:00');
        }
        if(resumenEl){
            if(selF && selH){
                resumenEl.innerHTML = `<div class="popup-summary">Reservarás para el <strong>${escapeHtml(formatFechaConDiaSemana(selF))}</strong> a las <strong>${escapeHtml(horaTextoLocal)}</strong>. Recuerda: No hay reembolsos y cambios solo con 24h de antelación.</div>`;
            } else {
                resumenEl.innerHTML = `<div class="popup-summary">Selecciona fecha y hora para ver el resumen de la reserva.</div>`;
            }
        }
    }

    const selFechaEl = document.getElementById('select-fecha');
    const selHoraEl = document.getElementById('select-hora');
    if(selFechaEl){ selFechaEl.addEventListener('change', () => { updateResumen(); validarFormularioReserva(); }); }
    if(selHoraEl){ selHoraEl.addEventListener('change', () => { updateResumen(); validarFormularioReserva(); }); }
    updateResumen();

    const clienteNombreEl = document.getElementById('cliente-nombre');
    const clienteTelEl = document.getElementById('cliente-tel');
    const clienteEmailEl = document.getElementById('cliente-email');
    const clienteDireccionEl = document.getElementById('cliente-direccion');
    [clienteNombreEl, clienteTelEl, clienteEmailEl, clienteDireccionEl].forEach(el => { if(el) el.addEventListener('input', validarFormularioReserva); });

    // Autocompletado de direcciones (modo domicilio) — sugerencias precisas
    if (exigeDireccion && clienteDireccionEl) initDireccionAutocomplete(clienteDireccionEl);

    aplicarSesionAModal(popupRef);

    const selectFecha = document.getElementById('select-fecha');
    const selectHora = document.getElementById('select-hora');

    function checkEnableConfirm(){
        const selF = selectFecha ? selectFecha.value : '';
        const selH = selectHora ? selectHora.value : '';
        const acepto = document.getElementById('acepto-condiciones')?.checked;
        const enable = Boolean(selF && selH && acepto);
        if(btnConfirm){ btnConfirm.disabled = !enable; btnConfirm.style.cursor = enable ? 'pointer' : 'not-allowed'; }
    }

    async function populateHorasForFecha(fecha, trabajadorId){
        if(!selectHora) return;
        if(!fecha){
            selectHora.innerHTML = '<option value="">Seleccione hora</option>';
            selectHora.disabled = true;
            return;
        }
        const modulosForDate = (servicio.disponibilidad && servicio.disponibilidad[fecha]) ? servicio.disponibilidad[fecha] : [];
        const esHoy = fecha === hoyLocalStr;
        const ahoraLocal = new Date();

        // Trabajador seleccionado: filtrar por su horario laboral y citas ocupadas
        let trabajadorSel = null;
        let horasOcupadas = [];
        if (trabajadorId) {
            trabajadorSel = workersServicio.find(w => String(w.id) === String(trabajadorId)) || null;
            if (trabajadorSel) {
                horasOcupadas = await getHorasOcupadasTrabajador(trabajadorSel.id, fecha);
            }
        }

        let options = '<option value="">Seleccione hora</option>';
        modulosForDate.forEach((m, index) => {
            const horaRaw = normalizarHoraReserva(m.hora || m.startTime || '00:00');
            const horaText = formatTimeDisplay(horaRaw);
            const cupos = Number(m.cupos || 0);
            if(cupos <= 0) return;
            // Si es hoy, ocultar horas que ya pasaron
            if(esHoy){
                const hp = horaText.match(/(\d{1,2}):(\d{2})/);
                if(hp){
                    const fh = new Date();
                    fh.setHours(parseInt(hp[1]), parseInt(hp[2]), 0, 0);
                    if(fh <= ahoraLocal) return;
                }
            }
            // Con trabajador seleccionado: debe laborar esa hora y no estar ocupado
            if (trabajadorSel) {
                const dia = getHorarioTrabajadorParaFecha(trabajadorSel, fecha);
                if (!dia || !dia.activo) return;
                const hMin = horaAMinutos(horaRaw);
                if (hMin < horaAMinutos(dia.inicio) || hMin >= horaAMinutos(dia.fin)) return;
                const ci = horaAMinutos(dia.colacion_inicio);
                const cf = horaAMinutos(dia.colacion_fin);
                if (ci > 0 && cf > 0 && ci < cf && hMin >= ci && hMin < cf) return;
                if (horasOcupadas.includes(horaRaw)) return;
            }
            options += `<option value="${index}" data-hora="${horaText}" data-cupos="${cupos}">${horaText} - ${cupos} cupos</option>`;
        });
        if (trabajadorSel && options === '<option value="">Seleccione hora</option>') {
            options += '<option value="" disabled>Sin horarios disponibles para este trabajador</option>';
        }
        selectHora.innerHTML = options;
        selectHora.disabled = options === '<option value="">Seleccione hora</option>';
    }

    // Marca los trabajadores que no laboran en la fecha elegida y
    // deselecciona el trabajador actual si dejó de estar disponible.
    function actualizarDisponibilidadTrabajadoresFecha(fecha) {
        const selTrab = document.getElementById('select-trabajador');
        if (!selTrab) return;
        Array.from(selTrab.options).forEach(opt => {
            if (!opt.value) return; // "Sin preferencia"
            const w = workersServicio.find(x => String(x.id) === String(opt.value));
            if (!w) return;
            const trabaja = trabajadorTrabajaEn(w, fecha);
            opt.disabled = !trabaja;
            opt.textContent = trabaja ? w.nombre : `${w.nombre} (no labora)`;
        });
        // Si el trabajador seleccionado dejó de estar disponible, volver a "Sin preferencia"
        const selOpt = selTrab.selectedOptions && selTrab.selectedOptions[0];
        if (selTrab.value && selOpt && selOpt.disabled) {
            selTrab.value = '';
            populateHorasForFecha(fecha, '');
        }
    }

    if(selectFecha){
        selectFecha.addEventListener('change', function(){
            const spanFecha = document.getElementById('servicio-fecha'); if(spanFecha) spanFecha.textContent = this.value || '—';
            if(this.value){
                const selTrab = document.getElementById('select-trabajador');
                const wid = selTrab ? selTrab.value : '';
                populateHorasForFecha(this.value, wid);
                actualizarDisponibilidadTrabajadoresFecha(this.value);
            } else {
                if(selectHora){ selectHora.innerHTML = '<option value="">Seleccione hora</option>'; selectHora.disabled = true; }
                const spanHora = document.getElementById('servicio-hora'); if(spanHora) spanHora.textContent = '—';
            }
            checkEnableConfirm();
        });
    }

    const selectTrabajador = document.getElementById('select-trabajador');
    if (selectTrabajador && workersServicio.length) {
        selectTrabajador.addEventListener('change', function(){
            const wid = this.value;
            const fechaSel = selectFecha ? selectFecha.value : '';
            if (fechaSel) populateHorasForFecha(fechaSel, wid);
            if (selectHora) selectHora.value = '';
            const spanHora = document.getElementById('servicio-hora'); if(spanHora) spanHora.textContent = '—';
            checkEnableConfirm();
            validarFormularioReserva();
        });
    }

    if(selectHora){
        selectHora.addEventListener('change', function(){
            const idx = this.value;
            const spanHora = document.getElementById('servicio-hora');
            if(spanHora){
                if(idx !== ''){
                    const selectedOption = this.options[this.selectedIndex];
                    const horaText = selectedOption ? selectedOption.getAttribute('data-hora') : '';
                    const cupos = selectedOption ? selectedOption.getAttribute('data-cupos') : 0;
                    spanHora.textContent = `${horaText} ${cupos <= 0 ? '(Agotado)' : `- ${cupos} cupos`}`;
                } else {
                    spanHora.textContent = '—';
                }
            }
            checkEnableConfirm();
        });
    }

    let anyAvailable = false;
    const disponibilidad = servicio.disponibilidad || {};
    const ahoraCheck = new Date();
    fechas.forEach(f => {
        const mods = disponibilidad[f] || [];
        const esHoy = f === hoyLocalStr;
        if(mods.some(m => {
            if(Number(m.cupos || 0) <= 0) return false;
            if(!esHoy) return true;
            const hp = String(m.hora || m.startTime || '').match(/(\d{1,2}):(\d{2})/);
            if(!hp) return true;
            const fh = new Date();
            fh.setHours(parseInt(hp[1]), parseInt(hp[2]), 0, 0);
            return fh > ahoraCheck;
        })) anyAvailable = true;
    });
    if(!anyAvailable){
        if(btnConfirm){ btnConfirm.disabled = true; btnConfirm.style.cursor = 'not-allowed'; }
        mostrarMensaje('Lo sentimos, todos los horarios están agotados para este servicio','warning');
    }

    if(selectFecha) selectFecha.addEventListener('change', validarFormularioReserva);
    if(selectHora) selectHora.addEventListener('change', validarFormularioReserva);
    if(checkbox) checkbox.addEventListener('change', validarFormularioReserva);

    // El click del botón se enlaza UNA sola vez vía btnConfirm.onclick (arriba, línea ~11142).
    // Antes había además un addEventListener('click') duplicado que se acumulaba entre
    // aperturas del popup y disparaba confirmarReserva/confirmarCambioFecha DOS veces por
    // click (toasts contradictorios éxito+error: "Reserva ya en proceso" / "La nueva
    // fecha/hora debe ser diferente"). El guard dataset.reserving ya protege el doble submit.
}
window.abrirModalReserva = abrirModalReserva;

function validarFormularioReserva() {
    const selF = document.getElementById('select-fecha')?.value || '';
    const selH = document.getElementById('select-hora')?.value || '';
    const acepto = document.getElementById('acepto-condiciones')?.checked;
    const btn = document.getElementById('btn-confirmar-reserva');

    const nombreEl = document.getElementById('cliente-nombre');
    const nombreOk = nombreEl?.value?.trim() !== '';

    const telEl = document.getElementById('cliente-tel');
    const telRaw = telEl?.value?.trim() || '';
    const digitCount = (telRaw.replace(/\D/g, '') || '').length;
    let clientPhoneOk = (!telEl || digitCount >= 8);

    const emailEl = document.getElementById('cliente-email');
    let emailOk = true;
    if (emailEl && emailEl.style.display !== 'none') {
        const emailRaw = emailEl.value.trim();
        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        emailOk = emailPattern.test(emailRaw);
    }

    // Modo domicilio: la dirección es obligatoria para completar la reserva
    const dirEl = document.getElementById('cliente-direccion');
    let direccionOk = true;
    if (dirEl && dirEl.style.display !== 'none') {
        direccionOk = (dirEl.value.trim() !== '');
    }

    if (idCitaEnEdicion) {
        // En reprogramación, no exigimos datos de contacto
    }

    // Modalidad promoción: exige TODAS las sesiones del paquete completas
    const modalidadActiva = document.querySelector('#modalidad-options .modalidad-option.active')?.dataset?.modalidad || 'sesion';
    let sesionesOk;
    if (modalidadActiva === 'promocion') {
        sesionesOk = true;
        const slotsPromo = document.querySelectorAll('.promo-slot');
        if (!slotsPromo.length) {
            sesionesOk = false;
        } else {
            slotsPromo.forEach(s => {
                const f = s.querySelector('.promo-slot-fecha')?.value;
                const h = s.querySelector('.promo-slot-hora')?.value;
                if (!f || !h) sesionesOk = false;
            });
        }
    } else {
        sesionesOk = Boolean(selF && selH);
    }

    let enable = Boolean(sesionesOk && acepto && nombreOk && clientPhoneOk && emailOk && direccionOk);

    if (idCitaEnEdicion && enable) {
        const origF = reprogramInfo.citaActual?.fecha || '';
        const origH = reprogramInfo.citaActual?.hora || '';
        if (origF && origH && selF === origF && selH === origH) {
            enable = false;
        }
    }

    if (btn) {
        btn.disabled = !enable;
        btn.style.cursor = enable ? 'pointer' : 'not-allowed';
        btn.style.opacity = enable ? '1' : '0.6';
    }
    return enable;
}
window.validarFormularioReserva = validarFormularioReserva;

async function aplicarSesionAModal(popupRef) {
    try{
        // PRIORIDAD: sesión local del cliente (link compartido)
        // Siempre gana sobre la sesión Supabase, así el cliente ve sus datos y no los del admin
        if (window.__clienteSession && window.__clienteSession.email) {
            const nombreEl = document.getElementById('cliente-nombre');
            const telEl = document.getElementById('cliente-tel');
            const emailEl = document.getElementById('cliente-email');

            if(nombreEl){ nombreEl.value = window.__clienteSession.nombre || ''; nombreEl.readOnly = false; nombreEl.style.opacity = '1'; }
            if(emailEl){ emailEl.value = window.__clienteSession.email || ''; emailEl.readOnly = false; emailEl.style.opacity = '1'; emailEl.required = true; }
            if(telEl){ telEl.value = window.__clienteSession.whatsapp || ''; telEl.readOnly = false; telEl.style.opacity = '1'; }
            const direccionLocalEl = document.getElementById('cliente-direccion');
            if(direccionLocalEl){ direccionLocalEl.value = window.__clienteSession.direccion || ''; direccionLocalEl.readOnly = false; direccionLocalEl.style.opacity = '1'; }
            if(popupRef) delete popupRef.dataset.userId;
            return;
        }

        const session = await getSession();

        const nombreEl = document.getElementById('cliente-nombre');
        const telEl = document.getElementById('cliente-tel');
        const emailEl = document.getElementById('cliente-email');

        const isInvitado = (session && ((session.rol && String(session.rol).toLowerCase() === 'invitado') || (session.nombre && String(session.nombre).toLowerCase().includes('invit'))));

        if(session && session.nombre && String(session.nombre).trim() !== ''){
            if(nombreEl){
                if(isInvitado){
                    const rnd = Math.floor(Math.random()*9000) + 1000;
                    nombreEl.value = `Invitado #${rnd}`;
                    nombreEl.readOnly = false;
                    nombreEl.style.opacity = '1';
                } else {
                    nombreEl.value = session.nombre || 'Invitado';
                    nombreEl.readOnly = true;
                    nombreEl.style.opacity = '0.9';
                }
            }
            if(emailEl){
                emailEl.value = session.email || '';
                emailEl.readOnly = true;
                emailEl.style.opacity = '0.9';
                emailEl.required = true;
            }
            if(telEl){ telEl.readOnly = false; telEl.style.opacity = '1'; }
            if(popupRef && session.id) popupRef.dataset.userId = String(session.id);
        } else {
            // Sin sesión Supabase — usar sesión local (cliente del link compartido)
            if(window.__clienteSession){
                if(nombreEl){
                    nombreEl.value = window.__clienteSession.nombre || '';
                    nombreEl.readOnly = false;
                    nombreEl.style.opacity = '1';
                }
                if(emailEl){
                    emailEl.value = window.__clienteSession.email || '';
                    emailEl.readOnly = false;
                    emailEl.style.opacity = '1';
                    emailEl.required = true;
                }
                if(telEl){
                    telEl.value = window.__clienteSession.whatsapp || '';
                    telEl.readOnly = false;
                    telEl.style.opacity = '1';
                }
                const direccionLocalEl2 = document.getElementById('cliente-direccion');
                if(direccionLocalEl2){ direccionLocalEl2.value = window.__clienteSession.direccion || ''; direccionLocalEl2.readOnly = false; direccionLocalEl2.style.opacity = '1'; }
            } else {
                if(nombreEl){ const rnd = Math.floor(Math.random()*9000) + 1000; nombreEl.value = `Invitado #${rnd}`; nombreEl.readOnly = false; nombreEl.style.opacity = '1'; }
                if(emailEl){ emailEl.value = ''; emailEl.readOnly = false; emailEl.style.opacity = '1'; emailEl.required = true; }
                if(telEl){ telEl.readOnly = false; telEl.style.opacity = '1'; }
            }
            if(popupRef) delete popupRef.dataset.userId;
        }

        try{
            const roleIsInvitado = isInvitado;
            if(roleIsInvitado && emailEl){
                const maybeLabel = emailEl.previousElementSibling;
                if(maybeLabel && maybeLabel.tagName === 'LABEL') maybeLabel.style.display = 'none';
                emailEl.style.display = 'none';
                emailEl.required = false;
            } else if(emailEl){
                const maybeLabel = emailEl.previousElementSibling;
                if(maybeLabel && maybeLabel.tagName === 'LABEL') maybeLabel.style.display = '';
                emailEl.style.display = '';
                emailEl.required = true;
            }
        }catch(e){}

        if(telEl){
            if(!telEl.dataset.sanitizerAttached){
                telEl.addEventListener('input', function(){
                    let v = this.value || '';
                    v = v.replace(/[^+\d]/g, '');
                    const plusMatches = v.match(/\+/g) || [];
                    if(plusMatches.length > 1){
                        v = v.replace(/\+/g, '');
                        v = '+' + v;
                    }
                    if(v.indexOf('+') > 0){
                        v = v.replace(/\+/g, '');
                        v = '+' + v;
                    }
                    this.value = v;
                });
                telEl.dataset.sanitizerAttached = '1';
            }
        }

        const updateResumen = () => {
            try{
                const servicioNombre = document.getElementById('servicio-nombre')?.textContent || '';
                const selF = document.getElementById('select-fecha');
                const selH = document.getElementById('select-hora');
                const fechaVal = selF ? (selF.value || selF.options[selF.selectedIndex]?.text || '') : (document.getElementById('servicio-fecha')?.textContent || '');
                const horaVal = selH ? (selH.value ? (selH.options[selH.selectedIndex]?.text || '') : '') : (document.getElementById('servicio-hora')?.textContent || '');
                const resumenEl = document.querySelector('#resumen-confirmacion .popup-summary');
                if(resumenEl){
                    if(servicioNombre && (fechaVal || horaVal)){
                        resumenEl.textContent = `Reserva: ${servicioNombre} — Fecha: ${fechaVal || '—'} — Hora: ${horaVal || '—'}`;
                    } else if(fechaVal || horaVal){
                        resumenEl.textContent = `Fecha: ${fechaVal || '—'} — Hora: ${horaVal || '—'}`;
                    } else {
                        resumenEl.textContent = 'Selecciona fecha y hora para ver el resumen de la reserva.';
                    }
                }
            }catch(err){}
        };

        try{
            const selF = document.getElementById('select-fecha');
            const selH = document.getElementById('select-hora');
            if(selF && !selF.dataset.resumenAttached){ selF.addEventListener('change', updateResumen); selF.dataset.resumenAttached = '1'; }
            if(selH && !selH.dataset.resumenAttached){ selH.addEventListener('change', updateResumen); selH.dataset.resumenAttached = '1'; }
            updateResumen();
        }catch(e){}
    }catch(err){ console.warn('aplicarSesionAModal error', err); }
}
window.aplicarSesionAModal = aplicarSesionAModal;

async function confirmarReserva(e) {
    if(e){ try{ e.preventDefault(); e.stopPropagation(); }catch(err){} }
    const popup = popupEl || document.getElementById('popup-reserva');
    if(!popup){ mostrarMensaje('Popup no encontrado','error'); return; }

    if (popup.dataset.reserving === '1') {
        mostrarMensaje('Reserva ya en proceso','warning');
        return;
    }
    popup.dataset.reserving = '1';

    const confirmBtnImmediate = document.getElementById('btn-confirmar-reserva');
    if (confirmBtnImmediate) { confirmBtnImmediate.disabled = true; confirmBtnImmediate.style.cursor = 'not-allowed'; }

    const serviceId = Number(popup.dataset.serviceId);
    if(!serviceId){ mostrarMensaje('ID de servicio inválido','error'); return; }

    // Modalidad de reserva: 'sesion' (1 fecha/hora) o 'promocion' (N sesiones)
    const modalidadReserva = document.querySelector('#modalidad-options .modalidad-option.active')?.dataset?.modalidad || 'sesion';
    const esPromoReserva = modalidadReserva === 'promocion';

    const selectFecha = document.getElementById('select-fecha');
    const selectHora = document.getElementById('select-hora');
    const acepto = document.getElementById('acepto-condiciones')?.checked;

    const fecha = selectFecha ? selectFecha.value : document.getElementById('servicio-fecha')?.textContent;
    const horaIdx = selectHora ? selectHora.value : null;

    if(!acepto){ mostrarMensaje('Debes aceptar las condiciones','warning'); return; }
    if (!esPromoReserva) {
        if(!fecha || fecha === ''){ mostrarMensaje('Selecciona una fecha','warning'); return; }
        if(horaIdx === null || horaIdx === ''){ mostrarMensaje('Selecciona una hora','warning'); return; }
    }

    const nombreEl = document.getElementById('cliente-nombre');
    const nombre = nombreEl?.value?.trim() || '';
    if (!nombre) {
        mostrarToast('Debes ingresar tu nombre completo', 'error');
        popup.dataset.reserving = '0';
        if (confirmBtnImmediate) { confirmBtnImmediate.disabled = false; confirmBtnImmediate.style.cursor = 'pointer'; }
        return;
    }

    const telEl = document.getElementById('cliente-tel');
    const telVal = telEl ? String(telEl.value || '') : '';
    const telDigits = (telVal.replace(/\D/g, '')).length;
    if(telDigits < 8){
        mostrarToast('Por favor, ingresa un número de contacto válido (mínimo 8 dígitos).', 'error');
        popup.dataset.reserving = '0';
        if (confirmBtnImmediate) { confirmBtnImmediate.disabled = false; confirmBtnImmediate.style.cursor = 'pointer'; }
        return;
    }

    const emailEl = document.getElementById('cliente-email');
    if (emailEl && emailEl.style.display !== 'none') {
        const emailRaw = emailEl.value.trim();
        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailPattern.test(emailRaw)) {
            mostrarToast('Por favor, ingresa un correo electrónico válido.', 'error');
            popup.dataset.reserving = '0';
            if (confirmBtnImmediate) { confirmBtnImmediate.disabled = false; confirmBtnImmediate.style.cursor = 'pointer'; }
            return;
        }
    }

    // Modo domicilio: la dirección es obligatoria para completar la reserva
    const dirEl = document.getElementById('cliente-direccion');
    if (dirEl && dirEl.style.display !== 'none') {
        const dirRaw = dirEl.value.trim();
        if (!dirRaw) {
            mostrarToast('Debes ingresar tu dirección para completar la reserva', 'error');
            popup.dataset.reserving = '0';
            if (confirmBtnImmediate) { confirmBtnImmediate.disabled = false; confirmBtnImmediate.style.cursor = 'pointer'; }
            return;
        }
    }

    const servicios = await ServiciosManager.getAll();
    const idx = servicios.findIndex(s => String(s.id) === String(serviceId));
    if(idx === -1){ mostrarMensaje('Servicio no encontrado','error'); return; }

    const servicio = servicios[idx];

    const disponibilidad = servicio.disponibilidad || {};

    // En modo promoción los checks de fecha/hora de sesión única NO aplican:
    // el popup tiene los selects ocultos (vacíos) y las sesiones se validan
    // y arman en el branch promo (reservar_citas_bulk). Saltarse este bloque
    // evita el return temprano que dejaba el popup bloqueado (reserving='1').
    if (!esPromoReserva) {
        if(!disponibilidad[fecha] || disponibilidad[fecha].length === 0){
            mostrarMensaje('El servicio no tiene horarios configurados para la fecha seleccionada','error');
            return;
        }

        const moduloIndex = Number(horaIdx);
        const modulo = disponibilidad[fecha][moduloIndex];
        if(!modulo){ mostrarMensaje('Horario seleccionado inválido','error'); return; }

        const cuposActuales = Number(modulo.cupos || 0);
        if(cuposActuales <= 0){
            mostrarMensaje('Lo sentimos, ese horario está agotado','error');
            let anyLeft = false;
            Object.keys(disponibilidad).forEach(f => { if(disponibilidad[f].some(m => Number(m.cupos || 0) > 0)) anyLeft = true; });
            if(!anyLeft){ servicio.activo = false; servicios[idx] = servicio; await ServiciosManager.save(servicio); }
            if (typeof aplicarFiltrosCombinados === 'function') aplicarFiltrosCombinados();
            return;
        }

        var horaTexto = formatTimeDisplay(modulo.hora || modulo.startTime || '00:00');
    }

    const clienteNombre = document.getElementById('cliente-nombre')?.value?.trim() || (window.__clienteSession?.nombre || '');
    const clienteTel = document.getElementById('cliente-tel')?.value?.trim() || (window.__clienteSession?.whatsapp || '');
    const clienteEmail = document.getElementById('cliente-email')?.value?.trim() || (window.__clienteSession?.email || '');
    const clienteDireccion = document.getElementById('cliente-direccion')?.value?.trim() || (window.__clienteSession?.direccion || '');
    const session = await getSession();
    const userId = session?.id || null;

    // ================================================================
    // RESERVA SERVER-SIDE: RPC reservar_cita — valida cupos, descuenta,
    // crea la cita y la notificación, todo atómico en el servidor.
    // (El cliente ya no inserta ni descuenta directamente.)
    // ================================================================
    const tenantIdReserva = await getCurrentTenantId();
    if (!tenantIdReserva) {
        mostrarMensaje('No se pudo identificar el negocio. Recarga la página.', 'error');
        popup.dataset.reserving = '0';
        if (confirmBtnImmediate) { confirmBtnImmediate.disabled = false; confirmBtnImmediate.style.cursor = 'pointer'; }
        return;
    }

    const selTrabajador = document.getElementById('select-trabajador');
    const trabajadorIdReserva = (selTrabajador && selTrabajador.value) ? selTrabajador.value : null;

    const pContactoReserva = {
        nombre: clienteNombre || session?.nombre || '',
        telefono: clienteTel || '',
        email: clienteEmail || session?.email || '',
        direccion: clienteDireccion || '',
        userId: userId || null
    };

    let reserva, rpcError;

    if (esPromoReserva) {
        // ================================================================
        // RESERVA POR PROMOCIÓN: N sesiones en una sola operación atómica.
        // El servidor valida cupos, descuenta y crea las N citas con precio
        // = precio_promocion / num_sesiones (todo o nada).
        // ================================================================
        const itemsPromo = [];
        const numSlots = Number(servicio.num_sesiones) || 0;
        for (let i = 1; i <= numSlots; i++) {
            const fSel = document.getElementById(`promo-fecha-${i}`);
            const hSel = document.getElementById(`promo-hora-${i}`);
            if (!fSel?.value || !hSel?.value) {
                mostrarMensaje(`Completa la fecha y hora de la sesión ${i}`, 'warning');
                popup.dataset.reserving = '0';
                if (confirmBtnImmediate) { confirmBtnImmediate.disabled = false; confirmBtnImmediate.style.cursor = 'pointer'; }
                return;
            }
            const mod = (servicio.disponibilidad[fSel.value] || [])[Number(hSel.value)];
            itemsPromo.push({
                servicio_id: servicio.id,
                fecha: fSel.value,
                hora: formatTimeDisplay(mod?.hora || mod?.startTime || '00:00'),
                trabajador_id: trabajadorIdReserva || null,
                modalidad: 'promocion'
            });
        }
        const r = await supabaseClient.rpc('reservar_citas_bulk', {
            p_tenant_id: tenantIdReserva,
            p_items: itemsPromo,
            p_contacto: pContactoReserva
        });
        reserva = r.data;
        rpcError = r.error;
    } else {
        // ================================================================
        // RESERVA SERVER-SIDE: RPC reservar_cita — valida cupos, descuenta,
        // crea la cita y la notificación, todo atómico en el servidor.
        // (El cliente ya no inserta ni descuenta directamente.)
        // ================================================================
        const rr = await supabaseClient.rpc('reservar_cita', {
            p_tenant_id: tenantIdReserva,
            p_servicio_id: servicio.id,
            p_fecha: fecha,
            p_hora: horaTexto,
            p_trabajador_id: trabajadorIdReserva,
            p_contacto: pContactoReserva
        });
        reserva = rr.data;
        rpcError = rr.error;
    }

    if (rpcError) {
        console.error('Error en reservar_cita:', rpcError);
        mostrarMensaje('No se pudo completar la reserva. Intenta de nuevo.', 'error');
        popup.dataset.reserving = '0';
        if (confirmBtnImmediate) { confirmBtnImmediate.disabled = false; confirmBtnImmediate.style.cursor = 'pointer'; }
        if (typeof cargarServiciosParaCliente === 'function') cargarServiciosParaCliente();
        return;
    }

    if (!reserva || reserva.ok !== true) {
        // El servidor es la fuente de verdad (agotado, horario no disponible, etc.)
        mostrarMensaje(reserva?.error || 'No se pudo completar la reserva', 'error');
        if (typeof cargarServiciosParaCliente === 'function') cargarServiciosParaCliente();
        if (typeof actualizarGridCliente === 'function') actualizarGridCliente(await ServiciosManager.getAll());
        popup.dataset.reserving = '0';
        if (confirmBtnImmediate) { confirmBtnImmediate.disabled = false; confirmBtnImmediate.style.cursor = 'pointer'; }
        return;
    }

    if (typeof generarNotificaciones === 'function') generarNotificaciones();

    popup.style.display = 'none';

    if (typeof renderCarrito === 'function') renderCarrito();

    try{
        mostrarToast(esPromoReserva
            ? `¡Reserva exitosa! ${servicio.num_sesiones} sesiones reservadas. Revisa tu WhatsApp pronto`
            : '¡Reserva exitosa! Revisa tu WhatsApp pronto', 'success');
    }catch(e){
        mostrarMensaje(esPromoReserva
            ? `¡Reserva confirmada! ${servicio.num_sesiones} sesiones reservadas.`
            : `¡Reserva confirmada para el ${fecha} a las ${horaTexto}!`, 'success');
    }

    if (typeof cargarServiciosParaCliente === 'function') cargarServiciosParaCliente();
    if (typeof actualizarGridCliente === 'function') actualizarGridCliente(servicios);
    if (typeof aplicarFiltrosCombinados === 'function') aplicarFiltrosCombinados();

    setTimeout(() => {
        if (confirmBtnImmediate) { confirmBtnImmediate.disabled = false; confirmBtnImmediate.style.cursor = 'pointer'; }
        delete popup.dataset.reserving;
    }, 1500);
}
window.confirmarReserva = confirmarReserva;

async function abrirModalCambioFecha(citaId, serviceId, citaActual) {
    try{
        const popup = document.getElementById('popup-reserva');
        if(!popup) return;

        try {
            const ahora = new Date();
            let citaDate;

            if(citaActual && citaActual.fecha){
                const partes = String(citaActual.fecha).split('-');
                if(partes.length === 3) {
                    citaDate = new Date(partes[0], partes[1]-1, partes[2]);
                } else {
                    citaDate = new Date(citaActual.fecha);
                }

                if(citaActual.hora){
                    const hp = String(citaActual.hora).match(/(\d{1,2}):(\d{2})/);
                    if(hp){
                        citaDate.setHours(parseInt(hp[1]), parseInt(hp[2]), 0, 0);
                    }
                }
            }

            if(citaDate){
                const diferenciaMs = citaDate - ahora;
                // El admin (edición desde "Citas Programadas") puede corregir
                // citas próximas/pasadas — el RPC reagendar_cita valida server-side
                // (el admin conserva permiso; el cliente sigue con la regla de 24h).
                const esEdicionAdmin = window._modoEdicionAdmin === true;

                if(!esEdicionAdmin && diferenciaMs < 24 * 60 * 60 * 1000) {
                    let mensaje = diferenciaMs < 0 ? 'No se puede reprogramar una cita pasada' : 'No se puede reprogramar con menos de 24h de antelación';
                    mostrarToast(mensaje, 'error');
                    renderCarrito();
                    return;
                }
            }
        } catch(e){
            console.warn('Error durante validación 24h', e);
        }

        const servicios = await ServiciosManager.getAll();
        const servicio = servicios.find(s => String(s.id) === String(serviceId));

        if(!servicio){
            mostrarToast('Servicio no encontrado', 'error');
            return;
        }

        const titleEl = document.getElementById('popup-reserva-title');
        if(titleEl) titleEl.textContent = 'Reagendar Cita';

        const nombreEl = document.getElementById('servicio-nombre'); 
        if(nombreEl) nombreEl.textContent = (citaActual.nombre || '—');

        const precioEl = document.getElementById('servicio-precio'); 
        if(precioEl) precioEl.textContent = formatearPeso(citaActual.precio || 0);

        const detallesEl = document.querySelector('.detalles-servicio');
        if(detallesEl){
            detallesEl.innerHTML = '';

            const infoActual = document.createElement('div');
            infoActual.style.margin = '10px 0';
            infoActual.style.padding = '10px';
            infoActual.style.background = 'rgba(255,255,255,0.05)';
            infoActual.style.borderRadius = '8px';
            infoActual.innerHTML = `
                <p><strong>Cita actual:</strong> ${formatFechaConDiaSemana(citaActual.fecha)} - ${citaActual.hora}</p>
                <p><small>Selecciona nueva fecha y hora para reprogramar</small></p>
            `;
            detallesEl.appendChild(infoActual);

            const fechaDiv = document.createElement('div');
            fechaDiv.style.marginTop = '15px';

            const fechaLabel = document.createElement('label');
            fechaLabel.textContent = 'Nueva Fecha:';
            fechaLabel.style.display = 'block';
            fechaLabel.style.fontWeight = 'bold';
            fechaLabel.style.marginBottom = '5px';

            const fechaSelect = document.createElement('select');
            fechaSelect.id = 'select-fecha';
            fechaSelect.style.width = '100%';
            fechaSelect.style.padding = '8px';
            fechaSelect.style.marginBottom = '10px';
            fechaSelect.style.background = 'rgba(255,255,255,0.1)';
            fechaSelect.style.color = '#fff';
            fechaSelect.style.border = '1px solid rgba(255,255,255,0.2)';
            fechaSelect.style.borderRadius = '4px';

            const disponibilidad = servicio.disponibilidad || {};

            const optionDefault = document.createElement('option');
            optionDefault.value = '';
            optionDefault.textContent = '-- Selecciona fecha --';
            fechaSelect.appendChild(optionDefault);

            const hoy = new Date();
            hoy.setHours(0, 0, 0, 0);

            Object.keys(disponibilidad)
                .filter(fecha => {
                    const fechaDate = new Date(fecha + 'T12:00:00');
                    return fechaDate >= hoy;
                })
                .sort()
                .forEach(fecha => {
                    const tieneCupos = disponibilidad[fecha].some(m => Number(m.cupos || 0) > 0);
                    if(tieneCupos) {
                        const option = document.createElement('option');
                        option.value = fecha;
                        option.textContent = formatFechaConDiaSemana(fecha);
                        fechaSelect.appendChild(option);
                    }
                });

            fechaDiv.appendChild(fechaLabel);
            fechaDiv.appendChild(fechaSelect);
            detallesEl.appendChild(fechaDiv);

            const horaDiv = document.createElement('div');
            horaDiv.style.marginTop = '10px';

            const horaLabel = document.createElement('label');
            horaLabel.textContent = 'Nueva Hora:';
            horaLabel.style.display = 'block';
            horaLabel.style.fontWeight = 'bold';
            horaLabel.style.marginBottom = '5px';

            const horaSelect = document.createElement('select');
            horaSelect.id = 'select-hora';
            horaSelect.style.width = '100%';
            horaSelect.style.padding = '8px';
            horaSelect.style.background = 'rgba(255,255,255,0.1)';
            horaSelect.style.color = '#fff';
            horaSelect.style.border = '1px solid rgba(255,255,255,0.2)';
            horaSelect.style.borderRadius = '4px';
            horaSelect.disabled = true;

            const optionDefaultHora = document.createElement('option');
            optionDefaultHora.value = '';
            optionDefaultHora.textContent = '-- Primero selecciona fecha --';
            horaSelect.appendChild(optionDefaultHora);

            horaDiv.appendChild(horaLabel);
            horaDiv.appendChild(horaSelect);
            detallesEl.appendChild(horaDiv);

            fechaSelect.addEventListener('change', function(){
                const fechaSeleccionada = this.value;
                horaSelect.innerHTML = '';
                horaSelect.disabled = !fechaSeleccionada;

                if(fechaSeleccionada && disponibilidad[fechaSeleccionada]){
                    const optionDefault = document.createElement('option');
                    optionDefault.value = '';
                    optionDefault.textContent = '-- Selecciona hora --';
                    horaSelect.appendChild(optionDefault);

                    disponibilidad[fechaSeleccionada].forEach((modulo, idx) => {
                        const cuposDisp = Number(modulo.cupos || 0);
                        if(cuposDisp > 0) {
                            const horaFormateada = formatTimeDisplay(modulo.hora);
                            const option = document.createElement('option');
                            option.value = horaFormateada;
                            option.textContent = `${horaFormateada} (${cuposDisp} cupo${cuposDisp !== 1 ? 's' : ''})`;
                            horaSelect.appendChild(option);
                        }
                    });
                }
            });
        }

        const checkbox = document.getElementById('acepto-condiciones');
        if(checkbox){
            checkbox.checked = false;
            const label = checkbox.closest('label');
            if(label){
                label.innerHTML = '<input type="checkbox" id="acepto-condiciones"> Confirmo reprogramar la cita';
            }
        }

        const validarFormulario = () => {
            const fechaVal = document.getElementById('select-fecha')?.value;
            const horaVal = document.getElementById('select-hora')?.value;
            const aceptado = document.getElementById('acepto-condiciones')?.checked;
            const btnConfirm = document.getElementById('btn-confirmar-reserva');

            const valido = fechaVal && horaVal && aceptado;

            if(btnConfirm){
                btnConfirm.disabled = !valido;
                btnConfirm.style.cursor = valido ? 'pointer' : 'not-allowed';
                btnConfirm.style.opacity = valido ? '1' : '0.6';
            }
        };

        document.getElementById('select-fecha')?.addEventListener('change', validarFormulario);
        document.getElementById('select-hora')?.addEventListener('change', validarFormulario);
        document.getElementById('acepto-condiciones')?.addEventListener('change', validarFormulario);

        const btnConfirm = document.getElementById('btn-confirmar-reserva');

        esReprogramacion = true;
        reprogramInfo = { citaId, serviceId, citaActual };
        idCitaEnEdicion = String(citaId);

        if(btnConfirm){
            btnConfirm.textContent = 'Confirmar Reprogramación';
            btnConfirm.disabled = true;
            btnConfirm.style.cursor = 'not-allowed';
            btnConfirm.style.opacity = '0.6';

            btnConfirm.onclick = function(e) {
                e.preventDefault();
                e.stopPropagation();
                if(!this.disabled) {
                    confirmarCambioFecha(reprogramInfo.citaId, reprogramInfo.serviceId, reprogramInfo.citaActual);
                }
            };
        }

        aplicarSesionAModal(popup);
        validarFormulario();

        popup.style.opacity = '1';
        popup.style.transition = '';
        popup.style.display = 'flex';

    } catch(err){ 
        console.error('abrirModalCambioFecha error', err); 
    }
}
window.abrirModalCambioFecha = abrirModalCambioFecha;

async function confirmarCambioFecha(citaId, serviceId, citaActual) {
    try{
        const popup = document.getElementById('popup-reserva');
        const btnConfirm = document.getElementById('btn-confirmar-reserva');

        if(btnConfirm) btnConfirm.disabled = true;

        let citas = await CitasManager.getAll();
        const idxOriginal = citas.findIndex(c => String(c.id) === String(citaId));

        if(idxOriginal === -1){
            mostrarToast('No se encontró la cita a actualizar', 'error');
            if(btnConfirm) btnConfirm.disabled = false;
            return;
        }

        const fechaSelect = document.getElementById('select-fecha');
        const horaSelect = document.getElementById('select-hora');
        const checkbox = document.getElementById('acepto-condiciones');

        if(!fechaSelect?.value || !horaSelect?.value || !checkbox?.checked){
            mostrarToast('Completa todos los campos', 'warning');
            if(btnConfirm) btnConfirm.disabled = false;
            return;
        }

        const nuevaFecha = fechaSelect.value;
        const nuevaHoraRaw = horaSelect.value;

        const nuevaHora = limpiarHora(nuevaHoraRaw);

        if(nuevaFecha === citaActual.fecha && nuevaHora === limpiarHora(citaActual.hora)){
            mostrarToast('La nueva fecha/hora debe ser diferente a la actual', 'warning');
            if(btnConfirm) btnConfirm.disabled = false;
            return;
        }

        const servicios = await ServiciosManager.getAll();
        const servicio = servicios.find(s => String(s.id) === String(serviceId));

        if(!servicio || !servicio.disponibilidad){
            mostrarToast('Servicio no encontrado o sin disponibilidad', 'error');
            if(btnConfirm) btnConfirm.disabled = false;
            return;
        }

        if(!servicio.disponibilidad[nuevaFecha]){
            mostrarToast('Fecha no disponible', 'error');
            if(btnConfirm) btnConfirm.disabled = false;
            return;
        }

        const modulosFecha = servicio.disponibilidad[nuevaFecha];
        const moduloEncontrado = modulosFecha.find(m => {
            const horaMod = limpiarHora(m.hora || m.startTime || '');
            return horaMod === nuevaHora;
        });

        if(!moduloEncontrado){
            mostrarToast('Horario no disponible', 'error');
            if(btnConfirm) btnConfirm.disabled = false;
            return;
        }

        if(Number(moduloEncontrado.cupos || 0) <= 0){
            mostrarToast('El horario seleccionado no tiene cupos disponibles', 'error');
            if(btnConfirm) btnConfirm.disabled = false;
            return;
        }

        const citaOriginal = citas[idxOriginal];

        // ============================================================
        // FASE 2 (2026-08-25): reagendar SERVER-SIDE vía RPC
        // reagendar_cita valida dueño/admin, cupos con FOR UPDATE,
        // devuelve +1 al horario original, descuenta -1 al nuevo y
        // actualiza la cita (mismo id) en UNA operación atómica.
        // Se elimina la manipulación client-side de cupos (el RLS
        // bloqueaba el UPDATE de servicios del cliente: el cupo del
        // horario original nunca se devolvía y el nuevo no se
        // descontaba → sobreventa silenciosa) y el upsert directo
        // (el trigger de Fase 1 ya fuerza el precio del servicio).
        // ============================================================
        const { data: rpcData, error: rpcError } = await supabaseClient.rpc('reagendar_cita', {
            p_cita_id: citaId,
            p_tenant_id: window.currentTenantId,
            p_nueva_fecha: nuevaFecha,
            p_nueva_hora: nuevaHora
        });

        if (rpcError || !rpcData || rpcData.ok !== true) {
            mostrarToast((rpcData && rpcData.error) || (rpcError && rpcError.message) || 'Error al reprogramar la cita', 'error');
            if (btnConfirm) btnConfirm.disabled = false;
            return;
        }

        // Objeto para la notificación de cambio (flujo admin) — sin mutar cupos
        const nuevaCita = {
            ...citaOriginal,
            id: citaOriginal.id, // mantener mismo ID
            fecha: nuevaFecha,
            hora: nuevaHora,
            editado: true,
            fechaEdicion: new Date().toISOString(),
            notificaciones: { 
                emailEnviado: false, 
                whatsappEnviado: false 
            }
        };
        
        let esEdicionAdmin = window._modoEdicionAdmin === true;
        let citaOriginalAdmin = esEdicionAdmin ? window._citaEnEdicionAdmin : null;

        if (esEdicionAdmin && citaOriginalAdmin) {
            const notif = await crearNotificacionCambioAdmin(citaOriginalAdmin, nuevaCita);
            
            window._modoEdicionAdmin = false;
            window._citaEnEdicionAdmin = null;
            
            console.log('✅ Notificación de cambio admin creada:', notif);
        }
        
        if (typeof generarNotificaciones === 'function') generarNotificaciones();

        clearCartHTML();

        if(typeof renderCarrito === 'function') renderCarrito();
        if(typeof renderCartFromReservations === 'function') renderCartFromReservations();
        if(typeof renderMisReservas === 'function') renderMisReservas();
        if(typeof renderAdminAppointments === 'function') renderAdminAppointments();

        mostrarToast('Cita reprogramada con éxito', 'success');

        if(popup){
            popup.style.transition = 'opacity 0.3s';
            popup.style.opacity = '0';
            setTimeout(() => {
                popup.style.display = 'none';
                popup.style.opacity = '1';
                popup.style.transition = '';
            }, 300);
        }

        esReprogramacion = false;
        reprogramInfo = { citaId: null, serviceId: null, citaActual: null };
        idCitaEnEdicion = null;

    } catch(err){
        console.error('confirmarCambioFecha error', err);
        mostrarToast('Error al reprogramar la cita', 'error');

        const btnConfirm = document.getElementById('btn-confirmar-reserva');
        if(btnConfirm) btnConfirm.disabled = false;
    }
}
window.confirmarCambioFecha = confirmarCambioFecha;

// ============================================
// MODAL PARA EDITAR CONFIGURACIÓN VISUAL (SUPERADMIN)
// ============================================
let visualConfigModal = null;

function crearModalEditarVisualTenant() {
    if (visualConfigModal) return visualConfigModal;
    const modalHtml = `
        <div id="modal-editar-visual" class="modal" style="display:none;">
            <div class="modal-content glass-panel" style="max-width:500px;">
                <span class="modal-close">&times;</span>
                <h3>Editar configuración visual del tenant</h3>
                <div class="form-group">
                    <label>Color primario</label>
                    <input type="color" id="edit-vis-primary" class="form-control">
                </div>
                <div class="form-group">
                    <label>Color secundario</label>
                    <input type="color" id="edit-vis-secondary" class="form-control">
                </div>
                <div class="form-group">
                    <label>URL del logo</label>
                    <input type="text" id="edit-vis-logo" class="form-control" placeholder="https://...">
                </div>
                <div class="form-group">
                    <label>URL del favicon</label>
                    <input type="text" id="edit-vis-favicon" class="form-control" placeholder="https://...">
                </div>
                <div class="form-group">
                    <label>CSS personalizado</label>
                    <textarea id="edit-vis-css" rows="4" class="form-control" placeholder="/* Estilos adicionales */"></textarea>
                </div>
                <div class="form-actions" style="margin-top:20px;">
                    <button id="btn-guardar-visual" class="btn-grad">Guardar cambios</button>
                    <button id="btn-cancelar-visual" class="btn-secondary">Cancelar</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    visualConfigModal = document.getElementById('modal-editar-visual');
    const closeSpan = visualConfigModal.querySelector('.modal-close');
    const cancelBtn = document.getElementById('btn-cancelar-visual');
    closeSpan.onclick = () => visualConfigModal.style.display = 'none';
    cancelBtn.onclick = () => visualConfigModal.style.display = 'none';
    window.onclick = (e) => { if (e.target === visualConfigModal) visualConfigModal.style.display = 'none'; };
    return visualConfigModal;
}

async function abrirModalEditarVisualTenant(tenantId) {
    const modal = crearModalEditarVisualTenant();
    const config = await VisualConfigManager.loadConfigForTenant(tenantId);
    document.getElementById('edit-vis-primary').value = config.primary_color;
    document.getElementById('edit-vis-secondary').value = config.secondary_color;
    document.getElementById('edit-vis-logo').value = config.logo_url || '';
    document.getElementById('edit-vis-favicon').value = config.favicon_url || '';
    document.getElementById('edit-vis-css').value = config.custom_css || '';
    modal.style.display = 'flex';
    modal.dataset.currentTenant = tenantId;
    
    // Remover listener anterior para evitar duplicados
    const saveBtn = document.getElementById('btn-guardar-visual');
    const newSaveBtn = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
    newSaveBtn.onclick = async () => {
        const updatedConfig = {
            primary_color: document.getElementById('edit-vis-primary').value,
            secondary_color: document.getElementById('edit-vis-secondary').value,
            logo_url: document.getElementById('edit-vis-logo').value,
            favicon_url: document.getElementById('edit-vis-favicon').value,
            custom_css: document.getElementById('edit-vis-css').value
        };
        const success = await VisualConfigManager.saveConfigForTenant(tenantId, updatedConfig);
        if (success) {
            mostrarToast('Configuración visual guardada correctamente', 'success');
            modal.style.display = 'none';
            await cargarTenants(); // refrescar lista (opcional)
        } else {
            mostrarToast('Error al guardar la configuración', 'error');
        }
    };
}

// ============================================
// CARRITO (modificado para async)
// ============================================
async function renderCarrito() {
    try {
        console.log('=== renderCarrito iniciado ===');
        if (typeof sanearBaseDeDatos === 'function') sanearBaseDeDatos();
        if (typeof limpiarCitasVencidas === 'function') limpiarCitasVencidas();

        const cartItemsContainer = document.querySelector('.cart-items');
        if (!cartItemsContainer) {
            console.warn('No se encontró .cart-items');
            return;
        }

        cartItemsContainer.innerHTML = '';

        const session = await getSession();
        console.log('Sesión actual:', session);

        const userId = session?.id || null;
        const citas = await CitasManager.getAll();
        console.log('Total citas en storage:', citas.length);

        if (citas.length === 0) {
            cartItemsContainer.innerHTML = '<div style="padding:10px; text-align:center; color:#999;">No tienes reservas en el carrito</div>';
            return;
        }

        // Filtrar citas del cliente actual
        const citasUsuario = citas.filter(c => {
            // PRIORIDAD 1: Sesión local del cliente (formulario de registro)
            // Esto funciona incluso si el admin está logueado en Supabase probando el link
            if (window.__clienteSession && window.__clienteSession.email) {
                const emailCliente = window.__clienteSession.email.toLowerCase().trim();
                const cEmail = (c.contacto?.email || '').toLowerCase().trim();
                return cEmail === emailCliente;
            }
            // PRIORIDAD 2: Sesión Supabase (admin normal o cliente con Auth)
            if (session) {
                if (userId && c.contacto?.userId) {
                    return String(c.contacto.userId) === String(userId);
                }
                if (session.nombre && c.contacto?.nombre) {
                    return String(c.contacto.nombre).trim().toLowerCase() === String(session.nombre).trim().toLowerCase();
                }
            }
            // Sin ninguna sesión: no mostrar nada
            return false;
        });

        console.log('Citas del usuario encontradas:', citasUsuario.length);

        if (citasUsuario.length === 0) {
            cartItemsContainer.innerHTML = '<div style="padding:10px; text-align:center; color:#999;">No tienes reservas en el carrito</div>';
            return;
        }

        const ahora = new Date();
        let htmlAcumulado = '';

        citasUsuario.forEach(cita => {
            const servicioNombre = escapeHtml(cita.nombre || 'Servicio');
            const fecha = escapeHtml(formatFechaConDiaSemana(cita.fecha || '—'));
            const hora = escapeHtml(limpiarHora(cita.hora || '—'));
            const precio = formatearPeso(cita.precio || 0);
            
            const estadoUrgencia = UrgenciaManager.calcularEstado(cita.fecha, cita.hora);
            const urgenciaClass = (estadoUrgencia === 'urgent-soon' || estadoUrgencia === 'urgent-now') ? estadoUrgencia : '';
            
            if (estadoUrgencia === 'expirado') {
                return;
            }

            let puedeReagendar = false;
            let bloqueadoMsg = 'Cambio bloqueado';
            let tituloBoton = '';

            try {
                let citaDate;
                const partes = String(cita.fecha).split('-');
                if (partes.length === 3) {
                    citaDate = new Date(partes[0], partes[1] - 1, partes[2]);
                } else {
                    citaDate = new Date(cita.fecha);
                }

                if (cita.hora) {
                    const horaParts = String(cita.hora).match(/(\d{1,2}):(\d{2})/);
                    if (horaParts) {
                        citaDate.setHours(parseInt(horaParts[1]), parseInt(horaParts[2]), 0, 0);
                    }
                }

                if (isNaN(citaDate.getTime())) {
                    throw new Error('Fecha inválida');
                }

                const diferenciaMs = citaDate - ahora;

                if (diferenciaMs < 0) {
                    puedeReagendar = false;
                    bloqueadoMsg = 'Cita Expirada';
                    tituloBoton = 'Esta cita ya ha pasado';
                } else if (diferenciaMs < 24 * 60 * 60 * 1000) {
                    puedeReagendar = false;
                    bloqueadoMsg = 'Cambio no disponible (menos de 24h)';
                    tituloBoton = 'Solo se permite cambiar con 24h de antelación';
                } else {
                    puedeReagendar = true;
                    bloqueadoMsg = 'Reagendar';
                    tituloBoton = 'Cambiar fecha y hora de esta cita';
                }
            } catch (e) {
                console.warn('Error calculando diferencia:', e, cita);
                puedeReagendar = false;
                bloqueadoMsg = 'Error en fecha';
                tituloBoton = 'No se pudo calcular la disponibilidad';
            }

            let botonHTML = '';
            if (puedeReagendar) {
                const citaJson = JSON.stringify(cita).replace(/"/g, '&quot;');
                botonHTML = `<button class="btn-small btn-reagendar" 
                    data-cita-id="${cita.id}" 
                    data-servicio-id="${cita.servicioId}" 
                    data-cita='${citaJson}'
                    title="${tituloBoton}">
                    <i class="fas fa-calendar-alt"></i> Reagendar
                </button>`;
            } else {
                botonHTML = `<button class="btn-small" disabled 
                    style="opacity:0.5; cursor:not-allowed; background:#bdc3c7;" 
                    title="${tituloBoton || bloqueadoMsg}">
                    <i class="fas fa-lock"></i> ${bloqueadoMsg}
                </button>`;
            }

            const itemClass = puedeReagendar ? `cart-item ${urgenciaClass}` : `cart-item locked ${urgenciaClass}`;

            htmlAcumulado += `
                <div class="${itemClass}" data-urgencia="${estadoUrgencia}">
                    <div class="cart-item-details">
                        <strong>${servicioNombre}</strong>
                        <br><small class="cart-item-date">${fecha} - ${hora}</small>
                        <br><small class="cart-item-price">${precio}</small>
                        <br style="margin:8px 0;">
                        <div style="margin-top:8px;">
                            ${botonHTML}
                        </div>
                    </div>
                </div>
            `;
        });

        cartItemsContainer.innerHTML = htmlAcumulado;

        const totalElement = document.querySelector('.cart-total strong');
        if (totalElement) {
            const totalPrecio = citasUsuario.reduce((sum, c) => sum + (Number(c.precio) || 0), 0);
            totalElement.textContent = formatearPeso(totalPrecio);
        }

        cartItemsContainer.querySelectorAll('.btn-reagendar').forEach(btn => {
            btn.addEventListener('click', function () {
                const citaId = this.getAttribute('data-cita-id');
                const servicioId = this.getAttribute('data-servicio-id');
                const citaJson = this.getAttribute('data-cita');
                try {
                    const citaActual = JSON.parse(citaJson);
                    abrirModalCambioFecha(citaId, servicioId, citaActual);
                } catch (err) {
                    console.error('Error al parsear cita:', err);
                    mostrarToast('Error al abrir formulario de reprogramación', 'error');
                }
            });
        });

        console.log('=== renderCarrito finalizado ===');
    } catch (err) {
        console.error('Error en renderCarrito():', err);
        mostrarToast('Error al mostrar el carrito', 'error');
    }
}
window.renderCarrito = renderCarrito;

// ============================================
// OTRAS FUNCIONES (cancelar, cerrar sesión, etc.)
// ============================================
function clearCartHTML() {
    const container = document.querySelector('.cart-items');
    if (container) container.innerHTML = '';
}
window.clearCartHTML = clearCartHTML;

async function cancelarCita(citaId) {
    try {
        const citasRaw = await CitasManager.getAll();
        const idx = citasRaw.findIndex(c => c && String(c.id) === String(citaId));
        if (idx === -1) { mostrarToast('Cita no encontrada', 'error'); return; }
        const cita = citasRaw[idx];

        try {
            const servicios = await ServiciosManager.getAll();
            const sIdx = servicios.findIndex(s => s && String(s.id) === String(cita.servicioId));
            if (sIdx !== -1) {
                const servicio = servicios[sIdx];
                const fecha = cita.fecha;
                if (servicio.disponibilidad && servicio.disponibilidad[fecha]) {
                    let modIndex = (typeof cita.moduloIndex !== 'undefined' && cita.moduloIndex !== null) ? Number(cita.moduloIndex) : -1;
                    if (modIndex >= 0 && servicio.disponibilidad[fecha][modIndex]) {
                        servicio.disponibilidad[fecha][modIndex].cupos = (Number(servicio.disponibilidad[fecha][modIndex].cupos || 0) + 1);
                    } else {
                        const targetHora = String(cita.hora || '').trim();
                        for (let mi = 0; mi < servicio.disponibilidad[fecha].length; mi++) {
                            const m = servicio.disponibilidad[fecha][mi];
                            const horaText = formatTimeDisplay(m.hora || m.startTime || '00:00');
                            if (horaText === targetHora) {
                                servicio.disponibilidad[fecha][mi].cupos = (Number(m.cupos || 0) + 1);
                                break;
                            }
                        }
                    }
                }
                servicios[sIdx] = servicio;
                await ServiciosManager.save(servicio);
            }
        } catch (e) { console.warn('No se pudo devolver cupo al servicio', e); }

        await CitasManager.delete(citaId);
        
        if (typeof generarNotificaciones === 'function') generarNotificaciones();
        
        mostrarToast('Cita cancelada correctamente', 'success');
        if (typeof renderMisReservas === 'function') renderMisReservas();
        if (typeof cargarServiciosParaCliente === 'function') cargarServiciosParaCliente();
        if (typeof aplicarFiltrosCombinados === 'function') aplicarFiltrosCombinados();
        if (typeof updateProjectedRevenue === 'function') updateProjectedRevenue();
        if (typeof renderCarrito === 'function') renderCarrito();
    } catch (err) {
        console.error('cancelarCita error', err);
        mostrarToast('Error al cancelar la cita', 'error');
    }
}
window.cancelarCita = cancelarCita;

async function cerrarSesion() {
    // 1. Limpiar JWT de localStorage inmediatamente
    if (window.JwtManager) {
        window.JwtManager.clear();
    }
    // 2. Limpiar claves de sesion de Supabase SDK (sb-*-auth-token)
    //    como fallback por si signOut() falla (CSP bloquea o cliente no listo)
    try {
        var _keysToRemove = [];
        for (var _i = 0; _i < localStorage.length; _i++) {
            var _key = localStorage.key(_i);
            if (_key && _key.indexOf('sb-') === 0 && _key.indexOf('-auth-token') > 0) {
                _keysToRemove.push(_key);
            }
        }
        _keysToRemove.forEach(function(k) { localStorage.removeItem(k); });
    } catch (_e) { /* silencioso */ }
    // 3. Limpiar sesion en Supabase (usar cualquier cliente disponible)
    try {
        var client = supabaseClient || window.supabaseClient;
        if (client && client.auth) {
            await client.auth.signOut();
        }
    } catch (e) { }
    window.location.href = 'login.html';
}
window.cerrarSesion = cerrarSesion;

// ============================================
// INICIALIZACIÓN DEL SISTEMA DE URGENCIAS
// ============================================

function iniciarSistemaUrgencias() {
    UrgenciaManager.limpiarServiciosExpirados();
    
    setInterval(async () => {
        const eliminados = await UrgenciaManager.limpiarServiciosExpirados();
        
        if (eliminados > 0) {
            if (typeof cargarServiciosExistentes === 'function') {
                cargarServiciosExistentes();
            }
            if (typeof cargarServiciosParaCliente === 'function') {
                cargarServiciosParaCliente();
            }
            if (typeof renderAdminAppointments === 'function') {
                renderAdminAppointments();
            }
            if (typeof renderCarrito === 'function') {
                renderCarrito();
            }
        }
    }, 5 * 60 * 1000);
}

// ============================================
// INICIALIZACIÓN PRINCIPAL
// ============================================

// ============================================
// ADMIN SPA FUNCTIONS - Movidas desde admin.html inline script
// para evitar bloqueo CSP (los scripts inline no tienen hash en CSP).
// Estas funciones DEBEN estar en el scope del IIFE para que el
// CSP bridge (en _initCSPEventBridge) las detecte via typeof.
// ============================================
// Declarar variables locales para CSP bridge
// IMPORTANTE: los nombres DEBEN coincidir con los usados en onclick="funcion()" en admin.html
// para que el CSP bridge (en _initCSPEventBridge) las registre via typeof + reg()
var cerrarPopupReserva, toggleSidebar, closeSidebar, navigateTo,
    toggleNotifPopover, closeNotifPopover, filtrarNotifPopover, actualizarBadgeNotif;

(function() {
    if (typeof document === 'undefined') return;
    if (!document.querySelector('.admin-screen')) return;
    if (document.querySelector('.superadmin-screen')) return;

    cerrarPopupReserva = window.cerrarPopupReserva = function() {
        var el = document.getElementById('popup-reserva');
        if (el) el.style.display = 'none';
    };

    toggleSidebar = window.toggleSidebar = function() {
        var s = document.getElementById('sidebar');
        var o = document.getElementById('sidebar-overlay');
        if (s) s.classList.toggle('open');
        if (o) o.classList.toggle('show');
    };

    closeSidebar = window.closeSidebar = function() {
        var s = document.getElementById('sidebar');
        var o = document.getElementById('sidebar-overlay');
        if (s) s.classList.remove('open');
        if (o) o.classList.remove('show');
    };

    navigateTo = window.navigateTo = function(sectionId) {
        document.querySelectorAll('.section-content').forEach(function(el) {
            el.style.display = 'none';
        });
        var target = document.getElementById('section-' + sectionId);
        if (target) target.style.display = 'block';
        document.querySelectorAll('.sidebar-item').forEach(function(item) {
            item.classList.remove('active');
            if (item.dataset.section === sectionId) item.classList.add('active');
        });
        if (typeof window.closeSidebar === 'function') window.closeSidebar();
        var main = document.getElementById('dynamic-content');
        if (main) main.scrollIntoView({ behavior: 'smooth', block: 'start' });

        setTimeout(function() {
            switch (sectionId) {
                case 'mis-servicios':
                    if (typeof cargarServiciosExistentes === 'function') cargarServiciosExistentes();
                    break;
                case 'citas':
                    if (typeof renderAdminAppointments === 'function') renderAdminAppointments();
                    break;
                case 'clientes':
                    if (typeof renderClientListView === 'function') renderClientListView();
                    break;
                case 'dashboard':
                    if (typeof actualizarDashboardFinanzas === 'function') actualizarDashboardFinanzas();
                    break;
                case 'personalizar':
                    if (typeof VisualConfigManager !== 'undefined') {
                        VisualConfigManager.loadConfig().then(function(cfg) {
                            VisualConfigManager.applyConfigToForm(cfg);
                            VisualConfigManager.applyStyles(cfg);
                        });
                    }
                    break;
                case 'compartir':
                    if (typeof configurarCompartirEnlace === 'function') configurarCompartirEnlace();
                    if (window.__initWorkerShare) window.__initWorkerShare();
                    break;
                case 'compartir-trabajadores':
                    if (window.__initWorkerShare) window.__initWorkerShare();
                    break;
                case 'equipo':
                    if (window.__initWorkersList) window.__initWorkersList();
                    break;
                case 'horarios':
                    if (window.__initWorkerSchedule) window.__initWorkerSchedule();
                    break;
                case 'suscripcion':
                    if (typeof cargarSuscripcionTenant === 'function') cargarSuscripcionTenant();
                    break;
            }
        }, 100);
    };

    toggleNotifPopover = window.toggleNotifPopover = function(event) {
        if (event) event.stopPropagation();
        var popover = document.getElementById('notif-popover');
        if (!popover) return;
        if (popover.style.display === 'none' || popover.style.display === '') {
            if (typeof generarNotificaciones === 'function') generarNotificaciones();
            // IMPORTANTE: display flex (no block) para que la lista interna
            // (flex:1 + overflow-y:auto) se encoja y permita deslizar/scroll.
            forzarScrollNotifPopover();
            popover.style.display = 'flex';
            if (typeof window.actualizarBadgeNotif === 'function') window.actualizarBadgeNotif();
        } else {
            popover.style.display = 'none';
        }
    };

    // Fuerza el layout de scroll del popover con estilos inline (ganan a
    // cualquier CSS cacheado): popover flex-col con alto máximo y lista
    // interna con overflow-y auto. Así el scroll funciona aunque el navegador
    // tenga una style.css vieja en caché del service worker.
    function forzarScrollNotifPopover() {
        var popover = document.getElementById('notif-popover');
        var list = document.getElementById('notif-popover-list');
        if (popover) {
            popover.style.maxHeight = 'min(60vh, 420px)';
            popover.style.overflow = 'hidden';
            popover.style.flexDirection = 'column';
        }
        if (list) {
            list.style.flex = '1 1 0%';
            list.style.minHeight = '0';
            list.style.overflowY = 'auto';
            list.style.WebkitOverflowScrolling = 'touch';
        }
    }
    window.forzarScrollNotifPopover = forzarScrollNotifPopover;

    closeNotifPopover = window.closeNotifPopover = function() {
        var el = document.getElementById('notif-popover');
        if (el) el.style.display = 'none';
    };

    filtrarNotifPopover = window.filtrarNotifPopover = function(btn, tipo) {
        document.querySelectorAll('.notif-popover-tabs .tab-btn').forEach(function(t) {
            t.classList.remove('active');
            t.style.color = '#aaa';
            t.style.borderBottom = 'none';
        });
        btn.classList.add('active');
        btn.style.color = '#fff';
        btn.style.borderBottom = '3px solid #b300ff';
        var list = document.getElementById('notif-popover-list');
        if (!list) return;
        list.querySelectorAll('.notification-item').forEach(function(item) {
            if (tipo === 'todas' || item.dataset.origen === tipo) {
                item.style.display = 'flex';
            } else {
                item.style.display = 'none';
            }
        });
    };

    actualizarBadgeNotif = window.actualizarBadgeNotif = function() {
        var badge = document.getElementById('notif-badge-count');
        if (!badge) return;
        var list = document.getElementById('notif-popover-list');
        if (!list) return;
        var cambios = list.querySelectorAll('.notification-item[data-origen="cambio"]').length;
        var total = list.querySelectorAll('.notification-item').length;
        var count = cambios || total;
        if (count > 0) {
            badge.textContent = count;
            badge.style.display = 'flex';
        } else {
            badge.style.display = 'none';
        }
    };

    // Cerrar popover al hacer clic fuera
    document.addEventListener('click', function _adminClick(event) {
        var popover = document.getElementById('notif-popover');
        var bellBtn = document.getElementById('notif-bell-btn');
        if (popover && popover.style.display === 'block') {
            if (!popover.contains(event.target) && bellBtn && !bellBtn.contains(event.target)) {
                popover.style.display = 'none';
            }
        }
    });

    // MutationObserver para sincronizar notificaciones
    if (typeof MutationObserver !== 'undefined') {
        (function() {
            var src = document.getElementById('notifications-list');
            if (!src) return;
            var obs = new MutationObserver(function() {
                var tgt = document.getElementById('notif-popover-list');
                if (!tgt) return;
                var items = src.querySelectorAll('.notification-item');
                if (items.length > 0) {
                    tgt.innerHTML = '';
                    items.forEach(function(it) { tgt.appendChild(it.cloneNode(true)); });
                    if (typeof window.actualizarBadgeNotif === 'function') window.actualizarBadgeNotif();
                }
            });
            obs.observe(src, { childList: true, subtree: true });
        })();
    }

    // Inicializar admin UI: mostrar dashboard por defecto
    var _init = function() {
        if (typeof window.navigateTo === 'function') window.navigateTo('dashboard');
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _init);
    } else {
        _init();
    }
})();

document.addEventListener('DOMContentLoaded', async function () {
    // CSP Event Bridge: convertir onclick/onchange/onsubmit inline a addEventListener
    // (evita que CSP los bloquee sin necesidad de 'unsafe-inline')
    _initCSPEventBridge();

    // Tarjetas de estadísticas del header → navegación a secciones
    vincularNavegacionStatsHeader();

    // Esperar a que supabaseClient esté disponible (espera hasta 2s)
    const supabaseListo = await initSupabase();
    if (!supabaseListo) {
        console.error('[DOMContentLoaded] supabaseClient no disponible, abortando');
        return;
    }

    await CitasManager.limpiar({ soloSinId: true, soloCompletadas: true, soloInvalidas: true });
    await CitasManager.sanear();
    
    configurarLimpiezaAutomatica();
    
    if (typeof iniciarSistemaUrgencias === 'function') {
        iniciarSistemaUrgencias();
    }
    
    if (typeof NotificacionesAdminManager !== 'undefined') {
        // Solo limpiar notificaciones viejas si hay sesión activa (evita error 42501 de anon)
        try {
            const accessToken = localStorage.getItem('agendapro_access_token');
            if (accessToken) {
                await NotificacionesAdminManager.eliminarViejos(7);
            }
        } catch (_e) {
            // Silencioso — no crítico
        }
    }

    await verificarProteccionRutas();
    popupEl = document.getElementById('popup-reserva');

        // ========== NUEVA LÓGICA: diferenciar superadmin / admin / cliente / planes ==========
    const esSuperAdmin = document.querySelector('.superadmin-screen');
    const esAdminNormal = document.querySelector('.admin-screen') && !esSuperAdmin;
    const esCliente = document.querySelector('.client-screen');
    const esPlanes = document.getElementById('planes-container'); // <-- NUEVO

    if (esSuperAdmin) {
        // Inicializar superadmin desde legacy.js (antes se hacia desde inline script en superadmin.html
        // que quedaba bloqueado por CSP). Ahora corre directamente desde el bundle legacy.js.
        if (typeof window.iniciarSuperAdmin === 'function') {
            await window.iniciarSuperAdmin();
        } else {
            console.error('[DOMContentLoaded] window.iniciarSuperAdmin no definida');
        }
    } else if (esAdminNormal) {
        await iniciarAdmin();
        if (!window._subscriptionExpired && typeof cargarServiciosExistentes === 'function') cargarServiciosExistentes();
        // Dashboard financiero: inicializar fechas, cargar datos y conectar botones
        // (antes esto vivía en un override de window.iniciarAdmin que nunca se ejecutaba)
        if (!window._subscriptionExpired) {
            inicializarFeedbackWidget();
            inicializarFechasDashboard();
            await actualizarDashboardFinanzas();
            configurarDashboardEventos();
        }
    } else if (esCliente) {
        await iniciarCliente();
        // Solo renderizar si NO es link compartido (el callback del formulario lo hará)
        if (!window.__skipClientRender) {
            if (typeof renderMisReservas === 'function') renderMisReservas();
            if (typeof renderCarrito === 'function') renderCarrito();
        }
    } else if (esPlanes) {
        // Página de planes
        await cargarPlanes();
    } else {
        iniciarLogin();
    }

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-reservar');
        if (btn) {
            const serviceId = Number(btn.dataset.serviceId);
            if (!isNaN(serviceId)) abrirModalReserva(serviceId);
        }
    });
});

// ============================================
// FUNCION DE LOGIN / REGISTRO (versión modernizada)
// ============================================
function iniciarLogin() {
    console.log('Iniciando login moderno...');

    // Elementos del DOM
    const loginContainer = document.getElementById('login-container');
    const registerContainer = document.getElementById('register-container');
    const loginModeBtn = document.getElementById('login-mode');
    const registerModeBtn = document.getElementById('register-mode');
    const backToLogin = document.getElementById('back-to-login');
    const loginForm = document.getElementById('login-form-modern');
    const registerForm = document.getElementById('register-form-modern');
    const loginErrorDiv = document.getElementById('login-error-message');
    const registerErrorDiv = document.getElementById('register-error-message');
    const googleBtn = document.getElementById('google-login-btn');
    const forgotLink = document.getElementById('forgot-password-link');

    // Mostrar formulario de login
    function showLogin() {
        if (loginContainer) loginContainer.style.display = 'block';
        if (registerContainer) registerContainer.style.display = 'none';
        if (loginModeBtn) loginModeBtn.classList.add('active');
        if (registerModeBtn) registerModeBtn.classList.remove('active');
        // Limpiar mensajes
        if (loginErrorDiv) loginErrorDiv.style.display = 'none';
        if (registerErrorDiv) registerErrorDiv.style.display = 'none';
    }

    // Mostrar formulario de registro
    function showRegister() {
        if (loginContainer) loginContainer.style.display = 'none';
        if (registerContainer) registerContainer.style.display = 'block';
        if (loginModeBtn) loginModeBtn.classList.remove('active');
        if (registerModeBtn) registerModeBtn.classList.add('active');
        // Limpiar mensajes
        if (loginErrorDiv) loginErrorDiv.style.display = 'none';
        if (registerErrorDiv) registerErrorDiv.style.display = 'none';
    }

    // Eventos toggle
    if (loginModeBtn) loginModeBtn.addEventListener('click', (e) => { e.preventDefault(); showLogin(); });
    if (registerModeBtn) registerModeBtn.addEventListener('click', (e) => { e.preventDefault(); showRegister(); });
    if (backToLogin) backToLogin.addEventListener('click', (e) => { e.preventDefault(); showLogin(); });

    // ====================================================================
    // [BLOQUE DESACTIVADO] LOGIN con email/password
    // Manejo delegado a src/auth/ui/LoginPage.js (modulo moderno)
    // LoginPage.js es el unico handler de submit del formulario de login.
    // ====================================================================
    // Codigo original comentado en el commit 05ab538 si se necesita restaurar.
    // if (loginForm) {
    //     loginForm.addEventListener('submit', async (e) => { ... });
    // }
    console.log('[script.js] Login handler delegado a LoginPage.js');

    // ====================================================================
    // [BLOQUE DESACTIVADO] REGISTRO con creacion de tenant
    // Manejo delegado a src/auth/ui/LoginPage.js (modulo moderno)
    // LoginPage.js ejecuta el orden SECUENCIAL: signUp → createTenant → updateUser
    // ====================================================================
    // if (registerForm) {
    //     registerForm.addEventListener('submit', async (e) => { ... });
    // }
    console.log('[script.js] Register handler delegado a LoginPage.js');

    // ====================================================================
    // [BLOQUE DESACTIVADO] Botón de Google (signInWithOAuth)
    // Manejo delegado a src/auth/ui/LoginPage.js (modulo moderno)
    // LoginPage.js redirige a /admin.html de forma consistente.
    // ====================================================================
    // if (googleBtn) {
    //     googleBtn.addEventListener('click', async () => { ... });
    // }
    console.log('[script.js] Google OAuth handler delegado a LoginPage.js');

    // ====================================================================
    // [BLOQUE DESACTIVADO] Recuperación de contraseña
    // Manejo delegado a src/auth/ui/LoginPage.js (modulo moderno)
    // ====================================================================
    // if (forgotLink) { ... }
    // if (resetModal) { ... }
    console.log('[script.js] Password recovery delegado a LoginPage.js');

    // Asegurar que empiece en Login
    showLogin();
}
window.iniciarLogin = iniciarLogin;
// ============================================
// FUNCIÓN DE DIAGNÓSTICO
// ============================================
async function diagnosticarSistema() {
    console.log('🔍 DIAGNÓSTICO DEL SISTEMA');
    console.log('==========================');
    
    try {
        // 1. Verificar sesión
        const session = await getSession();
        console.log('📌 Sesión actual:', session);
        
        if (!session) {
            console.log('❌ No hay sesión activa');
            return;
        }
        
        // 2. Verificar tenant en BD
        const cleanTenantId = String(session.tenant_id).trim();
        console.log('🏢 Buscando tenant:', cleanTenantId);
        
        const { data: tenant, error: tenantError } = await supabaseClient
            .from('tenants')
            .select('*')
            .eq('id', cleanTenantId)
            .maybeSingle();
            
        if (tenantError) {
            console.error('❌ Error verificando tenant:', tenantError);
        } else if (tenant) {
            console.log('✅ Tenant encontrado:', tenant);
        } else {
            console.log('❌ Tenant NO encontrado en BD');
        }
        
        // 3. Verificar servicios
        const servicios = await ServiciosManager.getAll();
        console.log(`📦 Servicios encontrados: ${servicios.length}`);
        
        // 4. Verificar citas
        const citas = await CitasManager.getAll();
        console.log(`📅 Citas encontradas: ${citas.length}`);
        
        console.log('✅ Diagnóstico completado');
        
    } catch (e) {
        console.error('Error en diagnóstico:', e);
    }
}

// Exponer globalmente
window.diagnosticarSistema = diagnosticarSistema;



// ========== EXTENSIÓN SUPER ADMIN (TABS, ESTADÍSTICAS GLOBALES, SERVICIOS Y CITAS) ==========
// Estas funciones complementan las existentes (iniciarSuperAdmin, cargarTenants, etc.)
// No duplican nombres, solo añaden nuevas capacidades.

// --- Variables globales adicionales ---
let currentSuperTab = 'tenants';

// --- Función auxiliar: esperar a que las APIs globales estén disponibles ---
function esperarApisGlobales(timeout = 3000) {
    return new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
            if (window.__tenantsApi && window.__subscriptionsApi) {
                console.log('[esperarApisGlobales] APIs listas');
                resolve(true);
                return;
            }
            if (Date.now() - start >= timeout) {
                console.warn('[esperarApisGlobales] Timeout esperando APIs');
                resolve(false);
                return;
            }
            setTimeout(check, 100);
        };
        check();
    });
}

// --- Inicializar SuperAdmin: SIEMPRE poblar el DOM visible ---
window.iniciarSuperAdmin = async function() {
    // NOTA: Aunque los módulos ES estén cargados, el DOM visible de superadmin.html
    // (stats, tenant cards, tabs, chart) NO se puebla automáticamente.
    // SuperAdminView.js renderiza dentro de #superadmin-content (display:none),
    // por lo que debemos ejecutar el fallback SIEMPRE para llenar los elementos visibles.
    if (window.__tenantsApi && window.__subscriptionsApi) {
        console.log('[SuperAdmin] Modulos ES cargados, ejecutando fallback visible igualmente');
    }
    
    // Configurar eventos del modal ANTES de poblar datos
    configurarModalTenant();
    
    // Poblar el DOM visible con datos
    await cargarTenants();
    await cargarEstadisticasGlobales();
    await cargarMetricasGlobales();
    // Tab de Sugerencias/Feedback de tenants (inyectado por JS, sin tocar HTML)
    // Cada inyección va en try/catch: si una falla no debe bloquear las demás
    // (antes un error en feedback impedía que pagos/directorio/tabs se montaran).
    try { inyectarTabFeedback(); } catch (e) { console.warn('[SuperAdmin] fallo inyectarTabFeedback:', e); }
    // Tab de Pagos Mercado Pago (inyectado por JS, sin tocar HTML)
    try { inyectarTabPagos(); } catch (e) { console.warn('[SuperAdmin] fallo inyectarTabPagos:', e); }
    // Tab de Directorio Público de PYMEs (inyectado por JS, sin tocar HTML)
    try { inyectarTabDirectorio(); } catch (e) { console.warn('[SuperAdmin] fallo inyectarTabDirectorio:', e); }
    try { setupSuperAdminTabs(); } catch (e) { console.warn('[SuperAdmin] fallo setupSuperAdminTabs:', e); }
};

// --- Configuración de Tabs (fallback si modulos no cargan) ---
function setupSuperAdminTabs() {
    const tabs = document.querySelectorAll('.tab-btn');
    const contents = document.querySelectorAll('.tab-content');
    
    tabs.forEach(tab => {
        tab.addEventListener('click', async () => {
            const targetId = tab.dataset.tab;
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            contents.forEach(c => c.style.display = 'none');
            const el = document.getElementById(`tab-${targetId}`);
            if (el) {
                el.style.display = 'block';
                // Cargar contenido del tab al hacer clic (lazy-load)
                try {
                    if (targetId === 'usuarios') await cargarUsuariosSuper();
                    else if (targetId === 'servicios') await cargarServiciosGlobales();
                    else if (targetId === 'citas') await cargarCitasGlobales();
                    else if (targetId === 'feedback') await cargarFeedbackSuper();
                    else if (targetId === 'pagos') await cargarPagosSuper();
                    else if (targetId === 'directorio') await cargarDirectorioSuper();
                    else if (targetId === 'tenants') await cargarTenants();
                } catch(e) {
                    console.warn(`Error cargando tab ${targetId}:`, e);
                }
            }
        });
    });

    // === Botones "Refrescar" de los tabs estáticos (superadmin.html) ===
    // Antes no tenían listener: el botón no hacía nada. Se bindean aquí.
    const bindRefresh = (id, fn) => {
        const btn = document.getElementById(id);
        if (btn && typeof fn === 'function') btn.addEventListener('click', fn);
    };
    bindRefresh('btn-refresh-users', cargarUsuariosSuper);
    bindRefresh('btn-refresh-servicios', cargarServiciosGlobales);
    bindRefresh('btn-refresh-citas', cargarCitasGlobales);

    // === Botón "Refrescar" en el tab Tenants (inyectado por JS, sin tocar HTML) ===
    // Permite recargar la actividad (citas 7d, último acceso) sin recargar la página.
    const tenantsHeader = document.querySelector('#tab-tenants .panel-header');
    if (tenantsHeader && !document.getElementById('btn-refresh-tenants')) {
        const btn = document.createElement('button');
        btn.className = 'btn-grad';
        btn.id = 'btn-refresh-tenants';
        btn.type = 'button';
        btn.innerHTML = '<i class="fas fa-sync"></i> Refrescar';
        btn.addEventListener('click', () => cargarTenants());
        tenantsHeader.appendChild(btn);
    }
}

// --- Estadísticas globales (fallback completo con supabaseClient directo) ---
async function cargarEstadisticasGlobales() {
    if (!supabaseClient) return;
    try {
        // Tenants (solo los que cumplen la regla: suscripción vigente trial/plan)
        const { data: tenantsVisibles, error: errTenants } = await supabaseClient
            .from('tenants')
            .select('id, subscriptions!inner(plan, status)')
            .in('subscriptions.plan', ['free_trial', 'pro', 'premium_anual', 'freemium'])
            .in('subscriptions.status', ['active', 'trial']);
        const elTenants = document.getElementById('total-tenants');
        if (elTenants) elTenants.innerText = errTenants ? 0 : (tenantsVisibles || []).length;
        
        // Servicios globales (sin tenantId = super admin)
        const { count: serviciosCount } = await supabaseClient.from('servicios').select('*', { count: 'exact', head: true });
        const elServicios = document.getElementById('total-servicios');
        if (elServicios) elServicios.innerText = serviciosCount || 0;
        
        // Citas globales
        const { count: citasCount } = await supabaseClient.from('citas').select('*', { count: 'exact', head: true });
        const elCitas = document.getElementById('total-citas');
        if (elCitas) elCitas.innerText = citasCount || 0;
        
        // Usuarios via RPC superadmin (vista usuarios_con_rol bloqueada por seguridad)
        try {
            const { data: usersData } = await supabaseClient.rpc('get_all_users_for_superadmin');
            const usersCount = (usersData || []).length;
            const elUsuarios = document.getElementById('total-usuarios');
            if (elUsuarios) elUsuarios.innerText = usersCount || 0;
        } catch (e) {
            // vista puede no existir
        }
        
        // Suscripciones activas
        const { data: subs } = await supabaseClient.from('subscriptions').select('plan, status');
        const activeSubs = (subs || []).filter(s => s.status === 'active');
        const elSubs = document.getElementById('total-subscripciones');
        if (elSubs) elSubs.innerText = activeSubs.length;
        
    } catch (e) {
        console.error('Error en estadísticas globales:', e);
    }
}

// --- Métricas Globales (MRR + Gráfico) con Chart.js ---
async function cargarMetricasGlobales() {
    if (!supabaseClient) return;
    try {
        // 1. Ingresos por suscripciones activas (precios reales de planesData)
        const { data: subs } = await supabaseClient.from('subscriptions').select('plan, status');
        const activeSubs = (subs || []).filter(s => s.status === 'active');
        let ingresos = 0;
        let totalPro = 0, totalPremiumAnual = 0, totalFreemium = 0, totalTrial = 0;
        activeSubs.forEach(sub => {
            if (sub.plan === 'pro') { ingresos += 15000; totalPro++; }
            else if (sub.plan === 'premium_anual') { ingresos += 140000; totalPremiumAnual++; }
            else if (sub.plan === 'freemium') { totalFreemium++; }
            else if (sub.plan === 'free_trial') { totalTrial++; }
        });
        const mrrEl = document.getElementById('mrr-value');
        if (mrrEl) mrrEl.textContent = '$' + ingresos.toLocaleString();
        const planEl = document.getElementById('plan-breakdown');
        if (planEl) planEl.innerHTML = `Pro: ${totalPro} (x $15.000/mes) | Premium: ${totalPremiumAnual} (x $140.000/año) | Free Trial: ${totalTrial} | Freemium: ${totalFreemium}`;

        // 2. Evolución tenants (mensual)
        const { data: tenants } = await supabaseClient.from('tenants').select('fecha_registro');
        if (!tenants || tenants.length === 0) {
            const chartContainer = document.querySelector('.chart-container');
            if (chartContainer) {
                const existingMsg = chartContainer.querySelector('.chart-empty-msg');
                if (!existingMsg) {
                    const msg = document.createElement('p');
                    msg.className = 'chart-empty-msg';
                    msg.style.cssText = 'color: var(--text-muted); text-align: center; padding: 20px;';
                    msg.textContent = 'No hay tenants registrados para mostrar evolución';
                    chartContainer.appendChild(msg);
                }
            }
            return;
        }

        const map = new Map();
        tenants.forEach(t => {
            const date = new Date(t.fecha_registro);
            const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
            map.set(key, (map.get(key) || 0) + 1);
        });
        const sortedKeys = Array.from(map.keys()).sort();
        const counts = sortedKeys.map(k => map.get(k));

        const canvas = document.getElementById('tenants-evolution-chart');
        if (!canvas) return;
        if (window.tenantsChart) {
            window.tenantsChart.destroy();
            window.tenantsChart = null;
        }
        
        // Chart.js responsive maneja las dimensiones automáticamente
        canvas.style.display = 'block';
        canvas.style.width = '100%';
        canvas.style.height = '300px';

        // Verificar que Chart.js esté cargado
        if (typeof Chart === 'undefined') {
            console.error('[cargarMetricasGlobales] Chart.js no está cargado');
            const chartContainer = canvas.parentElement;
            if (chartContainer) {
                const existingMsg = chartContainer.querySelector('.chart-empty-msg');
                if (!existingMsg) {
                    const msg = document.createElement('p');
                    msg.className = 'chart-empty-msg';
                    msg.style.cssText = 'color: var(--danger); text-align: center; padding: 20px;';
                    msg.textContent = 'Error: Chart.js no se pudo cargar. Verifica tu conexión.';
                    chartContainer.appendChild(msg);
                }
            }
            return;
        }

        const ctx = canvas.getContext('2d');
        if (window.tenantsChart) {
            window.tenantsChart.destroy();
        }
        window.tenantsChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: sortedKeys,
                datasets: [{
                    label: 'Tenants registrados',
                    data: counts,
                    backgroundColor: 'rgba(179,0,255,0.7)',
                    borderColor: '#b300ff',
                    borderWidth: 1,
                    borderRadius: 4,
                    barPercentage: 0.6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function(ctx) {
                                return ctx.parsed.y + ' tenant' + (ctx.parsed.y !== 1 ? 's' : '');
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            precision: 0,
                            stepSize: 1
                        },
                        grid: { color: 'rgba(255,255,255,0.05)' }
                    },
                    x: {
                        grid: { display: false },
                        ticks: { maxRotation: 45, minRotation: 30 }
                    }
                }
            }
        });
    } catch (e) {
        console.error('Error en métricas globales:', e);
    }
}

// --- Usuarios con nombre de tenant (resuelve tenant_id → nombre_negocio) ---
async function cargarUsuariosSuper() {
    const tbody = document.getElementById('users-list-body');
    if (!tbody) return;
    
    tbody.innerHTML = '<tr><td colspan="6">Cargando...</td></tr>';
    
    try {
        let users;
        // Intentar API modular; si no existe, usar supabaseClient directo
        if (window.__usuariosApi && typeof window.__usuariosApi.getAll === 'function') {
            users = await window.__usuariosApi.getAll();
        } else {
            console.log('[cargarUsuariosSuper] Usando fallback legacy (RPC get_all_users_for_superadmin)');
            const { data, error } = await supabaseClient
                .rpc('get_all_users_for_superadmin');
            if (error) throw error;
            users = data;
        }
        
        if (!users || users.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6">No hay usuarios registrados</td></tr>';
            return;
        }
        
        // Resolver tenant_ids a nombres de negocio
        const tenantIds = [...new Set(users.map(u => u.tenant_id).filter(Boolean))];
        let tenantMap = {};
        if (tenantIds.length > 0) {
            try {
                const { data: tenants } = await supabaseClient
                    .from('tenants')
                    .select('id, nombre_negocio')
                    .in('id', tenantIds);
                if (tenants) {
                    tenants.forEach(t => { tenantMap[t.id] = t.nombre_negocio; });
                }
            } catch (e) {
                console.warn('[cargarUsuariosSuper] Error resolviendo nombres de tenants:', e);
            }
        }
        
        let html = '';
        users.forEach(user => {
            let rolBadge = '';
            if (user.rol === 'super_admin') rolBadge = '<span class="role-badge-super">Super Admin</span>';
            else if (user.rol === 'admin') rolBadge = '<span class="role-badge-admin">Admin</span>';
            else rolBadge = '<span class="role-badge-cliente">Cliente</span>';
            
            const tenantNombre = user.tenant_id ? (tenantMap[user.tenant_id] || escapeHtml(user.tenant_id.slice(0,8)) + '…') : '<span class="text-muted">—</span>';
            
            html += `<tr>
                <td>${escapeHtml(user.email)}</td>
                <td>${escapeHtml(user.nombre || '-')}</td>
                <td>${rolBadge}</td>
                <td style="font-size:0.85rem;">${tenantNombre}</td>
                <td class="action-icons">
                    ${user.rol !== 'super_admin' ? `
                        <select class="filter-select rol-select-usuario" data-user-id="${user.id}" style="padding:4px; width:100px;">
                            <option value="cliente" ${user.rol === 'cliente' ? 'selected' : ''}>Cliente</option>
                            <option value="admin" ${user.rol === 'admin' ? 'selected' : ''}>Admin</option>
                            <option value="super_admin" ${user.rol === 'super_admin' ? 'selected' : ''}>Super Admin</option>
                        </select>
                        <button class="btn-small danger btn-eliminar-usuario" data-user-id="${user.id}" style="margin-left:8px;"><i class="fas fa-trash"></i></button>
                    ` : '<span>—</span>'}
                </td>
            </tr>`;
        });
        
        tbody.innerHTML = html;

        // CSP FIX (2026-08-27): handlers inline bloqueados por CSP → addEventListener
        tbody.querySelectorAll('.rol-select-usuario').forEach(sel => {
            sel.addEventListener('change', () => cambiarRolUsuarioDirecto(sel.dataset.userId, sel.value));
        });
        tbody.querySelectorAll('.btn-eliminar-usuario').forEach(btn => {
            btn.addEventListener('click', () => eliminarUsuarioDirecto(btn.dataset.userId));
        });
        
    } catch (error) {
        console.error('Error cargando usuarios:', error);
        tbody.innerHTML = '<tr><td colspan="6">Error al cargar usuarios</td></tr>';
    }
}

async function cambiarRolUsuario(userId, currentRole) {
    const nuevoRol = currentRole === 'admin' ? 'estilista' : 'admin';
    if (!confirm(`¿Cambiar rol de ${currentRole} a ${nuevoRol}?`)) return;
    
    try {
        const { error } = await supabase
            .from('usuarios')
            .update({ rol: nuevoRol })
            .eq('id', userId);
        
        if (error) throw error;
        alert('Rol actualizado correctamente');
        await cargarUsuariosSuper();
    } catch (error) {
        console.error('Error cambiando rol:', error);
        alert('Error al cambiar el rol');
    }
}
window.cambiarRol = async (userId, nuevoRol) => {
    const { error } = await window.__usuariosApi.updateRol(userId, nuevoRol);
    if (error) {
        mostrarToast('Error al cambiar rol: ' + error.message, 'error');
    } else {
        mostrarToast(`Rol cambiado a ${nuevoRol}`, 'success');
        cargarUsuarios();
    }
};

// Fallback: cambiar rol directo con supabaseClient (cuando main.js falla)
window.cambiarRolUsuarioDirecto = async (userId, nuevoRol) => {
    try {
        const { error } = await supabaseClient
            .rpc('actualizar_rol_usuario', { p_user_id: userId, p_rol: nuevoRol });
        if (error) throw error;
        mostrarToast(`Rol cambiado a ${nuevoRol}`, 'success');
        cargarUsuariosSuper();
    } catch (e) {
        console.error('Error cambiando rol:', e);
        mostrarToast('Error al cambiar rol', 'error');
    }
};

async function eliminarUsuario(userId) {
    if (!confirm('¿Eliminar este usuario? Esta acción no se puede deshacer.')) return;
    
    try {
        const { error } = await supabase
            .from('usuarios')
            .delete()
            .eq('id', userId);
        
        if (error) throw error;
        alert('Usuario eliminado');
        await cargarUsuariosSuper();
        await cargarEstadisticasGlobales(); // actualizar contador
    } catch (error) {
        console.error('Error eliminando usuario:', error);
        alert('Error al eliminar usuario');
    }
}
window.eliminarUsuario = async (userId) => {
    if (!confirm('¿Eliminar este usuario permanentemente?')) return;
    const { error } = await window.__usuariosApi.delete(userId);
    if (error) {
        mostrarToast('Error al eliminar usuario: ' + error.message, 'error');
    } else {
        mostrarToast('Usuario eliminado', 'success');
        cargarUsuarios();
        cargarEstadisticasGlobales();
    }
};

// Fallback: eliminar usuario directo con supabaseClient
window.eliminarUsuarioDirecto = async (userId) => {
    if (!confirm('¿Eliminar este usuario permanentemente?')) return;
    try {
        const { error } = await supabaseClient
            .rpc('eliminar_usuario', { p_user_id: userId });
        if (error) throw error;
        mostrarToast('Usuario eliminado', 'success');
        cargarUsuariosSuper();
        cargarEstadisticasGlobales();
    } catch (e) {
        console.error('Error eliminando usuario:', e);
        mostrarToast('Error al eliminar usuario', 'error');
    }
};
// --- Servicios globales (solo lectura) ---
async function cargarServiciosGlobales() {
    const container = document.getElementById('servicios-global-list');
    if (!container) return;
    
    container.innerHTML = '<p>Cargando servicios...</p>';
    
    try {
        // Vista GLOBAL (superadmin): consulta directa SIN filtro de tenant.
        // NO usar window.__serviciosApi.getAll(): la API moderna es tenant-scoped
        // (if (!tenantId) return []) y esta vista necesita los servicios de TODOS los negocios.
        const { data, error } = await supabaseClient
            .from('servicios')
            .select('*, tenants:tenant_id(nombre_negocio)');
        if (error) throw error;
        const servicios = data;
        
        if (!servicios || servicios.length === 0) {
            container.innerHTML = '<p>No hay servicios registrados</p>';
            return;
        }
        
        let html = '<div class="services-grid" style="display:grid; grid-template-columns:repeat(auto-fill,minmax(250px,1fr)); gap:15px;">';
        servicios.forEach(s => {
            html += `
                <div class="service-card glass-panel" style="padding:15px;">
                    <h4>${escapeHtml(s.nombre)}</h4>
                    <p><i class="fas fa-building"></i> ${escapeHtml(s.tenants?.nombre_negocio || 'Desconocido')}</p>
                    <p><i class="fas fa-clock"></i> ${s.duracion || '?'} min</p>
                    <p><i class="fas fa-dollar-sign"></i> ${formatearPeso(s.precio)}</p>
                </div>
            `;
        });
        html += '</div>';
        container.innerHTML = html;
        
    } catch (error) {
        console.error('Error cargando servicios globales:', error);
        container.innerHTML = '<p>Error al cargar servicios</p>';
    }
}

// --- Citas globales (solo lectura) ---
async function cargarCitasGlobales() {
    const tbody = document.getElementById('citas-global-body');
    if (!tbody) return;
    
    tbody.innerHTML = '<tr><td colspan="6">Cargando citas...</td></tr>';
    
    try {
        // Vista GLOBAL (superadmin): consulta directa SIN filtro de tenant.
        // NO usar window.__appointmentsApi.getAllCitas(): la API moderna es
        // tenant-scoped (if (!tenantId) return []) y esta vista necesita las de TODOS.
        const { data, error } = await supabaseClient
            .from('citas')
            .select('*, tenants:tenant_id(nombre_negocio), servicios:servicio_id(nombre)');
        if (error) throw error;
        const citas = data;
        
        if (!citas || citas.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6">No hay citas registradas</td></tr>';
            return;
        }
        
        let html = '';
        citas.forEach(c => {
            const tenantNombre = c.tenants?.nombre_negocio || 'N/A';
            const servicioNombre = c.servicios?.nombre || 'N/A';
            const clienteNombre = c.contacto?.nombre || 'Anónimo';
            html += `<tr>
                <td>${c.id?.slice(0,8)}</td>
                <td>${escapeHtml(tenantNombre)}</td>
                <td>${escapeHtml(servicioNombre)}</td>
                <td>${escapeHtml(clienteNombre)}</td>
                <td>${c.fecha || ''}</td>
                <td>${c.hora || ''}</td>
            </tr>`;
        });
        
        tbody.innerHTML = html;
        
    } catch (error) {
        console.error('Error cargando citas globales:', error);
        tbody.innerHTML = '<tr><td colspan="6">Error al cargar citas</td></tr>';
    }
}

// Función auxiliar para abrir modal con datos del tenant (si no existe)
async function abrirModalEditarTenant(tenantId) {
    try {
        const { data: tenant, error } = await supabaseClient
            .from('tenants')
            .select('*')
            .eq('id', tenantId)
            .single();
        
        if (error) throw error;
        
        if (tenant) {
            const modal = document.getElementById('tenant-modal');
            document.getElementById('tenant-id').value = tenant.id;
            modal.dataset.currentId = tenant.id;
            document.getElementById('tenant-nombre').value = tenant.nombre_negocio || '';
            document.getElementById('tenant-email').value = tenant.email_contacto || '';
            document.getElementById('tenant-plan').value = tenant.plan || 'freemium';
            document.getElementById('tenant-estado').value = tenant.estado || 'activo';
            document.getElementById('modal-title').textContent = 'Editar Tenant';
            document.getElementById('tenant-modal').style.display = 'flex';
        } else {
            mostrarToast('No se encontraron datos del tenant', 'error');
        }
    } catch (error) {
        console.error('[abrirModalEditarTenant] Error:', error);
        mostrarToast('Error al cargar datos del tenant: ' + (error.message || 'Error de red'), 'error');
    }
}

// --- Inicialización segura ---
// Si la variable supabase no está definida globalmente, la declaramos (ya debería estarlo en script.js)
if (typeof supabase === 'undefined') {
    console.warn('supabase no definido. Asegúrate de inicializar el cliente en script.js');
}

// Exponer globalmente
window.diagnosticarSistema = diagnosticarSistema;

// ============================================
// COMPARTIR ENLACE DE CLIENTES
// ============================================
// navigateTo eliminado: se usa la versión definida en admin.html (inline)
// que tiene la lógica completa de navegación y carga de datos por sección.
function configurarCompartirEnlace() {
    const linkInput = document.getElementById('client-share-link');
    const copyBtn = document.getElementById('copy-link-btn');
    const qrBtn = document.getElementById('generate-qr-btn');
    const qrContainer = document.getElementById('qr-code');

    if (!linkInput) return; // No está en esta página

    // Generar enlace (URL amigable /p/slug si el negocio tiene slug)
    getCurrentTenantId().then(async tenantId => {
        if (tenantId) {
            try {
                const { data: tData } = await supabaseClient
                    .from('tenants')
                    .select('slug')
                    .eq('id', tenantId)
                    .maybeSingle();
                const origin = window.location.origin;
                if (tData?.slug) {
                    linkInput.value = `${origin}/p/${encodeURIComponent(tData.slug)}`;
                } else {
                    linkInput.value = `${origin}/cliente.html?tenant=${tenantId}`;
                }
            } catch (e) {
                console.warn('[CompartirEnlace] Error obteniendo slug, usando fallback:', e);
                linkInput.value = `${window.location.origin}/cliente.html?tenant=${tenantId}`;
            }
        } else {
            linkInput.value = 'No se pudo generar el enlace (sin tenant)';
        }
    });

    // Copiar al portapapeles
    if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(linkInput.value);
                copyBtn.classList.add('copied');
                copyBtn.innerHTML = '<i class="fas fa-check"></i> Copiado';
                setTimeout(() => {
                    copyBtn.classList.remove('copied');
                    copyBtn.innerHTML = '<i class="fas fa-copy"></i> Copiar';
                }, 2000);
            } catch {
                // Fallback para navegadores sin clipboard API
                linkInput.select();
                linkInput.setSelectionRange(0, 99999);
                document.execCommand('copy');
                mostrarToast('Enlace copiado', 'success');
            }
        });
    }

    // Botón WhatsApp
    const whatsappBtn = document.getElementById('share-whatsapp-btn');
    if (whatsappBtn) {
        whatsappBtn.addEventListener('click', () => {
            const url = linkInput.value;
            if (!url || url === 'Cargando...' || url === 'No se pudo generar el enlace (sin tenant)') {
                mostrarToast('Espera a que se genere el enlace', 'warning');
                return;
            }
            const message = `🌟 *¡Agenda tu cita aquí!* 🌟\n\nHaz clic en el enlace para ver nuestros servicios y reservar tu hora:\n${url}\n\n¡Te esperamos!`;
            const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(message)}`;
            window.open(whatsappUrl, '_blank');
        });
    }

    // Generar QR
    if (qrBtn && qrContainer) {
        qrBtn.addEventListener('click', () => {
            if (qrContainer.style.display === 'flex') {
                qrContainer.style.display = 'none';
                qrContainer.innerHTML = '';
                return;
            }
            const url = linkInput.value;
            if (!url || url === 'Cargando...') {
                mostrarToast('Espera a que se genere el enlace', 'warning');
                return;
            }
            // Usar API gratuita de QR
            const qrImg = document.createElement('img');
            qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(url)}`;
            qrImg.alt = 'Código QR';
            qrImg.onload = () => {
                qrContainer.innerHTML = '';
                qrContainer.style.flexDirection = 'column';
                qrContainer.style.alignItems = 'center';
                qrContainer.appendChild(qrImg);
                qrContainer.appendChild(crearAccionesQR(url));
                qrContainer.style.display = 'flex';
            };
            qrImg.onerror = () => {
                mostrarToast('Error al generar el QR', 'error');
            };
        });
    }
}

// ── Acciones del QR: imprimir / descargar como imagen ──────────────────
// Crea los botones "Imprimir QR" y "Descargar PNG" junto al código QR.
// Se generan dinámicamente con addEventListener (compatible con CSP).
function crearAccionesQR(url) {
    const wrap = document.createElement('div');
    wrap.className = 'qr-actions';
    wrap.style.cssText = 'display:flex; gap:10px; justify-content:center; margin-top:12px; flex-wrap:wrap;';

    const printBtn = document.createElement('button');
    printBtn.type = 'button';
    printBtn.className = 'btn-secondary';
    printBtn.innerHTML = '<i class="fas fa-print"></i> Imprimir QR';
    printBtn.addEventListener('click', () => imprimirQR(url));

    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'btn-secondary';
    downloadBtn.innerHTML = '<i class="fas fa-download"></i> Descargar PNG';
    downloadBtn.addEventListener('click', () => descargarQR(url));

    wrap.appendChild(printBtn);
    wrap.appendChild(downloadBtn);
    return wrap;
}

// Abre una ventana de impresión con el QR en alta resolución y el enlace,
// para que la pyme lo imprima y lo deje en su local.
function imprimirQR(url) {
    const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=600x600&data=${encodeURIComponent(url)}`;
    const win = window.open('', '_blank', 'width=640,height=720');
    if (!win) {
        mostrarToast('Permite ventanas emergentes para imprimir el QR', 'warning');
        return;
    }
    win.document.write(
        '<!DOCTYPE html><html><head><title>Imprimir QR - Mi Agenda</title>' +
        '<style>' +
        'body{font-family:Arial,Helvetica,sans-serif;text-align:center;padding:30px;color:#222;}' +
        'h2{margin:0 0 6px;font-size:22px;}' +
        'p{margin:0 0 18px;color:#555;}' +
        'img{width:340px;height:340px;image-rendering:pixelated;}' +
        '.qr-url{margin-top:18px;font-size:13px;color:#444;word-break:break-all;}' +
        '@media print{body{padding:10px;}}' +
        '</style></head><body>' +
        '<h2>Escaneá y agendá tu cita</h2>' +
        '<p>Mirá nuestros servicios y reservá tu hora</p>' +
        '<img src="' + qrSrc + '" alt="Código QR">' +
        '<div class="qr-url">' + url + '</div>' +
        '</body></html>'
    );
    win.onload = () => {
        win.focus();
        win.print();
    };
    win.onafterprint = () => win.close();
    win.document.close();
}

// Descarga el QR como imagen PNG (para editarla o imprimirla externamente).
// Estrategia multi-fallback para que funcione en PC y móvil:
//   1. fetch → blob → <a download> (Android/PC)
//   2. Si el fetch falla (CSP/red): canvas con crossOrigin (usa img-src, no connect-src)
//   3. Último recurso: abrir la imagen para guardarla con pulsación larga
// iOS Safari no soporta <a download> con blob/data URLs → se abre la imagen directo.
async function descargarQR(url) {
    const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=600x600&data=${encodeURIComponent(url)}`;
    const nombreArchivo = 'qr-mi-agenda.png';

    const esIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (esIOS) {
        const win = window.open(qrSrc, '_blank');
        if (win) {
            mostrarToast('Imagen abierta: mantené el dedo sobre ella para guardarla', 'info');
        } else {
            mostrarToast('Permite ventanas emergentes para descargar el QR', 'warning');
        }
        return;
    }

    try {
        mostrarToast('Generando imagen…', 'info');
        const resp = await fetch(qrSrc);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const blob = await resp.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = nombreArchivo;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
        mostrarToast('QR descargado como imagen', 'success');
    } catch (e) {
        // Fallback sin fetch: dibujar en canvas con crossOrigin (solo necesita img-src https:)
        try {
            await descargarQRViaCanvas(qrSrc, nombreArchivo);
            mostrarToast('QR descargado como imagen', 'success');
        } catch (e2) {
            console.error('Error descargando QR:', e, e2);
            const win = window.open(qrSrc, '_blank');
            if (win) {
                mostrarToast('Imagen abierta: mantené pulsado para guardarla', 'info');
            } else {
                mostrarToast('Error al descargar el QR. Revisá tu conexión', 'error');
            }
        }
    }
}

// Descarga vía canvas: la API de QR responde Access-Control-Allow-Origin: *,
// así que con crossOrigin='anonymous' el canvas no se mancha y se puede exportar.
function descargarQRViaCanvas(src, nombreArchivo) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                canvas.getContext('2d').drawImage(img, 0, 0);
                const dataUrl = canvas.toDataURL('image/png');
                const a = document.createElement('a');
                a.href = dataUrl;
                a.download = nombreArchivo;
                document.body.appendChild(a);
                a.click();
                a.remove();
                resolve();
            } catch (err) {
                reject(err);
            }
        };
        img.onerror = () => reject(new Error('No se pudo cargar la imagen del QR'));
        img.src = src;
    });
}

// ============================================
// EXPORTAR FUNCIONES GLOBALES ADICIONALES
// ============================================
window.eliminarServicio = eliminarServicio;
window.toggleActivoServicio = toggleActivoServicio;
window.editarServicio = editarServicio;
window.abrirModalCambioFecha = abrirModalCambioFecha;
window.confirmarCambioFecha = confirmarCambioFecha;

// ============================================
// CSP EVENT BRIDGE: convierte onclick/onchange inline a addEventListener
// ============================================
// CSP bloquea los event handlers inline (onclick="fn()") cuando script-src
// no tiene 'unsafe-inline'. Este bridge lee los atributos onclick/onchange
// del DOM en tiempo de ejecución, los convierte a addEventListener, y remueve
// el atributo inline para que CSP no lo bloquee.
// No requiere cambios en HTML ni CSS.
// ============================================
function _initCSPEventBridge() {
    if (window.__cspBridgeDone) return;
    window.__cspBridgeDone = true;

    // ---- Callbacks de Turnstile Captcha (definidos en login.html como data-callback) ----
    // Son referenciados por el widget de Turnstile pero no estaban definidos en JS.
    // Se necesita la función global para que Turnstile no muestre warnings.
    if (typeof window.onCaptchaReady !== 'function') {
        window.onCaptchaReady = function() {
            console.log('[Captcha] Turnstile resuelto (login)');
        };
    }
    if (typeof window.onRegisterCaptchaReady !== 'function') {
        window.onRegisterCaptchaReady = function() {
            console.log('[Captcha] Turnstile resuelto (registro)');
        };
    }
    if (typeof window.onCaptchaExpired !== 'function') {
        window.onCaptchaExpired = function() {
            console.log('[Captcha] Token expirado, re-resolviendo...');
        };
    }

    // ---- Handlers directos (sin argumentos) ----
    var directMap = {};

    // Registrar función en el mapa: onclickValue → functionReference
    function reg(fn) {
        var name = fn.name;
        if (!name) return;
        directMap[name + '()'] = fn;
    }
    // Las funciones disponibles globalmente desde inline scripts o legacy.js
    // NOTA: Usamos strings hardcodeadas como clave, NO fn.name, porque esbuild
    // minifica los nombres de las funciones (closeSidebar → a) y fn.name quedaria
    // incorrecto ("a" en vez de "closeSidebar").
    if (typeof closeSidebar === 'function') {
        directMap['closeSidebar()'] = closeSidebar;
    }
    if (typeof toggleSidebar === 'function') {
        directMap['toggleSidebar()'] = toggleSidebar;
    }
    if (typeof closeNotifPopover === 'function') {
        directMap['closeNotifPopover()'] = closeNotifPopover;
    }
    if (typeof toggleNotifPopover === 'function') {
        directMap['toggleNotifPopover(event)'] = function(e) { toggleNotifPopover(e); };
    }
    if (typeof generarFechasPorRango === 'function') {
        directMap['generarFechasPorRango()'] = generarFechasPorRango;
    }
    if (typeof guardarAsignacionActual === 'function') {
        directMap['guardarAsignacionActual()'] = guardarAsignacionActual;
    }
    if (typeof mostrarVistaPrevia === 'function') {
        directMap['mostrarVistaPrevia()'] = mostrarVistaPrevia;
    }
    if (typeof cerrarPopupReserva === 'function') {
        directMap['cerrarPopupReserva()'] = cerrarPopupReserva;
    }
    if (typeof cerrarSesion === 'function') {
        directMap['cerrarSesion()'] = cerrarSesion;
    }
    if (typeof onDateSelectorChange === 'function') {
        directMap['onDateSelectorChange(this)'] = function(e) { onDateSelectorChange(e.target); };
    }

    // ---- Procesar todos los elementos con onclick ----
    var els = document.querySelectorAll('[onclick]');
    for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var attr = (el.getAttribute('onclick') || '').trim();
        if (!attr) continue;
        el.removeAttribute('onclick');

        // Pattern: navigateTo('section')
        var navMatch = attr.match(/^navigateTo\('([^']+)'\)(?:;return false;)?$/);
        if (navMatch && typeof navigateTo === 'function') {
            (function(section) { el.addEventListener('click', function() { navigateTo(section); }); })(navMatch[1]);
            continue;
        }

        // Pattern: window.location.href = 'url'
        var urlMatch = attr.match(/^(?:window\.)?location(?:\.href)?\s*=\s*'([^']+)'/);
        if (urlMatch) {
            (function(url) { el.addEventListener('click', function() { window.location.href = url; }); })(urlMatch[1]);
            continue;
        }

        // Pattern: filtrarNotifPopover(this, 'tipo')
        var filterMatch = attr.match(/^filtrarNotifPopover\(this,\s*'(\w+)'\)$/);
        if (filterMatch && typeof filtrarNotifPopover === 'function') {
            (function(tipo) { el.addEventListener('click', function() { filtrarNotifPopover(el, tipo); }); })(filterMatch[1]);
            continue;
        }

        // Pattern: setAssignmentMode('tipo')
        var assignMatch = attr.match(/^setAssignmentMode\('(\w+)'\)$/);
        if (assignMatch && typeof setAssignmentMode === 'function') {
            (function(mode) { el.addEventListener('click', function() { setAssignmentMode(mode); }); })(assignMatch[1]);
            continue;
        }

        // Pattern: return false;
        if (attr === 'return false;') {
            el.addEventListener('click', function(e) { e.preventDefault(); });
            continue;
        }

        // Fallback: lookup directo
        if (directMap[attr]) {
            el.addEventListener('click', directMap[attr]);
            continue;
        }

        console.warn('[CSP-Bridge] onclick sin mapear:', attr);
    }

    // ---- Procesar onchange ----
    var changeEls = document.querySelectorAll('[onchange]');
    for (var j = 0; j < changeEls.length; j++) {
        var cel = changeEls[j];
        var changeAttr = (cel.getAttribute('onchange') || '').trim();
        if (!changeAttr) continue;
        cel.removeAttribute('onchange');

        if (changeAttr === 'onDateSelectorChange(this)' && typeof onDateSelectorChange === 'function') {
            (function(c) { cel.addEventListener('change', function() { onDateSelectorChange(c); }); })(cel);
            continue;
        }

        console.warn('[CSP-Bridge] onchange sin mapear:', changeAttr);
    }

    // ---- Procesar onsubmit ----
    var submitEls = document.querySelectorAll('[onsubmit]');
    for (var k = 0; k < submitEls.length; k++) {
        var sel = submitEls[k];
        var subAttr = (sel.getAttribute('onsubmit') || '').trim();
        if (!subAttr) continue;
        sel.removeAttribute('onsubmit');

        if (subAttr === 'return false;') {
            sel.addEventListener('submit', function(e) { e.preventDefault(); });
            continue;
        }

        console.warn('[CSP-Bridge] onsubmit sin mapear:', subAttr);
    }
}

// ============================================================
// FEEDBACK / SOPORTE DE TENANTS (widget en admin + tab superadmin)
// Tabla: tenant_feedback (ver migración 20260918_tenant_feedback.sql)
// ============================================================

// ---------- Lado tenant (admin.html): widget inferior ----------
function inicializarFeedbackWidget() {
    if (document.getElementById('feedback-widget')) return;
    const footer = document.querySelector('.admin-footer');
    if (!footer) return;
    const cont = document.createElement('div');
    cont.id = 'feedback-widget';
    cont.className = 'glass-panel';
    cont.style.cssText = 'margin:26px auto 0;max-width:900px;padding:20px;';
    cont.innerHTML = `
        <h3 style="margin:0 0 6px;font-size:1.05rem;"><i class="fas fa-comments"></i> ¿Cómo podemos mejorar tu experiencia?</h3>
        <p style="margin:0 0 14px;font-size:0.85rem;color:var(--text-muted,#aaa);">Cuéntanos un problema, una sugerencia o una mejora que te facilitaría el día a día en tu pyme. Tu comentario llega directo al equipo.</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
            <select id="feedback-categoria" style="flex:1;min-width:160px;background:rgba(255,255,255,0.05);color:var(--text-color,#fff);border:1px solid var(--border-color,#2a2a4a);border-radius:8px;padding:10px;font-family:inherit;font-size:0.9rem;">
                <option value="sugerencia">💡 Sugerencia</option>
                <option value="problema">⚠️ Problema o error</option>
                <option value="mejora">🚀 Mejora que me ayudaría</option>
                <option value="otro">📝 Otro</option>
            </select>
        </div>
        <textarea id="feedback-mensaje" rows="3" maxlength="2000" placeholder="Ej: Me gustaría poder exportar mis citas a Excel..." style="width:100%;margin:0 0 12px;padding:10px;border-radius:8px;background:rgba(255,255,255,0.05);color:var(--text-color,#fff);border:1px solid var(--border-color,#2a2a4a);resize:vertical;font-family:inherit;box-sizing:border-box;"></textarea>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
            <button type="button" id="feedback-enviar" class="btn-grad"><i class="fas fa-paper-plane"></i> Enviar comentario</button>
            <span id="feedback-counter" style="font-size:0.75rem;color:var(--text-muted,#888);">0/2000</span>
        </div>
    `;
    footer.parentNode.insertBefore(cont, footer);
    const enviarBtn = document.getElementById('feedback-enviar');
    if (enviarBtn) enviarBtn.addEventListener('click', enviarFeedback);
    const textarea = document.getElementById('feedback-mensaje');
    if (textarea) {
        textarea.addEventListener('input', () => {
            const c = document.getElementById('feedback-counter');
            if (c) c.textContent = textarea.value.length + '/2000';
        });
    }
}

async function enviarFeedback() {
    const categoriaEl = document.getElementById('feedback-categoria');
    const mensajeEl = document.getElementById('feedback-mensaje');
    if (!mensajeEl) return;
    const categoria = (categoriaEl && categoriaEl.value) || 'sugerencia';
    const mensaje = mensajeEl.value.trim();
    if (!mensaje) {
        mostrarToast('Escribe tu comentario antes de enviar.', 'warning');
        return;
    }
    const client = supabaseClient || window.supabaseClient;
    if (!client) {
        mostrarToast('Error de conexión. Intenta de nuevo.', 'error');
        return;
    }
    const tenantId = window.currentTenantId || (typeof getCurrentTenantId === 'function' ? await getCurrentTenantId() : null);
    if (!tenantId) {
        mostrarToast('Error: no se pudo identificar tu negocio.', 'error');
        return;
    }
    const enviarBtn = document.getElementById('feedback-enviar');
    if (enviarBtn) {
        enviarBtn.disabled = true;
        enviarBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enviando...';
    }
    try {
        const { error } = await client.from('tenant_feedback').insert({
            tenant_id: tenantId,
            categoria: categoria,
            mensaje: mensaje
        });
        if (error) throw error;
        mensajeEl.value = '';
        const c = document.getElementById('feedback-counter');
        if (c) c.textContent = '0/2000';
        mostrarToast('¡Gracias! Tu comentario llegó al equipo.', 'success');
    } catch (e) {
        console.error('Error enviando feedback:', e);
        mostrarToast('Error al enviar. Intenta de nuevo.', 'error');
    } finally {
        if (enviarBtn) {
            enviarBtn.disabled = false;
            enviarBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Enviar comentario';
        }
    }
}

// ---------- Lado superadmin (superadmin.html): tab + listado ----------
function inyectarTabFeedback() {
    if (document.querySelector('.tab-btn[data-tab="feedback"]') && document.getElementById('tab-feedback')) return;
    const tabsBar = document.querySelector('.superadmin-tabs');
    if (!tabsBar) return;
    const btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.dataset.tab = 'feedback';
    btn.innerHTML = '<i class="fas fa-comments"></i> Sugerencias';
    tabsBar.appendChild(btn);

    const panel = document.querySelector('.superadmin-screen .glass-panel');
    if (!panel) return;
    const cont = document.createElement('div');
    cont.id = 'tab-feedback';
    cont.className = 'tab-content';
    cont.style.display = 'none';
    cont.innerHTML = `
        <div class="panel-header">
            <h3><i class="fas fa-comments"></i> Comentarios de los tenants</h3>
            <button type="button" class="btn-grad" id="btn-refresh-feedback"><i class="fas fa-sync"></i> Refrescar</button>
        </div>
        <div id="feedback-list" class="solicitudes-container" style="margin-top:20px;"><p>Cargando comentarios...</p></div>
    `;
    const footer = panel.querySelector('.admin-footer');
    if (footer) footer.parentNode.insertBefore(cont, footer);
    else panel.appendChild(cont);
    const refreshBtn = document.getElementById('btn-refresh-feedback');
    if (refreshBtn) refreshBtn.addEventListener('click', cargarFeedbackSuper);
}

// ---------- Tab Pagos (superadmin): pagos REALES de Mercado Pago ----------
// Inyecta la tab por JS (patrón inyectarTabFeedback) sin tocar HTML.
// Solo super_admin ve esta data (RLS: SELECT con is_super_admin()).
function inyectarTabPagos() {
    if (document.querySelector('.tab-btn[data-tab="pagos"]') && document.getElementById('tab-pagos')) return;
    const tabsBar = document.querySelector('.superadmin-tabs');
    if (!tabsBar) return;
    const btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.dataset.tab = 'pagos';
    btn.innerHTML = '<i class="fas fa-credit-card"></i> Pagos';
    tabsBar.appendChild(btn);

    const panel = document.querySelector('.superadmin-screen .glass-panel');
    if (!panel) return;
    const cont = document.createElement('div');
    cont.id = 'tab-pagos';
    cont.className = 'tab-content';
    cont.style.display = 'none';
    cont.innerHTML = `
        <div class="panel-header">
            <h3><i class="fas fa-credit-card"></i> Pagos Mercado Pago (reales)</h3>
            <button type="button" class="btn-grad" id="btn-refresh-pagos"><i class="fas fa-sync"></i> Refrescar</button>
        </div>
        <div class="appointments-table-container" style="margin-top:20px;">
            <table class="appointments-table" id="pagos-super-table">
                <thead><tr><th>Fecha</th><th>Negocio</th><th>Email</th><th>Plan</th><th>Monto</th><th>Estado</th><th>Payment ID</th></tr></thead>
                <tbody id="pagos-super-body"><tr><td colspan="7">Cargando pagos...</td></tr></tbody>
            </table>
        </div>
    `;
    const footer = panel.querySelector('.admin-footer');
    if (footer) footer.parentNode.insertBefore(cont, footer);
    else panel.appendChild(cont);
    const refreshBtn = document.getElementById('btn-refresh-pagos');
    if (refreshBtn) refreshBtn.addEventListener('click', cargarPagosSuper);
}

async function cargarPagosSuper() {
    const tbody = document.getElementById('pagos-super-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="7">Cargando pagos...</td></tr>';
    const client = supabaseClient || window.supabaseClient;
    if (!client) {
        tbody.innerHTML = '<tr><td colspan="7">Error de conexión.</td></tr>';
        return;
    }
    try {
        const { data, error } = await client
            .from('mercadopago_payments')
            .select('*, tenants:tenant_id(nombre_negocio, email_contacto)')
            .order('created_at', { ascending: false })
            .limit(100);
        if (error) throw error;
        if (!data || data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7">No hay pagos registrados todavía.</td></tr>';
            return;
        }
        const statusMeta = {
            approved: { label: 'Aprobado', color: '#2ecc71' },
            rejected: { label: 'Rechazado', color: '#e74c3c' },
            pending: { label: 'Pendiente', color: '#f39c12' },
            cancelled: { label: 'Cancelado', color: '#95a5a6' },
            refunded: { label: 'Reembolsado', color: '#9b59b6' },
        };
        let html = '';
        data.forEach(p => {
            const tenantName = p.tenants?.nombre_negocio || 'Desconocido';
            const tenantEmail = p.tenants?.email_contacto || p.mp_payer_email || '—';
            const fecha = p.created_at ? new Date(p.created_at).toLocaleString('es-CL') : '—';
            const planLabel = p.plan === 'premium_anual' ? 'Premium Anual' : (p.plan === 'pro' ? 'Pro' : p.plan || '—');
            const monto = p.monto != null ? '$' + Number(p.monto).toLocaleString('es-CL') : '—';
            const meta = statusMeta[p.mp_status] || { label: p.mp_status || '—', color: '#888888' };
            html += `
                <tr>
                    <td>${fecha}</td>
                    <td>${escapeHtml(tenantName)}</td>
                    <td>${escapeHtml(tenantEmail)}</td>
                    <td>${escapeHtml(planLabel)}</td>
                    <td style="font-weight:600;">${monto}</td>
                    <td><span style="background:${meta.color}22;color:${meta.color};border:1px solid ${meta.color}55;padding:2px 10px;border-radius:20px;font-size:0.72rem;font-weight:600;">${escapeHtml(meta.label)}</span></td>
                    <td style="font-size:0.78rem;opacity:0.75;">${escapeHtml(p.mp_payment_id || '—')}</td>
                </tr>
            `;
        });
        tbody.innerHTML = html;
    } catch (e) {
        console.error('[PagosSuper] Error cargando pagos:', e);
        tbody.innerHTML = '<tr><td colspan="7">Error al cargar pagos: ' + escapeHtml(e.message) + '</td></tr>';
    }
}

// ---------- Tab Directorio (superadmin): ordenar pymes del Directorio Público ----------
// Inyecta la tab por JS (patrón inyectarTabPagos) sin tocar HTML.
// El orden se guarda en tenant_config.directorio_posicion (política superadmin).
const DIRECTORIO_CATEGORIAS_SUPER = {
    salud: 'Salud y Bienestar Clínico',
    estetica: 'Estética, Belleza y Cuidado Personal',
    deporte: 'Deporte, Actividad Física y Clases',
    profesionales: 'Servicios Profesionales y Creativos',
    tecnicos: 'Servicios Técnicos, Hogar y Terreno'
};
const PLANES_DIRECTORIO_VISIBLES = ['pro', 'premium_anual', 'freemium'];
let _directorioSuperFiltro = { cat: 'todas', termino: '' };
let _directorioSuperFilas = [];

function inyectarTabDirectorio() {
    if (document.querySelector('.tab-btn[data-tab="directorio"]') && document.getElementById('tab-directorio')) return;
    const tabsBar = document.querySelector('.superadmin-tabs');
    if (!tabsBar) return;
    const btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.dataset.tab = 'directorio';
    btn.innerHTML = '<i class="fas fa-store"></i> Directorio';
    tabsBar.appendChild(btn);

    const panel = document.querySelector('.superadmin-screen .glass-panel');
    if (!panel) return;
    const cont = document.createElement('div');
    cont.id = 'tab-directorio';
    cont.className = 'tab-content';
    cont.style.display = 'none';
    cont.innerHTML = `
        <div class="panel-header">
            <h3><i class="fas fa-store"></i> Directorio Público de PYMEs</h3>
            <button type="button" class="btn-grad" id="btn-refresh-directorio"><i class="fas fa-sync"></i> Refrescar</button>
        </div>
        <p class="muted" style="margin-top:6px;">Ordena quién aparece primero en la página de inicio. Usa las flechas para subir o bajar cada pyme; el orden se guarda al instante.</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px;">
            <input type="text" id="directorio-super-buscar" placeholder="Buscar pyme..." style="flex:1;min-width:200px;padding:8px 12px;border-radius:8px;border:1px solid #ced4da;">
            <select id="directorio-super-cat" style="padding:8px 12px;border-radius:8px;border:1px solid #ced4da;">
                <option value="todas">Todas las categorías</option>
            </select>
        </div>
        <div class="appointments-table-container" style="margin-top:16px;">
            <table class="appointments-table" id="directorio-super-table">
                <thead><tr><th>Orden</th><th>Pyme</th><th>Categoría</th><th>Tipo</th><th>Reseñas</th><th>Plan</th><th>Público</th></tr></thead>
                <tbody id="directorio-super-body"><tr><td colspan="7">Cargando directorio...</td></tr></tbody>
            </table>
        </div>
    `;
    const footer = panel.querySelector('.admin-footer');
    if (footer) footer.parentNode.insertBefore(cont, footer);
    else panel.appendChild(cont);

    document.getElementById('btn-refresh-directorio')?.addEventListener('click', cargarDirectorioSuper);
    document.getElementById('directorio-super-buscar')?.addEventListener('input', (e) => {
        _directorioSuperFiltro.termino = e.target.value;
        renderDirectorioSuper();
    });
    document.getElementById('directorio-super-cat')?.addEventListener('change', (e) => {
        _directorioSuperFiltro.cat = e.target.value;
        renderDirectorioSuper();
    });
}

async function cargarDirectorioSuper() {
    const tbody = document.getElementById('directorio-super-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="7">Cargando directorio...</td></tr>';
    const client = supabaseClient || window.supabaseClient;
    if (!client) {
        tbody.innerHTML = '<tr><td colspan="7">Error de conexión.</td></tr>';
        return;
    }
    try {
        const [tenantsRes, configsRes, subsRes] = await Promise.all([
            client.from('tenants').select('id, nombre_negocio, plan, estado').order('fecha_registro', { ascending: false }),
            client.from('tenant_config').select('tenant_id, directorio_activo, directorio_categoria, directorio_tipo_pyme, directorio_posicion, directorio_estrellas, directorio_comentarios'),
            client.from('subscriptions').select('tenant_id, plan, status')
        ]);
        if (tenantsRes.error) throw tenantsRes.error;
        if (configsRes.error) throw configsRes.error;

        const subMap = {};
        (subsRes.data || []).forEach(s => {
            if (!subMap[s.tenant_id] || s.status === 'active') subMap[s.tenant_id] = s;
        });

        const configMap = {};
        (configsRes.data || []).forEach(c => { configMap[c.tenant_id] = c; });

        const filas = [];
        (tenantsRes.data || []).forEach(t => {
            const cfg = configMap[t.id];
            if (!cfg || cfg.directorio_activo !== true) return;
            const sub = subMap[t.id];
            const planActivo = (sub && sub.status === 'active') ? sub.plan : null;
            filas.push({
                tenant_id: t.id,
                nombre: t.nombre_negocio || 'Sin nombre',
                plan: planActivo || t.plan || '—',
                estadoTenant: t.estado,
                categoria: cfg.directorio_categoria || '',
                tipo: cfg.directorio_tipo_pyme || '',
                estrellas: cfg.directorio_estrellas === true,
                comentarios: cfg.directorio_comentarios === true,
                posicion: Number(cfg.directorio_posicion) || 0,
                visiblePublico: Boolean(planActivo && PLANES_DIRECTORIO_VISIBLES.includes(planActivo))
            });
        });
        filas.sort((a, b) => (a.posicion - b.posicion) || a.nombre.localeCompare(b.nombre));
        _directorioSuperFilas = filas;

        // Poblar filtro de categorías con las presentes en el directorio
        const catSelect = document.getElementById('directorio-super-cat');
        if (catSelect) {
            const cats = [...new Set(filas.map(f => f.categoria).filter(Boolean))];
            catSelect.innerHTML = '<option value="todas">Todas las categorías</option>' +
                cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(DIRECTORIO_CATEGORIAS_SUPER[c] || c)}</option>`).join('');
            catSelect.value = _directorioSuperFiltro.cat;
        }
        renderDirectorioSuper();
    } catch (e) {
        console.error('[DirectorioSuper] Error cargando:', e);
        tbody.innerHTML = '<tr><td colspan="7">Error al cargar directorio: ' + escapeHtml(e.message) + '</td></tr>';
    }
}

function renderDirectorioSuper() {
    const tbody = document.getElementById('directorio-super-body');
    if (!tbody) return;
    const term = _directorioSuperFiltro.termino.trim().toLowerCase();
    const visibles = _directorioSuperFilas.filter(f => {
        if (_directorioSuperFiltro.cat !== 'todas' && f.categoria !== _directorioSuperFiltro.cat) return false;
        if (term && !((f.nombre || '').toLowerCase().includes(term) || (f.tipo || '').toLowerCase().includes(term))) return false;
        return true;
    });

    if (!visibles.length) {
        tbody.innerHTML = '<tr><td colspan="7">No hay pymes en el directorio con ese filtro.</td></tr>';
        return;
    }

    tbody.innerHTML = visibles.map((f, i) => `
        <tr>
            <td>
                <div style="display:flex;align-items:center;gap:6px;">
                    <span style="font-weight:700;min-width:26px;">${i + 1}</span>
                    <button type="button" class="btn-small" data-dir-mover="up" data-idx="${i}" title="Subir" ${i === 0 ? 'disabled style="opacity:0.4"' : ''}><i class="fas fa-arrow-up"></i></button>
                    <button type="button" class="btn-small" data-dir-mover="down" data-idx="${i}" title="Bajar" ${i === visibles.length - 1 ? 'disabled style="opacity:0.4"' : ''}><i class="fas fa-arrow-down"></i></button>
                </div>
            </td>
            <td><strong>${escapeHtml(f.nombre)}</strong></td>
            <td>${escapeHtml(DIRECTORIO_CATEGORIAS_SUPER[f.categoria] || f.categoria || '—')}</td>
            <td>${escapeHtml(f.tipo || '—')}</td>
            <td style="white-space:nowrap;">
                ${f.estrellas ? '<i class="fas fa-star" style="color:#f1c40f;" title="Estrellas"></i>' : '<span class="muted">—</span>'}
                ${f.comentarios ? '<i class="fas fa-comment-dots" style="color:#3498db;margin-left:6px;" title="Comentarios"></i>' : ''}
            </td>
            <td><span class="badge" style="background:${f.plan === 'premium_anual' ? '#ffd700' : f.plan === 'pro' ? '#b300ff' : '#666'};color:${f.plan === 'premium_anual' ? '#000' : '#fff'};padding:2px 10px;border-radius:20px;font-size:0.72rem;">${escapeHtml(f.plan)}</span></td>
            <td>${f.visiblePublico
                ? '<span style="color:#2ecc71;font-weight:600;"><i class="fas fa-eye"></i> Visible</span>'
                : '<span style="color:#e67e22;"><i class="fas fa-eye-slash"></i> Oculto (plan)</span>'}</td>
        </tr>
    `).join('');

    tbody.querySelectorAll('[data-dir-mover]').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = Number(btn.dataset.idx);
            const dir = btn.dataset.dirMover;
            const objetivo = dir === 'up' ? idx - 1 : idx + 1;
            if (objetivo < 0 || objetivo >= visibles.length) return;
            const a = visibles[idx];
            const b = visibles[objetivo];
            const ia = _directorioSuperFilas.indexOf(a);
            const ib = _directorioSuperFilas.indexOf(b);
            if (ia === -1 || ib === -1) return;
            [_directorioSuperFilas[ia], _directorioSuperFilas[ib]] = [_directorioSuperFilas[ib], _directorioSuperFilas[ia]];
            guardarOrdenDirectorio();
        });
    });
}

async function guardarOrdenDirectorio() {
    const client = supabaseClient || window.supabaseClient;
    if (!client) return;
    for (let i = 0; i < _directorioSuperFilas.length; i++) {
        const f = _directorioSuperFilas[i];
        const nueva = i + 1;
        if (f.posicion === nueva) continue;
        try {
            if (window.__tenantConfigApi?.upsert) {
                await window.__tenantConfigApi.upsert(f.tenant_id, { directorio_posicion: nueva });
            } else {
                await client.from('tenant_config').upsert({ tenant_id: f.tenant_id, directorio_posicion: nueva });
            }
            f.posicion = nueva;
        } catch (e) {
            console.warn('[DirectorioSuper] Error guardando posición de', f.tenant_id, e);
            mostrarToast('⚠️ No se pudo guardar el orden: ' + (e.message || 'error'), 'error');
            break;
        }
    }
    renderDirectorioSuper();
    mostrarToast('✅ Orden del directorio actualizado', 'success');
}

async function cargarFeedbackSuper() {
    const container = document.getElementById('feedback-list');
    if (!container) return;
    container.innerHTML = '<p>Cargando comentarios...</p>';
    const client = supabaseClient || window.supabaseClient;
    if (!client) {
        container.innerHTML = '<p>Error de conexión.</p>';
        return;
    }
    try {
        const { data, error } = await client
            .from('tenant_feedback')
            .select('*, tenants:tenant_id(nombre_negocio)')
            .order('creado_en', { ascending: false })
            .limit(200);
        if (error) throw error;
        if (!data || data.length === 0) {
            container.innerHTML = '<p>No hay comentarios de tenants todavía.</p>';
            return;
        }
        const categoriaLabels = { problema: 'Problema', sugerencia: 'Sugerencia', mejora: 'Mejora', otro: 'Otro' };
        const categoriaColors = { problema: '#e74c3c', sugerencia: '#f39c12', mejora: '#2ecc71', otro: '#9b59b6' };
        let html = '';
        data.forEach(f => {
            const tenantName = f.tenants?.nombre_negocio || 'Desconocido';
            const fecha = new Date(f.creado_en).toLocaleString();
            const cat = categoriaLabels[f.categoria] || f.categoria;
            const color = categoriaColors[f.categoria] || '#888888';
            html += `
                <div class="solicitud-item" data-id="${f.id}" style="margin-bottom:14px;">
                    <div class="solicitud-header">
                        <span class="solicitud-tenant"><i class="fas fa-building"></i> ${escapeHtml(tenantName)}</span>
                        <span style="margin-left:10px;background:${color}22;color:${color};border:1px solid ${color}55;padding:2px 10px;border-radius:20px;font-size:0.72rem;font-weight:600;">${escapeHtml(cat)}</span>
                        <span class="solicitud-fecha" style="margin-left:auto;">${fecha}</span>
                    </div>
                    <div class="solicitud-descripcion" style="white-space:pre-wrap;">${escapeHtml(f.mensaje)}</div>
                    <div class="solicitud-actions">
                        <button type="button" class="btn-secondary btn-small eliminar-feedback" data-id="${f.id}" data-tenant="${escapeHtml(tenantName)}"><i class="fas fa-trash"></i> Eliminar</button>
                    </div>
                </div>
            `;
        });
        container.innerHTML = html;
        document.querySelectorAll('.eliminar-feedback').forEach(btn => {
            btn.addEventListener('click', () => eliminarFeedbackSuper(btn.dataset.id, btn.dataset.tenant));
        });
    } catch (e) {
        console.error('Error cargando feedback:', e);
        container.innerHTML = '<p>Error al cargar comentarios.</p>';
    }
}

// Modal de doble confirmación (evita confirm() nativo bloqueado en Firefox)
function mostrarConfirmacionDoble(opciones) {
    return new Promise((resolve) => {
        let paso = 1;
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';
        const modal = document.createElement('div');
        modal.style.cssText = 'background:#1a1a2e;color:#fff;padding:32px;border-radius:16px;max-width:480px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.5);text-align:center;';
        const title = document.createElement('h3');
        title.style.cssText = 'margin:0 0 16px;font-size:1.2rem;color:#e74c3c;';
        const body = document.createElement('p');
        body.style.cssText = 'margin:0 0 20px;font-size:0.95rem;line-height:1.6;';
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:12px;justify-content:center;';
        const btnCancel = document.createElement('button');
        btnCancel.textContent = 'Cancelar';
        btnCancel.style.cssText = 'padding:10px 24px;border:none;border-radius:8px;background:#555;color:#fff;cursor:pointer;font-size:0.95rem;';
        const btnConfirm = document.createElement('button');
        btnConfirm.style.cssText = 'padding:10px 24px;border:none;border-radius:8px;background:#e74c3c;color:#fff;cursor:pointer;font-size:0.95rem;font-weight:600;';
        btnRow.appendChild(btnCancel);
        btnRow.appendChild(btnConfirm);
        modal.appendChild(title);
        modal.appendChild(body);
        modal.appendChild(btnRow);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        const cleanup = () => {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        };
        const renderPaso = () => {
            if (paso === 1) {
                title.innerHTML = '<i class="fas fa-exclamation-triangle"></i> ' + (opciones.titulo || 'CONFIRMAR');
                body.innerHTML = opciones.cuerpoPaso1 || '¿Deseas continuar?';
                btnConfirm.textContent = 'Continuar';
            } else {
                title.innerHTML = '<i class="fas fa-exclamation-triangle"></i> CONFIRMACIÓN FINAL';
                body.innerHTML = opciones.cuerpoPaso2 || '<strong style="color:#e74c3c;">Esta acción NO SE PUEDE DESHACER.</strong>';
                btnConfirm.textContent = opciones.textoConfirmar || 'Sí, confirmar';
            }
        };
        btnCancel.addEventListener('click', () => { cleanup(); resolve(false); });
        btnConfirm.addEventListener('click', () => {
            if (paso === 1) {
                paso = 2;
                renderPaso();
                return;
            }
            cleanup();
            resolve(true);
        });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { cleanup(); resolve(false); }
        });
        renderPaso();
    });
}

async function eliminarFeedbackSuper(feedbackId, tenantName) {
    if (!feedbackId) return;
    const confirmado = await mostrarConfirmacionDoble({
        titulo: 'ELIMINAR COMENTARIO',
        cuerpoPaso1: `Comentario de <strong>${escapeHtml(tenantName || 'Desconocido')}</strong>.<br><br>¿Deseas eliminarlo?`,
        cuerpoPaso2: '<strong style="color:#e74c3c;">Esta acción NO SE PUEDE DESHACER.</strong>',
        textoConfirmar: 'Sí, eliminar'
    });
    if (!confirmado) return;
    const client = supabaseClient || window.supabaseClient;
    if (!client) {
        mostrarToast('Error de conexión.', 'error');
        return;
    }
    try {
        const { error } = await client.from('tenant_feedback').delete().eq('id', feedbackId);
        if (error) throw error;
        mostrarToast('Comentario eliminado', 'success');
        cargarFeedbackSuper();
    } catch (e) {
        console.error('Error eliminando feedback:', e);
        mostrarToast('Error al eliminar el comentario.', 'error');
    }
}

// Exposición para harness de validación y consistencia con window.iniciarSuperAdmin
window.inicializarFeedbackWidget = inicializarFeedbackWidget;
window.inyectarTabFeedback = inyectarTabFeedback;
window.cargarFeedbackSuper = cargarFeedbackSuper;
window.enviarFeedback = enviarFeedback;
