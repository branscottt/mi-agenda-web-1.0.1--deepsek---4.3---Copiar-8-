# Mis Clientes — Guía paso a paso (panel admin)

Sección del panel admin: **Mis Clientes** (menú lateral → Mis Clientes).

---

## 1. ¿Qué es y de dónde salen los clientes?

"Mis Clientes" es el directorio de clientes de tu negocio. Un cliente aparece
aquí por **cualquiera** de estas vías:

| Vía | Origen | Ejemplo |
|---|---|---|
| **Reserva web** | Clientes que reservan un servicio en tu catálogo (citas) | "Juan Pérez" reserva "Corte pelo" |
| **Histórico** | Citas pasadas ya archivadas (ventas) | Cliente que vino hace 2 meses |
| **Alta manual** | Tú los agregas a mano (botón "Agregar cliente") | Pacientes que ya tenías antes de la web |

Los clientes se unifican por **correo electrónico**: si la misma persona
reserva por la web y además la agregaste a mano, se muestra **una sola
tarjeta** que combina sus datos de contacto, visitas, gasto total y próxima cita.

> Nota: el correo es la "llave" del cliente en el sistema (así lo identifican
> también el tablero de información y el historial).

---

## 2. ¿Qué muestra cada tarjeta de cliente?

Cada tarjeta muestra:

- **Nombre** y **correo** (cabecera).
- **Total gastado** y **visitas** (chips de la cabecera).
- **Teléfono** (si lo hay).
- **Dirección** (si la hay) → clic abre Google Maps con "Cómo llegar".
- **Última visita** (o "Agregado: fecha" si lo cargaste a mano y aún no reserva).
- **Próxima cita** (fecha y hora) si tiene una reserva futura.
- **Estado de pago** (Pagado / Abonado / Se pagó algo / No pagado) si se marcó.

---

## 3. Acciones disponibles (botones de cada tarjeta)

- **WhatsApp** (verde): abre chat con el cliente con un mensaje preparado.
- **Email** (morado): abre tu correo con la dirección del cliente.
- **Llamar** (naranja): marca el teléfono del cliente.
- **Información**: abre el tablero completo del cliente (ver punto 5).
- **Historial**: despliega el listado de sus citas (servicio, fecha, hora,
  precio, total visitas y total gastado).
- **Marcar pago** (etiqueta en la tarjeta): cambia el estado de pago del
  cliente en una sola acción.

### Barra superior de la sección

- **Buscador**: filtra por nombre, correo o teléfono.
- **Agregar cliente**: alta manual (ver punto 4).
- **Etiquetas: X**: permite/limita que los trabajadores pongan etiquetas de
  pago a sus clientes (Todos / elegir trabajadores).
- **Exportar CSV**: descarga todos los clientes con nombre, correo, teléfono,
  visitas, total gastado y fechas (compatible con Excel).

---

## 4. Agregar un cliente (pacientes previos a la web)

1. Entra a **Mis Clientes** → botón **"Agregar cliente"** (también aparece en
   la pantalla vacía si aún no tienes clientes).
2. Completa los datos pedidos:
   - **Nombre** (obligatorio)
   - **Número de teléfono** (obligatorio)
   - **Correo electrónico** (obligatorio; identifica al cliente)
   - **Dirección**: solo aparece (obligatoria) si tu negocio está configurado
     con "El negocio va al domicilio del cliente". Si tu pyme muestra su local
     o no usa ubicación, este campo no se pide.
3. **Asignar reserva de un servicio** (marcado por defecto):
   - Si lo dejas activado, eliges **servicio** → **fecha** (solo días con
     horarios) → **hora** (solo horarios con cupos) → **trabajador** (opcional,
     si el servicio tiene trabajadores).
   - La reserva se crea con las mismas reglas que una reserva web: valida
     cupos, descuenta el cupo, valida el horario del trabajador y te llega la
     notificación de nueva reserva.
   - Si lo desactivas, solo guardas la ficha del cliente (sin cita).
4. Pulsa **"Guardar cliente"**. Verás un aviso de confirmación y el cliente
   aparece en la lista al instante (no hace falta recargar).

Si el correo ya existía, el sistema **no duplica**: actualiza sus datos de
contacto y te avisa "El cliente ya existía: se actualizaron sus datos".

---

## 5. Información del cliente (tablero)

Al pulsar **Información** se abre el tablero del cliente (estilo Trello):

- **Listas y tarjetas**: organiza seguimientos, tareas o notas del cliente
  (arrastrar y soltar en PC; en móvil se mueven desde el modal de la tarjeta).
- **Tarjetas**: título, descripción, etiqueta de pago (Pagado/Abonado/Se pagó
  algo/No pagado), vínculo a una cita programada (sincroniza el estado de pago
  con Citas Programadas), checklists y documentos adjuntos (hasta 100 MB:
  imágenes, PDF, Word, Excel, etc.).
- **Guardar estilo / Usar estilo**: guarda tus listas como plantilla y
  aplícala a otros clientes con un clic.
- **Editar contacto**: cambia nombre, teléfono o correo (solo vista admin).
- **Eliminar cliente** (rojo, solo admin): borra TODO el rastro del cliente
  (citas, ventas archivadas, tablero, listas, tarjetas, archivos y su ficha
  manual). Pide **doble confirmación** porque no se puede deshacer.

---

## 6. Retención de datos (¿cuándo se borra un cliente?)

La información de tus clientes **no se borra sola**:

- Los clientes que reservaron aparecen siempre que su última actividad sea de
  los últimos **3 meses**; si pasan más de 3 meses sin reservar, dejan de
  mostrarse en la lista (pero su historial queda guardado en ventas y, si
  vuelven a reservar, reaparecen con todo su historial).
- Los clientes que **agregaste manualmente** se conservan **siempre**, sin
  límite de tiempo, hasta que tú los borres con "Eliminar cliente".

En resumen: la única forma de perder un cliente es que el administrador lo
borre explícitamente (o que no reserve por más de 3 meses y no esté cargado
como cliente manual).

---

## 7. ¿Qué pasa si asigno una reserva desde "Agregar cliente"?

- Se crea la cita con fecha y hora elegidas (se descuenta el cupo del servicio).
- El cliente queda con su tarjeta actualizada: visitas, total gastado y
  próxima cita visibles.
- Recibes la **notificación de nueva reserva** en el panel (campana) y la cita
  aparece en **Citas Programadas** con las acciones habituales
  (WhatsApp, editar fecha/hora, marcar completada, no asistió).
- Si la reserva fallara (ej. horario agotado por otra reserva simultánea),
  el cliente **igual queda guardado** y se te avisa del motivo.

---

## 8. Etiquetas de pago para trabajadores

- Botón **"Etiquetas: ..."**: activa o desactiva que los trabajadores puedan
  marcar el estado de pago de sus clientes (aparece en Citas Programadas).
- Al activar puedes elegir: **todos los trabajadores** o **elegir
  trabajadores** (lista blanca).
- El administrador siempre puede marcar etiquetas, esté activado o no.
