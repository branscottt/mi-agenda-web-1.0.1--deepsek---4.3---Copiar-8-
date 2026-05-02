# Plan de Refactorización: Screaming Architecture

## FASE 1: Análisis y Planificación de Dominio

### 1.1 Análisis de la Base de Código Actual

**Estado actual:** Monolito de 3 archivos (script.js 7733 LOC, style.css 5992 LOC, admin.html 857 LOC)
con toda la lógica mezclada: UI, negocio, datos, auth, routing, formateo, notificaciones, etc.

**Problemas identificados:**

1. **script.js (7733 LOC)**: Contiene 9 managers, ~60 funciones globales, lógica de UI,
   lógica de negocio, acceso a datos (Supabase calls esparcidos), formateo, auth routing,
   y event listeners todo en el mismo archivo
2. **style.css (5992 LOC)**: Sin estructura, todo en un CSS file
3. **HTMLs**: Cada HTML tiene scripts inline y estilos embedidos
4. **Dependencia directa a Supabase SDK**: Los managers llaman `supabaseClient` directamente
5. **Sin separación de concerns**: NO hay capa domain/application/infrastructure/ui
6. **Acoplamiento global**: `window.ServiciosManager = ServiciosManager` expone todo globalmente

### 1.2 Identificación de Módulos del Dominio

Basado en el análisis de tablas (6+ tablas), managers (9 managers), y funcionalidad:

```
DOMINIO PRINCIPAL: AGENDAMIENTO DE CITAS (multi-tenant)
```

**Módulos de Negocio Identificados:**

| Módulo | Entidad Central | Archivo Actual | LOC Aprox |
|--------|----------------|----------------|-----------|
| **tenants** | Tenant (negocio) | script.js:145, admin.html, superadmin.html, modal tenant | ~400 |
| **subscriptions** | Subscription | script.js SuscripcionManager (line 913), planes.html | ~200 |
| **services** | Servicio | script.js ServiciosManager (line 713), admin.html form | ~600 |
| **appointments** | Cita | script.js CitasManager (line 312), VentasManager (line 478) | ~600 |
| **catalog** | Vista cliente | script.js iniciarCliente (line 4891), cliente.html | ~500 |
| **notifications** | NotificacionAdmin | script.js NotificacionesAdminManager (line 839) | ~250 |
| **visual-config** | TenantConfig | script.js VisualConfigManager (line 1045) | ~200 |
| **auth** | Usuario/Sesion | script.js getSession, iniciarLogin, login.html | ~400 |
| **dashboard** | Dashboard/Stats | script.js actualizarDashboardFinanzas, Chart.js, admin.html | ~500 |
| **super-admin** | Panel global | script.js iniciarSuperAdmin (line 2784), superadmin.html | ~500 |

**Módulo Compartido (shared/):**
- Supabase client (supabase.js)
- Utilidades de formato (formatDate, formatearDinero, escapeHtml, formatTimeDisplay)
- UrgenciaManager (line 599) - lógica transversal
- mostrarToast (line 2351)
- getCurrentTenantId, getSession, verificarProteccionRutas
- initSupabase, supabaseClient global
- Constantes: planesData (line 1337), URLs, colores default

### 1.3 Estrategia de Migración (Strangler Fig Pattern)

**Principio:** NO rewrite. Crear nueva estructura EN PARALELO, migrar módulo por módulo.

**Orden de Migración (priorizado por riesgo + aislamiento):**

```
FASE A (Semana 1-2) - Fundación compartida:
  shared/       → 100% segura, sin dependencias de negocio
  auth/         → Crítica para todo el sistema, alto riesgo

FASE B (Semana 2-3) - Núcleo del negocio:
  services/     → CRUD puro, fácil de aislar y testear
  appointments/ → Lógica central, pero bien definida
  notifications/→ Dependiente de appointments, bajo riesgo

FASE C (Semana 3-4) - Features de tenant:
  tenants/      → Afecta multi-tenant, requiere cuidado RLS
  subscriptions/→ Depende de tenants, lógica financiera
  visual-config/→ Aislado, fácil

FASE D (Semana 4-5) - UI y presentación:
  catalog/      → Vista cliente, consume services + appointments
  dashboard/    → Chart.js + agregaciones
  super-admin/  → Consume todos los módulos

FASE E (Semana 5-6) - Limpieza:
  Eliminar script.js original
  Refactorizar style.css module por module
  HTMLs finales solo importan módulos específicos
```

---

## FASE 2: Diseño de la Nueva Estructura (Screaming Layout)

### Árbol de Directorios Propuesto

```
mi-agenda-web/
├── index.html                         # Redirección a login.html
├── login.html                         # Sin cambios (solo refactor JS imports)
├── admin.html                         # Sin cambios (solo refactor JS imports)
├── cliente.html                       # Sin cambios (solo refactor JS imports)
├── superadmin.html                    # Sin cambios (solo refactor JS imports)
├── planes.html                        # Sin cambios
├── style.css                          # Se mantiene, se refactoriza internamente
│
├── src/
│   ├── main.js                        # Entry point: importa módulos, initApp()
│   │
│   ├── shared/                        # Kernel compartido (código transversal)
│   │   ├── domain/
│   │   │   ├── constants.js           # planesData, colores default, URLs
│   │   │   └── errors.js              # DomainError, AppError classes
│   │   │
│   │   ├── application/
│   │   │   ├── supabase.js            # Cliente Supabase (antes supabase.js, initSupabase)
│   │   │   └── di-container.js        # Dependency Injection container
│   │   │
│   │   └── infrastructure/
│   │       ├── router.js              # verificarProteccionRutas, redirectByRole
│   │       ├── toast.js               # mostrarToast, notificaciones UI
│   │       ├── formatters.js          # formatearDinero, formatDate, escapeHtml, formatTimeDisplay
│   │       └── urgency-calculator.js  # UrgenciaManager (calcularEstado)
│   │
│   ├── auth/                          # MÓDULO: Autenticación
│   │   ├── domain/
│   │   │   ├── User.js                # Value Object: User (id, email, rol, tenant_id, nombre)
│   │   │   ├── Session.js             # Entity: Sesión activa
│   │   │   └── roles.js               # Enum: ROLES (SUPER_ADMIN, ADMIN, CLIENTE)
│   │   │
│   │   ├── application/
│   │   │   ├── AuthService.js         # login, register, logout, googleLogin
│   │   │   ├── SessionService.js      # getSession, refreshSession, listenAuthChanges
│   │   │   └── RegisterService.js     # registerNewAdmin con creación tenant + sub
│   │   │
│   │   ├── infrastructure/
│   │   │   ├── SupabaseAuthGateway.js # Implementación concreta de AuthGateway
│   │   │   └── AuthGateway.js         # Puerto/Interface para testabilidad
│   │   │
│   │   └── ui/
│   │       ├── LoginPage.js           # iniciarLogin, loginForm submit handler
│   │       ├── RegisterForm.js        # registerForm submit handler
│   │       └── PasswordResetModal.js  # Modal recuperar contraseña
│   │
│   ├── tenants/                       # MÓDULO: Gestión de Negocios (multi-tenant)
│   │   ├── domain/
│   │   │   ├── Tenant.js              # Entity: negocio con plan, estado
│   │   │   └── TenantRepository.js    # Interface: puerto para persistencia
│   │   │
│   │   ├── application/
│   │   │   └── TenantService.js       # crearTenant, actualizarTenant, listarTodos
│   │   │
│   │   ├── infrastructure/
│   │   │   └── SupabaseTenantRepo.js  # Implementación concreta
│   │   │
│   │   └── ui/
│   │       ├── TenantCard.js          # Tarjeta de tenant (superadmin grid)
│   │       ├── TenantModal.js         # Modal crear/editar tenant
│   │       └── ShareLink.js           # Generar enlace compartible cliente
│   │
│   ├── subscriptions/                 # MÓDULO: Planes y Suscripciones
│   │   ├── domain/
│   │   │   ├── Subscription.js        # Entity: plan, status, fechas
│   │   │   ├── Plan.js                # Value Object: planesData
│   │   │   └── SubscriptionRepository.js
│   │   │
│   │   ├── application/
│   │   │   └── SubscriptionService.js # getCurrent, create, updatePlan, cancel, renew
│   │   │
│   │   ├── infrastructure/
│   │   │   └── SupabaseSubscriptionRepo.js
│   │   │
│   │   └── ui/
│   │       ├── PlanCards.js           # Render tarjetas planes.html
│   │       ├── SubscriptionInfo.js    # Banner "Mi Suscripción" en admin
│   │       └── SuperAdminSubModal.js  # Modal gestion suscripción (superadmin)
│   │
│   ├── services/                      # MÓDULO: Servicios (Catálogo del negocio)
│   │   ├── domain/
│   │   │   ├── Service.js             # Entity: nombre, categoria, precio, disponibilidad
│   │   │   ├── ScheduleModule.js      # Value Object: módulo horario (start, end, cups)
│   │   │   └── ServiceRepository.js   # Interface
│   │   │
│   │   ├── application/
│   │   │   ├── ServiceService.js      # CRUD + toggleActivo + filtrarDisponibles
│   │   │   └── ScheduleService.js     # Gestión módulos horario + disponibilidad
│   │   │
│   │   ├── infrastructure/
│   │   │   └── SupabaseServiceRepo.js
│   │   │
│   │   └── ui/
│   │       ├── ServiceForm.js         # Formulario crear/editar servicio (admin)
│   │       ├── ServiceCard.js         # Card de servicio en admin list
│   │       ├── CalendarWidget.js      # Calendario selección fechas (admin)
│   │       └── ScheduleModulesUI.js   # Módulos horario UI (addModule, removeModule)
│   │
│   ├── appointments/                  # MÓDULO: Citas (core del negocio)
│   │   ├── domain/
│   │   │   ├── Appointment.js         # Entity: fecha, hora, precio, contacto, estado
│   │   │   ├── Contact.js             # Value Object: nombre, email, telefono, userId
│   │   │   └── AppointmentRepository.js
│   │   │
│   │   ├── application/
│   │   │   ├── AppointmentService.js  # getAll, create, update, delete, finalizar, noAsistio
│   │   │   ├── SalesService.js        # Ventas derivadas de citas (getHoy, getSemana, getMes)
│   │   │   └── RescheduleService.js   # Reprogramación con validación 24h
│   │   │
│   │   ├── infrastructure/
│   │   │   └── SupabaseAppointmentRepo.js
│   │   │
│   │   └── ui/
│   │       ├── AdminAppointmentList.js # Render citas admin (con acciones)
│   │       ├── ClientReservationList.js# Mis reservas (cliente)
│   │       ├── ReservationPopup.js     # Popup términos + confirmación reserva
│   │       └── AppointmentUrgency.js   # Clases de urgencia visual
│   │
│   ├── notifications/                 # MÓDULO: Notificaciones
│   │   ├── domain/
│   │   │   ├── AdminNotification.js   # Entity: tipo, citaId, fechas, leido
│   │   │   └── NotificationRepository.js
│   │   │
│   │   ├── application/
│   │   │   ├── NotificationService.js # getAll, markAsRead, deleteOld
│   │   │   └── ChangeNotifier.js      # crearNotificacionCambioAdmin, crearNotificacionCambioPlan
│   │   │
│   │   ├── infrastructure/
│   │   │   └── SupabaseNotificationRepo.js
│   │   │
│   │   └── ui/
│   │       ├── NotificationPanel.js   # Panel notificaciones admin (con tabs)
│   │       ├── NotificationBadge.js   # Badge contador no leídos
│   │       └── AdminChangeList.js     # Lista cambios admin
│   │
│   ├── catalog/                       # MÓDULO: Catálogo Cliente (Vista pública)
│   │   ├── application/
│   │   │   └── CatalogService.js      # cargarServicios, filtrar, buscar
│   │   │
│   │   └── ui/
│   │       ├── CatalogPage.js         # iniciarCliente, grid servicios
│   │       ├── ServiceCard.js         # Card servicio en vista cliente (con botón reservar)
│   │       ├── CartSidebar.js         # Carrito lateral con resumen
│   │       ├── SearchFilters.js       # Buscador + filtros categoría/fecha
│   │       └── ExportCSV.js           # Exportar CSV filtrado
│   │
│   ├── dashboard/                     # MÓDULO: Dashboard Financiero
│   │   ├── application/
│   │   │   └── DashboardService.js    # Calcular stats, top servicios, KPIs
│   │   │
│   │   └── ui/
│   │       ├── StatsHeader.js         # 4 stat boxes (servicios, ventas, citas, clientes)
│   │       ├── TripleStats.js         # Diario/Semanal/Mensual
│   │       ├── SalesChart.js          # Chart.js gráfico ventas
│   │       ├── TopServices.js         # Ranking servicios más vendidos
│   │       └── KPIGrid.js             # Ticket promedio, total ventas, día pico
│   │
│   ├── super-admin/                   # MÓDULO: Panel Super Admin
│   │   ├── application/
│   │   │   └── SuperAdminService.js   # cargarTenants, cargarUsuarios, metricas globales
│   │   │
│   │   └── ui/
│   │       ├── GlobalStats.js         # 5 stat boxes (tenants, servicios, citas, etc)
│   │       ├── MRRDisplay.js          # Métricas MRR + desglose plan
│   │       ├── TenantsEvolutionChart.js# Chart.js evolución tenants
│   │       ├── TenantsTab.js          # Tab + grid tenants
│   │       ├── UsersTab.js            # Tab usuarios con acciones
│   │       ├── GlobalServicesTab.js   # Tab servicios globales
│   │       ├── GlobalAppointmentsTab.js# Tab citas globales
│   │       └── CSSRequestsTab.js      # Tab solicitudes CSS profesional
│   │
│   └── visual-config/                 # MÓDULO: Configuración Visual por Tenant
│       ├── domain/
│       │   └── VisualConfig.js        # Value Object: primary, secondary, logo, css
│       │
│       ├── application/
│       │   └── VisualConfigService.js # loadConfig, saveConfig, applyStyles
│       │
│       ├── infrastructure/
│       │   └── SupabaseConfigRepo.js
│       │
│       └── ui/
│           ├── ConfigEditor.js        # Selectores color, input logo, campo CSS
│           └── StyleApplier.js        # applyStyles runtime
│
├── spec/
│   └── specs.md
│
└── metodologia                        # Plan maestro original
```

---

## FASE 3: Plan de Implementación Detallado

### 3.1 Arquitectura de Capas Dentro de Cada Módulo

Cada módulo sigue la misma arquitectura hexagonal:

```
módulo/
├── domain/       # REGLAS DE NEGOCIO PURAS
│   ├── Entity.js         # Entidad con comportamiento (no anémica)
│   ├── ValueObject.js    # Objeto de valor inmutable
│   └── Repository.js     # Puerto (interface) para persistencia
│
├── application/  # ORQUESTACIÓN (casos de uso)
│   └── Service.js        # Servicio de aplicación (inyecta repositorios)
│
├── infrastructure/ # ADAPTADORES (implementaciones concretas)
│   └── SupabaseRepo.js   # Implementación del puerto via Supabase
│
└── ui/           # PRESENTACIÓN (eventos DOM, render)
    └── Component.js      # Componente de UI puro (render + event handlers)
```

### 3.2 Reglas de Dependencia

```
UI → Application → Domain
                ↘
         Infrastructure → Domain
```

- **domain/** NO puede importar nada fuera de sí mismo o shared/domain/
- **application/** importa domain/ y shared/application/
- **infrastructure/** importa domain/ (implementa puertos) y shared/infrastructure/
- **ui/** importa application/ y shared/infrastructure/
- **NUNCA** ui importa infrastructure directamente
- **NUNCA** domain importa infrastructure

### 3.3 Patrón de Inyección de Dependencias (DI Container)

```js
// shared/application/di-container.js
const container = {
    _registry: new Map(),
    
    register(name, factory) {
        this._registry.set(name, { factory, instance: null });
    },
    
    resolve(name) {
        const entry = this._registry.get(name);
        if (!entry) throw new Error(`Service ${name} not registered`);
        if (!entry.instance) {
            entry.instance = entry.factory(this);
        }
        return entry.instance;
    }
};

// Registro de servicios:
container.register('appointmentRepo', () => new SupabaseAppointmentRepo(supabaseClient));
container.register('appointmentService', (c) => new AppointmentService(c.resolve('appointmentRepo')));
```

### 3.4 Estrategia de Migración Paso a Paso

**Paso 1: shared/** (Semana 1, Día 1-2)
- Crear `src/shared/domain/constants.js` con planesData
- Crear `src/shared/domain/errors.js`
- Crear `src/shared/infrastructure/supabase.js` con initSupabase exportado
- Crear `src/shared/infrastructure/formatters.js`
- Crear `src/shared/infrastructure/toast.js`
- Crear `src/shared/infrastructure/router.js`
- Crear `src/shared/infrastructure/urgency-calculator.js`
- Crear `src/shared/application/di-container.js`
- **NO se elimina nada de script.js aún** — solo se crean los archivos

**Paso 2: auth/** (Semana 1, Día 3-4)
- Crear auth/domain/ (User.js, Session.js, roles.js)
- Crear auth/infrastructure/AuthGateway.js (interface)
- Crear auth/infrastructure/SupabaseAuthGateway.js
- Crear auth/application/AuthService.js y SessionService.js
- Crear auth/ui/LoginPage.js
- Importar auth/ en login.html + reemplazar event listeners

**Paso 3: tenants/ + subscriptions/** (Semana 2)
- Misma estructura: domain → infrastructure → application → ui
- Conectar con admin.html

**Paso 4: services/ + appointments/** (Semana 2-3)
- Núcleo del negocio. Mayor cuidado con RLS y multi-tenant
- Migrar ServiciosManager y CitasManager

**Paso 5: catalog/ + notifications/ + visual-config/** (Semana 3)
- Vista cliente + notificaciones + config visual

**Paso 6: dashboard/ + super-admin/** (Semana 4)
- Panel admin y super admin

**Paso 7: main.js + entry points** (Semana 4-5)
- Crear `src/main.js` como entry point unificado
- Cada HTML importa main.js que detecta qué página es y carga los módulos correctos

```html
<!-- admin.html -->
<script type="module" src="src/main.js"></script>
```

```js
// src/main.js
import './shared/infrastructure/supabase.js';
import './auth/application/AuthService.js';
// ... otros imports

// Detectar página actual
if (document.querySelector('.admin-screen')) {
    import('./dashboard/ui/StatsHeader.js');
    import('./services/ui/ServiceForm.js');
    // etc.
}
```

**Paso 8: Limpieza final** (Semana 5)
- Eliminar script.js
- Refactorizar style.css en módulos CSS (por módulo)
- Verificar que nada se rompe

### 3.5 Cómo Evitar el "Big Bang"

La migración usa **Strangler Fig Pattern**:

```
Semana 0:  script.js (7733 LOC) ← TODO aquí
Semana 1:  script.js (6000 LOC) + src/shared/ + src/auth/
Semana 2:  script.js (4000 LOC) + src/services/ + src/appointments/
Semana 3:  script.js (2000 LOC) + src/tenants/ + src/subscriptions/
Semana 4:  script.js (500 LOC)  + src/catalog/ + src/dashboard/ + src/super-admin/
Semana 5:  src/main.js solo     ← script.js eliminado
```

Cada semana:
1. Se crean los nuevos archivos en `src/` con estructura DDD
2. Los HTMLs nuevos importan los módulos modernos
3. Las funciones viejas que ya están migradas DELEGAN a los nuevos módulos
4. Al final, las funciones viejas ya no tienen código — solo re-exportan
5. Se elimina el archivo viejo

### 3.6 Archivos a NO TOCAR (se mantienen igual)

- `supabase.js` — Se refactoriza como `src/shared/application/supabase.js`
- `style.css` — Se mantiene pero se extraen secciones a módulos CSS
- `Untitled-1.sql` — Script de migración, no se modifica
- `spec/specs.md` — Documentación
- `metodologia` — Plan maestro

---

## ANEXO: Mapa de Dependencias Entre Módulos

```
auth/ ────────────────► shared/ (supabase, router, toast)
        │
        ▼
tenants/ ─────────────► shared/ (supabase)
        │
        ▼
subscriptions/ ──────► tenants/, shared/
        │
        ▼
services/ ───────────► tenants/, shared/
        │
        ▼
appointments/ ───────► services/, tenants/, shared/
        │
        ├──► notifications/ ──► shared/
        ├──► catalog/ ────────► services/, appointments/, shared/
        ├──► dashboard/ ──────► appointments/, services/, shared/
        └──► visual-config/ ──► tenants/, shared/

super-admin/ ─────────► tenants/, subscriptions/, services/, appointments/, shared/
                (consume todos los módulos)
```