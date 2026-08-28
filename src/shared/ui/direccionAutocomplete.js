// shared/ui/direccionAutocomplete.js
// Autocompletado de direcciones con Nominatim (OpenStreetMap).
// Gratis, sin API key. Sugiere direcciones completas (calle, ciudad,
// región, país) para que la dirección guardada sea precisa.
// Uso: import { initDireccionAutocomplete } from '...'; initDireccionAutocomplete(inputEl);
// El input debe existir en el DOM. Al elegir una sugerencia, el input
// se llena con el display_name completo (p. ej. "Av. Providencia 1234,
// Providencia, Región Metropolitana, Chile") — sirve directo para el
// iframe de Google Maps (?q=...) y para que el negocio encuentre al cliente.

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
// La web hoy opera solo en Chile; si se expande a más países, cambiar
// esta lista (ISO 3166-1 alpha-2, p. ej. 'cl,ar,pe').
const COUNTRY_CODES = 'cl';
const MIN_CHARS = 3;
const DEBOUNCE_MS = 600;
const LIMIT = 5;

export function initDireccionAutocomplete(input) {
    if (!input || input.dataset.direccionAcInit) return;
    input.dataset.direccionAcInit = '1';
    input.setAttribute('autocomplete', 'off');

    // Contenedor del dropdown (dentro del wrapper del input, tras él)
    let wrap = input.parentNode.querySelector(':scope > .direccion-ac');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'direccion-ac';
        input.parentNode.insertBefore(wrap, input.nextSibling);
    }
    const list = document.createElement('div');
    list.className = 'direccion-ac-list';
    list.style.display = 'none';
    wrap.appendChild(list);

    let items = [];
    let selectedIndex = -1;
    let timer = null;

    function hide() {
        list.style.display = 'none';
        list.innerHTML = '';
        items = [];
        selectedIndex = -1;
    }

    function highlight() {
        Array.from(list.children).forEach((el, i) => {
            el.classList.toggle('activa', i === selectedIndex);
        });
    }

    function render(results) {
        items = results;
        selectedIndex = -1;
        list.innerHTML = '';
        if (!results.length) {
            list.style.display = 'none';
            return;
        }
        results.forEach((r, i) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'direccion-ac-item';
            item.innerHTML = '<i class="fas fa-map-marker-alt"></i><span></span>';
            item.querySelector('span').textContent = r.display_name || '';
            item.addEventListener('mousedown', (e) => {
                e.preventDefault(); // evita que el input pierda el foco antes del click
                seleccionar(i);
            });
            list.appendChild(item);
        });
        list.style.display = 'block';
    }

    function seleccionar(i) {
        const r = items[i];
        if (!r) return;
        input.value = r.display_name || '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        hide();
        input.focus();
    }

    async function buscar(q) {
        try {
            const url = `${NOMINATIM_URL}?format=jsonv2&addressdetails=1&countrycodes=${COUNTRY_CODES}&limit=${LIMIT}&q=${encodeURIComponent(q)}`;
            const res = await fetch(url, { headers: { 'Accept-Language': 'es' } });
            if (!res.ok) return [];
            const data = await res.json();
            return Array.isArray(data) ? data : [];
        } catch (e) {
            console.warn('[direccionAutocomplete] Error buscando dirección:', e);
            return [];
        }
    }

    input.addEventListener('input', () => {
        const q = input.value.trim();
        if (q.length < MIN_CHARS) {
            hide();
            return;
        }
        clearTimeout(timer);
        timer = setTimeout(async () => {
            render(await buscar(q));
        }, DEBOUNCE_MS);
    });

    input.addEventListener('keydown', (e) => {
        if (list.style.display !== 'block' || !items.length) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = (selectedIndex + 1) % items.length;
            highlight();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = (selectedIndex - 1 + items.length) % items.length;
            highlight();
        } else if (e.key === 'Enter') {
            if (selectedIndex >= 0) {
                e.preventDefault();
                e.stopPropagation();
                seleccionar(selectedIndex);
            }
        } else if (e.key === 'Escape') {
            hide();
        }
    });

    input.addEventListener('blur', () => {
        setTimeout(hide, 150); // deja tiempo al mousedown de la sugerencia
    });

    return { destroy: hide };
}
