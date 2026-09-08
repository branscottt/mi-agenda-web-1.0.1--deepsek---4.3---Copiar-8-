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

import { getSupabase } from '../../shared/infrastructure/supabase.js';

const MAX_FECHAS = 400; // tope defensivo (1 año "todos los días" ≈ 366)
const CLP = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-CL');
// Precio 0 = servicio gratuito: se muestra "Gratis" (el resto como $CLP).
const fmtPrecio = (n) => (n === 0 ? 'Gratis' : CLP(n));

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
// ── Edición conversacional ──
let _editando = false;        // true mientras se edita un servicio por chat
let _editConvIniciada = false;// la conversación de edición ya se pintó
let _editHookPuesto = false;  // listener del evento legacy (una sola vez)

// ── Foto de tarjeta + rondas ("volver a una respuesta anterior") ────────
let _rondas = [];               // rondas de pregunta vivas: { ctl, respondida }
let _fotoSubiendo = false;      // true mientras sube una foto (bloquea volver)
let _guardandoEdicionChat = false;
let _inputFoto = null;          // input[type=file] oculto reutilizable (fuera del conv)
let _fotoFuenteData = null;     // dataURL del archivo original (para re-encuadrar)
let _burbujaFotoPreview = null; // burbuja con la foto en vivo (se actualiza al reajustar)

const DIAS_SEMANA = [
    { v: 1, label: 'Lun' }, { v: 2, label: 'Mar' }, { v: 3, label: 'Mié' },
    { v: 4, label: 'Jue' }, { v: 5, label: 'Vie' }, { v: 6, label: 'Sáb' }, { v: 0, label: 'Dom' }
];
const NOMBRES_DIA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const nombreDia = (d) => NOMBRES_DIA[d] || ('Día ' + d);
// Orden semanal Lun→Dom para listas estables de días.
const ORDEN_DIAS = [1, 2, 3, 4, 5, 6, 0];
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
    // Edición conversacional: editarServicio (legacy) avisa cuando terminó de
    // cargar el formulario → el chat aparece preguntando qué cambiar.
    if (!_editHookPuesto) {
        _editHookPuesto = true;
        window.addEventListener('servicio-edicion-iniciada', () => {
            setTimeout(() => {
                if (estaEditando() && section && section.style.display !== 'none') {
                    iniciarChatEdicion();
                }
            }, 350);
        });
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
    if (_editando) {
        if (header) header.innerHTML = _modo === 'chat'
            ? '<i class="fas fa-comments"></i> Editando por chat'
            : '<i class="fas fa-edit"></i> Editando Servicio (formulario completo)';
        if (btn) btn.innerHTML = _modo === 'chat'
            ? '<i class="fas fa-keyboard"></i> Ver formulario completo'
            : '<i class="fas fa-comments"></i> Editar conversando';
        return;
    }
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

    if (_editando) {
        // En edición el chat NO reinicia el form: continúa la conversación.
        pintarCabeceraModo();
        if (!_editConvIniciada) iniciarChatEdicion();
        return;
    }

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
    _editando = false;
    _editConvIniciada = false;
    if (typeof window.limpiarEstadoEdicion === 'function') window.limpiarEstadoEdicion();
    _state = estadoInicial();
    limpiarConv();
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

    if (_editando) {
        // En edición, volver al formulario completo conserva todo lo cargado.
        _modo = 'form';
        form.style.display = '';
        _el.view.style.display = 'none';
        pintarCabeceraModo();
        return;
    }

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
        cupos: 1,
        // Excepciones de horario (jerarquía fecha > día > general en el legacy):
        // excepcionesDias: { dia(0-6): [bloques] } | null = sin excepciones
        excepcionesDias: null,
        // fechasEspeciales: { 'YYYY-MM-DD': [bloques] } | null = sin fechas especiales
        fechasEspeciales: null,
        // Foto de la tarjeta: URL pública ya subida (null = sin foto).
        imagenUrl: null
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
    const txt = document.createElement('span');
    txt.className = 'svcchat-user-text';
    txt.textContent = texto;
    div.appendChild(txt);
    // Botón para volver a la pregunta que originó esta respuesta.
    const volver = document.createElement('button');
    volver.type = 'button';
    volver.className = 'svcchat-user-volver';
    volver.title = 'Volver a esta respuesta para corregirla';
    volver.setAttribute('aria-label', 'Volver a esta respuesta');
    volver.innerHTML = '<i class="fas fa-undo-alt"></i>';
    volver.addEventListener('click', () => {
        const ctl = ctlDeBurbuja(div);
        if (ctl) volverARonda(ctl);
    });
    div.appendChild(volver);
    _el.conv.appendChild(div);
    scrollAbajo();
    return div;
}

// ── Rondas: infraestructura para "volver a una respuesta anterior" ──────
// Cada control de pregunta (opciones/input/fecha/multiselect/horas) se
// registra como una "ronda". Responder la marca como usada (el control queda
// deshabilitado y atenuado); volver a una burbuja de respuesta reabre su
// ronda: recorta la conversación posterior y deja el control listo para
// responder de nuevo (con la respuesta previa visible para corregirla).
function limpiarConv() {
    if (_el && _el.conv) _el.conv.innerHTML = '';
    _rondas = [];
    _fotoFuenteData = null;
    _burbujaFotoPreview = null;
}

function registrarRonda(ctl, responder) {
    ctl.dataset.svcctl = '1';
    const ronda = { ctl, respondida: false };
    _rondas.push(ronda);
    return (...args) => {
        if (!ronda.respondida) {
            ronda.respondida = true;
            marcarControlUsado(ctl);
        }
        return responder(...args);
    };
}

function marcarControlUsadoDe(ctl) {
    const r = _rondas.find(x => x.ctl === ctl);
    if (r && !r.respondida) {
        r.respondida = true;
        marcarControlUsado(ctl);
    }
}

function marcarControlUsado(ctl) {
    ctl.classList.add('svcchat-ctl-usado');
    ctl.querySelectorAll('button, input, select, textarea').forEach(el => { el.disabled = true; });
}

function rehabilitarControl(ctl) {
    ctl.classList.remove('svcchat-ctl-usado', 'svcchat-input-usado', 'svcchat-input-error');
    ctl.querySelectorAll('button, input, select, textarea').forEach(el => { el.disabled = false; });
    ctl.querySelectorAll('.svcchat-input-usado, .svcchat-input-error').forEach(el => el.classList.remove('svcchat-input-usado', 'svcchat-input-error'));
    // El botón "Otro…" pudo quedar oculto al desplegar su input libre.
    ctl.querySelectorAll('.svcchat-opt-otro').forEach(b => { b.style.display = ''; });
    // Si quedó un input-libre respondido a la vista, se limpia (se reabre con "Otro…").
    ctl.querySelectorAll('.svcchat-otro-row').forEach(r => r.remove());
}

function ctlDeBurbuja(burbuja) {
    let nodo = burbuja.previousSibling;
    while (nodo) {
        if (nodo.nodeType === 1 && nodo.dataset && nodo.dataset.svcctl === '1') return nodo;
        nodo = nodo.previousSibling;
    }
    return null;
}

function volverARonda(ctl) {
    if (!ctl || _publicando || _fotoSubiendo || _guardandoEdicionChat) return;
    const idx = _rondas.findIndex(r => r.ctl === ctl);
    if (idx < 0) return;
    // Recortar el DOM: todo lo posterior a esta pregunta se descarta
    // (respuestas, burbujas del bot, resumen final…). Al re-responder,
    // el flujo vuelve a preguntar lo siguiente en orden.
    let nodo = ctl.nextSibling;
    while (nodo) {
        const sig = nodo.nextSibling;
        nodo.remove();
        nodo = sig;
    }
    _rondas.length = idx + 1;
    const ronda = _rondas[idx];
    ronda.respondida = false;
    rehabilitarControl(ctl);
    // Destello suave para ubicar la pregunta reabierta.
    ctl.classList.add('svcchat-reabierta');
    setTimeout(() => ctl.classList.remove('svcchat-reabierta'), 1600);
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
    // Listener real de respuesta; se envuelve al registrar la ronda.
    let responder = (...args) => alElegir(...args);

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
            b.addEventListener('click', () => {
                // Marca visual de la opción elegida (orienta al reabrir la ronda).
                wrap.querySelectorAll('.svcchat-opt-elegida').forEach(x => x.classList.remove('svcchat-opt-elegida'));
                b.classList.add('svcchat-opt-elegida');
                responder(op.valor, op);
            });
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
                // Los presets pasan a "usados": la respuesta vendrá del sub-control.
                marcarControlUsadoDe(wrap);
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
                responder(opts.parseOtro ? opts.parseOtro(val) : val, { otro: true, texto: val });
            });
            wrap.appendChild(form);
        }
    }

    responder = registrarRonda(wrap, responder);

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
    let responder = (...a) => alEnviar(...a);
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
        responder(input.value.trim());
    });
    input.addEventListener('input', () => input.classList.remove('svcchat-input-error'));
    responder = registrarRonda(form, responder);
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
    let responder = (...a) => alEnviar(...a);
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
        responder(input.value);
    });
    responder = registrarRonda(form, responder);
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
    let confirmar = (...a) => alConfirmar(...a);
    btn.addEventListener('click', () => {
        if (!elegidos.size) {
            burbujaBot(opts.errorVacio || 'Elige al menos una opción 😉');
            return;
        }
        confirmar([...elegidos]);
    });
    confirmar = registrarRonda(wrap, confirmar);
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
        ? '¿Cuánto cobras por <strong>una sesión suelta</strong>? (el cliente también podrá pagar el pack completo)<br><span class="svcchat-sub">Si es gratis, escribe 0.</span>'
        : '¿Cuánto cobras por sesión?<br><span class="svcchat-sub">Si el servicio es gratis, escribe 0.</span>');
    bloqueInput(esPromo ? 'Precio de la sesión suelta ($)' : 'Precio de la sesión ($)', {
        inputmode: 'numeric',
        validar: (v) => {
            const n = parseFloat(String(v).replace(/[^0-9]/g, ''));
            return (Number.isFinite(n) && n >= 0) ? null : 'Ingresa un precio (0 si es gratis)';
        }
    }, (valor) => {
        const n = parseFloat(valor.replace(/[^0-9]/g, ''));
        _state.precioSesion = n;
        burbujaUser(fmtPrecio(n));
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
    burbujaBot(sugerido > 0
        ? `¿Cuánto cuesta el pack de <strong>${_state.numSesiones}</strong>?<br>
        <span class="svcchat-sub">Sugerencia: ${CLP(sugerido)} — con 15% de descuento ganas lo mismo y el cliente paga por adelantado.</span>`
        : `¿Cuánto cuesta el pack de <strong>${_state.numSesiones}</strong>?<br>
        <span class="svcchat-sub">Como la sesión es gratis, el pack también puede serlo.</span>`);
    bloqueOpciones([
        { valor: 'sugerido', label: sugerido > 0 ? `Usar ${CLP(sugerido)} (15% off)` : 'Gratis también ($0)', rec: true },
        { valor: 'otro', label: 'Poner otro precio' }
    ], (valor) => {
        if (valor === 'sugerido') {
            _state.precioPack = sugerido;
            burbujaUser(fmtPrecio(sugerido));
            actualizarResumen();
            pasoDuracion();
        } else {
            burbujaUser('Poner otro precio');
            bloqueInput('Precio total del pack ($)', {
                inputmode: 'numeric',
                validar: (v) => {
                    const n = parseFloat(String(v).replace(/[^0-9]/g, ''));
                    return (Number.isFinite(n) && n >= 0) ? null : 'Ingresa un precio (0 si es gratis)';
                }
            }, (valor2) => {
                const n2 = parseFloat(valor2.replace(/[^0-9]/g, ''));
                if ((_state.precioSesion || 0) > 0 && n2 >= (_state.precioSesion || 0) * _state.numSesiones) {
                    burbujaBot('Ese precio no tiene descuento (es mayor o igual al valor real). Usa el sugerido o un precio menor 😉');
                }
                _state.precioPack = n2;
                burbujaUser(fmtPrecio(n2));
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

// Duración vigente: la del estado de creación o la del form real (edición).
function duracionActual() {
    if (_state && _state.duracion) return _state.duracion;
    const dur = parseInt(document.getElementById('srv-duration')?.value, 10);
    return (dur && dur >= 5 && dur <= 480) ? dur : 60;
}

// ── Reutilizable: rango de horas (selects inicio/fin) ─────────────────────
// Pregunta entre qué horas se atiende y sigue con alRango(ini, fin).
function preguntarRangoHoras(tituloHtml, iniDef, finDef, alRango) {
    burbujaBot(tituloHtml);
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
    let responder = (...a) => alRango(...a);
    for (let h = 5; h <= 22; h++) {
        const v = String(h).padStart(2, '0') + ':00';
        const o = new Option(v, v);
        if (v === iniDef) o.selected = true;
        selIni.appendChild(o);
    }
    for (let h = 6; h <= 23; h++) {
        const v = String(h).padStart(2, '0') + ':00';
        const o = new Option(v, v);
        if (v === finDef) o.selected = true;
        selFin.appendChild(o);
    }
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const ini = selIni.value;
        const fin = selFin.value;
        if (horaAMin(fin) - horaAMin(ini) < duracionActual()) {
            burbujaBot(`Necesitas al menos ${duracionActual()} min entre la hora de inicio y la de fin 😉`);
            return;
        }
        selIni.disabled = true;
        selFin.disabled = true;
        form.querySelector('button').disabled = true;
        form.classList.add('svcchat-input-usado');
        burbujaUser(`${ini} a ${fin}`);
        responder(ini, fin);
    });
    responder = registrarRonda(form, responder);
    _el.conv.appendChild(form);
    scrollAbajo();
}

// ── Reutilizable: bloques corridos vs elegidos a mano ─────────────────────
// alFinal({ modo: 'corridos'|'elegir', elegidos: [hh:mm] | null })
function preguntarTipoBloques(ini, fin, alFinal) {
    const dur = duracionActual();
    const candidatas = horasCandidatas(ini, fin, dur);
    const corridos = candidatas.length;
    burbujaBot(`¿Cómo armamos los <strong>bloques de atención</strong>?<br>
        <span class="svcchat-sub">Entre ${ini} y ${fin}, corridos serían <strong>${corridos} bloques de ${dur} min</strong>. Si tienes descansos o solo atiendes a ciertas horas, elige tú los bloques.</span>`);
    bloqueOpciones([
        { valor: 'corridos', label: `Corridos (${corridos} bloques de ${dur} min)`, rec: true, hint: 'Uno tras otro, sin espacios.' },
        { valor: 'elegir', label: 'Elegir yo los bloques', hint: 'Marca solo las horas que trabajas.' }
    ], (valor) => {
        if (valor === 'elegir') {
            burbujaUser('Elegir yo los bloques');
            burbujaBot(`Marca los bloques que trabajas (de ${dur} min, entre ${ini} y ${fin}):`);
            bloqueMultiSelect(candidatas.map(h => ({ valor: h, label: h })), (elegidos) => {
                burbujaUser(`${elegidos.length} bloque(s): ${elegidos.join(', ')}`);
                alFinal({ modo: 'elegir', elegidos });
            }, { errorVacio: 'Marca al menos un bloque 😉' });
        } else {
            burbujaUser(`Corridos (${corridos} bloques de ${dur} min)`);
            alFinal({ modo: 'corridos', elegidos: null });
        }
    });
}

function pasoHorario() {
    _state.paso = 10;
    preguntarRangoHoras(`¿<strong>Entre qué horas</strong> trabajas este servicio?<br>
        <span class="svcchat-sub">Después eliges si son bloques corridos o los marcas tú (descansos, clases puntuales, etc.).</span>`, _state.horaInicio, _state.horaFin, (ini, fin) => {
        _state.horaInicio = ini;
        _state.horaFin = fin;
        actualizarResumen();
        pasoBloques();
    });
}

function pasoBloques() {
    _state.paso = 11;
    preguntarTipoBloques(_state.horaInicio, _state.horaFin, ({ modo, elegidos }) => {
        if (modo === 'elegir') {
            _state.bloquesModo = 'elegir';
            _state.bloquesElegidos = elegidos;
        } else {
            _state.bloquesModo = 'corridos';
            _state.bloquesElegidos = null;
        }
        actualizarResumen();
        pasoCupos();
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
        pasoVariacionHorarios();
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
// ============================================================
// Paso 13-14: horarios por día de la semana y fechas especiales
// Jerarquía real del guardado: fecha específica > día de semana > general.
// ============================================================
function pasoVariacionHorarios() {
    _state.paso = 13;
    burbujaBot(`¿El horario de <strong>${etiquetaDias(_state)}</strong> es el mismo todas las semanas?<br><span class="svcchat-sub">Si algún día atiendes en otro horario (ej. el lunes solo hasta las 13:00) o con otros bloques, lo configuramos ahora.</span>`);
    bloqueOpciones([
        { valor: 'igual', label: 'Igual todos los días', rec: true },
        { valor: 'variar', label: 'Cambia según el día' }
    ], (valor) => {
        if (valor === 'igual') {
            _state.excepcionesDias = null;
            _state.fechasEspeciales = null;
            burbujaUser('Igual todos los días');
            actualizarResumen();
            pasoFechasEspeciales();
            return;
        }
        burbujaUser('Cambia según el día');
        _state.excepcionesDias = {};
        const activos = diasEfectivos(_state);
        const items = ORDEN_DIAS.filter(d => activos.includes(d)).map(d => ({ valor: d, label: nombreDia(d) }));
        burbujaBot(`¿Qué días tienen <strong>otro horario</strong>?<br><span class="svcchat-sub">Los días que no marques quedan con el horario general (${_state.horaInicio} a ${_state.horaFin}).</span>`);
        bloqueMultiSelect(items, (elegidos) => {
            burbujaUser('Otro horario: ' + elegidos.map(d => nombreDia(d)).join(', '));
            _state._diasPorPersonalizar = elegidos.slice().sort((a, b) => ORDEN_DIAS.indexOf(a) - ORDEN_DIAS.indexOf(b));
            preguntarHorarioDeDia();
        }, { errorVacio: 'Marca al menos un día con horario distinto 😉' });
    });
}

// Pregunta el horario de cada día marcado, uno por uno (orden Lun→Dom).
function preguntarHorarioDeDia() {
    const lista = _state._diasPorPersonalizar;
    if (!lista || !lista.length) {
        _state._diasPorPersonalizar = null;
        actualizarResumen();
        pasoFechasEspeciales();
        return;
    }
    const dia = lista.shift();
    const nom = nombreDia(dia);
    preguntarRangoHoras(`¿A qué horas atiende el <strong>${nom}</strong>?<br><span class="svcchat-sub">Así queda solo el ${nom}; los demás días siguen con lo conversado.</span>`, _state.horaInicio, _state.horaFin, (ini, fin) => {
        preguntarTipoBloques(ini, fin, ({ modo, elegidos }) => {
            _state.excepcionesDias[dia] = (modo === 'elegir')
                ? elegidos.map(h => ({ startTime: h, endTime: minAHora(horaAMin(h) + _state.duracion), duration: _state.duracion, editable: true }))
                : generarBloques(ini, fin, _state.duracion);
            actualizarResumen();
            preguntarHorarioDeDia();
        });
    });
}

function pasoFechasEspeciales() {
    _state.paso = 14;
    const desde = fechaDesdeISO(_state);
    const hasta = fechaHastaISO(_state);
    burbujaBot(`¿Alguna <strong>fecha puntual</strong> con otro horario?<br><span class="svcchat-sub">Ej: un festivo o un día con atención especial. La fecha debe caer en un día que atiendes y dentro de la vigencia (${fmtFechaLegible(desde)} → ${fmtFechaLegible(hasta)}).</span>`);
    bloqueOpciones([
        { valor: 'no', label: 'No, así está bien', rec: true },
        { valor: 'si', label: 'Sí, agregar fechas…' }
    ], (valor) => {
        if (valor === 'no') {
            _state.fechasEspeciales = null;
            burbujaUser('No, así está bien');
            pasoFoto();
            return;
        }
        burbujaUser('Sí, agregar fechas…');
        _state.fechasEspeciales = _state.fechasEspeciales || {};
        preguntarUnaFechaEspecial();
    });
}

function preguntarUnaFechaEspecial() {
    const desde = fechaDesdeISO(_state);
    const hasta = fechaHastaISO(_state);
    const ya = Object.keys(_state.fechasEspeciales || {}).filter(f => _state.fechasEspeciales[f] && _state.fechasEspeciales[f].length).length;
    if (ya >= 20) {
        burbujaBot('Llegaste a 20 fechas especiales (máximo por servicio). Puedes ajustarlas desde Mis Servicios → Editar 😉');
        pasoFoto();
        return;
    }
    burbujaBot(ya
        ? `¿Otra fecha especial? (${fmtFechaLegible(desde)} → ${fmtFechaLegible(hasta)})`
        : 'Elige la fecha:');
    bloqueFecha(desde, (f) => {
        if (f > hasta) {
            burbujaBot(`Esa fecha queda fuera de la vigencia (hasta ${fmtFechaLegible(hasta)}). Elige una anterior 😉`);
            preguntarUnaFechaEspecial();
            return;
        }
        const dia = new Date(f + 'T12:00:00').getDay();
        if (!diasEfectivos(_state).includes(dia)) {
            burbujaBot(`El ${fmtFechaLegible(f)} cae <strong>${nombreDia(dia)}</strong>, que no está en tus días de atención (${etiquetaDias(_state)}). Elige una fecha que caiga en esos días 😉`);
            preguntarUnaFechaEspecial();
            return;
        }
        if (_state.fechasEspeciales[f] && _state.fechasEspeciales[f].length) {
            burbujaBot('Esa fecha ya tiene horario especial. Elige otra 😉');
            preguntarUnaFechaEspecial();
            return;
        }
        const nom = fmtFechaLegible(f);
        burbujaUser('Fecha especial: ' + nom);
        preguntarRangoHoras(`¿A qué horas atiendes el <strong>${nom}</strong>?`, _state.horaInicio, _state.horaFin, (ini, fin) => {
            preguntarTipoBloques(ini, fin, ({ modo, elegidos }) => {
                _state.fechasEspeciales[f] = (modo === 'elegir')
                    ? elegidos.map(h => ({ startTime: h, endTime: minAHora(horaAMin(h) + _state.duracion), duration: _state.duracion, editable: true }))
                    : generarBloques(ini, fin, _state.duracion);
                actualizarResumen();
                burbujaBot('¿Agregar <strong>otra fecha</strong> especial?');
                bloqueOpciones([
                    { valor: 'si', label: 'Sí, otra fecha' },
                    { valor: 'no', label: 'No, listo', rec: true }
                ], (v2) => {
                    if (v2 === 'si') {
                        burbujaUser('Sí, otra fecha');
                        preguntarUnaFechaEspecial();
                    } else {
                        burbujaUser('No, listo');
                        pasoFoto();
                    }
                });
            });
        });
    });
}

// ============================================================
// FOTO DE LA TARJETA (paso 15) — elegir, recortar/encuadrar y confirmar
// ============================================================
function pasoFoto() {
    _state.paso = 15;
    const ya = _state.imagenUrl;
    burbujaBot(`¿Quieres ponerle <strong>foto a la tarjeta</strong>?<br>
        <span class="svcchat-sub">Es lo primero que ven tus clientes al reservar${ya ? ' (ya tienes una: puedes ajustarla o reemplazarla)' : ''}. La foto es opcional.</span>`);
    const opciones = [];
    if (ya && _fotoFuenteData) opciones.push({ valor: 'ajustar', label: '🔍 Ajustar el encuadre actual' });
    opciones.push({ valor: 'subir', label: ya ? '📷 Reemplazar con otra foto' : '📷 Subir una foto' });
    opciones.push({ valor: 'no', label: ya ? '🚫 Quitar la foto' : 'Sin foto, seguir', rec: !ya });
    bloqueOpciones(opciones, (valor) => {
        if (valor === 'no') {
            burbujaUser(ya ? 'Quitar la foto' : 'Sin foto, seguir');
            if (ya) {
                _state.imagenUrl = null;
                if (_burbujaFotoPreview && _burbujaFotoPreview.isConnected) _burbujaFotoPreview.remove();
                _burbujaFotoPreview = null;
            }
            actualizarResumen();
            return pasoResumenFinal();
        }
        burbujaUser(valor === 'ajustar' ? 'Ajustar el encuadre' : 'Subir una foto');
        fotoPrepararYRecortar();
    });
}

// Subir/reemplazar/ajustar: garantiza una fuente en memoria y abre el modal.
async function fotoPrepararYRecortar() {
    const origen = _state.imagenUrl;
    if (!_fotoFuenteData) {
        const file = await elegirArchivoFoto();
        if (!file) {
            burbujaBot(origen
                ? 'Ok, dejamos la foto como estaba.'
                : 'Ok, sin foto por ahora. Puedes reintentar tocando ↩ en tu respuesta.');
            return pasoResumenFinal();
        }
        const dataUrl = await leerArchivoDataURL(file);
        if (!dataUrl) {
            burbujaBot('⚠️ No se pudo leer esa imagen (usa JPG, PNG o WebP de hasta 10 MB).');
            return pasoResumenFinal();
        }
        _fotoFuenteData = dataUrl;
    }
    const blob = await abrirAjusteFoto(_fotoFuenteData);
    if (!blob) {
        burbujaBot(origen
            ? 'Ok, dejamos la foto como estaba.'
            : 'Ok, sin foto por ahora. Puedes reintentar tocando ↩ en tu respuesta.');
        return pasoResumenFinal();
    }
    await fotoSubirYCerrarPregunta(blob, false);
}

// Re-encuadre desde la pregunta "¿Cómo quedó?": deja la pregunta abierta.
async function fotoReajustar() {
    if (!_fotoFuenteData) {
        const file = await elegirArchivoFoto();
        if (!file) { reabrirUltimaPregunta(); return; }
        const dataUrl = await leerArchivoDataURL(file);
        if (!dataUrl) { reabrirUltimaPregunta(); return burbujaBot('⚠️ No se pudo leer esa imagen.'); }
        _fotoFuenteData = dataUrl;
    }
    const blob = await abrirAjusteFoto(_fotoFuenteData);
    if (!blob) { reabrirUltimaPregunta(); return; } // cancela: foto como estaba
    const est = burbujaBot('Subiendo la foto… <i class="fas fa-spinner fa-spin"></i>');
    const url = await subirFotoServicio(blob);
    if (!url) {
        est.innerHTML = '⚠️ No se pudo subir la foto (revisa tu conexión). Elige "Ajustar el encuadre" para reintentar.';
        reabrirUltimaPregunta();
        return;
    }
    est.remove();
    _state.imagenUrl = url;
    actualizarResumen();
    if (_burbujaFotoPreview && _burbujaFotoPreview.isConnected) {
        const img = _burbujaFotoPreview.querySelector('img');
        if (img) img.src = url;
    } else {
        _burbujaFotoPreview = burbujaBot(`<div class="svcchat-foto-titulo"><i class="fas fa-image"></i> Así se ve la foto en la tarjeta:</div>
            <div class="svcchat-foto-preview"><img src="${url}" alt="Foto del servicio"></div>`);
    }
    reabrirUltimaPregunta();
}

function reabrirUltimaPregunta() {
    const r = _rondas[_rondas.length - 1];
    if (r && r.respondida) {
        r.respondida = false;
        rehabilitarControl(r.ctl);
    }
    scrollAbajo();
}

// Sube el recorte, muestra la foto en vivo y (si no estaba preguntado) consulta.
async function fotoSubirYCerrarPregunta(blob, yaPreguntado) {
    const est = burbujaBot('Subiendo la foto… <i class="fas fa-spinner fa-spin"></i>');
    const url = await subirFotoServicio(blob);
    if (!url) {
        est.innerHTML = '⚠️ No se pudo subir la foto (revisa tu conexión). Puedes reintentar con ↩ en tu respuesta.';
        return;
    }
    est.remove();
    _state.imagenUrl = url;
    actualizarResumen();
    if (_burbujaFotoPreview && _burbujaFotoPreview.isConnected) {
        const img = _burbujaFotoPreview.querySelector('img');
        if (img) img.src = url;
    } else {
        _burbujaFotoPreview = burbujaBot(`<div class="svcchat-foto-titulo"><i class="fas fa-image"></i> Así se ve la foto en la tarjeta:</div>
            <div class="svcchat-foto-preview"><img src="${url}" alt="Foto del servicio"></div>`);
    }
    if (yaPreguntado) return; // la pregunta "¿cómo quedó?" ya está abierta
    burbujaBot('¿Cómo quedó?');
    bloqueOpciones([
        { valor: 'ok', label: '✓ Se ve bien, continuar', rec: true },
        { valor: 'ajustar', label: 'Ajustar el encuadre' },
        { valor: 'quitar', label: 'Quitar la foto' }
    ], (valor) => {
        if (valor === 'ok') { burbujaUser('Se ve bien ✓'); return pasoResumenFinal(); }
        if (valor === 'quitar') {
            burbujaUser('Quitar la foto');
            _state.imagenUrl = null;
            if (_burbujaFotoPreview && _burbujaFotoPreview.isConnected) _burbujaFotoPreview.remove();
            _burbujaFotoPreview = null;
            actualizarResumen();
            burbujaBot('Listo, sin foto. La tarjeta mostrará la inicial del servicio con un color de fondo.');
            return pasoResumenFinal();
        }
        burbujaUser('Ajustar el encuadre');
        fotoReajustar();
    });
}

// ── Helpers de archivo / subida ──────────────────────────────────────────
function elegirArchivoFoto() {
    return new Promise((resolve) => {
        if (!_inputFoto) {
            _inputFoto = document.createElement('input');
            _inputFoto.type = 'file';
            _inputFoto.accept = 'image/*';
            _inputFoto.style.display = 'none';
            document.body.appendChild(_inputFoto);
        }
        _inputFoto.value = '';
        _inputFoto.onchange = () => {
            const file = _inputFoto.files && _inputFoto.files[0];
            _inputFoto.onchange = null;
            if (!file) return resolve(null);
            if (file.size > 10 * 1024 * 1024) {
                burbujaBot('⚠️ La imagen pesa más de 10 MB: elige una más liviana.');
                return resolve(null);
            }
            if (!file.type || !file.type.startsWith('image/')) {
                burbujaBot('⚠️ Ese archivo no es una imagen (usa JPG, PNG o WebP).');
                return resolve(null);
            }
            resolve(file);
        };
        _inputFoto.click();
    });
}

function leerArchivoDataURL(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result || null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
    });
}

// Sube al bucket service-images/<tenant>/ (misma convención que el legacy).
async function subirFotoServicio(blob) {
    _fotoSubiendo = true;
    try {
        const supabase = getSupabase();
        if (!supabase) {
            console.error('[svcchat] Cliente Supabase no disponible para subir foto');
            return null;
        }
        let tenantId = null;
        try {
            const { data } = await supabase.rpc('get_user_tenant_id');
            tenantId = data || null;
        } catch (e) {
            console.warn('[svcchat] tenant canónico no disponible, uso JWT:', e);
        }
        tenantId = tenantId || window.currentTenantId || 'public';
        const fileName = `servicio-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.jpg`;
        const filePath = `${tenantId}/${fileName}`;
        const { error } = await supabase.storage
            .from('service-images')
            .upload(filePath, blob, { contentType: 'image/jpeg', upsert: true });
        if (error) throw error;
        const { data: urlData } = supabase.storage.from('service-images').getPublicUrl(filePath);
        return (urlData && urlData.publicUrl) || null;
    } catch (e) {
        console.error('[svcchat] Error subiendo foto:', e);
        return null;
    } finally {
        _fotoSubiendo = false;
    }
}

// ── Modal de ajuste/recorte (canvas vanilla, sin librerías externas) ─────
// Visor con la proporción de la tarjeta (16:9): arrastrar encuadra y el
// slider acerca/aleja. Al confirmar exporta un JPEG de ~800px de ancho.
function abrirAjusteFoto(dataUrl) {
    return new Promise((resolve) => {
        const ov = document.createElement('div');
        ov.className = 'svcchat-crop-ov';
        ov.innerHTML = `
            <div class="svcchat-crop-card" role="dialog" aria-modal="true" aria-label="Ajustar la foto de la tarjeta">
                <div class="svcchat-crop-head">
                    <div class="svcchat-crop-titulos">
                        <strong><i class="fas fa-crop-alt"></i> Ajusta la foto de la tarjeta</strong>
                        <span>Arrastra la foto para encuadrarla y usa el zoom para acercar o alejar.</span>
                    </div>
                    <button type="button" class="svcchat-crop-cerrar" aria-label="Cancelar" title="Cancelar"><i class="fas fa-times"></i></button>
                </div>
                <div class="svcchat-crop-stage" id="svcchat-crop-stage">
                    <img id="svcchat-crop-img" alt="Foto a ajustar">
                </div>
                <div class="svcchat-crop-zoomrow">
                    <button type="button" class="svcchat-crop-zoombtn" id="svcchat-crop-out" title="Alejar"><i class="fas fa-minus"></i></button>
                    <input type="range" id="svcchat-crop-zoom" min="1" max="4" step="0.01" value="1" aria-label="Zoom">
                    <button type="button" class="svcchat-crop-zoombtn" id="svcchat-crop-in" title="Acercar"><i class="fas fa-plus"></i></button>
                    <button type="button" class="svcchat-crop-reset" id="svcchat-crop-reset">Restablecer</button>
                </div>
                <div class="svcchat-crop-actions">
                    <button type="button" class="svcchat-crop-btn svcchat-crop-cancel" id="svcchat-crop-cancel">Cancelar</button>
                    <button type="button" class="svcchat-crop-btn svcchat-crop-ok" id="svcchat-crop-ok"><i class="fas fa-check"></i> Usar esta foto</button>
                </div>
            </div>
        `;
        document.body.appendChild(ov);

        const stage = ov.querySelector('#svcchat-crop-stage');
        const img = ov.querySelector('#svcchat-crop-img');
        const slider = ov.querySelector('#svcchat-crop-zoom');

        let z = 1;
        let tx = 0;
        let ty = 0;
        let fit = 1;     // escala base: la imagen cubre el visor con z=1
        let stW = 0;
        let stH = 0;
        let natW = 0;
        let natH = 0;
        let dispW = 0;
        let dispH = 0;
        let cerrado = false;

        const medir = () => {
            const r = stage.getBoundingClientRect();
            stW = r.width;
            stH = r.height;
        };
        const aplicar = () => {
            dispW = natW * fit * z;
            dispH = natH * fit * z;
            const maxTx = Math.max(0, (dispW - stW) / 2);
            const maxTy = Math.max(0, (dispH - stH) / 2);
            tx = Math.min(maxTx, Math.max(-maxTx, tx));
            ty = Math.min(maxTy, Math.max(-maxTy, ty));
            img.style.width = dispW + 'px';
            img.style.height = dispH + 'px';
            img.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
        };
        const setZoom = (nz, anclarCentro) => {
            const cxn = anclarCentro ? (stW / 2 - tx) / dispW : null;
            const cyn = anclarCentro ? (stH / 2 - ty) / dispH : null;
            z = Math.min(4, Math.max(1, nz));
            slider.value = String(z);
            if (anclarCentro && cxn != null) {
                dispW = natW * fit * z;
                dispH = natH * fit * z;
                tx = stW / 2 - cxn * dispW;
                ty = stH / 2 - cyn * dispH;
            }
            aplicar();
        };
        const terminar = (resultado) => {
            if (cerrado) return;
            cerrado = true;
            ov.remove();
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('resize', onResize);
            resolve(resultado);
        };

        img.onload = () => {
            natW = img.naturalWidth;
            natH = img.naturalHeight;
            medir();
            fit = Math.max(stW / natW, stH / natH);
            aplicar();
        };
        img.src = dataUrl;

        // Arrastre (mouse y táctil vía Pointer Events).
        let arrastrando = false;
        let iniX = 0;
        let iniY = 0;
        let iniTx = 0;
        let iniTy = 0;
        stage.addEventListener('pointerdown', (e) => {
            if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
            arrastrando = true;
            stage.classList.add('svcchat-crop-drag');
            iniX = e.clientX;
            iniY = e.clientY;
            iniTx = tx;
            iniTy = ty;
            try { stage.setPointerCapture(e.pointerId); } catch (err) { /* no crítico */ }
            e.preventDefault();
        });
        stage.addEventListener('pointermove', (e) => {
            if (!arrastrando) return;
            tx = iniTx + (e.clientX - iniX);
            ty = iniTy + (e.clientY - iniY);
            aplicar();
        });
        const soltar = () => {
            arrastrando = false;
            stage.classList.remove('svcchat-crop-drag');
        };
        stage.addEventListener('pointerup', soltar);
        stage.addEventListener('pointercancel', soltar);

        slider.addEventListener('input', () => setZoom(parseFloat(slider.value) || 1, true));
        ov.querySelector('#svcchat-crop-in').addEventListener('click', () => setZoom(z + 0.2, true));
        ov.querySelector('#svcchat-crop-out').addEventListener('click', () => setZoom(z - 0.2, true));
        ov.querySelector('#svcchat-crop-reset').addEventListener('click', () => {
            z = 1;
            slider.value = '1';
            tx = 0;
            ty = 0;
            aplicar();
        });
        ov.querySelector('#svcchat-crop-cancel').addEventListener('click', () => terminar(null));
        ov.querySelector('.svcchat-crop-cerrar').addEventListener('click', () => terminar(null));
        ov.addEventListener('click', (e) => { if (e.target === ov) terminar(null); });
        ov.querySelector('#svcchat-crop-ok').addEventListener('click', () => {
            if (!natW) return;
            try {
                const factor = natW / dispW; // px de imagen natural por px en pantalla
                const sx = Math.max(0, (-tx) * factor);
                const sy = Math.max(0, (-ty) * factor);
                const sw = Math.min(natW - sx, stW * factor);
                const sh = Math.min(natH - sy, stH * factor);
                if (sw < 4 || sh < 4) return;
                const cw = 800;
                const ch = Math.max(1, Math.round(cw * sh / sw));
                const canvas = document.createElement('canvas');
                canvas.width = cw;
                canvas.height = ch;
                const ctx = canvas.getContext('2d');
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);
                canvas.toBlob((blob) => terminar(blob || null), 'image/jpeg', 0.82);
            } catch (err) {
                console.error('[svcchat] Error recortando foto:', err);
                terminar(null);
            }
        });

        const onKey = (e) => { if (e.key === 'Escape') terminar(null); };
        const onResize = () => { medir(); aplicar(); };
        document.addEventListener('keydown', onKey);
        window.addEventListener('resize', onResize);
    });
}

// ============================================================
// EDICIÓN CONVERSACIONAL
// editarServicio() deja el form real cargado; este modo pregunta qué
// cambiar, aplica cada cambio sobre el form/globals legacy y al final
// llama actualizarServicio() (misma ruta que el botón GUARDAR CAMBIOS).
// ============================================================
function setCampoReal(id, valor) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = valor;
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

function tipoVentaActual() {
    const sel = document.querySelector('input[name="srv-tipo-venta"]:checked');
    return sel ? sel.value : 'sesion';
}

// Excepciones activas (días/fechas con horario propio) leídas del hidden
// #service-modules que editarServicio serializó al cargar.
function excepcionesActivas() {
    try {
        const hidden = document.getElementById('service-modules');
        if (!hidden || !hidden.value) return { dias: 0, fechas: 0 };
        const data = JSON.parse(hidden.value);
        const dias = Object.keys(data.weekday || {}).filter(d => (data.weekday[d] || []).length).length;
        const fechas = Object.keys(data.dateSpecific || {}).filter(f => (data.dateSpecific[f] || []).length).length;
        return { dias, fechas };
    } catch (e) { return { dias: 0, fechas: 0 }; }
}

// Refresca matriz + hidden + trabajadores tras mutar módulos/fechas.
function refrescarModulosTrasCambio() {
    try { if (typeof renderModulesList === 'function') renderModulesList(); } catch (e) { /* no crítico */ }
    try { if (typeof saveModulesToHiddenField === 'function') saveModulesToHiddenField(); } catch (e) { /* no crítico */ }
    window.dispatchEvent(new CustomEvent('servicio-modulos-actualizados'));
}

function fechasActuales() {
    try {
        if (typeof generarDisponibilidadFinal === 'function') {
            return Object.keys(generarDisponibilidadFinal() || {}).sort();
        }
    } catch (e) { /* no crítico */ }
    return [];
}

function iniciarChatEdicion() {
    const form = document.getElementById('service-form');
    if (!form || !_el) return;
    _editando = true;
    _editConvIniciada = true;
    _modo = 'chat';
    form.style.display = 'none';
    _el.view.style.display = '';
    const nombre = (document.getElementById('srv-name')?.value || '').trim();
    limpiarConv();
    pintarCabeceraModo();
    burbujaBot(`¡Vamos a editar <strong>${escapeHtml(nombre || 'tu servicio')}</strong>!<br><span class="svcchat-sub">Lo que ya tiene se queda igual hasta que lo cambies. Al final eliges si guardar.</span>`);
    pintarResumenEdicion();
    menuEdicion();
    scrollAbajo();
}

function pintarResumenEdicion() {
    const body = _el && _el.resumen;
    if (!body) return;
    const nombre = (document.getElementById('srv-name')?.value || '').trim();
    const precioRaw = document.getElementById('srv-price')?.value;
    const precio = precioRaw !== '' && precioRaw !== undefined ? fmtPrecio(parseFloat(precioRaw) || 0) : '';
    const dur = duracionActual();
    const ex = excepcionesActivas();
    const nFechas = fechasActuales().length;
    const imgUrl = (document.getElementById('srv-image-url')?.value || '').trim();
    const fila = (k, v) => (v ? `<div class="svcchat-rsm-fila"><span>${k}</span><strong>${v}</strong></div>` : '');
    body.innerHTML = `
        ${imgUrl ? `<div class="svcchat-rsm-img"><img src="${imgUrl}" alt="Foto del servicio"></div>` : ''}
        <div class="svcchat-rsm-preview">
            ${nombre ? `<div class="svcchat-rsm-nombre">${escapeHtml(nombre)}</div>` : ''}
            ${precio ? `<div class="svcchat-rsm-precio">${precio}</div>` : ''}
        </div>
        ${fila('Duración', dur + ' min')}
        ${fila('Fechas', nFechas ? nFechas + ' día(s) con horario' : '')}
        ${fila('Horario propio', (ex.dias || ex.fechas) ? ex.dias + ' día(s) · ' + ex.fechas + ' fecha(s)' : '')}
    `;
}

function menuEdicion() {
    burbujaBot('¿Qué quieres cambiar?');
    bloqueOpciones([
        { valor: 'nombre', label: '📝 Nombre' },
        { valor: 'precio', label: '💰 Precio' },
        { valor: 'duracion', label: '⏱️ Duración de la sesión' },
        { valor: 'dias', label: '📅 Días y vigencia' },
        { valor: 'horario', label: '🕘 Horario y bloques' },
        { valor: 'cupos', label: '👥 Cupos por bloque' },
        { valor: 'descripcion', label: '📄 Descripción' },
        { valor: 'foto', label: '📷 Foto de la tarjeta', hint: 'Elige, recorta y encuadra la foto' },
        { valor: 'avanzado', label: '⚙️ Algo más avanzado…', hint: 'Trabajadores, horarios por día/fecha, promociones: se hace en el formulario completo.' },
        { valor: 'cancelar', label: '✖️ Descartar y salir' }
    ], (valor) => {
        if (valor === 'nombre') return editarNombre();
        if (valor === 'precio') return editarPrecio();
        if (valor === 'duracion') return editarDuracion();
        if (valor === 'dias') return editarDiasVigencia();
        if (valor === 'horario') return editarHorarioGeneral();
        if (valor === 'cupos') return editarCupos();
        if (valor === 'descripcion') return editarDescripcion();
        if (valor === 'foto') return editarFotoChat();
        if (valor === 'avanzado') {
            burbujaBot('Perfecto, eso se afina mejor en el <strong>formulario completo</strong> (trabajadores, horarios por día/fecha, promociones…). Te dejo ahí 👇');
            mostrarForm();
            return;
        }
        cancelarEdicionChat();
    });
}

function editarNombre() {
    burbujaBot('¿Cuál es el <strong>nuevo nombre</strong>?');
    bloqueInput('Nuevo nombre del servicio', {
        validar: (v) => (v.trim().length >= 2 ? null : 'El nombre debe tener al menos 2 letras')
    }, (valor) => {
        const limpio = valor.trim();
        setCampoReal('srv-name', limpio);
        burbujaUser(limpio);
        pintarResumenEdicion();
        trasCambioEdicion();
    });
}

function editarPrecio() {
    const esPromo = tipoVentaActual() === 'promocion';
    burbujaBot(esPromo
        ? '¿Cuál es el <strong>nuevo precio de la sesión suelta</strong>?<br><span class="svcchat-sub">Si es gratis, escribe 0.</span>'
        : '¿Cuál es el <strong>nuevo precio</strong>?<br><span class="svcchat-sub">Si el servicio es gratis, escribe 0.</span>');
    bloqueInput(esPromo ? 'Precio sesión suelta ($)' : 'Precio ($)', {
        inputmode: 'numeric',
        validar: (v) => {
            const n = parseFloat(String(v).replace(/[^0-9]/g, ''));
            return (Number.isFinite(n) && n >= 0) ? null : 'Ingresa un precio (0 si es gratis)';
        }
    }, (valor) => {
        const n = parseFloat(valor.replace(/[^0-9]/g, ''));
        setCampoReal('srv-price', n);
        burbujaUser(fmtPrecio(n));
        if (!esPromo) { pintarResumenEdicion(); return trasCambioEdicion(); }
        burbujaBot('¿Y el <strong>precio total del pack</strong>?<br><span class="svcchat-sub">Puede ser 0 si el pack también es gratis.</span>');
        bloqueInput('Precio total del pack ($)', {
            inputmode: 'numeric',
            validar: (v) => {
                const n2 = parseFloat(String(v).replace(/[^0-9]/g, ''));
                return (Number.isFinite(n2) && n2 >= 0) ? null : 'Ingresa un precio (0 si es gratis)';
            }
        }, (valor2) => {
            const n2 = parseFloat(valor2.replace(/[^0-9]/g, ''));
            setCampoReal('srv-promo-precio', n2);
            burbujaUser(fmtPrecio(n2) + ' el pack');
            pintarResumenEdicion();
            trasCambioEdicion();
        });
    });
}

function editarDuracion() {
    burbujaBot('¿Cuánto dura <strong>cada sesión</strong> ahora?');
    bloqueOpciones([
        { valor: 30, label: '30 min' },
        { valor: 45, label: '45 min' },
        { valor: 60, label: '60 min', rec: true },
        { valor: 90, label: '90 min' }
    ], (valor) => {
        aplicarDuracion(valor);
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

function aplicarDuracion(min) {
    setCampoReal('srv-duration', min);
    burbujaUser(min + ' min');
    burbujaBot('Listo ✓. Ojo: los bloques ya generados mantienen su duración actual; si quieres regenerarlos con la nueva, elige <strong>Horario y bloques</strong>.');
    pintarResumenEdicion();
    trasCambioEdicion();
}

function editarDiasVigencia() {
    burbujaBot('¿Qué ajustamos de las <strong>fechas</strong>?');
    bloqueOpciones([
        { valor: 'dias', label: 'Los días de atención' },
        { valor: 'vigencia', label: 'La vigencia (hasta cuándo)' },
        { valor: 'ambos', label: 'Ambos' }
    ], (valor) => {
        burbujaUser(valor === 'dias' ? 'Los días de atención' : valor === 'vigencia' ? 'La vigencia' : 'Ambos');
        if (valor === 'dias') editarDiasSolo();
        else if (valor === 'vigencia') editarVigenciaSolo();
        else { editarDiasSolo(() => editarVigenciaSolo()); }
    });
}

function editarDiasSolo(despues) {
    burbujaBot('¿Qué días de la semana atiende este servicio?<br><span class="svcchat-sub">Los días que quites dejarán de ofrecerse (las citas ya tomadas no se borran solas: revísalas en el tablero).</span>');
    bloqueOpciones([
        { valor: 'laborables', label: 'Lun a Vie' },
        { valor: 'finde', label: 'Sáb y Dom' },
        { valor: 'todos', label: 'Todos los días' }
    ], (valor) => {
        const lista = valor === 'laborables' ? [1, 2, 3, 4, 5] : valor === 'finde' ? [6, 0] : [0, 1, 2, 3, 4, 5, 6];
        burbujaUser(valor === 'laborables' ? 'Lun a Vie' : valor === 'finde' ? 'Sáb y Dom' : 'Todos los días');
        aplicarDias(lista, despues);
    }, {
        conOtro: true,
        otroLabel: 'Elegir días…',
        onOtro: () => {
            burbujaUser('Elegir días…');
            burbujaBot('Marca los días que atiende:');
            bloqueMultiSelect(ORDEN_DIAS.map(d => ({ valor: d, label: nombreDia(d) })), (elegidos) => {
                burbujaUser('Días: ' + elegidos.map(d => nombreDia(d)).join(', '));
                aplicarDias(elegidos, despues);
            }, { errorVacio: 'Marca al menos un día 😉' });
        }
    });
}

function aplicarDias(listaDias, despues) {
    const actuales = fechasActuales();
    const ini = actuales[0] || hoyISO();
    const fin = actuales[actuales.length - 1] || sumarMesesClamp(hoyISO(), 3);
    setCampoReal('range-start', ini);
    setCampoReal('range-end', fin);
    document.querySelectorAll('.dia-semana-checkbox').forEach(cb => { cb.checked = listaDias.includes(parseInt(cb.value, 10)); });
    let ok = false;
    try { if (typeof window.generarFechasPorRango === 'function') { window.generarFechasPorRango(); ok = true; } } catch (e) { /* validación del legacy */ }
    if (ok) {
        const n = fechasActuales().length;
        burbujaBot(n ? `✓ Quedaron <strong>${n} día(s)</strong> con horario.` : 'No quedó ninguna fecha para esa combinación: prueba con más días o más vigencia 😉');
    } else {
        burbujaBot('El calendario marcó un aviso con esa combinación. Revisa en el formulario completo si quieres 😉');
    }
    window.moduleDateCupos = {};
    try { if (typeof renderModulesList === 'function') renderModulesList(); } catch (e) { /* no crítico */ }
    pintarResumenEdicion();
    if (despues) despues(); else trasCambioEdicion();
}

function editarVigenciaSolo() {
    const actuales = fechasActuales();
    const ini = actuales[0] || hoyISO();
    const fin = actuales[actuales.length - 1] || sumarMesesClamp(hoyISO(), 3);
    burbujaBot('¿<strong>Hasta cuándo</strong> lo dejamos disponible?');
    bloqueOpciones([
        { valor: 1, label: '1 mes' },
        { valor: 3, label: '3 meses' },
        { valor: 6, label: '6 meses' },
        { valor: 12, label: '1 año entero' }
    ], (valor) => {
        const hasta = sumarMesesClamp(ini, valor);
        aplicarVigencia(ini, hasta);
    }, {
        conOtro: true,
        otroLabel: 'Hasta una fecha exacta…',
        onOtro: () => {
            burbujaUser('Hasta una fecha exacta…');
            burbujaBot('¿Hasta qué fecha?');
            bloqueFecha(ini, (f) => aplicarVigencia(ini, f));
        }
    });
}

function aplicarVigencia(ini, hasta) {
    if (hasta < ini) { burbujaBot('La fecha final debe ser posterior al inicio 😉'); return editarVigenciaSolo(); }
    setCampoReal('range-start', ini);
    setCampoReal('range-end', hasta);
    burbujaUser('Hasta el ' + fmtFechaLegible(hasta));
    let ok = false;
    try { if (typeof window.generarFechasPorRango === 'function') { window.generarFechasPorRango(); ok = true; } } catch (e) { /* validación */ }
    const n = fechasActuales().length;
    burbujaBot(n ? `✓ Quedaron <strong>${n} día(s)</strong> con horario.` : 'No quedó ninguna fecha para esa vigencia 😉');
    window.moduleDateCupos = {};
    try { if (typeof renderModulesList === 'function') renderModulesList(); } catch (e) { /* no crítico */ }
    pintarResumenEdicion();
    trasCambioEdicion();
}

function editarHorarioGeneral() {
    const ex = excepcionesActivas();
    const mods = window.serviceModules || [];
    const horas = mods.map(m => m.startTime || m.hora).filter(Boolean).sort();
    const iniDef = horas[0] || '09:00';
    const finDef = horas.length ? minAHora(horaAMin(horas[horas.length - 1]) + duracionActual()) : '18:00';
    const cupPrev = mods.length ? (mods[0].cupos || 1) : 1;
    burbujaBot('¿Entre qué horas atenderá de ahora en adelante?<br><span class="svcchat-sub">Cambia el horario general; si hay horarios propios por día o fecha, esos se mantienen.</span>');
    preguntarRangoHoras('¿<strong>Entre qué horas</strong>?', iniDef, finDef, (ini, fin) => {
        preguntarTipoBloques(ini, fin, ({ modo, elegidos }) => {
            const dur = duracionActual();
            const bloques = (modo === 'elegir')
                ? elegidos.map(h => ({ startTime: h, endTime: minAHora(horaAMin(h) + dur), duration: dur, editable: true }))
                : generarBloques(ini, fin, dur);
            window.serviceModules = bloques.map(m => ({ ...m, cupos: cupPrev }));
            window.moduleDateCupos = {};
            refrescarModulosTrasCambio();
            const avisoEx = (ex.dias || ex.fechas)
                ? `<br><span class="svcchat-sub">Se mantienen ${ex.dias} día(s) y ${ex.fechas} fecha(s) con horario propio.</span>`
                : '';
            burbujaBot(`✓ Horario general: <strong>${bloques.length} bloque(s)</strong> de ${dur} min entre ${ini} y ${fin}.${avisoEx}`);
            pintarResumenEdicion();
            trasCambioEdicion();
        });
    });
}

function editarCupos() {
    burbujaBot('¿A cuántos clientes atiende <strong>a la vez</strong> en cada bloque?<br><span class="svcchat-sub">Se aplica a todos los bloques del horario general.</span>');
    bloqueOpciones([
        { valor: 1, label: '1 cliente', rec: true },
        { valor: 2, label: '2 clientes' },
        { valor: 4, label: '4 clientes' },
        { valor: 6, label: '6 clientes' }
    ], (valor) => {
        aplicarCupos(valor);
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

function aplicarCupos(n) {
    (window.serviceModules || []).forEach(m => { m.cupos = n; });
    window.moduleDateCupos = {};
    refrescarModulosTrasCambio();
    burbujaUser(n === 1 ? '1 cliente a la vez' : n + ' clientes a la vez');
    burbujaBot(`✓ Cupos actualizados: <strong>${n} por bloque</strong>.`);
    pintarResumenEdicion();
    trasCambioEdicion();
}

function editarDescripcion() {
    burbujaBot('¿Qué <strong>descripción</strong> le ponemos?<br><span class="svcchat-sub">Se ve en la tarjeta del servicio. Si no quieres cambiarla, escribe "no".</span>');
    bloqueInput('Descripción (opcional)', {
        validar: (v) => (v.trim().length <= 2000 ? null : 'Máximo 2000 caracteres')
    }, (valor) => {
        if (valor.trim().toLowerCase() === 'no') { burbujaUser('Sin cambios'); return trasCambioEdicion(); }
        setCampoReal('srv-desc', valor.trim());
        burbujaUser(valor.trim());
        trasCambioEdicion();
    });
}

function editarFotoChat() {
    const actual = (document.getElementById('srv-image-url')?.value || '').trim();
    const opciones = [{ valor: 'subir', label: '📷 Elegir y recortar una foto' }];
    if (actual) opciones.push({ valor: 'quitar', label: '🗑️ Quitar la foto actual' });
    opciones.push({ valor: 'no', label: 'No tocar la foto' });
    burbujaBot(`¿Qué hacemos con la <strong>foto de la tarjeta</strong>?${actual ? '<br><span class="svcchat-sub">Recuerda: puedes recortarla y encuadrarla a tu gusto.</span>' : ''}`);
    bloqueOpciones(opciones, (valor) => {
        if (valor === 'no') {
            burbujaUser('No tocar la foto');
            return menuEdicion();
        }
        if (valor === 'quitar') {
            burbujaUser('Quitar la foto actual');
            setCampoReal('srv-image-url', '');
            try { if (typeof window._actualizarPreview === 'function') window._actualizarPreview(''); } catch (e) { /* no crítico */ }
            burbujaBot('✓ Foto quitada: la tarjeta mostrará la inicial con un color de fondo.');
            pintarResumenEdicion();
            return trasCambioEdicion();
        }
        burbujaUser('Elegir y recortar una foto');
        editarFotoSubir();
    });
}

async function editarFotoSubir() {
    const file = await elegirArchivoFoto();
    if (!file) {
        burbujaBot('Ok, dejamos la foto como está.');
        return trasCambioEdicion();
    }
    const dataUrl = await leerArchivoDataURL(file);
    if (!dataUrl) {
        burbujaBot('⚠️ No se pudo leer esa imagen (usa JPG, PNG o WebP de hasta 10 MB).');
        return trasCambioEdicion();
    }
    _fotoFuenteData = dataUrl;
    const blob = await abrirAjusteFoto(_fotoFuenteData);
    if (!blob) {
        burbujaBot('Ok, dejamos la foto como está.');
        return trasCambioEdicion();
    }
    const est = burbujaBot('Subiendo la foto… <i class="fas fa-spinner fa-spin"></i>');
    const url = await subirFotoServicio(blob);
    if (!url) {
        est.innerHTML = '⚠️ No se pudo subir la foto (revisa tu conexión). Puedes reintentar eligiendo <strong>Foto de la tarjeta</strong> de nuevo.';
        return;
    }
    est.remove();
    setCampoReal('srv-image-url', url);
    try { if (typeof window._actualizarPreview === 'function') window._actualizarPreview(url); } catch (e) { /* no crítico */ }
    burbujaBot(`<div class="svcchat-foto-preview"><img src="${url}" alt="Foto del servicio"></div>
        <span class="svcchat-sub">✓ Foto actualizada: así se verá en la tarjeta.</span>`);
    pintarResumenEdicion();
    trasCambioEdicion();
}

function trasCambioEdicion() {
    burbujaBot('¿Quieres cambiar <strong>algo más</strong>?');
    bloqueOpciones([
        { valor: 'otra', label: 'Sí, cambiar otra cosa' },
        { valor: 'listo', label: 'No: con eso es suficiente — guardar ✓', rec: true }
    ], (valor) => {
        if (valor === 'otra') { burbujaUser('Sí, otra cosa'); menuEdicion(); }
        else { burbujaUser('Guardar'); guardarEdicionChat(); }
    });
}

function guardarEdicionChat() {
    burbujaBot('Guardando cambios… <i class="fas fa-spinner fa-spin"></i>');
    _guardandoEdicionChat = true;
    const esperar = (ms) => new Promise(r => setTimeout(r, ms));
    (async () => {
        try {
            if (typeof window.actualizarServicio === 'function') await window.actualizarServicio();
        } catch (e) {
            console.warn('[svcchat-edit] error al guardar:', e);
        }
        let ok = false;
        for (let i = 0; i < 14; i++) {
            await esperar(700);
            const m = document.getElementById('section-mis-servicios');
            if (m && m.style.display !== 'none') { ok = true; break; }
        }
        _guardandoEdicionChat = false;
        if (ok) {
            _editando = false;
            _editConvIniciada = false;
            limpiarConv();
            return;
        }
        burbujaBot('⚠️ El formulario marcó un aviso (revisa abajo). Tus cambios quedaron aplicados: toca <strong>Ver formulario completo</strong> para corregir y pulsar GUARDAR CAMBIOS.');
        setTimeout(() => { try { mostrarForm(); } catch (e) { /* no crítico */ } }, 800);
    })();
}

function cancelarEdicionChat() {
    burbujaUser('Descartar y salir');
    _editando = false;
    _editConvIniciada = false;
    limpiarConv();
    try {
        if (typeof window.cancelarEdicion === 'function') { window.cancelarEdicion(); return; }
    } catch (e) { /* no crítico */ }
    try {
        if (typeof window.limpiarEstadoEdicion === 'function') window.limpiarEstadoEdicion();
        if (typeof window.navigateTo === 'function') window.navigateTo('mis-servicios');
    } catch (e) { /* no crítico */ }
}

function pasoResumenFinal() {
    _state.paso = 99;
    const fechas = calcularFechas(diasEfectivos(_state), fechaDesdeISO(_state), fechaHastaISO(_state));
    const bloques = bloquesDe(_state);
    const esPromo = _state.modalidad === 'promocion';

    burbujaBot(`
        <div class="svcchat-msg-titulo">¡Listo! 🎉 Así quedó tu servicio</div>
        <div class="svcchat-tarjeta-final">
            ${_state.imagenUrl ? `<div class="svcchat-final-img"><img src="${_state.imagenUrl}" alt="Foto del servicio"></div>` : ''}
            <div class="svcchat-final-nombre"><i class="fas fa-tag"></i> ${escapeHtml(_state.nombre)}</div>
            <div class="svcchat-final-fila"><span>Modalidad</span><strong>${esPromo ? `Pack de ${_state.numSesiones} sesiones` : 'Sesión suelta'}</strong></div>
            <div class="svcchat-final-fila"><span>Precio</span><strong>${esPromo ? `${fmtPrecio(_state.precioSesion)} sesión · ${fmtPrecio(_state.precioPack)} el pack` : fmtPrecio(_state.precioSesion)}</strong></div>
            <div class="svcchat-final-fila"><span>Duración</span><strong>${_state.duracion} min</strong></div>
            <div class="svcchat-final-fila"><span>Disponible</span><strong>${etiquetaDias(_state)} · ${_state.horaInicio} a ${_state.horaFin}</strong></div>
            <div class="svcchat-final-fila"><span>Bloques</span><strong>${bloques.length} de ${_state.duracion} min${_state.bloquesModo === 'elegir' ? ' (elegidos)' : ''}</strong></div>
            <div class="svcchat-final-fila"><span>Cupos por bloque</span><strong>${_state.cupos} cliente${_state.cupos > 1 ? 's' : ''}</strong></div>
            ${_state.excepcionesDias && Object.keys(_state.excepcionesDias).length ? `<div class="svcchat-final-fila"><span>Horario por día</span><strong>${etiquetaExcepcionesDias(_state)}</strong></div>` : ''}
            ${_state.fechasEspeciales && Object.keys(_state.fechasEspeciales).length ? `<div class="svcchat-final-fila"><span>Fechas especiales</span><strong>${etiquetaFechasEspeciales(_state)}</strong></div>` : ''}
            <div class="svcchat-final-fila"><span>Vigencia</span><strong>${fmtFechaLegible(fechaDesdeISO(_state))} → ${fmtFechaLegible(fechaHastaISO(_state))} · ${fechas.length} día(s) con horario</strong></div>
        </div>
        <p class="svcchat-sub" style="margin-top:8px;">💡 La descripción puedes agregarla después desde Mis Servicios → Editar. Si quieres corregir algo, toca ↩ en cualquiera de tus respuestas.</p>
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

// "Lun 2 bloq · Jue 1 bloq" — días con horario distinto al general.
function etiquetaExcepcionesDias(s) {
    const o = (s && s.excepcionesDias) || {};
    const keys = Object.keys(o).filter(d => o[d] && o[d].length);
    if (!keys.length) return '';
    return keys
        .sort((a, b) => ORDEN_DIAS.indexOf(+a) - ORDEN_DIAS.indexOf(+b))
        .map(d => `${(DIAS_SEMANA.find(x => x.v === +d) || {}).label || d} ${o[d].length} bloq`)
        .join(' · ');
}

// "24 de diciembre de 2026, 31 de diciembre de 2026" — fechas con horario propio.
function etiquetaFechasEspeciales(s) {
    const o = (s && s.fechasEspeciales) || {};
    const keys = Object.keys(o).filter(f => o[f] && o[f].length);
    return keys.length ? keys.map(f => fmtFechaLegible(f)).join(', ') : '';
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
        ${s.imagenUrl ? `<div class="svcchat-rsm-img"><img src="${s.imagenUrl}" alt="Foto del servicio"></div>` : ''}
        <div class="svcchat-rsm-preview">
            ${s.nombre ? `<div class="svcchat-rsm-nombre">${escapeHtml(s.nombre)}</div>` : '<div class="svcchat-rsm-vacio">[Nombre del servicio]</div>'}
            ${s.precioSesion != null ? `<div class="svcchat-rsm-precio">${fmtPrecio(s.precioSesion)}${esPromo && s.precioPack != null ? ' · pack ' + fmtPrecio(s.precioPack) : ''}</div>` : ''}
            ${s.duracion ? `<div class="svcchat-rsm-chip">${s.duracion} min</div>` : ''}
        </div>
        ${fila('Modalidad', esPromo ? `Pack de ${s.numSesiones}` : (s.paso >= 2 ? 'Sesión suelta' : ''))}
        ${fila('Días', s.paso >= 7 ? etiquetaDias(s) : '')}
        ${fila('Vigencia', vigencia + (nDias !== null ? ` · ${nDias} día(s)` : ''))}
        ${fila('Horario', s.paso >= 10 ? `${s.horaInicio} a ${s.horaFin}` : '')}
        ${fila('Bloques', s.paso >= 11 ? `${bloquesDe(s).length} de ${s.duracion} min` : '')}
        ${fila('Cupos', s.paso >= 12 ? `${s.cupos} por bloque` : '')}
        ${fila('Por día', s.paso >= 13 ? etiquetaExcepcionesDias(s) : '')}
        ${fila('Fechas especiales', s.paso >= 14 ? etiquetaFechasEspeciales(s) : '')}
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
    if (s.precioSesion != null) setVal('srv-price', s.precioSesion);
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
        if (s.precioPack != null) setVal('srv-promo-precio', s.precioPack);
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
            // Excepciones por día de la semana / fecha específica (jerarquía
            // fecha > día > general en el legacy; los cupos van inyectados).
            if (typeof window.__svcChatSetAsignacion === 'function') {
                const s = _state;
                const cup = s.cupos || 1;
                const wd = {};
                const ds = {};
                if (s.excepcionesDias) {
                    Object.keys(s.excepcionesDias).forEach(d => {
                        const mods = s.excepcionesDias[d];
                        if (mods && mods.length) wd[d] = mods.map(m => ({ ...m, cupos: cup }));
                    });
                }
                if (s.fechasEspeciales) {
                    Object.keys(s.fechasEspeciales).forEach(f => {
                        const mods = s.fechasEspeciales[f];
                        if (mods && mods.length) ds[f] = mods.map(m => ({ ...m, cupos: cup }));
                    });
                }
                window.__svcChatSetAsignacion(wd, ds);
            }
        } catch (e) { /* no crítico */ }
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
    // La foto conversada viaja al form (hidden srv-image-url + preview legacy).
    if (s.imagenUrl) {
        const imgHidden = document.getElementById('srv-image-url');
        if (imgHidden) imgHidden.value = s.imagenUrl;
        try { if (typeof window._actualizarPreview === 'function') window._actualizarPreview(s.imagenUrl); } catch (e) { /* no crítico */ }
    }
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
        // Foto elegida por chat → el form legacy la toma del hidden. Va DESPUÉS
        // de rellenarFormularioReal() (que limpia srv-image-url) y antes del submit.
        if (_state && _state.imagenUrl) {
            const imgHidden = document.getElementById('srv-image-url');
            if (imgHidden) imgHidden.value = _state.imagenUrl;
            try { if (typeof window._actualizarPreview === 'function') window._actualizarPreview(_state.imagenUrl); } catch (e) { /* no crítico */ }
        }
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
        limpiarConv();
        if (crearCopia && copiaBase) {
            setTimeout(() => {
                if (typeof window.navigateTo === 'function') window.navigateTo('crear-servicio');
                if (typeof window.limpiarEstadoEdicion === 'function') window.limpiarEstadoEdicion();
                _state = { ...estadoInicial(), ...copiaBase, paso: 1 };
                // mostrarChat (vía observer/navegación) continúa la copia sin repintar.
                if (_modo !== 'chat') mostrarChat({ silencioso: true });
                limpiarConv();
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
