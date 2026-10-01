// ventas-live/ui/accionesProceso.js
// Modales de acción sobre un proceso activo, compartidos por las
// vistas Procesos y Clientes. Cada acción llama a su RPC y avisa con
// onDone() para que la vista refresque.

import { vlApi, ESTADO_INFO } from '../domain/vlApi.js';
import { abrirModal, cerrarModal } from './vlModales.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { formatearDinero, escapeHtml } from '../../shared/infrastructure/formatters.js';

const EMPRESAS = [
    { v: 'blue_express', l: 'Blue Express' },
    { v: 'paket', l: 'Paket' },
    { v: 'chilexpress', l: 'Chilexpress' },
    { v: 'starken', l: 'Starken' },
    { v: 'otra', l: 'Otra' }
];

function estadoLabel(estado) {
    return (ESTADO_INFO[estado] || {}).label || estado;
}

function parseMonto(raw) {
    const n = Number(String(raw || '').replace(/[^\d]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------- Confirmar pago (completo / parcial / presencial) ----------
export function modalConfirmarPago(proceso, onDone) {
    const saldo = Number(proceso.saldo || 0);
    const nick = proceso.cliente ? proceso.cliente.tiktok_user : 'cliente';
    abrirModal({
        titulo: '💳 Confirmar pago — @' + escapeHtml(nick),
        sub: 'Saldo pendiente: <b>' + formatearDinero(saldo) + '</b> · ' + estadoLabel(proceso.estado),
        html: `
            <div class="vl-form-row">
                <label for="vp-monto">Monto recibido</label>
                <input class="vl-control vl-monto-grande" id="vp-monto" inputmode="numeric" value="${saldo}">
                <div style="font-size:0.75rem;color:var(--muted,#adb5bd);margin-top:5px;">
                    Completo = el saldo exacto. Si recibes menos, quedará como <b>pago parcial</b>.
                </div>
            </div>
            <div class="vl-form-row">
                <label for="vp-metodo">Método</label>
                <select class="vl-control" id="vp-metodo">
                    <option value="transferencia">Transferencia</option>
                    <option value="efectivo">Efectivo</option>
                    <option value="otro">Otro</option>
                </select>
            </div>
            <div class="vl-form-row">
                <label for="vp-nota">Nota (opcional)</label>
                <input class="vl-control" id="vp-nota" placeholder="Ej: comprobante N°1234">
            </div>
            <div class="vl-modal-actions">
                <button class="vl-btn" id="vp-cancelar" type="button">Cancelar</button>
                <button class="vl-btn success" id="vp-ok" type="button"><i class="fas fa-check-circle"></i> Confirmar pago</button>
            </div>`,
        onMount: (modal, { marcarSucio }) => {
            const montoEl = modal.querySelector('#vp-monto');
            const metodoEl = modal.querySelector('#vp-metodo');
            const notaEl = modal.querySelector('#vp-nota');
            [montoEl, metodoEl, notaEl].forEach(el => el.addEventListener('input', marcarSucio));
            montoEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
            modal.querySelector('#vp-cancelar').addEventListener('click', () => cerrarModal(true));
            modal.querySelector('#vp-ok').addEventListener('click', ok);
            montoEl.focus();
            montoEl.select();
            async function ok() {
                const monto = parseMonto(montoEl.value);
                if (!monto) { mostrarToast('Monto inválido', 'warning'); return; }
                if (monto > saldo) { mostrarToast('El monto supera el saldo pendiente (' + formatearDinero(saldo) + ')', 'warning'); return; }
                const btn = modal.querySelector('#vp-ok');
                btn.disabled = true;
                const res = await vlApi.confirmarPago(proceso.proceso_id, monto, metodoEl.value, notaEl.value.trim());
                btn.disabled = false;
                if (!res.ok) { mostrarToast(res.error || 'No se pudo confirmar', 'error'); return; }
                cerrarModal(true);
                mostrarToast('Pago de ' + formatearDinero(monto) + ' registrado', 'success');
                onDone();
            }
        }
    });
}

// ---------- Pagará presencialmente ----------
export function modalPagaraPresencial(proceso, onDone) {
    const nick = proceso.cliente ? proceso.cliente.tiktok_user : 'cliente';
    abrirModal({
        titulo: '🤝 Pagará presencialmente — @' + escapeHtml(nick),
        sub: 'El cliente pagará cuando reciba sus prendas. El saldo sigue pendiente.',
        html: `
            <div style="background:rgba(120,180,255,0.08);border:1px solid rgba(120,180,255,0.3);border-radius:12px;padding:12px 14px;color:#a5d8ff;font-size:0.88rem;line-height:1.5;">
                Saldo: <b>${formatearDinero(proceso.saldo)}</b> · al confirmar el pago en la entrega, el proceso pasará a "entrega presencial".
            </div>
            <div class="vl-modal-actions">
                <button class="vl-btn" id="vp-cancelar" type="button">Cancelar</button>
                <button class="vl-btn primary" id="vp-ok" type="button"><i class="fas fa-handshake"></i> Marcar: pagará presencial</button>
            </div>`,
        onMount: (modal) => {
            modal.querySelector('#vp-cancelar').addEventListener('click', () => cerrarModal(true));
            modal.querySelector('#vp-ok').addEventListener('click', async () => {
                const btn = modal.querySelector('#vp-ok');
                btn.disabled = true;
                const res = await vlApi.marcarPagaraPresencial(proceso.proceso_id);
                btn.disabled = false;
                if (!res.ok) { mostrarToast(res.error || 'No se pudo actualizar', 'error'); return; }
                cerrarModal(true);
                mostrarToast('Cliente marcado: pagará presencialmente', 'success');
                onDone();
            });
        }
    });
}

// ---------- Decisión de entrega post-pago (spec §15) ----------
export function modalDecisionEntrega(proceso, onDone) {
    const nick = proceso.cliente ? proceso.cliente.tiktok_user : 'cliente';
    const opciones = [
        { v: 'enviar_ahora', icono: '🚚', l: 'Quiero envío / entrega ahora', extra: true },
        { v: 'fecha', icono: '📅', l: 'Quiero envío en una fecha específica', extra: true },
        { v: 'despues', icono: '🤔', l: 'Todavía no sé cuándo' },
        { v: 'acumular', icono: '🛍️', l: 'Quiero seguir acumulando prendas en futuros LIVE' }
    ];
    let sel = 'acumular';
    abrirModal({
        titulo: '📦 Decisión de entrega — @' + escapeHtml(nick),
        sub: 'El proceso está pagado (' + (proceso.prendas || 0) + ' prenda(s) en bolsa). ¿Qué hace el cliente con sus prendas?',
        html: `
            <div class="vl-opciones" id="vd-opciones">
                ${opciones.map((o, i) => `
                    <div class="vl-opcion ${i === 3 ? 'sel' : ''}" data-v="${o.v}" role="button" tabindex="0">
                        <span style="font-size:1.15rem;">${o.icono}</span> ${o.l}
                    </div>`).join('')}
            </div>
            <div id="vd-extra" style="display:none;margin-top:12px;">
                <div class="vl-form-row" id="vd-tipo-row" style="display:none;">
                    <label for="vd-tipo">Tipo de entrega</label>
                    <select class="vl-control" id="vd-tipo">
                        <option value="envio">Envío</option>
                        <option value="presencial">Entrega presencial</option>
                    </select>
                </div>
                <div class="vl-form-row" id="vd-fecha-row" style="display:none;">
                    <label for="vd-fecha">Fecha del envío</label>
                    <input class="vl-control" id="vd-fecha" type="date">
                </div>
            </div>
            <div class="vl-modal-actions">
                <button class="vl-btn" id="vd-cancelar" type="button">Cancelar</button>
                <button class="vl-btn primary" id="vd-ok" type="button"><i class="fas fa-check"></i> Guardar decisión</button>
            </div>`,
        onMount: (modal, { marcarSucio }) => {
            const opcionesEl = modal.querySelectorAll('.vl-opcion');
            const extra = modal.querySelector('#vd-extra');
            const tipoRow = modal.querySelector('#vd-tipo-row');
            const fechaRow = modal.querySelector('#vd-fecha-row');
            const fechaEl = modal.querySelector('#vd-fecha');
            const tipoEl = modal.querySelector('#vd-tipo');

            function pintar() {
                opcionesEl.forEach(o => o.classList.toggle('sel', o.dataset.v === sel));
                const o = opciones.find(x => x.v === sel);
                extra.style.display = o && o.extra ? 'block' : 'none';
                tipoRow.style.display = (o && o.extra && sel === 'enviar_ahora') ? 'block' : 'none';
                fechaRow.style.display = (sel === 'fecha') ? 'block' : 'none';
            }
            opcionesEl.forEach(o => {
                o.addEventListener('click', () => { sel = o.dataset.v; marcarSucio(); pintar(); });
                o.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') { sel = o.dataset.v; marcarSucio(); pintar(); }
                });
            });
            fechaEl.addEventListener('input', marcarSucio);
            tipoEl.addEventListener('change', marcarSucio);
            modal.querySelector('#vd-cancelar').addEventListener('click', () => cerrarModal(true));
            modal.querySelector('#vd-ok').addEventListener('click', ok);
            pintar();

            async function ok() {
                const fecha = sel === 'fecha' ? fechaEl.value || null : null;
                if (sel === 'fecha' && !fecha) { mostrarToast('Elige la fecha del envío', 'warning'); return; }
                const tipo = sel === 'enviar_ahora' ? tipoEl.value : 'envio';
                const btn = modal.querySelector('#vd-ok');
                btn.disabled = true;
                const res = await vlApi.decidirEntrega(proceso.proceso_id, sel, fecha, tipo);
                btn.disabled = false;
                if (!res.ok) { mostrarToast(res.error || 'No se pudo guardar', 'error'); return; }
                cerrarModal(true);
                mostrarToast('Decisión guardada', 'success');
                onDone();
            }
        }
    });
}

// ---------- Marcar ENVÍO CREADO (spec §22) ----------
export function modalCrearEnvio(proceso, onDone) {
    const nick = proceso.cliente ? proceso.cliente.tiktok_user : 'cliente';
    const envio = proceso.envio || {};
    abrirModal({
        titulo: '🚚 Envío creado — @' + escapeHtml(nick),
        sub: 'Completaste el envío en la empresa de transporte. Registralo acá.',
        html: `
            ${envio.fecha_programada ? `<div style="font-size:0.85rem;color:#ced4da;margin-bottom:10px;">Fecha programada: <b>${envio.fecha_programada}</b></div>` : ''}
            <div class="vl-form-row">
                <label for="ve-empresa">Empresa</label>
                <select class="vl-control" id="ve-empresa">
                    ${EMPRESAS.map(e => `<option value="${e.v}">${e.l}</option>`).join('')}
                </select>
            </div>
            <div class="vl-form-row">
                <label for="ve-tracking">Número de seguimiento (opcional)</label>
                <input class="vl-control" id="ve-tracking" placeholder="Ej: 1234567890">
            </div>
            <div class="vl-modal-actions">
                <button class="vl-btn" id="ve-cancelar" type="button">Cancelar</button>
                <button class="vl-btn success" id="ve-ok" type="button"><i class="fas fa-truck-fast"></i> Marcar ENVÍO CREADO</button>
            </div>`,
        onMount: (modal, { marcarSucio }) => {
            const empresaEl = modal.querySelector('#ve-empresa');
            const trackingEl = modal.querySelector('#ve-tracking');
            if (envio.empresa) empresaEl.value = envio.empresa;
            if (envio.tracking) trackingEl.value = envio.tracking;
            [empresaEl, trackingEl].forEach(el => el.addEventListener('input', marcarSucio));
            modal.querySelector('#ve-cancelar').addEventListener('click', () => cerrarModal(true));
            modal.querySelector('#ve-ok').addEventListener('click', ok);
            trackingEl.focus();
            async function ok() {
                const btn = modal.querySelector('#ve-ok');
                btn.disabled = true;
                const res = await vlApi.crearEnvio(proceso.proceso_id, empresaEl.value, trackingEl.value.trim());
                btn.disabled = false;
                if (!res.ok) { mostrarToast(res.error || 'No se pudo registrar', 'error'); return; }
                cerrarModal(true);
                mostrarToast('Envío en proceso', 'success');
                onDone();
            }
        }
    });
}

// ---------- Marcar entregado / completado ----------
export function modalMarcarEntregado(proceso, onDone) {
    const nick = proceso.cliente ? proceso.cliente.tiktok_user : 'cliente';
    abrirModal({
        titulo: '✅ Marcar entregado — @' + escapeHtml(nick),
        sub: 'Se entregaron las prendas. El proceso quedará como COMPLETADO.',
        html: `
            <div style="background:rgba(0,184,148,0.08);border:1px solid rgba(0,184,148,0.3);border-radius:12px;padding:12px 14px;color:#7ff5d8;font-size:0.88rem;">
                <b>${proceso.prendas || 0}</b> prenda(s) en este proceso · saldo pendiente: <b>${formatearDinero(proceso.saldo)}</b>
            </div>
            <div class="vl-modal-actions">
                <button class="vl-btn" id="vg-cancelar" type="button">Cancelar</button>
                <button class="vl-btn success" id="vg-ok" type="button"><i class="fas fa-check-circle"></i> Sí, marcar entregado</button>
            </div>`,
        onMount: (modal) => {
            modal.querySelector('#vg-cancelar').addEventListener('click', () => cerrarModal(true));
            modal.querySelector('#vg-ok').addEventListener('click', async () => {
                const btn = modal.querySelector('#vg-ok');
                btn.disabled = true;
                const res = await vlApi.marcarEntregado(proceso.proceso_id);
                btn.disabled = false;
                if (!res.ok) { mostrarToast(res.error || 'No se pudo completar', 'error'); return; }
                cerrarModal(true);
                mostrarToast('Proceso completado ✔', 'success');
                onDone();
            });
        }
    });
}

// ---------- Puntos del diagrama: etiquetas ----------
// Nombre de cada punto del proceso (chips del diagrama).
export const PUNTO_LABEL = {
    region:  'Región',
    entrega: 'Entrega',
    courier: 'Courier',
    pago:    'Pago',
    fecha:   'Fecha'
};

// Texto legible del valor actual de un punto (para el chip).
export const PUNTO_VALOR_LABEL = {
    santiago:   'Santiago (RM)',
    region:     'Región',
    envio:      'Envío',
    presencial: 'Presencial',
    blue:       'Blue Express',
    paket:      'Paket',
    pagado:     'Pagado',
    parcial:    'Pago parcial',
    sin_pagar:  'Sin pagar',
    sin_pedido: 'Sin pedido'
};

// ---------- Cambiar un punto del diagrama (a mano) ----------
// region / entrega / courier → lista de opciones
// pago   → abre el modal de confirmar pago (necesita monto)
// fecha  → pide la fecha del envío
export function modalPunto(proceso, puntoKey, punto, onDone) {
    const nick = proceso.cliente ? proceso.cliente.tiktok_user : 'cliente';
    const titulo = PUNTO_LABEL[puntoKey] || puntoKey;

    if (puntoKey === 'pago') {
        const valor = (punto && punto.valor) || 'sin_pagar';
        abrirModal({
            titulo: '💳 Pago — @' + escapeHtml(nick),
            sub: 'Cómo está el pago de este pedido. Para registrar plata se abre el detalle.',
            html: `
                <div class="vl-opciones" id="vpu-opciones">
                    ${[
                        { v: 'pagado',    l: '✅ Pagado (registrar el pago completo)' },
                        { v: 'parcial',   l: '🟣 Pago parcial (registrar un abono)' },
                        { v: 'sin_pagar', l: '🟠 Sin pagar (queda esperando pago)' }
                    ].map(o => `
                        <div class="vl-opcion${o.v === valor ? ' sel' : ''}" data-v="${o.v}" role="button" tabindex="0">
                            ${o.l}
                        </div>`).join('')}
                </div>
                <div class="vl-modal-actions">
                    <button class="vl-btn" id="vpu-cancelar" type="button">Cancelar</button>
                </div>`,
            onMount: (modal) => {
                modal.querySelector('#vpu-cancelar').addEventListener('click', () => cerrarModal(true));
                modal.querySelectorAll('#vpu-opciones .vl-opcion').forEach(op => {
                    const elegir = async () => {
                        const v = op.dataset.v;
                        if (v === 'pagado' || v === 'parcial') {
                            cerrarModal(true);
                            modalConfirmarPago(proceso, onDone);
                            return;
                        }
                        const res = await vlApi.marcarEsperandoPago(proceso.proceso_id);
                        if (!res.ok) { mostrarToast(res.error || 'No se pudo actualizar', 'error'); return; }
                        cerrarModal(true);
                        mostrarToast('Marcado: sin pagar', 'success');
                        onDone();
                    };
                    op.addEventListener('click', elegir);
                    op.addEventListener('keydown', (e) => { if (e.key === 'Enter') elegir(); });
                });
            }
        });
        return;
    }

    if (puntoKey === 'fecha') {
        const actual = (punto && punto.valor) || '';
        abrirModal({
            titulo: '📅 Fecha — @' + escapeHtml(nick),
            sub: 'Día en que se entrega o se envía el pedido.',
            html: `
                <div class="vl-form-row">
                    <label for="vpu-fecha">Fecha</label>
                    <input class="vl-control" id="vpu-fecha" type="date" value="${escapeHtml(actual)}">
                </div>
                <div class="vl-modal-actions">
                    <button class="vl-btn" id="vpu-cancelar" type="button">Cancelar</button>
                    <button class="vl-btn" id="vpu-quitar" type="button">Quitar fecha</button>
                    <button class="vl-btn primary" id="vpu-ok" type="button"><i class="fas fa-check"></i> Guardar</button>
                </div>`,
            onMount: (modal, { marcarSucio }) => {
                const fechaEl = modal.querySelector('#vpu-fecha');
                fechaEl.addEventListener('input', marcarSucio);
                modal.querySelector('#vpu-cancelar').addEventListener('click', () => cerrarModal(true));
                modal.querySelector('#vpu-ok').addEventListener('click', async () => {
                    if (!fechaEl.value) { mostrarToast('Elige una fecha', 'warning'); return; }
                    const btn = modal.querySelector('#vpu-ok');
                    btn.disabled = true;
                    const res = await vlApi.procesoPuntoSet(proceso.proceso_id, 'fecha', '', fechaEl.value);
                    btn.disabled = false;
                    if (!res.ok) { mostrarToast(res.error || 'No se pudo guardar', 'error'); return; }
                    cerrarModal(true);
                    mostrarToast('Fecha guardada', 'success');
                    onDone();
                });
                modal.querySelector('#vpu-quitar').addEventListener('click', async () => {
                    modal.querySelector('#vpu-quitar').disabled = true;
                    const res = await vlApi.procesoPuntoSet(proceso.proceso_id, 'fecha', '', null);
                    if (!res.ok) { mostrarToast(res.error || 'No se pudo quitar', 'error'); return; }
                    cerrarModal(true);
                    mostrarToast('Fecha quitada', 'success');
                    onDone();
                });
            }
        });
        return;
    }

    // region / entrega / courier → lista de opciones
    const opciones = (punto && punto.opciones) || [];
    const valorActual = (punto && punto.valor) || '';
    abrirModal({
        titulo: '📍 ' + escapeHtml(titulo) + ' — @' + escapeHtml(nick),
        sub: 'Elige el valor correcto. Se guarda al instante.',
        html: `
            <div class="vl-opciones" id="vpu-opciones">
                ${opciones.map(o => `
                    <div class="vl-opcion${o.v === valorActual ? ' sel' : ''}" data-v="${o.v}" role="button" tabindex="0">
                        ${escapeHtml(o.l)}
                    </div>`).join('')}
            </div>
            <div class="vl-modal-actions">
                <button class="vl-btn" id="vpu-cancelar" type="button">Cancelar</button>
                ${valorActual ? `<button class="vl-btn" id="vpu-quitar" type="button">Dejar en blanco</button>` : ''}
            </div>`,
        onMount: (modal) => {
            modal.querySelector('#vpu-cancelar').addEventListener('click', () => cerrarModal(true));
            const aplicar = async (v) => {
                const res = await vlApi.procesoPuntoSet(proceso.proceso_id, puntoKey, v, null);
                if (!res.ok) { mostrarToast(res.error || 'No se pudo guardar', 'error'); return; }
                cerrarModal(true);
                // La regla del negocio puede haber movido el courier solo
                const auto = res.data && res.data.courier_auto;
                if (auto) {
                    mostrarToast('Región guardada · courier → ' + (PUNTO_VALOR_LABEL[auto] || auto)
                        + ' (regla: Región = Blue · Santiago = Paket)', 'success');
                } else if (res.data && res.data.aviso) {
                    mostrarToast(res.data.aviso, 'warning');
                } else {
                    mostrarToast(titulo + ' actualizado', 'success');
                }
                onDone();
            };
            modal.querySelectorAll('#vpu-opciones .vl-opcion').forEach(op => {
                const elegir = () => aplicar(op.dataset.v);
                op.addEventListener('click', elegir);
                op.addEventListener('keydown', (e) => { if (e.key === 'Enter') elegir(); });
            });
            const quitar = modal.querySelector('#vpu-quitar');
            if (quitar) quitar.addEventListener('click', () => aplicar(''));
        }
    });
}

// ---------- Bloquear usuario y borrar sus datos (DESTRUCTIVO) ----------
// Pedido del dueño: tras decidir (p. ej. soltar la prenda) puede bloquear al
// usuario y borrar TODO. Sus prendas quedan liberadas y esos montos dejan de
// contar como venta. Doble confirmación: nunca en un solo clic.
export function modalBloquearBorrar(cliente, onDone) {
    const nick = (cliente && cliente.tiktok_user) ? cliente.tiktok_user : 'cliente';
    abrirModal({
        titulo: '🚫 Bloquear y borrar — @' + escapeHtml(nick),
        sub: 'Se borra el usuario completo. No se puede deshacer.',
        html: `
            <div style="background:rgba(230,60,60,0.10);border:1px solid rgba(230,60,60,0.35);border-radius:12px;padding:12px 14px;color:#ffb3b3;font-size:0.88rem;line-height:1.55;">
                Se <b>borra todo el usuario</b>: nombre, WhatsApp, correo, contacto, dirección,
                comuna/ciudad, notas y su conversación de WhatsApp.<br>
                Sus prendas quedan <b>liberadas</b> y el pedido se cierra como
                &laquo;no pagó&raquo;: <b>esos montos dejan de contar como venta</b>.<br>
                La plata que ya estaba pagada sigue contando como recibida (es caja real).
            </div>
            <div style="font-size:0.8rem;color:#adb5bd;margin-top:10px;line-height:1.5;">
                Ojo: como el usuario se borra, si vuelve a comprar en un LIVE aparecerá como
                cliente nuevo (no queda registro de que estaba bloqueado).
            </div>
            <label class="vl-check-item" style="margin-top:12px;">
                <input type="checkbox" id="vbb-confirmo">
                <span style="flex:1;">Entiendo: se borra el usuario y sus prendas quedan liberadas.</span>
            </label>
            <div class="vl-modal-actions">
                <button class="vl-btn" id="vbb-cancelar" type="button">Cancelar</button>
                <button class="vl-btn danger" id="vbb-ok" type="button" disabled><i class="fas fa-user-slash"></i> Bloquear y borrar</button>
            </div>`,
        onMount: (modal) => {
            const chk = modal.querySelector('#vbb-confirmo');
            const ok = modal.querySelector('#vbb-ok');
            chk.addEventListener('change', () => { ok.disabled = !chk.checked; });
            modal.querySelector('#vbb-cancelar').addEventListener('click', () => cerrarModal(true));
            ok.addEventListener('click', async () => {
                if (!chk.checked) return;
                if (!window.confirm('Última confirmación: ¿borrar por completo a @' + nick + ', liberar sus prendas y cerrar su pedido? Esta acción no se puede deshacer.')) return;
                ok.disabled = true;
                const res = await vlApi.clienteBloquearBorrar(cliente.cliente_id);
                if (!res.ok) { mostrarToast(res.error || 'No se pudo bloquear', 'error'); ok.disabled = false; return; }
                cerrarModal(true);
                const d = res.data || {};
                mostrarToast('@' + nick + ' borrado · ' + (d.prendas_liberadas || 0)
                    + ' prenda(s) liberada(s) · ya no cuenta como venta', 'success');
                if (typeof onDone === 'function') onDone();
            });
        }
    });
}

export async function modalLiberarItems(proceso, onDone) {
    const nick = proceso.cliente ? proceso.cliente.tiktok_user : 'cliente';
    // Necesita las prendas adjudicadas: las pide a la ficha
    const ficha = await vlApi.fichaCliente(proceso.cliente.cliente_id);
    const pa = ficha.ok && ficha.data.proceso_activo ? ficha.data.proceso_activo : null;
    const items = (pa && pa.items || []).filter(i => i.estado === 'adjudicada' && Number(i.abonado) === 0);
    if (!items.length) {
        mostrarToast('No hay prendas sin pagar para liberar', 'warning');
        return;
    }
    abrirModal({
        titulo: '🔴 Liberar prendas — @' + escapeHtml(nick),
        sub: 'El cliente no concretó. Las prendas marcadas salen de su bolsa, quedan en el historial como liberadas y <b>no cuentan como venta</b> en Finanzas.',
        html: `
            <div id="vl-li-items">
                ${items.map(i => `
                    <label class="vl-check-item">
                        <input type="checkbox" value="${i.id}" checked>
                        <span style="flex:1;">${i.descripcion ? escapeHtml(i.descripcion) : 'Prenda'}</span>
                        <b>${formatearDinero(i.precio)}</b>
                    </label>`).join('')}
            </div>
            <div class="vl-form-row" style="margin-top:10px;">
                <label for="vl-li-nota">Motivo (opcional, queda en las notas del cliente)</label>
                <input class="vl-control" id="vl-li-nota" placeholder="Ej: nunca contactó por WhatsApp">
            </div>
            <div class="vl-modal-actions">
                <button class="vl-btn" id="vl-li-cancelar" type="button">Cancelar</button>
                <button class="vl-btn danger" id="vl-li-ok" type="button"><i class="fas fa-unlock"></i> Liberar seleccionadas</button>
            </div>`,
        onMount: (modal, { marcarSucio }) => {
            const notaEl = modal.querySelector('#vl-li-nota');
            notaEl.addEventListener('input', marcarSucio);
            modal.querySelector('#vl-li-cancelar').addEventListener('click', () => cerrarModal(true));
            modal.querySelector('#vl-li-ok').addEventListener('click', ok);
            async function ok() {
                const ids = Array.from(modal.querySelectorAll('#vl-li-items input:checked')).map(c => c.value);
                if (!ids.length) { mostrarToast('Selecciona al menos una prenda', 'warning'); return; }
                if (!window.confirm('¿Liberar ' + ids.length + ' prenda(s)? Esta acción no se puede deshacer.')) return;
                const btn = modal.querySelector('#vl-li-ok');
                btn.disabled = true;
                const res = await vlApi.liberarItems(proceso.proceso_id, ids, notaEl.value.trim());
                btn.disabled = false;
                if (!res.ok) { mostrarToast(res.error || 'No se pudo liberar', 'error'); return; }
                cerrarModal(true);
                mostrarToast('Prendas liberadas', 'success');
                onDone();
            }
        }
    });
}
