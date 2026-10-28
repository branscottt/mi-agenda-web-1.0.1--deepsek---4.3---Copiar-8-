// ventas-live/ui/vlAtras.js
// Botón "atrás" del celular DENTRO de Ventas Live.
//
// EL PROBLEMA
// En el móvil, apretar atrás con una conversación abierta (o una ficha, o un
// modal) salía de ventas-live.html: se perdía el lugar y había que volver a
// entrar. Lo que se espera (como en WhatsApp) es que atrás deshaga UN paso:
// chat → lista de conversaciones → cajón cerrado → recién ahí se sale.
//
// CÓMO
// Cada estado "navegable" registra una CAPA con su forma natural de cerrarse:
//   capa 1: cajón de Conversaciones      → cerrarConversaciones()
//   capa 2: conversación abierta         → volver a la lista
//   capa 3: hoja "¿Quién es?" / búsqueda → cerrar la hoja / la barra
//   capa 4: modal (prenda, pago, envío…)→ cerrarModal()
//   capa 5: ficha de cliente             → volver a la lista de clientes
//   capa 6: sección (Procesos/Clientes/Envíos/Finanzas) → volver a LIVE
//
// Al abrir la capa se hace pushState con la profundidad. Cuando el navegador
// dispara "atrás", el popstate trae la profundidad de destino y se cierran
// (de arriba hacia abajo) todas las capas que quedaron por encima, cada una
// con su cierre natural. Si no hay ninguna capa abierta, el atrás es el del
// navegador de siempre: sale de la página.
//
// REGLA: la UI nunca cierra "a mano" una capa que está en el historial: llama
// a cerrar*() y ese cierre consume la entrada con consumirCapa(). Así no
// quedan entradas huérfanas (atrás "mudo" o que salta dos pasos).
// Es el mismo patrón que ya usa ClientBoard para el tablero del cliente.

const capas = [];          // [{ id, cerrar }] — la última es la de más arriba
let _instalado = false;
let _enPop = false;        // estamos cerrando por un popstate (no re-consumir)

// Sello de ESTA carga de la página. El navegador conserva el `history.state`
// al recargar (o al volver a la misma URL), así que una entrada vieja podría
// traer un {vlCapa:N} que ya no corresponde a ninguna capa de esta sesión y
// dejar "atrás" mudo. Con el sello, una entrada de otra sesión vale 0.
const SESION = Math.random().toString(36).slice(2) + Date.now().toString(36);

function instalar() {
    if (_instalado) return;
    _instalado = true;
    window.addEventListener('popstate', alAtras);
}

function profundidad() { return capas.length; }

function alAtras(e) {
    if (!capas.length) return;                 // nada nuestro: navegación normal
    const st = e.state;
    const esNuestra = !!st && st.vlSesion === SESION && typeof st.vlCapa === 'number';
    const destino = esNuestra ? Math.max(0, st.vlCapa) : 0;
    if (capas.length <= destino) return;       // volvimos a una capa que sigue abierta

    _enPop = true;
    try {
        while (capas.length > destino) {
            const capa = capas[capas.length - 1];
            let cerro = true;
            try {
                cerro = capa.cerrar() !== false;
            } catch (err) {
                console.error('[vlAtras] no se pudo cerrar la capa', capa.id, err);
            }
            if (!cerro) {
                // El cierre se canceló (ej. "Hay cambios sin guardar. ¿Descartarlos?"
                // → No). Se devuelve la entrada para que el próximo atrás la vea.
                empujar(profundidad());
                return;
            }
            capas.pop();
        }
    } finally {
        _enPop = false;
    }
}

function empujar(n) {
    try { history.pushState({ vlCapa: n, vlSesion: SESION }, ''); } catch (_) { /* historial no disponible */ }
}

/**
 * Registra una capa y deja una entrada propia en el historial.
 * @param {string} id     identificador único ('conv-drawer', 'conv-chat', …)
 * @param {Function} cerrar  cierre natural; devolver false = no se cerró
 * @returns {boolean} true si se registró (false si ya estaba)
 */
export function abrirCapa(id, cerrar) {
    instalar();
    if (capas.some(c => c.id === id)) return false;
    capas.push({ id, cerrar });
    empujar(profundidad());
    return true;
}

/** ¿Esa capa está abierta? */
export function hayCapa(id) {
    return capas.some(c => c.id === id);
}

/**
 * Consume la entrada del historial de una capa (y de las que estén por encima)
 * DESPUÉS de haberla cerrado visualmente. Se usa desde los botones/gestos
 * propios (X, ←, Cancelar, Escape): así el próximo atrás no queda mudo ni
 * salta de más.
 * @returns {boolean} true si había una entrada que consumir
 */
export function consumirCapa(id) {
    if (_enPop) return false;                  // ya venimos de un atrás
    const i = capas.findIndex(c => c.id === id);
    if (i < 0) return false;
    const n = capas.length - i;                // esta capa + las de arriba
    capas.length = i;
    try { history.go(-n); } catch (_) { /* historial no disponible */ }
    return true;
}

/** Solo para pruebas/diagnóstico: qué capas hay ahora mismo. */
export function capasAbiertas() {
    return capas.map(c => c.id);
}

// Puente de diagnóstico (no enumerable, como el resto de __* del proyecto):
// permite verificar por automatización qué capas están abiertas.
try {
    Object.defineProperty(window, '__vlCapas', {
        value: capasAbiertas, enumerable: false, configurable: true
    });
} catch (_) { /* sin window (SSR/build) */ }

/**
 * Cambia una capa por otra SIN tocar el historial (replaceState). Se usa al
 * cambiar de pestaña: la ficha abierta se cierra y la pestaña nueva pasa a ser
 * la capa de arriba, todo en la misma entrada (sin "atrás" de más).
 * @returns {boolean} true si reemplazó
 */
export function reemplazarCapa(idViejo, id, cerrar) {
    if (_enPop) return false;
    const i = capas.findIndex(c => c.id === idViejo);
    if (i < 0) return false;
    capas.length = i;                     // fuera la vieja y las de encima
    if (id) capas.push({ id, cerrar });
    try {
        history.replaceState(id ? { vlCapa: capas.length, vlSesion: SESION } : null, '');
    } catch (_) { /* sin historial */ }
    return true;
}
