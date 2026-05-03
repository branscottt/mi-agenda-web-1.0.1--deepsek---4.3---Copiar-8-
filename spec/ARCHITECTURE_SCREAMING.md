# Agenda Pro - Arquitectura Gritona (Screaming Architecture)

> "Your architecture should scream the use case, not the framework."
> La estructura del proyecto debe gritar **QUÉ hace**, no **cómo** lo hace.

---

## 1 Grito del Sistema: ¿QUÉ es Agenda Pro?

```
  AGENDA PRO
  ─────────────────────────────────────────────────────
  Un sistema de GESTIÓN DE CITAS para negocios de servicios.
  
  El negocio gira en torno a 3 actores:
    • ADMIN   → Ofrece servicios, gestiona agenda, administra el negocio
    • CLIENTE → Explora servicios, reserva citas, gestiona sus reservas
    • SÚPER   → Administra multi-tenant, planes, métricas globales
  
  Y 3 procesos de negocio fundamentales:
    1. OFERTA DE SERVICIOS (catálogo + disponibilidad)
    2. RESERVA DE CITAS (agenda + carrito + validaciones)
    3. GESTIÓN DEL NEGOCIO (dashboard + notificaciones + suscripciones)
```

---

## 2 Estructura que Grita el Negocio

### 2.1 Vista de Alto Nivel

```
src/
├── auth/              # GESTIÓN DE IDENTIDAD: quien entra al sistema
├── catalog/           # CATÁLOGO DE SERVICIOS: lo que se ofrece
├── services/          # GESTIÓN DE SERVICIOS: lo que el admin configura
├── appointments/      # RESERVA DE CITAS: el core del negocio
├── dashboard/         # PANEL DE CONTROL: métricas del negocio
├── notifications/     # NOTIFICACIONES: alertas y comunicaciones
├── subscriptions/     # SUSCRIPCIONES Y PLANES: monetización
├── tenants/           # MULTI-TENANCY: negocio multi-cliente
├── super-admin/       # ADMINISTRACIÓN GLOBAL: supervisión del SaaS
├── visual-config/     # PERSONALIZACIÓN VISUAL: identidad de marca
└── shared/            # CIMIENTOS COMPARTIDOS: infraestructura común
```

**Cada carpeta es un GRITO del negocio**, no de la tecnología. No hay `controllers/`, `models/`, `utils/` — hay `catalog/`, `appointments/`, `notifications/`.

---

### 2.2 Grito por Grito

```
auth/                   → "¡Aquí se maneja QUIÉN ACCEDE al sistema!"
├── domain/             →    Reglas del negocio: roles, permisos
│   └── roles.js        →    Qué puede hacer cada quien
├── application/        →    Casos de uso: login, registro, Google
│   └── AuthService.js  →    "Un usuario inicia sesión / se registra"
└── ui/                 →    Interfaz: pantalla de login
    └── LoginPage.js    →    "Aquí el usuario escribe su email y clave"

catalog/                → "¡Aquí el CLIENTE EXPLORA y elige servicios!"
├── application/        →    Casos de uso: listar, filtrar, disponibilidad
│   └── CatalogService.js
└── ui/                 →    Interfaz: grid de servicios, carrito
    ├── CatalogPage.js  →    "El cliente ve el catálogo"
    └── CartSidebar.js  →    "El cliente arma su carrito"

services/               → "¡Aquí el ADMIN DEFINE lo que ofrece!"
├── application/        →    Casos de uso: crear, editar, eliminar
│   └── ServiceService.js
└── ui/
    └── ServiceForm.js  →    Formulario con calendario y horarios

appointments/           → "¡Aquí se GESTIONAN las CITAS!"
├── application/        →    Casos de uso: crear, listar, cancelar
│   ├── AppointmentService.js
│   └── SalesService.js →    "Ventas del mes, servicios más vendidos"
└── ui/
    ├── AdminAppointmentList.js    → "El admin ve todas las citas"
    └── ClientReservationList.js   → "El cliente ve sus reservas"

dashboard/              → "¡Aquí el ADMIN VE las MÉTRICAS de su negocio!"
├── application/        →    Casos de uso: estadísticas, tendencias
│   └── DashboardService.js
└── ui/
    └── DashboardView.js →    Gráficos: diario, semanal, mensual

notifications/          → "¡Aquí se ALERTA sobre eventos del negocio!"
├── application/        →    Casos de uso: crear, leer, marcar leído
│   └── NotificationService.js
└── ui/
    └── NotificationPanel.js  →    "El admin ve sus alertas"

subscriptions/          → "¡Aquí se COBRA y GESTIONAN los PLANES!"
└── application/
    └── SubscriptionService.js  →    "El admin elige plan, paga, cancela"

tenants/                → "¡Aquí se CREAN y ADMINISTRAN NEGOCIOS!"
└── application/
    └── TenantService.js    →    "Un nuevo negocio se registra en la plataforma"

super-admin/            → "¡Aquí el SÚPER ADMIN gobierna TODO!"
├── application/        →    Casos de uso: métricas globales, MRR
│   └── SuperAdminService.js
└── ui/
    └── SuperAdminView.js   →    "El súper admin ve todos los tenants"

visual-config/          → "¡Aquí el ADMIN PERSONALIZA su MARCA!"
├── application/        →    Casos de uso: guardar configuración
│   └── VisualConfigService.js
└── ui/
    └── ConfigEditor.js     →    "El admin elige colores, logo, CSS"
```

---

## 3 Contratos de Negocio (APIs de Dominio)

### 3.1 Autenticación
```
iniciarSesion(email, contraseña)         → {usuario, rol, tenant}
registrarse(email, contraseña, datos)    → {usuario, tenant}
iniciarConGoogle()                        → redirige a admin
cerrarSesion()                            → redirige a login
recuperarContraseña(email)                → envía enlace
```

### 3.2 Catálogo (lo que el cliente ve)
```
listarServiciosDisponibles(tenantId)     → [{servicio, fechas, horarios}]
filtrarPorCategoria(categoria)           → [servicios]
filtrarPorFecha(fecha)                   → [servicios con disponibilidad ese día]
obtenerDisponibilidad(servicioId, fecha) → [{horaInicio, horaFin, cupos}]
```

### 3.3 Servicios (lo que el admin configura)
```
crearServicio(nombre, precio, categoria, imagen, disponibilidad)  → servicio
editarServicio(id, cambios)                                       → servicio
eliminarServicio(id)                                               → ok
alternarActivo(id)                                                 → ok
```

### 3.4 Citas (el core)
```
reservarCita(servicioId, fecha, hora, datosCliente)  → cita
cancelarCita(id)                                       → ok
reagendarCita(id, nuevaFecha, nuevaHora)               → cita
listarCitasDelDia(tenantId)                            → [citas]
listarCitasDelCliente(userId)                          → [citas]
exportarCitasCSV(tenantId, desde, hasta)               → archivo CSV
```

### 3.5 Dashboard
```
obtenerEstadisticasVentas(tenantId, desde, hasta)   → {diario, semanal, mensual}
obtenerServiciosMasVendidos(tenantId)                → [{servicio, cantidad, total}]
obtenerKPIs(tenantId, desde, hasta)                  → {ticketPromedio, totalVentas, clientesUnicos, diaPico}
obtenerTendenciaVentas(tenantId)                     → [{fecha, total}]
```

### 3.6 Notificaciones
```
crearNotificacion(tenantId, tipo, mensaje, origen)  → notificación
listarNoLeidas(tenantId)                             → [notificaciones]
marcarComoLeida(id)                                  → ok
marcarTodasLeidas(tenantId)                          → ok
```

### 3.7 Suscripciones
```
obtenerSuscripcion(tenantId)                         → {plan, estado, vigencia}
cambiarPlan(tenantId, nuevoPlan)                     → suscripción
cancelarSuscripcion(tenantId)                        → ok
crearSesionPago(tenantId, plan)                      → URL de pago
```

### 3.8 Super Admin
```
obtenerEstadisticasGlobales()                        → {tenants, servicios, citas, usuarios, suscripciones}
calcularMRR()                                        → {total, desglosePorPlan}
listarTodosLosTenants()                              → [tenants]
listarTodosLosUsuarios()                             → [usuarios con rol]
obtenerEvolucionTenants()                            → [{mes, cantidad}]
```

### 3.9 Tenants (multi-tenancy)
```
crearTenant(nombre, email, plan)                     → tenant
obtenerTenant(id)                                    → tenant
actualizarTenant(id, cambios)                        → tenant
```

### 3.10 Personalización Visual
```
obtenerConfig(tenantId)    → {colorPrimario, colorSecundario, logo, css}
guardarConfig(tenantId, datos) → ok
restablecerConfig(tenantId)    → ok
aplicarTema(tenantId, temaId)  → ok
```

---

## 4 Flujos de Negocio End-to-End

### 4.1 FLUJO: Un nuevo cliente se registra y crea su negocio

```
1. Usuario entra a login.html
2. Hace clic en "Crear Cuenta" (toggle)
3. Llena formulario: nombre, email, contraseña, WhatsApp
4. Sistema: INSERT en tabla tenants
            → Se crea tenant con plan "freemium"
            → Trigger: se crea subscription activa
5. Sistema: signUp() en Supabase Auth
            → user_metadata = {rol:'admin', tenant_id, nombre, whatsapp}
6. Sistema: redirect a planes.html?tenant_id=X&new=true
7. Usuario elige plan (Freemium/Pro/Premium)
8. Sistema: redirect a admin.html
9. ¡El negocio está listo! El admin puede crear servicios.
```

### 4.2 FLUJO: Un cliente agenda una cita

```
1. Cliente entra a cliente.html
2. Ve el catálogo de servicios del negocio
3. Filtra por categoría o fecha
4. Hace clic en un servicio → popup de reserva
5. Selecciona fecha disponible → se cargan horarios disponibles
6. Selecciona hora
7. Acepta términos y condiciones
8. Confirma reserva
9. Sistema: INSERT en tabla citas
            → Se guarda con contacto JSON {nombre, email, whatsapp, userId}
10. Sistema: CREATE notificación admin
11. Cliente ve su reserva en "Mis Reservas" (carrito)
```

### 4.3 FLUJO: Admin edita una cita (reprogramación)

```
1. Admin ve tabla de citas programadas en admin.html
2. Hace clic en "Editar" de una cita
3. Sistema abre popup con selector de fecha/hora
4. Admin selecciona nueva fecha/hora
5. Sistema: UPDATE en tabla citas
6. Sistema: INSERT en notificaciones_admin con origen='cambio'
7. Admin puede contactar al cliente (WhatsApp/Email)
8. Cliente ve la notificación de cambio (si tiene sesión)
```

### 4.4 FLUJO: Súper Admin monitorea la plataforma

```
1. Super admin inicia sesión (super@demo.com)
2. Ve stats globales: tenants, servicios, citas, usuarios, suscripciones
3. Ve MRR (Monthly Recurring Revenue): $X del plan Pro + $X del Premium
4. Ve gráfico de evolución de tenants registrados
5. Pestaña "Tenants": grid con todos los negocios, puede editar/toggle estado
6. Pestaña "Usuarios": tabla con todos los usuarios, puede cambiar roles
7. Pestaña "Servicios": todos los servicios de todos los tenants
8. Pestaña "Citas": todas las citas de la plataforma
9. Pestaña "Solicitudes CSS": solicitudes de personalización de admins
```

---

## 5 Modelo de Datos del Negocio

```
┌─────────────────────────────────────────────────────────────┐
│                        TENANTS                               │
│  (un negocio, una instancia del sistema)                     │
│  id | nombre_negocio | email | plan | estado | registro      │
└───────────────────────┬─────────────────────────────────────┘
                        │ 1
                        │
          ┌─────────────┼─────────────────┐
          │             │                  │
          ▼ 1           ▼ N                ▼ N
┌─────────────────┐ ┌──────────┐ ┌──────────────────┐
│  TENANT_CONFIG   │ │SERVICIOS │ │   NOTIFICACIONES  │
│ (personalización) │ │(lo que   │ │   ADMIN           │
│                   │ │ se vende)│ │   (alertas)       │
│ primary_color     │ │          │ │                   │
│ secondary_color   │ │ nombre   │ │ tipo              │
│ logo_url          │ │ precio   │ │ mensaje           │
│ custom_css        │ │ categoria│ │ origen            │
└───────────────────┘ │ imagen   │ │ leido             │
                      │ activo   │ └──────────────────┘
                      │ destacado│
                      │ dispon.  │
                      │ (JSONB)  │
                      └────┬─────┘
                           │ 1
                           │
                           ▼ N
                    ┌──────────────┐
                    │    CITAS      │
                    │  (el core!)   │
                    │               │
                    │ fecha         │
                    │ hora          │
                    │ precio        │
                    │ contacto      │
                    │ (JSONB)       │
                    │ estado        │
                    └──────────────┘

┌─────────────────────────────────────┐
│          SUBSCRIPTIONS               │
│  (cómo se monetiza el SaaS)         │
│                                     │
│  tenant_id → FK tenants             │
│  plan: freemium | pro | premium_anual│
│  status: active | inactive | trial   │
│  start_date | end_date               │
│  stripe_session_id                   │
└─────────────────────────────────────┘
```

---

## 6 Seguridad Multi-tenant (RLS)

El sistema aplica **aislamiento de datos por tenant** a nivel de base de datos:

```
CADA USUARIO VE SOLO LO SUYO:

  super_admin  →  TODO (todas las tablas, todos los tenants)
  admin        →  SOLO su tenant (servicios, citas, notificaciones)
  cliente      →  SOLO sus propias citas (contacto.userId = auth.uid())
  anónimo      →  SOLO servicios del tenant via app.tenant_id

IMPLEMENTADO VÍA:
  is_super_admin()      →  ¿El JWT dice rol='super_admin'?
  get_user_tenant_id()  →  ¿Qué tenant_id está en el JWT?
```

---

## 7 Vista 360°: Pantallas y sus Capacidades

```
login.html
├── Iniciar sesión (email + contraseña)
├── Registro (nombre, email, teléfono, WhatsApp)
├── Google OAuth
├── Recuperar contraseña (modal)
└── Toggle login / register

admin.html
├── Suscripción actual (plan, vigencia, cambiar/cancelar)
├── Estadísticas rápidas (servicios, ventas, citas, clientes)
├── Dashboard financiero (diario/semanal/mensual, Chart.js, KPIs)
├── Crear servicio (nombre, categoría, precio, horarios, calendario, imagen)
├── Mis servicios (cards con filtros, export CSV)
├── Citas programadas (tabla con editar/cancelar, limpiar DB)
├── Notificaciones (tabs: Todas/Reservas/Cambios, badge)
├── Personalización visual (colores, logo, CSS custom, temas)
├── Compartir enlace clientes (copiar, WhatsApp, QR)
└── Navegación (login ↔ admin ↔ cliente)

cliente.html
├── Catálogo de servicios (grid con búsqueda y filtros)
├── Filtros: categoría, fecha, export CSV
├── Carrito lateral (reservas pendientes, total)
├── Popup de reserva (selector fecha/hora, términos, confirmar)
└── Navegación (login ← admin → cliente)

superadmin.html
├── Estadísticas globales (tenants, servicios, citas, usuarios, suscripciones)
├── MRR y desglose por plan
├── Gráfico evolución tenants (Chart.js)
├── 5 tabs: Tenants | Usuarios | Servicios | Citas | Solicitudes CSS
└── Modal gestión suscripción (plan, estado, fechas, Stripe ID)

planes.html
├── 3 planes: Freemium (gratis), Pro ($5.000/mes), Premium ($36.000/año)
├── Desde registro con tenant_id=new
└── Navegación a login y admin
```

---

## 8 Decisión Arquitectónica Clave: Strangler Fig

```
ESTADO ACTUAL:
  script.js (7733 LOC) → monolito legacy que TODO lo hace
  src/ (29 módulos)    → módulos modernos por dominio

ESTRATEGIA:
  Cada HTML carga script.js Y src/main.js
  main.js detecta la página y carga el módulo moderno correspondiente
  Los módulos modernos coexisten sin romper el legacy

PLAN:
  FASE 1: Extraer auth/ (LoginPage moderno funcionando ✓)
  FASE 2: Extraer services/ (ServiceForm moderno para crear servicios ✓)
  FASE 3: Extraer catalog/ + appointments/ (catálogo cliente + reservas)
  FASE 4: Extraer dashboard/ + notifications/ (dashboard y notificaciones)
  FASE 5: Extraer super-admin/ + subscriptions/
  FASE 6: Eliminar script.js cuando todo esté migrado

CONTAINERS FALTANTES (IDs que módulos buscan pero aún no existen en HTML):
  → CatalogPage busca 8 IDs (popup-reserva-overlay, popup-cerrar, etc.)
  → CartSidebar busca 7 IDs (cart-sidebar, cart-items, etc.)
  → NotificationPanel busca 5 IDs (notif-bell-btn, notif-badge, etc.)
  → ConfigEditor busca 15 IDs (temas-grid, cfg-primary, cfg-secondary, etc.)
```

---

> **Este documento es el mapa del negocio.** Cada carpeta, cada archivo, cada contrato API debe hacer eco del dominio real: gestión de citas, no tecnología.
>
> *"When you look at the package structure of your application, you should get a sense of what the application does, not what frameworks it uses."* — Robert C. Martin