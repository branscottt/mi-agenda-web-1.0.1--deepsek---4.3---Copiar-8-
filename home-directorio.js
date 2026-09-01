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
                ${p.estrellas_activas ? renderEstrellas(p.promedio, p.total_resenas) : ''}
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

    // Muestra aleatoria: cuando haya muchos, cada visita muestra otros
    const muestra = [...pymes].sort(() => Math.random() - 0.5).slice(0, 6);
    grid.innerHTML = muestra.map(p => renderCard(p, slugs[p.tenant_id])).join('');
}

document.addEventListener('DOMContentLoaded', cargarDirectorioVivo);
