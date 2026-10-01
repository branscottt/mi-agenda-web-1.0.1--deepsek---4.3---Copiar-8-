// ventas-live/ui/DiagramaView.js
// DIAGRAMA de procesos: TODOS los procesos activos de una, en tarjetas una al
// lado de otra.
//
// Cada tarjeta muestra:
//   * quién es (@usuario + nombre) y cuánto debe;
//   * DÓNDE ESTÁ el pedido, de forma visual: una línea de etapas
//     (Contacto → Pago → Decidir → Preparar → Entrega) con la etapa actual
//     encendida;
//   * sus "puntos" auto-rellenados y presionables (Región · Entrega · Courier ·
//     Pago · Fecha): se ven de una y se corrigen a mano;
//   * la alerta "posible soltar prenda" cuando debe plata y no escribe hace 3+ días;
//   * abajo a la derecha, chicos, los botones que hacen avanzar el proceso
//     (el paso que sigue) más ver chat / ficha / liberar / bloquear.
//
// Datos: vl_procesos_diagrama (RPC admin). Cambios: vl_proceso_punto_set y las
// acciones de proceso compartidas (accionesProceso.js).

import { vlApi, ESTADO_INFO } from '../domain/vlApi.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { formatearDinero, escapeHtml } from '../../shared/infrastructure/formatters.js';
import {
    modalPunto, modalLiberarItems, modalBloquearBorrar,
    modalConfirmarPago, modalPagaraPresencial, modalDecisionEntrega,
    modalCrearEnvio, modalMarcarEntregado, modalPagarItems,
    PUNTO_LABEL, PUNTO_VALOR_LABEL
} from './accionesProceso.js';
import { abrirChatDeUsuario } from './ConversacionesDrawer.js';

// Orden de los puntos = el orden natural del proceso (como el chat).
const ORDEN_PUNTOS = ['region', 'entrega', 'courier', 'pago', 'fecha'];

// Etapas del pedido (para ver de un golpe dónde está).
const ETAPAS = ['Contacto', 'Pago', 'Decidir', 'Preparar', 'Entrega'];

// grupo derivado igual que vl_panel_procesos (una sola verdad de negocio).
function grupoDe(p) {
    const s = Number(p.saldo || 0);
    switch (p.estado) {
        case 'esperando_whatsapp':
        case 'identificando_cliente': return 'esperando_whatsapp';
        case 'esperando_pago':        return 'esperando_pago';
        case 'pago_parcial':          return 'pago_parcial';
        case 'pagara_presencial':     return 'pagara_presencial';
        case 'pagado':                return s > 0 ? 'esperando_pago' : 'pagado_sin_decision';
        case 'acumulando':            return s > 0 ? 'esperando_pago' : 'acumulando';
        case 'listo_preparar':        return 'listo_preparar';
        case 'envio_programado':      return 'envio_programado';
        case 'envio_proceso':         return 'envio_proceso';
        case 'entrega_presencial':    return 'entrega_presencial';
        case 'entregado_por_cobrar':  return 'por_cobrar';
        default:                      return p.estado;
    }
}

// Etapa (0..4) en la que está el pedido, según su grupo.
const ETAPA_POR_GRUPO = {
    esperando_whatsapp:  0,
    esperando_pago:      1,
    pago_parcial:        1,
    pagara_presencial:   1,
    pagado_sin_decision: 2,
    acumulando:          2,
    listo_preparar:      3,
    envio_programado:    4,
    envio_proceso:       4,
    entrega_presencial:  4,
    por_cobrar:          4
};

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
        cont.innerHTML = '<div class="vl-empty"><i class="fas fa-spinner fa-spin"></i> Cargando procesos…</div>';
    }
    const res = await vlApi.diagramaProcesos();
    if (!res.ok) {
        cont.innerHTML = '<div class="vl-empty">No se pudo cargar: '
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
    return PUNTO_VALOR_LABEL[v] || (v ? v : '—');
}

function chipPunto(key, punto, puntos) {
    const v = punto && punto.valor;
    let clase = 'vlg-punto';
    if (!v) clase += ' vacio';
    if (key === 'pago') {
        if (v === 'pagado') clase += ' ok';
        else if (v === 'parcial') clase += ' parcial';
        else if (v === 'sin_pagar') clase += ' pendiente';
    }
    // Regla del negocio: Paket solo cubre Santiago (RM). Si el courier elegido
    // no calza con la región, el chip se marca para que se note.
    const region = puntos && puntos.region && puntos.region.valor;
    if (key === 'courier' && v === 'paket' && region === 'region') clase += ' warn';

    const title = 'Cambiar ' + (PUNTO_LABEL[key] || key) + ' · actual: ' + valorTexto(key, punto);
    return `<button class="${clase}" data-punto="${key}" type="button" title="${escapeHtml(title)}">
                <span class="k">${escapeHtml(PUNTO_LABEL[key] || key)}</span>
                <span class="v">${escapeHtml(valorTexto(key, punto))}</span>
            </button>`;
}

// Línea de etapas: pasado = hecho, actual = encendida, futuro = apagado.
function etapasHTML(etapaActual) {
    return `<div class="vlg-pipe" title="Paso ${etapaActual + 1} de ${ETAPAS.length}">
        ${ETAPAS.map((l, i) => {
            const cls = i < etapaActual ? 'done' : (i === etapaActual ? 'actual' : '');
            return `<span class="vlg-pipe-i ${cls}">${escapeHtml(l)}</span>`;
        }).join('')}
    </div>`;
}

// Acción que hace avanzar el proceso (la misma que tenía la vieja Lista).
function pasoHTML(g) {
    if (g === 'esperando_whatsapp') return '<button class="vlg-mini primary" data-acc="espera-pago" type="button">Marcar esperando pago</button>';
    if (g === 'esperando_pago' || g === 'pago_parcial' || g === 'pagara_presencial') return '<button class="vlg-mini primary" data-acc="pago" type="button"><i class="fas fa-hand-holding-dollar"></i> Confirmar pago</button>';
    if (g === 'pagado_sin_decision' || g === 'acumulando') return '<button class="vlg-mini primary" data-acc="decision" type="button"><i class="fas fa-box-open"></i> Decidir entrega</button>';
    if (g === 'listo_preparar' || g === 'envio_programado') return '<button class="vlg-mini success" data-acc="crear-envio" type="button"><i class="fas fa-truck-fast"></i> Envío creado</button>';
    if (g === 'envio_proceso' || g === 'entrega_presencial') return '<button class="vlg-mini success" data-acc="entregado" type="button"><i class="fas fa-check-circle"></i> Marcar entregado</button>';
    if (g === 'por_cobrar') return '<button class="vlg-mini primary" data-acc="pago" type="button"><i class="fas fa-hand-holding-dollar"></i> Cobrar saldo</button>';
    return '';
}

function tarjetaHTML(p) {
    const c = p.cliente || {};
    const info = ESTADO_INFO[p.estado] || { label: p.estado };
    const alerta = p.alerta;
    const puntos = p.puntos || {};
    const g = grupoDe(p);
    const etapa = ETAPA_POR_GRUPO[g] != null ? ETAPA_POR_GRUPO[g] : 0;
    const dias = Number(p.dias_sin_contacto || 0);
    const saldo = Number(p.saldo || 0);

    const contacto = dias <= 0 ? 'Contacto hoy' : ('Sin contacto hace ' + dias + ' día(s)');
    const plata = saldo > 0
        ? `<span class="vlg-debe">Debe</span><span class="vlg-monto">${formatearDinero(saldo)}</span>`
        : '<span class="vlg-pagado">Pagado</span>';

    // Secundarios chicos: pagará presencial (si toca), prendas con alerta
    const extra = [];
    if ((g === 'esperando_pago' || g === 'pago_parcial') && Number(p.saldo) > 0) {
        extra.push('<button class="vlg-mini" data-acc="presencial" type="button"><i class="fas fa-handshake"></i> Presencial</button>');
    }
    // Pagar UNA prenda o todas de una (misma acción que en Envíos): cobrar
    // parcialmente sin cerrar el pedido.
    if (Number(p.saldo) > 0) {
        extra.push('<button class="vlg-mini success" data-acc="pagar-items" type="button" title="Pagar prendas (una o todas)"><i class="fas fa-money-bill-wave"></i> Pagar</button>');
    }

    return `
        <article class="vlg-card${alerta ? ' con-alerta' : ''}" data-p="${escapeHtml(p.proceso_id)}">
            <header class="vlg-cab">
                <div class="vlg-quien">
                    <span class="vlg-nick">@${escapeHtml(c.tiktok_user || '?')}</span>
                    ${c.nombre_real ? `<span class="vlg-nombre">${escapeHtml(c.nombre_real)}</span>` : ''}
                </div>
                <div class="vlg-plata">${plata}</div>
            </header>

            ${etapasHTML(etapa)}
            <div class="vlg-linea">
                <span class="vlg-estado">${escapeHtml(info.label)}</span>
                <span class="vlg-sep">·</span>
                <span>${p.prendas} prenda(s)</span>
                <span class="vlg-sep">·</span>
                <span>${escapeHtml(contacto)}</span>
            </div>

            ${alerta ? `<div class="vlg-alerta">⚠️ ${escapeHtml(alerta.detalle || 'Posible soltar prenda')}</div>` : ''}

            <div class="vlg-puntos">
                ${ORDEN_PUNTOS.map(k => chipPunto(k, puntos[k], puntos)).join('')}
            </div>

            <footer class="vlg-pie">
                <div class="vlg-pie-nota">${alerta ? 'Decide: liberar o bloquear' : ''}</div>
                <div class="vlg-acc">
                    ${extra.join('')}
                    ${c.tiktok_user ? '<button class="vlg-mini" data-acc="chat" type="button" title="Ver chat"><i class="fas fa-comments"></i></button>' : ''}
                    <button class="vlg-mini" data-acc="ficha" type="button" title="Ficha del cliente"><i class="fas fa-id-card"></i></button>
                    ${alerta ? '<button class="vlg-mini danger" data-acc="liberar" type="button" title="Liberar prenda"><i class="fas fa-unlock"></i></button>' : ''}
                    <button class="vlg-mini danger" data-acc="bloquear" type="button" title="Bloquear y borrar usuario"><i class="fas fa-user-slash"></i></button>
                    ${pasoHTML(g)}
                </div>
            </footer>
        </article>`;
}

function pintar(cont) {
    if (!_procesos.length) {
        cont.innerHTML = '<div class="vl-empty">Sin procesos activos 🎉 Todo al día.</div>';
        return;
    }
    const conAlerta = _procesos.filter(p => p.alerta).length;
    cont.innerHTML = `
        <div class="vlg-cab-lista">
            <div class="vlg-count">${_procesos.length} proceso(s) activo(s)${
                conAlerta ? ` · <span class="vlg-count-alerta">⚠️ ${conAlerta} con posible soltar prenda</span>` : ''
            }</div>
            <div class="vlg-leyenda">Toca un punto para corregirlo · ordenado por urgencia</div>
        </div>
        <div class="vlg-lista">${_procesos.map(tarjetaHTML).join('')}</div>`;

    cont.querySelectorAll('.vlg-card').forEach(card => {
        const p = _procesos.find(x => String(x.proceso_id) === String(card.dataset.p));
        if (!p) return;

        card.querySelectorAll('.vlg-punto').forEach(b => {
            b.addEventListener('click', () => {
                const key = b.dataset.punto;
                modalPunto(p, key, (p.puntos || {})[key], refrescarDiagrama);
            });
        });

        card.querySelectorAll('button[data-acc]').forEach(b => {
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                const acc = b.dataset.acc;
                if (acc === 'ficha') {
                    if (typeof window.__vlIrAFicha === 'function') window.__vlIrAFicha(p.cliente.cliente_id);
                    return;
                }
                if (acc === 'chat') { abrirChatDeUsuario(p.cliente.tiktok_user); return; }
                if (acc === 'liberar') { modalLiberarItems(p, refrescarDiagrama); return; }
                if (acc === 'pagar-items') { modalPagarItems(p, refrescarDiagrama); return; }
                if (acc === 'bloquear') { modalBloquearBorrar(p.cliente, refrescarDiagrama); return; }
                if (acc === 'pago') { modalConfirmarPago(p, refrescarDiagrama); return; }
                if (acc === 'presencial') {
                    modalPagaraPresencial(p, refrescarDiagrama);
                    return;
                }
                if (acc === 'decision') { modalDecisionEntrega(p, refrescarDiagrama); return; }
                if (acc === 'crear-envio') { modalCrearEnvio(p, refrescarDiagrama); return; }
                if (acc === 'entregado') { modalMarcarEntregado(p, refrescarDiagrama); return; }
                if (acc === 'espera-pago') {
                    vlApi.marcarEsperandoPago(p.proceso_id).then(r => {
                        if (!r.ok) { mostrarToast(r.error || 'No se pudo actualizar', 'error'); return; }
                        mostrarToast('Cliente en espera de pago', 'success');
                        refrescarDiagrama();
                    });
                }
            });
        });
    });
}
