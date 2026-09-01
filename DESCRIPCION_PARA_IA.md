# ORGANIFY / AGENDA PRO — Descripción Integral del Producto

Documento de referencia para que otra IA entienda la plataforma completa:
qué es, cómo funciona, todas sus funcionalidades, beneficios y qué dolores
resuelve a cada tipo de PYME.

================================================================
1. QUÉ ES
================================================================

Organify (nombre comercial "Agenda Pro") es un SaaS web multi-tenant de
agendamiento de citas para PYMEs de servicios. Cada PYME (tenant) crea su
cuenta y obtiene:

  - Un panel de administración para gestionar su negocio (servicios,
    citas, clientes, equipo, horarios, finanzas, personalización).
  - Una página pública de catálogo con su propia marca (logo, colores,
    portada, redes sociales, ubicación) donde sus clientes reservan
    citas en línea sin necesidad de crear cuenta.
  - Un portal para trabajadores/empleados con su propio acceso.
  - Presencia en un Directorio Público de PYMEs con reseñas, que sirve
    como canal de captación de nuevos clientes.

Es una app 100% web, responsive (mobile-first), sin instalación, pensada
para el mercado latinoamericano (precios en CLP, integración con
Mercado Pago y WhatsApp como canales nativos). Modelo freemium con
suscripción mensual/anual plana: sin comisiones por reserva.

================================================================
2. PARA QUIÉN — LOS 27 TIPOS DE PYME (+ "Otros")
================================================================

El Directorio Público define 5 categorías con 27 tipos de pyme + "Otros":

A) SALUD Y BIENESTAR CLÍNICO (profesionales que manejan expedientes,
   notas privadas o salud de pacientes):
   1. Odontólogos
   2. Psicólogos
   3. Terapeutas
   4. Fonoaudiólogos (Terapia del lenguaje)
   5. Kinesiólogos / Fisioterapeutas
   6. Nutricionistas

B) ESTÉTICA, BELLEZA Y CUIDADO PERSONAL (salón, gabinetes, atención
   directa de imagen y relajación):
   7. Peluqueros
   8. Manicuristas
   9. Barberos
   10. Maquillistas (Make-up Artists)
   11. Esteticistas y Cosmetólogas
   12. Masajistas / Masoterapeutas

C) DEPORTE, ACTIVIDAD FÍSICA Y CLASES (entrenadores, instructores,
   gestión de horarios o cupos recurrentes):
   13. Entrenadores
   14. Dueños de Centros de Yoga o Pilates
   15. Entrenadores de Deportes Específicos (Tenis, Fútbol, Golf)
   16. Instructores de Música (Guitarra, canto, piano)
   17. Academias de Baile
   18. Tutores Particulares / Profesores de Idiomas

D) SERVICIOS PROFESIONALES Y CREATIVOS (independientes, estudios,
   agendamiento de reuniones o proyectos largos):
   19. Abogados, Consultores o Contadores
   20. Fotógrafos (Estudio o exteriores)
   21. Tatuadores (gestión de horas largas y anticipos)
   22. Diseñadores Gráficos / Web Freelancers
   23. Veterinarios (Consultas para mascotas)

E) SERVICIOS TÉCNICOS, HOGAR Y TERRENO (reservas con visitas a
   domicilio o traslados geográficos):
   24. Técnicos de Reparación de Electrodomésticos / Aire Acondicionado
   25. Plomeros / Electricistas / Gasfíters
   26. Empresas de Limpieza de Alfombras / Sofás
   27. Guías de Turismo (Tours privados o excursiones)
   + Dueños de Canchas de Fútbol / Pádel / Tenis (alquiler de espacios)
   + "Otros" (cualquier rubro adicional)

================================================================
3. CÓMO FUNCIONA (FLUJO COMPLETO)
================================================================

1) REGISTRO: El dueño crea su cuenta en login.html con email+contraseña
   (o Google OAuth), nombre de la pyme y su número de WhatsApp
   (obligatorio: es el canal de contacto con clientes). Protegido con
   captcha Cloudflare Turnstile contra bots.

2) ONBOARDING: Se crea el tenant y se activa el Free Trial (14 días sin
   límites, sin tarjeta). El panel guía paso a paso: crear servicios,
   definir horarios, invitar equipo, personalizar la página.

3) SETUP DEL NEGOCIO (panel admin):
   - Crear servicios (nombre, precio, duración, descripción, foto,
     destacado, disponibilidad por fechas).
   - Configurar horarios por trabajador (grid semanal, copiar horarios,
     módulos de atención con cupos por día de la semana o por fecha
     específica).
   - Invitar trabajadores (cada uno recibe acceso a su portal).
   - Personalizar la página pública (tema, colores, logo, portada,
     redes sociales, ubicación con mapa, CSS custom).
   - Opcional: darse de alta en el Directorio Público (categoría, tipo
     de pyme, fotos) para aparecer en el buscador de PYMEs.

4) COMPARTIR: El admin obtiene un enlace público único
   (cliente.html?tenant_id=X) que puede difundir por WhatsApp, redes o
   imprimir en QR.

5) RESERVA DEL CLIENTE (sin registrarse): El cliente abre el enlace,
   ve el catálogo con la marca de la pyme, agrega servicios a un
   carrito (puede reservar varios servicios en una sola operación),
   elige fecha/hora entre los cupos disponibles, selecciona trabajador
   si aplica, y confirma. Se genera la cita al instante.

6) OPERACIÓN DIARIA: El admin ve las citas programadas, las notifica
   (nuevas reservas por email, recordatorios de próxima cita por
   WhatsApp), cambia fechas, marca estado de pago, archiva ventas y
   exporta a CSV. El trabajador ve su día en su propio portal.

7) PAGO / SUSCRIPCIÓN: Al vencer el trial, el dueño elige plan en
   planes.html y paga con Mercado Pago (pago único o cobro automático
   mensual/anual). Sin plan activo, el panel se bloquea pero los datos
   se conservan; al reactivar, todo vuelve igual.

================================================================
4. FUNCIONALIDADES COMPLETAS (POR PORTAL)
================================================================

--- 4.1 LOGIN / LANDING (login.html) ----------------------------
  - Inicio de sesión y registro con email o Google.
  - Campo WhatsApp obligatorio en el registro.
  - Recuperación de contraseña por email.
  - Cloudflare Turnstile (anti-bot) en login y registro.
  - Directorio Público de PYMEs integrado debajo del login:
    * 5 categorías con iconos y chips de filtro.
    * Buscador por nombre, tipo de pyme, categoría o dirección.
    * Tarjetas con foto de portada, logo, badge de tipo, estrellas.
    * Modal de reseñas: ver reseñas y dejar estrellas + comentario.
    * CTA "Crear mi pyme gratis" cuando no hay resultados.
    * Cada tarjeta lleva a la página de reservas de esa pyme.

--- 4.2 PANEL ADMIN (admin.html) — 12 secciones -----------------
  1. Dashboard Financiero: métricas de ventas, citas, ingresos,
     estadísticas avanzadas del negocio.
  2. Crear Servicio: alta con precio, duración, categoría, descripción,
     imagen, destacado, activo/inactivo, disponibilidad, modo de
     asignación (todos los trabajadores o solo algunos), módulos por
     día de la semana y por fecha específica, cupos por módulo.
  3. Mis Servicios: listado, edición, duplicación, activar/desactivar,
     eliminar con doble confirmación; aviso y limpieza de servicios
     expirados.
  4. Citas Programadas: agenda por día, creación manual, cambio de
     fecha, cancelación, vista de ventas archivadas, indicador de
     estado de pago (pendiente/pagado/adelanto), limpieza de citas
     expiradas, exportar CSV.
  5. Mis Clientes: base de datos de clientes con historial, alta
     manual, contacto directo por WhatsApp (wa.me), exportar CSV,
     exención de clientes del filtro de antigüedad (3 meses).
  6. Mi Equipo: alta de trabajadores con habilidades, activar/
     desactivar, renombrar (nunca borrar), tutoriales de equipo.
  7. Horarios: grid semanal por trabajador, editor de horario, copiar
     horarios entre días/trabajadores, validación de solapamientos.
  8. Compartir con trabajadores: enlaces de acceso al portal del
     trabajador para cada miembro del equipo.
  9. Personalizar (ConfigEditor): temas rápidos (1 clic), colores,
     logo, portada, textos, redes sociales, ubicación (local → mapa
     con Google Maps), CSS avanzado por tenant, vista previa en vivo
     y guía paso a paso. La página cliente se ve con la marca del
     negocio.
  10. Compartir: enlace público de la pyme + tutorial de difusión.
  11. Suscripción: plan actual, cambiar de plan, estado de pago.
  12. Promo Video (oculto): sección promocional opcional.

  Extras transversales del admin:
  - Panel de Notificaciones con polling: nuevas reservas (email) y
    recordatorios de próximas citas (WhatsApp); marcar leídas,
    eliminar, acciones directas (editar servicio, eliminar con doble
    confirmación inline).
  - Tablero Kanban de citas por estado (ClientBoard), con etiquetas de
    pago por cliente basadas en citas.estado_pago; permiso por tenant
    para que los trabajadores vean/editen etiquetas.
  - Modales con formulario que NUNCA pierden datos al tocar fuera
    (confirman antes de descartar).
  - Estética: banners de guía paso a paso, botones primarios con
    gradiente, diseño mobile con tarjetas compactas y acciones
    icon-only.

--- 4.3 PÁGINA PÚBLICA DEL CLIENTE (cliente.html?tenant_id=X) ----
  - Header con portada, logo y nombre de la pyme (marca personalizada).
  - Banner de redes sociales y banner de ubicación (con mapa si es
    local presencial).
  - Buscador de servicios y filtro por fecha.
  - Catálogo con tarjetas de servicio (precio, duración, descripción,
    imagen, badge "destacado").
  - Carrito lateral multi-servicio con total en vivo y botón
    "Agendar Cita" (flujo tipo e-commerce).
  - Selección de fecha/hora según cupos disponibles (fechas con día de
    la semana, cupos por hora), con selección de trabajador cuando el
    servicio lo requiere.
  - Reserva sin registro: solo datos de contacto.
  - Exportar CSV de servicios filtrados.
  - Ocultamiento automático de servicios expirados con aviso al
    cliente.
  - Diseño 100% responsive; el cliente la abre desde el celular.

--- 4.4 PORTAL DEL TRABAJADOR (trabajador.html) ------------------
  - Acceso propio con su cuenta (sin ver datos de otros tenants).
  - Cabecera con su nombre y habilidades.
  - Mi Horario Semanal (solo lectura de su turno).
  - Reservas de Hoy: lista de sus citas del día.
  - Tablero Kanban de citas reutilizado (misma vista que el admin),
    con etiquetas de pago si el tenant lo permite.

--- 4.5 SUPERADMIN (superadmin.html) ------------------------------
  - Gestión global de Tenants (crear, configurar, eliminar inactivos,
    estadísticas por tenant).
  - Usuarios (global).
  - Servicios globales y Citas globales (visión transversal).
  - Estadísticas globales de la plataforma.
  - Tabs adicionales inyectados por JS: Directorio de PYMEs
    (moderación de reseñas, visibilidad pública) y otros módulos
    internos.

--- 4.6 PLANES Y PAGOS (planes.html) ------------------------------
  - Free Trial: 14 días gratis, sin límites, sin tarjeta.
  - Pro: $15.000 CLP/mes (con cupón promocional aprobado: $7.500/mes
    con descuento 50%).
  - Premium Anual: $140.000 CLP/año (ahorro de $40.000 vs mensual).
  - Pago con Mercado Pago: pago único o suscripción con cobro
    automático (preapproval); verificación de estado al volver de MP;
    banners de éxito/fallo, suscripción expirada, cuenta suspendida y
    WhatsApp pendiente.
  - Auto-redirección al panel tras pago exitoso.
  - Los datos se conservan aunque la suscripción expire (reactivar =
    todo vuelve).

================================================================
5. BENEFICIOS TRANSVERSALES
================================================================

  - Elimina el "no-show": recordatorios automáticos por WhatsApp y
    notificaciones de nueva reserva por email reducen ausencias.
  - Elimina la gestión telefónica: los clientes se auto-agendan 24/7
    desde el celular; el dueño deja de coordinar por mensajes.
  - Imagen profesional: página pública con la marca del negocio
    (logo, colores, portada, redes, ubicación) sin saber programar.
  - Captación de clientes gratis: el Directorio Público con reseñas
    funciona como vitrina local y buscador (SEO social).
  - Prueba social: sistema de reseñas con estrellas en el directorio.
  - Control financiero: dashboard de ventas, estado de pago por cita
    (pendiente/pagado/adelanto), ventas archivadas, export CSV.
  - Escala con el equipo: multi-trabajador con portales individuales,
    horarios propios y asignación de servicios por profesional.
  - Multi-reserva: carrito de servicios (el cliente agenda varios
    servicios de una vez, como un combo).
  - Datos centralizados: base de clientes con historial y exportación.
  - Mobile-first: todo funciona desde el teléfono del dueño y del
    cliente.
  - Seguridad y privacidad: aislamiento total entre pymes (RLS
    multi-tenant), captcha anti-bot, CSP estricta, JWT; datos clínicos
    protegidos (caso salud).
  - Costo predecible: suscripción plana sin comisión por reserva.
  - Sin instalación ni mantenimiento: web app con PWA/service worker.

================================================================
6. DOLORES QUE RESUELVE POR CATEGORÍA DE PYME
================================================================

A) SALUD Y BIENESTAR CLÍNICO (odontólogos, psicólogos, terapeutas,
   fonoaudiólogos, kinesiólogos, nutricionistas):
   - No-shows en consultas: recordatorios automáticos por WhatsApp.
   - Agenda sobrecargada de llamadas: auto-reserva online 24/7.
   - Privacidad de pacientes: aislamiento multi-tenant (cada
     profesional solo ve sus datos; nunca los de otra pyme).
   - Historial de pacientes centralizado con exportación.
   - Sesiones recurrentes: disponibilidad por fechas y cupos.
   - Citas de duración variable (consulta vs procedimiento largo).

B) ESTÉTICA, BELLEZA Y CUIDADO PERSONAL (peluqueros, manicuristas,
   barberos, maquillistas, esteticistas, masajistas):
   - Salón con varios profesionales: agenda por trabajador y
     asignación de servicios por especialidad.
   - Cupos por horario: módulos con capacidad (evita sobreventa).
   - Recordatorios por WhatsApp (crítico en belleza: alto no-show).
   - Carrito multi-servicio (ej. manicure + pedicure + depilación en
     una sola reserva).
   - Reputación local: directorio + reseñas atraen clientes nuevos.
   - Fidelización: base de clientes con historial de servicios.

C) DEPORTE, ACTIVIDAD FÍSICA Y CLASES (entrenadores, yoga/pilates,
   deportes específicos, música, baile, tutores/idiomas):
   - Clases con cupos limitados: gestión de capacidad por horario.
   - Alumnos recurrentes: horarios fijos semanales y fechas especiales.
   - Multi-instructor: horarios y habilidades por profesional.
   - Recordatorios de próxima clase (reduce abandono y ausencias).
   - Alquiler de espacios/ canchas por bloques de tiempo con cupos.

D) SERVICIOS PROFESIONALES Y CREATIVOS (abogados, consultores,
   contadores, fotógrafos, tatuadores, diseñadores/freelancers,
   veterinarios):
   - Horas largas y de alto valor (tatuajes, sesiones de foto):
     estado de pago con ANTICIPOS/SEÑAS por cita.
   - Agenda de reuniones/consultas sin ir y venir de correos.
   - Freelancers: página profesional propia para recibir clientes.
   - Veterinarios: consultas por mascota, urgencias y recordatorios
     de seguimiento.
   - Facturación simple: ventas archivadas y export CSV.

E) SERVICIOS TÉCNICOS, HOGAR Y TERRENO (reparaciones, plomeros/
   electricistas, limpieza, guías de turismo, canchas):
   - Visitas a domicilio: la página muestra la ubicación/cobertura y
     el cliente agenda el bloque que le sirve.
   - Optimización de rutas implícita: el técnico ve sus citas del día
     ordenadas y las reprograma desde el panel.
   - Alquiler por bloques (canchas): módulos con cupos y precios.
   - Tours/excursiones: reservas con cupos por fecha (grupos).
   - Contacto directo por WhatsApp con el cliente desde la cita.

================================================================
7. MODELO DE NEGOCIO Y MONETIZACIÓN
================================================================

  - Freemium → Free Trial 14 días (sin tarjeta) → plan de pago.
  - Pro $15.000 CLP/mes (posible cupón 50% = $7.500).
  - Premium Anual $140.000 CLP/año.
  - Pagos con Mercado Pago (APP_USR producción): pago único o
    suscripción con cobro automático; webhook verifica el pago contra
    la API de MP.
  - Gate por plan: el Directorio Público solo es visible/publicable
    para planes pro/premium_anual/freemium; free_trial limitado (sin
    visual, 14 días).
  - Sin comisión por reserva: el dueño paga solo su suscripción.

================================================================
8. STACK TÉCNICO (para que la otra IA entienda la arquitectura)
================================================================

  - Frontend: HTML + CSS + JavaScript vanilla (ES Modules), build con
    esbuild (code splitting por vista; app.js ~8.4KB + chunks).
    Arquitectura híbrida: módulos modernos en src/ (api, appointments,
    auth, catalog, clients, dashboard, directory, notifications,
    services, shared, subscriptions, super-admin, visual-config,
    workers) + núcleo legacy en src/_legacy/script.js (monolito que
    convive vía window.__apis y funciones globales).
  - Backend: Supabase (PostgreSQL + Auth + Storage + RLS). Las
    operaciones críticas (reservar cita, bulk, directorio, reseñas,
    permisos de trabajadores) se ejecutan como RPCs con SECURITY
    DEFINER; los INSERT directos a tablas protegidas están cerrados.
  - Multi-tenant: tabla tenants + tenant_id en todas las entidades +
    políticas RLS por tenant; el cliente accede vía ?tenant_id=X.
  - Páginas: login.html, planes.html, admin.html, cliente.html,
    trabajador.html, superadmin.html, reset-pass.html (+ dist/ y
    .vercel/output/static/ como build de producción).
  - Seguridad: anon key inyectada en build (service_role jamás en el
    bundle), CSP estricta (script-src solo hashes), Cloudflare
    Turnstile, rate limiting, JWT con expiración.
  - Infra: deploy en Vercel (aliases agenda-pro-*), service worker
    PWA, sitemap.xml, robots.txt, security.txt.
  - Migraciones: SQL lineales en orden cronológico estricto; nunca
    DO $$ blocks.

================================================================
9. DATOS CLAVE PARA CUALQUIER IA QUE TRABAJE EL CÓDIGO
================================================================

  - Entidades principales: tenants, servicios, trabajadores, citas,
    clientes_manuales, notificaciones, tenant_config (personalización
    visual + datos de directorio), pyme_resenas, subscriptions,
    kanban_cards, promo_coupons.
  - citas.estado_pago: pendiente / pagado / adelanto (seña) — se
    muestra como etiqueta en la agenda y en el kanban.
  - El nombre del servicio sale en la notificación de la reserva
    (usar servicios con nombres claros al probar).
  - Free Trial se crea solo en el registro (?new=true); nunca al
    cambiar de plan.
  - UX establecida: modales que no pierden datos, doble confirmación
    para destrucción, banners de guía paso a paso, botones primarios
    con gradiente, diseño mobile compacto.
  - El flujo cliente copia el look de e-commerce (carrito, resumen en
    vivo, fechas con día de la semana, cupos por hora).
