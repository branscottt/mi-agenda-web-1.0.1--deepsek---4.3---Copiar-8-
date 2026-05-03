# PLAN DE REFACTORIZACIÓN: Agenda Pro → Screaming Architecture

> Version: 1.0
> Fecha: 2026-05-01
> Arquitecto: Senior Software Architect (DDD, Strangler Fig)

---

## 0. Resumen Ejecutivo

**Sistema**: Agenda Pro - Gestión de Citas SaaS multi-tenant
**Objetivo**: Migrar de monolito (script.js, 7733 LOC) + módulos src/ parciales a Screaming Architecture pura
**Estrategia**: Strangler Fig Pattern (NO Big Bang)
**Riesgo**: Bajo-Medio (coexistencia ya implementada en login y services)
**Duración estimada**: 8 fases incrementales, cada fase 100-400 líneas

---

## 1. Estado Actual (Análisis de la Base de Código)

### 1.1 Mapa completo del monolito script.js

```
script.js (308KB, 7733 líneas, 138 funciones + 7 Managers)
├── Configuración (L1-16): supabaseUrl, supabaseKey, initSupabase()
├── Helpers/Dominio (L242-310): limpiarHora, formatDate, parseDate, escapeHtml, formatearDinero
├── Managers de Dominio (L312-1160):
│   ├── CitasManager           (L312) → CRUD citas contra Supabase
│   ├── VentasManager          (L478) → Estadísticas derivadas de citas
│   ├── UrgenciaManager        (L599) → Cálculo de urgencia de citas
│   ├── ServiciosManager       (L713) → CRUD servicios contra Supabase
│   ├── NotificacionesAdminManager (L839) → Notificaciones de cambios admin
│   ├── SuscripcionManager     (L913) → Gestión de suscripciones/planes
│   └── VisualConfigManager    (L1045) → Personalización visual
├── Planes/Suscripciones (L1337-1557): crearSuscripcionInicial, solicitarCambioPlan...
├── Dashboard Financiero (L1598-1820): actualizarDashboardFinanzas, gráficos, export CSV
├── Notificaciones UI (L1974-2240): render, generar, contadores
├── Router/Auth  (L2243-2351): getSession, verificarProteccionRutas
├── Toast/UI     (L2351-2390): mostrarToast
├── Admin Panel  (L2490-4182): iniciarAdmin, CRUD servicios, calendario, módulos horario
├── Dashboard Admin (L4182-4590): iniciarReloj, initCalendar, initModules
├── Cliente Panel (L4891-5410): iniciarCliente, cargarServicios, carrito, popup reserva
├── Super Admin  (L6673-7710): iniciarSuperAdmin, stats globales, MRR, gestión tenants
├── Eventos/Limpieza (L4590-4690): configurarLimpiezaAutomatica
└── DOMContentLoaded x2 (L2974, L6699)
```

### 1.2 Módulos src/ modernos (parciales)

```
src/ (12 dominios, 29 archivos, ~2928 LOC)
├── main.js           → Entry point, detecta página vía CSS class
├── shared/           → 6 archivos (completos, maduros)
├── auth/             → 3 archivos (completos, en uso)
├── services/         → 2 archivos (ServiceForm.js en producción, ServiceService.js completo)
├── appointments/     → 4 archivos (definidos pero NO conectados a HTML)
├── dashboard/        → 2 archivos (definidos pero NO conectados)
├── catalog/          → 3 archivos (definidos pero NO conectados)
├── notifications/    → 2 archivos (definidos pero NO conectados)
├── subscriptions/    → 1 archivo (definido pero NO conectado)
├── super-admin/      → 2 archivos (definidos pero NO conectados)
├── tenants/          → 1 archivo (definido pero NO conectado)
└── visual-config/    → 2 archivos (definidos pero NO conectados)
```

### 1.3 Dependencias entre capas

```
HTML (5 archivos)
├── <script src="script.js">        → SIEMPRE cargado (legacy global)
├── <script type="module" src="src/main.js">  → SIEMPRE cargado (moderno)
└── onclick="cerrarSesion()" etc    → Funciones globales de script.js

main.js (entry point moderno)
├── Detecta página por CSS class (.login-screen, .admin-screen, etc.)
├── Carga LoginPage.js → AUTH (en producción ✓)
├── Carga ServiceForm.js → SERVICES (en producción ✓)
└── Cliente, SuperAdmin → aún NO cargan módulos modernos

script.js (monolito)
├── Define 7 Managers globales (CitasManager, VentasManager, etc.)
├── Define 138 funciones sueltas
├── Exports NOTHING (todo global)
└── Depende de: supabaseClient global
```

---

## 2. Nueva Estructura (Screaming Architecture)

### 2.1 Layout final deseado

```
src/
├── auth/                    # "¡Aquí se maneja QUIÉN ACCEDE al sistema!"
│   ├── domain/
│   │   └── roles.js         # ROL enum, esRolValido(), puedeAcceder()
│   ├── application/
│   │   └── AuthService.js   # login(), register(), loginWithGoogle(), logout(), resetPassword()
│   └── ui/
│       └── LoginPage.js     # Controlador del login.html

├── catalog/                 # "¡Aquí el CLIENTE EXPLORA servicios!"
│   ├── application/
│   │   └── CatalogService.js
│   └── ui/
│       ├── CatalogPage.js   # Grid de servicios para cliente
│       └── CartSidebar.js   # Carrito de compras

├── services/                # "¡Aquí el ADMIN DEFINE los servicios!"
│   ├── application/
│   │   └── ServiceService.js
│   └── ui/
│       └── ServiceForm.js   # Formulario + calendario + horarios

├── appointments/            # "¡Aquí se GESTIONAN las CITAS!"
│   ├── application/
│   │   ├── AppointmentService.js  # CRUD citas
│   │   └── SalesService.js       # Estadísticas de ventas
│   └── ui/
│       ├── AdminAppointmentList.js  # Admin: tabla de citas
│       └── ClientReservationList.js # Cliente: mis reservas

├── dashboard/               # "¡Aquí el ADMIN ve MÉTRICAS del negocio!"
│   ├── application/
│   │   └── DashboardService.js
│   └── ui/
│       └── DashboardView.js # Gráficos + stats + KPIs

├── notifications/           # "¡Aquí se ALERTA al admin!"
│   ├── application/
│   │   └── NotificationService.js
│   └── ui/
│       └── NotificationPanel.js  # Panel con tabs + badge

├── subscriptions/           # "¡Aquí se COBRA y GESTIONAN planes!"
│   └── application/
│       └── SubscriptionService.js

├── super-admin/             # "¡Aquí el SÚPER ADMIN gobierna TODO!"
│   ├── application/
│   │   └── SuperAdminService.js
│   └── ui/
│       └── SuperAdminView.js

├── tenants/                 # "¡Aquí se CREAN y ADMINISTRAN negocios!"
│   └── application/
│       └── TenantService.js

├── visual-config/           # "¡Aquí el ADMIN PERSONALIZA su marca!"
│   ├── application/
│   │   └── VisualConfigService.js
│   └── ui/
│       └── ConfigEditor.js

└── shared/                  # "CIMIENTOS del sistema"
    ├── domain/
    │   └── constants.js     # PLANES, COLORS
    └── infrastructure/
        ├── supabase.js      # Cliente Supabase singleton
        ├── router.js        # getSession(), redirectByRole(), verificarProteccionRutas()
        ├── toast.js         # mostrarToast()
        ├── formatters.js    # formatDate(), formatearDinero(), etc.
        └── urgency-calculator.js  # calcularEstadoUrgencia()
```

**Lo que NO cambia**: la estructura actual de `src/` ya es screaming architecture. El problema es que la mayoría de los módulos modernos NO están conectados a los HTMLs — la lógica real sigue en script.js.

---

## 3. Estrategia de Migración (Strangler Fig)

### 3.1 Principios

1. **NO Big Bang**: cada fase migra UN dominio de negocio
2. **Coexistencia**: script.js y src/ conviven; quitamos script.js al final
3. **Contratos estables**: las funciones globales que HTML usa (onclick="cerrarSesion()") se mantienen como wrappers hasta la fase final
4. **Cada fase = feature completa**: no dejamos funcionalidad rota
5. **Prioridad por riesgo**: primero lo más estable (shared, auth), luego core del negocio

### 3.2 Fases de migración

```
FASE 0 (COMPLETADA ✓): shared/infrastructure + shared/domain
  → router.js, toast.js, formatters.js, supabase.js, constants.js ya existen
  → urgency-calculator.js existe (duplicado de UrgenciaManager en script.js)
  → No hay nada que migrar; shared es puramente infraestructura

FASE 1 (COMPLETADA ✓): auth/
  → LoginPage.js en producción (main.js lo carga)
  → AuthService.js, roles.js funcionando
  → script.js tiene iniciarLogin() legacy pero src/auth/ui/LoginPage.js es el activo
  
FASE 2 (COMPLETADA ✓): services/
  → ServiceForm.js en producción (main.js lo carga para admin.html)
  → ServiceService.js completo
  → script.js tiene ServiciosManager (L713) y funciones CRUD (L3584) como backup

FASE 3 (PENDIENTE): appointments/ + dashboard/
  → Migrar CitasManager (L312) + VentasManager (L478) a AppointmentService + SalesService
  → Migrar dashboard financiero (L1598-1820) a DashboardService + DashboardView
  → Conectar AdminAppointmentList.js al admin.html
  → Script.js funciones a migrar: 15 funciones (~800 LOC)

FASE 4 (PENDIENTE): catalog/ + client-reservation/
  → Migrar iniciarCliente() + cargarServiciosParaCliente() + popup reserva
  → Conectar CatalogPage.js, CartSidebar.js, ClientReservationList.js a cliente.html
  → Script.js: ~15 funciones (~600 LOC)

FASE 5 (PENDIENTE): notifications/
  → Migrar NotificacionesAdminManager (L839) + render/generar notificaciones
  → Conectar NotificationPanel.js, NotificationService.js a admin.html
  → Script.js: ~8 funciones (~400 LOC)

FASE 6 (PENDIENTE): subscriptions/
  → Migrar SuscripcionManager (L913) + cargarPlanes() + crearSuscripcionInicial()
  → Conectar SubscriptionService.js
  → Script.js: ~5 funciones (~250 LOC)

FASE 7 (PENDIENTE): super-admin/ + tenants/
  → Migrar iniciarSuperAdmin() + cargarTenants() + cargarUsuarios() + todo el panel superadmin
  → Conectar SuperAdminView.js, SuperAdminService.js, TenantService.js
  → Script.js: ~20 funciones (~800 LOC)

FASE 8 (PENDIENTE): visual-config/
  → Migrar VisualConfigManager (L1045)
  → Conectar VisualConfigService.js, ConfigEditor.js
  → Script.js: ~5 funciones (~200 LOC)

FASE 9 (FINAL): Limpieza de script.js
  → script.js se reduce a ORQUESTADOR que carga módulos
  → Toda la lógica de negocio vive en src/
  → Se puede eliminar script.js y cargar src/ directamente
```

---

## 4. Mapeo Detallado: script.js → src/ (Fase por Fase)

### 4.1 FASE 3: Appointments + Dashboard (SIGUIENTE)

```
Código Legacy (script.js)           → Módulo Moderno (src/)
───────────────────────────────────   ───────────────────────────
CitasManager (L312-475)              → appointments/application/AppointmentService.js
CitasManager.getAll()                → AppointmentService.getCitasByTenant()
CitasManager.upsert()                → AppointmentService.createCita()
CitasManager.getAll() (cliente)      → AppointmentService.getCitasByClient()
VentasManager (L478-595)             → appointments/application/SalesService.js
VentasManager.getHoy/getSemana/etc   → SalesService.getSalesStats()
VentasManager.getTopServicios()      → SalesService.getTopServices()
VentasManager.calcularTotal()        → (inline en SalesService)
UrgenciaManager (L599-708)           → compartido: urgency-calculator.js YA existe
UrgenciaManager.filtrarServicios()   → ServiceService.filtrarServiciosConFuturo() YA existe
actualizarDashboardFinanzas (L1598)  → dashboard/application/DashboardService.js
actualizarEstadisticasTriples (L1616)→ dashboard/ui/DashboardView.js
renderizarGraficoVentas (L1703)     → dashboard/ui/DashboardView.js (Chart.js)
exportarVentasCSV (L1780)           → dashboard/application/DashboardService.exportCSV()
cargarProximasCitas (L4060)         → appointments/ui/AdminAppointmentList.js
limpiarBaseDatos (L4123)            → appointments/application/AppointmentService.deleteCita()
```

### 4.2 FASE 4: Catalog + Cliente

```
Código Legacy (script.js)           → Módulo Moderno (src/)
───────────────────────────────────   ───────────────────────────
iniciarCliente() (L4891)             → catalog/ui/CatalogPage.js
cargarServiciosParaCliente() (L4962) → catalog/application/CatalogService.js
configurarBuscadorCliente() (L4976) → catalog/ui/CatalogPage.js
renderizarGridServicios()            → catalog/ui/CatalogPage.js
abrirPopupReserva()                  → catalog/ui/CatalogPage.js
confirmarReserva()                   → appointments/application/AppointmentService.createCita()
cancelarCita()                       → appointments/application/AppointmentService.deleteCita()
renderCarrito()                      → catalog/ui/CartSidebar.js
configurarFiltroFecha() (L5160)     → catalog/ui/CatalogPage.js
configurarBotonesExportacion()       → catalog/ui/CatalogPage.js
```

### 4.3 FASE 5: Notifications

```
Código Legacy (script.js)           → Módulo Moderno (src/)
───────────────────────────────────   ───────────────────────────
NotificacionesAdminManager (L839)    → notifications/application/NotificationService.js
NotificacionesAdminManager.getAll()  → NotificationService.getNotificaciones()
NotificacionesAdminManager.marcarComoLeido() → NotificationService.marcarLeido()
NotificacionesAdminManager.eliminarViejos() → NotificationService (inline)
renderNotificaciones() (L1974)       → notifications/ui/NotificationPanel.js
generarNotificaciones() (L2123)      → notifications/application/NotificationService.js
setupNotificacionesListeners() (L2064)→ notifications/ui/NotificationPanel.js
actualizarContadorNotificaciones()   → notifications/ui/NotificationPanel.js
renderNotificacionesCambiosAdmin()   → notifications/ui/NotificationPanel.js
crearNotificacionCambioAdmin()       → notifications/application/NotificationService.js
```

### 4.4 FASE 6: Subscriptions

```
Código Legacy (script.js)           → Módulo Moderno (src/)
───────────────────────────────────   ───────────────────────────
SuscripcionManager (L913)            → subscriptions/application/SubscriptionService.js
SuscripcionManager.getCurrent()      → SubscriptionService.getSubscription()
cargarSuscripcionTenant() (L102)    → SubscriptionService.getSubscription()
cargarPlanes() (L1364)              → shared/domain/constants.js (PLANES ya está)
crearSuscripcionInicial() (L1424)   → SubscriptionService.createCheckoutSession()
solicitarCambioPlan() (L1455)       → SubscriptionService.updateSubscription()
crearNotificacionCambioPlan() (L1515)→ NotificationService (notification)
```

### 4.5 FASE 7: Super Admin + Tenants

```
Código Legacy (script.js)           → Módulo Moderno (src/)
───────────────────────────────────   ───────────────────────────
iniciarSuperAdmin() (L2784)          → super-admin/ui/SuperAdminView.js
cargarTenants() (L2820)             → super-admin/application/SuperAdminService.getAllTenants()
cargarUsuarios() (L3039)            → super-admin/application/SuperAdminService.getAllUsers()
cargarEstadisticasGlobales() (L7159)→ super-admin/application/SuperAdminService.getGlobalStats()
cargarMetricasGlobales() (L7200)    → super-admin/application/SuperAdminService.getMRR()
editarTenant() (L3146)              → tenants/application/TenantService.updateTenant()
eliminarTenant() (L3165)            → super-admin/application/SuperAdminService? (o admin)
abrirModalGestionSuscripcion()      → super-admin/ui/SuperAdminView.js
renderTenants() (L2983)             → super-admin/ui/SuperAdminView.js
renderUsuarios() (L3050)            → super-admin/ui/SuperAdminView.js
```

### 4.6 FASE 8: Visual Config

```
Código Legacy (script.js)           → Módulo Moderno (src/)
───────────────────────────────────   ───────────────────────────
VisualConfigManager (L1045)          → visual-config/application/VisualConfigService.js
VisualConfigManager.loadConfig()     → VisualConfigService.getConfig()
VisualConfigManager.saveConfig()     → VisualConfigService.saveConfig()
VisualConfigManager.getDefaultConfig()→ VisualConfigService (default values)
```

---

## 5. Contratos de API entre Módulos (Interfaces)

### 5.1 Contratos que deben mantenerse estables

```
// Los módulos modernos EXPORTAN estas funciones
// Los HTMLs llaman a través de event listeners, NO funciones globales

src/auth/application/AuthService.js
  → login(email, password) → {success, session/error}
  → register(email, password, metadata) → {success, user/error}
  → loginWithGoogle() → redirect al provider
  → logout() → redirect a login.html
  → resetPassword(email) → {success/error}

src/catalog/application/CatalogService.js
  → getServiciosByTenant(tenantId) → [servicio]
  → filtrarDisponibles(servicios) → [servicios con fechas futuras y cupos]
  → getDisponibilidadFecha(servicioId, fecha) → [{hora, cupos}]

src/appointments/application/AppointmentService.js
  → createCita(citaData) → cita
  → getCitasByTenant(tenantId) → [cita]
  → getCitasByClient(userId) → [cita]
  → deleteCita(id) → ok

src/appointments/application/SalesService.js
  → getSalesStats(tenantId, desde, hasta) → {diario, semanal, mensual}
  → getTopServices(tenantId, limite) → [{servicio, cantidad, total}]
  → getKPI(tenantId, desde, hasta) → {ticketPromedio, totalVentas, clientesUnicos, diaPico}
```

---

## 6. Cronograma y Prioridades

```
FASE  | MÓDULO           | LÍNEAS | RIESGO | DEPENDENCIAS     | PRIORIDAD
──────┼───────────────────┼────────┼────────┼──────────────────┼──────────
0     │ shared/*         │ COMPLETE │ -    │ -                │ HECHA ✓
1     │ auth/*           │ COMPLETE │ -    │ -                │ HECHA ✓
2     │ services/*       │ COMPLETE │ -    │ -                │ HECHA ✓
3     │ appointments/    │ ~800   │ ALTO  │ shared/*         │ AHORA
      │ dashboard/       │        │       │                  │
4     │ catalog/         │ ~600   │ ALTO  │ shared/*         │ PRÓXIMO
      │ client-reservation│       │       │                  │
5     │ notifications/   │ ~400   │ MEDIO │ appointments/*   │ MEDIA
6     │ subscriptions/   │ ~250   │ BAJO  │ shared/*         │ MEDIA
7     │ super-admin/     │ ~800   │ MEDIO │ tenants/*        │ BAJA
      │ tenants/         │        │       │ appointments/*   │ 
8     │ visual-config/   │ ~200   │ BAJO  │ subscriptions/*  │ BAJA
9     │ script.js cleanup│ VAR    │ ALTO  │ TODAS            │ FINAL
```

**Recomendación**: empezar con FASE 3 (appointments + dashboard) porque:
1. Es el core del negocio (mayor riesgo = mayor prioridad)
2. Los módulos src/ ya existen, solo falta conectarlos
3. Las dependencias (shared) ya están completas
4. Dashboard financiero usa Chart.js y ya hay DashboardView.js listo

---

## 7. Containers Faltantes (IDs de DOM)

Los módulos modernos buscan estos IDs pero no están en los HTMLs reales.
Son "containers" que deben existir en el DOM para que los módulos rendericen.

```
MODULO MODERNO          → IDs QUE BUSCA (Y FALTAN EN HTML REAL)
────────────────────────   ─────────────────────────────────────────
CatalogPage.js          → 'popup-reserva-overlay', 'popup-cerrar', 
                          'popup-titulo', 'popup-descripcion', 
                          'popup-precio', 'popup-fechas', 
                          'popup-horarios', 'popup-reservar-btn'

CartSidebar.js          → 'cart-sidebar', 'cart-toggle-btn', 
                          'cart-items', 'cart-checkout-btn',
                          'cart-clear-btn', 'cart-footer',
                          'cart-total-amount'

NotificationPanel.js    → 'notif-bell-btn', 'notif-badge',
                          'notif-dropdown', 'notif-list',
                          'notif-mark-all-btn'

ConfigEditor.js         → 'temas-grid', 'cfg-primary', 'cfg-secondary',
                          'cfg-bg', 'cfg-text', 'cfg-card',
                          'cfg-radius', 'cfg-anim-speed', 'cfg-font',
                          'cfg-logo', 'cfg-favicon',
                          'cfg-save-btn', 'cfg-reset-btn', 'cfg-preview-btn'
```

**NOTA**: Estos IDs existen en los HTMLs como `<div id="X" style="display:none"></div>` para coexistencia con script.js. Cuando el módulo moderno tome el control, esos containers necesitan existir con la estructura correcta para que el módulo renderice dentro.

---

## 8. Estrategia de Rollback

Cada fase debe ser atómica y reversible:

```
1. ANTES de cambiar HTMLs: copiar script.js a script.js.bak
2. AGREGAR módulo moderno: main.js carga el nuevo módulo
3. PRUEBA: verificar que funcionalidad legacy sigue funcionando
4. REDIRIGIR: quitar script.js de esa sección (si el módulo moderno cubre todo)
5. ROLLBACK si falla: restaurar script.js + descomentar la línea en main.js
```

**Regla de oro**: si un módulo moderno no cubre el 100% de la funcionalidad de esa sección → NO DESACTIVAR script.js aún → convivir con Strangler Fig.

---

> **Este plan es vivo.** Cada fase debe ejecutarse de una en una, verificando que todo funcione antes de pasar a la siguiente. El código legacy seguirá funcionando durante todo el proceso.