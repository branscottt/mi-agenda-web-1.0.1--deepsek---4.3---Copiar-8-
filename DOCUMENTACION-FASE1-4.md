# Refactor del Segmento 3 — Horarios del Servicio (Fases 1-4)

> Proyecto: mi-agenda-web  
> Arquivos modificados: `script.js`, `style.css`, `admin.html`  
> Fecha: Junio 2026

---

## Resumen

Se refactorizó por completo el sistema de asignación de horarios y módulos del Paso 3 ("Horarios del servicio") para implementar una **jerarquía de datos en cascada** (_dateSpecificModules > _weekdayModules > window.serviceModules) y una interfaz visual de **cards por fecha** que soporta horarios asimétricos entre fechas.

El refactor se realizó en 4 fases incrementales, sin romper almacenes existentes ni funciones de guardado/persistencia.

---

## Fase 1 — Jerarquía en Cascada (generarDisponibilidadFinal)

### Problema original
`buildDisponibilidadFromForm()` usaba `getModulesForDate()` que solo retornaba módulos según el **modo activo** ('all', 'weekday' o 'date'), no según la jerarquía completa. Esto impedía que el JSON final a Supabase reflejara correctamente la combinación de configuraciones generales + por día + por fecha.

### Solución
Se creó `generarDisponibilidadFinal()` que procesa `selectedDates` aplicando la jerarquía real:

1. Si `_dateSpecificModules[fecha]` existe y tiene datos → usar esos (máxima prioridad)
2. Si no, pero `_weekdayModules[day]` tiene datos para el día de la semana → usar esos
3. Si no, usar `window.serviceModules` (base general)

### Archivos modificados

| Archivo | Líneas | Cambio |
|---------|--------|--------|
| `script.js` | ~5287-5344 | Nueva función `generarDisponibilidadFinal()` |
| `script.js` | ~3786-3810 | `buildDisponibilidadFromForm()` modificada para usar `generarDisponibilidadFinal()` |

### Código clave

```javascript
function generarDisponibilidadFinal() {
    const resultado = {};
    const fechas = Array.from(selectedDates || []).sort();
    
    fechas.forEach(fecha => {
        const day = new Date(fecha + 'T12:00:00').getDay();
        
        // 1. Prioridad máxima: fecha específica
        if (_dateSpecificModules[fecha] && _dateSpecificModules[fecha].length > 0) {
            mods = _dateSpecificModules[fecha];
        }
        // 2. Prioridad media: día de la semana
        else if (_weekdayModules[day] && _weekdayModules[day].length > 0) {
            mods = _weekdayModules[day];
        }
        // 3. Prioridad base: generales
        else if (window.serviceModules && window.serviceModules.length > 0) {
            mods = window.serviceModules;
        }
        
        if (mods && mods.length > 0) {
            resultado[fecha] = mods.map(m => ({
                hora, startTime, endTime, cupos, duration, editable, _fuente
            }));
        }
    });
    return resultado;
}
```

### Impacto
- `buildDisponibilidadFromForm()` ahora genera el JSON con jerarquía real
- Al crear un servicio, el campo `disponibilidad` en Supabase contiene los módulos correctos por fecha
- Ningún almacén existente fue modificado

---

## Fase 2 — Cards por fecha (renderModulesList)

### Problema original
`renderModulesList()` generaba una **tabla rígida** (`<table>`) con columnas fijas de horarios. Si distintas fechas tenían módulos/horarios diferentes, la tabla se rompía o se volvía confusa.

### Solución
Se reescribió `renderModulesList()` para generar **cards independientes por fecha**, cada una con sus propios módulos, inputs de cupo y totales.

### Estructura visual

```
┌─────────────────────────────────────────┐
│  Lun 10 Jun (Jue) [Fecha específica 🟣]  │  ← badge con fuente + tooltip
│  ↓ Cupo masivo  Total: 15 cupos         │
├─────────────────────────────────────────┤
│  09:00 - 10:00  60min  Cupos: [ 5 ] × │
│  14:00 - 15:00  60min  Cupos: [ 3 ] × │
│  ...                                    │
└─────────────────────────────────────────┘
```

### Archivos modificados

| Archivo | Líneas | Cambio |
|---------|--------|--------|
| `script.js` | ~6110-6240 | `renderModulesList()` reescrita completa |

### Funcionalidad preservada
- `actualizarCupo(input)` — los inputs usan `data-date` y `data-hora` (igual que antes)
- `deshabilitarCupo(fecha, hora)` — funciona igual
- `moduleDateCupos[fecha][hora]` — se inicializa y actualiza igual
- `buildDisponibilidadFromForm()` recolecta cupos con `querySelectorAll('.module-cupos-input')`
- Botón "↓ Cupo masivo" dentro de cada card (usa `aplicarCupoAHorarios()`)

### Elementos eliminados
- Tabla rígida con columnas fijas
- Colapso de fechas (`toggleFechasMatriz`)
- Fila de totales por horario (reemplazado por total parcial en cada card)
- Botón "↕" de cupo masivo por horario (`aplicarCupoAFechas()` existe pero sin botón explícito)

---

## Fase 3 — Alertas visuales de jerarquía

### Problema original
El usuario no tenía forma de saber qué fechas estaban usando configuraciones específicas vs generales, ni qué pasaba al guardar en modo "Todos los días igual" cuando existían excepciones.

### Solución — 3 niveles

#### Nivel 1: Badge enriquecido en cada card
Cada card muestra un badge de color con tooltip explicativo:

| Badge | Color | Tooltip |
|-------|-------|---------|
| Fecha específica | 🟣 Morado | "Ignora configuración de día y general" |
| Por día de semana | 🟢 Verde | "Sigue configuración del día, ignora base general" |
| General | 🔵 Azul | "Usa configuración base general para todos los días" |

#### Nivel 2: Barra de estado del sistema
Arriba de las cards se muestra un resumen:
```
📅 10 fechas  🟣 2 con fecha específica  🟢 3 días con configuración propia  🔵 8 heredan
⚠️ Modo general activo — las configuraciones específicas se mantienen
```

#### Nivel 3: Alerta no bloqueante en confirmarModulos()
Al presionar "Confirmar módulos" en modo `all` si existen configuraciones específicas:
```
⚠️ Al confirmar en modo global, recuerda que existen 2 fechas específicas y 3 días personalizados que mantendrán sus propios horarios prioritarios.
```

### Archivos modificados

| Archivo | Líneas | Cambio |
|---------|--------|--------|
| `script.js` | ~5365-5387 | Nueva función `contarFechasEspecificasActivas()` |
| `script.js` | ~6155-6190 | Badge enriquecido + barra `hierarchy-status-bar` |
| `script.js` | ~6030-6042 | Alerta Nivel 3 en `confirmarModulos()` |

---

## Fase 4 — Limpieza (código muerto)

### Elementos eliminados

| Archivo | Elemento | Motivo |
|---------|----------|--------|
| `script.js` | Función `getModulesForDate()` | Reemplazada por `generarDisponibilidadFinal()` |
| `script.js` | Función `toggleFechasMatriz()` | Ya no hay tabla colapsable |
| `style.css` | `.modules-table`, `.modules-table-row`, `.col-hour`, `.col-date`, `.col-actions` (2 bloques: principal y media query) | Ya no se usan |
| `style.css` | `.btn-mass-cupo-fila`, `.mass-cupo-fechas` (implícitos en los bloques eliminados) | Sin referencias |

---

## Jerarquía de datos (diagrama conceptual)

```
selectedDates (Set de fechas)
│
├── Fecha X → _dateSpecificModules[X]? ── SÍ → USAR (prioridad máxima)
│               └── NO
│                  → _weekdayModules[dayOfWeek]? ── SÍ → USAR (prioridad media)
│                     └── NO
│                        → window.serviceModules? ── SÍ → USAR (base general)
│                           └── NO → FECHA SIN MÓDULOS (rojo en UI)
│
└── generarDisponibilidadFinal() → JSON final

buildDisponibilidadFromForm()
  → recolecta cupos de inputs
  → llama a generarDisponibilidadFinal()
  → sobreescribe cupos con valores editados
  → retorna JSON para Supabase
```

---

## Backward Compatibility

| Componente | Estado | Notas |
|------------|--------|-------|
| `window.serviceModules` | ✅ Intacto | Sigue siendo el almacén base |
| `_weekdayModules[dia]` | ✅ Intacto | Sigue almacenando módulos por día |
| `_dateSpecificModules[fecha]` | ✅ Intacto | Sigue almacenando módulos por fecha |
| `saveModulesToHiddenField()` | ✅ Intacto | Serializa igual que antes |
| `loadModulesFromHiddenField()` | ✅ Intacto | Restaura igual que antes |
| `moduleDateCupos[fecha][hora]` | ✅ Intacto | Sigue almacenando cupos editados |
| `guardarAsignacionActual()` | ✅ Intacto | Guarda en almacenes actuales |
| `actualizarCupo(input)` | ✅ Intacto | Los inputs usan mismos dataset |
| `deshabilitarCupo(fecha, hora)` | ✅ Intacto | Funciona igual |
| `aplicarCupoAHorarios(fecha)` | ✅ Intacto | Ahora en header de cada card |
| `renderModulesEditable()` | ✅ Intacto | Editor de módulos sin cambios |
| `crearServicio()` | ✅ Intacto | Solo cambió `buildDisponibilidadFromForm()` interno |
| HTML `admin.html` | ✅ Intacto (excepto botones de limpieza/indicador weekday) | Sin cambios estructurales |

---

## Notas importantes para futuros desarrolladores

1. **No hay migración de datos necesaria.** Los almacenes son los mismos, solo cambió cómo se leen al construir el JSON final.

2. **La función `_fuente` en cada módulo** es un metadato de debug (dateSpecific / weekday / general). No afecta a Supabase. Si se quiere eliminar del JSON final, filtrar en `generarDisponibilidadFinal()`.

3. **Para agregar un nuevo modo de asignación** (ej. "quincenal", "mensual"), seguir el patrón: nuevo almacén, agregar prioridad en `generarDisponibilidadFinal()`, nuevo badge en `badgeColors`.

4. **Para probar la jerarquía**: en consola ejecutar `console.log(JSON.stringify(generarDisponibilidadFinal(), null, 2))` después de configurar módulos en distintos modos.

---

## Archivos técnicos relacionados

- `spec/ARCHITECTURE_SCREAMING.md` — Arquitectura general del proyecto
- `spec/PLAN_REFACTOR.md` — Plan de refactor original
- `10-mejoras.md` — Lista de mejoras pendientes