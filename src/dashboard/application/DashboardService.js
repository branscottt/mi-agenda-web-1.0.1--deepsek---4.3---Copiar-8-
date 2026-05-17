// dashboard/application/DashboardService.js
// Datos agregados para el dashboard del admin
// Toda la logica de datos va a traves de las APIs de dominio (sin supabase directo)

import { getAllServicios } from '../../api/serviciosApi.js';
import { getAllCitas } from '../../api/appointmentsApi.js';
import { getCurrentTenantId } from '../../shared/infrastructure/router.js';

export async function getDashboardStats(optionalTenantId) {
    try {
        const tenantId = optionalTenantId || await getCurrentTenantId();
        if (!tenantId) return valoresDefault();

        const [citas, servicios] = await Promise.all([
            getAllCitas(tenantId),
            getAllServicios(tenantId)
        ]);

        const ahora = new Date();
        const hoy = ahora.toISOString().split('T')[0];

        const citasHoy = citas.filter(c => c.fecha === hoy);
        const citasPendientes = citas.filter(c => new Date(c.fecha + 'T' + (c.hora || '12:00')) >= ahora);
        const serviciosActivos = servicios.filter(s => s.activo !== false);

        // Top servicios por cantidad de citas
        const conteoServicios = {};
        citas.forEach(c => {
            const key = String(c.servicio_id);
            conteoServicios[key] = (conteoServicios[key] || 0) + 1;
        });
        const topServiciosIds = Object.entries(conteoServicios)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
        const topServicios = topServiciosIds.map(([id, count]) => {
            const sv = servicios.find(s => String(s.id) === id);
            return { nombre: sv?.nombre || 'Servicio #' + id, cantidad: count };
        });

        const totalVentas = citas.reduce((s, c) => s + (parseFloat(c.precio) || 0), 0);
        const ventasHoy = citasHoy.reduce((s, c) => s + (parseFloat(c.precio) || 0), 0);

        const ventasMes = citas.filter(c => {
            const f = new Date(c.fecha + 'T12:00:00');
            return !isNaN(f.getTime()) && f.getMonth() === ahora.getMonth() && f.getFullYear() === ahora.getFullYear();
        }).reduce((s, c) => s + (parseFloat(c.precio) || 0), 0);

        return {
            totalCitas: citas.length,
            citasHoy: citasHoy.length,
            citasPendientes: citasPendientes.length,
            totalServicios: serviciosActivos.length,
            totalVentas,
            ventasHoy,
            ventasMes,
            topServicios,
            crecimiento: 0
        };
    } catch (e) {
        console.error('Error getDashboardStats:', e);
        return valoresDefault();
    }
}

function valoresDefault() {
    return {
        totalCitas: 0, citasHoy: 0, citasPendientes: 0,
        totalServicios: 0, totalVentas: 0, ventasHoy: 0, ventasMes: 0,
        topServicios: [], crecimiento: 0
    };
}