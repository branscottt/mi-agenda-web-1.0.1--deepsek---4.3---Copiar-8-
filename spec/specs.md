Especificación SDD: Agenda Pro - Sistema de Gestión de Citas
📋 Objetivos y Alcance Actual

Objetivo: Sistema de gestión de citas y servicios con triple interfaz (Login, Admin, Cliente) que permite:

    Gestión completa de servicios (CRUD con fechas y horarios)

    Reserva de citas por clientes

    Reprogramación de citas (con validación 24h)

    Panel administrativo con estadísticas y notificaciones

    Sistema de sesiones y roles (admin/cliente/invitado)

Alcance Funcional:

    ✅ Autenticación con roles (admin, cliente, invitado)

    ✅ CRUD de servicios con calendario y módulos de horario

    ✅ Sistema de disponibilidad por fecha/hora

    ✅ Reserva de citas con validación de cupos

    ✅ Reprogramación con regla de 24h

    ✅ Carrito de compras / Mis reservas

    ✅ Notificaciones (nuevas reservas / próximas citas)

    ✅ Estadísticas e ingresos proyectados

    ✅ Persistencia en localStorage

🧩 Módulos Detectados
Módulo	Archivo	Funciones Clave	Líneas Aprox
Core	script.js	CitasManager, formatDate, parseDate, mostrarToast	1-350
Admin - Servicios	script.js	crearServicio, editarServicio, cargarServiciosExistentes	350-950
Admin - Calendario	script.js	initCalendar, renderCalendar, toggleDateSelection	950-1150
Admin - Módulos Horario	script.js	initModules, addModule, renderModulesList	1150-1350
Cliente - Catálogo	script.js	cargarServiciosParaCliente, actualizarGridCliente, aplicarFiltrosCombinados	1350-1650
Reserva/Reprogramación	script.js	abrirModalReserva, confirmarReserva, abrirModalCambioFecha	1650-2100
Carrito/Mis Reservas	script.js	renderCarrito, renderMisReservas, cancelarCita	2100-2350
Notificaciones	script.js	generarNotificaciones, renderNotificaciones, setupNotificacionesListeners	2350-2550
Login/Sesión	script.js	iniciarLogin, getSession, verificarProteccionRutas	2550-2800
Estilos	style.css	Variables, componentes, responsive	Todo el CSS
🔑 APIs y Funciones Clave
Core System
javascript

CitasManager = {
    getAll(), save(citas), limpiar(opciones), sanear(), finalizar(citaId)
}

Servicios
javascript

guardarServicio(servicio)
cargarServiciosExistentes()
eliminarServicio(id)
editarServicio(id)
toggleActivoServicio(id)

Disponibilidad
javascript

buildDisponibilidadFromForm()
addModule()
renderModulesList()
toggleDateSelection(dateStr)

Reservas
javascript

abrirModalReserva(serviceId)
confirmarReserva(e)
abrirModalCambioFecha(citaId, serviceId, citaActual)
confirmarCambioFecha(citaId, serviceId, citaActual)
cancelarCita(citaId)

Notificaciones
javascript

generarNotificaciones()
renderNotificaciones(lista)
setupNotificacionesListeners()

🚀 Feature a Implementar: Edición de Citas por Admin + Notificación Automática

Requerimiento: Cuando el administrador modifique la fecha/hora de una cita existente (desde el panel admin), el sistema debe:

    Registrar el cambio (manteniendo historial)

    Generar automáticamente un aviso en el panel de notificaciones

    Permitir al admin contactar al cliente con un clic (WhatsApp/Email)

    Mantener los datos de contacto originales del cliente

Flujo propuesto:

    Admin hace clic en "Editar cita" desde la tabla de citas programadas

    Se abre modal con selector de fecha/hora (similar a reprogramación)

    Al confirmar, se actualiza la cita y se genera notificación

    La notificación aparece en el panel con los datos del cliente y botones de contacto

📝 Descomposición en Tareas (5-8 tareas <400 líneas)
Tarea 1: Botón "Editar" en tabla de citas admin

ID: TASK-ADMIN-EDIT-01
Estimación: 150 líneas
Archivo destino: script.js (sección _renderCitasBase ~ línea 1750)

Descripción: Agregar botón de edición en la tabla de citas del admin que permita modificar fecha/hora de una cita existente.

Funciones nuevas:
javascript

function abrirModalEdicionCitaAdmin(citaId) {
    // Obtener cita y servicio
    // Verificar disponibilidad
    // Abrir modal con selector de fecha/hora
}

Modificaciones existentes:
En _renderCitasBase, agregar botón cuando mostrarEditado sea true:
javascript

if (mostrarEditado) {
    html += `<button class="btn-small btn-edit" data-id="${c.id}" title="Editar cita"><i class="fas fa-pen"></i></button> `;
}

Código a inyectar (línea ~1780):
javascript

// Dentro de _renderCitasBase, después de los botones existentes
if (mostrarEditado) {
    html += `<button class="btn-small btn-edit-admin" data-id="${c.id}" title="Editar cita"><i class="fas fa-pen"></i></button> `;
}

// Al final de la función, agregar event listeners
container.querySelectorAll('.btn-edit-admin').forEach(btn => {
    btn.addEventListener('click', function() {
        const id = this.dataset.id;
        abrirModalEdicionCitaAdmin(id);
    });
});

Función completa:
javascript

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

    // Reutilizar modal existente pero con flag especial
    window._modoEdicionAdmin = true;
    window._citaEnEdicionAdmin = cita;
    
    // Abrir modal de reprogramación pero con datos de la cita
    abrirModalCambioFecha(citaId, cita.servicioId, cita);
}
window.abrirModalEdicionCitaAdmin = abrirModalEdicionCitaAdmin;

Tarea 2: Detectar edición admin y preparar notificación

ID: TASK-ADMIN-EDIT-02
Estimación: 200 líneas
Archivo destino: script.js (sección confirmarCambioFecha ~ línea 2000)

Descripción: Modificar confirmarCambioFecha para detectar si la edición viene del admin y preparar los datos para la notificación.

Funciones nuevas:
javascript

function crearNotificacionCambioAdmin(citaOriginal, citaNueva) {
    return {
        id: 'notif-' + Date.now(),
        tipo: 'cambio-admin',
        citaId: citaNueva.id,
        fechaOriginal: citaOriginal.fecha,
        horaOriginal: citaOriginal.hora,
        fechaNueva: citaNueva.fecha,
        horaNueva: citaNueva.hora,
        cliente: citaOriginal.contacto || { nombre: citaOriginal.nombreCliente },
        leido: false,
        creadoEn: new Date().toISOString()
    };
}

Modificaciones en confirmarCambioFecha (línea ~2050):
javascript

// Después de crear nuevaCita, antes de guardar
let esEdicionAdmin = window._modoEdicionAdmin === true;
let citaOriginal = esEdicionAdmin ? window._citaEnEdicionAdmin : null;

if (esEdicionAdmin && citaOriginal) {
    // Guardar notificación de cambio
    const notif = crearNotificacionCambioAdmin(citaOriginal, nuevaCita);
    let notificacionesAdmin = JSON.parse(localStorage.getItem('agendaPro_notificacionesAdmin')) || [];
    notificacionesAdmin.push(notif);
    localStorage.setItem('agendaPro_notificacionesAdmin', JSON.stringify(notificacionesAdmin));
    
    // Limpiar flags
    window._modoEdicionAdmin = false;
    window._citaEnEdicionAdmin = null;
}

Tarea 3: Almacén de notificaciones de cambios admin

ID: TASK-ADMIN-EDIT-03
Estimación: 150 líneas
Archivo destino: script.js (nueva sección, ~ línea 2550)

Descripción: Crear sistema de almacenamiento específico para notificaciones de cambios realizados por admin.

Funciones nuevas:
javascript

const NotificacionesAdminManager = {
    getAll() {
        try {
            return JSON.parse(localStorage.getItem('agendaPro_notificacionesAdmin')) || [];
        } catch {
            return [];
        }
    },
    
    save(notificaciones) {
        localStorage.setItem('agendaPro_notificacionesAdmin', JSON.stringify(notificaciones));
    },
    
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
window.NotificacionesAdminManager = NotificacionesAdminManager;

Tarea 4: Renderizar notificaciones de cambios en panel admin

ID: TASK-ADMIN-EDIT-04
Estimación: 250 líneas
Archivo destino: script.js (sección notificaciones ~ línea 2400)

Descripción: Extender renderNotificaciones para mostrar también los cambios realizados por admin, con estilo diferenciado.

Modificaciones en renderNotificaciones (línea ~2400):
javascript

function renderNotificaciones(lista) {
    const container = document.getElementById('notifications-list');
    if (!container) return;

    // Obtener también notificaciones de cambios admin
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
            // Renderizado para cambios admin
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

Tarea 5: Extender listeners para notificaciones admin

ID: TASK-ADMIN-EDIT-05
Estimación: 150 líneas
Archivo destino: script.js (sección setupNotificacionesListeners ~ línea 2450)

Descripción: Modificar los listeners para manejar también las notificaciones de cambios admin y marcarlas como leídas.

Modificaciones en setupNotificacionesListeners (línea ~2450):
javascript

function setupNotificacionesListeners() {
    const container = document.getElementById('notifications-list');
    if (!container) return;
    
    container.addEventListener('click', function(e) {
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
            // Lógica existente para reservas
            let citas = CitasManager.getAll();
            const citaIndex = citas.findIndex(c => String(c.id) === String(citaId));
            if (citaIndex === -1) return;
            
            const cita = citas[citaIndex];
            
            if (!cita.notificaciones) {
                cita.notificaciones = { emailEnviado: false, whatsappEnviado: false };
            }
            
            const esNueva = notificacion.classList.contains('new-reservation');
            const esProxima = notificacion.classList.contains('upcoming');
            
            if (tipo === 'email' && esNueva) {
                cita.notificaciones.emailEnviado = true;
            } else if (tipo === 'whatsapp' && esProxima) {
                cita.notificaciones.whatsappEnviado = true;
            }
            
            citas[citaIndex] = cita;
            CitasManager.save(citas);
            
        } else if (origen === 'cambio' && notifId) {
            // Marcar como leída la notificación de cambio
            NotificacionesAdminManager.marcarComoLeido(notifId);
        }
        
        // Abrir el enlace real
        const href = btn.getAttribute('href');
        if (href) {
            window.open(href, '_blank');
        }
        
        // Regenerar notificaciones
        if (typeof generarNotificaciones === 'function') {
            generarNotificaciones();
        }
    });
}

Tarea 6: Actualizar generación de notificaciones

ID: TASK-ADMIN-EDIT-06
Estimación: 100 líneas
Archivo destino: script.js (sección generarNotificaciones ~ línea 2500)

Descripción: Modificar generarNotificaciones para incluir las notificaciones admin en el renderizado.

Modificaciones en generarNotificaciones (línea ~2500):
javascript

function generarNotificaciones() {
    const citas = CitasManager.getAll();
    const ahora = new Date();
    const limiteNuevas = 24 * 60 * 60 * 1000;

    // Notificaciones existentes de reservas
    const nuevas = citas.filter(c => {
        const emailNoEnviado = !c.notificaciones || c.notificaciones.emailEnviado === false;
        if (!emailNoEnviado) return false;
        
        const creado = new Date(c.creadoEn || c.fechaCreacion || 0);
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

    // Notificaciones de cambios admin (no leídas)
    const notifsAdmin = NotificacionesAdminManager.getAll();
    const noLeidas = notifsAdmin.filter(n => !n.leido);

    // Combinar en un array con tipo
    const notificaciones = [
        ...nuevas.map(c => ({ ...c, tipo: 'nueva' })),
        ...proximas.map(c => ({ ...c, tipo: 'proxima' }))
    ];

    renderNotificaciones(notificaciones);
}

Tarea 7: Estilos CSS para notificaciones admin

ID: TASK-ADMIN-EDIT-07
Estimación: 150 líneas
Archivo destino: style.css (sección notificaciones)

Descripción: Agregar estilos específicos para las notificaciones de cambios admin.

Código a inyectar (al final de la sección de notificaciones):
css

/* ===== NOTIFICACIONES DE CAMBIOS ADMIN ===== */
.content-panel .notification-item.admin-change {
    border-left-color: #ff9800;
    background: rgba(255, 152, 0, 0.08);
    animation: glow-orange 2s infinite ease-in-out;
}

.content-panel .notification-item.admin-change .notification-info strong i {
    color: #ff9800;
    margin-right: 6px;
}

.content-panel .notification-item.admin-change .notification-info small {
    color: #ffb74d;
    margin-top: 4px;
}

@keyframes glow-orange {
    0% {
        box-shadow: 0 0 5px #ff9800, 0 0 10px rgba(255, 152, 0, 0.3);
    }
    50% {
        box-shadow: 0 0 15px #ff9800, 0 0 25px rgba(255, 152, 0, 0.5);
    }
    100% {
        box-shadow: 0 0 5px #ff9800, 0 0 10px rgba(255, 152, 0, 0.3);
    }
}

/* Para diferenciar los botones en notificaciones admin */
.content-panel .notification-item.admin-change .btn-notify.email i {
    color: #ff9800;
}

.content-panel .notification-item.admin-change .btn-notify.whatsapp i {
    color: #25d366;
}

/* Badge de "cambio admin" */
.admin-change-badge {
    display: inline-block;
    padding: 2px 8px;
    background: rgba(255, 152, 0, 0.2);
    border: 1px solid rgba(255, 152, 0, 0.4);
    border-radius: 12px;
    color: #ff9800;
    font-size: 0.7rem;
    font-weight: 600;
    margin-left: 8px;
}

Tarea 8: Limpieza automática de notificaciones admin

ID: TASK-ADMIN-EDIT-08
Estimación: 100 líneas
Archivo destino: script.js (sección inicialización ~ línea 2800)

Descripción: Agregar limpieza automática de notificaciones admin viejas al iniciar.

Código a inyectar en DOMContentLoaded (línea ~2800):
javascript

// Dentro del evento DOMContentLoaded, después de CitasManager.limpiar()
NotificacionesAdminManager.eliminarViejos(7); // Eliminar notificaciones de más de 7 días

// También agregar función manual por si se necesita
window.limpiarNotificacionesAdminViejas = function(dias = 7) {
    if (NotificacionesAdminManager.eliminarViejos(dias)) {
        mostrarToast(`Notificaciones de más de ${dias} días eliminadas`, 'info');
        if (typeof generarNotificaciones === 'function') generarNotificaciones();
    }
};

📊 Resumen de Tareas
ID	Tarea	Líneas	Archivo	Dependencias
1	Botón "Editar" en tabla admin	150	script.js (~1780)	Ninguna
2	Detectar edición admin	200	script.js (~2050)	TASK-1
3	Almacén de notificaciones admin	150	script.js (~2550)	TASK-2
4	Renderizar notificaciones admin	250	script.js (~2400)	TASK-3
5	Extender listeners	150	script.js (~2450)	TASK-4
6	Actualizar generador	100	script.js (~2500)	TASK-4
7	Estilos CSS	150	style.css	TASK-4
8	Limpieza automática	100	script.js (~2800)	TASK-3

Total estimado: ~1250 líneas de código nuevo
✅ Validación de Integración

Para verificar la correcta implementación:

    Admin edita cita → Se crea notificación en localStorage

    Panel de notificaciones → Muestra el cambio con estilo naranja

    Click en botón contacto → Abre WhatsApp/Email con mensaje predefinido

    Notificación desaparece → Al hacer click, se marca como leída

    Limpieza automática → Notificaciones >7 días se eliminan al recargar

🔧 Notas Técnicas

    Compatibilidad: Todo vanilla JS, sin dependencias externas

    Persistencia: localStorage con clave agendaPro_notificacionesAdmin

    Mensajes: Los textos de WhatsApp/Email están predefinidos pero pueden personalizarse

    Flags globales: Se usan window._modoEdicionAdmin y window._citaEnEdicionAdmin (se limpian después de usar)

    Animaciones: Efecto glow naranja para notificaciones admin (diferenciado del morado de reservas)

📁 Estructura de Archivos Modificados
text

script.js
├── _renderCitasBase (TASK-1)
├── confirmarCambioFecha (TASK-2)
├── Nueva sección: NotificacionesAdminManager (TASK-3)
├── renderNotificaciones (TASK-4)
├── setupNotificacionesListeners (TASK-5)
├── generarNotificaciones (TASK-6)
└── DOMContentLoaded (TASK-8)

style.css
└── Sección notificaciones (TASK-7)