# Cards de "Mis Servicios" — Guía visual y funcionamiento

Documenta el significado de los colores/brillo de las cards y el flujo
completo de la sección **Mis Servicios** del panel admin (admin.html).

---

## 1. ¿Qué significan los colores de las cards?

Cada card tiene un **estado de urgencia** calculado según la próxima fecha
y hora con cupos disponibles del servicio. El color es un semáforo:

| Color / Efecto | Clase CSS | Significado | Regla |
|---|---|---|---|
| **Sin brillo** (normal) | (ninguna) | Hay disponibilidad, pero la próxima cita posible es en **más de 24 h** | diferencia > 24 h |
| **Morado flúor** `#b300ff` con pulso | `.urgent-soon` | **"Próximo"** — la próxima cita posible es **entre 2 y 24 horas**. La card respira con un pulso morado (2 s) | 2 h < diferencia ≤ 24 h |
| **Rojo flúor** `#ff1744` con pulso + sello `⚠️ URGENTE` | `.urgent-now` | **"URGENTE"** — la próxima cita posible es en **menos de 2 horas**. Pulso rojo rápido (1.5 s), borde 3px y badge flotante | diferencia < 2 h |
| **Gris atenuado + borde punteado rojo + sello `EXPIRADO`** | `.service-no-dates` (estado `expirado`) | El servicio **no tiene fechas futuras con cupos**: o todas pasaron o los cupos están en 0 | sin fecha futura con cupo > 0 |

Detalles técnicos del CSS (style.css):

- `.urgent-soon`: `border: 2px solid #b300ff` + `box-shadow: 0 0 15px #b300ff` +
  animación `pulse-purple` (2s, ease-in-out). El título también se tiñe de morado.
- `.urgent-now`: `border: 3px solid #ff1744` + `box-shadow: 0 0 20px #ff1744, 0 0 40px rgba(...)` +
  animación `pulse-red` (1.5s) + `::after` con `⚠️ URGENTE`.
- `.service-no-dates`: `opacity: 0.6` + `filter: grayscale(0.5)` + borde punteado rojo
  y sello `EXPIRADO` centrado sobre la imagen (`.service-card-header::after`).
- **Hover (solo escritorio)**: la card se eleva 5px con borde y sombra morados
  (`box-shadow: 0 10px 25px rgba(157,78,221,0.2)`).

### Móvil (borde lateral de color)

En pantallas pequeñas el brillo completo se sustituye por una **barra de estado
en el borde izquierdo** de la card (más limpio, sin saturar):

- Borde **verde** → servicio Activo (`.service-status.active`)
- Borde **rojo** → servicio Inactivo (`.service-status.inactive`)
- Borde **naranja** → urgencia (`.urgent-now` usa `--warning-color`, `.urgent-soon` usa `#f39c12`)
- El badge de urgencia se muestra mini arriba a la izquierda de la imagen.

---

## 2. Paso a paso: cómo funcionan las cards

1. **Navegación**: al entrar a "Mis Servicios", `navigateTo('mis-servicios')`
   dispara `cargarServiciosExistentes()` (src/_legacy/script.js).

2. **Carga de datos**: `ServiciosManager.getAll()` trae todos los servicios del
   tenant desde Supabase (tabla servicios con `disponibilidad`, `fechas`, `modulos`).

3. **Cálculo de urgencia por servicio**:
   - Se busca la **fecha más cercana** (hoy o futura) que tenga **módulos con cupos > 0**.
   - Se toma la **hora más cercana** de ese día (si es hoy, solo horas que aún no pasaron).
   - `UrgenciaManager.calcularEstado(fecha, hora)` devuelve:
     `expirado` | `urgent-now` (<2h) | `urgent-soon` (2-24h) | `normal` (>24h).
   - Sin ninguna fecha futura con cupos → `expirado`.

4. **Render**: se genera el HTML de cada card con:
   - Clases de estado: `urgent-now`, `urgent-soon` o `service-no-dates`.
   - Badges: `URGENTE`, `Próximo`, `Sin fechas`, `Destacado`, `Activo/Inactivo`.
   - Metadatos: fechas (próximas 3), horarios, duración, cupo mínimo por turno.

5. **Binding de botones** (fix CSP): los 4 botones de cada card se bindean con
   `addEventListener` vía `data-srv-action` + `data-id` (los `onclick` inline
   quedan bloqueados por la CSP de producción, que anula `unsafe-inline` al
   incluir hashes `sha256-...`). Este es el mismo patrón usado en Mi Equipo.

6. **Acciones de los botones**:

   | Botón | Función | Qué hace |
   |---|---|---|
   | ✏️ **Editar** | `editarServicio(id)` | Carga el servicio en el formulario de creación y navega allí para modificarlo |
   | 📋 **Duplicar** | `duplicarServicio(id)` | Copia el servicio (nombre, precio, horarios, disponibilidad) como borrador en el formulario |
   | 🗑️ **Eliminar** | `eliminarServicio(id)` | Pide confirmación y borra el servicio (y sus horarios asociados) |
   | 👁️ **Ocultar/Mostrar** | `toggleActivoServicio(id)` | Activa/desactiva el servicio sin borrarlo (no aparece en la vista cliente) |

7. **Click en la card** (fuera de botones): abre el **modal de detalle**
   (`verDetalleServicio`) con imagen, precio, estado, duración, resumen de
   cupos y el desglose fecha por fecha con horarios y cupos.

8. **Filtros**: los selectores superiores permiten filtrar por estado
   (Activos/Inactivos) y por urgencia (Próximos 2-24h / Urgentes <2h / Sin urgencia).

---

## 3. Notas para el mantenimiento

- **Nunca vuelvas a poner `onclick="..."` inline en HTML generado por JS**:
  la CSP de producción (vercel.json) incluye hashes y por la spec CSP3 eso
  inhabilita `'unsafe-inline'` → el botón "no hace nada" en silencio.
  Usar siempre `data-*` + `addEventListener` después del render.
- El bridge `_initCSPEventBridge()` solo cubre el DOM estático del HTML inicial
  (patrones fijos como `navigateTo('...')`); no cubre HTML dinámico con argumentos.
- Tras modificar script.js: `node build.js` (genera dist/legacy.js minificado).
