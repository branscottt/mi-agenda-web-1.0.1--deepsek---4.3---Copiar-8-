// shared/infrastructure/urgency-calculator.js
// Calcula estado de urgencia de citas (transversal a varios modulos)

export function calcularEstadoUrgencia(fecha, hora) {
    if (!fecha) return 'normal';
    try {
        const ahora = new Date();
        let citaDate;
        const partes = String(fecha).split('-');
        if (partes.length === 3) {
            citaDate = new Date(partes[0], partes[1] - 1, partes[2]);
        } else {
            citaDate = new Date(fecha);
        }
        if (hora) {
            const horaParts = String(hora).match(/(\d{1,2}):(\d{2})/);
            if (horaParts) {
                citaDate.setHours(parseInt(horaParts[1]), parseInt(horaParts[2]), 0, 0);
            }
        } else {
            citaDate.setHours(12, 0, 0, 0);
        }
        if (isNaN(citaDate.getTime())) return 'normal';
        const diferenciaMs = citaDate - ahora;
        const diferenciaHoras = diferenciaMs / (1000 * 60 * 60);
        if (diferenciaMs < 0) return 'expirado';
        if (diferenciaHoras < 2) return 'urgent-now';
        if (diferenciaHoras <= 24) return 'urgent-soon';
        return 'normal';
    } catch (e) {
        return 'normal';
    }
}

export function aplicarClaseUrgencia(elemento, fecha, hora) {
    if (!elemento) return;
    elemento.classList.remove('urgent-soon', 'urgent-now', 'expirado');
    const estado = calcularEstadoUrgencia(fecha, hora);
    if (estado === 'urgent-soon' || estado === 'urgent-now' || estado === 'expirado') {
        elemento.classList.add(estado);
    }
}