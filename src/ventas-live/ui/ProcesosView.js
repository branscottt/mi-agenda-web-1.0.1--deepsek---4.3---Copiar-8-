// ventas-live/ui/ProcesosView.js
// La pantalla PROCESOS es UN SOLO DIAGRAMA.
//
// Antes había un toggle Lista / Diagrama: la "Lista" era el listado agrupado
// por estado, que en la práctica mostraba a todas las personas y duplicaba lo
// que ya vive en la pestaña Clientes. Se quitó: acá solo queda el diagrama
// (todos los procesos de una, con sus puntos presionables y sus acciones).
//
// La vista real está en DiagramaView.js; este módulo solo la monta en la
// sección y mantiene el nombre de export que usa el router.

import { initDiagrama } from './DiagramaView.js';

let _built = false;

export function initProcesos() {
    const cont = document.getElementById('vl-view-procesos');
    if (!cont) return;
    if (!_built) {
        cont.innerHTML = '<div id="vp-diag"></div>';
        _built = true;
    }
    initDiagrama(document.getElementById('vp-diag'));
}
