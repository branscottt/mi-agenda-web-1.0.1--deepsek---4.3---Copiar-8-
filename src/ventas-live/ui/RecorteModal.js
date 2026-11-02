// ventas-live/ui/RecorteModal.js
// Recortar un video antes de mandarlo: elegir DESDE y HASTA viendo la imagen.
//
// Reglas de UX del proyecto:
//   * Cerrar siempre explícito (Cancelar) y sin perder nada: tocar fuera o
//     Escape con las marcas movidas pregunta antes de descartar (lo maneja
//     abrirModal con marcarSucio()).
//   * Pensado para dedo: controles grandes, se ve la imagen mientras se mueve.
//   * El corte NO re-comprime: entra en el keyframe anterior más cercano (hasta
//     ~2 s antes). Eso se dice con todas las letras abajo del video.
import { abrirModal, cerrarModal } from './vlModales.js';
import { escapeHtml } from '../../shared/infrastructure/formatters.js';

/** "1:23" */
function mmss(seg) {
    const s = Math.max(0, Math.round(Number(seg) || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/**
 * Abre el modal de recorte.
 * @param {Object} o {archivo, onListo({desde, hasta}), onCancelar}
 */
export function abrirRecorte({ archivo, onListo } = {}) {
    if (!archivo) return;
    const url = URL.createObjectURL(archivo);
    let dur = 0;
    let movido = false;

    const html = `
        <video id="vlrc-video" class="vlrc-video" src="${escapeHtml(url)}" controls playsinline preload="metadata"></video>
        <div class="vlrc-marcas">
            <div class="vlrc-linea">
                <label class="vlrc-eti" for="vlrc-desde">Desde</label>
                <input class="vlrc-range" type="range" id="vlrc-desde" min="0" max="1" step="0.1" value="0">
                <output class="vlrc-val" id="vlrc-desde-out">0:00</output>
            </div>
            <div class="vlrc-linea">
                <label class="vlrc-eti" for="vlrc-hasta">Hasta</label>
                <input class="vlrc-range" type="range" id="vlrc-hasta" min="0" max="1" step="0.1" value="1">
                <output class="vlrc-val" id="vlrc-hasta-out">0:00</output>
            </div>
        </div>
        <div class="vlrc-info" id="vlrc-info">
            <i class="fas fa-circle-notch fa-spin"></i> Leyendo el video…
        </div>
        <div class="vlrc-nota">
            Se manda con la calidad original (no se recomprime). El corte de entrada
            cae en el keyframe anterior más cercano: puede empezar hasta ~2 s antes.
        </div>
        <div class="vl-modal-actions">
            <button class="vl-btn" id="vlrc-cancelar" type="button">Cancelar</button>
            <button class="vl-btn primary" id="vlrc-listo" type="button" disabled>
                <i class="fas fa-scissors"></i> Usar este tramo
            </button>
        </div>`;

    abrirModal({
        titulo: '✂️ Recortar video',
        sub: escapeHtml(String(archivo.name || 'video')),
        html,
        ancho: '520px',
        onMount: (modal, ctx) => {
            const video = modal.querySelector('#vlrc-video');
            const desde = modal.querySelector('#vlrc-desde');
            const hasta = modal.querySelector('#vlrc-hasta');
            const desdeOut = modal.querySelector('#vlrc-desde-out');
            const hastaOut = modal.querySelector('#vlrc-hasta-out');
            const info = modal.querySelector('#vlrc-info');
            const listo = modal.querySelector('#vlrc-listo');
            const cancelar = modal.querySelector('#vlrc-cancelar');
            let cerrado = false;

            const soltar = () => {
                if (cerrado) return;
                cerrado = true;
                try { URL.revokeObjectURL(url); } catch (_) { /* nada */ }
            };

            const pintarInfo = () => {
                const d = Number(desde.value) || 0;
                const h = Number(hasta.value) || 0;
                desdeOut.textContent = mmss(d);
                hastaOut.textContent = mmss(h);
                const queda = Math.max(0, h - d);
                info.innerHTML = queda > 0
                    ? `<i class="fas fa-check"></i> Quedan <b>${mmss(queda)}</b> de ${mmss(dur)}`
                    : '<i class="fas fa-triangle-exclamation"></i> El tramo no puede quedar vacío';
                listo.disabled = !(queda > 0.5);
            };

            // Al mover las marcas se ve ESA imagen en el reproductor.
            const ver = (t) => {
                try { if (video && Math.abs(video.currentTime - t) > 0.05) video.currentTime = t; } catch (_) { /* nada */ }
            };

            desde.addEventListener('input', () => {
                const h = Number(hasta.value) || dur;
                if (Number(desde.value) >= h - 0.3) desde.value = String(Math.max(0, h - 0.3));
                movido = true;
                if (typeof ctx.marcarSucio === 'function') ctx.marcarSucio();
                pintarInfo();
                ver(Number(desde.value));
            });
            hasta.addEventListener('input', () => {
                const d = Number(desde.value) || 0;
                if (Number(hasta.value) <= d + 0.3) hasta.value = String(d + 0.3);
                movido = true;
                if (typeof ctx.marcarSucio === 'function') ctx.marcarSucio();
                pintarInfo();
                ver(Number(hasta.value));
            });

            const arrancar = () => {
                dur = Number(video.duration) || 0;
                if (!(dur > 0)) {
                    info.innerHTML = '<i class="fas fa-triangle-exclamation"></i> '
                        + 'Este video no se puede ver en este dispositivo, así que no se puede recortar acá.';
                    return;
                }
                desde.max = String(dur);
                hasta.max = String(dur);
                desde.value = '0';
                hasta.value = String(dur);
                listo.disabled = false;
                pintarInfo();
                try { video.currentTime = Math.min(0.05, dur / 2); } catch (_) { /* nada */ }
            };
            if (video.readyState >= 1) arrancar();
            else video.addEventListener('loadedmetadata', arrancar, { once: true });
            video.addEventListener('error', () => {
                info.innerHTML = '<i class="fas fa-triangle-exclamation"></i> '
                    + 'Este formato no se puede previsualizar acá. Prueba recortarlo en la galería del teléfono.';
            }, { once: true });

            cancelar.addEventListener('click', () => {
                cerrarModal();
                soltar();
            });
            listo.addEventListener('click', () => {
                const tramo = { desde: Number(desde.value) || 0, hasta: Number(hasta.value) || 0 };
                if (!(tramo.hasta - tramo.desde > 0.5)) return;
                cerrarModal(true);
                soltar();
                if (typeof onListo === 'function') onListo(tramo);
            });

            // El modal se pudo cerrar por fuera/Escape: se libera la URL.
            const esperar = setInterval(() => {
                if (!document.body.contains(modal)) {
                    clearInterval(esperar);
                    soltar();
                }
            }, 800);
            void movido;
        }
    });
}
