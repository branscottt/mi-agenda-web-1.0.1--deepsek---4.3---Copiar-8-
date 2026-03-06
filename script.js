// ============================================
// VARIABLES GLOBALES (originales)
// ============================================
let currentDate = new Date();
let selectedDates = new Set();
let popupEl = null;

// Estado para reprogramación
let esReprogramacion = false;
let reprogramInfo = { citaId: null, serviceId: null, citaActual: null };
let idCitaEnEdicion = null;

// Módulos de horario (admin)
let serviceModules = [];
let moduleDateCupos = {};

// Filtros (cliente)
let currentFilterTerm = '';
let currentFilterDate = '';
let currentFilterCategory = 'todos'; // <-- AÑADIR ESTA LÍNEA

// ============================================
// UTILIDADES DE FORMATO (originales, pero optimizadas)
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
// normalizarHora es alias (se mantiene para compatibilidad, pero internamente usamos limpiarHora)
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
// GESTIÓN DE CITAS (nuevo, pero integrado sin romper funciones existentes)
// ============================================
const CitasManager = {
    getAll() {
        try {
            return JSON.parse(localStorage.getItem('agendaPro_citas')) || [];
        } catch {
            return [];
        }
    },
    save(citas) {
        localStorage.setItem('agendaPro_citas', JSON.stringify(citas));
    },
    // Limpieza genérica (usada internamente por las funciones específicas)
    limpiar(opciones = {}) {
        const { soloCompletadas = false, soloSinId = false, soloVencidas = false, soloInvalidas = false } = opciones;
        let citas = this.getAll();
        const hoy = new Date();
        hoy.setHours(0, 0, 0, 0);

        const filtradas = citas.filter(c => {
            if (!c) return false;

            if (soloCompletadas && c.estado === 'completada') return false;

            if (soloSinId) {
                const id = c.id;
                const validId = (typeof id === 'number' && !isNaN(id)) || (typeof id === 'string' && id.trim() !== '');
                if (!validId) return false;
            }

            if (soloInvalidas) {
                const nombre = c.nombreCliente ?? c.contacto?.nombre ?? '';
                const telefono = c.telefono ?? c.contacto?.telefono ?? '';
                const invalid = s => !s || /^[-—\s]+$/.test(String(s).trim());
                if (invalid(nombre) || invalid(telefono)) return false;
            }

            if (soloVencidas && c.fecha) {
                let citaDate = null;
                const partes = String(c.fecha).split('-');
                if (partes.length === 3) {
                    citaDate = new Date(partes[0], partes[1] - 1, partes[2]);
                } else {
                    citaDate = new Date(c.fecha);
                }
                if (citaDate && !isNaN(citaDate.getTime())) {
                    const citaDia = new Date(citaDate);
                    citaDia.setHours(0, 0, 0, 0);
                    if (citaDia < hoy) return false;
                }
            }

            return true;
        });

        if (filtradas.length !== citas.length) {
            this.save(filtradas);
            return true;
        }
        return false;
    },
    sanear() {
        let citas = this.getAll();
        const servicios = JSON.parse(localStorage.getItem('agendaPro_servicios')) || [];
        const validServiceIds = new Set(servicios.map(s => String(s.id)));
        let cambiado = false;

        citas = citas.filter(c => {
            if (!c) return false;
            if (c.id !== undefined && c.id !== null) {
                c.id = String(c.id);
            }
            if (c.hora) {
                const hLim = limpiarHora(c.hora);
                if (hLim !== c.hora) {
                    c.hora = hLim;
                    cambiado = true;
                }
            }
            if (!validServiceIds.has(String(c.servicioId))) {
                cambiado = true;
                return false;
            }
            return true;
        });

        if (cambiado) this.save(citas);
    },
    finalizar(citaId) {
        const citas = this.getAll();
        const idStr = String(citaId);
        const idx = citas.findIndex(c => String(c.id) === idStr);
        if (idx === -1) {
            mostrarToast('Cita no encontrada', 'error');
            return false;
        }
        citas.splice(idx, 1);
        this.save(citas);
        return true;
    }
};
// ============================================
// GESTIÓN DE VENTAS (NUEVO - FASE 3)
// ============================================
const VentasManager = {
    // Obtener todas las ventas
    getAll() {
        try {
            return JSON.parse(localStorage.getItem('agendaPro_ventas')) || [];
        } catch {
            return [];
        }
    },
    
    // Guardar ventas
    save(ventas) {
        localStorage.setItem('agendaPro_ventas', JSON.stringify(ventas));
    },
    
    // Registrar una venta a partir de una cita completada
    registrarDesdeCita(cita) {
        const ventas = this.getAll();
        
        const venta = {
            id: 'VENTA-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
            citaId: cita.id,
            servicioId: cita.servicioId,
            servicioNombre: cita.nombre || 'Servicio',
            clienteNombre: cita.contacto?.nombre || cita.nombreCliente || 'Cliente',
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
        
        ventas.push(venta);
        this.save(ventas);
        return venta;
    },
    
    // Obtener ventas por rango de fechas
    getPorRango(fechaInicio, fechaFin) {
        const ventas = this.getAll();
        const inicio = new Date(fechaInicio).getTime();
        const fin = new Date(fechaFin).getTime();
        
        return ventas.filter(v => {
            const fechaVenta = new Date(v.fechaVenta).getTime();
            return fechaVenta >= inicio && fechaVenta <= fin;
        });
    },
    
    // Obtener ventas de hoy
    getHoy() {
        const hoy = new Date();
        hoy.setHours(0, 0, 0, 0);
        const mañana = new Date(hoy);
        mañana.setDate(mañana.getDate() + 1);
        
        return this.getPorRango(hoy.toISOString(), mañana.toISOString());
    },
    
    // Obtener ventas de esta semana
    getSemana() {
        const hoy = new Date();
        const inicioSemana = new Date(hoy);
        inicioSemana.setDate(hoy.getDate() - hoy.getDay() + (hoy.getDay() === 0 ? -6 : 1));
        inicioSemana.setHours(0, 0, 0, 0);
        
        const finSemana = new Date(inicioSemana);
        finSemana.setDate(inicioSemana.getDate() + 7);
        
        return this.getPorRango(inicioSemana.toISOString(), finSemana.toISOString());
    },
    
    // Obtener ventas de este mes
    getMes() {
        const hoy = new Date();
        const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
        const finMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 1);
        
        return this.getPorRango(inicioMes.toISOString(), finMes.toISOString());
    },
    
    // Calcular total de ventas
    calcularTotal(ventas) {
        return ventas.reduce((sum, v) => sum + (v.monto || 0), 0);
    },
    
    // Obtener servicios más vendidos
    getTopServicios(limite = 5) {
        const ventas = this.getAll();
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

// Exportar al objeto window
window.VentasManager = VentasManager;

// ============================================
// DASHBOARD FINANCIERO (NUEVO - FASE 3)
// ============================================
function actualizarDashboardFinanzas() {
    actualizarEstadisticasTriples();
    actualizarTopServicios();
    actualizarKPIs();
    renderizarGraficoVentas();
}

// Actualizar estadísticas diarias/semanales/mensuales
function actualizarEstadisticasTriples() {
    // Ventas hoy
    const ventasHoy = VentasManager.getHoy();
    const totalHoy = VentasManager.calcularTotal(ventasHoy);
    document.getElementById('valor-diario').textContent = formatearPeso(totalHoy);
    document.getElementById('detalle-diario').textContent = `${ventasHoy.length} venta${ventasHoy.length !== 1 ? 's' : ''}`;
    
    // Ventas esta semana
    const ventasSemana = VentasManager.getSemana();
    const totalSemana = VentasManager.calcularTotal(ventasSemana);
    document.getElementById('valor-semanal').textContent = formatearPeso(totalSemana);
    document.getElementById('detalle-semanal').textContent = `${ventasSemana.length} venta${ventasSemana.length !== 1 ? 's' : ''}`;
    
    // Ventas este mes
    const ventasMes = VentasManager.getMes();
    const totalMes = VentasManager.calcularTotal(ventasMes);
    document.getElementById('valor-mensual').textContent = formatearPeso(totalMes);
    document.getElementById('detalle-mensual').textContent = `${ventasMes.length} venta${ventasMes.length !== 1 ? 's' : ''}`;
}

// Actualizar top servicios
function actualizarTopServicios() {
    const container = document.getElementById('top-servicios');
    if (!container) return;
    
    const topServicios = VentasManager.getTopServicios(5);
    
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

// Actualizar KPIs
function actualizarKPIs() {
    const ventas = VentasManager.getAll();
    
    // Ticket promedio
    const totalVentas = ventas.length;
    const montoTotal = VentasManager.calcularTotal(ventas);
    const ticketPromedio = totalVentas > 0 ? montoTotal / totalVentas : 0;
    document.getElementById('kpi-ticket-promedio').textContent = formatearPeso(ticketPromedio);
    document.getElementById('kpi-total-ventas').textContent = totalVentas;
    
    // Clientes únicos
    const clientesUnicos = new Set(ventas.map(v => v.clienteEmail).filter(Boolean)).size;
    document.getElementById('kpi-clientes-unicos').textContent = clientesUnicos || '0';
    
    // Día pico (día de la semana con más ventas)
    const diasSemana = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const conteoDias = [0, 0, 0, 0, 0, 0, 0];
    
    ventas.forEach(v => {
        const fecha = new Date(v.fechaVenta);
        const dia = fecha.getDay(); // 0 = Domingo
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
// GRÁFICO DE VENTAS (FASE 3)
// ============================================
let ventasChart = null;

function renderizarGraficoVentas() {
    const canvas = document.getElementById('ventas-chart');
    if (!canvas) return;
    
    // Destruir gráfico anterior si existe
    if (ventasChart) {
        ventasChart.destroy();
    }
    
    // Obtener ventas de los últimos 7 días
    const ventas = VentasManager.getAll();
    const fechas = [];
    const montos = [];
    
    // Generar últimos 7 días
    for (let i = 6; i >= 0; i--) {
        const fecha = new Date();
        fecha.setDate(fecha.getDate() - i);
        fecha.setHours(0, 0, 0, 0);
        
        const fechaStr = fecha.toLocaleDateString('es-ES', { 
            day: '2-digit', 
            month: '2-digit' 
        });
        
        const fechaISO = fecha.toISOString().slice(0,10);
        fechas.push(fechaStr);
        
        // Sumar ventas de ese día
        const ventasDia = ventas.filter(v => {
            const vFecha = new Date(v.fechaVenta).toISOString().slice(0,10);
            return vFecha === fechaISO;
        });
        
        const totalDia = VentasManager.calcularTotal(ventasDia);
        montos.push(totalDia);
    }
    
    // Crear gráfico
    const ctx = canvas.getContext('2d');
    
    ventasChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: fechas,
            datasets: [{
                label: 'Ventas diarias',
                data: montos,
                borderColor: '#b300ff',
                backgroundColor: 'rgba(179, 0, 255, 0.1)',
                borderWidth: 3,
                pointBackgroundColor: '#fff',
                pointBorderColor: '#b300ff',
                pointBorderWidth: 2,
                pointRadius: 4,
                pointHoverRadius: 6,
                tension: 0.3,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return formatearPeso(context.raw);
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)'
                    },
                    ticks: {
                        color: '#aaa',
                        callback: function(value) {
                            return formatearPeso(value);
                        }
                    }
                },
                x: {
                    grid: {
                        display: false
                    },
                    ticks: {
                        color: '#aaa'
                    }
                }
            }
        }
    });
}

// Modificar actualizarDashboardFinanzas para incluir gráfico
function actualizarDashboardFinanzas() {
    actualizarEstadisticasTriples();
    actualizarTopServicios();
    actualizarKPIs();
    renderizarGraficoVentas(); // Añadir esta línea
}

// Filtro por rango de fechas
function aplicarFiltroFechas() {
    const fechaInicio = document.getElementById('fecha-inicio')?.value;
    const fechaFin = document.getElementById('fecha-fin')?.value;
    
    if (!fechaInicio || !fechaFin) {
        mostrarToast('Selecciona ambas fechas', 'warning');
        return;
    }
    
    // Ajustar fin para incluir todo el día
    const finDate = new Date(fechaFin);
    finDate.setHours(23, 59, 59, 999);
    
    const ventasFiltradas = VentasManager.getPorRango(fechaInicio, finDate.toISOString());
    const totalFiltrado = VentasManager.calcularTotal(ventasFiltradas);
    
    // Mostrar resultado temporal
    mostrarToast(`${ventasFiltradas.length} ventas en el período: ${formatearPeso(totalFiltrado)}`, 'info');
    
    // Opcional: resaltar en dashboard
    document.getElementById('valor-mensual').textContent = formatearPeso(totalFiltrado);
    document.getElementById('detalle-mensual').textContent = `${ventasFiltradas.length} ventas (filtradas)`;
}

// Exportar a CSV
function exportarVentasCSV() {
    const ventas = VentasManager.getAll();
    
    if (ventas.length === 0) {
        mostrarToast('No hay ventas para exportar', 'warning');
        return;
    }
    
    // Cabeceras CSV
    const cabeceras = ['ID', 'Fecha Venta', 'Servicio', 'Cliente', 'Monto', 'Fecha Cita', 'Hora'];
    
    // Filas de datos
    const filas = ventas.map(v => [
        v.id,
        new Date(v.fechaVenta).toLocaleDateString('es-CL'),
        v.servicioNombre,
        v.clienteNombre,
        v.monto,
        v.fecha,
        v.hora
    ]);
    
    // Convertir a CSV
    const csvContent = [
        cabeceras.join(','),
        ...filas.map(f => f.map(cell => `"${cell}"`).join(','))
    ].join('\n');
    
    // Descargar archivo
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

// Configurar eventos del dashboard
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

// Inicializar fechas por defecto (primer día del mes hasta hoy)
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

// Modificar iniciarAdmin para incluir dashboard
const originalIniciarAdmin = iniciarAdmin;
window.iniciarAdmin = function() {
    if (originalIniciarAdmin) originalIniciarAdmin();
    
    // Inicializar dashboard
    inicializarFechasDashboard();
    actualizarDashboardFinanzas();
    configurarDashboardEventos();
};

// Exportar funciones
window.actualizarDashboardFinanzas = actualizarDashboardFinanzas;
window.exportarVentasCSV = exportarVentasCSV;

// Funciones de limpieza (mantienen nombres y firma originales)
function limpiarCitasAntiguas() {
    CitasManager.limpiar({ soloInvalidas: true });
}
window.limpiarCitasAntiguas = limpiarCitasAntiguas;

function limpiarCitasCompletasYSinId() {
    CitasManager.limpiar({ soloCompletadas: true, soloSinId: true });
}
window.limpiarCitasCompletasYSinId = limpiarCitasCompletasYSinId;

function limpiarCitasVencidas() {
    CitasManager.limpiar({ soloVencidas: true });
}
window.limpiarCitasVencidas = limpiarCitasVencidas;

function sanearBaseDeDatos() {
    CitasManager.sanear();
}
window.sanearBaseDeDatos = sanearBaseDeDatos;

function finalizarCita(citaId) {
    const citas = CitasManager.getAll();
    const cita = citas.find(c => String(c.id) === String(citaId));
    
    if (cita && CitasManager.finalizar(citaId)) {
        // Registrar en ventas
        VentasManager.registrarDesdeCita(cita);
        
        if (typeof renderAdminAppointments === 'function') renderAdminAppointments();
        if (typeof updateProjectedRevenue === 'function') updateProjectedRevenue();
        if (typeof actualizarDashboardFinanzas === 'function') actualizarDashboardFinanzas();
        
        mostrarToast('Servicio completado. Ingresos actualizados', 'success');
    }
}
window.finalizarCita = finalizarCita;
// 1. Agregar función después de finalizarCita (línea ~600)
function noAsistioCita(citaId) {
    const citas = CitasManager.getAll();
    const cita = citas.find(c => String(c.id) === String(citaId));
    
    if (!cita) {
        mostrarToast('Cita no encontrada', 'error');
        return;
    }

    if (!confirm(`¿Confirmas que ${cita.contacto?.nombre || cita.nombreCliente || 'el cliente'} NO ASISTIÓ a su cita?`)) {
        return;
    }

    try {
        const servicios = JSON.parse(localStorage.getItem('agendaPro_servicios')) || [];
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
            localStorage.setItem('agendaPro_servicios', JSON.stringify(servicios));
        }
    } catch (e) { 
        console.warn('No se pudo devolver cupo al servicio', e); 
    }

    if (CitasManager.finalizar(citaId)) {
        if (typeof renderAdminAppointments === 'function') renderAdminAppointments();
        if (typeof updateProjectedRevenue === 'function') updateProjectedRevenue();
        if (typeof renderCarrito === 'function') renderCarrito();
        
        mostrarToast('Cita marcada como No Asistió. Cupo liberado.', 'info');
    }
}
window.noAsistioCita = noAsistioCita;
// Dentro de admin.js o en la sección de funciones de admin
// ============================================
// RENDERIZADO DE NOTIFICACIONES (VERSIÓN MODIFICADA CON CAMBIOS ADMIN)
// ============================================
function renderNotificaciones(lista) {
  const container = document.getElementById('notifications-list');
  if (!container) return;

  // Obtener notificaciones de cambios admin
  const notifsAdmin = NotificacionesAdminManager.getAll();
  const noLeidas = notifsAdmin.filter(n => !n.leido);
  
  // Combinar con las notificaciones existentes
  const todas = [
    ...lista.map(c => ({ ...c, tipoOrigen: 'reserva' })),
    ...noLeidas.map(n => ({ ...n, tipoOrigen: 'cambio' }))
  ];

  if (todas.length === 0) {
    container.innerHTML = '<p class="empty">✨ No hay notificaciones pendientes</p>';
    return;
  }

  // Ordenar por fecha (más reciente primero)
  todas.sort((a, b) => new Date(b.creadoEn || 0) - new Date(a.creadoEn || 0));

  let html = '';
  todas.forEach(item => {
    if (item.tipoOrigen === 'reserva') {
      // Renderizado existente para reservas
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
        <div class="notification-item ${claseTipo}" data-cita-id="${item.id}" data-origen="reserva">
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
    } else {
      // Renderizado para cambios admin (ESTILO DIFERENCIADO)
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
}
function setupNotificacionesListeners() {
    const container = document.getElementById('notifications-list');
    if (!container) return;
    
    container.addEventListener('click', function(e) {
        const btn = e.target.closest('.btn-notify');
        if (!btn) return;
        
        e.preventDefault(); // Evita que el enlace se abra inmediatamente
        
        const notificacion = btn.closest('.notification-item');
        if (!notificacion) return;
        
        // Obtener datos según el origen
        const origen = notificacion.dataset.origen;
        const citaId = notificacion.dataset.citaId;
        const notifId = notificacion.dataset.notifId;
        const tipo = btn.dataset.tipo; // 'email' o 'whatsapp'
        
        // === MANEJO SEGÚN ORIGEN ===
        if (origen === 'reserva' && citaId) {
            // Lógica existente para reservas
            let citas = CitasManager.getAll();
            const citaIndex = citas.findIndex(c => String(c.id) === String(citaId));
            if (citaIndex === -1) return;
            
            const cita = citas[citaIndex];
            const esNueva = notificacion.classList.contains('new-reservation');
            const esProxima = notificacion.classList.contains('upcoming');
            
            // Asegurar que existe el objeto notificaciones
            if (!cita.notificaciones) {
                cita.notificaciones = { emailEnviado: false, whatsappEnviado: false };
            }
            
            // Marcar según corresponda
            if (tipo === 'email' && esNueva) {
                cita.notificaciones.emailEnviado = true;
            } else if (tipo === 'whatsapp' && esProxima) {
                cita.notificaciones.whatsappEnviado = true;
            }
            
            // Guardar cambios
            citas[citaIndex] = cita;
            CitasManager.save(citas);
            
        } else if (origen === 'cambio' && notifId) {
            // ✅ NUEVO: Marcar como leída la notificación de cambio admin
            NotificacionesAdminManager.marcarComoLeido(notifId);
            
            // Actualizar contador de notificaciones admin si existe
            if (typeof actualizarContadorNotificacionesAdmin === 'function') {
                actualizarContadorNotificacionesAdmin();
            }
        }
        
        // Abrir el enlace real (para ambos tipos)
        const href = btn.getAttribute('href');
        if (href) {
            window.open(href, '_blank');
        }
        
        // Regenerar notificaciones completas (reservas + cambios)
        if (typeof generarNotificaciones === 'function') {
            generarNotificaciones();
        }
    });
}
function generarNotificaciones() {
  const citas = CitasManager.getAll();
  const ahora = new Date();
  const limiteNuevas = 24 * 60 * 60 * 1000; // 24h en ms

  // Filtrar citas nuevas (creadas en las últimas 24h) que NO tengan emailEnviado = true
  const nuevas = citas.filter(c => {
    // Verificar que tenga el campo notificaciones y que emailEnviado sea false
    const emailNoEnviado = !c.notificaciones || c.notificaciones.emailEnviado === false;
    if (!emailNoEnviado) return false; // Si ya se envió email, excluir
    
    const creado = new Date(c.creadoEn || c.fechaCreacion || 0);
    return (ahora - creado) <= limiteNuevas;
  });

  // Filtrar citas próximas (fecha/hora dentro de las próximas 24h) que NO tengan whatsappEnviado = true
  const proximas = citas.filter(c => {
    try {
      // Verificar que tenga el campo notificaciones y que whatsappEnviado sea false
      const whatsappNoEnviado = !c.notificaciones || c.notificaciones.whatsappEnviado === false;
      if (!whatsappNoEnviado) return false; // Si ya se envió WhatsApp, excluir
      
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

  // ✅ NUEVO: Obtener notificaciones de cambios admin no leídas
  const notifsAdmin = NotificacionesAdminManager.getAll();
  const noLeidas = notifsAdmin.filter(n => !n.leido);

  // Combinar en un array con tipo
  const notificaciones = [
    ...nuevas.map(c => ({ ...c, tipo: 'nueva' })),
    ...proximas.map(c => ({ ...c, tipo: 'proxima' }))
  ];

  renderNotificaciones(notificaciones);
}

// ============================================
// NOTIFICACIONES DE CAMBIOS ADMIN
// ============================================
// Sistema de almacenamiento para cambios realizados por admin
const NotificacionesAdminManager = {
    // Obtener todas las notificaciones de cambios admin
    getAll() {
        try {
            return JSON.parse(localStorage.getItem('agendaPro_notificacionesAdmin')) || [];
        } catch {
            return [];
        }
    },
    
    // Guardar notificaciones
    save(notificaciones) {
        localStorage.setItem('agendaPro_notificacionesAdmin', JSON.stringify(notificaciones));
    },
    
    // Marcar una notificación como leída
    marcarComoLeido(id) {
        const notifs = this.getAll();
        const idx = notifs.findIndex(n => n.id === id);
        if (idx !== -1) {
            notifs[idx].leido = true;
            this.save(notifs);
            return true;
        }
        return false;
    },
    
    // Eliminar notificaciones antiguas (por defecto > 7 días)
    eliminarViejos(dias = 7) {
        const notifs = this.getAll();
        const ahora = new Date();
        const filtradas = notifs.filter(n => {
            const creado = new Date(n.creadoEn);
            const diffDias = (ahora - creado) / (1000 * 60 * 60 * 24);
            return diffDias <= dias;
        });
        
        if (filtradas.length !== notifs.length) {
            this.save(filtradas);
            return true;
        }
        return false;
    }
};

// Función para crear una notificación de cambio admin
function crearNotificacionCambioAdmin(citaOriginal, citaNueva) {
    // Determinar el cliente (priorizar contacto si existe)
    let cliente = citaOriginal.contacto || { 
        nombre: citaOriginal.nombreCliente || 'Cliente',
        telefono: citaOriginal.telefonoCliente || citaOriginal.contacto?.telefono || '',
        email: citaOriginal.contacto?.email || ''
    };
    
    // Asegurar que el nombre del cliente esté presente
    if (!cliente.nombre) {
        cliente.nombre = citaOriginal.nombreCliente || 'Cliente';
    }
    
    return {
        id: 'notif-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
        tipo: 'cambio-admin',
        citaId: citaNueva.id || citaOriginal.id,
        fechaOriginal: citaOriginal.fecha || '',
        horaOriginal: citaOriginal.hora || '',
        fechaNueva: citaNueva.fecha || '',
        horaNueva: citaNueva.hora || '',
        cliente: cliente,
        leido: false,
        creadoEn: new Date().toISOString()
    };
}

// Función para renderizar notificaciones de cambios admin
function renderNotificacionesCambiosAdmin() {
    const container = document.getElementById('admin-changes-list');
    if (!container) return;
    
    const notificaciones = NotificacionesAdminManager.getAll();
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
    
    // Agregar event listeners para marcar como leído
    container.querySelectorAll('.mark-read').forEach(btn => {
        btn.addEventListener('click', function() {
            const id = this.dataset.id;
            NotificacionesAdminManager.marcarComoLeido(id);
            renderNotificacionesCambiosAdmin();
            actualizarContadorNotificacionesAdmin();
        });
    });
}

// Función para actualizar el contador de notificaciones admin
function actualizarContadorNotificacionesAdmin() {
    const badge = document.getElementById('admin-notif-badge');
    if (!badge) return;
    
    const notificaciones = NotificacionesAdminManager.getAll();
    const noLeidas = notificaciones.filter(n => !n.leido).length;
    
    if (noLeidas > 0) {
        badge.textContent = noLeidas;
        badge.style.display = 'flex';
    } else {
        badge.style.display = 'none';
    }
}

// Exportar al objeto window
window.NotificacionesAdminManager = NotificacionesAdminManager;
window.crearNotificacionCambioAdmin = crearNotificacionCambioAdmin;
window.renderNotificacionesCambiosAdmin = renderNotificacionesCambiosAdmin;
window.actualizarContadorNotificacionesAdmin = actualizarContadorNotificacionesAdmin;

// Limpiar notificaciones antiguas al iniciar
(function limpiarNotificacionesAntiguas() {
    NotificacionesAdminManager.eliminarViejos(7);
})();

function creaNotificacionCambioAdmin(citaOriginal, citaNueva) {
    // Determinar el cliente (priorizar contacto si existe)
    let cliente = citaOriginal.contacto || { 
        nombre: citaOriginal.nombreCliente || 'Cliente',
        telefono: citaOriginal.telefonoCliente || citaOriginal.contacto?.telefono || '',
        email: citaOriginal.contacto?.email || ''
    };
    
    // Asegurar que el nombre del cliente esté presente
    if (!cliente.nombre) {
        cliente.nombre = citaOriginal.nombreCliente || 'Cliente';
    }
    
    return {
        id: 'notif-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
        tipo: 'cambio-admin',
        citaId: citaNueva.id || citaOriginal.id,
        fechaOriginal: citaOriginal.fecha || '',
        horaOriginal: citaOriginal.hora || '',
        fechaNueva: citaNueva.fecha || '',
        horaNueva: citaNueva.hora || '',
        cliente: cliente,
        leido: false,
        creadoEn: new Date().toISOString()
    };
}
// ============================================
// SESIÓN Y PROTECCIÓN DE RUTAS
// ============================================
function getSession() {
    try {
        const raw = localStorage.getItem('agendaPro_session');
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function verificarProteccionRutas() {
    try {
        const session = getSession();
        const pathname = (window.location.pathname || '').split('/').pop() || '';

        if (!session) {
            if (!/^(login\.html)$/i.test(pathname)) {
                window.location.href = 'login.html';
                return;
            }
            return;
        }

        if (/^(admin\.html)$/i.test(pathname)) {
            if (!session || session.rol !== 'admin') {
                window.location.href = 'login.html';
                return;
            }
        }
    } catch (err) {
        console.error('verificarProteccionRutas error', err);
    }
}
window.verificarProteccionRutas = verificarProteccionRutas;

// ============================================
// SISTEMA DE NOTIFICACIONES (Toast) - original
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
// FUNCIONES DE ADMIN (completadas con el segundo JS)
// ============================================
function diagnosticarDatos() {
    // diagnóstico silencioso
    const claves = ['agendaPro_servicios', 'servicios', 'services', 'agendaPro_services'];
    claves.forEach(clave => { localStorage.getItem(clave); });
}
window.diagnosticarDatos = diagnosticarDatos;

function crearDatosEjemplo() {
    let servicios = JSON.parse(localStorage.getItem('agendaPro_servicios')) || [];
    if (servicios.length === 0) {
        const serviciosEjemplo = [
            {
                id: 1,
                nombre: "Masaje Relajante",
                categoria: "bienestar",
                precio: 60,
                duracion: 60,
                capacidad: 4,
                imagen: "https://images.unsplash.com/photo-1544161515-4ab6ce6db874",
                descripcion: "Sesión de masaje terapeútico para aliviar tensiones y estrés. Incluye aromaterapia.",
                destacado: true,
                activo: true,
                fechas: ["2024-02-15", "2024-02-16", "2024-02-17"],
                fechaCreacion: new Date().toISOString()
            },
            {
                id: 2,
                nombre: "Corte de Cabello Premium",
                categoria: "belleza",
                precio: 35,
                duracion: 45,
                capacidad: 6,
                imagen: "https://images.unsplash.com/photo-1560066984-138dadb4c035",
                descripcion: "Corte profesional con lavado, tratamiento y acabado premium por nuestro estilista experto.",
                destacado: true,
                activo: true,
                fechas: ["2024-02-14", "2024-02-21", "2024-02-28"],
                fechaCreacion: new Date().toISOString()
            },
            {
                id: 3,
                nombre: "Facial Rejuvenecedor",
                categoria: "belleza",
                precio: 80,
                duracion: 90,
                capacidad: 3,
                imagen: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881",
                descripcion: "Tratamiento facial completo con productos premium para rejuvenecer la piel.",
                destacado: false,
                activo: true,
                fechas: ["2024-02-20", "2024-02-27"],
                fechaCreacion: new Date().toISOString()
            }
        ];
        localStorage.setItem('agendaPro_servicios', JSON.stringify(serviciosEjemplo));
        return serviciosEjemplo;
    }
    return servicios;
}
window.crearDatosEjemplo = crearDatosEjemplo;

function iniciarAdmin() {
    diagnosticarDatos();
    crearDatosEjemplo();
    limpiarCitasAntiguas();
    probarEventosBasicos();
    configurarFormulario();
    configurarPrevisualizacionImagen();
    configurarContadorCaracteres();
    configurarFiltros();
    configurarBotonesEspeciales();
    cargarProximasCitas();
    iniciarReloj();
    if (typeof renderAdminAppointments === 'function') renderAdminAppointments();
    initCalendar();
    initModules();
    if (typeof generarNotificaciones === 'function') generarNotificaciones();
    
    // ✅ NUEVA LÍNEA: Activar listeners de notificaciones
    if (typeof setupNotificacionesListeners === 'function') setupNotificacionesListeners();
}

window.iniciarAdmin = iniciarAdmin;

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

function crearServicio() {
    const nombre = document.getElementById('srv-name').value;
    const categoria = document.getElementById('srv-category').value;
    const precio = document.getElementById('srv-price').value;
    const activo = document.getElementById('srv-active').checked;

    if (!nombre || !categoria || !precio) {
        mostrarMensaje("Por favor completa todos los campos obligatorios", "error");
        return;
    }

    if (activo && selectedDates.size === 0) {
        mostrarMensaje("⚠️ El servicio está marcado como activo pero no tiene fechas seleccionadas. Selecciona al menos una fecha en el calendario.", "warning");
        return;
    }

    if (activo && serviceModules.length === 0) {
        mostrarMensaje("⚠️ El servicio está marcado como activo pero no tiene horarios configurados. Agrega al menos un horario.", "warning");
        return;
    }

    const duracion = serviceModules.length > 0 ? serviceModules[0].duration : 60;

    const disponibilidad = buildDisponibilidadFromForm();

    const nuevoServicio = {
        id: Date.now(),
        nombre: nombre,
        categoria: categoria,
        precio: parseFloat(precio),
        duracion: duracion,
        imagen: document.getElementById('srv-image-url').value || 'https://images.unsplash.com/photo-1544161515-4ab6ce6db874',
        descripcion: document.getElementById('srv-desc').value || '',
        destacado: document.getElementById('srv-featured').checked,
        activo: activo,
        disponibilidad: disponibilidad,
        fechas: Object.keys(disponibilidad).sort(),
        fechaCreacion: new Date().toISOString()
    };

    guardarServicio(nuevoServicio);
    mostrarMensaje(`✅ Servicio "${nombre}" creado con ${selectedDates.size} fecha(s) y ${serviceModules.length} horario(s)`, "success");

    document.getElementById('service-form').reset();
    selectedDates.clear();
    clearAllModules();
    renderCalendar();
    cargarServiciosExistentes();
}
window.crearServicio = crearServicio;

function buildDisponibilidadFromForm() {
    const disponibilidad = {};
    const modulesList = document.getElementById('modules-list');
    if (modulesList) {
        const inputs = modulesList.querySelectorAll('.module-cupos-input');
        inputs.forEach(inp => {
            const fecha = inp.dataset.fecha;
            const hora = inp.dataset.hora;
            moduleDateCupos[fecha] = moduleDateCupos[fecha] || {};
            moduleDateCupos[fecha][hora] = Number(inp.value || 0);
        });
    }
    const fechas = Array.from(selectedDates).sort();
    fechas.forEach(fecha => {
        disponibilidad[fecha] = serviceModules.map(m => {
            const hora = m.hora || m.startTime || '00:00';
            const cupos = (moduleDateCupos[fecha] && typeof moduleDateCupos[fecha][hora] !== 'undefined') ? Number(moduleDateCupos[fecha][hora]) : (typeof m.cupos !== 'undefined' ? Number(m.cupos) : 0);
            return {
                id: m.id || (Date.now() + Math.random()),
                hora: hora,
                cupos: cupos,
                duration: m.duration || 0
            };
        });
    });
    return disponibilidad;
}
window.buildDisponibilidadFromForm = buildDisponibilidadFromForm;

function guardarServicio(servicio) {
    let servicios = JSON.parse(localStorage.getItem('agendaPro_servicios')) || [];
    servicios.push(servicio);
    localStorage.setItem('agendaPro_servicios', JSON.stringify(servicios));
}
window.guardarServicio = guardarServicio;

function cargarServiciosExistentes() {
    const container = document.getElementById('services-cards');
    if (!container) {
        console.error("❌ No se encontró el contenedor de servicios");
        return;
    }

    const servicios = JSON.parse(localStorage.getItem('agendaPro_servicios')) || [];

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
                    document.getElementById('service-form').scrollIntoView({ behavior: 'smooth' });
                });
            }
        }, 100);
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

    function formatTimeDisplay(time24) {
        if (!time24) return '';
        const [hour, minute] = time24.split(':');
        const h = parseInt(hour);
        const ampm = h >= 12 ? 'PM' : 'AM';
        const hour12 = h % 12 || 12;
        return `${hour12}:${minute} ${ampm}`;
    }

    let html = '';

    servicios.forEach(servicio => {
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
        <div class="service-card-admin" data-service-id="${servicio.id}">
            <div class="service-card-header">
                <img src="${servicio.imagen}" alt="${servicio.nombre}" class="service-card-image">
                
                ${servicio.destacado ? `
                <div class="service-card-featured">
                    <i class="fas fa-star"></i> Destacado
                </div>
                ` : ''}
                
                <div class="service-card-category ${servicio.categoria}">
                    ${getCategoriaNombre(servicio.categoria)}
                </div>
                
                <div class="service-status ${servicio.activo ? 'active' : 'inactive'}">
                    ${servicio.activo ? 'Activo' : 'Inactivo'}
                </div>
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
            document.getElementById('srv-name').focus();
            document.querySelector('.admin-panel').scrollIntoView({ behavior: 'smooth' });
        });
    }
}
window.cargarServiciosExistentes = cargarServiciosExistentes;

function eliminarServicio(id) {
    if (!confirm("¿Estás seguro de eliminar este servicio?")) {
        return;
    }
    let servicios = JSON.parse(localStorage.getItem('agendaPro_servicios')) || [];
    servicios = servicios.filter(servicio => String(servicio.id) !== String(id));
    localStorage.setItem('agendaPro_servicios', JSON.stringify(servicios));
    cargarServicios();
    mostrarMensaje("Servicio eliminado correctamente", "success");
}
window.eliminarServicio = eliminarServicio;

function cargarServicios() {
    if (typeof cargarServiciosExistentes === 'function') {
        return cargarServiciosExistentes();
    }
    return cargarServiciosExistentes && cargarServiciosExistentes();
}
window.cargarServicios = cargarServicios;

function toggleActivoServicio(id) {
    let servicios = JSON.parse(localStorage.getItem('agendaPro_servicios')) || [];
    const servicio = servicios.find(s => String(s.id) === String(id));
    if (!servicio) {
        console.error("❌ Servicio no encontrado");
        return;
    }
    servicio.activo = !servicio.activo;
    localStorage.setItem('agendaPro_servicios', JSON.stringify(servicios));
    cargarServiciosExistentes();
    mostrarMensaje(
        `Servicio "${servicio.nombre}" ${servicio.activo ? 'activado ✅' : 'desactivado ⚠️'}`,
        "success"
    );
}
window.toggleActivoServicio = toggleActivoServicio;

function editarServicio(id) {
    let servicios = JSON.parse(localStorage.getItem('agendaPro_servicios')) || [];
    const servicio = servicios.find(s => String(s.id) === String(id));

    if (!servicio) {
        mostrarMensaje("Servicio no encontrado", "error");
        return;
    }

    document.getElementById('srv-name').value = servicio.nombre;
    document.getElementById('srv-category').value = servicio.categoria;
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
    document.getElementById('srv-desc').value = servicio.descripcion;
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
                        id: module.id || Date.now() + Math.random(),
                        hora: h,
                        cupos: (typeof module.cupos !== 'undefined') ? Number(module.cupos) : 0,
                        duration: module.duration || 0
                    };
                }
            });
        });
        Object.values(horaMap).forEach(h => serviceModules.push(h));
        moduleDateCupos = {};
        Object.keys(servicio.disponibilidad || {}).forEach(fecha => {
            moduleDateCupos[fecha] = {};
            (servicio.disponibilidad[fecha] || []).forEach(mod => {
                const hora = mod.hora || mod.startTime || '00:00';
                moduleDateCupos[fecha][hora] = Number(mod.cupos || 0);
            });
        });
        renderModulesList();
        saveModulesToHiddenField();
        updateDurationDisplay();
    } else if (servicio.modulos && servicio.modulos.length > 0) {
        servicio.modulos.forEach(module => {
            serviceModules.push({
                id: module.id || Date.now() + Math.random(),
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

function actualizarServicio(id) {
    let servicios = JSON.parse(localStorage.getItem('agendaPro_servicios')) || [];
    const index = servicios.findIndex(s => s.id === id);

    if (index === -1) {
        mostrarMensaje("Servicio no encontrado", "error");
        return;
    }

    const nombre = document.getElementById('srv-name').value;
    const categoria = document.getElementById('srv-category').value;
    const precio = document.getElementById('srv-price').value;
    const activo = document.getElementById('srv-active').checked;

    if (!nombre || !categoria || !precio) {
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

    const duracion = serviceModules.length > 0 ? serviceModules[0].duration : 60;

    const disponibilidadNueva = buildDisponibilidadFromForm();

    const servicioActualizado = {
        id: id,
        nombre: nombre,
        categoria: categoria,
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

    servicios[index] = servicioActualizado;
    localStorage.setItem('agendaPro_servicios', JSON.stringify(servicios));

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

function actualizarEstadisticas() {
    const servicios = JSON.parse(localStorage.getItem('agendaPro_servicios')) || [];

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

function actualizarStatsHeader() {
    const servicios = JSON.parse(localStorage.getItem('agendaPro_servicios')) || [];

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
    const filtroCategoria = document.getElementById('filter-category');
    const filtroEstado = document.getElementById('filter-status');
    const btnActualizar = document.getElementById('refresh-services');

    if (filtroCategoria) {
        filtroCategoria.addEventListener('change', aplicarFiltros);
    }

    if (filtroEstado) {
        filtroEstado.addEventListener('change', aplicarFiltros);
    }

    if (btnActualizar) {
        btnActualizar.addEventListener('click', function() {
            cargarServiciosExistentes();
            mostrarMensaje("Lista de servicios actualizada", "info");
        });
    }
}
window.configurarFiltros = configurarFiltros;

function aplicarFiltros() {
    const categoria = document.getElementById('filter-category')?.value || 'all';
    const estado = document.getElementById('filter-status')?.value || 'all';

    const tarjetas = document.querySelectorAll('.service-card-admin');

    if (tarjetas.length === 0) {
        return;
    }

    let visibleCount = 0;

    tarjetas.forEach(tarjeta => {
        const serviceId = parseInt(tarjeta.getAttribute('data-service-id'));
        const servicios = JSON.parse(localStorage.getItem('agendaPro_servicios')) || [];
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

        if (mostrar) {
            tarjeta.style.display = 'block';
            visibleCount++;
        } else {
            tarjeta.style.display = 'none';
        }
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
            const formulario = document.getElementById('service-form');
            if (formulario) {
                formulario.scrollIntoView({ 
                    behavior: 'smooth', 
                    block: 'start' 
                });
                formulario.style.boxShadow = '0 0 30px rgba(157, 78, 221, 0.5)';
                formulario.style.transition = 'box-shadow 0.5s';
                setTimeout(() => {
                    formulario.style.boxShadow = '';
                }, 2000);
                mostrarMensaje("¡Completa el formulario para crear tu primer servicio!", "info");
            }
        });
    }

    const btnLimpiar = document.getElementById('reset-form');
    if (btnLimpiar) {
        btnLimpiar.addEventListener('click', function() {
            setTimeout(() => {
                mostrarMensaje("Formulario limpiado", "info");
            }, 100);
        });
    }
}
window.configurarBotonesEspeciales = configurarBotonesEspeciales;

function cargarProximasCitas() {
    const contenedor = document.getElementById('upcoming-appointments');
    if (!contenedor) {
        console.error("❌ ERROR: No se encontró #upcoming-appointments");
        return;
    }

    const servicios = JSON.parse(localStorage.getItem('agendaPro_servicios')) || [];
    const totalCitas = servicios.length * 2;

    if (totalCitas === 0) {
        contenedor.innerHTML = `
            <div class="day empty">
                <i class="fas fa-calendar-times"></i>
                <p>No hay citas programadas</p>
                <small>Crea servicios primero</small>
            </div>
        `;
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

    contenedor.innerHTML = `
        <div class="day today">
            <strong>${nombreDia(hoy)}</strong>
            <div class="day-number">${hoy.getDate()}</div>
            <div class="appointments-count">
                <i class="fas fa-users"></i>
                <span>${Math.min(totalCitas, 5)}</span>
            </div>
        </div>
        
        <div class="day">
            <strong>${nombreDia(maniana)}</strong>
            <div class="day-number">${maniana.getDate()}</div>
            <div class="appointments-count">
                <i class="fas fa-users"></i>
                <span>${Math.min(totalCitas + 2, 8)}</span>
            </div>
        </div>
        
        <div class="day">
            <strong>${nombreDia(pasadoManiana)}</strong>
            <div class="day-number">${pasadoManiana.getDate()}</div>
            <div class="appointments-count">
                <i class="fas fa-users"></i>
                <span>${Math.min(totalCitas - 1, 3)}</span>
            </div>
        </div>
    `;
}
window.cargarProximasCitas = cargarProximasCitas;

function limpiarBaseDatos() {
    const confirmacion1 = confirm('¿Estás seguro de borrar TODAS las citas?');
    if(!confirmacion1) return;

    const confirmacion2 = confirm('Esta acción no se puede deshacer');
    if(!confirmacion2) return;

    try{
        localStorage.removeItem('agendaPro_citas');
        if(typeof renderAdminAppointments === 'function') renderAdminAppointments();
        if(typeof updateProjectedRevenue === 'function') updateProjectedRevenue();
        mostrarToast('Base de datos de citas eliminada correctamente', 'success');
    }catch(err){
        console.error('limpiarBaseDatos error', err);
        mostrarToast('Error al limpiar la base de datos', 'error');
    }
}
window.limpiarBaseDatos = limpiarBaseDatos;

function updateProjectedRevenue() {
    const target = document.getElementById('projected-revenue');
    if(!target) return;

    const raw = localStorage.getItem('agendaPro_citas');
    const citas = JSON.parse(raw || '[]');
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

// ============ CALENDARIO FUNCIONES ============
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
        moduleDateCupos[fecha] = moduleDateCupos[fecha] || {};
        serviceModules.forEach(mod => {
            if (typeof moduleDateCupos[fecha][mod.hora] === 'undefined') {
                moduleDateCupos[fecha][mod.hora] = Number(mod.cupos || 0);
            }
        });
    });

    renderModulesList();

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
}
window.selectWeekendsOnly = selectWeekendsOnly;

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
}
window.selectWeekdaysOnly = selectWeekdaysOnly;

// ============ FUNCIONES PARA MÓDULOS DE HORARIO ============
function initModules() {
    setupModuleEvents();
    updateDurationDisplay();
    loadModulesFromHiddenField();
}
window.initModules = initModules;

function setupModuleEvents() {
    document.getElementById('module-start-time')?.addEventListener('change', updateDurationDisplay);
    document.getElementById('module-end-time')?.addEventListener('change', updateDurationDisplay);

    document.getElementById('add-module-btn')?.addEventListener('click', addModule);

    document.getElementById('service-modules')?.addEventListener('change', function() {
        loadModulesFromHiddenField();
    });
}
window.setupModuleEvents = setupModuleEvents;

function updateDurationDisplay() {
    const startTime = document.getElementById('module-start-time')?.value;
    const endTime = document.getElementById('module-end-time')?.value;

    if (!startTime || !endTime) return;

    const [startHour, startMin] = startTime.split(':').map(Number);
    const [endHour, endMin] = endTime.split(':').map(Number);

    let durationMinutes = (endHour * 60 + endMin) - (startHour * 60 + startMin);

    if (durationMinutes < 0) {
        durationMinutes += 24 * 60;
    }

    const durationDisplay = document.getElementById('main-duration-display');
    if (durationDisplay) {
        durationDisplay.textContent = durationMinutes;
    }

    const smallDurationDisplay = document.getElementById('duration-minutes');
    if (smallDurationDisplay) {
        smallDurationDisplay.textContent = durationMinutes;
    }

    return durationMinutes;
}
window.updateDurationDisplay = updateDurationDisplay;

function addModule() {
    const startTime = document.getElementById('module-start-time')?.value;
    const endTime = document.getElementById('module-end-time')?.value;

    if (!startTime || !endTime) {
        mostrarMensaje("Selecciona hora inicio y hora fin", "warning");
        return;
    }

    const [startHour, startMin] = startTime.split(':').map(Number);
    const [endHour, endMin] = endTime.split(':').map(Number);

    let startTotal = startHour * 60 + startMin;
    let endTotal = endHour * 60 + endMin;

    if (endTotal <= startTotal) {
        if (endTotal + (24 * 60) <= startTotal + (24 * 60)) {
            mostrarMensaje("La hora fin debe ser mayor que la hora inicio", "error");
            return;
        }
    }

    const duration = updateDurationDisplay();

    const rawCap = document.getElementById('srv-capacity')?.value;
    const cupos = (rawCap === '') ? 0 : (parseInt(rawCap) || 0);

    const newModule = {
        id: Date.now() + Math.random(),
        hora: startTime,
        cupos: Number(cupos),
        duration: duration
    };

    serviceModules.push(newModule);
    Array.from(selectedDates).forEach(fecha => {
        moduleDateCupos[fecha] = moduleDateCupos[fecha] || {};
        moduleDateCupos[fecha][startTime] = Number(newModule.cupos || 0);
    });

    renderModulesList();
    saveModulesToHiddenField();

    mostrarMensaje(`Horario ${startTime} - ${endTime} agregado`, "success");
}
window.addModule = addModule;

function renderModulesList() {
    const modulesList = document.getElementById('modules-list');
    if (!modulesList) return;
    if (serviceModules.length === 0) {
        modulesList.innerHTML = `
            <div class="empty-modules">
                <i class="fas fa-clock"></i>
                <p>No hay horarios configurados</p>
                <small>Agrega al menos un horario</small>
            </div>
        `;
        return;
    }

    const fechas = Array.from(selectedDates).sort();
    let html = '<div class="modules-table">';
    html += '<div class="modules-table-head">';
    html += '<div class="col-hour"><strong>Hora</strong></div>';
    if (fechas.length > 0) {
        fechas.forEach(f => { html += `<div class="col-date"><strong>${f}</strong></div>`; });
    } else {
        html += `<div class="col-date"><strong>Plantilla / Cupos</strong></div>`;
    }
    html += '<div class="col-actions"><strong>Acciones</strong></div>';
    html += '</div>';

    serviceModules.forEach((module, index) => {
        const horaFormateada = formatTimeDisplay(module.hora || module.startTime || '00:00');
        html += `<div class="modules-table-row" data-module-id="${module.id}" data-hora="${module.hora}">`;
        html += `<div class="col-hour">${horaFormateada}</div>`;
        if (fechas.length > 0) {
            fechas.forEach(fecha => {
                const val = (moduleDateCupos[fecha] && typeof moduleDateCupos[fecha][module.hora] !== 'undefined') ? moduleDateCupos[fecha][module.hora] : (typeof module.cupos !== 'undefined' ? module.cupos : 0);
                html += `<div class="col-date"><input type="number" min="0" class="module-cupos-input" data-fecha="${fecha}" data-hora="${module.hora}" value="${val}"></div>`;
            });
        } else {
            const val = (typeof module.cupos !== 'undefined' ? module.cupos : 0);
            html += `<div class="col-date"><input type="number" min="0" class="module-cupos-input template-cupos-input" data-hora="${module.hora}" data-module-id="${module.id}" value="${val}"></div>`;
        }
        html += `<div class="col-actions"><button class="btn-remove-module" onclick="removeModule('${module.id}')" title="Eliminar horario"><i class="fas fa-times"></i></button></div>`;
        html += '</div>';
    });

    html += '</div>';
    modulesList.innerHTML = html;

    const inputs = modulesList.querySelectorAll('.module-cupos-input');
    inputs.forEach(inp => {
        inp.addEventListener('change', function(){
            const fecha = this.dataset.fecha;
            const hora = this.dataset.hora || this.dataset.hora;
            const v = Number(this.value || 0);
            if (fecha) {
                moduleDateCupos[fecha] = moduleDateCupos[fecha] || {};
                moduleDateCupos[fecha][hora] = v;
            } else {
                const moduleId = this.dataset.moduleId;
                let mod = null;
                if (moduleId) mod = serviceModules.find(m => String(m.id) === String(moduleId));
                if (!mod) mod = serviceModules.find(m => String(m.hora) === String(hora));
                if (mod) mod.cupos = v;
            }
        });
    });
}
window.renderModulesList = renderModulesList;

function removeModule(moduleId) {
    const modToRemove = serviceModules.find(m => String(m.id) === String(moduleId));
    const horaRemovida = modToRemove ? modToRemove.hora : null;

    serviceModules = serviceModules.filter(m => String(m.id) !== String(moduleId));

    if (horaRemovida) {
        Object.keys(moduleDateCupos).forEach(fecha => {
            if (moduleDateCupos[fecha] && Object.prototype.hasOwnProperty.call(moduleDateCupos[fecha], horaRemovida)) {
                delete moduleDateCupos[fecha][horaRemovida];
            }
            if (moduleDateCupos[fecha] && Object.keys(moduleDateCupos[fecha]).length === 0) {
                delete moduleDateCupos[fecha];
            }
        });
    }

    renderModulesList();
    saveModulesToHiddenField();
    updateDurationDisplay();
    mostrarMensaje("Horario eliminado", "info");
}
window.removeModule = removeModule;

function saveModulesToHiddenField() {
    const hiddenField = document.getElementById('service-modules');
    if (hiddenField) {
        hiddenField.value = JSON.stringify(serviceModules);
    }
}
window.saveModulesToHiddenField = saveModulesToHiddenField;

function loadModulesFromHiddenField() {
    const hiddenField = document.getElementById('service-modules');
    if (hiddenField && hiddenField.value) {
        try {
            const raw = JSON.parse(hiddenField.value);
            serviceModules = raw.map(m => {
                if (m.hora || m.cupos) {
                    return {
                        id: m.id || Date.now() + Math.random(),
                        hora: m.hora || m.startTime,
                        cupos: (typeof m.cupos !== 'undefined') ? Number(m.cupos) : (typeof m.capacidad !== 'undefined' ? Number(m.capacidad) : 0),
                        duration: m.duration || 0
                    };
                }
                return {
                    id: m.id || Date.now() + Math.random(),
                    hora: m.startTime || m.hora || '00:00',
                    cupos: (typeof m.capacidad !== 'undefined') ? Number(m.capacidad) : 0,
                    duration: m.duration || 0
                };
            });
            renderModulesList();
        } catch (e) {
            console.error("Error cargando módulos:", e);
            serviceModules = [];
        }
    }
}
window.loadModulesFromHiddenField = loadModulesFromHiddenField;

function clearAllModules() {
    serviceModules = [];
    renderModulesList();
    saveModulesToHiddenField();
    updateDurationDisplay();
}
window.clearAllModules = clearAllModules;

function getServiceDuration() {
    if (serviceModules.length > 0) {
        return serviceModules[0].duration || 0;
    }
    return 0;
}
window.getServiceDuration = getServiceDuration;

// ============================================
// RENDERIZADO DE CITAS (unificado internamente)
// ============================================

function _renderCitasBase(contenedorId, opciones = {}) {
    const container = document.getElementById(contenedorId);
    if (!container) return;

    const { soloUsuario = false, mostrarWhatsApp = false, mostrarFinalizar = false, mostrarCancelar = false, mostrarEditado = false, mostrarNoAsistio = false } = opciones;
    const session = getSession();
    const todas = CitasManager.getAll();

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

        html += `<tr data-id="${c.id}">`;
        html += `<td>${escapeHtml(nombre)}</td>`;
        html += `<td>${escapeHtml(telefono)}</td>`;
        html += `<td>${escapeHtml(servicio)}${editado}</td>`;
        html += `<td>${escapeHtml(fechaDisplay)}</td>`;
        html += `<td>${escapeHtml(hora)}</td>`;
        html += `<td class="action-buttons">`;

        // Botón WhatsApp
        if (mostrarWhatsApp && telefono !== '—') {
            html += `<button class="btn-small btn-whatsapp" data-phone="${escapeHtml(telefono)}" data-nombre="${escapeHtml(nombre)}" data-servicio="${escapeHtml(servicio)}" data-fecha="${escapeHtml(fechaDisplay)}" title="Contactar por WhatsApp"><i class="fab fa-whatsapp"></i></button> `;
        }
        
        // ✅ NUEVO: Botón Editar (admin)
        if (mostrarEditado) {
            html += `<button class="btn-small btn-edit-admin" data-id="${c.id}" title="Editar fecha/hora de la cita"><i class="fas fa-pen"></i></button> `;
        }
        
        // Botón Finalizar
        if (mostrarFinalizar) {
            html += `<button class="btn-small btn-complete" data-id="${c.id}" title="Marcar como completada (Asistió)"><i class="fas fa-check"></i></button> `;
        }
        
        // ✅ NUEVO: Botón No Asistió
        if (mostrarNoAsistio) {
            html += `<button class="btn-small btn-no-asistio" data-id="${c.id}" title="Marcar como No Asistió"><i class="fas fa-times"></i></button> `;
        }
        
        // Botón Cancelar
        if (mostrarCancelar) {
            html += `<button class="btn-small btn-cancel-res" data-id="${c.id}" title="Cancelar cita"><i class="fas fa-times"></i></button>`;
        }
        
        html += `</td></tr>`;
    });

    html += '</tbody></table>';
    container.innerHTML = html;

    // Event listeners para WhatsApp
    container.querySelectorAll('.btn-whatsapp').forEach(btn => {
        btn.addEventListener('click', function () {
            const phone = this.dataset.phone.replace(/[^\d+]/g, '');
            if (!phone) return;
            const msg = `Hola ${this.dataset.nombre}, te contacto por tu cita de ${this.dataset.servicio} el ${this.dataset.fecha}`;
            window.open(`https://api.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(msg)}`);
        });
    });

    // ✅ NUEVO: Event listeners para botón Editar
    container.querySelectorAll('.btn-edit-admin').forEach(btn => {
        btn.addEventListener('click', function() {
            const id = this.dataset.id;
            abrirModalEdicionCitaAdmin(id);
        });
    });

    // Event listeners para Finalizar
    container.querySelectorAll('.btn-complete').forEach(btn => {
        btn.addEventListener('click', function () {
            const id = this.dataset.id;
            finalizarCita(id);
        });
    });
    
    // ✅ NUEVO: Event listeners para No Asistió
    container.querySelectorAll('.btn-no-asistio').forEach(btn => {
        btn.addEventListener('click', function () {
            const id = this.dataset.id;
            noAsistioCita(id);
        });
    });

    // Event listeners para Cancelar
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
function abrirModalEdicionCitaAdmin(citaId) {
    const citas = CitasManager.getAll();
    const cita = citas.find(c => String(c.id) === String(citaId));
    
    if (!cita) {
        mostrarToast('Cita no encontrada', 'error');
        return;
    }

    const servicios = JSON.parse(localStorage.getItem('agendaPro_servicios')) || [];
    const servicio = servicios.find(s => String(s.id) === String(cita.servicioId));
    
    if (!servicio) {
        mostrarToast('Servicio no encontrado', 'error');
        return;
    }

    // Verificar disponibilidad
    if (!servicio.disponibilidad || Object.keys(servicio.disponibilidad).length === 0) {
        mostrarToast('El servicio no tiene horarios disponibles', 'warning');
        return;
    }

    // Verificar que haya fechas/horarios con cupos
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

    // Marcar modo edición admin
    window._modoEdicionAdmin = true;
    window._citaEnEdicionAdmin = cita;
    
    // Usar el modal de reprogramación existente
    abrirModalCambioFecha(citaId, cita.servicioId, cita);
}
window.abrirModalEdicionCitaAdmin = abrirModalEdicionCitaAdmin;

function renderAdminAppointments() {
    _renderCitasBase('upcoming-appointments', { 
        mostrarWhatsApp: true, 
        mostrarFinalizar: true,
        mostrarNoAsistio: true,
        mostrarEditado: true
    });
}
window.renderAdminAppointments = renderAdminAppointments;

function renderMisReservas() {
    _renderCitasBase('mis-reservas-list', { soloUsuario: true, mostrarCancelar: true });
}
window.renderMisReservas = renderMisReservas;

// ============================================
// FUNCIONES DE CLIENTE (completadas con el segundo JS)
// ============================================
function iniciarCliente() {
    currentFilterTerm = '';
    currentFilterDate = '';
    currentFilterCategory = 'todos'; // <-- AÑADIR ESTA LÍNEA
    cargarServiciosParaCliente();
    configurarBuscadorCliente();
    configurarFiltroFecha();

    const session = getSession();
    if (session && session.rol === 'invitado') {
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Iniciar Sesión / Registrarse';
            logoutBtn.onclick = () => window.location.href = 'login.html';
        }
    }
}
window.iniciarCliente = iniciarCliente;

function cargarServiciosParaCliente() {
    const gridContainer = document.getElementById('client-services-grid');
    if (!gridContainer) {
        console.error("❌ No se encontró el contenedor de servicios para cliente");
        return;
    }

    const servicios = JSON.parse(localStorage.getItem('agendaPro_servicios')) || [];
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

    // Configurar botones de categoría
    const filterBtns = document.querySelectorAll('.filter-btn');
    filterBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            // Quitar clase active de todos
            filterBtns.forEach(b => b.classList.remove('active'));
            // Añadir clase active al clickeado
            this.classList.add('active');
            
            // Obtener categoría (texto del botón, excepto "Más filtros")
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
                // Por ahora no hacemos nada, pero podrías abrir un modal
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

function aplicarFiltrosCombinados() {
    const servicios = JSON.parse(localStorage.getItem('agendaPro_servicios')) || [];
    const serviciosActivos = servicios.filter(s => s.activo === true);

    let serviciosFiltrados = serviciosActivos;

    // Filtrar por término de búsqueda (nombre)
    if (currentFilterTerm) {
        serviciosFiltrados = serviciosFiltrados.filter(servicio => 
            servicio.nombre.toLowerCase().includes(currentFilterTerm)
        );
    }

    // Filtrar por categoría
    if (currentFilterCategory && currentFilterCategory !== 'todos') {
        serviciosFiltrados = serviciosFiltrados.filter(servicio => 
            servicio.categoria === currentFilterCategory
        );
    }

    // Filtrar por fecha
    if (currentFilterDate) {
        serviciosFiltrados = serviciosFiltrados.filter(servicio => {
            return servicio.fechas && servicio.fechas.includes(currentFilterDate);
        });
    }

    actualizarGridCliente(serviciosFiltrados);

    // Mostrar mensaje si no hay resultados
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
            
            // Resetear UI
            document.querySelector('.search-box input').value = '';
            document.getElementById('filter-date').value = '';
            document.getElementById('filter-date').classList.remove('active-filter');
            
            // Reactivar botón "Todos"
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
// RESERVA Y REPROGRAMACIÓN
// ============================================
function abrirModalReserva(serviceId) {
    const servicios = JSON.parse(localStorage.getItem('agendaPro_servicios')) || [];
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

    if (typeof aplicarSesionAModal === 'function') aplicarSesionAModal(popupRef);

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

    // Validación del nombre: no debe estar vacío
    const nombreEl = document.getElementById('cliente-nombre');
    const nombreOk = nombreEl?.value?.trim() !== '';

    const telEl = document.getElementById('cliente-tel');
    const telRaw = telEl?.value?.trim() || '';
    const digitCount = (telRaw.replace(/\D/g, '') || '').length;
    let clientPhoneOk = (!telEl || digitCount >= 8);

    const emailEl = document.getElementById('cliente-email');
    let emailOk = true;
    // Si el email está visible, lo validamos; si está oculto, se considera válido
    if (emailEl && emailEl.style.display !== 'none') {
        const emailRaw = emailEl.value.trim();
        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        emailOk = emailPattern.test(emailRaw);
    }

    // Si es reprogramación, no exigimos datos de contacto (se mantienen los originales)
    if (idCitaEnEdicion) {
        // En reprogramación los campos de contacto no se muestran o se heredan,
        // así que consideramos que nombre, teléfono y email son válidos
        // (ya que la cita original ya los tiene)
    } else {
        // Para reserva normal, se requieren todos los campos visibles
        // El nombre ya lo validamos arriba, igual teléfono y email
    }

    let enable = Boolean(selF && selH && acepto && nombreOk && clientPhoneOk && emailOk);

    // En reprogramación, adicionalmente verificar que haya un cambio real
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


function aplicarSesionAModal(popupRef) {
    try{
        const sessionRaw = localStorage.getItem('agendaPro_session');
        const session = sessionRaw ? JSON.parse(sessionRaw) : null;

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
                emailEl.required = false;  // Quitar required cuando está oculto
            } else if(emailEl){
                const maybeLabel = emailEl.previousElementSibling;
                if(maybeLabel && maybeLabel.tagName === 'LABEL') maybeLabel.style.display = '';
                emailEl.style.display = '';
                emailEl.required = true;    // Restaurar required cuando visible
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

function confirmarReserva(e) {
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

    // --- VALIDACIONES DE CONTACTO (nombre, teléfono, email) ---
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
    // Solo validar email si el campo está visible
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
    // ----------------------------------------------------------

    const servicios = JSON.parse(localStorage.getItem('agendaPro_servicios')) || [];
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
        if(!anyLeft){ servicio.activo = false; servicios[idx] = servicio; localStorage.setItem('agendaPro_servicios', JSON.stringify(servicios)); }
        if (typeof aplicarFiltrosCombinados === 'function') aplicarFiltrosCombinados();
        return;
    }

    const horaTexto = formatTimeDisplay(modulo.hora || modulo.startTime || '00:00');

    const clienteNombre = document.getElementById('cliente-nombre')?.value?.trim() || '';
    const clienteTel = document.getElementById('cliente-tel')?.value?.trim() || '';
    const clienteEmail = document.getElementById('cliente-email')?.value?.trim() || '';
    const sessionRaw = localStorage.getItem('agendaPro_session');
    const session = sessionRaw ? JSON.parse(sessionRaw) : null;
    const userId = session?.id || null;

    // ✅ NUEVO: Crear cita con campo notificaciones
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
        // ✅ CAMPO AGREGADO: notificaciones inicializadas en false
        notificaciones: { 
            emailEnviado: false, 
            whatsappEnviado: false 
        }
    };
    cita.telefonoCliente = cita.contacto.telefono || '';

    const citas = JSON.parse(localStorage.getItem('agendaPro_citas')) || [];
    citas.push(cita);
    localStorage.setItem('agendaPro_citas', JSON.stringify(citas));

    if(typeof renderCarrito === 'function') renderCarrito();

    servicio.disponibilidad[fecha][moduloIndex].cupos = Math.max(0, cuposActuales - 1);

    let anyRemaining = false;
    Object.keys(servicio.disponibilidad || {}).forEach(f => {
        if((servicio.disponibilidad[f] || []).some(m => Number(m.cupos || 0) > 0)) anyRemaining = true;
    });
    if(!anyRemaining) servicio.activo = false;
    servicios[idx] = servicio;
    localStorage.setItem('agendaPro_servicios', JSON.stringify(servicios));
    
    if (typeof generarNotificaciones === 'function') generarNotificaciones();

    popup.style.display = 'none';

    if (typeof renderCarrito === 'function') renderCarrito();

    try{
        mostrarToast('¡Reserva exitosa! Revisa tu WhatsApp pronto', 'success');
    }catch(e){
        mostrarMensaje(`¡Reserva confirmada para el ${fecha} a las ${horaTexto}!`, 'success');
    }

    if (typeof cargarServiciosParaCliente === 'function') cargarServiciosParaCliente();
    if (typeof actualizarGridCliente === 'function') actualizarGridCliente(JSON.parse(localStorage.getItem('agendaPro_servicios')) || []);
    if (typeof aplicarFiltrosCombinados === 'function') aplicarFiltrosCombinados();

    setTimeout(() => {
        if (confirmBtnImmediate) { confirmBtnImmediate.disabled = false; confirmBtnImmediate.style.cursor = 'pointer'; }
        delete popup.dataset.reserving;
    }, 1500);
}
window.confirmarReserva = confirmarReserva;

function abrirModalCambioFecha(citaId, serviceId, citaActual) {
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

        const servicios = JSON.parse(localStorage.getItem('agendaPro_servicios')) || [];
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

function confirmarCambioFecha(citaId, serviceId, citaActual) {
    try{
        const popup = document.getElementById('popup-reserva');
        const btnConfirm = document.getElementById('btn-confirmar-reserva');

        if(btnConfirm) btnConfirm.disabled = true;

        let citas = JSON.parse(localStorage.getItem('agendaPro_citas')) || [];
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

        const servicios = JSON.parse(localStorage.getItem('agendaPro_servicios')) || [];
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

        // ✅ NUEVO: Crear cita reprogramada con notificaciones reiniciadas
        const nuevaCita = {
            ...citaExtraida,
            fecha: nuevaFecha,
            hora: nuevaHora,
            editado: true,
            fechaEdicion: new Date().toISOString(),
            // ✅ CAMPO AGREGADO: Reiniciar notificaciones al reprogramar
            notificaciones: { 
                emailEnviado: false, 
                whatsappEnviado: false 
            }
        };

        citas.push(nuevaCita);

        localStorage.setItem('agendaPro_citas', JSON.stringify(citas));
        localStorage.setItem('agendaPro_servicios', JSON.stringify(servicios));
        
        // ============================================
        // ✅ NUEVA SECCIÓN: Detectar edición admin y crear notificación
        // ============================================
        // Después de crear nuevaCita, antes de guardar
        let esEdicionAdmin = window._modoEdicionAdmin === true;
        let citaOriginalAdmin = esEdicionAdmin ? window._citaEnEdicionAdmin : null;

        if (esEdicionAdmin && citaOriginalAdmin) {
            // Guardar notificación de cambio
            const notif = creaNotificacionCambioAdmin(citaOriginalAdmin, nuevaCita);
            
            let notificacionesAdmin = JSON.parse(localStorage.getItem('agendaPro_notificacionesAdmin')) || [];
            notificacionesAdmin.push(notif);
            localStorage.setItem('agendaPro_notificacionesAdmin', JSON.stringify(notificacionesAdmin));
            
            // Limpiar banderas
            window._modoEdicionAdmin = false;
            window._citaEnEdicionAdmin = null;
            
            console.log('✅ Notificación de cambio admin creada:', notif);
        }
        // ============================================
        // FIN DE LA NUEVA SECCIÓN
        // ============================================
        
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
// CARRITO
// ============================================
function renderCarrito() {
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

        const session = getSession();
        console.log('Sesión actual:', session);

        const userId = session?.id || null;
        const citas = CitasManager.getAll();
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

            const itemClass = puedeReagendar ? 'cart-item' : 'cart-item locked';

            htmlAcumulado += `
                <div class="${itemClass}">
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

function cancelarCita(citaId) {
    try {
        const citasRaw = CitasManager.getAll();
        const idx = citasRaw.findIndex(c => c && String(c.id) === String(citaId));
        if (idx === -1) { mostrarToast('Cita no encontrada', 'error'); return; }
        const cita = citasRaw[idx];

        try {
            const servicios = JSON.parse(localStorage.getItem('agendaPro_servicios')) || [];
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
                localStorage.setItem('agendaPro_servicios', JSON.stringify(servicios));
            }
        } catch (e) { console.warn('No se pudo devolver cupo al servicio', e); }

        citasRaw.splice(idx, 1);
        CitasManager.save(citasRaw);
        
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

function cerrarSesion() {
    try {
        localStorage.removeItem('agendaPro_session');
    } catch (e) { }
    window.location.href = 'login.html';
}
window.cerrarSesion = cerrarSesion;

// ============================================
// INICIALIZACIÓN PRINCIPAL
// ============================================
document.addEventListener('DOMContentLoaded', function () {
    CitasManager.limpiar({ soloSinId: true, soloCompletadas: true, soloInvalidas: true });
    CitasManager.sanear();
    
    // ✅ NUEVO: Limpiar notificaciones admin antiguas al iniciar (más de 7 días)
    if (typeof NotificacionesAdminManager !== 'undefined') {
        NotificacionesAdminManager.eliminarViejos(7);
    }

    verificarProteccionRutas();
    popupEl = document.getElementById('popup-reserva');

    if (document.querySelector('.admin-screen')) {
        iniciarAdmin();
        if (typeof cargarServiciosExistentes === 'function') cargarServiciosExistentes();
    } else if (document.querySelector('.client-screen')) {
        iniciarCliente();
        if (typeof renderMisReservas === 'function') renderMisReservas();
        if (typeof renderCarrito === 'function') renderCarrito();
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
// FUNCIONES DE LOGIN
// ============================================
function iniciarLogin() {
    const loginModeBtn = document.getElementById('login-mode');
    const registerModeBtn = document.getElementById('register-mode');
    const loginContainer = document.getElementById('login-container');
    const registerContainer = document.getElementById('register-container');

    function showLogin(){
        if(loginContainer) loginContainer.classList.add('active');
        if(registerContainer) registerContainer.classList.remove('active');
        if(loginModeBtn) loginModeBtn.classList.add('active');
        if(registerModeBtn) registerModeBtn.classList.remove('active');
    }
    function showRegister(){
        if(loginContainer) loginContainer.classList.remove('active');
        if(registerContainer) registerContainer.classList.add('active');
        if(loginModeBtn) loginModeBtn.classList.remove('active');
        if(registerModeBtn) registerModeBtn.classList.add('active');
    }

    if (registerModeBtn) registerModeBtn.addEventListener('click', (e) => { e.preventDefault(); showRegister(); });
    if (loginModeBtn) loginModeBtn.addEventListener('click', (e) => { e.preventDefault(); showLogin(); });

    const registerForm = document.getElementById('register-form');
    if (registerForm) {
        registerForm.addEventListener('submit', function (e) {
            e.preventDefault();
            const nombre = (this.querySelector('input[placeholder="Nombre completo"]')?.value || '').trim();
            const email = (this.querySelector('input[placeholder="Email"]')?.value || '').trim().toLowerCase();
            const pass = (this.querySelector('input[placeholder="Contraseña"]')?.value || '');
            const pass2 = (this.querySelector('input[placeholder="Confirmar contraseña"]')?.value || '');

            if (!nombre || !email || !pass) { mostrarMensaje('Completa todos los campos', 'warning'); return; }
            if (pass !== pass2) { mostrarMensaje('Las contraseñas no coinciden', 'error'); return; }

            let usuarios = JSON.parse(localStorage.getItem('agendaPro_usuarios')) || [];
            if (usuarios.some(u => u.email === email)) { mostrarMensaje('El email ya está registrado', 'error'); return; }

            const newUser = { id: 'USER-' + Date.now(), nombre: nombre, email: email, password: pass, rol: 'cliente' };
            usuarios.push(newUser);
            localStorage.setItem('agendaPro_usuarios', JSON.stringify(usuarios));

            const session = { id: newUser.id, nombre: newUser.nombre, email: newUser.email, rol: 'cliente' };
            localStorage.setItem('agendaPro_session', JSON.stringify(session));
            mostrarMensaje(`Cuenta creada. Bienvenido ${nombre}`, 'success');
            setTimeout(() => { window.location.href = 'cliente.html'; }, 800);
        });
    }

    const tokenInput = document.getElementById('quick-token');
    const tokenBtn = document.getElementById('submit-token');
    if (tokenBtn) {
        tokenBtn.addEventListener('click', function (e) {
            e.preventDefault();
            const raw = (tokenInput?.value || '').trim();
            const token = raw.toUpperCase();
            const rol = token.includes('ADMIN') ? 'admin' : 'cliente';
            const nombre = 'Usuario Invitado';
            const email = rol === 'admin' ? 'admin@invitado.local' : '';
            const session = { id: (rol==='admin'?'ADMIN-':'USER-')+Date.now(), nombre: nombre, email: email, rol: rol };
            try { localStorage.setItem('agendaPro_session', JSON.stringify(session)); } catch (err) { console.error('No se pudo guardar la sesión', err); }
            mostrarMensaje(`Acceso rápido como ${rol}`, 'success');
            if (rol === 'admin') window.location.href = 'admin.html'; else window.location.href = 'cliente.html';
        });
    }

    const clientRoleCard = document.getElementById('client-role');
    if(clientRoleCard){
        clientRoleCard.addEventListener('click', function(e){
            e.preventDefault();
            try{
                localStorage.removeItem('agendaPro_session');
            }catch(err){}
            const session = { id: 'GUEST-' + Date.now(), nombre: 'Invitado', email: '', rol: 'invitado' };
            try{ localStorage.setItem('agendaPro_session', JSON.stringify(session)); }catch(err){ console.error('No se pudo guardar sesión invitado', err); }
            mostrarMensaje('Acceso como Invitado', 'info');
            window.location.href = 'cliente.html';
        });
    }

    const submitAdmin = document.getElementById('submit-admin');
    if (submitAdmin) {
        submitAdmin.addEventListener('click', function (e) {
            e.preventDefault();
            const pwd = document.getElementById('admin-password')?.value || '';
            if (pwd === 'admin123') {
                const session = { id: 'ADMIN-' + Date.now(), nombre: 'Administrador', email: 'admin@local', rol: 'admin' };
                try { localStorage.setItem('agendaPro_session', JSON.stringify(session)); } catch (err) { console.error(err); }
                mostrarMensaje('Acceso administrador', 'success');
                window.location.href = 'admin.html';
            } else {
                mostrarMensaje('Contraseña incorrecta', 'error');
            }
        });
    }
}
window.iniciarLogin = iniciarLogin;

// ============================================
// EXPORTAR FUNCIONES GLOBALES ADICIONALES
// ============================================
window.eliminarServicio = eliminarServicio;
window.toggleActivoServicio = toggleActivoServicio;
window.editarServicio = editarServicio;
window.abrirModalCambioFecha = abrirModalCambioFecha;
window.confirmarCambioFecha = confirmarCambioFecha;