# 10 Mejoras para "Crear Servicio"

## Mejora #1 – Cupos disponibles en popup ✅ YA IMPLEMENTADA
Línea 6263: `<option>${horaText} - ${cupos} cupos</option>`

## Mejora #2 – Validar solapamiento
### Nueva función: `horariosSolapan()` antes de `addModule()`
### Modificar `addModule()`: validar antes de pushear

## Mejora #3 – Botones cupo masivo
### Modificar `renderModulesList()`: añadir botones "Aplicar a todas las fechas" y "Aplicar a todos los horarios"

## Mejora #4 – Rango de fechas + días de semana
### Nuevo bloque HTML en admin.html (sección `#service-creator`)
### Nueva función: `generarFechasPorRango()`

## Mejora #5 – Duración independiente del servicio
### Modificar `crearServicio()`, `actualizarServicio()`, `getServiceDuration()`, `updateDurationDisplay()`

## Mejora #6 – Restaurar cupos en edición
### Modificar `editarServicio()`: reconstrucción robusta de `moduleDateCupos`

## Mejora #7 – Duplicar servicio
### Modificar `cargarServiciosExistentes()`: añadir botón "Duplicar"
### Nueva función: `duplicarServicio(id)`

## Mejora #8 – Vista previa
### Nueva función: `mostrarVistaPrevia()`
### Nuevo botón en el formulario (admin.html o inyectado por JS)

## Mejora #9 – Confirmación al cancelar edición
### Modificar `cancelarEdicion()`: preguntar si hay cambios

## Mejora #10 – Botón X para deshabilitar horario en fecha específica
### Modificar `renderModulesList()`: añadir botón X en cada celda de cupo