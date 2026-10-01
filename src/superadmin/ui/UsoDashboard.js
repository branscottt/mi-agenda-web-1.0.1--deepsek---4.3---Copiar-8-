// src/superadmin/ui/UsoDashboard.js
// Panel "Uso" del superadmin — se inyecta por JS (no toca HTML/CSS base).
//
// Responde la pregunta: ¿qué hace y qué NO hace cada negocio?
//   - Datos duros (servicios, citas, clientes, archivos, bandeja, trello, ventas live)
//   - Eventos de producto (tenant_eventos): qué pantallas y flujos usó
//   - Cambios de datos (audit_log): qué tablas tocó en 30 días
//   - Veredicto legible + "qué usa / qué NO" por negocio
//   - Detalle por negocio (modal) y export CSV para hacer el estudio
//
// Fuentes: RPC get_uso_tenants() y get_tenant_uso(uuid) (migración 20261045).

const USO_STYLES = `
  .uso-wrap { --uso-ok:#00b894; --uso-no:#6b7280; --uso-warn:#ffc107; }
  .uso-filtros { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:14px; }
  .uso-filtros input, .uso-filtros select {
    padding:8px 12px; border-radius:8px; border:1px solid rgba(255,255,255,0.15);
    background:rgba(255,255,255,0.05); color:#fff; font-size:13px; min-width:150px;
  }
  .uso-filtros select option { background:#1a1a2e; color:#fff; }
  .uso-chip-btn {
    padding:7px 14px; border-radius:999px; border:1px solid rgba(255,255,255,0.15);
    background:rgba(255,255,255,0.05); color:#fff; cursor:pointer; font-size:12px; font-weight:600;
  }
  .uso-chip-btn.activo { background:linear-gradient(135deg,#9d4edd,#00b894); border-color:transparent; }
  .uso-tabla-cont { overflow-x:auto; background:rgba(255,255,255,0.03); border-radius:12px; padding:4px; }
  .uso-tabla { width:100%; border-collapse:collapse; font-size:13px; }
  .uso-tabla th {
    text-align:left; padding:11px 9px; border-bottom:1px solid rgba(255,255,255,0.1);
    color:var(--text-muted,#aaa); font-weight:600; white-space:nowrap; font-size:12px;
  }
  .uso-tabla td { padding:9px; border-bottom:1px solid rgba(255,255,255,0.04); vertical-align:middle; }
  .uso-tabla tr:hover td { background:rgba(255,255,255,0.03); }
  .uso-num { font-weight:700; font-variant-numeric:tabular-nums; }
  .uso-num.cero { color:#5a5f6e; font-weight:500; }
  .uso-num.si { color:#7ee2b8; }
  .uso-chip {
    display:inline-block; padding:2px 8px; border-radius:10px; font-size:10.5px;
    font-weight:700; margin:1px 2px 1px 0; white-space:nowrap;
  }
  .uso-chip.si { background:rgba(0,184,148,0.16); color:#3ddc97; }
  .uso-chip.no { background:rgba(255,255,255,0.05); color:#7b8194; }
  .uso-chip.warn { background:rgba(255,193,7,0.14); color:#ffc107; }
  .uso-chip.err { background:rgba(255,80,80,0.14); color:#ff6b6b; }
  .uso-ver { font-weight:700; font-size:12px; }
  .uso-detalle-btn {
    padding:5px 12px; border-radius:8px; border:1px solid rgba(157,78,221,0.35);
    background:rgba(157,78,221,0.12); color:#c77dff; cursor:pointer; font-size:12px; font-weight:600;
  }
  .uso-resumen { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; }
  .uso-kpi {
    flex:1; min-width:130px; padding:11px 14px; border-radius:12px;
    background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08);
  }
  .uso-kpi .k { font-size:11px; color:var(--text-muted,#8b8fa3); text-transform:uppercase; letter-spacing:.5px; }
  .uso-kpi .v { font-size:20px; font-weight:800; color:#c77dff; }
  .uso-overlay {
    position:fixed; inset:0; background:rgba(5,5,8,0.85); backdrop-filter:blur(4px);
    z-index:99999; display:flex; align-items:center; justify-content:center; padding:20px;
  }
  .uso-modal {
    background:rgba(20,20,30,0.98); border:1px solid rgba(199,125,255,0.35); border-radius:16px;
    max-width:720px; width:100%; padding:24px; box-shadow:0 24px 70px rgba(0,0,0,0.6);
    max-height:90vh; overflow-y:auto;
  }
  .uso-barra { height:6px; border-radius:4px; background:rgba(255,255,255,0.08); overflow:hidden; }
  .uso-barra > span { display:block; height:100%; background:linear-gradient(90deg,#9d4edd,#00b894); }
  .uso-vacio { text-align:center; padding:34px; color:var(--text-muted,#888); }
`;

const FEATURES = [
  { key: 'servicios', label: 'Crear servicios' },
  { key: 'citas', label: 'Reservas' },
  { key: 'clientes', label: 'Mis clientes' },
  { key: 'archivos', label: 'Mudanza/Archivos' },
  { key: 'tableros', label: 'Trello cliente' },
  { key: 'ventas_live', label: 'Ventas Live' }
];

let DATOS = [];

function supabaseClient() {
  return window.supabaseClient || window.supabase || null;
}

function injectStyles() {
  if (document.getElementById('uso-styles')) return;
  const s = document.createElement('style');
  s.id = 'uso-styles';
  s.textContent = USO_STYLES;
  document.head.appendChild(s);
}

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtFecha(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function diasDesde(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function num(n, si) {
  const v = Number(n) || 0;
  return `<span class="uso-num ${v === 0 ? 'cero' : (si ? 'si' : '')}">${v}</span>`;
}

/** Señales de uso reales (datos + eventos). */
function senales(r) {
  const ev = r.eventos_top || {};
  const claves = Object.keys(ev);
  const tiene = (frag) => claves.some(k => k.indexOf(frag) === 0);
  return {
    servicios: Number(r.servicios) > 0 || tiene('servicio_creado'),
    citas: Number(r.citas) > 0,
    clientes: Number(r.clientes) > 0 || tiene('mudanza_clientes_importados'),
    archivos: Number(r.archivos) > 0 || Number(r.huerfanos) > 0 || tiene('mudanza_archivos') || tiene('archivos_'),
    tableros: Number(r.tableros) > 0 || tiene('trello_'),
    ventas_live: Number(r.vl_lives) > 0 || Number(r.vl_clientes) > 0,
    chat_crear: tiene('svc_chat_visto'),
    form_manual: tiene('svc_form_manual'),
    editar_chat: tiene('svc_edicion_por_chat'),
    bandeja: tiene('bandeja_'),
    secciones: claves.filter(k => k.indexOf('seccion_') === 0).length
  };
}

function veredicto(r) {
  const s = senales(r);
  const dAct = diasDesde(r.ultima_actividad);
  const dLog = diasDesde(r.ultimo_login);
  const usos = FEATURES.filter(f => s[f.key]).length;

  if (Number(r.servicios) === 0 && Number(r.citas) === 0 && Number(r.eventos_total) === 0) {
    return { txt: 'No hizo nada todavía', color: '#6b7280', chip: 'err' };
  }
  if (Number(r.citas) === 0 && Number(r.servicios) > 0) {
    return { txt: 'Configuró servicios, sin reservas aún', color: '#ffc107', chip: 'warn' };
  }
  if (Number(r.citas) > 0 && Number(r.citas_30d) === 0) {
    return { txt: 'Usó reservas pero lleva +30 días sin reservar', color: '#ffc107', chip: 'warn' };
  }
  if (usos >= 4) return { txt: 'Activo y usa varias herramientas', color: '#3ddc97', chip: 'si' };
  if (Number(r.citas_30d) > 0) return { txt: 'Activo: usa reservas', color: '#3ddc97', chip: 'si' };
  if (dLog === null || dLog > 30) return { txt: 'Entró, pero sin actividad reciente', color: '#ffc107', chip: 'warn' };
  return { txt: 'Con actividad', color: '#3ddc97', chip: 'si' };
}

function chipsUso(r) {
  const s = senales(r);
  const usaHtml = FEATURES.filter(f => s[f.key])
    .map(f => `<span class="uso-chip si">✓ ${esc(f.label)}</span>`).join('');
  const noHtml = FEATURES.filter(f => !s[f.key])
    .map(f => `<span class="uso-chip no">✗ ${esc(f.label)}</span>`).join('');
  return `<div style="max-width:260px;">${usaHtml || '<span class="uso-chip no">nada aún</span>'}${noHtml}</div>`;
}

function render() {
  const cont = document.getElementById('uso-content');
  if (!cont) return;
  const filtro = (document.getElementById('uso-buscar')?.value || '').toLowerCase().trim();
  const modo = document.getElementById('uso-modo')?.value || 'todos';

  let filas = DATOS.slice();
  if (filtro) filas = filas.filter(r => String(r.nombre_negocio || '').toLowerCase().includes(filtro));
  if (modo === 'activos') filas = filas.filter(r => Number(r.citas_30d) > 0 || Number(r.eventos_30d) > 0);
  else if (modo === 'sin_uso') filas = filas.filter(r => Number(r.servicios) === 0 && Number(r.citas) === 0 && Number(r.eventos_total) === 0);
  else if (modo === 'sin_archivos') filas = filas.filter(r => Number(r.archivos) === 0 && Number(r.huerfanos) === 0);

  const tot = {
    negocios: DATOS.length,
    con_citas: DATOS.filter(r => Number(r.citas) > 0).length,
    con_archivos: DATOS.filter(r => Number(r.archivos) > 0 || Number(r.huerfanos) > 0).length,
    con_trello: DATOS.filter(r => Number(r.tableros) > 0).length,
    sin_nada: DATOS.filter(r => Number(r.servicios) === 0 && Number(r.citas) === 0 && Number(r.eventos_total) === 0).length
  };

  cont.innerHTML = `
    <div class="uso-resumen uso-wrap">
      <div class="uso-kpi"><div class="k">Negocios</div><div class="v">${tot.negocios}</div></div>
      <div class="uso-kpi"><div class="k">Con reservas</div><div class="v">${tot.con_citas}</div></div>
      <div class="uso-kpi"><div class="k">Usa Archivos/Mudanza</div><div class="v">${tot.con_archivos}</div></div>
      <div class="uso-kpi"><div class="k">Usa Trello</div><div class="v">${tot.con_trello}</div></div>
      <div class="uso-kpi"><div class="k">Sin uso</div><div class="v" style="color:#ff6b6b">${tot.sin_nada}</div></div>
    </div>
    ${filas.length === 0 ? '<div class="uso-vacio"><i class="fas fa-inbox"></i> Sin negocios con este filtro.</div>' : `
    <div class="uso-tabla-cont">
      <table class="uso-tabla">
        <thead><tr>
          <th>Negocio</th><th>Plan</th><th>Últ. acceso</th>
          <th>Serv.</th><th>Citas</th><th>Clientes</th><th>Archivos</th><th>Bandeja</th>
          <th>Trello</th><th>Ventas</th><th>Ev. 7d</th>
          <th>Qué usa / qué NO</th><th>Veredicto</th><th></th>
        </tr></thead>
        <tbody>
          ${filas.map(r => {
            const v = veredicto(r);
            return `<tr>
              <td style="max-width:180px;"><strong>${esc(r.nombre_negocio || '(sin nombre)')}</strong><div style="font-size:11px;color:#8b8fa3;">${(r.proyecto === 'ventas_live') ? 'ventas live' : 'reservas'} · ${esc(String(r.tenant_id).slice(0, 8))}</div></td>
              <td style="font-size:12px;">${esc(r.plan || '—')}<div style="font-size:11px;color:#8b8fa3;">${esc(r.estado || '')}</div></td>
              <td style="font-size:12px;white-space:nowrap;">${fmtFecha(r.ultimo_login)}</td>
              <td>${num(r.servicios)}</td>
              <td>${num(r.citas)}</td>
              <td>${num(r.clientes)}</td>
              <td>${num(r.archivos)}</td>
              <td>${num(r.huerfanos)}</td>
              <td>${num(r.tableros)}</td>
              <td>${num(Number(r.vl_lives) + Number(r.vl_clientes))}</td>
              <td>${num(r.eventos_7d)}</td>
              <td>${chipsUso(r)}</td>
              <td><span class="uso-ver" style="color:${v.color}">${esc(v.txt)}</span></td>
              <td><button class="uso-detalle-btn" data-tid="${esc(r.tenant_id)}" data-nom="${esc(r.nombre_negocio)}">Detalle</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`}
    <p style="font-size:11.5px;color:#8b8fa3;margin-top:10px;">
      «Ev.» = eventos de uso registrados por la web (pantallas y flujos tocados).
      «Archivos» = archivos guardados en la carpeta de algún cliente; «Bandeja» = archivos esperando dueño.
    </p>
  `;

  cont.querySelectorAll('.uso-detalle-btn').forEach(b => {
    b.addEventListener('click', () => abrirDetalle(b.dataset.tid, b.dataset.nom));
  });
}

async function cargar() {
  const cont = document.getElementById('uso-content');
  if (!cont) return;
  cont.innerHTML = '<div class="uso-vacio"><i class="fas fa-spinner fa-spin"></i> Cargando uso de los negocios...</div>';
  const sb = supabaseClient();
  if (!sb) { cont.innerHTML = '<div class="uso-vacio">Cliente Supabase no disponible</div>'; return; }
  try {
    const { data, error } = await sb.rpc('get_uso_tenants');
    if (error) throw error;
    DATOS = Array.isArray(data) ? data : [];
    render();
  } catch (e) {
    cont.innerHTML = `<div class="uso-vacio"><i class="fas fa-exclamation-triangle"></i> Error al cargar el uso: ${esc(e.message || e)}</div>`;
  }
}

async function abrirDetalle(tenantId, nombre) {
  const sb = supabaseClient();
  if (!sb) return;
  const ov = document.createElement('div');
  ov.className = 'uso-overlay';
  ov.innerHTML = '<div class="uso-modal"><div class="uso-vacio"><i class="fas fa-spinner fa-spin"></i> Cargando detalle...</div></div>';
  document.body.appendChild(ov);
  const cerrar = () => ov.remove();
  ov.addEventListener('click', (e) => { if (e.target === ov) cerrar(); });
  const onEsc = (e) => { if (e.key === 'Escape') { cerrar(); document.removeEventListener('keydown', onEsc, true); } };
  document.addEventListener('keydown', onEsc, true);

  try {
    const { data, error } = await sb.rpc('get_tenant_uso', { p_tenant_id: tenantId });
    if (error) throw error;
    const d = data || {};
    const eventos = Array.isArray(d.eventos) ? d.eventos : [];
    const serie = Array.isArray(d.serie_14d) ? d.serie_14d : [];
    const cambios = d.cambios || {};
    const maxSerie = Math.max(1, ...serie.map(x => Number(x.n) || 0));
    const ultimos = Array.isArray(d.ultimos_eventos) ? d.ultimos_eventos : [];

    ov.querySelector('.uso-modal').innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <h3 style="margin:0;font-size:1.05rem;"><i class="fas fa-chart-bar" style="color:#c77dff;"></i> ${esc(nombre || d.nombre_negocio || 'Negocio')}</h3>
        <button class="uso-detalle-btn" id="uso-cerrar">Cerrar ×</button>
      </div>
      <div class="uso-resumen">
        <div class="uso-kpi"><div class="k">Servicios</div><div class="v">${Number(d.servicios) || 0}</div></div>
        <div class="uso-kpi"><div class="k">Citas</div><div class="v">${Number(d.citas) || 0}</div></div>
        <div class="uso-kpi"><div class="k">Clientes</div><div class="v">${Number(d.clientes) || 0}</div></div>
        <div class="uso-kpi"><div class="k">Archivos</div><div class="v">${Number(d.archivos) || 0}</div></div>
        <div class="uso-kpi"><div class="k">Sin dueño</div><div class="v">${Number(d.huerfanos) || 0}</div></div>
        <div class="uso-kpi"><div class="k">Eventos</div><div class="v">${Number(d.eventos_total) || 0}</div></div>
      </div>
      <div style="font-size:12px;color:#8b8fa3;margin-bottom:16px;">
        Último acceso: <strong style="color:#f8f9fa">${fmtFecha(d.ultimo_login)}</strong> ·
        Registrado: <strong style="color:#f8f9fa">${fmtFecha(d.registrado)}</strong> ·
        Plan: <strong style="color:#f8f9fa">${esc(d.plan || '—')}</strong>
      </div>

      <div style="margin-bottom:16px;">
        <div style="font-weight:700;font-size:13px;margin-bottom:8px;">Actividad de los últimos 14 días</div>
        <div style="display:flex;gap:3px;align-items:flex-end;height:60px;">
          ${serie.map(x => `<div title="${esc(x.dia)}: ${Number(x.n) || 0} evento(s)" style="flex:1;background:${Number(x.n) ? 'linear-gradient(180deg,#c77dff,#00b894)' : 'rgba(255,255,255,0.07)'};height:${Math.max(4, Math.round((Number(x.n) || 0) / maxSerie * 60))}px;border-radius:3px;"></div>`).join('')}
        </div>
      </div>

      <div style="margin-bottom:16px;">
        <div style="font-weight:700;font-size:13px;margin-bottom:8px;">Qué pantallas / flujos usó (eventos)</div>
        ${eventos.length ? eventos.map(e => `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;font-size:12px;">
            <span style="width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(e.evento)}</span>
            <span class="uso-barra" style="flex:1;"><span style="width:${Math.min(100, Math.round(Number(e.veces) / Math.max(1, Number(eventos[0].veces)) * 100))}%"></span></span>
            <span style="width:44px;text-align:right;font-weight:700;">${Number(e.veces) || 0}</span>
            <span style="width:80px;text-align:right;color:#8b8fa3;">${fmtFecha(e.ultima)}</span>
          </div>`).join('') : '<div style="font-size:12px;color:#8b8fa3;">Sin eventos registrados (aún). Los eventos empezaron a guardarse con esta versión.</div>'}
      </div>

      <div style="margin-bottom:16px;">
        <div style="font-weight:700;font-size:13px;margin-bottom:8px;">Qué datos tocó (cambios auditados)</div>
        ${Object.keys(cambios).length ? Object.entries(cambios).map(([k, v]) => `<span class="uso-chip si">${esc(k)}: ${Number(v) || 0}</span>`).join('') : '<span style="font-size:12px;color:#8b8fa3;">Sin cambios auditados.</span>'}
      </div>

      <div>
        <div style="font-weight:700;font-size:13px;margin-bottom:8px;">Últimos eventos</div>
        ${ultimos.length ? `<div style="max-height:190px;overflow-y:auto;font-size:12px;">
          ${ultimos.map(u => `<div style="display:flex;gap:8px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
            <span style="flex:1;">${esc(u.evento)} <span style="color:#8b8fa3;">${esc(JSON.stringify(u.props || {}).slice(0, 80))}</span></span>
            <span style="color:#8b8fa3;white-space:nowrap;">${fmtFecha(u.en)}</span>
          </div>`).join('')}
        </div>` : '<span style="font-size:12px;color:#8b8fa3;">Sin eventos.</span>'}
      </div>
    `;
    ov.querySelector('#uso-cerrar').addEventListener('click', cerrar);
  } catch (e) {
    ov.querySelector('.uso-modal').innerHTML = `<div class="uso-vacio">Error: ${esc(e.message || e)}</div>`;
  }
}

function exportarCSV() {
  if (!DATOS.length) return;
  const cols = ['nombre_negocio', 'plan', 'estado', 'ultimo_login', 'ultima_actividad', 'servicios', 'citas', 'citas_30d', 'clientes', 'archivos', 'huerfanos', 'tableros', 'tarjetas', 'vl_lives', 'vl_clientes', 'eventos_total', 'eventos_7d', 'eventos_30d'];
  const escCsv = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lineas = [cols.join(',') + ',veredicto'];
  DATOS.forEach(r => lineas.push(cols.map(c => escCsv(r[c])).join(',') + ',' + escCsv(veredicto(r).txt)));
  const blob = new Blob([lineas.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'uso-negocios.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

export function initUsoDashboard() {
  if (!document.querySelector('.superadmin-screen')) return;
  injectStyles();
  injectUsoTab();
}

function injectUsoTab() {
  if (document.getElementById('tab-uso')) return;
  const tabBar = document.querySelector('.superadmin-tabs');
  if (!tabBar) return;

  const btn = document.createElement('button');
  btn.className = 'tab-btn';
  btn.dataset.tab = 'uso';
  btn.innerHTML = '<i class="fas fa-chart-line"></i> Uso';
  tabBar.appendChild(btn);

  const content = document.createElement('div');
  content.id = 'tab-uso';
  content.className = 'tab-content';
  content.style.display = 'none';
  content.innerHTML = `
    <div class="uso-wrap">
      <div class="panel-header">
        <h3><i class="fas fa-chart-line"></i> Uso de los negocios</h3>
        <div style="display:flex;gap:8px;">
          <button class="uso-detalle-btn" id="uso-csv-btn"><i class="fas fa-file-csv"></i> Exportar CSV</button>
          <button class="uso-detalle-btn" id="uso-refresh-btn"><i class="fas fa-sync"></i> Refrescar</button>
        </div>
      </div>
      <div class="uso-filtros">
        <select id="uso-modo">
          <option value="todos">Todos los negocios</option>
          <option value="activos">Con actividad (30 días)</option>
          <option value="sin_uso">Sin ningún uso</option>
          <option value="sin_archivos">Sin usar Archivos/Mudanza</option>
        </select>
        <input type="text" id="uso-buscar" placeholder="Buscar negocio...">
      </div>
      <div id="uso-content"><div class="uso-vacio"><i class="fas fa-spinner fa-spin"></i> Cargando...</div></div>
    </div>
  `;

  const lastTab = tabBar.parentElement?.querySelector('.tab-content:last-of-type');
  if (lastTab && lastTab.parentElement) lastTab.parentElement.insertBefore(content, lastTab.nextSibling);
  else tabBar.parentElement?.appendChild(content);

  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-content').forEach(tc => { tc.style.display = 'none'; });
    document.querySelectorAll('.tab-btn').forEach(tb => tb.classList.remove('active'));
    content.style.display = 'block';
    btn.classList.add('active');
    cargar();
  });

  content.querySelector('#uso-refresh-btn')?.addEventListener('click', cargar);
  content.querySelector('#uso-csv-btn')?.addEventListener('click', exportarCSV);
  content.querySelector('#uso-modo')?.addEventListener('change', render);
  content.querySelector('#uso-buscar')?.addEventListener('input', render);
}
