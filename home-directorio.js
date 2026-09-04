// home-directorio.js — Cards REALES del directorio en la portada (página SEO, sin login)
// Muestra una muestra aleatoria de pymes publicadas; cada card lleva a la página
// de reservas del tenant (/p/<slug>). La anon key es PÚBLICA por diseño (los datos
// se protegen con RLS/RPCs), igual que en directorio.js.
const SUPABASE_URL = "https://dfcfimipkfhitlsyixqu.supabase.co";
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRmY2ZpbWlwa2ZoaXRsc3lpeHF1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxNzczMzAsImV4cCI6MjA4ODc1MzMzMH0.1OviTiPxYIK83bbmrYVY1nUR2o0bxn_wfqnWqK4Ccw0";

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

async function rpc(name, body) {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: {
            'apikey': ANON_KEY,
            'Authorization': `Bearer ${ANON_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body || {}),
    });
    if (!resp.ok) throw new Error(`RPC ${name}: HTTP ${resp.status}`);
    return resp.json();
}

function renderEstrellas(promedio, total) {
    const prom = Math.round((Number(promedio) || 0) * 2) / 2;
    let stars = '';
    for (let i = 1; i <= 5; i++) {
        stars += prom >= i ? '★' : (prom >= i - 0.5 ? '★' : '☆');
    }
    const count = total > 0 ? `<span class="count">${total} reseña${total === 1 ? '' : 's'}</span>` : '';
    return `<span class="dir-card-stars">${stars}${count}</span>`;
}

function renderResenasHomeCard(p) {
    const resenas = (Array.isArray(p.resenas) ? p.resenas : []).filter(r => r && r.comentario);
    if (!resenas.length) return '';
    const r = resenas[0];
    const estrellas = r.puntuacion ? '<span class="dir-card-mini-stars">' + '★'.repeat(Math.min(5, Number(r.puntuacion))) + '</span>' : '';
    const texto = String(r.comentario).length > 100 ? String(r.comentario).slice(0, 100) + '…' : String(r.comentario);
    return `
        <div class="dir-card-resena">
            <div class="dir-card-resena-head">${escapeHtml(r.nombre_cliente)} ${estrellas}</div>
            <p class="dir-card-resena-texto">"${escapeHtml(texto)}"</p>
        </div>`;
}

function renderCard(p, slug) {
    const fotos = Array.isArray(p.fotos) ? p.fotos.filter(Boolean) : [];
    const portada = fotos[0] || p.logo_url || '';
    const href = slug ? `/p/${encodeURIComponent(slug)}` : `cliente.html?tenant_id=${encodeURIComponent(p.tenant_id)}`;
    return `
        <article class="dir-card">
            <div class="dir-card-cover">
                ${portada
                    ? `<img src="${escapeHtml(portada)}" alt="${escapeHtml(p.nombre_negocio)}" loading="lazy" onerror="this.style.display='none'">`
                    : '🏪'}
            </div>
            <div class="dir-card-body">
                <h3>${escapeHtml(p.nombre_negocio)}</h3>
                <div class="dir-card-cat">${escapeHtml(p.tipo_pyme || p.categoria || 'Pyme')}</div>
                ${p.direccion ? `<div class="dir-card-dir">📍 ${escapeHtml(p.direccion)}</div>` : ''}
                ${p.estrellas_activas && p.total_resenas > 0 ? renderEstrellas(p.promedio, p.total_resenas) : ''}
                ${p.comentarios_activos ? renderResenasHomeCard(p) : ''}
                <a class="btn-reservar" href="${href}" rel="noopener">Reservar hora</a>
            </div>
        </article>`;
}

async function cargarDirectorioVivo() {
    const grid = document.getElementById('home-directorio-grid');
    if (!grid) return;

    let pymes = [];
    let slugs = {};
    try {
        pymes = await rpc('get_directorio_pymes');
        const ids = pymes.map(p => p.tenant_id).filter(Boolean);
        if (ids.length > 0) {
            const filas = await rpc('get_slugs_by_ids', { p_ids: ids });
            (filas || []).forEach(f => { if (f?.tenant_id && f?.slug) slugs[f.tenant_id] = f.slug; });
        }
    } catch (e) {
        // Si el directorio falla, ocultar la sección (no bloquear la portada)
        const sec = document.getElementById('directorio-vivo');
        if (sec) sec.style.display = 'none';
        return;
    }

    if (!pymes.length) {
        const sec = document.getElementById('directorio-vivo');
        if (sec) sec.style.display = 'none';
        return;
    }

    // Carrusel infinito con TODAS las pymes del directorio (marketing para cada negocio).
    // El track tiene N copias idénticas del grupo; animamos translateX(-100% / N),
    // así el bucle es invisible porque cada copia es idéntica a la anterior.
    const containerW = (grid.closest('.container') || grid).clientWidth || 1100;
    const CARW = 280, GAP = 20;
    const cards = pymes.map(p => renderCard(p, slugs[p.tenant_id]));
    const groupW = cards.length * (CARW + GAP);
    const copies = Math.max(2, Math.ceil((containerW * 2) / groupW));
    const groups = Array.from({ length: copies }, (_, i) =>
        `<div class="home-marquee-group"${i ? ' aria-hidden="true"' : ''}>${cards.join('')}</div>`
    ).join('');
    grid.innerHTML = `<div class="home-marquee"><div class="home-marquee-track">${groups}</div></div>`;
    const track = grid.querySelector('.home-marquee-track');
    // Velocidad constante ~45 px/s, ajustada al ancho real del contenido
    track.style.setProperty('--marquee-copies', copies);
    track.style.animationDuration = `${(groupW / 45).toFixed(2)}s`;
}

// ── Mocks de la portada con datos REALES del tenant (Miu) ──
// El hero y el demo muestran "Miu Street Workout" como ejemplo; sus servicios
// y precios se cargan desde la BD (nada hardcodeado/inventado).
const MOCK_TENANT_ID = 'bee07bcd-6c45-469b-aaf1-bf0e3481a3ca'; // Miu Street workout training

function formatearPrecio(valor) {
    const n = Number(valor);
    if (!isFinite(n) || n <= 0) return '';
    return '$' + Math.round(n).toLocaleString('es-CL');
}

async function cargarMockReal() {
    const heroNombre = document.getElementById('mock-servicio-nombre');
    const heroPrecio = document.getElementById('mock-servicio-precio');
    const demoLista = document.getElementById('mock-demo-list');
    if (!heroNombre && !heroPrecio && !demoLista) return;

    try {
        // Contexto RLS anónimo para leer el catálogo del tenant
        await rpc('set_tenant_anon', { p_tenant_id: MOCK_TENANT_ID });
        const resp = await fetch(`${SUPABASE_URL}/rest/v1/servicios?tenant_id=eq.${MOCK_TENANT_ID}&select=nombre,precio,duracion,descripcion&activo=eq.true&order=precio.asc`, {
            headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}` },
        });
        if (!resp.ok) throw new Error(`servicios HTTP ${resp.status}`);
        const servicios = await resp.json();
        if (!Array.isArray(servicios) || servicios.length === 0) return;

        const primero = servicios[0];
        const precio1 = formatearPrecio(primero.precio);
        if (heroNombre) heroNombre.textContent = primero.nombre || 'Entrenador personal';
        if (heroPrecio) heroPrecio.textContent = precio1 || '…';

        if (demoLista) {
            demoLista.innerHTML = servicios.slice(0, 3).map(s => {
                const p = formatearPrecio(s.precio);
                const dur = Number(s.duracion) > 0 ? ` · ${s.duracion} min` : '';
                return `<div class="mock-row"><span class="d">${escapeHtml(s.nombre)}</span><span class="v">${p}${dur}</span></div>`;
            }).join('');
        }
    } catch (e) {
        // Sin datos reales: dejar los placeholders neutrales (nada inventado)
        console.warn('[home-mock] No se pudieron cargar servicios reales:', e);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    cargarDirectorioVivo();
    cargarMockReal();
});
