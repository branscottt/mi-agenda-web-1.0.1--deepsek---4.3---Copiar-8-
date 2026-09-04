// services/ui/ServiceChat.js
// ============================================================
// "Crea tu servicio conversando" v2 — ASISTENTE INLINE (admin.html,
// sección crear-servicio). Aparece DE UNA al entrar a la sección; el
// formulario clásico queda detrás del botón "Rellenar manual".
//
// v2 (2026-09, pedido del dueño):
//  - El chat es la vista por defecto de Crear Servicio.
//  - Respuestas ABIERTAS: cada pregunta cerrada incluye "Otro…" (input
//    libre), "Elijo la fecha…" (date picker), "Elegir días…" y
//    "Elegir yo los bloques" (multiselect de horas).
//  - "¿Desde cuándo vas a hacer este servicio?" (hoy / próxima semana /
//    fecha) y "¿Hasta cuándo?" (1-3-6 meses / 1 año entero / fecha).
//  - Bloques/módulos explícitos: corridos automáticos o elegidos a mano.
//
// Guardado SIN duplicar lógica: rellena el estado REAL del form legacy
// (selectedDates + window.serviceModules + inputs) y llama a
// window.crearServicio() → validaciones, gate de suscripción y workers
// intactos. Al pasar a "Rellenar manual" a mitad de conversación se aplica
// el avance parcial al formulario (no se pierde nada).
// ============================================================

const MAX_FECHAS = 400; // tope defensivo (1 año "todos los días" ≈ 366)
const CLP = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-CL');

function fmtLocal(d) {
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function hoyISO() {
    return fmtLocal(new Date());
}

// Suma meses a una fecha ISO (clamp al último día del mes).
function sumarMesesClamp(fechaISO, meses) {
    const [y, m, d] = fechaISO.split('-').map(Number);
    const ultimo = new Date(y, m, 0).getDate();
    const dia = Math.min(d, ultimo);
    const fin = new Date(y, m - 1 + meses, dia);
    return fmtLocal(fin);
}

// Días de la semana incluidos (0=Dom..6=Sáb, igual que .dia-semana-checkbox).
function diasDeRespuesta(resp) {
    if (resp === 'finde') return [0, 6];
    if (resp === 'laborables') return [1, 2, 3, 4, 5];
    if (resp === 'todos') return [0, 1, 2, 3, 4, 5, 6];
    return resp; // array libre (días elegidos)
}

// Fechas entre desdeISO y hastaISO (inclusive) que caen en los días elegidos.
// Se itera con MEDIODÍA local (T12): inmune a cambios de hora/DST (fix 2026-09).
function calcularFechas(dias, desdeISO, hastaISO) {
    if (!desdeISO || !hastaISO || hastaISO < desdeISO) return [];
    const out = [];
    const d = new Date(desdeISO + 'T12:00:00');
    const end = new Date(hastaISO + 'T12:00:00');
    while (d <= end) {
        if (dias.includes(d.getDay())) {
            out.push(fmtLocal(d));
            if (out.length > MAX_FECHAS) break;
        }
        d.setDate(d.getDate() + 1);
    }
    return out;
}

// Próximo lunes a partir de una fecha (semanasAdelante=1 → lunes siguiente).
function proximoLunes(fechaISO) {
    const d = new Date(fechaISO + 'T12:00:00');
    const diff = (8 - d.getDay()) % 7 || 7;
    d.setDate(d.getDate() + diff);
    return fmtLocal(d);
}

function horaAMin(hhmm) {
    const p = String(hhmm || '0').split(':').map(Number);
    return (p[0] || 0) * 60 + (p[1] || 0);
}

function minAHora(min) {
    const p = (x) => String(x).padStart(2, '0');
    return `${p(Math.floor(min / 60))}:${p(min % 60)}`;
}

// Bloques corridos de durMin desde inicio hasta fin.
function generarBloques(inicio, fin, durMin, cupos) {
    const bloques = [];
    let t = horaAMin(inicio);
    const finMin = horaAMin(fin);
    while (t + durMin <= finMin) {
        bloques.push({
            startTime: minAHora(t),
            endTime: minAHora(t + durMin),
            duration: durMin,
            cupos: cupos || 1,
            editable: true
        });
        t += durMin;
    }
    return bloques;
}

// Horas candidatas para "elegir bloques a mano" (cada durMin desde inicio).
function horasCandidatas(inicio, fin, durMin) {
    const horas = [];
    let t = horaAMin(inicio);
    const finMin = horaAMin(fin);
    while (t + durMin <= finMin) {
        horas.push(minAHora(t));
        t += durMin;
    }
    return horas;
}

function fmtFechaLegible(iso) {
    if (!iso) return '';
    const p = iso.split('-');
    if (p.length !== 3) return iso;
    const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    return `${parseInt(p[2], 10)} de ${meses[parseInt(p[1], 10) - 1] || p[1]} de ${p[0]}`;
}

let _state = null;
let _el = null;      // refs del chat inline
let _publicando = false;
let _modo = 'chat';  // 'chat' | 'form'
let _tituloOriginal = null;
let _observer = null;

const DIAS_SEMANA = [
    { v: 1, label: 'Lun' }, { v: 2, label: 'Mar' }, { v: 3, label: 'Mié' },
    { v: 4, label: 'Jue' }, { v: 5, label: 'Vie' }, { v: 6, label: 'Sáb' }, { v: 0, label: 'Dom' }
];
const MESES_LABEL = { 1: '1 mes', 3: '3 meses', 6: '6 meses', 12: '1 año entero' };

// ============================================================
// Init: contenedor inline + botón toggle + auto-mostrar al entrar
// ============================================================
export function initServicioChat() {
    const header = document.getElementById('section-title-servicio');
    const form = document.getElementById('service-form');
    if (!header || !form) return;

    _tituloOriginal = header.innerHTML;

    // Contenedor del chat (hermano del form, dentro del mismo glass-panel).
    if (!document.getElementById('svcchat-view')) {
        const view = document.createElement('div');
        view.id = 'svcchat-view';
        view.className = 'svcchat-view';
        view.style.display = 'none';
        view.innerHTML = `
            <div class="svcchat-inline">
                <div class="svcchat-conv" id="svcchat-conv"></div>
                <aside class="svcchat-resumen" id="svcchat-resumen">
                    <div class="svcchat-resumen-titulo"><i class="fas fa-eye"></i> Así está quedando tu servicio</div>
                    <div class="svcchat-resumen-body" id="svcchat-resumen-body"></div>
                </aside>
            </div>
        `;
        form.parentNode.insertBefore(view, form.nextSibling);
        _el = {
            view,
            conv: view.querySelector('#svcchat-conv'),
            resumen: view.querySelector('#svcchat-resumen-body')
        };
    }

    // Botón único toggle en el header (junto a "Ver tutorial").
    let headerFlex = header.closest('.section-header-flex');
    if (!headerFlex) {
        headerFlex = document.createElement('div');
        headerFlex.className = 'section-header-flex';
        header.parentNode.insertBefore(headerFlex, header);
        headerFlex.appendChild(header);
    }
    if (!document.getElementById('btn-svc-modo')) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'btn-svc-modo';
        btn.className = 'tutorial-btn svcchat-modo-btn';
        btn.innerHTML = '<i class="fas fa-keyboard"></i> Rellenar manual';
        btn.addEventListener('click', alternarModo);
        headerFlex.appendChild(btn);
    }

    // Auto-mostrar el chat al entrar a la sección (salvo edición activa).
    const section = document.getElementById('section-crear-servicio');
    if (section && !_observer && typeof MutationObserver !== 'undefined') {
        _observer = new MutationObserver(() => {
            if (section.style.display !== 'none' && !estaEditando()) {
                mostrarChat({ silencioso: true });
            }
        });
        _observer.observe(section, { attributes: true, attributeFilter: ['style'] });
    }
    if (section && section.style.display !== 'none' && !estaEditando()) {
        mostrarChat({ silencioso: true });
    }
}

function estaEditando() {
    const submitBtn = document.querySelector('#service-form button[type="submit"]');
    return !!(submitBtn && /guardar|guardando/i.test(submitBtn.textContent));
}

// ============================================================
// Alternar chat ↔ formulario
// ============================================================
function alternarModo() {
    if (_modo === 'chat') mostrarForm();
    else mostrarChat({ silencioso: false });
}

function pintarCabeceraModo() {
    const header = document.getElementById('section-title-servicio');
    const btn = document.getElementById('btn-svc-modo');
    if (_modo === 'chat') {
        if (header && _tituloOriginal) header.innerHTML = '<i class="fas fa-comments"></i> Crea tu servicio conversando';
        if (btn) btn.innerHTML = '<i class="fas fa-keyboard"></i> Rellenar manual';
    } else {
        if (header && _tituloOriginal) header.innerHTML = _tituloOriginal;
        if (btn) btn.innerHTML = '<i class="fas fa-comments"></i> Crear conversando';
    }
}

function mostrarChat(opts) {
    const form = document.getElementById('service-form');
    if (!form || !_el) return;
    opts = opts || {};

    _modo = 'chat';
    form.style.display = 'none';
    _el.view.style.display = '';

    if (_state && _state.paso >= 1 && _state.paso < 99) {
        // Conversación a medias o copia en curso: continuar (no repintar).
        pintarCabeceraModo();
        actualizarResumen();
        return;
    }
    if (_state && _state.paso === 99) {
        pintarCabeceraModo();
        return; // resumen final ya pintado
    }

    // Arranque fresco: reset del form (submit → crear, no actualizar).
    // OJO: limpiarEstadoEdicion() restaura el título legacy, por eso la
    // cabecera se pinta DESPUÉS del reset.
    if (typeof window.limpiarEstadoEdicion === 'function') window.limpiarEstadoEdicion();
    _state = estadoInicial();
    _el.conv.innerHTML = '';
    pintarCabeceraModo();
    pintarBienvenida();
    actualizarResumen();
    if (!opts.silencioso) {
        const input = _el.conv.querySelector('.svcchat-input');
        if (input) setTimeout(() => input.focus(), 60);
    }
}

function mostrarForm() {
    const form = document.getElementById('service-form');
    if (!form || !_el) return;

    _modo = 'form';
    form.style.display = '';
    _el.view.style.display = 'none';
    pintarCabeceraModo();

    // Aplicar lo conversado al formulario ("como si se llenara a mano").
    if (_state && _state.nombre) aplicarAvanceEnFormulario();
}

// ============================================================
// Estado inicial
// ============================================================
function estadoInicial() {
    return {
        paso: 0,
        nombre: '',
        modalidad: 'sesion',
        numSesiones: 8,
        precioSesion: null,
        precioPack: null,
        duracion: 60,
        dias: 'todos',          // 'laborables'|'finde'|'todos'|'array'
        diasArray: null,
        desde: 'hoy',           // 'hoy'|'proxima'|'fecha'
        desdeISO: null,
        hastaMeses: 3,          // 1|3|6|12
        hastaISO: null,         // si eligió fecha exacta
        horaInicio: '09:00',
        horaFin: '18:00',
        bloquesModo: 'corridos', // 'corridos'|'elegir'
        bloquesElegidos: null,
        cupos: 1
    };
}

function fechaDesdeISO(s) {
    if (s.desdeISO) return s.desdeISO;
    if (s.desde === 'proxima') return proximoLunes(hoyISO());
    return hoyISO();
}

function fechaHastaISO(s) {
    if (s.hastaISO) return s.hastaISO;
    return sumarMesesClamp(fechaDesdeISO(s), s.hastaMeses || 3);
}

function diasEfectivos(s) {
    return diasDeRespuesta(s.diasArray || s.dias);
}

function bloquesDe(s) {
    const dur = s.duracion || 60;
    const cup = s.cupos || 1;
    if (s.bloquesModo === 'elegir' && s.bloquesElegidos && s.bloquesElegidos.length) {
        return s.bloquesElegidos.map(h => ({
            startTime: h,
            endTime: minAHora(horaAMin(h) + dur),
            duration: dur,
            cupos: cup,
            editable: true
        }));
    }
    return generarBloques(s.horaInicio, s.horaFin, dur, cup);
}

// ============================================================
// Burbujas y controles
// ============================================================
function scrollAbajo() {
    const conv = _el && _el.conv;
    if (!conv) return;
    requestAnimationFrame(() => { conv.scrollTop = conv.scrollHeight; });
}

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

/**
 * Bloque de opciones con botones.
 * opts.conOtro: agrega "Otro…". Si opts.onOtro está definido, al tocarlo se
 * llama onOtro() (p.ej. abrir multiselect o date picker); si no, despliega
 * un input libre que al enviar llama alElegir(parseOtro(valor)||valor).
 */
function bloqueOpciones(opciones, alElegir, opts) {
    opts = opts || {};
    const wrap = document.createElement('div');
    wrap.className = 'svcchat-opciones';

    const crearBoton = (op) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'svcchat-opt' + (op.rec ? ' svcchat-opt-rec' : '') + (op.peligro ? ' svcchat-opt-peligro' : '');
        b.innerHTML = (op.rec ? '<span class="svcchat-badge">Recomendado</span>' : '') +
            `<span class="svcchat-opt-texto">${op.label}</span>` +
            (op.hint ? `<small class="svcchat-opt-hint">${op.hint}</small>` : '');
        // El botón "Otro…" NO dispara alElegir: su comportamiento lo maneja el
        // listener extra (input libre / onOtro). Evita avanzar con '__otro__'.
        if (op.valor !== '__otro__') {
            b.addEventListener('click', () => alElegir(op.valor, op));
        }
        return b;
    };

    opciones.forEach(op => wrap.appendChild(crearBoton(op)));

    if (opts.conOtro) {
        const b = crearBoton({ label: opts.otroLabel || 'Otro…', valor: '__otro__' });
        b.classList.add('svcchat-opt-otro');
        wrap.appendChild(b); // ← el botón "Otro…" debe ser visible

        if (typeof opts.onOtro === 'function') {
            // Comportamiento propio (multiselect / fecha…)
            b.addEventListener('click', () => {
                b.style.display = 'none';
                opts.onOtro();
            });
        } else {
            // Input libre por defecto.
            const form = document.createElement('form');
            form.className = 'svcchat-input-row svcchat-otro-row';
            form.style.display = 'none';
            form.innerHTML = `
                <input type="text" class="svcchat-input" placeholder="${opts.otroPlaceholder || 'Escribe tu respuesta'}" autocomplete="off" ${opts.inputmode ? `inputmode="${opts.inputmode}"` : ''}>
                <button type="submit" class="svcchat-btn-enviar">Usar</button>
            `;
            const input = form.querySelector('input');
            b.addEventListener('click', () => {
                b.style.display = 'none';
                form.style.display = 'flex';
                setTimeout(() => input.focus(), 40);
            });
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                const val = input.value.trim();
                const err = opts.validarOtro ? opts.validarOtro(val) : (val ? null : 'Escribe un valor');
                if (err) {
                    input.classList.add('svcchat-input-error');
                    input.title = err;
                    return;
                }
                input.classList.remove('svcchat-input-error');
                input.disabled = true;
                form.querySelector('button').disabled = true;
                form.classList.add('svcchat-input-usado');
                alElegir(opts.parseOtro ? opts.parseOtro(val) : val, { otro: true, texto: val });
            });
            wrap.appendChild(form);
        }
    }

    _el.conv.appendChild(wrap);
    scrollAbajo();
    return wrap;
}

// Input simple dentro del chat.
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

// Input de fecha (date) dentro del chat.
function bloqueFecha(minISO, alEnviar) {
    const form = document.createElement('form');
    form.className = 'svcchat-input-row svcchat-fecha-row';
    form.innerHTML = `
        <input type="date" class="svcchat-input svcchat-input-fecha" ${minISO ? `min="${minISO}"` : ''}>
        <button type="submit" class="svcchat-btn-enviar">Usar fecha</button>
    `;
    const input = form.querySelector('input');
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!input.value) {
            input.classList.add('svcchat-input-error');
            return;
        }
        if (minISO && input.value < minISO) {
            input.classList.add('svcchat-input-error');
            input.title = 'Elige una fecha desde ' + fmtFechaLegible(minISO) + ' en adelante';
            return;
        }
        input.classList.remove('svcchat-input-error');
        input.disabled = true;
        form.querySelector('button').disabled = true;
        form.classList.add('svcchat-input-usado');
        alEnviar(input.value);
    });
    _el.conv.appendChild(form);
    setTimeout(() => {
        try { if (input.showPicker) input.showPicker(); }
        catch (e) { input.focus(); }
    }, 80);
    scrollAbajo();
    return form;
}

// Multiselect de chips + botón continuar.
function bloqueMultiSelect(items, alConfirmar, opts) {
    opts = opts || {};
    const wrap = document.createElement('div');
    wrap.className = 'svcchat-multiselect';
    const elegidos = new Set(opts.preseleccion || []);
    const grid = document.createElement('div');
    grid.className = 'svcchat-chip-grid';
    items.forEach(item => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'svcchat-chip' + (elegidos.has(item.valor) ? ' active' : '');
        chip.textContent = item.label;
        chip.addEventListener('click', () => {
            if (elegidos.has(item.valor)) elegidos.delete(item.valor);
            else elegidos.add(item.valor);
            chip.classList.toggle('active', elegidos.has(item.valor));
        });
        grid.appendChild(chip);
    });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'svcchat-btn-enviar svcchat-multi-continuar';
    btn.textContent = 'Continuar';
    wrap.appendChild(grid);
    wrap.appendChild(btn);
    btn.addEventListener('click', () => {
        if (!elegidos.size) {
            burbujaBot(opts.errorVacio || 'Elige al menos una opción 😉');
            return;
        }
        alConfirmar([...elegidos]);
    });
    _el.conv.appendChild(wrap);
    scrollAbajo();
    return wrap;
}

// ============================================================
// Flujo de preguntas
// ============================================================
function pintarBienvenida() {
    burbujaBot(`
        <div class="svcchat-msg-titulo">¡Hola! 👋 Te ayudo a crear tu servicio.</div>
        <p>Responde como prefieras: toca una opción o usa <strong>"Otro…"</strong> para escribir tu propia respuesta.<br>
        En cualquier momento pasas al <strong>formulario completo</strong> con el botón "Rellenar manual" (arriba) y sigues desde ahí.</p>
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
            <span class="svcchat-ejemplo-notif">"Tu turno de <strong>${escapeHtml(valor)}</strong> es mañana a las 18:00"</span>`);
        actualizarResumen();
        pasoModalidad();
    });
}

function pasoModalidad() {
    _state.paso = 2;
    burbujaBot('¿Cómo vas a ofrecerlo?');
    bloqueOpciones([
        { valor: 'sesion', label: 'Sesión suelta', hint: 'El cliente paga por sesión y reserva cuando quiera.' },
        { valor: 'promocion', label: 'Pack de N sesiones', rec: true, hint: 'Cobras por adelantado y el cliente se compromete a volver.' }
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
    }, {
        conOtro: true,
        otroLabel: 'Otro número…',
        otroPlaceholder: 'N° de sesiones (ej: 6)',
        inputmode: 'numeric',
        validarOtro: (v) => {
            const n = parseInt(v.replace(/[^0-9]/g, ''), 10);
            return (n && n >= 2) ? null : 'El pack debe tener al menos 2 sesiones';
        },
        parseOtro: (v) => parseInt(v.replace(/[^0-9]/g, ''), 10)
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
                    burbujaBot('Ese precio no tiene descuento (es mayor o igual al valor real). Usa el sugerido o un precio menor 😉');
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
    }, {
        conOtro: true,
        otroLabel: 'Otra duración…',
        otroPlaceholder: 'Minutos (ej: 20, 75, 120)',
        inputmode: 'numeric',
        validarOtro: (v) => {
            const n = parseInt(v.replace(/[^0-9]/g, ''), 10);
            return (n && n >= 5 && n <= 480) ? null : 'Elige entre 5 y 480 minutos';
        },
        parseOtro: (v) => parseInt(v.replace(/[^0-9]/g, ''), 10)
    });
}

function pasoDias() {
    _state.paso = 7;
    burbujaBot('¿Qué días de la semana vas a atender este servicio?<br><span class="svcchat-sub">Elige "Otro…" para marcar días sueltos.</span>');
    bloqueOpciones([
        { valor: 'laborables', label: 'Lun a Vie' },
        { valor: 'finde', label: 'Sáb y Dom' },
        { valor: 'todos', label: 'Todos los días', rec: true }
    ], (valor) => {
        _state.dias = valor;
        _state.diasArray = null;
        burbujaUser(valor === 'laborables' ? 'Lun a Vie' : valor === 'finde' ? 'Sáb y Dom' : 'Todos los días');
        actualizarResumen();
        pasoDesde();
    }, {
        conOtro: true,
        otroLabel: 'Elegir días…',
        onOtro: () => {
            burbujaUser('Elegir días…');
            burbujaBot('Marca los días en que atiendes este servicio:');
            bloqueMultiSelect(DIAS_SEMANA.map(x => ({ valor: x.v, label: x.label })), (elegidos) => {
                _state.dias = 'array';
                _state.diasArray = elegidos;
                burbujaUser('Días: ' + elegidos.map(v => (DIAS_SEMANA.find(d => d.v === v) || {}).label).join(', '));
                actualizarResumen();
                pasoDesde();
            }, { errorVacio: 'Marca al menos un día 😉' });
        }
    });
}

function pasoDesde() {
    _state.paso = 8;
    burbujaBot('¿<strong>Desde cuándo</strong> vas a hacer este servicio?<br><span class="svcchat-sub">Las fechas se marcan solas en el calendario.</span>');
    bloqueOpciones([
        { valor: 'hoy', label: 'Desde hoy', rec: true },
        { valor: 'proxima', label: 'Desde la próxima semana' }
    ], (valor) => {
        _state.desde = valor;
        _state.desdeISO = null;
        burbujaUser(valor === 'hoy' ? 'Desde hoy' : 'Desde la próxima semana');
        actualizarResumen();
        pasoHasta();
    }, {
        conOtro: true,
        otroLabel: 'Elijo la fecha…',
        onOtro: () => {
            burbujaUser('Elijo la fecha…');
            burbujaBot('¿Desde qué fecha exacta?');
            bloqueFecha(hoyISO(), (f) => {
                _state.desde = 'fecha';
                _state.desdeISO = f;
                burbujaUser('Desde el ' + fmtFechaLegible(f));
                actualizarResumen();
                pasoHasta();
            });
        }
    });
}

function pasoHasta() {
    _state.paso = 9;
    const desde = fechaDesdeISO(_state);
    burbujaBot(`¿<strong>Hasta cuándo</strong> lo dejamos disponible?<br>
        <span class="svcchat-sub">Empieza el ${fmtFechaLegible(desde)}. Después lo renuevas con un clic desde Mis Servicios.</span>`);
    bloqueOpciones([
        { valor: 1, label: '1 mes' },
        { valor: 3, label: '3 meses', rec: true },
        { valor: 6, label: '6 meses' },
        { valor: 12, label: '1 año entero' }
    ], (valor) => {
        _state.hastaMeses = valor;
        _state.hastaISO = null;
        burbujaUser(MESES_LABEL[valor]);
        actualizarResumen();
        pasoHorario();
    }, {
        conOtro: true,
        otroLabel: 'Hasta una fecha exacta…',
        onOtro: () => {
            burbujaUser('Hasta una fecha exacta…');
            burbujaBot('¿Hasta qué fecha?');
            bloqueFecha(desde, (f) => {
                _state.hastaMeses = null;
                _state.hastaISO = f;
                burbujaUser('Hasta el ' + fmtFechaLegible(f));
                actualizarResumen();
                pasoHorario();
            });
        }
    });
}

function pasoHorario() {
    _state.paso = 10;
    burbujaBot(`¿<strong>Entre qué horas</strong> trabajas este servicio?<br>
        <span class="svcchat-sub">Después eliges si son bloques corridos o los marcas tú (descansos, clases puntuales, etc.).</span>`);
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
    for (let h = 5; h <= 22; h++) {
        const v = String(h).padStart(2, '0') + ':00';
        const o = new Option(v, v);
        if (v === _state.horaInicio) o.selected = true;
        selIni.appendChild(o);
    }
    for (let h = 6; h <= 23; h++) {
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
        form.querySelector('button').disabled = true;
        form.classList.add('svcchat-input-usado');
        burbujaUser(`${ini} a ${fin}`);
        actualizarResumen();
        pasoBloques();
    });
    _el.conv.appendChild(form);
    scrollAbajo();
}

function pasoBloques() {
    _state.paso = 11;
    const dur = _state.duracion;
    const candidatas = horasCandidatas(_state.horaInicio, _state.horaFin, dur);
    const corridos = candidatas.length;
    burbujaBot(`¿Cómo armamos los <strong>bloques de atención</strong>?<br>
        <span class="svcchat-sub">Entre ${_state.horaInicio} y ${_state.horaFin}, corridos serían <strong>${corridos} bloques de ${dur} min</strong>. Si tienes descansos o solo atiendes a ciertas horas, elige tú los bloques.</span>`);
    bloqueOpciones([
        { valor: 'corridos', label: `Corridos (${corridos} bloques de ${dur} min)`, rec: true, hint: 'Uno tras otro, sin espacios.' },
        { valor: 'elegir', label: 'Elegir yo los bloques', hint: 'Marca solo las horas que trabajas.' }
    ], (valor) => {
        if (valor === 'elegir') {
            _state.bloquesModo = 'elegir';
            burbujaUser('Elegir yo los bloques');
            burbujaBot(`Marca los bloques que trabajas (de ${dur} min, entre ${_state.horaInicio} y ${_state.horaFin}):`);
            bloqueMultiSelect(candidatas.map(h => ({ valor: h, label: h })), (elegidos) => {
                _state.bloquesElegidos = elegidos.slice().sort();
                burbujaUser(`${elegidos.length} bloque(s): ${elegidos.join(', ')}`);
                actualizarResumen();
                pasoCupos();
            }, { errorVacio: 'Marca al menos un bloque 😉' });
        } else {
            _state.bloquesModo = 'corridos';
            _state.bloquesElegidos = null;
            burbujaUser(`Corridos (${corridos} bloques de ${dur} min)`);
            actualizarResumen();
            pasoCupos();
        }
    });
}

function pasoCupos() {
    _state.paso = 12;
    const nBloques = bloquesDe(_state).length;
    burbujaBot(`¿A cuántos clientes puedes atender <strong>a la vez</strong> en cada bloque?<br><span class="svcchat-sub">Aplica a tus ${nBloques} bloque(s). Si haces clases grupales, elige más de 1.</span>`);
    bloqueOpciones([
        { valor: 1, label: '1 cliente', hint: 'Atención personalizada', rec: true },
        { valor: 2, label: '2 clientes' },
        { valor: 4, label: '4 clientes' },
        { valor: 6, label: '6 clientes', hint: 'Clases grupales' }
    ], (valor) => {
        _state.cupos = valor;
        burbujaUser(valor === 1 ? '1 cliente a la vez' : `${valor} clientes a la vez`);
        actualizarResumen();
        pasoResumenFinal();
    }, {
        conOtro: true,
        otroLabel: 'Otro número…',
        otroPlaceholder: 'Cupos por bloque (ej: 3, 8, 10)',
        inputmode: 'numeric',
        validarOtro: (v) => {
            const n = parseInt(v.replace(/[^0-9]/g, ''), 10);
            return (n && n >= 1 && n <= 100) ? null : 'Elige entre 1 y 100';
        },
        parseOtro: (v) => parseInt(v.replace(/[^0-9]/g, ''), 10)
    });
}

// ============================================================
// Resumen final + acciones
// ============================================================
function pasoResumenFinal() {
    _state.paso = 99;
    const fechas = calcularFechas(diasEfectivos(_state), fechaDesdeISO(_state), fechaHastaISO(_state));
    const bloques = bloquesDe(_state);
    const esPromo = _state.modalidad === 'promocion';

    burbujaBot(`
        <div class="svcchat-msg-titulo">¡Listo! 🎉 Así quedó tu servicio</div>
        <div class="svcchat-tarjeta-final">
            <div class="svcchat-final-nombre"><i class="fas fa-tag"></i> ${escapeHtml(_state.nombre)}</div>
            <div class="svcchat-final-fila"><span>Modalidad</span><strong>${esPromo ? `Pack de ${_state.numSesiones} sesiones` : 'Sesión suelta'}</strong></div>
            <div class="svcchat-final-fila"><span>Precio</span><strong>${esPromo ? `${CLP(_state.precioSesion)} sesión · ${CLP(_state.precioPack)} el pack` : CLP(_state.precioSesion)}</strong></div>
            <div class="svcchat-final-fila"><span>Duración</span><strong>${_state.duracion} min</strong></div>
            <div class="svcchat-final-fila"><span>Disponible</span><strong>${etiquetaDias(_state)} · ${_state.horaInicio} a ${_state.horaFin}</strong></div>
            <div class="svcchat-final-fila"><span>Bloques</span><strong>${bloques.length} de ${_state.duracion} min${_state.bloquesModo === 'elegir' ? ' (elegidos)' : ''}</strong></div>
            <div class="svcchat-final-fila"><span>Cupos por bloque</span><strong>${_state.cupos} cliente${_state.cupos > 1 ? 's' : ''}</strong></div>
            <div class="svcchat-final-fila"><span>Vigencia</span><strong>${fmtFechaLegible(fechaDesdeISO(_state))} → ${fmtFechaLegible(fechaHastaISO(_state))} · ${fechas.length} día(s) con horario</strong></div>
        </div>
        <p class="svcchat-sub" style="margin-top:8px;">💡 Foto y descripción puedes agregarlas después desde Mis Servicios → Editar.</p>
    `);

    const acciones = document.createElement('div');
    acciones.className = 'svcchat-acciones';
    acciones.innerHTML = `
        <button type="button" class="svcchat-btn-publicar" id="svcchat-publicar"><i class="fas fa-rocket"></i> Publicar servicio 🎉</button>
        <button type="button" class="svcchat-btn-copiar" id="svcchat-copiar"><i class="fas fa-copy"></i> Crear otro parecido</button>
        <button type="button" class="svcchat-btn-manual" id="svcchat-manual"><i class="fas fa-list-alt"></i> Revisar en el formulario</button>
    `;
    _el.conv.appendChild(acciones);
    acciones.querySelector('#svcchat-publicar').addEventListener('click', () => publicar(false));
    acciones.querySelector('#svcchat-copiar').addEventListener('click', () => publicar(true));
    acciones.querySelector('#svcchat-manual').addEventListener('click', mostrarForm);
    scrollAbajo();
}

function etiquetaDias(s) {
    const dias = diasEfectivos(s);
    if (dias.length === 7) return 'Todos los días';
    if (dias.length === 5 && !dias.includes(0) && !dias.includes(6)) return 'Lun a Vie';
    if (dias.length === 2 && dias.includes(0) && dias.includes(6)) return 'Sáb y Dom';
    return 'Días: ' + dias.map(v => (DIAS_SEMANA.find(d => d.v === v) || {}).label || v).join(', ');
}

// ============================================================
// Resumen en vivo (lateral)
// ============================================================
function actualizarResumen() {
    const s = _state;
    const body = _el.resumen;
    if (!body) return;

    const esPromo = s.modalidad === 'promocion';
    const fila = (k, v) => (v ? `<div class="svcchat-rsm-fila"><span>${k}</span><strong>${v}</strong></div>` : '');

    let vigencia = '';
    let nDias = null;
    if (s.paso >= 8) {
        const desde = fechaDesdeISO(s);
        const hasta = fechaHastaISO(s);
        nDias = calcularFechas(diasEfectivos(s), desde, hasta).length;
        vigencia = `${fmtFechaLegible(desde)} → ${fmtFechaLegible(hasta)}`;
    }

    body.innerHTML = `
        <div class="svcchat-rsm-preview">
            ${s.nombre ? `<div class="svcchat-rsm-nombre">${escapeHtml(s.nombre)}</div>` : '<div class="svcchat-rsm-vacio">[Nombre del servicio]</div>'}
            ${s.precioSesion ? `<div class="svcchat-rsm-precio">${CLP(s.precioSesion)}${esPromo ? ' · pack ' + CLP(s.precioPack) : ''}</div>` : ''}
            ${s.duracion ? `<div class="svcchat-rsm-chip">${s.duracion} min</div>` : ''}
        </div>
        ${fila('Modalidad', esPromo ? `Pack de ${s.numSesiones}` : (s.paso >= 2 ? 'Sesión suelta' : ''))}
        ${fila('Días', s.paso >= 7 ? etiquetaDias(s) : '')}
        ${fila('Vigencia', vigencia + (nDias !== null ? ` · ${nDias} día(s)` : ''))}
        ${fila('Horario', s.paso >= 10 ? `${s.horaInicio} a ${s.horaFin}` : '')}
        ${fila('Bloques', s.paso >= 11 ? `${bloquesDe(s).length} de ${s.duracion} min` : '')}
        ${fila('Cupos', s.paso >= 12 ? `${s.cupos} por bloque` : '')}
    `;
}

// ============================================================
// Prefill del formulario real (parcial o completo)
// ============================================================
function aplicarEnFormulario(fechas, bloques) {
    const s = _state;
    const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val;
    };
    if (s.nombre) setVal('srv-name', s.nombre);
    if (s.precioSesion) setVal('srv-price', s.precioSesion);
    if (s.duracion) setVal('srv-duration', s.duracion);
    setVal('srv-desc', '');
    setVal('srv-image-url', '');
    const activo = document.getElementById('srv-active');
    if (activo) activo.checked = true;
    const destacado = document.getElementById('srv-featured');
    if (destacado) destacado.checked = true;

    const radioPromo = document.querySelector('input[name="srv-tipo-venta"][value="promocion"]');
    const radioSesion = document.querySelector('input[name="srv-tipo-venta"][value="sesion"]');
    if (s.modalidad === 'promocion' && radioPromo) {
        radioPromo.checked = true;
        radioPromo.dispatchEvent(new Event('change', { bubbles: true }));
        if (s.numSesiones) setVal('srv-promo-sesiones', s.numSesiones);
        if (s.precioPack) setVal('srv-promo-precio', s.precioPack);
        const pp = document.getElementById('srv-promo-precio');
        if (pp) pp.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (radioSesion) {
        radioSesion.checked = true;
        radioSesion.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const dur = document.getElementById('srv-duration');
    if (dur) dur.dispatchEvent(new Event('input', { bubbles: true }));

    if (fechas && fechas.length && typeof window.generarFechasPorRango === 'function') {
        const rIni = document.getElementById('range-start');
        const rFin = document.getElementById('range-end');
        if (rIni && rFin) {
            rIni.value = fechas[0];
            rFin.value = fechas[fechas.length - 1];
            document.querySelectorAll('.dia-semana-checkbox').forEach(cb => { cb.checked = false; });
            new Set(fechas.map(f => new Date(f + 'T12:00:00').getDay())).forEach(dia => {
                const cb = document.querySelector(`.dia-semana-checkbox[value="${dia}"]`);
                if (cb) cb.checked = true;
            });
            window.generarFechasPorRango();
        }
    }

    if (bloques && bloques.length) {
        window.serviceModules = bloques.map(b => ({ ...b, cupos: _state.cupos || b.cupos }));
        window.moduleDateCupos = {};
        try {
            if (typeof saveModulesToHiddenField === 'function') saveModulesToHiddenField();
        } catch (e) { /* no crítico */ }
    }
    window.dispatchEvent(new CustomEvent('servicio-modulos-actualizados'));
}

// Aplica lo conversado hasta ahora (para "Rellenar manual" a mitad de chat).
function aplicarAvanceEnFormulario() {
    const s = _state;
    let fechas = null;
    if (s.paso >= 8) {
        fechas = calcularFechas(diasEfectivos(s), fechaDesdeISO(s), fechaHastaISO(s));
    }
    let bloques = null;
    if (s.paso >= 11) {
        bloques = bloquesDe(s);
    }
    aplicarEnFormulario(fechas, bloques);
}

// Prefill completo + verificación de paridad (para Publicar).
function rellenarFormularioReal() {
    const s = _state;
    const fechas = calcularFechas(diasEfectivos(s), fechaDesdeISO(s), fechaHastaISO(s));
    if (!fechas.length) return 'No hay fechas disponibles para lo elegido. Prueba con más días o más tiempo.';
    const bloques = bloquesDe(s);
    if (!bloques.length) return 'No hay bloques de horario: revisa la hora de inicio/fin, la duración o los bloques elegidos.';

    // Módulos ANTES de generar fechas (para verificar paridad después).
    window.serviceModules = bloques.map(b => ({ ...b, cupos: s.cupos }));
    window.moduleDateCupos = {};

    aplicarEnFormulario(fechas, bloques);

    // Paridad: el form debe quedar con EXACTAMENTE las fechas anunciadas.
    let persistidas = [];
    try {
        persistidas = Object.keys(window.generarDisponibilidadFinal() || {}).sort();
    } catch (e) {
        console.warn('[svcchat] No se pudo verificar fechas:', e);
    }
    if (persistidas.length !== fechas.length) {
        return `Se generaron ${persistidas.length} de ${fechas.length} fechas en el formulario. Recarga la página y vuelve a intentarlo.`;
    }
    return null;
}

function esperarRefrescoWorkers(ms) {
    return new Promise(res => setTimeout(res, ms || 220));
}

// Si el negocio exige trabajador, pregunta quién lo atiende (DOM real).
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
            burbujaBot('⚠️ Ningún trabajador con horario cubre este servicio. Publícalo desde <strong>Rellenar manual</strong> para elegir la asignación correcta.');
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

    // Base para "Crear otro parecido" (antes de que el estado cambie).
    const copiaBase = _state ? { ..._state, nombre: '' } : null;

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
        // Servicio creado: reset para la próxima visita.
        _state = null;
        _el.conv.innerHTML = '';
        if (crearCopia && copiaBase) {
            setTimeout(() => {
                if (typeof window.navigateTo === 'function') window.navigateTo('crear-servicio');
                if (typeof window.limpiarEstadoEdicion === 'function') window.limpiarEstadoEdicion();
                _state = { ...estadoInicial(), ...copiaBase, paso: 1 };
                // mostrarChat (vía observer/navegación) continúa la copia sin repintar.
                if (_modo !== 'chat') mostrarChat({ silencioso: true });
                _el.conv.innerHTML = '';
                burbujaBot('¡Publicado! 🎉 Ahora creemos <strong>otro parecido</strong> con los mismos datos.');
                _state.paso = 0;
                pasoNombre('¿Cómo se llama esta copia?');
            }, 700);
        }
        return;
    }

    // Fallo de validación legacy: los datos quedaron en el formulario.
    burbujaBot('⚠️ El formulario marcó un aviso (revisa abajo los campos en rojo).<br>Tus datos quedaron cargados: toca <strong>Rellenar manual</strong> para corregir y pulsar CREAR SERVICIO, o cambia tus respuestas aquí.');
    if (crearSection) crearSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
