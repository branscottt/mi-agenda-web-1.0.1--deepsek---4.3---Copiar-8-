// src/workers/domain/horarioValidation.js
// Validador de horarios laborales según normas chilenas (Código del Trabajo)
// Sin dependencias externas — lógica pura, fácil de testear.

// --- Constantes normativas ---
const MAX_HORAS_SEMANALES = 45;       // Art. 22 CT
const MAX_HORAS_DIARIAS = 10;         // Art. 22 CT (horas efectivas)
const MIN_COLACION_MIN = 30;          // Art. 34 CT — mínimo 30 min si >5h continuas
const UMBRAL_COLACION_HORAS = 5;      // Si jornada bruta > 5h, colación obligatoria
const DIAS_RESTRINGIDOS = { 7: 'Domingo (descanso obligatorio Art. 36 CT)' };

/**
 * Convierte string "HH:MM" a minutos desde 00:00
 */
function aMinutos(hhmm) {
    if (!hhmm || hhmm === '00:00') return 0;
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
}

/**
 * Calcula horas efectivas de un día (restando colación si existe)
 * @param {object} dia - { activo, inicio, fin, colacion_inicio, colacion_fin }
 * @returns {number} horas efectivas (decimal)
 */
function calcularHorasEfectivas(dia) {
    if (!dia || !dia.activo) return 0;
    const inicio = aMinutos(dia.inicio);
    const fin = aMinutos(dia.fin);
    if (fin <= inicio) return 0;

    let totalMin = fin - inicio;
    const ci = aMinutos(dia.colacion_inicio);
    const cf = aMinutos(dia.colacion_fin);

    if (ci > 0 && cf > ci) {
        totalMin -= (cf - ci);
    }

    return Math.max(0, Math.round((totalMin / 60) * 10) / 10);
}

/**
 * Calcula jornada bruta (sin descontar colación)
 */
function calcularJornadaBruta(dia) {
    if (!dia || !dia.activo) return 0;
    const inicio = aMinutos(dia.inicio);
    const fin = aMinutos(dia.fin);
    if (fin <= inicio) return 0;
    return Math.round(((fin - inicio) / 60) * 10) / 10;
}

/**
 * Valida el horario completo de un trabajador según normas chilenas
 *
 * @param {object} horario_semanal - { "1": {activo, inicio, fin, colacion_inicio, colacion_fin}, ... }
 * @param {number|null} horario_max_semanal - máximo configurado por el admin (opcional)
 * @returns {object} resultado de validación
 */
export function validarHorarioChile(horario_semanal, horario_max_semanal) {
    const resultado = {
        total_horas: 0,
        cumple: true,
        estado: 'ok', // 'ok' | 'warning' | 'error'
        advertencias: [],
        errores: [],
        detalle_dias: {}
    };

    if (!horario_semanal || typeof horario_semanal !== 'object') {
        resultado.estado = 'warning';
        resultado.advertencias.push('No hay horario semanal definido');
        return resultado;
    }

    // Validar día por día
    for (let k = 1; k <= 7; k++) {
        const key = String(k);
        const dia = horario_semanal[key] || { activo: false };
        const detalle = { activo: dia.activo, horas_efectivas: 0, jornada_bruta: 0, advertencias: [], errores: [] };

        if (dia.activo) {
            const efectivas = calcularHorasEfectivas(dia);
            const brutas = calcularJornadaBruta(dia);
            detalle.horas_efectivas = efectivas;
            detalle.jornada_bruta = brutas;
            resultado.total_horas += efectivas;

            // Validar: máximo horas efectivas diarias
            if (efectivas > MAX_HORAS_DIARIAS) {
                detalle.errores.push(`Excede ${MAX_HORAS_DIARIAS}h diarias (${efectivas}h efectivas)`);
            }

            // Validar: colación obligatoria si jornada bruta > 5h
            const ci = aMinutos(dia.colacion_inicio);
            const cf = aMinutos(dia.colacion_fin);
            const tieneColacion = ci > 0 && cf > ci;

            if (brutas > UMBRAL_COLACION_HORAS && !tieneColacion) {
                detalle.errores.push(`Falta colación: jornada de ${brutas}h sin pausa (obligatorio Art. 34 CT)`);
            }

            // Validar: colación mínima 30 min
            if (tieneColacion) {
                const colacionMin = cf - ci;
                if (colacionMin < MIN_COLACION_MIN) {
                    detalle.advertencias.push(`Colación muy corta: ${Math.round(colacionMin)}min (mínimo ${MIN_COLACION_MIN}min Art. 34 CT)`);
                }
            }

            // Validar: día restringido (domingo)
            if (DIAS_RESTRINGIDOS[key]) {
                detalle.advertencias.push(DIAS_RESTRINGIDOS[key]);
            }
        }

        resultado.detalle_dias[key] = detalle;
    }

    // Validar: máximo semanal
    const maxReferencia = horario_max_semanal || MAX_HORAS_SEMANALES;
    if (resultado.total_horas > maxReferencia) {
        const exceso = Math.round((resultado.total_horas - maxReferencia) * 10) / 10;
        resultado.errores.push(
            `Excede ${maxReferencia}h semanales por ${exceso}h${horario_max_semanal ? '' : ' (máximo legal Art. 22 CT)'}`
        );
    }

    // Validar: máximo legal 45h
    if (resultado.total_horas > MAX_HORAS_SEMANALES) {
        const exceso = Math.round((resultado.total_horas - MAX_HORAS_SEMANALES) * 10) / 10;
        if (!resultado.errores.some(e => e.includes('45h'))) {
            resultado.errores.push(`Excede el máximo legal de ${MAX_HORAS_SEMANALES}h semanales por ${exceso}h (Art. 22 CT)`);
        }
    }

    // Estado general
    if (resultado.errores.length > 0) {
        resultado.estado = 'error';
        resultado.cumple = false;
    } else if (resultado.advertencias.length > 0) {
        resultado.estado = 'warning';
    } else {
        resultado.estado = 'ok';
    }

    return resultado;
}

/**
 * Versión resumida para mostrar en la tabla de trabajadores
 * @param {object} horario_semanal
 * @param {number|null} horario_max_semanal
 * @returns {{ total_horas: number, estado: string, badge: string }}
 */
export function resumenValidacion(horario_semanal, horario_max_semanal) {
    const v = validarHorarioChile(horario_semanal, horario_max_semanal);

    let badge;
    switch (v.estado) {
        case 'ok':
            badge = '✅';
            break;
        case 'warning':
            badge = '⚠️';
            break;
        case 'error':
            badge = '❌';
            break;
        default:
            badge = '—';
    }

    return {
        total_horas: Math.round(v.total_horas * 10) / 10,
        estado: v.estado,
        badge,
        errores: v.errores,
        advertencias: v.advertencias
    };
}

// Exportar funciones auxiliares por si se necesitan individualmente
export { calcularHorasEfectivas, aMinutos };

/**
 * Obtiene el key de semana ISO a partir de una fecha
 * Ej: "2026-W29"
 * @param {Date} fecha
 * @returns {string}
 */
export function getSemanaISO(fecha) {
    const d = new Date(Date.UTC(fecha.getFullYear(), fecha.getMonth(), fecha.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return d.getUTCFullYear() + '-W' + String(weekNo).padStart(2, '0');
}

/**
 * Resuelve el horario aplicable a un trabajador en una semana específica.
 * Si existe excepción para esa semana → la usa.
 * Si no → usa la plantilla base (horario_semanal).
 *
 * @param {object} worker - trabajador completo (con horario_semanal y horario_excepciones)
 * @param {string} isoWeekKey - clave de semana ISO (ej: "2026-W29")
 * @returns {{ horario: object, esExcepcion: boolean, maxSemanal: number }}
 */
export function getHorarioParaSemana(worker, isoWeekKey) {
    const excepciones = worker.horario_excepciones || {};
    const horarioExcepcion = excepciones[isoWeekKey];

    if (horarioExcepcion && Object.keys(horarioExcepcion).length > 0) {
        return {
            horario: horarioExcepcion,
            esExcepcion: true,
            maxSemanal: worker.horario_max_semanal || 45
        };
    }

    return {
        horario: worker.horario_semanal || {},
        esExcepcion: false,
        maxSemanal: worker.horario_max_semanal || 45
    };
}

/**
 * Obtiene todas las semanas ISO dentro de un mes
 * @param {number} year - año (ej: 2026)
 * @param {number} month - mes (0-11, 0=enero)
 * @returns {Array<{ weekKey: string, start: Date, end: Date }>}
 */
export function getSemanasDelMes(year, month) {
    const semanas = [];
    const primerDia = new Date(year, month, 1);
    const ultimoDia = new Date(year, month + 1, 0);

    // Ir al lunes de la primera semana que toca este mes
    let cursor = new Date(primerDia);
    cursor.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7));

    while (cursor <= ultimoDia || semanas.length === 0) {
        const weekKey = getSemanaISO(cursor);
        const end = new Date(cursor);
        end.setDate(end.getDate() + 6);

        // Solo agregar si la semana toca el mes actual
        if (end >= primerDia && cursor <= ultimoDia) {
            semanas.push({
                weekKey,
                start: new Date(cursor),
                end: new Date(end)
            });
        }

        cursor.setDate(cursor.getDate() + 7);
        if (semanas.length > 6) break; // seguridad
    }

    return semanas;
}
