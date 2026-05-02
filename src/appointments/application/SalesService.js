// appointments/application/SalesService.js
// Ventas derivadas de citas. No persiste ventas separadas - todo sale de appointments.

import { getAllCitas } from './AppointmentService.js';
import { formatearDinero } from '../../shared/infrastructure/formatters.js';

export async function getAllVentas() {
    const citas = await getAllCitas();
    return citas.map(c => ({
        id: `VENTA-${c.id}`,
        citaId: c.id,
        servicioId: c.servicioId,
        servicioNombre: c.nombre,
        clienteNombre: c.contacto?.nombre || 'Cliente',
        clienteEmail: c.contacto?.email || '',
        clienteTelefono: c.contacto?.telefono || '',
        fecha: c.fecha,
        hora: c.hora,
        monto: Number(c.precio) || 0,
        fechaVenta: c.creadoEn,
        mes: new Date(c.creadoEn).getMonth() + 1,
        año: new Date(c.creadoEn).getFullYear(),
        diaSemana: new Date(c.creadoEn).getDay()
    }));
}

export async function getVentasPorRango(fechaInicio, fechaFin) {
    const ventas = await getAllVentas();
    const inicio = new Date(fechaInicio).getTime();
    const fin = new Date(fechaFin).getTime();
    return ventas.filter(v => {
        const fv = new Date(v.fechaVenta).getTime();
        return fv >= inicio && fv <= fin;
    });
}

export async function getVentasHoy() {
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const mañana = new Date(hoy); mañana.setDate(mañana.getDate() + 1);
    return getVentasPorRango(hoy.toISOString(), mañana.toISOString());
}

export async function getVentasSemana() {
    const hoy = new Date();
    const inicio = new Date(hoy); inicio.setDate(hoy.getDate() - hoy.getDay() + (hoy.getDay() === 0 ? -6 : 1)); inicio.setHours(0, 0, 0, 0);
    const fin = new Date(inicio); fin.setDate(inicio.getDate() + 7);
    return getVentasPorRango(inicio.toISOString(), fin.toISOString());
}

export async function getVentasMes() {
    const hoy = new Date();
    const inicio = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    const fin = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 1);
    return getVentasPorRango(inicio.toISOString(), fin.toISOString());
}

export function calcularTotalVentas(ventas) {
    return ventas.reduce((sum, v) => sum + (v.monto || 0), 0);
}

export async function getTopServicios(limite = 5) {
    const ventas = await getAllVentas();
    const conteo = {};
    ventas.forEach(v => {
        const id = v.servicioId;
        if (!conteo[id]) conteo[id] = { id, nombre: v.servicioNombre, cantidad: 0, total: 0 };
        conteo[id].cantidad++;
        conteo[id].total += v.monto;
    });
    return Object.values(conteo).sort((a, b) => b.cantidad - a.cantidad).slice(0, limite);
}