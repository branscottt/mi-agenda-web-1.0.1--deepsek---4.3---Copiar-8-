// dashboard/application/DashboardService.js
// Datos agregados para el dashboard del admin
// Estadisticas de ventas, citas, servicios

import { getAllCitas } from '../../appointments/application/AppointmentService.js';
import { getAllServicios } from '../../services/application/ServiceService.js';
import { getAllVentas, calcularTotalVentas, getTopServicios } from '../../appointments/application/SalesService.js';
import { formatearDinero } from '../../shared/infrastructure/formatters.js';

export async function getDashboardStats() {
    try {
        const [citas, servicios, ventas] = await Promise.all([
            getAllCitas(),
            getAllServicios(),
            getAllVentas()
        ]);

        const ahora = new Date();
        const hoy = ahora.toISOString().split('T')[0];

        const citasHoy = citas.filter(c => c.fecha === hoy);
        const citasPendientes = citas.filter(c => new Date(c.fecha + 'T' + (c.hora || '12:00')) >= ahora);
        const totalVentasHoy = ventas.filter(v => v.fecha === hoy).reduce((s, v) => s + v.monto, 0);
        const totalVentasMes = ventas.filter(v => {
            const f = new Date(v.fechaVenta);
            return f.getMonth() === ahora.getMonth() && f.getFullYear() === ahora.getFullYear();
        }).reduce((s, v) => s + v.monto, 0);

        const serviciosActivos = servicios.filter(s => s.activo !== false);

        const topServicios = await getTopServicios(5);

        return {
            totalCitas: citas.length,
            citasHoy: citasHoy.length,
            citasPendientes: citasPendientes.length,
            totalServicios: serviciosActivos.length,
            totalVentas: ventas.reduce((s, v) => s + v.monto, 0),
            ventasHoy: totalVentasHoy,
            ventasMes: totalVentasMes,
            topServicios: topServicios.slice(0, 5),
            crecimiento: calcularCrecimiento(ventas)
        };
    } catch (e) {
        console.error('Error getDashboardStats:', e);
        return {
            totalCitas: 0, citasHoy: 0, citasPendientes: 0,
            totalServicios: 0, totalVentas: 0, ventasHoy: 0, ventasMes: 0,
            topServicios: [], crecimiento: 0
        };
    }
}

function calcularCrecimiento(ventas) {
    const ahora = new Date();
    const mesActual = ventas.filter(v => {
        const f = new Date(v.fechaVenta);
        return f.getMonth() === ahora.getMonth() && f.getFullYear() === ahora.getFullYear();
    });
    const mesAnterior = ventas.filter(v => {
        const f = new Date(v.fechaVenta);
        const mesAnt = ahora.getMonth() === 0 ? 11 : ahora.getMonth() - 1;
        const añoAnt = ahora.getMonth() === 0 ? ahora.getFullYear() - 1 : ahora.getFullYear();
        return f.getMonth() === mesAnt && f.getFullYear() === añoAnt;
    });

    const totalActual = mesActual.reduce((s, v) => s + v.monto, 0);
    const totalAnterior = mesAnterior.reduce((s, v) => s + v.monto, 0);
    if (totalAnterior === 0) return totalActual > 0 ? 100 : 0;
    return Math.round(((totalActual - totalAnterior) / totalAnterior) * 100);
}