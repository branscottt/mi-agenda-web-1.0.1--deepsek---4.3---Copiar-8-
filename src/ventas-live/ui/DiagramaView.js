// ventas-live/ui/DiagramaView.js
// DIAGRAMA de procesos: TODOS los procesos activos en una sola vista.
//
// Por cada cliente se ve su proceso como "puntos" (Región · Entrega · Courier ·
// Pago · Fecha). Los valores se AUTO-RELLENAN con lo que ya sabe el sistema
// (y lo que el bot fue capturando del chat) y se pueden CAMBIAR a mano
// presionando el punto.
//
// Además marca la alerta "posible soltar prenda" (debe plata y no escribe
// hace 3+ días) y ofrece las acciones destructivas a mano: liberar prenda y
// bloquear + borrar datos.
//
// Datos: vl_procesos_diagrama (RPC admin). Cambios: vl_proceso_punto_set.

import { vlApi, ESTADO_INFO } from '../domain/vlApi.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { formatearDinero, escapeHtml } from '../../shared/infrastructure/formatters.js';
import {
    modalPunto, modalLiberarItems, modalBloquearBorrar,
    PUNTO_LABEL, PUNTO_VALOR_LABEL
} from './accionesProceso.js';
import { abrirChatDeUsuario } from './ConversacionesDrawer.js';

// Orden de los puntos = el orden natural del proceso (como el chat).
const ORDEN_PUNTOS = ['region', 'entrega', 'courier', 'pago', 'fecha'];

let _procesos = [];
let _cont = null;

export function initDiagrama(cont) {
    _cont = cont || document.getElementById('vp-diag');
    refrescarDiagrama();
}

export async function refrescarDiagrama() {
    const cont = _cont || document.getElementById('vp-diag');
    if (!cont) return;
    if (!_procesos.length) {
        cont.innerHTML = '<div class="vl-empty"><i class="fas fa-spinner fa-spin"></i> Cargando diagrama…</div>';
    }
    const res = await vlApi.diagramaProcesos();
    if (!res.ok) {
        cont.innerHTML = '<div class="vl-empty">No se pudo cargar el diagrama: '
            + escapeHtml(res.error || 'error') + '</div>';
        return;
    }
    _procesos = (res.data && Array.isArray(res.data.procesos)) ? res.data.procesos : [];
    pintar(cont);
}

function fmtFecha(iso) {
    if (!iso) return '';
    const p = String(iso).slice(0, 10).split('-');
    if (p.length !== 3) return iso;
    return p[2] + '/' + p[1];
}

function valorTexto(key, punto) {
    const v = punto && punto.valor;
    if (key === 'fecha') return v ? fmtFecha(v) : 'Sin fecha';
    return PUNTO_VALOR_LABEL[v] || (v ? v : 'Sin definir');
}

function chipPunto(key, punto) {
    const v = punto && punto.valor;
    let clase = 'vlg-punto';
    if (!v) clase += ' vacio';
    if (key === 'pago') {
        if (v === 'pagado') clase += ' ok';
        else if (v === 'parcial') clase += ' parcial';
        else if (v === 'sin_pagar') clase += ' pendiente';
    }
    const title = 'Cambiar ' + (PUNTO_LABEL[key] || key) + ' (valor actual: '
        + valorTexto(key, punto) + ')';
    return `<button class="${clase}" data-punto="${key}" type="button" title="${escapeHtml(title)}">
                <span class="k">${escapeHtml(PUNTO_LABEL[key] || key)}</span>
                <span class="v">${escapeHtml(valorTexto(key, punto))}</span>
            </button>`;
}

function filaHTML(p) {
    const c = p.cliente || {};
    const info = ESTADO_INFO[p.estado] || { label: p.estado };
    const alerta = p.alerta;
    const puntos = p.puntos || {};
    const dias = Number(p.dias_sin_contacto || 0);
    const sub = [
        c.nombre_real ? escapeHtml(c.nombre_real) : null,
        'Debe <b>' + formatearDinero(p.saldo) + '</b>',
        p.prendas + ' prenda(s)',
        dias <= 0 ? 'Contacto hoy' : ('Sin contacto hace ' + dias + ' día(s)')
    ].filter(Boolean).join(' · ');

    return `
        <div class="vlg-row${alerta ? ' con-alerta' : ''}" data-p="${escapeHtml(p.proceso_id)}">
            <div class="vlg-cli">
                <div class="vlg-titulo">
                    <span class="vlg-nick">@${escapeHtml(c.tiktok_user || '?')}</span>
                    <span class="vlg-estado">${escapeHtml(info.label)}</span>
                </div>
                <div class="vlg-sub">${sub}</div>
                ${alerta ? `<div class="vlg-alerta">⚠️ ${escapeHtml(alerta.detalle || 'Posible soltar prenda')}
                    <span class="vlg-alerta-hint">— decide: liberar la prenda o bloquear al usuario</span></div>` : ''}
            </div>
            <div class="vlg-puntos">
                ${ORDEN_PUNTOS.map(k => chipPunto(k, puntos[k])).join('')}
            </div>
            <div class="vlg-acc">
                ${c.tiktok_user ? '<button class="vl-btn" data-acc="chat" type="button"><i class="fas fa-comments"></i> Ver chat</button>' : ''}
                <button class="vl-btn" data-acc="ficha" type="button"><i class="fas fa-id-card"></i> Ficha</button>
                ${alerta ? '<button class="vl-btn danger" data-acc="liberar" type="button"><i class="fas fa-unlock"></i> Liberar prenda</button>' : ''}
                <button class="vl-btn danger-ghost" data-acc="bloquear" type="button"><i class="fas fa-user-slash"></i> Bloquear y borrar</button>
            </div>
        </div>`;
}

function pintar(cont) {
    if (!_procesos.length) {
        cont.innerHTML = '<div class="vl-empty">Sin procesos activos 🎉 Todo al día.</div>';
        return;
    }
    const conAlerta = _procesos.filter(p => p.alerta).length;
    cont.innerHTML = `
        <div class="vlg-head">
            <div class="vlg-count">${_procesos.length} proceso(s) activo(s)${
                conAlerta ? ` · <span class="vlg-count-alerta">⚠️ ${conAlerta} con posible soltar prenda</span>` : ''
            }</div>
            <div class="vlg-leyenda">Toca un punto para cambiarlo. Se ordena por urgencia.</div>
        </div>
        <div class="vlg-lista">${_procesos.map(filaHTML).join('')}</div>`;

    cont.querySelectorAll('.vlg-row').forEach(row => {
        const p = _procesos.find(x => String(x.proceso_id) === String(row.dataset.p));
        if (!p) return;
        row.querySelectorAll('.vlg-punto').forEach(b => {
            b.addEventListener('click', () => {
                const key = b.dataset.punto;
                modalPunto(p, key, (p.puntos || {})[key], refrescarDiagrama);
            });
        });
        row.querySelectorAll('button[data-acc]').forEach(b => {
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                const acc = b.dataset.acc;
                if (acc === 'ficha') {
                    if (typeof window.__vlIrAFicha === 'function') window.__vlIrAFicha(p.cliente.cliente_id);
                    return;
                }
                if (acc === 'chat') {
                    abrirChatDeUsuario(p.cliente.tiktok_user);
                    return;
                }
                if (acc === 'liberar') { modalLiberarItems(p, refrescarDiagrama); return; }
                if (acc === 'bloquear') { modalBloquearBorrar(p.cliente, refrescarDiagrama); return; }
            });
        });
    });
}

// Exportado para que ProcesosView pueda refrescar cuando vuelve a la pestaña.
export function hayDiagrama() { return _procesos.length; }
