// catalog/application/CatalogService.js
// Catalogo de servicios visible al cliente con carrito de compras
// Lee servicios desde Supabase, filtra solo activos con disponibilidad futura

import { getSupabase } from '../../shared/infrastructure/supabase.js';
import { getCurrentTenantId } from '../../shared/infrastructure/router.js';

// --- Estado del carrito (singleton en memoria) ---
let _carrito = [];
let _carritoListeners = [];

export function suscribirseCarrito(fn) {
    _carritoListeners.push(fn);
    return () => {
        _carritoListeners = _carritoListeners.filter(l => l !== fn);
    };
}

function notificarCarrito() {
    _carritoListeners.forEach(fn => {
        try { fn([..._carrito]); } catch(e) { console.error('Error en listener carrito:', e); }
    });
}

export function getCarrito() {
    return [..._carrito];
}

export function agregarAlCarrito(item) {
    const existente = _carrito.find(i => i.id === item.id && i.fecha === item.fecha && i.hora === item.hora);
    if (existente) {
        mostrarToast('Ya agregaste este horario', 'warning');
        return false;
    }
    _carrito.push({
        ...item,
        carritoId: Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    });
    notificarCarrito();
    return true;
}

export function quitarDelCarrito(carritoId) {
    _carrito = _carrito.filter(i => i.carritoId !== carritoId);
    notificarCarrito();
}

export function vaciarCarrito() {
    _carrito = [];
    notificarCarrito();
}

export function totalCarrito() {
    return _carrito.reduce((sum, i) => sum + (Number(i.precio) || 0), 0);
}

// --- Servicios del catalogo ---

export async function getCatalogoServicios(optionalTenantId) {
    const tenantId = optionalTenantId || await getCurrentTenantId();
    if (!tenantId) return [];
    try {
        const { data, error } = await getSupabase()
            .from('servicios')
            .select('id, nombre, categoria, precio, descripcion, imagen, destacado, activo, disponibilidad, fechas, created_at')
            .eq('tenant_id', String(tenantId).trim())
            .eq('activo', true)
            .order('created_at', { ascending: false });
        if (error) throw error;

        const ahora = new Date();
        return (data || [])
            .map(s => ({
                id: s.id,
                nombre: s.nombre,
                categoria: s.categoria,
                precio: Number(s.precio) || 0,
                descripcion: s.descripcion || '',
                imagen: s.imagen || 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874',
                destacado: s.destacado || false,
                disponibilidad: s.disponibilidad || {},
                fechas: s.fechas || Object.keys(s.disponibilidad || {})
            }))
            .filter(s => tieneDisponibilidadFutura(s, ahora));
    } catch (e) {
        console.error('Error getCatalogoServicios:', e);
        return [];
    }
}

function tieneDisponibilidadFutura(servicio, ahora) {
    const fechas = servicio.fechas || Object.keys(servicio.disponibilidad || {});
    return fechas.some(f => {
        const partes = f.split('-');
        if (partes.length !== 3) return false;
        const fechaServ = new Date(partes[0], partes[1] - 1, partes[2], 12);
        if (fechaServ < new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate())) return false;
        const modulos = servicio.disponibilidad[f] || [];
        return modulos.some(m => {
            if (Number(m.cupos || 0) <= 0) return false;
            if (fechaServ.toDateString() === ahora.toDateString()) {
                const hora = m.startTime || '00:00';
                const hp = hora.match(/(\d{1,2}):(\d{2})/);
                if (!hp) return true;
                const fh = new Date();
                fh.setHours(parseInt(hp[1]), parseInt(hp[2]), 0, 0);
                return fh > ahora;
            }
            return true;
        });
    });
}

export function getFechasDisponibles(servicio) {
    const fechas = servicio.fechas || Object.keys(servicio.disponibilidad || {});
    const ahora = new Date();
    const hoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
    return fechas
        .filter(f => {
            const partes = f.split('-');
            if (partes.length !== 3) return false;
            const fechaServ = new Date(partes[0], partes[1] - 1, partes[2], 12);
            return fechaServ >= hoy;
        })
        .sort();
}

export function getHorariosDisponibles(servicio, fecha) {
    const modulos = servicio.disponibilidad?.[fecha] || [];
    const ahora = new Date();
    const esHoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate()).toISOString().split('T')[0] === fecha;
    return modulos.filter(m => {
        if (Number(m.cupos || 0) <= 0) return false;
        if (esHoy) {
            const hora = m.startTime || '00:00';
            const hp = hora.match(/(\d{1,2}):(\d{2})/);
            if (!hp) return true;
            const fh = new Date();
            fh.setHours(parseInt(hp[1]), parseInt(hp[2]), 0, 0);
            return fh > ahora;
        }
        return true;
    });
}

// --- Reserva final ---

export async function confirmarReserva(contacto) {
    const tenantId = await getCurrentTenantId();
    if (!tenantId || !_carrito.length) throw new Error('Carrito vacio o sesion expirada');

    const citas = _carrito.map(item => ({
        tenant_id: String(tenantId).trim(),
        servicio_id: item.id,
        servicio_nombre: item.nombre,
        fecha: item.fecha,
        hora: item.hora,
        precio: item.precio,
        contacto: contacto,
        notificaciones: { emailEnviado: false, whatsappEnviado: false }
    }));

    const { data, error } = await getSupabase().from('citas').insert(citas).select();
    if (error) throw new Error('Error al reservar: ' + error.message);

    vaciarCarrito();
    return data;
}