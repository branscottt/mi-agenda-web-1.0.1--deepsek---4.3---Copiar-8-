// services/ui/ServiceChat.js
// ============================================================
// "Crea tu servicio conversando" — asistente conversacional para
// CREAR servicios (admin.html, sección crear-servicio).
//
// Reglas de diseño (acordadas con el dueño):
//  - El chat es SOLO para crear. Editar sigue en el formulario normal.
//  - Máx ~9 interacciones; se escribe SOLO el nombre y los precios.
//  - Botón "modo formulario completo" siempre disponible.
//  - Resumen en vivo "Así está quedando tu servicio" (se rellena solo).
//  - Al publicar NO duplica la lógica de guardado: rellena el estado
//    REAL del formulario legacy (selectedDates + window.serviceModules
//    + inputs) y dispara requestSubmit() → crearServicio() legacy con
//    TODAS sus validaciones (gate de suscripción, trabajadores, promos).
// ============================================================

const MAX_FECHAS = 210; // tope de seguridad para el payload de disponibilidad
const CLP = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-CL');

function hoyISO() {
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function sumarMesesClamp(fechaISO, meses) {
    const [y, m, d] = fechaISO.split('-').map(Number);
    const ultimo = new Date(y, m, 0).getDate(); // días del mes base (m es 1-based)
    const dia = Math.min(d, ultimo);
    const fin = new Date(y, m - 1 + meses, dia);
    const p = (x) => String(x).padStart(2, '0');
    return `${fin.getFullYear()}-${p(fin.getMonth() + 1)}-${p(fin.getDate())}`;
}

function fmtLocal(d) {
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Días de la semana incluidos según la respuesta del chat.
// getDay(): 0=Dom .. 6=Sáb. El checkbox del rango usa value 0=Dom..6=Sáb (admin.html L501-507).
function diasDeRespuesta(resp) {
    if (resp === 'finde') return [0, 6];
    if (resp === 'laborables') return [1, 2, 3, 4, 5];
    return [0, 1, 2, 3, 4, 5, 6]; // 'todos'
}

// Fechas reales que generará generarFechasPorRango (rango + días elegidos).
// Se itera con MEDIODÍA local (T12) y no con medianoche: al cruzar un
// cambio de hora (Chile: 00:00→01:00 del primer sábado de septiembre),
// setDate() desde las 00:00 queda desfasado +1h y el último día del rango
// se pierde. A las 12:00 el reloj nunca salta (mismo fix que el legacy).
function calcularFechas(dias, meses) {
    const inicio = hoyISO();
    const fin = sumarMesesClamp(inicio, meses);
    const out = [];
    const d = new Date(inicio + 'T12:00:00');
    const end = new Date(fin + 'T12:00:00');
    while (d <= end) {
        if (dias.includes(d.getDay())) {
            out.push(fmtLocal(d));
        }
        d.setDate(d.getDate() + 1);
        if (out.length > MAX_FECHAS) break;
    }
    return out;
}

function horaAMin(hhmm) {
    const p = String(hhmm || '0').split(':').map(Number);
    return (p[0] || 0) * 60 + (p[1] || 0);
}

function minAHora(min) {
    const p = (x) => String(x).padStart(2, '0');
    return `${p(Math.floor(min / 60))}:${p(min % 60)}`;
}

// Bloques consecutivos de `durMin` desde inicio hasta fin (modo 'all').
function generarBloques(inicio, fin, durMin) {
    const bloques = [];
    let t = horaAMin(inicio);
    const finMin = horaAMin(fin);
    while (t + durMin <= finMin) {
        bloques.push({
            startTime: minAHora(t),
            endTime: minAHora(t + durMin),
            duration: durMin,
            cupos: 1,
            editable: true
        });
        t += durMin;
    }
    return bloques;
}

let _state = null;
let _el = null; // referencias DOM del modal
let _publicando = false;

const DIAS_LABEL = { laborables: 'Lun a Vie', finde: 'Sáb y Dom', todos: 'Todos los días' };
const VIGENCIA_LABEL = { 1: '1 mes', 3: '3 meses', 6: '6 meses' };

// ============================================================
// Inicialización: botón junto a "Ver tutorial"
// ============================================================
export function initServicioChat() {
    const header = document.getElementById('section-title-servicio');
    if (!header) return;

    // El botón "Ver tutorial" vive en .section-header-flex (lo crea ServiceForm.js).
    let headerFlex = header.closest('.section-header-flex');
    if (!headerFlex) {
        headerFlex = document.createElement('div');
        headerFlex.className = 'section-header-flex';
        header.parentNode.insertBefore(headerFlex, header);
        headerFlex.appendChild(header);
    }

    if (document.getElementById('btn-servicio-chat')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'btn-servicio-chat';
    btn.className = 'tutorial-btn svcchat-open-btn';
    btn.innerHTML = '<i class="fas fa-comments"></i> Crear conversando';
    btn.addEventListener('click', abrirChat);
    headerFlex.appendChild(btn);
}

// ============================================================
// Apertura / cierre del modal
// ============================================================
async function abrirChat() {
    if (_publicando) return;
    if (!_el) construirModal();

    // Si venía de una edición, el chat crea un servicio NUEVO: descartar edición.
    const submitBtn = document.querySelector('#service-form button[type="submit"]');
    const editando = submitBtn && /guardar|guardando/i.test(submitBtn.textContent);
    if (editando) {
        const ok = window.confirm('Estás editando un servicio. El chat crea uno NUEVO y descarta esa edición. ¿Continuar?');
        if (!ok) return;
    }
    // Estado del form en blanco (rutea el submit a crearServicio, no a actualizarServicio).
    if (typeof window.limpiarEstadoEdicion === 'function') window.limpiarEstadoEdicion();

    _state = estadoInicial();
    _el.modal.hidden = false;
    document.body.classList.add('svcchat-abierto');
    _el.conv.innerHTML = '';
    pintarBienvenida();
}

function cerrarChat() {
    if (!_el) return;
    _el.modal.hidden = true;
    document.body.classList.remove('svcchat-abierto');
}

function preguntarAntesDeCerrar() {
    if (!_state || _publicando) return;
    const respondido = _state.nombre || _state.paso > 0;
    if (respondido && !window.confirm('¿Descartar el servicio que estabas creando en el chat?')) return;
    cerrarChat();
}

function estadoInicial() {
    return {
        paso: 0,
        nombre: '',
        modalidad: 'sesion',      // 'sesion' | 'promocion'
        numSesiones: 8,
        precioSesion: null,
        precioPack: null,          // null = usar sugerido
        duracion: 60,
        dias: 'todos',
        horaInicio: '09:00',
        horaFin: '18:00',
        cupos: 1,
        vigenciaMeses: 3
    };
}

// ============================================================
// DOM del modal (CSP-safe: listeners, sin handlers inline)
// ============================================================
function construirModal() {
    const modal = document.createElement('div');
    modal.id = 'svcchat-modal';
    modal.className = 'svcchat-modal';
    modal.hidden = true;
    modal.innerHTML = `
        <div class="svcchat-backdrop" data-svcchat-cerrar="1"></div>
        <div class="svcchat-panel" role="dialog" aria-modal="true" aria-label="Crear servicio conversando">
            <div class="svcchat-head">
                <div class="svcchat-head-titulo">
                    <span class="svcchat-av">💬</span>
                    <div>
                        <h4>Crea tu servicio conversando</h4>
                        <p>Te hago unas preguntas cortas y lo dejamos listo.</p>
                    </div>
                </div>
                <div class="svcchat-head-acciones">
                    <button type="button" class="svcchat-btn-form" id="svcchat-a-form" title="Ver el formulario clásico">
                        <i class="fas fa-list-alt"></i> <span>Modo formulario completo</span>
                    </button>
                    <button type="button" class="svcchat-cerrar" data-svcchat-cerrar="1" title="Cerrar" aria-label="Cerrar">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            </div>
            <div class="svcchat-cuerpo">
                <div class="svcchat-conv" id="svcchat-conv"></div>
                <aside class="svcchat-resumen" id="svcchat-resumen">
                    <div class="svcchat-resumen-titulo"><i class="fas fa-eye"></i> Así está quedando tu servicio</div>
                    <div class="svcchat-resumen-body" id="svcchat-resumen-body"></div>
                </aside>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    _el = {
        modal,
        conv: modal.querySelector('#svcchat-conv'),
        resumen: modal.querySelector('#svcchat-resumen-body'),
        panel: modal.querySelector('.svcchat-panel')
    };

    modal.querySelectorAll('[data-svcchat-cerrar]').forEach(el => {
        el.addEventListener('click', preguntarAntesDeCerrar);
    });
    modal.querySelector('#svcchat-a-form').addEventListener('click', () => {
        if (typeof window.limpiarEstadoEdicion === 'function') window.limpiarEstadoEdicion();
        cerrarChat();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.hidden) preguntarAntesDeCerrar();
    });
}

function scrollAbajo() {
    const conv = _el && _el.conv;
    if (!conv) return;
    requestAnimationFrame(() => { conv.scrollTop = conv.scrollHeight; });
}

// ============================================================
// Burbujas
// ============================================================
function burbujaBot(html, extraCls) {
    const div = document.createElement('div');
    div.className = 'svcchat-burbuja svcchat-bot' + (extraCls ? ' ' + extraCls : '');
    div.innerHTML = html;
    _el.conv.appendChild(div);
    scrollAbajo();
    return div;
}

function burbujaUser(texto) {
    const div = document.createElement('div');
    div.className = 'svcchat-burbuja svcchat-user';
    div.textContent = texto;
    _el.conv.appendChild(div);
    scrollAbajo();
}

function bloqueOpciones(opciones, alElegir) {
    const wrap = document.createElement('div');
    wrap.className = 'svcchat-opciones';
    opciones.forEach(op => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'svcchat-opt' + (op.rec ? ' svcchat-opt-rec' : '') + (op.peligro ? ' svcchat-opt-peligro' : '');
        b.innerHTML = (op.rec ? '<span class="svcchat-badge">Recomendado</span>' : '') +
            `<span class="svcchat-opt-texto">${op.label}</span>` +
            (op.hint ? `<small class="svcchat-opt-hint">${op.hint}</small>` : '');
        b.addEventListener('click', () => alElegir(op.valor, op));
        wrap.appendChild(b);
    });
    _el.conv.appendChild(wrap);
    scrollAbajo();
    return wrap;
}

// Formulario de una línea dentro del chat (input + botón).
function bloqueInput(placeholder, opts, alEnviar) {
    const form = document.createElement('form');
    form.className = 'svcchat-input-row';
    form.innerHTML = `
        <input type="text" class="svcchat-input" placeholder="${placeholder}" autocomplete="off" ${opts.inputmode ? `inputmode="${opts.inputmode}"` : ''}>
        <button type="submit" class="svcchat-btn-enviar"><i class="fas fa-arrow-right"></i></button>
    `;
    const input = form.querySelector('input');
    const validar = opts.validar || ((v) => (v.trim().length ? null : 'Escribe un valor'));
    const btn = form.querySelector('button');
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const err = validar(input.value);
        if (err) {
            input.classList.add('svcchat-input-error');
            input.title = err;
            return;
        }
        input.classList.remove('svcchat-input-error');
        // Historial inerte: tras responder, el input deja de ser editable
        // (evita re-disparar un paso viejo al hacer Enter en burbujas pasadas).
        input.disabled = true;
        btn.disabled = true;
        form.classList.add('svcchat-input-usado');
        alEnviar(input.value.trim());
    });
    input.addEventListener('input', () => input.classList.remove('svcchat-input-error'));
    _el.conv.appendChild(form);
    setTimeout(() => { input.focus(); }, 60);
    scrollAbajo();
    return { form, input, btn };
}

// ============================================================
// Flujo de preguntas
// ============================================================
function pintarBienvenida() {
    burbujaBot(`
        <div class="svcchat-msg-titulo">¡Hola! 👋 Vamos a crear tu servicio.</div>
        <p>Te hago <strong>unas pocas preguntas</strong> y a la derecha verás cómo va quedando.<br>
        Todo se puede editar después desde <strong>Mis Servicios</strong>.</p>
    `);
    pasoNombre();
}

function pasoNombre(preguntaPersonalizada) {
    _state.paso = 1;
    burbujaBot(preguntaPersonalizada || 'Primero lo principal: <strong>¿cómo se llama tu servicio?</strong><br><span class="svcchat-sub">Ej: Entrenamiento de calistenia, Corte + barba, Clase de yoga…</span>');
    bloqueInput('Nombre del servicio', {}, (valor) => {
        if (valor.length < 2) {
            burbujaBot('El nombre debe tener al menos 2 letras 😉');
            return pasoNombre();
        }
        _state.nombre = valor;
        burbujaUser(valor);
        burbujaBot(`<i class="fas fa-mobile-alt"></i> <span class="svcchat-sub">Así lo verá tu cliente cuando reserve:</span><br>
            <span class="svcchat-ejemplo-notif">“Tu turno de <strong>${escapeHtml(valor)}</strong> es mañana a las 18:00”</span>`);
        actualizarResumen();
        pasoModalidad();
    });
}

function pasoModalidad() {
    _state.paso = 2;
    burbujaBot('¿Cómo vas a ofrecerlo?');
    bloqueOpciones([
        { valor: 'sesion', label: 'Sesión suelta', hint: 'El cliente paga por sesión y reserva cuando quiera.' },
        {
            valor: 'promocion', label: 'Pack de N sesiones', rec: true,
            hint: 'Cobras por adelantado y el cliente se compromete a volver.'
        }
    ], (valor) => {
        _state.modalidad = valor;
        burbujaUser(valor === 'promocion' ? 'Pack de N sesiones ⭐' : 'Sesión suelta');
        actualizarResumen();
        if (valor === 'promocion') pasoNumSesiones();
        else pasoPrecio();
    });
}

function pasoNumSesiones() {
    _state.paso = 3;
    burbujaBot('¿Cuántas sesiones incluye el pack?');
    bloqueOpciones([
        { valor: 4, label: '4 sesiones' },
        { valor: 8, label: '8 sesiones', rec: true },
        { valor: 12, label: '12 sesiones' }
    ], (valor) => {
        _state.numSesiones = valor;
        burbujaUser(`${valor} sesiones`);
        pasoPrecio();
    });
}

function pasoPrecio() {
    _state.paso = 4;
    const esPromo = _state.modalidad === 'promocion';
    burbujaBot(esPromo
        ? '¿Cuánto cobras por <strong>una sesión suelta</strong>? (el cliente también podrá pagar el pack completo)'
        : '¿Cuánto cobras por sesión?');
    bloqueInput(esPromo ? 'Precio de la sesión suelta ($)' : 'Precio de la sesión ($)', {
        inputmode: 'numeric',
        validar: (v) => {
            const n = parseFloat(String(v).replace(/[^0-9]/g, ''));
            return (!n || n <= 0) ? 'Ingresa un precio mayor a 0' : null;
        }
    }, (valor) => {
        const n = parseFloat(valor.replace(/[^0-9]/g, ''));
        _state.precioSesion = n;
        burbujaUser(CLP(n));
        if (esPromo) pasoPrecioPack();
        else { actualizarResumen(); pasoDuracion(); }
    });
}

function precioPackSugerido() {
    // 15% de descuento sobre el valor real (N × sesión), redondeado a $100.
    const bruto = (_state.precioSesion || 0) * (_state.numSesiones || 1);
    return Math.max(0, Math.round((bruto * 0.85) / 100) * 100);
}

function pasoPrecioPack() {
    _state.paso = 5;
    const sugerido = precioPackSugerido();
    burbujaBot(`¿Cuánto cuesta el pack de <strong>${_state.numSesiones}</strong>?<br>
        <span class="svcchat-sub">Sugerencia: ${CLP(sugerido)} — con 15% de descuento ganas lo mismo y el cliente paga por adelantado.</span>`);
    bloqueOpciones([
        { valor: 'sugerido', label: `Usar ${CLP(sugerido)} (15% off)`, rec: true },
        { valor: 'otro', label: 'Poner otro precio' }
    ], (valor) => {
        if (valor === 'sugerido') {
            _state.precioPack = sugerido;
            burbujaUser(CLP(sugerido));
            actualizarResumen();
            pasoDuracion();
        } else {
            burbujaUser('Poner otro precio');
            bloqueInput('Precio total del pack ($)', {
                inputmode: 'numeric',
                validar: (v) => {
                    const n = parseFloat(String(v).replace(/[^0-9]/g, ''));
                    return (!n || n <= 0) ? 'Ingresa un precio mayor a 0' : null;
                }
            }, (valor2) => {
                const n2 = parseFloat(valor2.replace(/[^0-9]/g, ''));
                if (n2 >= (_state.precioSesion || 0) * _state.numSesiones) {
                    burbujaBot('Ese precio no tiene descuento: es mayor o igual al valor real de las sesiones sueltas. Mejor usa el sugerido 😉');
                    _state.precioPack = n2;
                    burbujaUser(CLP(n2));
                    actualizarResumen();
                    pasoDuracion();
                    return;
                }
                _state.precioPack = n2;
                burbujaUser(CLP(n2));
                actualizarResumen();
                pasoDuracion();
            });
        }
    });
}

function pasoDuracion() {
    _state.paso = 6;
    burbujaBot('¿Cuánto dura <strong>cada sesión</strong>?');
    bloqueOpciones([
        { valor: 30, label: '30 min' },
        { valor: 45, label: '45 min' },
        { valor: 60, label: '60 min', rec: true },
        { valor: 90, label: '90 min' }
    ], (valor) => {
        _state.duracion = valor;
        burbujaUser(`${valor} min`);
        actualizarResumen();
        pasoDias();
    });
}

function pasoDias() {
    _state.paso = 7;
    burbujaBot('¿Qué días vas a atender este servicio?');
    bloqueOpciones([
        { valor: 'laborables', label: 'Lun a Vie' },
        { valor: 'finde', label: 'Sáb y Dom' },
        { valor: 'todos', label: 'Todos los días', rec: true }
    ], (valor) => {
        _state.dias = valor;
        burbujaUser(DIAS_LABEL[valor]);
        actualizarResumen();
        pasoHorario();
    });
}

function pasoHorario() {
    _state.paso = 8;
    burbujaBot(`¿Entre qué horas vas a atender?<br>
        <span class="svcchat-sub">Se generarán bloques de <strong>${_state.duracion} min</strong> corridos (ej: ${_state.horaInicio} a ${_state.horaFin}). Después puedes ajustarlos en el formulario.</span>`);
    const form = document.createElement('form');
    form.className = 'svcchat-input-row svcchat-horas';
    form.innerHTML = `
        <select class="svcchat-select" id="svcchat-h-ini"></select>
        <span class="svcchat-horas-sep">a</span>
        <select class="svcchat-select" id="svcchat-h-fin"></select>
        <button type="submit" class="svcchat-btn-enviar">Continuar <i class="fas fa-arrow-right"></i></button>
    `;
    const selIni = form.querySelector('#svcchat-h-ini');
    const selFin = form.querySelector('#svcchat-h-fin');
    for (let h = 6; h <= 22; h++) {
        const v = String(h).padStart(2, '0') + ':00';
        const o = new Option(v, v);
        if (v === _state.horaInicio) o.selected = true;
        selIni.appendChild(o);
    }
    for (let h = 7; h <= 23; h++) {
        const v = String(h).padStart(2, '0') + ':00';
        const o = new Option(v, v);
        if (v === _state.horaFin) o.selected = true;
        selFin.appendChild(o);
    }
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const ini = selIni.value;
        const fin = selFin.value;
        if (horaAMin(fin) - horaAMin(ini) < _state.duracion) {
            burbujaBot(`Necesitas al menos ${_state.duracion} min entre la hora de inicio y la de fin 😉`);
            return;
        }
        _state.horaInicio = ini;
        _state.horaFin = fin;
        selIni.disabled = true;
        selFin.disabled = true;
        form.querySelector('button[type="submit"]').disabled = true;
        form.classList.add('svcchat-input-usado');
        burbujaUser(`${ini} a ${fin}`);
        actualizarResumen();
        pasoCupos();
    });
    _el.conv.appendChild(form);
    scrollAbajo();
}

function pasoCupos() {
    _state.paso = 9;
    burbujaBot('¿A cuántos clientes puedes atender <strong>a la vez</strong> en cada bloque?<br><span class="svcchat-sub">Si haces clases grupales, elige más de 1. Si es atención 1 a 1, déjalo en 1.</span>');
    bloqueOpciones([
        { valor: 1, label: '1 cliente', hint: 'Atención personalizada', rec: true },
        { valor: 2, label: '2 clientes' },
        { valor: 4, label: '4 clientes' },
        { valor: 6, label: '6 clientes', hint: 'Clases grupales' }
    ], (valor) => {
        _state.cupos = valor;
        burbujaUser(valor === 1 ? '1 cliente a la vez' : `${valor} clientes a la vez`);
        actualizarResumen();
        pasoVigencia();
    });
}

function pasoVigencia() {
    _state.paso = 10;
    burbujaBot('¿Hasta cuándo se podrá reservar este servicio?<br><span class="svcchat-sub">Después lo renuevas con un clic desde Mis Servicios.</span>');
    bloqueOpciones([
        { valor: 1, label: '1 mes' },
        { valor: 3, label: '3 meses', rec: true },
        { valor: 6, label: '6 meses' }
    ], (valor) => {
        _state.vigenciaMeses = valor;
        burbujaUser(VIGENCIA_LABEL[valor]);
        actualizarResumen();
        pasoResumenFinal();
    });
}

// ============================================================
// Resumen final + acciones
// ============================================================
function pasoResumenFinal() {
    _state.paso = 11;
    const fechas = calcularFechas(diasDeRespuesta(_state.dias), _state.vigenciaMeses);
    const bloques = generarBloques(_state.horaInicio, _state.horaFin, _state.duracion);
    const esPromo = _state.modalidad === 'promocion';

    burbujaBot(`
        <div class="svcchat-msg-titulo">¡Listo! 🎉 Así quedó tu servicio</div>
        <div class="svcchat-tarjeta-final">
            <div class="svcchat-final-nombre"><i class="fas fa-tag"></i> ${escapeHtml(_state.nombre)}</div>
            <div class="svcchat-final-fila"><span>Modalidad</span><strong>${esPromo ? `Pack de ${_state.numSesiones} sesiones` : 'Sesión suelta'}</strong></div>
            <div class="svcchat-final-fila"><span>Precio</span><strong>${esPromo ? `${CLP(_state.precioSesion)} sesión suelta · ${CLP(_state.precioPack)} el pack` : CLP(_state.precioSesion)}</strong></div>
            <div class="svcchat-final-fila"><span>Duración</span><strong>${_state.duracion} min</strong></div>
            <div class="svcchat-final-fila"><span>Disponible</span><strong>${DIAS_LABEL[_state.dias]} · ${_state.horaInicio} a ${_state.horaFin}</strong></div>
            <div class="svcchat-final-fila"><span>Cupos por bloque</span><strong>${_state.cupos} cliente${_state.cupos > 1 ? 's' : ''}</strong></div>
            <div class="svcchat-final-fila"><span>Vigencia</span><strong>${VIGENCIA_LABEL[_state.vigenciaMeses]} · ${fechas.length} día(s) con horario</strong></div>
        </div>
        <p class="svcchat-sub" style="margin-top:8px;">💡 Foto y descripción puedes agregarlas después desde Mis Servicios → Editar.</p>
    `);

    const acciones = document.createElement('div');
    acciones.className = 'svcchat-acciones';
    acciones.innerHTML = `
        <button type="button" class="svcchat-btn-publicar" id="svcchat-publicar"><i class="fas fa-rocket"></i> Publicar servicio 🎉</button>
        <button type="button" class="svcchat-btn-copiar" id="svcchat-copiar"><i class="fas fa-copy"></i> Crear otro parecido</button>
    `;
    _el.conv.appendChild(acciones);

    acciones.querySelector('#svcchat-publicar').addEventListener('click', () => publicar(false));
    acciones.querySelector('#svcchat-copiar').addEventListener('click', () => publicar(true));
    scrollAbajo();
}

// ============================================================
// Resumen en vivo (lateral)
// ============================================================
function actualizarResumen() {
    const s = _state;
    const body = _el.resumen;
    if (!body) return;

    const fechas = calcularFechas(diasDeRespuesta(s.dias), s.vigenciaMeses);
    const bloques = generarBloques(s.horaInicio, s.horaFin, s.duracion);
    const esPromo = s.modalidad === 'promocion';

    const fila = (k, v) => (v ? `<div class="svcchat-rsm-fila"><span>${k}</span><strong>${v}</strong></div>` : '');

    body.innerHTML = `
        <div class="svcchat-rsm-preview">
            ${s.nombre ? `<div class="svcchat-rsm-nombre">${escapeHtml(s.nombre)}</div>` : '<div class="svcchat-rsm-vacio">[Nombre del servicio]</div>'}
            ${s.precioSesion ? `<div class="svcchat-rsm-precio">${CLP(s.precioSesion)}${esPromo ? ' · pack ' + CLP(s.precioPack) : ''}</div>` : ''}
            ${s.duracion ? `<div class="svcchat-rsm-chip">${s.duracion} min</div>` : ''}
        </div>
        ${fila('Modalidad', esPromo ? `Pack de ${s.numSesiones}` : (s.paso >= 2 ? 'Sesión suelta' : ''))}
        ${fila('Días', s.paso >= 7 ? DIAS_LABEL[s.dias] : '')}
        ${fila('Horario', s.paso >= 8 ? `${s.horaInicio} a ${s.horaFin} (${bloques.length} bloque${bloques.length === 1 ? '' : 's'} de ${s.duracion} min)` : '')}
        ${fila('Cupos', s.paso >= 9 ? `${s.cupos} por bloque` : '')}
        ${fila('Vigencia', s.paso >= 10 ? `${VIGENCIA_LABEL[s.vigenciaMeses]} · ${fechas.length} día(s)` : '')}
    `;
}

// ============================================================
// Publicación: rellenar el formulario real y disparar su submit
// ============================================================
function rellenarFormularioReal() {
    const s = _state;
    const fechas = calcularFechas(diasDeRespuesta(s.dias), s.vigenciaMeses);
    if (!fechas.length) return 'No hay fechas disponibles para la vigencia elegida. Prueba con más meses o más días.';
    const bloques = generarBloques(s.horaInicio, s.horaFin, s.duracion);
    if (!bloques.length) return 'No hay bloques de horario: revisa la hora de inicio/fin y la duración.';

    // --- Paso 1: inputs ---
    const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val;
    };
    setVal('srv-name', s.nombre);
    setVal('srv-price', s.precioSesion);
    setVal('srv-duration', s.duracion);
    setVal('srv-desc', '');
    setVal('srv-image-url', '');

    const activo = document.getElementById('srv-active');
    if (activo) activo.checked = true;
    const destacado = document.getElementById('srv-featured');
    if (destacado) destacado.checked = true;

    // Tipo de venta + campos de promoción
    const radioPromo = document.querySelector('input[name="srv-tipo-venta"][value="promocion"]');
    const radioSesion = document.querySelector('input[name="srv-tipo-venta"][value="sesion"]');
    if (s.modalidad === 'promocion' && radioPromo) {
        radioPromo.checked = true;
        radioPromo.dispatchEvent(new Event('change', { bubbles: true }));
        setVal('srv-promo-sesiones', s.numSesiones);
        setVal('srv-promo-precio', s.precioPack || precioPackSugerido());
        const pp = document.getElementById('srv-promo-precio');
        if (pp) pp.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (radioSesion) {
        radioSesion.checked = true;
        radioSesion.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const dur = document.getElementById('srv-duration');
    if (dur) dur.dispatchEvent(new Event('input', { bubbles: true }));

    // --- Paso 2: módulos generales (modo 'all') ---
    // Se setean ANTES de generar las fechas para poder verificar la paridad
    // con generarDisponibilidadFinal() (que solo incluye fechas con módulos).
    bloques.forEach(b => { b.cupos = s.cupos; });
    window.serviceModules = bloques;
    window.moduleDateCupos = {};

    // --- Paso 3: fechas vía el generador por rango del form (muta selectedDates) ---
    const rIni = document.getElementById('range-start');
    const rFin = document.getElementById('range-end');
    if (!rIni || !rFin || typeof window.generarFechasPorRango !== 'function') {
        return 'El formulario de fechas no está listo. Recarga la página e inténtalo de nuevo.';
    }
    rIni.value = fechas[0];
    rFin.value = fechas[fechas.length - 1];
    document.querySelectorAll('.dia-semana-checkbox').forEach(cb => { cb.checked = false; });
    diasDeRespuesta(s.dias).forEach(d => {
        const cb = document.querySelector(`.dia-semana-checkbox[value="${d}"]`);
        if (cb) cb.checked = true;
    });
    window.generarFechasPorRango();

    // Paridad: el formulario debe quedar con EXACTAMENTE las fechas anunciadas
    // en el chat (misma aritmética T12 en ambos lados tras el fix de DST).
    let persistidas = [];
    try {
        persistidas = Object.keys(window.generarDisponibilidadFinal() || {}).sort();
    } catch (e) {
        console.warn('[svcchat] No se pudo verificar fechas:', e);
    }
    if (persistidas.length !== fechas.length) {
        return `Se generaron ${persistidas.length} de ${fechas.length} fechas en el formulario. Recarga la página y vuelve a intentarlo.`;
    }

    // saveModulesToHiddenField es const global del legacy (no cuelga de window):
    // se resuelve por el scope global declarativo del navegador.
    try {
        if (typeof saveModulesToHiddenField === 'function') saveModulesToHiddenField();
    } catch (e) {
        console.warn('[svcchat] saveModulesToHiddenField no disponible:', e);
    }

    // Refrescar la cobertura de trabajadores (ServiceForm escucha este evento)
    window.dispatchEvent(new CustomEvent('servicio-modulos-actualizados'));
    return null;
}

// Espera a que ServiceForm re-renderice los checkboxes (cubre disponibilidad real).
function esperarRefrescoWorkers(ms) {
    return new Promise(res => setTimeout(res, ms || 220));
}

// Si el negocio exige trabajador, pregunta quién lo atiende (desde el DOM real).
// Devuelve false solo si no hay trabajador seleccionable (caso límite): ahí el
// chat no puede publicar solo y deriva al formulario.
function pedirTrabajadorSiHaceFalta() {
    return new Promise((resolve) => {
        const cont = document.getElementById('service-workers-list');
        const requiere = cont && cont.dataset.requiereTrabajador === '1';
        if (!requiere) return resolve(true);

        const opciones = [];
        cont.querySelectorAll('.worker-checkbox-label input[type="checkbox"]:not(:disabled)').forEach(cb => {
            const label = cb.closest('.worker-checkbox-label');
            const nombre = label && label.querySelector('.worker-check-name');
            opciones.push({ valor: cb.value, label: (nombre ? nombre.textContent.trim() : 'Trabajador') });
        });

        if (!opciones.length) {
            // No debería pasar (requiere='1' implica ≥1 que cubre), pero si pasa:
            // el formulario completo es quien puede resolverlo (validación propia).
            burbujaBot('⚠️ Ningún trabajador con horario cubre este servicio. Publícalo desde <strong>Modo formulario completo</strong> para elegir la asignación correcta.');
            return resolve(false);
        }

        burbujaBot('En tu negocio los servicios se asignan a trabajadores. <strong>¿Quién atiende este servicio?</strong>');
        bloqueOpciones(opciones.map(o => ({ valor: o.valor, label: o.label })), (valor) => {
            const cb = cont.querySelector(`input[type="checkbox"][value="${valor}"]`);
            if (cb) cb.checked = true;
            const nombre = opciones.find(o => o.valor === valor);
            burbujaUser((nombre ? nombre.label : 'Trabajador') + ' ✓');
            resolve(true);
        });
    });
}

async function publicar(crearCopia) {
    if (_publicando) return;
    _publicando = true;

    const errorPre = rellenarFormularioReal();
    if (errorPre) {
        burbujaBot('⚠️ ' + errorPre);
        _publicando = false;
        return;
    }

    await esperarRefrescoWorkers();
    const okWorkers = await pedirTrabajadorSiHaceFalta();
    if (!okWorkers) {
        _publicando = false;
        return;
    }

    // Publicar vía el MISMO camino del formulario (crearServicio legacy):
    // validaciones, gate de suscripción, workers y navegación incluidos.
    // Al ser await, sabemos con certeza si terminó creando (navegó a
    // mis-servicios) o si una validación frenó antes (sigue en crear).
    const crearSection = document.getElementById('section-crear-servicio');
    let exito = false;
    try {
        if (typeof window.crearServicio === 'function') {
            await window.crearServicio();
        }
        const mis = document.getElementById('section-mis-servicios');
        exito = !!(mis && mis.style.display !== 'none');
    } catch (err) {
        console.error('[svcchat] Error al crear el servicio:', err);
        exito = false;
    }

    _publicando = false;
    if (exito) {
        cerrarChat();
        if (crearCopia) {
            const copia = { ..._state, nombre: '' };
            // Esperar a que el form se resetee tras la creación y reabrir con las respuestas.
            setTimeout(() => {
                if (typeof window.navigateTo === 'function') window.navigateTo('crear-servicio');
                if (typeof window.limpiarEstadoEdicion === 'function') window.limpiarEstadoEdicion();
                _state = { ...estadoInicial(), ...copia, paso: 0 };
                if (!_el) construirModal();
                _el.modal.hidden = false;
                document.body.classList.add('svcchat-abierto');
                _el.conv.innerHTML = '';
                burbujaBot('¡Publicado! 🎉 Ahora creemos <strong>otro parecido</strong> con los mismos datos.');
                _state.paso = 0;
                pasoNombre('¿Cómo se llama esta copia?');
            }, 700);
        }
        return;
    }

    // Fallo de validación legacy: los datos quedaron cargados en el formulario.
    burbujaBot('⚠️ El formulario marcó un aviso (revisa abajo los campos en rojo).<br>Tus datos quedaron cargados: toca <strong>Modo formulario completo</strong> para corregir y pulsar CREAR SERVICIO, o cambia tus respuestas aquí.');
    if (crearSection) crearSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
