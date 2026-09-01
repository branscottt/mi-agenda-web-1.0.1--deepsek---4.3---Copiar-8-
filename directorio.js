// directorio.js — Directorio público de PYMEs (página SEO, sin login)
// La anon key es PÚBLICA por diseño (los datos se protegen con RLS/RPCs).
const SUPABASE_URL = "https://dfcfimipkfhitlsyixqu.supabase.co";
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRmY2ZpbWlwa2ZoaXRsc3lpeHF1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxNzczMzAsImV4cCI6MjA4ODc1MzMzMH0.1OviTiPxYIK83bbmrYVY1nUR2o0bxn_wfqnWqK4Ccw0";

const CATEGORIAS = [["salud", "Salud y Bienestar Cl\u00ednico"], ["estetica", "Est\u00e9tica, Belleza y Cuidado Personal"], ["deporte", "Deporte, Actividad F\u00edsica y Clases"], ["profesionales", "Servicios Profesionales y Creativos"], ["tecnicos", "Servicios T\u00e9cnicos, Hogar y Terreno"]];

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
    return `<span class="stars">${stars}${count}</span>`;
}

function renderCard(p, slug) {
    const fotos = Array.isArray(p.fotos) ? p.fotos.filter(Boolean) : [];
    const portada = fotos[0] || p.logo_url || '';
    const href = slug ? `/p/${encodeURIComponent(slug)}` : `cliente.html?tenant_id=${encodeURIComponent(p.tenant_id)}`;
    return `
        <article class="card">
            <div class="card-cover">
                ${portada
                    ? `<img src="${escapeHtml(portada)}" alt="${escapeHtml(p.nombre_negocio)}" loading="lazy" onerror="this.style.display='none'">`
                    : '🏪'}
            </div>
            <div class="card-body">
                <h2>${escapeHtml(p.nombre_negocio)}</h2>
                <div class="cat">${escapeHtml(p.tipo_pyme || p.categoria || 'Pyme')}</div>
                ${p.direccion ? `<div class="dir">📍 ${escapeHtml(p.direccion)}</div>` : ''}
                ${p.estrellas_activas ? renderEstrellas(p.promedio, p.total_resenas) : ''}
                <a class="btn-reservar" href="${href}" rel="noopener">Reservar hora</a>
            </div>
        </article>`;
}

async function cargar() {
    const chipsEl = document.getElementById('directorio-chips');
    const grid = document.getElementById('directorio-grid');
    const buscar = document.getElementById('directorio-buscar');

    let filtro = 'todas';
    let termino = '';

    chipsEl.innerHTML = '<button class="chip active" data-cat="todas">Todas</button>' +
        CATEGORIAS.map(([id, nombre]) => `<button class="chip" data-cat="${id}">${escapeHtml(nombre)}</button>`).join('');

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
        grid.innerHTML = '<p class="empty">No se pudo cargar el directorio. Intenta de nuevo.</p>';
        return;
    }

    function filtrar() {
        const term = termino.trim().toLowerCase();
        return pymes.filter(p => {
            if (filtro !== 'todas' && p.categoria !== filtro) return false;
            if (!term) return true;
            return (p.nombre_negocio || '').toLowerCase().includes(term)
                || (p.tipo_pyme || '').toLowerCase().includes(term)
                || (p.direccion || '').toLowerCase().includes(term);
        });
    }

    function render() {
        const visibles = filtrar();
        grid.innerHTML = visibles.length === 0
            ? '<p class="empty">No encontramos pymes con ese filtro.</p>'
            : visibles.map(p => renderCard(p, slugs[p.tenant_id])).join('');
    }

    chipsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.chip');
        if (!btn) return;
        chipsEl.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        filtro = btn.dataset.cat;
        render();
    });

    buscar.addEventListener('input', (e) => { termino = e.target.value; render(); });

    render();
}

document.addEventListener('DOMContentLoaded', cargar);
