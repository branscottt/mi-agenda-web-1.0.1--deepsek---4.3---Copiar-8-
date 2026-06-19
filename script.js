// ============================================
// CONFIGURACIÓN DE SUPABASE - VERSIÓN CORREGIDA
// ============================================
const supabaseUrl = 'https://dfcfimipkfhitlsyixqu.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRmY2ZpbWlwa2ZoaXRsc3lpeHF1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxNzczMzAsImV4cCI6MjA4ODc1MzMzMH0.1OviTiPxYIK83bbmrYVY1nUR2o0bxn_wfqnWqK4Ccw0';

console.log('URL:', supabaseUrl);
console.log('KEY:', supabaseKey.substring(0, 20) + '...');

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

function formatFechaCorta(dateStr) {
    try {
        const date = parseDate(dateStr);
        return date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
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
                    creadoEn: c.created_at
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
                .select('id, servicio_id, fecha, hora, precio, contacto, notificaciones, created_at')
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
                creadoEn: c.created_at
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

    async getAll(forceRefresh = false) {
        try {
            // Cache en memoria (valido 1 minuto)
            const ahora = Date.now();
            if (!forceRefresh && this._cachedVentas && (ahora - this._cacheTime) < this._CACHE_TTL) {
                return this._cachedVentas;
            }

            const tenantId = await getCurrentTenantId();
            if (!tenantId) return [];

            const { data, error } = await supabaseClient
                .from('citas')
                .select('id, servicio_id, precio, contacto, created_at, fecha, hora')
                .eq('tenant_id', String(tenantId).trim())
                .order('created_at', { ascending: false });

            if (error) {
                console.error('Error en VentasManager.getAll:', error);
                return [];
            }

            const ventas = (data || []).map(c => {
                const createdDate = new Date(c.created_at);
                return {
                    id: `VENTA-${c.id}`,
                    citaId: c.id,
                    servicioId: c.servicio_id,
                    servicioNombre: 'Servicio',
                    clienteNombre: c.contacto?.nombre || 'Cliente',
                    clienteEmail: c.contacto?.email || '',
                    clienteTelefono: c.contacto?.telefono || '',
                    fecha: c.fecha,
                    hora: c.hora,
                    monto: Number(c.precio) || 0,
                    fechaVenta: c.created_at,
                    mes: createdDate.getMonth() + 1,
                    año: createdDate.getFullYear(),
                    diaSemana: createdDate.getDay()
                };
            });

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
                .select('id, nombre, categoria, precio, descripcion, imagen, destacado, activo, disponibilidad, fechas, created_at')
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
                descripcion: s.descripcion || '',
                imagen: s.imagen || 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874',
                destacado: s.destacado || false,
                activo: s.activo !== false,
                disponibilidad: s.disponibilidad || {},
                fechas: s.fechas || Object.keys(s.disponibilidad || {}),
                fechaCreacion: s.created_at
            }));
        } catch (e) {
            console.error('Error en getAll servicios:', e);
            return [];
        }
    },
    
    async save(servicio) {
        try {
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
                disponibilidad: servicio.disponibilidad || {},
                fechas: Object.keys(servicio.disponibilidad || {})
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
                .select('id, tipo, cita_id, fecha_original, hora_original, fecha_nueva, hora_nueva, cliente, leido, creado_en')
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
        if (!endDate && data.plan && planesData[data.plan]?.duracionMeses) {
            const duracionMeses = planesData[data.plan].duracionMeses;
            const calculatedEnd = new Date();
            calculatedEnd.setMonth(calculatedEnd.getMonth() + duracionMeses);
            endDate = calculatedEnd.toISOString();
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
    /**
     * Carga la configuración visual del tenant actual
     * @returns {Promise<Object>} Configuración con primary_color, secondary_color, logo_url, custom_css
     */
    async loadConfig() {
        try {
            const tenantId = await getCurrentTenantId();
            if (!tenantId) return this.getDefaultConfig();
            
            // Intentar desde localStorage (caché de sesión)
            const cached = localStorage.getItem(`tenant_config_${tenantId}`);
            if (cached) {
                try {
                    const parsed = JSON.parse(cached);
                    if (parsed && parsed.primary_color) return parsed;
                } catch(e) {}
            }
            
            const { data, error } = await supabaseClient
                .from('tenant_config')
                .select('primary_color, secondary_color, logo_url, custom_css')
                .eq('tenant_id', tenantId)
                .maybeSingle();
                
            if (error) throw error;
            
            let config = this.getDefaultConfig();
            if (data) {
                config = {
                    primary_color: data.primary_color || config.primary_color,
                    secondary_color: data.secondary_color || config.secondary_color,
                    logo_url: data.logo_url || config.logo_url,
                    custom_css: data.custom_css || config.custom_css
                };
            }
            // Guardar en caché
            localStorage.setItem(`tenant_config_${tenantId}`, JSON.stringify(config));
            return config;
        } catch (e) {
            console.error('Error cargando configuración visual:', e);
            return this.getDefaultConfig();
        }
    },
    
    getDefaultConfig() {
        return {
            primary_color: '#9d4edd',
            secondary_color: '#ff6d00',
            logo_url: '',
            custom_css: ''
        };
    },
    
        /**
     * Guarda la configuración visual del tenant actual
     * @param {Object} config - { primary_color, secondary_color, logo_url, custom_css }
     * @returns {Promise<boolean>}
     */
    async saveConfig(config) {
        try {
            // ========== NUEVO: Verificar plan antes de guardar ==========
            const suscripcion = await SuscripcionManager.getCurrent();
            if (!suscripcion || (suscripcion.plan !== 'pro' && suscripcion.plan !== 'premium_anual')) {
                mostrarToast('No tienes permisos para personalizar. Actualiza a un plan de pago.', 'error');
                return false;
            }
            // ============================================================

            const tenantId = await getCurrentTenantId();
            if (!tenantId) throw new Error('No tenant ID');
            
            // Limpiar valores vacíos
            const cleanConfig = {
                tenant_id: tenantId,
                primary_color: config.primary_color || this.getDefaultConfig().primary_color,
                secondary_color: config.secondary_color || this.getDefaultConfig().secondary_color,
                logo_url: config.logo_url || null,
                custom_css: config.custom_css || null
            };
            
            // Upsert
            const { error } = await supabaseClient
                .from('tenant_config')
                .upsert(cleanConfig, { onConflict: 'tenant_id' });
                
            if (error) throw error;
            
            // Actualizar caché
            localStorage.setItem(`tenant_config_${tenantId}`, JSON.stringify({
                primary_color: cleanConfig.primary_color,
                secondary_color: cleanConfig.secondary_color,
                logo_url: cleanConfig.logo_url,
                custom_css: cleanConfig.custom_css
            }));
            
            // Aplicar estilos inmediatamente
            this.applyStyles(cleanConfig);
            return true;
        } catch (e) {
            console.error('Error guardando configuración visual:', e);
            return false;
        }
    },

    // Dentro de const VisualConfigManager = { ... }
async loadConfigForTenant(tenantId) {
    if (!tenantId) return this.getDefaultConfig();
    try {
        const cached = localStorage.getItem(`tenant_config_${tenantId}`);
        if (cached) {
            const parsed = JSON.parse(cached);
            if (parsed && parsed.primary_color) return parsed;
        }
        const { data, error } = await supabaseClient
            .from('tenant_config')
            .select('primary_color, secondary_color, logo_url, custom_css')
            .eq('tenant_id', tenantId)
            .maybeSingle();
        if (error) throw error;
        let config = this.getDefaultConfig();
        if (data) {
            config = {
                primary_color: data.primary_color || config.primary_color,
                secondary_color: data.secondary_color || config.secondary_color,
                logo_url: data.logo_url || config.logo_url,
                custom_css: data.custom_css || config.custom_css
            };
        }
        localStorage.setItem(`tenant_config_${tenantId}`, JSON.stringify(config));
        return config;
    } catch (e) {
        console.error('Error cargando configuración para tenant', tenantId, e);
        return this.getDefaultConfig();
    }
},

async saveConfigForTenant(tenantId, config) {
    if (!tenantId) throw new Error('Tenant ID requerido');
    try {
        const cleanConfig = {
            tenant_id: tenantId,
            primary_color: config.primary_color || this.getDefaultConfig().primary_color,
            secondary_color: config.secondary_color || this.getDefaultConfig().secondary_color,
            logo_url: config.logo_url || null,
            custom_css: config.custom_css || null
        };
        const { error } = await supabaseClient
            .from('tenant_config')
            .upsert(cleanConfig, { onConflict: 'tenant_id' });
        if (error) throw error;
        localStorage.setItem(`tenant_config_${tenantId}`, JSON.stringify({
            primary_color: cleanConfig.primary_color,
            secondary_color: cleanConfig.secondary_color,
            logo_url: cleanConfig.logo_url,
            custom_css: cleanConfig.custom_css
        }));
        return true;
    } catch (e) {
        console.error('Error guardando configuración para tenant', tenantId, e);
        return false;
    }
},
    
    /**
     * Aplica los estilos dinámicos al documento
     * @param {Object} config 
     */
    applyStyles(config) {
        // Remover bloque de estilos personalizados anterior si existe
        const oldStyle = document.getElementById('tenant-custom-styles');
        if (oldStyle) oldStyle.remove();
        
        // Crear nuevo bloque <style>
        const styleEl = document.createElement('style');
        styleEl.id = 'tenant-custom-styles';
        
        let cssRules = `
            :root {
                --primary-color: ${config.primary_color};
                --secondary-color: ${config.secondary_color};
                --primary-glow: ${config.primary_color}80;
            }
            /* Ajustes adicionales para botones y bordes */
            .btn-grad {
                background: linear-gradient(90deg, ${config.primary_color}, ${config.secondary_color}) !important;
            }
            .btn-grad:hover {
                background: linear-gradient(90deg, ${config.secondary_color}, ${config.primary_color}) !important;
            }
            .stat-box::before {
                background: linear-gradient(to bottom, ${config.primary_color}, ${config.secondary_color});
            }
            .calendar-day.selected {
                background: ${config.primary_color};
            }
            .service-card-category.belleza,
            .service-card-category.bienestar,
            .service-card-category.salud {
                border-color: ${config.primary_color};
                color: ${config.primary_color};
            }
        `;
        
        if (config.custom_css && config.custom_css.trim()) {
            cssRules += `\n/* Custom CSS del tenant */\n${config.custom_css}`;
        }
        
        styleEl.textContent = cssRules;
        document.head.appendChild(styleEl);
        
        // Actualizar logo si existe
        this.updateLogo(config.logo_url);
    },
    
    updateLogo(logoUrl) {
    // Buscar todos los elementos con clase 'tenant-logo' que sean imágenes
    const logoImages = document.querySelectorAll('.tenant-logo img, img.tenant-logo');
    logoImages.forEach(img => {
        if (logoUrl && logoUrl.trim() !== '') {
            img.src = logoUrl;
            img.style.display = 'inline-block';
        } else {
            img.style.display = 'none';
        }
    });

    // Opcional: también soportar elementos con background-image
    const logoBgElements = document.querySelectorAll('.tenant-logo-bg');
    logoBgElements.forEach(el => {
        if (logoUrl && logoUrl.trim() !== '') {
            el.style.backgroundImage = `url('${logoUrl}')`;
            el.style.backgroundSize = 'contain';
            el.style.backgroundRepeat = 'no-repeat';
            el.style.backgroundPosition = 'center';
        } else {
            el.style.backgroundImage = 'none';
        }
    });

    if (logoUrl && logoUrl.trim() !== '') {
        console.log('Logo actualizado:', logoUrl);
    } else {
        console.log('Logo no configurado (omitido)');
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
        features: ['Hasta 10 servicios', 'Hasta 50 citas/mes', 'Soporte email'], 
        color: '#00b894',
        soloSuperAdmin: true   // ← nuevo flag
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

async function cargarPlanes() {
    const container = document.getElementById('planes-container');
    if (!container) return;

    // Esperar a que supabaseClient esté listo
    if (!supabaseClient) {
        await initSupabase();
    }

    // Obtener parámetros de URL
    const urlParams = new URLSearchParams(window.location.search);
    const isNewAdmin = urlParams.get('new') === 'true';
    const tenantIdFromUrl = urlParams.get('tenant_id');

    // Obtener sesión usando JwtManager o fallback
    let session = null;
    let rol = null;
    let tenantId = null;
    let suscripcionActual = null;
    const esSuperAdmin = false;

    try {
        const result = JwtManager.getSession();
        session = result?.data?.session || null;
        if (session) {
            rol = session.user?.user_metadata?.rol;
            tenantId = session.user?.user_metadata?.tenant_id;
        }
    } catch (e) {
        console.warn('[cargarPlanes] Error obteniendo sesión:', e.message);
    }

    // Para un nuevo admin que viene del registro, usar tenant_id de URL
    if (isNewAdmin && tenantIdFromUrl && !session) {
        tenantId = tenantIdFromUrl;
    } else if (rol === 'admin' && tenantId) {
        try {
            suscripcionActual = await SuscripcionManager.getCurrent();
        } catch (e) {
            console.warn('[cargarPlanes] Error obteniendo suscripción:', e.message);
        }
    }

    let html = '<div class="stats-container" style="grid-template-columns: repeat(3,1fr); gap: 25px;">';
    
    for (const [key, plan] of Object.entries(planesData)) {
        if (plan.soloSuperAdmin && !esSuperAdmin) continue;
        
        const isCurrent = suscripcionActual && suscripcionActual.plan === key;
        html += `
            <div class="stat-box plan-card" data-plan="${key}" style="text-align: center; border-top: 4px solid ${plan.color};">
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
}

// Nueva función para crear suscripción inicial (alta de nuevo admin)
async function crearSuscripcionInicial(planKey, tenantId) {
    if (planKey === 'freemium') {
        mostrarToast('El plan Freemium no está disponible para nuevos administradores', 'error');
        return;
    }
    const duracionMeses = planesData[planKey]?.duracionMeses;
    let endDate = null;
    if (duracionMeses) {
        endDate = new Date();
        endDate.setMonth(endDate.getMonth() + duracionMeses);
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
        mostrarToast(`Plan ${planesData[planKey].nombre} activado correctamente`, 'success');
        // Redirección inmediata: usar replace() evita que "atrás" vuelva a planes.html
        // El parámetro ?subscription_created=true le indica a admin.html que salte la validación
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

    const suscripcion = await SuscripcionManager.getCurrent();
    if (!suscripcion) {
        mostrarToast('No se encontró suscripción activa. Crea una nueva.', 'error');
        return;
    }

    const nuevoPlan = planKey; // 'freemium', 'pro', 'premium_anual'
    const planAnterior = suscripcion.plan;
    const tenantId = suscripcion.tenant_id;

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
    
    const ventasSemana = await VentasManager.getSemana();
    const totalSemana = VentasManager.calcularTotal(ventasSemana);
    document.getElementById('valor-semanal').textContent = formatearPeso(totalSemana);
    document.getElementById('detalle-semanal').textContent = `${ventasSemana.length} venta${ventasSemana.length !== 1 ? 's' : ''}`;
    
    const ventasMes = await VentasManager.getMes();
    const totalMes = VentasManager.calcularTotal(ventasMes);
    document.getElementById('valor-mensual').textContent = formatearPeso(totalMes);
    document.getElementById('detalle-mensual').textContent = `${ventasMes.length} venta${ventasMes.length !== 1 ? 's' : ''}`;
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

async function renderizarGraficoVentas() {
    const canvas = document.getElementById('ventas-chart');
    if (!canvas) {
        console.error('Canvas no encontrado');
        return;
    }
    
    // Destruir gráfico anterior si existe
    if (window.ventasChart) {
        window.ventasChart.destroy();
    }
    
    // Datos de prueba
    const ctx = canvas.getContext('2d');
    window.ventasChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'],
            datasets: [{
                label: 'Ventas',
                data: [65000, 59000, 80000, 81000, 56000, 95000, 120000],
                borderColor: '#b300ff',
                backgroundColor: 'rgba(179, 0, 255, 0.1)',
                tension: 0.3,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false
        }
    });
    
    console.log('✅ Gráfico de prueba renderizado');
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

// Sobrescribir iniciarAdmin

// Sobrescribir iniciarAdmin solo en admin.html (no en superadmin)
if (document.querySelector('.admin-screen') && !document.querySelector('.superadmin-screen')) {
    const originalIniciarAdmin = window.iniciarAdmin;
    window.iniciarAdmin = async function() {
        if (originalIniciarAdmin) await originalIniciarAdmin();
        inicializarFechasDashboard();
        await actualizarDashboardFinanzas();
        configurarDashboardEventos();
    };
}

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

async function finalizarCita(citaId) {
    const citas = await CitasManager.getAll();
    const cita = citas.find(c => String(c.id) === String(citaId));
    
    if (cita && await CitasManager.finalizar(citaId)) {
        await VentasManager.registrarDesdeCita(cita);
        
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

    if (await CitasManager.finalizar(citaId)) {
        if (typeof renderAdminAppointments === 'function') renderAdminAppointments();
        if (typeof updateProjectedRevenue === 'function') updateProjectedRevenue();
        if (typeof renderCarrito === 'function') renderCarrito();
        
        mostrarToast('Cita marcada como No Asistió. Cupo liberado.', 'info');
    }
}
window.noAsistioCita = noAsistioCita;

// ============================================
// RENDERIZADO DE NOTIFICACIONES (modificado para async)
// ============================================
async function renderNotificaciones(lista, containerId) {
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
    const noLeidas = notifsAdmin.filter(n => !n.leido);
    
    const todas = [
        ...lista.map(c => ({ ...c, tipoOrigen: 'reserva' })),
        ...noLeidas.map(n => ({ ...n, tipoOrigen: 'cambio' }))
    ];

    if (todas.length === 0) {
        container.innerHTML = '<p class="empty">✨ No hay notificaciones pendientes</p>';
        return;
    }

    todas.sort((a, b) => new Date(b.creadoEn || 0) - new Date(a.creadoEn || 0));

    let html = '';
    todas.forEach(item => {
        if (item.tipoOrigen === 'reserva') {
            const nombre = item.contacto?.nombre || item.nombreCliente || 'Cliente';
            const telefono = item.contacto?.telefono || item.telefonoCliente || '';
            const email = item.contacto?.email || '';
            const servicio = item.nombre || item.servicioNombre || 'Servicio';
            const fecha = item.fecha || '—';
            const hora = item.hora || '—';

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
                        ${email ? `<a href="${mailtoLink}" target="_blank" class="btn-notify email" data-tipo="email"><i class="fas fa-envelope"></i> Email</a>` : ''}
                        ${telefono ? `<a href="${waLink}" target="_blank" class="btn-notify whatsapp" data-tipo="whatsapp"><i class="fab fa-whatsapp"></i> WhatsApp</a>` : ''}
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

            const asuntoEmail = encodeURIComponent(`Confirmación de reserva: ${servicio}`);
            const cuerpoEmail = encodeURIComponent(`Hola ${nombre},\n\nTe confirmamos tu reserva para ${servicio} el ${fecha} a las ${hora}.\n\nGracias.`);
            const mailtoLink = `mailto:${email}?subject=${asuntoEmail}&body=${cuerpoEmail}`;

            const mensajeWhatsApp = encodeURIComponent(`Hola ${nombre}, recordatorio: tienes una cita de ${servicio} el ${fecha} a las ${hora}.`);
            const waLink = `https://wa.me/${telefono.replace(/\D/g, '')}?text=${mensajeWhatsApp}`;

            html += `
                <div class="notification-item new-reservation notif-email" data-notif-id="${item.id}" data-origen="reserva">
                    <div class="notification-info">
                        <strong>🆕 Nueva reserva</strong>
                        <span>${nombre} - ${servicio} - ${fecha} ${hora}</span>
                    </div>
                    <div class="notification-actions">
                        ${email ? `<a href="${mailtoLink}" target="_blank" class="btn-notify email" data-tipo="email"><i class="fas fa-envelope"></i> Email</a>` : ''}
                        ${telefono ? `<a href="${waLink}" target="_blank" class="btn-notify whatsapp" data-tipo="whatsapp"><i class="fab fa-whatsapp"></i> WhatsApp</a>` : ''}
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

            const asuntoEmail = encodeURIComponent('Cambio en tu cita - Agenda Pro');
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
                    </div>
                </div>
            `;
        }
    });

    container.innerHTML = html;

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
            await CitasManager.upsert(cita);
            
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
    const citas = await CitasManager.getAll();
    const ahora = new Date();
    const limiteNuevas = 24 * 60 * 60 * 1000;

    const nuevas = citas.filter(c => {
        const emailNoEnviado = !c.notificaciones || c.notificaciones.emailEnviado === false;
        if (!emailNoEnviado) return false;
        
        const creado = new Date(c.creadoEn || 0);
        return (ahora - creado) <= limiteNuevas;
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

    const notifsAdmin = await NotificacionesAdminManager.getAll();
    const noLeidas = notifsAdmin.filter(n => !n.leido);

    const notificaciones = [
        ...nuevas.map(c => ({ ...c, tipo: 'nueva' })),
        ...proximas.map(c => ({ ...c, tipo: 'proxima' }))
    ];

    renderNotificaciones(notificaciones);
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
        
        const { data: { session } } = JwtManager.getSession();
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
            rol: (session.user.email && ['super@demo.com'].includes(session.user.email)) ? 'super_admin' : (session.user.user_metadata?.rol || 'cliente'),
            tenant_id: session.user.user_metadata?.tenant_id
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
        const pathname = (window.location.pathname || '').split('/').pop() || '';

        console.log('Verificando ruta:', pathname, 'Sesión:', session ? '✅' : '❌', 'Rol:', session?.rol);

        // Si NO hay sesión
        if (!session) {
            // Permitir acceso solo a login.html
            if (pathname !== 'login.html' && pathname !== '') {
                console.log('No hay sesión, redirigiendo a login');
                window.location.href = 'login.html';
            }
            return;
        }

        // Si HAY sesión
        if (session) {
           
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

            // Si es super_admin, solo puede ver superadmin.html
            if (session.rol === 'super_admin') {
                if (pathname !== 'superadmin.html' && pathname !== 'login.html') {
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

    // ========== NUEVO: Verificar plan de suscripción y restringir personalización ==========
    let suscripcion = null;
    let esPlanPago = false;
    try {
        suscripcion = await SuscripcionManager.getCurrent();
        esPlanPago = suscripcion && (suscripcion.plan === 'pro' || suscripcion.plan === 'premium_anual');
    } catch(e) {
        console.warn('Error obteniendo suscripción:', e);
    }

    const primaryInput = document.getElementById('primary-color');
    const secondaryInput = document.getElementById('secondary-color');
    const logoInput = document.getElementById('logo-url');
    const customCssTextarea = document.getElementById('custom-css');
    const saveBtn = document.querySelector('#customization-form button[type="submit"]');
    const resetBtn = document.getElementById('reset-customization');
    const formFields = [primaryInput, secondaryInput, logoInput, customCssTextarea];

    if (!esPlanPago) {
        // Deshabilitar campos y botón guardar
        formFields.forEach(field => { if (field) field.disabled = true; });
        if (saveBtn) saveBtn.disabled = true;
        if (resetBtn) resetBtn.disabled = true;
        // Mostrar mensaje de upgrade
        let upgradeMsg = document.getElementById('upgrade-message');
        if (!upgradeMsg) {
            upgradeMsg = document.createElement('div');
            upgradeMsg.id = 'upgrade-message';
            upgradeMsg.className = 'warning-message';
            upgradeMsg.style.cssText = 'background: rgba(255,193,7,0.2); border-left: 4px solid #ffc107; padding: 12px; margin: 15px 0; border-radius: 8px;';
            upgradeMsg.innerHTML = `⚠️ <strong>Personalización visual disponible en planes Pro y Premium.</strong> <a href="planes.html" style="color: #ffc107;">Actualiza tu plan aquí</a>`;
            const form = document.getElementById('customization-form');
            if (form) form.parentNode.insertBefore(upgradeMsg, form);
        }
    } else {
        // Asegurar que los campos estén habilitados (por si se recarga)
        formFields.forEach(field => { if (field) field.disabled = false; });
        if (saveBtn) saveBtn.disabled = false;
        if (resetBtn) resetBtn.disabled = false;
        const existingMsg = document.getElementById('upgrade-message');
        if (existingMsg) existingMsg.remove();
    }

    // ========== NUEVO: Mostrar/ocultar botón de solicitud CSS según plan ==========
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

    // ========== RELLENAR FORMULARIO DE PERSONALIZACIÓN (solo si existen los campos) ==========
    if (primaryInput) primaryInput.value = visualConfig.primary_color;
    if (secondaryInput) secondaryInput.value = visualConfig.secondary_color;
    if (logoInput) logoInput.value = visualConfig.logo_url || '';
    if (customCssTextarea) customCssTextarea.value = visualConfig.custom_css || '';

    // Listener en tiempo real para el logo
    if (logoInput) {
        logoInput.addEventListener('input', (e) => {
            VisualConfigManager.updateLogo(e.target.value);
        });
    }

    // ========== DELEGAR VISTA PRINCIPAL A DASHBOARDVIEW MODULAR ==========
    const mainContainer = document.getElementById('dynamic-content');
    if (mainContainer) {
        try {
            const { renderDashboard } = await import('./src/dashboard/ui/DashboardView.js');
            // No reemplazar HTML - el dashboard se inyecta dentro del contenedor
            // manteniendo los elementos pre-existentes como sidebar, header, etc.
        } catch (e) {
            console.error('DashboardView no disponible, usando renderizado legacy:', e);
        }
    }

    // ========== SESIÓN Y PERMISOS ==========
    const session = await getSession();

    // Verificar si el usuario viene de OAuth y no tiene tenant_id
    if (session && (!session.tenant_id || session.tenant_id === '')) {
        console.log('Usuario sin tenant_id, buscando o creando tenant por email...');
        
        // Buscar tenant existente por email_contacto
        let { data: tenant, error: tenantError } = await supabaseClient
            .from('tenants')
            .select('id')
            .eq('email_contacto', session.email)
            .maybeSingle();
        
        if (tenantError) {
            console.error('Error buscando tenant:', tenantError);
            mostrarToast('Error al verificar tu cuenta. Contacta al soporte.', 'error');
            await supabaseClient.auth.signOut();
            window.location.href = 'login.html';
            return;
        }
        
        // Si no existe, crear un nuevo tenant
        if (!tenant) {
            console.log('No se encontró tenant, creando uno nuevo...');
            const nombreNegocio = session.nombre || session.email.split('@')[0] + "'s negocio";
            const { data: newTenant, error: createError } = await supabaseClient
                .from('tenants')
                .insert({
                    nombre_negocio: nombreNegocio,
                    email_contacto: session.email,
                    plan: null
                })
                .select()
                .single();
            
            if (createError) {
                console.error('Error creando tenant:', createError);
                mostrarToast('Error al crear tu negocio. Intenta nuevamente.', 'error');
                await supabaseClient.auth.signOut();
                window.location.href = 'login.html';
                return;
            }
            tenant = newTenant;
        }
        
        // Actualizar metadatos del usuario con tenant_id y rol admin
        const { error: updateError } = await supabaseClient.auth.updateUser({
            data: {
                tenant_id: tenant.id,
                rol: 'admin',
                nombre: session.nombre || session.email.split('@')[0]
            }
        });
        if (updateError) {
            console.error('Error actualizando metadatos:', updateError);
            mostrarToast('Error al configurar tu cuenta. Contacta al soporte.', 'error');
            await supabaseClient.auth.signOut();
            window.location.href = 'login.html';
            return;
        }
        
        // Refrescar sesión para obtener nuevos metadatos
        await supabaseClient.auth.refreshSession();
        
        // Redirigir a planes.html para elegir plan (solo si es un tenant nuevo)
        // Si ya existía el tenant, asumimos que ya eligió plan y redirigimos a admin
        // Delay de 500ms para asegurar que los metadatos se propaguen
        setTimeout(() => {
            if (!tenant) {
                window.location.href = `planes.html?tenant_id=${tenant.id}&new=true`;
            } else {
                window.location.href = 'admin.html';
            }
        }, 500);
        return;
    }

    if (!session || (session.rol !== 'admin' && session.rol !== 'super_admin')) {
        console.log('No hay sesión de admin/superadmin, redirigiendo...');
        window.location.href = 'login.html';
        return;
    }

    // ========== VALIDAR SUSCRIPCIÓN ACTIVA (solo para admins) ==========
    if (session.rol === 'admin') {
        // Si acabamos de crear una suscripción, damos tiempo para que Supabase propague
        const urlParams = new URLSearchParams(window.location.search);
        const justSubscribed = urlParams.get('subscription_created') === 'true';
        if (justSubscribed) {
            history.replaceState({}, '', window.location.pathname); // limpiar parámetro
            console.log('🕐 Suscripción recién creada, esperando propagación...');
            // Esperar 500ms y refrescar la sesión
            await new Promise(r => setTimeout(r, 500));
            const { data: refreshed } = JwtManager.getSession();
            if (refreshed?.session) {
                console.log('🕐 Sesión refrescada. Continuando sin validación de suscripción.');
                // Saltamos la validación — la suscripción acaba de crearse
            } else {
                // Si no hay sesión, redirigir a login
                window.location.href = 'login.html';
                return;
            }
        } else {
            const suscripcionActiva = await SuscripcionManager.getCurrent();
            if (!suscripcionActiva || suscripcionActiva.status !== 'active') {
                mostrarToast('No tienes una suscripción activa. Selecciona un plan para continuar.', 'warning');
                window.location.href = 'planes.html';
                return;
            }
        }
    }
    // ================================================================

    const permisosOK = await verificarPermisosAdmin();
    if (!permisosOK) {
        mostrarToast('⚠️ Problema de permisos. Revisa las políticas RLS en Supabase.', 'warning');
    }
    
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

    // ========== BOTÓN CANCELAR SUSCRIPCIÓN ==========
    const cancelBtn = document.getElementById('cancel-subscription-btn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', async () => {
            if (!confirm('¿Cancelar tu suscripción activa? Podrás volver a activarla más tarde desde "Cambiar plan".')) return;
            const suscripcion = await SuscripcionManager.getCurrent();
            if (!suscripcion) {
                mostrarToast('No hay suscripción activa', 'error');
                return;
            }
            const ok = await SuscripcionManager.cancel(suscripcion.id);
            if (ok) {
                mostrarToast('Suscripción cancelada. Tu plan pasará a inactivo.', 'success');
                await cargarSuscripcionTenant();
                if (typeof cargarPlanes === 'function') cargarPlanes();
            } else {
                mostrarToast('Error al cancelar suscripción', 'error');
            }
        });
    }
    
    // ========== CONFIGURAR EVENTOS DEL FORMULARIO DE PERSONALIZACIÓN ==========
    const customForm = document.getElementById('customization-form');
    if (customForm) {
        customForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const newConfig = {
                primary_color: document.getElementById('primary-color').value,
                secondary_color: document.getElementById('secondary-color').value,
                logo_url: document.getElementById('logo-url').value,
                custom_css: document.getElementById('custom-css').value
            };
            const success = await VisualConfigManager.saveConfig(newConfig);
            const feedback = document.getElementById('customization-feedback');
            if (success) {
                feedback.textContent = '✅ Configuración guardada y aplicada.';
                feedback.className = 'success';
                setTimeout(() => feedback.textContent = '', 3000);
            } else {
                feedback.textContent = '❌ Error al guardar. Revisa consola.';
                feedback.className = 'error';
            }
        });
        
        const resetBtnForm = document.getElementById('reset-customization');
        if (resetBtnForm) {
            resetBtnForm.addEventListener('click', async () => {
                const defaultConfig = VisualConfigManager.getDefaultConfig();
                const primaryInput = document.getElementById('primary-color');
                const secondaryInput = document.getElementById('secondary-color');
                const logoInput = document.getElementById('logo-url');
                const customCssTextarea = document.getElementById('custom-css');
                if (primaryInput) primaryInput.value = defaultConfig.primary_color;
                if (secondaryInput) secondaryInput.value = defaultConfig.secondary_color;
                if (logoInput) logoInput.value = '';
                if (customCssTextarea) customCssTextarea.value = '';
                const success = await VisualConfigManager.saveConfig(defaultConfig);
                const feedback = document.getElementById('customization-feedback');
                if (success) {
                    feedback.textContent = '✅ Configuración restablecida a valores por defecto.';
                    feedback.className = 'success';
                } else {
                    feedback.textContent = '❌ Error al restablecer.';
                    feedback.className = 'error';
                }
            });
        }
    }

    // Inicializar sección de compartir enlace
    configurarCompartirEnlace();

    console.log('Admin/SuperAdmin iniciado correctamente');
}
window.iniciarAdmin = iniciarAdmin;

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
    if (typeof window.iniciarSuperAdminFallback === 'function') {
        await window.iniciarSuperAdminFallback();
    } else {
        // Fallback inline si no existe
        await cargarTenants();
        await cargarEstadisticasGlobales();
        await cargarMetricasGlobales();
        const fnSetup = window.setupSuperAdminTabs || setupSuperAdminTabs;
        if (typeof fnSetup === 'function') fnSetup();
        
        // Configurar botones del modal de tenant
        configurarModalTenant();
    }
    
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
    
    try {
        const { data: tenants, error } = await supabaseClient
            .from('tenants')
            .select(`
                *,
                subscriptions ( id, plan, status, start_date, end_date )
            `)
            .order('fecha_registro', { ascending: false });
        
        if (error) throw error;
        if (!tenants || tenants.length === 0) {
            container.innerHTML = '<p>No hay tenants registrados</p>';
            return;
        }
        
        const planDisplayNames = {
            'freemium': 'Freemium',
            'pro': 'Pro',
            'premium_anual': 'Premium Anual'
        };
        
        let html = '';
        tenants.forEach(t => {
            let activeSub = t.subscriptions?.find(sub => sub.status === 'active') || t.subscriptions?.[0];
            const planKey = activeSub ? activeSub.plan : (t.plan || 'freemium');
            const planDisplay = planDisplayNames[planKey] || planKey;
            const statusSub = activeSub ? activeSub.status : 'active';
            const endDate = activeSub?.end_date ? new Date(activeSub.end_date).toLocaleDateString() : 'N/A';
            
            html += `
                <div class="tenant-card glass-panel" style="padding:20px;">
                    <div class="tenant-header">
                        <h4>${escapeHtml(t.nombre_negocio)}</h4>
                        <span class="badge ${planKey}">${planDisplay}</span>
                    </div>
                    <p><i class="fas fa-envelope"></i> ${escapeHtml(t.email_contacto || 'N/A')}</p>
                    <p><i class="fas fa-calendar"></i> Registro: ${new Date(t.fecha_registro).toLocaleDateString()}</p>
                    <p><i class="fas fa-ticket-alt"></i> Suscripción: ${statusSub} ${endDate !== 'N/A' ? `(hasta ${endDate})` : ''}</p>
                    <div class="tenant-actions" style="margin-top:15px;">
                        <i class="fas fa-edit edit-tenant" data-id="${t.id}" style="cursor:pointer; color:#ffc107; margin-right:10px;"></i>
                        <i class="fas fa-trash delete-tenant" data-id="${t.id}" style="cursor:pointer; color:#e74c3c;"></i>
                        <i class="fas fa-credit-card manage-sub" data-id="${t.id}" style="cursor:pointer; color:#b300ff; margin-left:10px;"></i>
                    </div>
                </div>
            `;
        });
        
        container.innerHTML = html;
        
        // Eventos
        document.querySelectorAll('.edit-tenant').forEach(icon => {
            icon.addEventListener('click', () => abrirModalEditarTenant(icon.dataset.id));
        });
        document.querySelectorAll('.delete-tenant').forEach(icon => {
            icon.addEventListener('click', () => eliminarTenant(icon.dataset.id));
        });
        document.querySelectorAll('.manage-sub').forEach(icon => {
            icon.addEventListener('click', () => abrirModalGestionSuscripcion(icon.dataset.id));
        });
        
    } catch (error) {
        console.error('Error en cargarTenants:', error);
    }
}

// Asegurar que la función sea global
window.cargarTenants = cargarTenants;

// Variable global para el modal
let currentSubTenantId = null;

async function abrirModalGestionSuscripcion(tenantId) {
    currentSubTenantId = tenantId;
    document.getElementById('subscription-modal-title').textContent = 'Gestionar Suscripción';
    document.getElementById('sub-tenant-id').value = tenantId;
    
    // === NUEVO: actualizar las opciones del select con los planes correctos ===
    document.getElementById('sub-plan').innerHTML = `
        <option value="freemium">Freemium</option>
        <option value="pro">Pro ($5.000/mes)</option>
        <option value="premium_anual">Premium Anual ($36.000/año)</option>
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
    }
}

// Event listeners del modal
document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('subscription-modal');
    if (modal) {
        modal.querySelector('.modal-close').addEventListener('click', () => modal.style.display = 'none');
        document.getElementById('cancel-sub-modal')?.addEventListener('click', () => modal.style.display = 'none');
        document.getElementById('save-subscription')?.addEventListener('click', guardarSuscripcion);
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
        document.getElementById('users-list-body').innerHTML = '<tr><td colspan="5">Error cargando usuarios. Asegúrate de tener la vista "usuarios_con_rol".</td></tr>';
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
                <select onchange="cambiarRol('${u.id}', this.value)" class="filter-select" style="padding:4px;">
                    <option value="cliente" ${u.rol === 'cliente' ? 'selected' : ''}>Cliente</option>
                    <option value="admin" ${u.rol === 'admin' ? 'selected' : ''}>Admin</option>
                    <option value="super_admin" ${u.rol === 'super_admin' ? 'selected' : ''}>Super Admin</option>
                </select>
                ${u.rol !== 'super_admin' ? `<button class="btn-small danger" style="margin-left:8px;" onclick="eliminarUsuario('${u.id}')"><i class="fas fa-trash"></i></button>` : ''}
            </td>
        </tr>`;
    });
    tbody.innerHTML = html;
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

    // Función de cierre (única, reutilizable)
    const cerrarModal = () => {
        modal.style.display = 'none';
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

    // Abrir modal para nuevo tenant
    if (btnNew && !btnNew._listener) {
        const abrirNuevo = () => {
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

    // Manejo del formulario (crear/editar)
    if (form && !form._listener) {
        form._listener = async (e) => {
            e.preventDefault();
            const id = document.getElementById('tenant-id').value;
            const data = {
                nombre_negocio: document.getElementById('tenant-nombre').value,
                email_contacto: document.getElementById('tenant-email').value,
                plan: document.getElementById('tenant-plan').value,
                estado: document.getElementById('tenant-estado').value
            };

            let result;
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

            if (result.error) {
                mostrarToast('Error: ' + result.error.message, 'error');
            } else {
                mostrarToast(id ? 'Tenant actualizado' : 'Tenant creado', 'success');
                cerrarModal();
                if (typeof cargarTenants === 'function') await cargarTenants();
                if (typeof cargarUsuarios === 'function') await cargarUsuarios();
                if (typeof cargarEstadisticasGlobales === 'function') await cargarEstadisticasGlobales();
            }
        };
        form.addEventListener('submit', form._listener);
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
    if (!confirm('¿Eliminar este tenant? Se perderán todos sus servicios y citas.')) return;
    let error;
    if (window.__tenantsApi?.delete) {
        const result = await window.__tenantsApi.delete(id);
        error = result.error;
    } else {
        const result = await supabaseClient
            .from('tenants')
            .delete()
            .eq('id', id);
        error = result.error;
    }
    if (error) {
        mostrarToast('Error: ' + error.message, 'error');
    } else {
        mostrarToast('Tenant eliminado', 'success');
        await cargarTenants();
        await cargarUsuarios();
    }
}

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
    form.addEventListener('submit', function(evento) { evento.preventDefault(); crearServicio(); });
    const btnLimpiarImg = document.getElementById('clear-image');
    if (btnLimpiarImg) {
        btnLimpiarImg.addEventListener('click', function() { document.getElementById('srv-image-url').value = ''; });
    }
    const capInput = document.getElementById('srv-capacity');
    if (capInput) capInput.disabled = false;
}
window.configurarFormulario = configurarFormulario;

async function crearServicio() {
    const nombre = document.getElementById('srv-name').value;
    const precio = document.getElementById('srv-price').value;
    const activo = document.getElementById('srv-active').checked;

    if (!nombre || !precio) {
        mostrarMensaje("Por favor completa todos los campos obligatorios", "error");
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
            // Hacer scroll al área de asignación
            const saveArea = document.getElementById('assignment-save-area');
            if (saveArea) saveArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }
    }

    // Leer duración: si existe input srv-duration, usarlo; si no, inferir del primer módulo
    let duracion = getServiceDuration();
    const durInput = document.getElementById('srv-duration');
    if (durInput && durInput.value && Number(durInput.value) > 0) {
        duracion = Number(durInput.value);
    } else if (window.serviceModules && window.serviceModules.length > 0) {
        duracion = window.serviceModules[0].duration || 60;
    }

    const disponibilidad = buildDisponibilidadFromForm();

    const nuevoServicio = {
        nombre: nombre,
        precio: parseFloat(precio),
        duracion: duracion,
        imagen: document.getElementById('srv-image-url').value || 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874',
        descripcion: document.getElementById('srv-desc').value || '',
        destacado: document.getElementById('srv-featured').checked,
        activo: activo,
        disponibilidad: disponibilidad,
        fechas: Object.keys(disponibilidad).sort()
    };

    await ServiciosManager.save(nuevoServicio);
    mostrarMensaje(`✅ Servicio "${nombre}" creado con ${selectedDates.size} fecha(s) y ${serviceModules.length} horario(s)`, "success");

    document.getElementById('service-form').reset();
    selectedDates.clear();
    clearAllModules();
    renderCalendar();
    cargarServiciosExistentes();
    // Redirigir a Mis Servicios
    if (typeof navigateTo === 'function') {
        navigateTo('mis-servicios');
    } else {
        document.getElementById('service-form').scrollIntoView({ behavior: 'smooth' });
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

    servicios.forEach(servicio => {
        let estadoUrgencia = 'normal';
        let fechaMasCercana = null;
        let horaMasCercana = null;
        
        if (servicio.disponibilidad && typeof servicio.disponibilidad === 'object') {
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
        }
        
        if (fechaMasCercana) {
            estadoUrgencia = UrgenciaManager.calcularEstado(fechaMasCercana, horaMasCercana);
        } else {
            estadoUrgencia = 'expirado';
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
                    <i class="fas fa-clock"></i> ${totalTurnos} turnos
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
                <img src="${servicio.imagen}" alt="${servicio.nombre}" class="service-card-image">
                
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
                    <h4>${servicio.nombre}</h4>
                    <div class="service-card-price">${formatearPeso(servicio.precio)}</div>
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
                    <button class="btn-secondary btn-small" onclick="editarServicio(${servicio.id})">
                        <i class="fas fa-edit"></i> Editar
                    </button>
                    <button class="btn-small" onclick="duplicarServicio(${servicio.id})" title="Duplicar servicio">
                        <i class="fas fa-copy"></i>
                    </button>
                    <button class="btn-small danger" onclick="eliminarServicio(${servicio.id})">
                        <i class="fas fa-trash"></i> Eliminar
                    </button>
                    <button class="btn-grad btn-small" onclick="toggleActivoServicio(${servicio.id})">
                        <i class="fas fa-eye${servicio.activo ? '' : '-slash'}"></i> ${servicio.activo ? 'Ocultar' : 'Mostrar'}
                    </button>
                </div>
            </div>
        </div>
        `;
    });

    container.innerHTML = html;

    actualizarEstadisticas();

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

async function eliminarServicio(id) {
    if (!confirm("¿Estás seguro de eliminar este servicio?")) {
        return;
    }
    await ServiciosManager.delete(id);
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
    document.getElementById('srv-image-url').value = servicio.imagen;
    document.getElementById('srv-desc').value = servicio.descripcion || '';
    document.getElementById('srv-featured').checked = servicio.destacado;
    document.getElementById('srv-active').checked = servicio.activo;

    if (servicio.fechas && servicio.fechas.length > 0) {
        selectedDates = new Set(servicio.fechas);
    } else {
        selectedDates.clear();
    }

    renderCalendar();
    clearAllModules();
    if (servicio.disponibilidad && Object.keys(servicio.disponibilidad).length > 0) {
        const horaMap = {};
        Object.keys(servicio.disponibilidad).forEach(f => {
            (servicio.disponibilidad[f] || []).forEach(module => {
                const h = module.hora || module.startTime || '00:00';
                if(!horaMap[h]){
                    horaMap[h] = {
                        id: module.id || crypto.randomUUID(),
                        hora: h,
                        cupos: (typeof module.cupos !== 'undefined') ? Number(module.cupos) : 0,
                        duration: module.duration || 0
                    };
                }
            });
        });
        Object.values(horaMap).forEach(h => serviceModules.push(h));
        window.moduleDateCupos = {};
        Object.keys(servicio.disponibilidad || {}).forEach(fecha => {
            window.moduleDateCupos[fecha] = {};
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
                id: module.id || crypto.randomUUID(),
                hora: module.hora || module.startTime || '00:00',
                cupos: (typeof module.cupos !== 'undefined') ? Number(module.cupos) : (typeof module.capacidad !== 'undefined' ? Number(module.capacidad) : 0),
                duration: module.duration || 0
            });
        });
        renderModulesList();
        saveModulesToHiddenField();
        updateDurationDisplay();
    }

    const form = document.getElementById('service-form');
    const submitBtn = form.querySelector('button[type="submit"]');

    const originalSubmit = form.onsubmit;

    form.onsubmit = function(e) {
        e.preventDefault();
        actualizarServicio(id);
    };

    submitBtn.innerHTML = '<i class="fas fa-save"></i> ACTUALIZAR SERVICIO';
    submitBtn.onclick = function(e) {
        e.preventDefault();
        actualizarServicio(id);
    };

    const formActions = document.querySelector('.form-actions');
    if (!document.getElementById('cancel-edit')) {
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.id = 'cancel-edit';
        cancelBtn.className = 'btn-secondary';
        cancelBtn.innerHTML = '<i class="fas fa-times"></i> Cancelar edición';
        cancelBtn.onclick = function() {
            cancelarEdicion(originalSubmit);
        };
        formActions.appendChild(cancelBtn);
    }

    mostrarMensaje(`Editando servicio: "${servicio.nombre}"`, "info");
}
window.editarServicio = editarServicio;

async function actualizarServicio(id) {
    const servicios = await ServiciosManager.getAll();
    const index = servicios.findIndex(s => s.id === id);

    if (index === -1) {
        mostrarMensaje("Servicio no encontrado", "error");
        return;
    }

    const nombre = document.getElementById('srv-name').value;
    const precio = document.getElementById('srv-price').value;
    const activo = document.getElementById('srv-active').checked;

    if (!nombre || !precio) {
        mostrarMensaje("Por favor completa todos los campos obligatorios", "error");
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

    // Mejora #5: duración desde input si existe
    let duracion = getServiceDuration();
    const durInput = document.getElementById('srv-duration');
    if (durInput && durInput.value && Number(durInput.value) > 0) {
        duracion = Number(durInput.value);
    } else if (serviceModules.length > 0) {
        duracion = window.serviceModules[0].duration || 60;
    }

    const disponibilidadNueva = buildDisponibilidadFromForm();

    const servicioActualizado = {
        id: id,
        nombre: nombre,
        precio: parseFloat(precio),
        duracion: duracion,
        imagen: document.getElementById('srv-image-url').value || 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874',
        descripcion: document.getElementById('srv-desc').value || '',
        destacado: document.getElementById('srv-featured').checked,
        activo: activo,
        disponibilidad: disponibilidadNueva,
        fechas: Object.keys(disponibilidadNueva).sort(),
        fechaCreacion: servicios[index].fechaCreacion,
        fechaActualizacion: new Date().toISOString()
    };

    await ServiciosManager.save(servicioActualizado);

    cancelarEdicion();
    cargarServiciosExistentes();

    mostrarMensaje(`✅ Servicio "${servicioActualizado.nombre}" actualizado correctamente`, "success");
}
window.actualizarServicio = actualizarServicio;

function cancelarEdicion() {
    const form = document.getElementById('service-form');
    form.reset();

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.innerHTML = '<i class="fas fa-plus-circle"></i> CREAR SERVICIO';
    submitBtn.onclick = null;

    const cancelBtn = document.getElementById('cancel-edit');
    if (cancelBtn) {
        cancelBtn.remove();
    }

    selectedDates.clear();
    renderCalendar();
    clearAllModules();
}
window.cancelarEdicion = cancelarEdicion;

async function actualizarEstadisticas() {
    const servicios = await ServiciosManager.getAll();

    const total = servicios.length;
    const activos = servicios.filter(s => s.activo).length;
    const destacados = servicios.filter(s => s.destacado && s.activo).length;
    const cuposTotales = servicios.reduce((sum, s) => {
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
}
window.actualizarEstadisticas = actualizarEstadisticas;

async function actualizarStatsHeader() {
    const servicios = await ServiciosManager.getAll();

    const statServicios = document.getElementById('statServicios');
    const statVentas = document.getElementById('statVentas');
    const statCitas = document.getElementById('statCitas');
    const statClientes = document.getElementById('statClientes');

    if (statServicios) {
        const activos = servicios.filter(s => s.activo).length;
        statServicios.textContent = activos;
    }

    if (statVentas) {
        const ventas = servicios.reduce((sum, s) => sum + s.precio, 0) * 2;
        statVentas.textContent = formatearPeso(ventas);
    }

    if (statCitas) {
        statCitas.textContent = servicios.length * 3;
    }

    if (statClientes) {
        statClientes.textContent = servicios.length * 5;
    }
}
window.actualizarStatsHeader = actualizarStatsHeader;

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

function configurarPrevisualizacionImagen() {
    const inputImagen = document.getElementById('srv-image-url');
    const contenedorPreview = document.getElementById('image-preview');
    const btnLimpiar = document.getElementById('clear-image');
    const btnDefault = document.getElementById('default-image');

    if (!inputImagen || !contenedorPreview) {
        return;
    }

    function actualizarPreview(url) {
        contenedorPreview.innerHTML = '';

        if (!url) {
            contenedorPreview.innerHTML = `
                <div class="image-placeholder">
                    <i class="fas fa-image"></i>
                    <p>Vista previa aparecerá aquí</p>
                </div>
            `;
            contenedorPreview.classList.remove('has-image');
            return;
        }

        const img = document.createElement('img');
        img.src = url;
        img.alt = 'Previsualización del servicio';
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'cover';
        img.style.borderRadius = '8px';

        img.onload = function() {
            contenedorPreview.appendChild(img);
            contenedorPreview.classList.add('has-image');
        };

        img.onerror = function() {
            contenedorPreview.innerHTML = `
                <div class="image-placeholder error">
                    <i class="fas fa-exclamation-triangle"></i>
                    <p>No se pudo cargar la imagen</p>
                    <small>URL inválida o imagen no accesible</small>
                </div>
            `;
            contenedorPreview.classList.remove('has-image');
        };
    }

    inputImagen.addEventListener('input', function() {
        const url = this.value.trim();
        actualizarPreview(url);
    });

    if (btnLimpiar) {
        btnLimpiar.addEventListener('click', function() {
            inputImagen.value = '';
            actualizarPreview('');
        });
    }

    if (btnDefault) {
        btnDefault.addEventListener('click', function() {
            const defaultImage = 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80';
            inputImagen.value = defaultImage;
            actualizarPreview(defaultImage);
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
            setTimeout(() => {
                mostrarMensaje("Formulario limpiado", "info");
            }, 100);
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
        if (tenantId) {
            await window.__appointmentsApi.limpiarCitasExpiradas(tenantId);
        }
        if(typeof renderAdminAppointments === 'function') renderAdminAppointments();
        if(typeof updateProjectedRevenue === 'function') updateProjectedRevenue();
        mostrarToast('Base de datos de citas eliminada correctamente', 'success');
    }catch(err){
        console.error('limpiarBaseDatos error', err);
        mostrarToast('Error al limpiar la base de datos', 'error');
    }
}
window.limpiarBaseDatos = limpiarBaseDatos;

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

    updateDatesPreview();
    updateDatesCount();
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

    updateDatesPreview();
    updateDatesCount();
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

function updateDatesPreview() {
    const previewContainer = document.getElementById('selected-dates-preview');
    if (!previewContainer) return;

    previewContainer.innerHTML = '';

    if (selectedDates.size === 0) {
        previewContainer.className = 'selected-dates-preview empty';
        previewContainer.innerHTML = '<p class="empty-dates">No hay fechas seleccionadas. Haz clic en el calendario para agregar fechas.</p>';
        return;
    }

    previewContainer.className = 'selected-dates-preview';

    const sortedDates = Array.from(selectedDates).sort();

    sortedDates.forEach(dateStr => {
        const date = parseDate(dateStr);
        const dateTag = document.createElement('div');
        dateTag.className = 'date-tag';

        const formattedDate = date.toLocaleDateString('es-ES', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric'
        });

        const capitalizedDate = formattedDate.charAt(0).toUpperCase() + formattedDate.slice(1);

        dateTag.innerHTML = `
            <i class="fas fa-calendar-check"></i>
            <span class="date-text">${capitalizedDate}</span>
            <button class="remove-tag" data-date="${dateStr}" title="Eliminar esta fecha">
                <i class="fas fa-times"></i>
            </button>
        `;

        previewContainer.appendChild(dateTag);
    });

    sortedDates.forEach(fecha => {
        window.moduleDateCupos[fecha] = window.moduleDateCupos[fecha] || {};
        serviceModules.forEach(mod => {
            if (typeof window.moduleDateCupos[fecha][mod.hora] === 'undefined') {
                window.moduleDateCupos[fecha][mod.hora] = Number(mod.cupos || 0);
            }
        });
    });

    renderModulesList();

    // Actualizar selector de fechas si está en modo date
    if (_assignmentMode === 'date' && typeof actualizarSelectorFechas === 'function') {
        actualizarSelectorFechas();
    }

    previewContainer.querySelectorAll('.remove-tag').forEach(button => {
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            const dateToRemove = e.target.closest('.remove-tag').dataset.date;
            toggleDateSelection(dateToRemove);

            const dayElement = document.querySelector(`.calendar-day[data-date="${dateToRemove}"]`);
            if (dayElement) {
                dayElement.classList.remove('selected');
            }
        });
    });
}
window.updateDatesPreview = updateDatesPreview;

function updateDatesCount() {
    const countElement = document.getElementById('dates-count');
    if (countElement) {
        countElement.textContent = selectedDates.size;
    }
}
window.updateDatesCount = updateDatesCount;

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
                id: m.id || (crypto.randomUUID()),
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
    const DURACION = 60;

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
            id: crypto.randomUUID(),
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

    // Mostrar boton Confirmar
    const confirmBtn = document.getElementById('confirm-modules-btn');
    if (confirmBtn) confirmBtn.style.display = 'inline-block';

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
                    onClick: 'asignarDiaWeekday(' + d + ')'
                });
            }
        });
    } else if (_assignmentMode === 'date') {
        (selectedDates || []).sort().forEach(f => {
            if (!_dateSpecificModules[f] || _dateSpecificModules[f].length === 0) {
                result.push({
                    label: f,
                    onClick: 'asignarFechaDate("' + f + '")'
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
            html += '<button type="button" class="btn-small" style="font-size:0.7rem;padding:2px 8px;" onclick="aplicarCupoAHorarios(\'' + date + '\')" title="Aplicar cupo a todos los horarios de esta fecha">↓ Cupo masivo</button>';
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
                html += '<input type="number" class="module-cupos-input" data-date="' + date + '" data-hora="' + key + '" value="' + cupo + '" min="0" onchange="actualizarCupo(this)" style="width:55px;padding:3px 6px;border-radius:4px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);color:#fff;text-align:center;">';
                html += '<button type="button" class="btn-disable-cupo" style="background:none;border:none;color:#ff6b6b;cursor:pointer;font-size:1rem;padding:2px 4px;line-height:1;" onclick="deshabilitarCupo(\'' + date + '\',\'' + key + '\')" title="Deshabilitar (cupo=0)">×</button>';
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
                html += '<button type="button" class="btn-small" style="background:rgba(255,70,70,0.2);color:#ff6b6b;border:1px solid rgba(255,70,70,0.3);padding:4px 12px;cursor:pointer;" onclick="' + item.onClick + '">➕ ' + item.label + '</button>';
            });
            html += '</div></div>';
        }
    }

    modulesList.innerHTML = html;

    // Actualizar resumen económico
    if (typeof actualizarResumenEconomico === 'function') {
        actualizarResumenEconomico();
    }
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
    actualizarResumenEconomico();
}
window.actualizarCupo = actualizarCupo;

// ============================================
// Mejora #3 – Cupo masivo por horario
// ============================================
function aplicarCupoAFechas(hora) {
    const cupoStr = prompt('Ingresa el cupo deseado para el horario ' + hora + ' en todas las fechas:');
    if (cupoStr === null) return;
    const cupo = parseInt(cupoStr);
    if (isNaN(cupo) || cupo < 0) { mostrarMensaje('Ingresa un número válido', 'warning'); return; }
    if (!window.moduleDateCupos) window.moduleDateCupos = {};
    const fechas = Array.from(selectedDates);
    fechas.forEach(f => {
        if (!window.moduleDateCupos[f]) window.moduleDateCupos[f] = {};
        window.moduleDateCupos[f][hora] = cupo;
    });
    renderModulesList();
    mostrarMensaje(`Cupo ${cupo} aplicado a todas las fechas para las ${hora}`, 'success');
    const btn = document.querySelector(`.btn-mass-cupo-fila[onclick*="${hora}"]`);
    if (btn) { btn.style.pointerEvents = 'auto'; }
}
window.aplicarCupoAFechas = aplicarCupoAFechas;

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
                    horaMap[h] = { id: crypto.randomUUID(), hora: h, cupos: Number(mod.cupos || 0), duration: mod.duration || 0 };
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
    // Ir al formulario
    document.getElementById('service-creator')?.scrollIntoView({ behavior: 'smooth' });
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
    const imagen = document.getElementById('srv-image-url')?.value || 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874';
    const activo = document.getElementById('srv-active')?.checked;

    const fechas = Array.from(selectedDates).sort();
    const horarios = serviceModules.map(m => formatTimeDisplay(m.hora)).join(', ');

    const modal = document.createElement('div');
    modal.className = 'preview-modal-overlay';
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:99999;';
    modal.innerHTML = `
        <div class="preview-modal" style="background:#1a1a2e;border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:30px;max-width:420px;width:90%;color:#fff;position:relative;">
            <button onclick="this.closest('.preview-modal-overlay').remove()" style="position:absolute;top:12px;right:16px;background:none;border:none;color:#888;font-size:24px;cursor:pointer;">×</button>
            <div class="service-card-preview" style="text-align:center;">
                <img src="${imagen}" alt="${nombre}" style="width:100%;height:200px;object-fit:cover;border-radius:12px;margin-bottom:16px;" onerror="this.style.display='none'">
                <h3 style="color:#fff;font-size:1.3rem;margin-bottom:8px;">${nombre}</h3>
                <div style="font-size:1.5rem;font-weight:bold;color:#9d4edd;margin-bottom:8px;">$ ${parseFloat(precio).toLocaleString('es-CL')}</div>
                ${descripcion ? `<p style="color:#aaa;font-size:0.9rem;margin-bottom:12px;">${descripcion}</p>` : ''}
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
}
window.mostrarVistaPrevia = mostrarVistaPrevia;

// ============================================
// Mejora #5 – getServiceDuration mejorada (lee servicio.duracion si existe)
// ============================================
function getServiceDuration() {
    const durVal = document.getElementById('srv-duration');
    if (durVal && durVal?.value && Number(durVal?.value) > 0) return Number(durVal?.value);
    // Si hay servicio editándose con duración propia, usarla
    const editingId = document.getElementById('editing-service-id');
    if (editingId && editingId.value) {
        const durHidden = document.getElementById('srv-duration-hidden');
        if (durHidden && durHidden?.value) return Number(durHidden?.value);
    }
    if (window.serviceModules && window.serviceModules.length > 0) return window.serviceModules[0].duration || 60;
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
    const form = document.getElementById('service-form');
    form.reset();
    document.getElementById('btn-guardar').style.display = 'inline-block';
    document.getElementById('btn-actualizar').style.display = 'none';
    document.getElementById('editing-service-id').value = '';
    selectedDates.clear();
    clearAllModules();
    renderCalendar();
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
                    id: m.id || crypto.randomUUID(),
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
                            id: m.id || crypto.randomUUID(),
                            hora: m.hora || m.startTime,
                            cupos: (typeof m.cupos !== 'undefined') ? Number(m.cupos) : (typeof m.capacidad !== 'undefined' ? Number(m.capacidad) : 0),
                            duration: m.duration || 0
                        };
                    }
                    return {
                        id: m.id || crypto.randomUUID(),
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
// Funciones auxiliares matriz de cupos
// ============================================

// Actualizar cupo individual al cambiar input
window.actualizarCupo = function(input) {
    const date = input.dataset.date;
    const hora = input.dataset.hora;
    const value = parseInt(input.value) || 0;
    if (!window.moduleDateCupos) window.moduleDateCupos = {};
    if (!window.moduleDateCupos[date]) window.moduleDateCupos[date] = {};
    window.moduleDateCupos[date][hora] = value;
    
    // Reflejar cambio en window.serviceModules
    const mod = serviceModules.find(m => (m.hora || m.startTime) === hora);
    if (mod) {
        if (!mod.cupos) mod.cupos = {};
        mod.cupos[date] = value;
    }
    
    // Marcar celda como cero si aplica
    const cell = input.closest('.cupo-cell');
    if (cell) {
        cell.classList.toggle('zero-cupo', value <= 0);
    }
    
    actualizarResumenEconomico();
};

// Colapsar/expandir fechas en matriz
window.toggleFechasMatriz = function() {
    const container = document.getElementById('modules-list');
    if (!container) return;
    container.dataset.showAll = container.dataset.showAll === 'true' ? 'false' : 'true';
    renderModulesList();
};

// Resumen económico dinámico
function actualizarResumenEconomico() {
    const totalEl = document.getElementById('eco-total-turnos');
    const ingresoEl = document.getElementById('eco-ingreso');
    if (!totalEl || !ingresoEl) return;
    
    let totalCupos = 0;
    if (window.moduleDateCupos && selectedDates && window.serviceModules) {
        for (const date of selectedDates) {
            for (const mod of window.serviceModules) {
                const key = mod.hora || mod.startTime;
                const cupo = window.moduleDateCupos[date] && typeof window.moduleDateCupos[date][key] !== 'undefined'
                    ? Number(window.moduleDateCupos[date][key]) : 0;
                totalCupos += cupo;
            }
        }
    }
    
    const precio = parseFloat(document.getElementById('srv-price')?.value) || 0;
    totalEl.textContent = totalCupos;
    ingresoEl.textContent = '$' + (totalCupos * precio).toLocaleString('es-CL');
}
window.actualizarResumenEconomico = actualizarResumenEconomico;


function getServiceDuration() {
    const durVal = document.getElementById('srv-duration');
    if (durVal && durVal?.value && Number(durVal?.value) > 0) return Number(durVal?.value);
    // Si hay servicio editándose con duración propia, usarla
    const editingId = document.getElementById('editing-service-id');
    if (editingId && editingId.value) {
        const durHidden = document.getElementById('srv-duration-hidden');
        if (durHidden && durHidden?.value) return Number(durHidden?.value);
    }
    if (window.serviceModules && window.serviceModules.length > 0) return window.serviceModules[0].duration || 60;
    return 60;
}
window.getServiceDuration = getServiceDuration;

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
    if (soloUsuario && session) {
        citas = todas.filter(c => {
            if (session.id && c.contacto?.userId) {
                return String(c.contacto.userId) === String(session.id);
            }
            if (session.nombre && c.contacto?.nombre) {
                return String(c.contacto.nombre).trim().toLowerCase() === String(session.nombre).trim().toLowerCase();
            }
            return false;
        });
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
        const servicio = c.nombre || c.servicioNombre || '—';
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
async function renderAdminAppointments() {
    const container = document.getElementById('upcoming-appointments');
    if (!container) return;

    const todas = await CitasManager.getAll();
    if (!todas || todas.length === 0) {
        container.innerHTML = '<div class="empty-state" style="padding:40px;text-align:center;color:#aaa;"><i class="fas fa-calendar-times" style="font-size:48px;display:block;margin-bottom:15px;"></i><p>No hay citas programadas</p></div>';
        return;
    }

    let html = '<div class="appointments-list">';
    todas.slice(0, 50).forEach(c => {
        const nombre = c.contacto?.nombre || c.nombre || '—';
        const telefono = c.contacto?.telefono || c.telefonoCliente || '';
        const servicio = c.nombre || c.servicioNombre || '—';
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

// ============================================
// FUNCIONES DE CLIENTE (modificadas para async)
// ============================================
async function iniciarCliente() {
    console.log('[iniciarCliente] Inicializando vista cliente...');

    // 1. Obtener tenant_id (prioridad: currentTenantId > URL > sesion > primer tenant)
    let tenantId = window.currentTenantId || null;
    if (!tenantId) {
        const urlParams = new URLSearchParams(window.location.search);
        tenantId = urlParams.get('tenant_id') || urlParams.get('tenant');
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

    // Validar formato UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(tenantId.trim())) {
        mostrarToast('Formato de tenant inválido', 'error');
        console.error('❌ tenant_id no tiene formato UUID:', tenantId);
        return;
    }

    // Establecer tenant en Supabase (para políticas anónimas RLS)
    try {
        const { error: rpcError } = await supabaseClient.rpc('set_tenant', { tenant_id: tenantId });
        if (rpcError) console.warn('[iniciarCliente] set_tenant RPC falló:', rpcError);
        else console.log('[iniciarCliente] set_tenant RPC exitoso para tenant', tenantId);
    } catch (e) {
        console.error('[iniciarCliente] Excepción en set_tenant:', e);
    }
    window.currentTenantId = tenantId;

    // Cargar configuración visual del tenant
    try {
        const visualConfig = await VisualConfigManager.loadConfig();
        VisualConfigManager.applyStyles(visualConfig);
    } catch (e) {
        console.warn('[iniciarCliente] Error cargando config visual:', e);
    }

    // Cargar servicios (funciona con o sin sesión)
    currentFilterTerm = '';
    currentFilterDate = '';
    currentFilterCategory = 'todos';
    await cargarServiciosParaCliente(tenantId);
    configurarBuscadorCliente();
    configurarFiltroFecha();
    configurarBotonesExportacion();

    // Verificar sesión – cargar datos adicionales si el usuario está logueado
    const session = await getSession();
    if (!session) {
        console.log('[iniciarCliente] Sin sesión. Funcionando en modo anónimo.');
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

    searchInput.addEventListener('input', function(e) {
        currentFilterTerm = e.target.value.toLowerCase().trim();
        aplicarFiltrosCombinados();
    });

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

        const rating = (4.5 + Math.random() * 0.5).toFixed(1);

        html += `
        <div class="service-card" data-service-id="${servicio.id}">
            <div class="service-image">
                <img src="${servicio.imagen}" alt="${servicio.nombre}" 
                     onerror="this.src='https://images.unsplash.com/photo-1544161515-4ab6ce6db874'">
                <span class="service-category ${servicio.categoria}">
                    ${getCategoriaNombre(servicio.categoria)}
                </span>
                ${servicio.destacado ? '<span class="service-featured"><i class="fas fa-star"></i></span>' : ''}
            </div>
            
            <div class="service-content">
                <h3>${servicio.nombre}</h3>
                <p class="service-description">${servicio.descripcion || 'Sin descripción disponible'}</p>
                
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
                    <span class="rating">
                        <i class="fas fa-star"></i> ${rating}
                    </span>
                </div>
                
                <div class="service-footer">
                    <div class="price">${formatearPeso(servicio.precio)}</div>
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
}
window.actualizarGridCliente = actualizarGridCliente;

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
    const btnAdmin = document.getElementById('export-services-csv');
    if (btnAdmin) {
        btnAdmin.addEventListener('click', async function() {
            const servicios = await ServiciosManager.getAll();
            
            if (servicios.length === 0) {
                mostrarToast('No hay servicios para exportar', 'warning');
                return;
            }
            
            const cabeceras = ['ID', 'Nombre', 'Categoría', 'Precio', 'Descripción', 'Fechas Disponibles', 'Horarios', 'Estado', 'Destacado'];
            
            const filas = servicios.map(s => {
                let fechasStr = s.fechas ? s.fechas.join('; ') : '';
                
                let horariosStr = '';
                if (s.disponibilidad) {
                    const horarios = new Set();
                    Object.values(s.disponibilidad).forEach(mods => {
                        (mods || []).forEach(m => {
                            if (m.hora) horarios.add(m.hora);
                        });
                    });
                    horariosStr = Array.from(horarios).join('; ');
                }
                
                return [
                    s.id,
                    s.nombre,
                    s.categoria,
                    s.precio,
                    (s.descripcion || '').replace(/,/g, ';'),
                    fechasStr,
                    horariosStr,
                    s.activo ? 'Activo' : 'Inactivo',
                    s.destacado ? 'Sí' : 'No'
                ];
            });
            
            const csvContent = [
                cabeceras.join(','),
                ...filas.map(f => f.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
            ].join('\n');
            
            const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            const url = URL.createObjectURL(blob);
            
            link.setAttribute('href', url);
            link.setAttribute('download', `todos_servicios_${new Date().toISOString().slice(0,10)}.csv`);
            link.style.visibility = 'hidden';
            
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            
            mostrarToast(`Exportados ${servicios.length} servicios`, 'success');
        });
    }
    
    const btnCliente = document.getElementById('export-filtered-csv');
    if (btnCliente) {
        btnCliente.addEventListener('click', exportarServiciosCSV);
    }
}

// ============================================
// RESERVA Y REPROGRAMACIÓN (modificadas para async)
// ============================================
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

    const fechas = Object.keys(servicio.disponibilidad || {}).sort();
    const fechasOptions = fechas.map(f => {
        const modulosForDate = servicio.disponibilidad[f] || [];
        const todosAgotadosEnFecha = modulosForDate.length > 0 && modulosForDate.every(m => (Number(m.cupos || 0) <= 0));
        return `<option value="${f}" ${todosAgotadosEnFecha ? 'disabled' : ''}>${f}${todosAgotadosEnFecha ? ' (Agotada)' : ''}</option>`;
    }).join('');

    detallesDiv.innerHTML = `
        <p><strong>Servicio:</strong> <span id="servicio-nombre">—</span></p>
        <p><strong>Precio:</strong> <span id="servicio-precio">—</span></p>

        <div style="margin-top:10px; display:flex; flex-direction:column; gap:8px;">
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
            </div>
        </div>
    `;

    const nombreSpan = document.getElementById('servicio-nombre'); if(nombreSpan) nombreSpan.textContent = servicio.nombre || '—';
    const precioSpan = document.getElementById('servicio-precio'); if(precioSpan) precioSpan.textContent = formatearPeso(servicio.precio);

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

    if(window.abrirPopupReserva) window.abrirPopupReserva({ nombre: servicio.nombre, fecha:'—', hora:'—', precio: formatearPeso(servicio.precio) });
    if(popupEl){
        popupEl.style.display = 'flex';
        popupEl.style.opacity = '1';
        popupEl.style.transition = '';
    }

    const resumenEl = document.getElementById('resumen-confirmacion');
    function updateResumen(){
        const selF = document.getElementById('select-fecha')?.value || '';
        const selH = document.getElementById('select-hora')?.value || '';
        let horaTextoLocal = '';
        if(selF && selH && servicio && servicio.disponibilidad && servicio.disponibilidad[selF]){
            const mod = servicio.disponibilidad[selF][Number(selH)];
            horaTextoLocal = formatTimeDisplay(mod?.hora || mod?.startTime || selH || '00:00');
        }
        if(resumenEl){
            if(selF && selH){
                resumenEl.innerHTML = `<div class="popup-summary">Reservarás para el <strong>${selF}</strong> a las <strong>${horaTextoLocal}</strong>. Recuerda: No hay reembolsos y cambios solo con 24h de antelación.</div>`;
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
    [clienteNombreEl, clienteTelEl, clienteEmailEl].forEach(el => { if(el) el.addEventListener('input', validarFormularioReserva); });

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

    function populateHorasForFecha(fecha){
        if(!selectHora) return;
        if(!fecha){ 
            selectHora.innerHTML = '<option value="">Seleccione hora</option>'; 
            selectHora.disabled = true; 
            return; 
        }
        const modulosForDate = (servicio.disponibilidad && servicio.disponibilidad[fecha]) ? servicio.disponibilidad[fecha] : [];
        let options = '<option value="">Seleccione hora</option>';
        modulosForDate.forEach((m, index) => {
            const horaText = formatTimeDisplay(m.hora || m.startTime || '00:00');
            const cupos = Number(m.cupos || 0);
            if(cupos <= 0) return;
            options += `<option value="${index}" data-hora="${horaText}" data-cupos="${cupos}">${horaText} - ${cupos} cupos</option>`;
        });
        selectHora.innerHTML = options;
        selectHora.disabled = false;
    }

    if(selectFecha){
        selectFecha.addEventListener('change', function(){
            const spanFecha = document.getElementById('servicio-fecha'); if(spanFecha) spanFecha.textContent = this.value || '—';
            if(this.value){
                populateHorasForFecha(this.value);
            } else {
                if(selectHora){ selectHora.innerHTML = '<option value="">Seleccione hora</option>'; selectHora.disabled = true; }
                const spanHora = document.getElementById('servicio-hora'); if(spanHora) spanHora.textContent = '—';
            }
            checkEnableConfirm();
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
    Object.keys(disponibilidad).forEach(f => {
        const mods = disponibilidad[f] || [];
        if(mods.some(m => Number(m.cupos || 0) > 0)) anyAvailable = true;
    });
    if(!anyAvailable){
        if(btnConfirm){ btnConfirm.disabled = true; btnConfirm.style.cursor = 'not-allowed'; }
        mostrarMensaje('Lo sentimos, todos los horarios están agotados para este servicio','warning');
    }

    if(selectFecha) selectFecha.addEventListener('change', validarFormularioReserva);
    if(selectHora) selectHora.addEventListener('change', validarFormularioReserva);
    if(checkbox) checkbox.addEventListener('change', validarFormularioReserva);

    if(btnConfirm){
        btnConfirm.addEventListener('click', function(e){
            e.preventDefault();
            e.stopPropagation();
            if(idCitaEnEdicion){
                confirmarCambioFecha(reprogramInfo.citaId, reprogramInfo.serviceId, reprogramInfo.citaActual);
            } else {
                confirmarReserva(e);
            }
        });
    }
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

    if (idCitaEnEdicion) {
        // En reprogramación, no exigimos datos de contacto
    }

    let enable = Boolean(selF && selH && acepto && nombreOk && clientPhoneOk && emailOk);

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
            if(nombreEl){ const rnd = Math.floor(Math.random()*9000) + 1000; nombreEl.value = `Invitado #${rnd}`; nombreEl.readOnly = false; nombreEl.style.opacity = '1'; }
            if(emailEl){ emailEl.value = ''; emailEl.readOnly = false; emailEl.style.opacity = '1'; emailEl.required = true; }
            if(telEl){ telEl.readOnly = false; telEl.style.opacity = '1'; }
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

    const selectFecha = document.getElementById('select-fecha');
    const selectHora = document.getElementById('select-hora');
    const acepto = document.getElementById('acepto-condiciones')?.checked;

    const fecha = selectFecha ? selectFecha.value : document.getElementById('servicio-fecha')?.textContent;
    const horaIdx = selectHora ? selectHora.value : null;

    if(!acepto){ mostrarMensaje('Debes aceptar las condiciones','warning'); return; }
    if(!fecha || fecha === ''){ mostrarMensaje('Selecciona una fecha','warning'); return; }
    if(horaIdx === null || horaIdx === ''){ mostrarMensaje('Selecciona una hora','warning'); return; }

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

    const servicios = await ServiciosManager.getAll();
    const idx = servicios.findIndex(s => String(s.id) === String(serviceId));
    if(idx === -1){ mostrarMensaje('Servicio no encontrado','error'); return; }

    const servicio = servicios[idx];

    const disponibilidad = servicio.disponibilidad || {};
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

    const horaTexto = formatTimeDisplay(modulo.hora || modulo.startTime || '00:00');

    const clienteNombre = document.getElementById('cliente-nombre')?.value?.trim() || '';
    const clienteTel = document.getElementById('cliente-tel')?.value?.trim() || '';
    const clienteEmail = document.getElementById('cliente-email')?.value?.trim() || '';
    const session = await getSession();
    const userId = session?.id || null;

    const cita = {
        id: String(Date.now()),
        servicioId: servicio.id,
        nombre: servicio.nombre,
        fecha: fecha,
        hora: horaTexto,
        precio: servicio.precio,
        creadoEn: new Date().toISOString(),
        contacto: {
            nombre: clienteNombre || session?.nombre || '',
            telefono: clienteTel || '',
            email: clienteEmail || session?.email || '',
            userId: userId || null
        },
        notificaciones: { 
            emailEnviado: false, 
            whatsappEnviado: false 
        }
    };
    cita.telefonoCliente = cita.contacto.telefono || '';

await CitasManager.upsert(cita, window.currentTenantId);

    // Insertar notificación admin para nueva reserva
    try {
        const tenantId = await getCurrentTenantId();
        if (tenantId) {
            const notifId = 'notif-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
            const { error: notifError } = await supabaseClient
                .from('notificaciones_admin')
                .insert({
                    id: notifId,
                    tenant_id: tenantId,
                    tipo: 'nueva_reserva',
                    cita_id: cita.id,
                    fecha_original: null,
                    hora_original: null,
                    fecha_nueva: null,
                    hora_nueva: null,
                    cliente: cita.contacto || {},
                    leido: false,
                    creado_en: new Date().toISOString(),
                    metadata: {
                        servicio: cita.nombre || '',
                        fecha: cita.fecha || '',
                        hora: cita.hora || '',
                        precio: cita.precio || 0
                    }
                });
            if (notifError) console.error('Error creando notificación admin:', notifError);
        }
    } catch (e) {
        console.error('Error al crear notificación admin:', e);
    }
    
    servicio.disponibilidad[fecha][moduloIndex].cupos = Math.max(0, cuposActuales - 1);

    let anyRemaining = false;
    Object.keys(servicio.disponibilidad || {}).forEach(f => {
        if((servicio.disponibilidad[f] || []).some(m => Number(m.cupos || 0) > 0)) anyRemaining = true;
    });
    if(!anyRemaining) servicio.activo = false;
    servicios[idx] = servicio;
    await ServiciosManager.save(servicio);
    
    if (typeof generarNotificaciones === 'function') generarNotificaciones();

    popup.style.display = 'none';

    if (typeof renderCarrito === 'function') renderCarrito();

    try{
        mostrarToast('¡Reserva exitosa! Revisa tu WhatsApp pronto', 'success');
    }catch(e){
        mostrarMensaje(`¡Reserva confirmada para el ${fecha} a las ${horaTexto}!`, 'success');
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

                if(diferenciaMs < 24 * 60 * 60 * 1000) {
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
                <p><strong>Cita actual:</strong> ${citaActual.fecha} - ${citaActual.hora}</p>
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
                        option.textContent = fecha;
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

        if(servicio.disponibilidad && servicio.disponibilidad[citaOriginal.fecha]){
            const modulosOriginal = servicio.disponibilidad[citaOriginal.fecha];
            const moduloOriginal = modulosOriginal.find(m => {
                const horaMod = limpiarHora(m.hora || m.startTime || '');
                return horaMod === limpiarHora(citaOriginal.hora);
            });

            if(moduloOriginal) {
                moduloOriginal.cupos = (Number(moduloOriginal.cupos || 0) + 1);
            }
        }

        moduloEncontrado.cupos = Math.max(0, Number(moduloEncontrado.cupos || 0) - 1);

        const [citaExtraida] = citas.splice(idxOriginal, 1);

        const nuevaCita = {
            ...citaExtraida,
            id: citaExtraida.id, // mantener mismo ID
            fecha: nuevaFecha,
            hora: nuevaHora,
            editado: true,
            fechaEdicion: new Date().toISOString(),
            notificaciones: { 
                emailEnviado: false, 
                whatsappEnviado: false 
            }
        };

        citas.push(nuevaCita);

        // En Supabase, actualizamos la cita directamente (upsert)
        await CitasManager.upsert(nuevaCita, window.currentTenantId);
        await ServiciosManager.save(servicio);
        
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

        const citasUsuario = citas.filter(c => {
            if (userId && c.contacto?.userId) {
                return String(c.contacto.userId) === String(userId);
            }
            if (session?.nombre && c.contacto?.nombre) {
                return String(c.contacto.nombre).trim().toLowerCase() === String(session.nombre).trim().toLowerCase();
            }
            // Si no hay sesión (anónimo), mostrar todas las citas del tenant actual
            if (!session) {
                return true;
            }
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
            const fecha = escapeHtml(cita.fecha || '—');
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
    // 2. Limpiar sesion en Supabase
    try {
        await supabaseClient.auth.signOut();
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
document.addEventListener('DOMContentLoaded', async function () {
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
        await NotificacionesAdminManager.eliminarViejos(7);
    }

    await verificarProteccionRutas();
    popupEl = document.getElementById('popup-reserva');

        // ========== NUEVA LÓGICA: diferenciar superadmin / admin / cliente / planes ==========
    const esSuperAdmin = document.querySelector('.superadmin-screen');
    const esAdminNormal = document.querySelector('.admin-screen') && !esSuperAdmin;
    const esCliente = document.querySelector('.client-screen');
    const esPlanes = document.getElementById('planes-container'); // <-- NUEVO

    if (esSuperAdmin) {
        // No hacer nada aquí, se inicia desde superadmin.html
    } else if (esAdminNormal) {
        await iniciarAdmin();
        if (typeof cargarServiciosExistentes === 'function') cargarServiciosExistentes();
    } else if (esCliente) {
        await iniciarCliente();
        if (typeof renderMisReservas === 'function') renderMisReservas();
        if (typeof renderCarrito === 'function') renderCarrito();
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

    // --- LOGIN con email/password ---
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('login-email')?.value.trim().toLowerCase();
            const password = document.getElementById('login-password')?.value;
            const remember = document.getElementById('remember-me')?.checked;

            if (!email || !password) {
                mostrarMensaje('Completa todos los campos', 'warning');
                return;
            }

            try {
                // Iniciar sesión con Supabase
                const { data, error } = await supabaseClient.auth.signInWithPassword({
                    email: email,
                    password: password
                });
                if (error) throw error;

                // Guardar JWT en localStorage via JwtManager
                if (window.JwtManager && data.session) {
                    window.JwtManager.setTokens(data.session.access_token, data.session.refresh_token);
                }

                // Recordarme (opcional: persistence local)
                if (remember) {
                    // Por defecto Supabase ya guarda sesión, pero podemos forzar
                    await supabaseClient.auth.setSession(data.session);
                }

                mostrarMensaje('Inicio de sesión exitoso', 'success');
                // Redirigir según el rol
                const emailUser = data.user.email || '';
                const SUPER_ADMIN_EMAILS = ['super@demo.com'];
                const rol = SUPER_ADMIN_EMAILS.includes(emailUser) ? 'super_admin' : (data.user.user_metadata?.rol || 'cliente');
                if (rol === 'super_admin') {
                    window.location.href = 'superadmin.html';
                } else if (rol === 'admin') {
                    window.location.href = 'admin.html';
                } else {
                    window.location.href = 'cliente.html';
                }
            } catch (err) {
                console.error('Error login:', err);
                let msg = err.message;
                if (msg.includes('Invalid login credentials')) msg = 'Correo o contraseña incorrectos';
                if (loginErrorDiv) {
                    loginErrorDiv.textContent = msg;
                    loginErrorDiv.style.display = 'block';
                } else {
                    mostrarMensaje(msg, 'error');
                }
            }
        });
    }

    // --- REGISTRO con creación automática de tenant (versión corregida) ---
    if (registerForm) {
        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const nombre = document.getElementById('register-name')?.value.trim();
            const email = document.getElementById('register-email')?.value.trim().toLowerCase();
            const password = document.getElementById('register-password')?.value;
            const confirm = document.getElementById('register-confirm-password')?.value;
            const whatsappRaw = document.getElementById('register-whatsapp')?.value.trim();

            if (!nombre || !email || !password || !whatsappRaw) {
                mostrarMensaje('Completa todos los campos', 'warning');
                return;
            }
            if (password !== confirm) {
                mostrarMensaje('Las contraseñas no coinciden', 'error');
                return;
            }
            if (password.length < 6) {
                mostrarMensaje('La contraseña debe tener al menos 6 caracteres', 'error');
                return;
            }

            const digits = whatsappRaw.replace(/\D/g, '');
            if (digits.length < 8) {
                mostrarMensaje('Número de WhatsApp inválido (mínimo 8 dígitos)', 'error');
                return;
            }
            let whatsappClean = digits;
            if (whatsappRaw.startsWith('+')) {
                whatsappClean = '+' + digits;
            }

            try {
                // 1. Registrar usuario en Auth
                const { data: signUpData, error: signUpError } = await supabaseClient.auth.signUp({
                    email: email,
                    password: password,
                    options: {
                        data: {
                            nombre: nombre,
                            rol: 'cliente',      // temporal, luego se actualizará a admin
                            whatsapp: whatsappClean
                        }
                    }
                });
                if (signUpError) throw signUpError;

                // Pequeña pausa para que Supabase complete el registro
                await new Promise(resolve => setTimeout(resolve, 1000));

                // 2. Iniciar sesión automáticamente (para tener sesión activa)
                const { error: signInError } = await supabaseClient.auth.signInWithPassword({
                    email: email,
                    password: password
                });
                if (signInError) throw signInError;

                // 3. Verificar que la sesión esté activa
                const { data: { session }, error: sessionError } = JwtManager.getSession();
                if (sessionError || !session) throw new Error('No se pudo establecer la sesión');

                // 4. Crear tenant (ahora con usuario autenticado)
                const { data: tenant, error: tenantError } = await supabaseClient
                    .from('tenants')
                    .insert({
                        nombre_negocio: nombre + "'s negocio",
                        email_contacto: email,
                        plan: null
                    })
                    .select()
                    .single();
                if (tenantError) throw tenantError;

                // 4. Actualizar metadatos del usuario (rol admin y tenant_id)
                const { error: updateError } = await supabaseClient.auth.updateUser({
                    data: {
                        tenant_id: tenant.id,
                        rol: 'admin',
                        nombre: nombre
                    }
                });
                if (updateError) throw updateError;

                // 5. Refrescar sesión para obtener nuevos metadatos
                await supabaseClient.auth.refreshSession();

                mostrarMensaje(`¡Cuenta creada! Bienvenido ${nombre}`, 'success');
                // Redirigir a planes.html para elegir plan
                setTimeout(() => {
                    window.location.href = `planes.html?tenant_id=${tenant.id}&new=true`;
                }, 1500);

            } catch (err) {
                console.error('Error registro:', err);
                let msg = err.message;
                if (msg.includes('User already registered')) msg = 'El correo ya está registrado';
                if (registerErrorDiv) {
                    registerErrorDiv.textContent = msg;
                    registerErrorDiv.style.display = 'block';
                } else {
                    mostrarMensaje(msg, 'error');
                }
            }
        });
    }

    // --- Botón de Google (signInWithOAuth) ---
    if (googleBtn) {
        googleBtn.addEventListener('click', async () => {
            try {
                const { error } = await supabaseClient.auth.signInWithOAuth({
                    provider: 'google',
                    options: {
                        redirectTo: window.location.origin + '/admin.html'
                    }
                });
                if (error) throw error;
            } catch (err) {
                console.error('Error en Google OAuth:', err);
                mostrarToast('Error al iniciar con Google: ' + err.message, 'error');
            }
        });
    }

    // --- Recuperación de contraseña ---
    if (forgotLink) {
        forgotLink.addEventListener('click', (e) => {
            e.preventDefault();
            const modal = document.getElementById('reset-modal');
            const resetEmail = document.getElementById('reset-email');
            const resetMessage = document.getElementById('reset-message');
            resetEmail.value = '';
            resetMessage.style.display = 'none';
            modal.style.display = 'flex';
        });
    }

    // Configurar eventos del modal de reset
    const resetModal = document.getElementById('reset-modal');
    const closeModalBtn = resetModal?.querySelector('.modal-close');
    const cancelBtn = document.getElementById('btn-cancel-reset');
    const sendBtn = document.getElementById('btn-send-reset');

    if (resetModal) {
        const cerrarModal = () => { resetModal.style.display = 'none'; };
        closeModalBtn?.addEventListener('click', cerrarModal);
        cancelBtn?.addEventListener('click', cerrarModal);
        window.addEventListener('click', (e) => { if (e.target === resetModal) cerrarModal(); });
        
        sendBtn?.addEventListener('click', async () => {
            const email = document.getElementById('reset-email').value.trim();
            const messageDiv = document.getElementById('reset-message');
            if (!email) {
                messageDiv.textContent = 'Por favor ingresa tu correo electrónico.';
                messageDiv.style.display = 'block';
                return;
            }
            sendBtn.disabled = true;
            sendBtn.textContent = 'Enviando...';
            try {
                const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
                    redirectTo: window.location.origin + '/login.html'  // redirige al login después de cambiar pass
                });
                if (error) throw error;
                messageDiv.style.color = '#00b894';
                messageDiv.textContent = '¡Revisa tu correo! Te hemos enviado un enlace para restablecer tu contraseña.';
                messageDiv.style.display = 'block';
                setTimeout(() => cerrarModal(), 4000);
            } catch (err) {
                console.error(err);
                messageDiv.style.color = '#e74c3c';
                messageDiv.textContent = err.message || 'Error al enviar el correo. Intenta nuevamente.';
                messageDiv.style.display = 'block';
            } finally {
                sendBtn.disabled = false;
                sendBtn.textContent = 'Enviar enlace';
            }
        });
    }

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

// --- Inicializar SuperAdmin (fallback si modulos no cargan) ---
window.iniciarSuperAdmin = async function() {
    if (window.__tenantsApi && window.__subscriptionsApi) {
        // Sistema modular cargado, delegar a SuperAdminView.js
        return;
    }
    
    // Fallback legacy: usar supabaseClient directamente
    await cargarTenants();
    await cargarEstadisticasGlobales();
    await cargarMetricasGlobales();
    setupSuperAdminTabs();
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
                    else if (targetId === 'solicitudes') await cargarSolicitudesCSS();
                } catch(e) {
                    console.warn(`Error cargando tab ${targetId}:`, e);
                }
            }
        });
    });
}

// --- Estadísticas globales (fallback completo con supabaseClient directo) ---
async function cargarEstadisticasGlobales() {
    if (!supabaseClient) return;
    try {
        // Tenants
        const { count: tenantsCount } = await supabaseClient.from('tenants').select('*', { count: 'exact', head: true });
        const elTenants = document.getElementById('total-tenants');
        if (elTenants) elTenants.innerText = tenantsCount || 0;
        
        // Servicios globales (sin tenantId = super admin)
        const { count: serviciosCount } = await supabaseClient.from('servicios').select('*', { count: 'exact', head: true });
        const elServicios = document.getElementById('total-servicios');
        if (elServicios) elServicios.innerText = serviciosCount || 0;
        
        // Citas globales
        const { count: citasCount } = await supabaseClient.from('citas').select('*', { count: 'exact', head: true });
        const elCitas = document.getElementById('total-citas');
        if (elCitas) elCitas.innerText = citasCount || 0;
        
        // Usuarios via vista
        try {
            const { count: usersCount } = await supabaseClient.from('usuarios_con_rol').select('id', { count: 'exact', head: true });
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
        // 1. MRR via API de suscripciones
        const { data: subs } = await supabaseClient.from('subscriptions').select('plan, status');
        const activeSubs = (subs || []).filter(s => s.status === 'active');
        let mrr = 0;
        let countPro = 0, countPremium = 0;
        activeSubs.forEach(sub => {
            if (sub.plan === 'pro') { mrr += 5000; countPro++; }
            else if (sub.plan === 'premium_anual') { mrr += 3000; countPremium++; }
        });
        const mrrEl = document.getElementById('mrr-value');
        if (mrrEl) mrrEl.textContent = '$' + mrr.toLocaleString();
        const planEl = document.getElementById('plan-breakdown');
        if (planEl) planEl.innerHTML = `Pro: ${countPro} | Premium Anual: ${countPremium}`;

        // 2. Evolución tenants (mensual)
        const { data: tenants } = await supabaseClient.from('tenants').select('fecha_registro');
        if (!tenants || tenants.length === 0) return;

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
        if (window.tenantsChart) window.tenantsChart.destroy();
        canvas.removeAttribute('width');
        canvas.removeAttribute('height');
        canvas.style.width = '100%';
        canvas.style.height = '300px';

        const ctx = canvas.getContext('2d');
        window.tenantsChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: sortedKeys,
                datasets: [{
                    label: 'Tenants registrados',
                    data: counts,
                    borderColor: '#b300ff',
                    backgroundColor: 'rgba(179,0,255,0.1)',
                    fill: true,
                    tension: 0.3
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { position: 'top' },
                    tooltip: { mode: 'index', intersect: false }
                },
                scales: {
                    x: {
                        ticks: { maxRotation: 45, minRotation: 30, autoSkip: true }
                    }
                }
            }
        });
    } catch (e) {
        console.error('Error en métricas globales:', e);
    }
}

// --- Usuarios con acciones (reemplaza la tabla simple) ---
async function cargarUsuariosSuper() {
    const tbody = document.getElementById('users-list-body');
    if (!tbody) return;
    
    tbody.innerHTML = '<tr><td colspan="5">Cargando...</td></tr>';
    
    try {
        let users;
        // Intentar API modular; si no existe, usar supabaseClient directo
        if (window.__usuariosApi && typeof window.__usuariosApi.getAll === 'function') {
            users = await window.__usuariosApi.getAll();
        } else {
            console.log('[cargarUsuariosSuper] Usando fallback legacy (supabaseClient directo)');
            const { data, error } = await supabaseClient
                .from('usuarios_con_rol')
                .select('*');
            if (error) throw error;
            users = data;
        }
        
        if (!users || users.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5">No hay usuarios registrados</td></tr>';
            return;
        }
        
        let html = '';
        users.forEach(user => {
            let rolBadge = '';
            if (user.rol === 'super_admin') rolBadge = '<span class="role-badge-super">Super Admin</span>';
            else if (user.rol === 'admin') rolBadge = '<span class="role-badge-admin">Admin</span>';
            else rolBadge = '<span class="role-badge-cliente">Cliente</span>';
            
            html += `<tr>
                <td>${escapeHtml(user.email)}</td>
                <td>${escapeHtml(user.nombre || '-')}</td>
                <td>${rolBadge}</td>
                <td>${escapeHtml(user.tenant_id || 'N/A')}</td>
                <td class="action-icons">
                    ${user.rol !== 'super_admin' ? `
                        <select onchange="cambiarRolUsuarioDirecto('${user.id}', this.value)" class="filter-select" style="padding:4px; width:100px;">
                            <option value="cliente" ${user.rol === 'cliente' ? 'selected' : ''}>Cliente</option>
                            <option value="admin" ${user.rol === 'admin' ? 'selected' : ''}>Admin</option>
                            <option value="super_admin" ${user.rol === 'super_admin' ? 'selected' : ''}>Super Admin</option>
                        </select>
                        <button class="btn-small danger" style="margin-left:8px;" onclick="eliminarUsuarioDirecto('${user.id}')"><i class="fas fa-trash"></i></button>
                    ` : '<span>—</span>'}
                </td>
            </tr>`;
        });
        
        tbody.innerHTML = html;
        
    } catch (error) {
        console.error('Error cargando usuarios:', error);
        tbody.innerHTML = '<tr><td colspan="5">Error al cargar usuarios</td></tr>';
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
            .from('usuarios_con_rol')
            .update({ rol: nuevoRol })
            .eq('id', userId);
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
            .from('usuarios_con_rol')
            .delete()
            .eq('id', userId);
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
        let servicios;
        if (window.__serviciosApi && typeof window.__serviciosApi.getAll === 'function') {
            servicios = await window.__serviciosApi.getAll();
        } else {
            console.log('[cargarServiciosGlobales] Usando fallback legacy');
            const { data, error } = await supabaseClient
                .from('servicios')
                .select('*, tenants:tenant_id(nombre_negocio)');
            if (error) throw error;
            servicios = data;
        }
        
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
        let citas;
        if (window.__appointmentsApi && typeof window.__appointmentsApi.getAllCitas === 'function') {
            citas = await window.__appointmentsApi.getAllCitas();
        } else {
            console.log('[cargarCitasGlobales] Usando fallback legacy');
            const { data, error } = await supabaseClient
                .from('citas')
                .select('*, tenants:tenant_id(nombre_negocio), servicios:servicio_id(nombre)');
            if (error) throw error;
            citas = data;
        }
        
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

async function cargarSolicitudesCSS() {
    const container = document.getElementById('solicitudes-list');
    if (!container) return;
    container.innerHTML = '<p>Cargando solicitudes...</p>';
    try {
        let data;
        if (window.__notificacionesApi && typeof window.__notificacionesApi.getAll === 'function') {
            data = await window.__notificacionesApi.getAll();
        } else {
            console.log('[cargarSolicitudesCSS] Usando fallback legacy');
            const { data: notifs, error } = await supabaseClient
                .from('notificaciones_admin')
                .select('*, tenants:tenant_id(nombre_negocio)')
                .order('creado_en', { ascending: false })
                .limit(50);
            if (error) throw error;
            data = notifs;
        }
        if (!data || data.length === 0) {
            container.innerHTML = '<p>No hay solicitudes pendientes.</p>';
            return;
        }
        let html = '';
        data.forEach(s => {
            const tenantName = s.tenants?.nombre_negocio || 'Desconocido';
            const fecha = new Date(s.creado_en).toLocaleString();
            const descripcion = s.metadata?.descripcion || 'Sin descripción';
            html += `
                <div class="solicitud-item" data-id="${s.id}" data-tenant-id="${s.tenant_id}">
                    <div class="solicitud-header">
                        <span class="solicitud-tenant">${escapeHtml(tenantName)}</span>
                        <span class="solicitud-fecha">${fecha}</span>
                    </div>
                    <div class="solicitud-descripcion">${escapeHtml(descripcion)}</div>
                    <div class="solicitud-actions">
                        <button class="btn-grad btn-small aplicar-css" data-id="${s.id}" data-tenant="${s.tenant_id}"><i class="fas fa-code"></i> Aplicar CSS</button>
                        <button class="btn-secondary btn-small descartar-solicitud" data-id="${s.id}"><i class="fas fa-trash"></i> Descartar</button>
                    </div>
                </div>
            `;
        });
        container.innerHTML = html;
        // Eventos
        document.querySelectorAll('.aplicar-css').forEach(btn => {
            btn.addEventListener('click', () => abrirModalAplicarCSS(btn.dataset.id, btn.dataset.tenant));
        });
        document.querySelectorAll('.descartar-solicitud').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (confirm('¿Descartar esta solicitud?')) {
                    try {
                        if (window.__notificacionesApi && typeof window.__notificacionesApi.delete === 'function') {
                            const { error } = await window.__notificacionesApi.delete(btn.dataset.id);
                            if (error) throw error;
                        } else {
                            const { error } = await supabaseClient
                                .from('notificaciones_admin')
                                .delete()
                                .eq('id', btn.dataset.id);
                            if (error) throw error;
                        }
                        mostrarToast('Solicitud descartada', 'success');
                        cargarSolicitudesCSS();
                    } catch(e) {
                        mostrarToast('Error al descartar', 'error');
                    }
                }
            });
        });
    } catch (e) {
        console.error(e);
        container.innerHTML = '<p>Error al cargar solicitudes.</p>';
    }
}

async function abrirModalAplicarCSS(solicitudId, tenantId) {
    // Crear modal dinámico o reutilizar uno existente
    let modal = document.getElementById('modal-aplicar-css');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'modal-aplicar-css';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content glass-panel">
                <span class="modal-close">&times;</span>
                <h3>Aplicar CSS personalizado</h3>
                <textarea id="aplicar-css-text" rows="6" style="width:100%; margin:15px 0; padding:10px; background:rgba(255,255,255,0.05); color:#fff;" placeholder="Escribe aquí el CSS personalizado..."></textarea>
                <div class="form-actions">
                    <button id="guardar-css-tenant" class="btn-grad">Guardar y marcar como atendida</button>
                    <button id="cancelar-aplicar-css" class="btn-secondary">Cancelar</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('.modal-close').onclick = () => modal.style.display = 'none';
        modal.querySelector('#cancelar-aplicar-css').onclick = () => modal.style.display = 'none';
    }
    modal.style.display = 'flex';
    const guardarBtn = document.getElementById('guardar-css-tenant');
    const textarea = document.getElementById('aplicar-css-text');
    // Remover eventos previos para evitar duplicados
    const newGuardarBtn = guardarBtn.cloneNode(true);
    guardarBtn.parentNode.replaceChild(newGuardarBtn, guardarBtn);
    newGuardarBtn.onclick = async () => {
        const customCss = textarea.value.trim();
        if (!customCss) {
            mostrarToast('El CSS no puede estar vacío', 'warning');
            return;
        }
        // Actualizar tenant_config
        const { error } = await supabaseClient
            .from('tenant_config')
            .upsert({ tenant_id: tenantId, custom_css: customCss }, { onConflict: 'tenant_id' });
        if (error) {
            mostrarToast('Error al guardar CSS', 'error');
            return;
        }
        // Eliminar la solicitud
        await window.__notificacionesApi.delete(solicitudId);
        mostrarToast('CSS aplicado y solicitud atendida', 'success');
        modal.style.display = 'none';
        cargarSolicitudesCSS();
        // Opcional: refrescar también la lista de tenants (para reflejar cambios visuales)
        if (typeof cargarTenants === 'function') cargarTenants();
    };
}



// Función auxiliar para abrir modal con datos del tenant (si no existe)
async function abrirModalEditarTenant(tenantId) {
    // Asumiendo que ya tienes una función que maneja el modal, aquí solo un ejemplo:
    try {
        const { data: tenant } = await supabaseClient
            .from('tenants')
            .select('*')
            .eq('id', tenantId)
            .single();
        
        if (tenant) {
            document.getElementById('tenant-id').value = tenant.id;
            document.getElementById('tenant-nombre').value = tenant.nombre;
            document.getElementById('tenant-email').value = tenant.email_contacto || '';
            document.getElementById('tenant-plan').value = tenant.plan || 'freemium';
            document.getElementById('tenant-estado').value = tenant.estado || 'activo';
            document.getElementById('modal-title').textContent = 'Editar Tenant';
            document.getElementById('tenant-modal').style.display = 'flex';
        }
    } catch (error) {
        console.error('Error abriendo modal:', error);
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

    // Generar enlace
    getCurrentTenantId().then(tenantId => {
        if (tenantId) {
            const baseUrl = window.location.origin + window.location.pathname.replace(/admin\.html.*/, 'cliente.html');
            linkInput.value = `${baseUrl}?tenant=${tenantId}`;
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
                qrContainer.appendChild(qrImg);
                qrContainer.style.display = 'flex';
            };
            qrImg.onerror = () => {
                mostrarToast('Error al generar el QR', 'error');
            };
        });
    }
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
// JwtManager - Gestion de JWT en localStorage
// ============================================
// Proporciona control explicito sobre los tokens JWT de Supabase.
// Se integra con getSession(), login() y cerrarSesion() existentes.
// ============================================

const STORAGE_KEYS = {
    ACCESS_TOKEN: 'agendapro_access_token',
    REFRESH_TOKEN: 'agendapro_refresh_token',
    USER_DATA: 'agendapro_user_data'
};

function decodeJWTPayload(token) {
    try {
        const payload = token.split('.')[1];
        return JSON.parse(atob(payload));
    } catch (e) {
        return null;
    }
}

window.JwtManager = {
    setTokens(accessToken, refreshToken) {
        localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, accessToken);
        if (refreshToken) {
            localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, refreshToken);
        }
        const payload = decodeJWTPayload(accessToken);
        if (payload) {
            const meta = payload.user_metadata || {};
            localStorage.setItem(STORAGE_KEYS.USER_DATA, JSON.stringify({
                id: payload.sub,
                nombre: meta.nombre || (payload.email ? payload.email.split('@')[0] : 'Usuario'),
                email: payload.email,
                rol: meta.rol || 'cliente',
                tenant_id: meta.tenant_id
            }));
        }
    },

    getAccessToken() {
        return localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
    },

    getRefreshToken() {
        return localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN);
    },

    getUserData() {
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.USER_DATA);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    },

    isTokenExpired() {
        const token = this.getAccessToken();
        if (!token) return true;
        const payload = decodeJWTPayload(token);
        if (!payload || !payload.exp) return true;
        return (payload.exp * 1000) <= (Date.now() + 60000);
    },

    async refreshToken(supabaseClient) {
        const refreshToken = this.getRefreshToken();
        if (!refreshToken) return false;
        try {
            const { data, error } = await supabaseClient.auth.refreshSession();
            if (error || !data || !data.session) {
                this.clear();
                return false;
            }
            this.setTokens(data.session.access_token, data.session.refresh_token);
            return true;
        } catch (e) {
            console.error('[JwtManager] Error refreshing token:', e);
            this.clear();
            return false;
        }
    },

    getSession() {
        const accessToken = this.getAccessToken();
        const refreshToken = this.getRefreshToken();
        const user = this.getUserData();
        if (!accessToken || !user) return null;
        return { access_token: accessToken, refresh_token: refreshToken, user: user };
    },

    clear() {
        localStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN);
        localStorage.removeItem(STORAGE_KEYS.REFRESH_TOKEN);
        localStorage.removeItem(STORAGE_KEYS.USER_DATA);
    }
};
