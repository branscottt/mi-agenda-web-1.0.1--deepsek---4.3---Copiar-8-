// src/superadmin/ui/AuditDashboard.js
// Panel de auditoría para superadmin — se inyecta vía JS, no modifica HTML/CSS
//
// Agrega un tab "Auditoría" al panel superadmin que muestra:
//   - audit_log con filtros por tabla, operación, tenant
//   - Paginación (50 registros por página)
//   - Iconos por tipo de operación

const AUDIT_STYLES = `
  .audit-filters {
    display: flex;
    gap: 12px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  .audit-filters select, .audit-filters input {
    padding: 8px 12px;
    border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.15);
    background: rgba(255,255,255,0.05);
    color: #fff;
    font-size: 13px;
    min-width: 140px;
  }
  .audit-filters select option { background: #1a1a2e; color: #fff; }
  .audit-filters .audit-search-btn {
    padding: 8px 20px;
    background: linear-gradient(135deg, #667eea, #764ba2);
    border: none;
    border-radius: 8px;
    color: #fff;
    cursor: pointer;
    font-weight: 600;
    font-size: 13px;
  }
  .audit-filters .audit-search-btn:hover { opacity: 0.9; }
  .audit-table-container {
    overflow-x: auto;
    background: rgba(255,255,255,0.03);
    border-radius: 12px;
    padding: 4px;
  }
  .audit-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .audit-table th {
    text-align: left;
    padding: 12px 10px;
    border-bottom: 1px solid rgba(255,255,255,0.1);
    color: var(--text-muted, #aaa);
    font-weight: 600;
    white-space: nowrap;
  }
  .audit-table td {
    padding: 10px;
    border-bottom: 1px solid rgba(255,255,255,0.04);
    vertical-align: top;
  }
  .audit-table tr:hover td { background: rgba(255,255,255,0.03); }
  .audit-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
  }
  .audit-badge-INSERT { background: rgba(40,167,69,0.2); color: #28a745; }
  .audit-badge-UPDATE { background: rgba(0,123,255,0.2); color: #6ea8fe; }
  .audit-badge-DELETE { background: rgba(220,53,69,0.2); color: #dc3545; }
  .audit-details {
    font-size: 12px;
    color: var(--text-muted, #999);
    max-width: 250px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .audit-pagination {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 12px;
    margin-top: 16px;
    padding: 12px 0;
  }
  .audit-pagination button {
    padding: 6px 16px;
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 6px;
    color: #fff;
    cursor: pointer;
    font-size: 13px;
  }
  .audit-pagination button:hover:not(:disabled) { background: rgba(255,255,255,0.15); }
  .audit-pagination button:disabled { opacity: 0.3; cursor: default; }
  .audit-pagination span { color: var(--text-muted, #aaa); font-size: 13px; }
  .audit-empty {
    text-align: center;
    padding: 40px 20px;
    color: var(--text-muted, #888);
  }
  .audit-loading {
    text-align: center;
    padding: 40px;
    color: var(--text-muted, #888);
  }
`;

const PAGE_SIZE = 50;

function injectStyles() {
  if (document.getElementById('audit-styles')) return;
  const style = document.createElement('style');
  style.id = 'audit-styles';
  style.textContent = AUDIT_STYLES;
  document.head.appendChild(style);
}

function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleDateString('es-CL', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function truncateJSON(str) {
  if (!str) return '-';
  const s = typeof str === 'string' ? str : JSON.stringify(str);
  return s.length > 80 ? s.slice(0, 80) + '...' : s;
}

const OPERATION_ICONS = {
  INSERT: 'fa-plus-circle',
  UPDATE: 'fa-edit',
  DELETE: 'fa-trash-alt',
};

function injectAuditTab() {
  // No duplicar
  if (document.getElementById('tab-auditoria')) return;

  const tabBar = document.querySelector('.superadmin-tabs');
  if (!tabBar) return;

  // 1. Agregar botón de tab
  const btn = document.createElement('button');
  btn.className = 'tab-btn';
  btn.dataset.tab = 'auditoria';
  btn.innerHTML = '<i class="fas fa-history"></i> Auditoría';
  tabBar.appendChild(btn);

  // 2. Crear contenido del tab (después del último tab-content)
  const lastTab = tabBar.parentElement?.querySelector('.tab-content:last-of-type');
  const content = document.createElement('div');
  content.id = 'tab-auditoria';
  content.className = 'tab-content';
  content.style.display = 'none';
  content.innerHTML = `
    <div class="panel-header">
      <h3><i class="fas fa-history"></i> Registro de Auditoría</h3>
      <button class="btn-grad" id="audit-refresh-btn"><i class="fas fa-sync"></i> Refrescar</button>
    </div>
    <div class="audit-filters">
      <select id="audit-filter-table">
        <option value="">Todas las tablas</option>
        <option value="subscriptions">subscriptions</option>
        <option value="tenants">tenants</option>
        <option value="citas">citas</option>
        <option value="servicios">servicios</option>
      </select>
      <select id="audit-filter-operation">
        <option value="">Todas las operaciones</option>
        <option value="INSERT">INSERT</option>
        <option value="UPDATE">UPDATE</option>
        <option value="DELETE">DELETE</option>
      </select>
      <input type="text" id="audit-filter-tenant" placeholder="ID Tenant..." style="min-width:120px;">
      <button class="audit-search-btn" id="audit-search-btn"><i class="fas fa-search"></i> Buscar</button>
    </div>
    <div id="audit-content">
      <div class="audit-loading"><i class="fas fa-spinner fa-spin"></i> Cargando registro de auditoría...</div>
    </div>
    <div class="audit-pagination" id="audit-pagination" style="display:none;">
      <button id="audit-prev-btn"><i class="fas fa-chevron-left"></i> Anterior</button>
      <span id="audit-page-info">Página 1</span>
      <button id="audit-next-btn">Siguiente <i class="fas fa-chevron-right"></i></button>
    </div>
  `;

  if (lastTab && lastTab.parentElement) {
    lastTab.parentElement.insertBefore(content, lastTab.nextSibling);
  } else {
    tabBar.parentElement?.appendChild(content);
  }

  // 3. Vincular eventos
  btn.addEventListener('click', () => switchAuditTab(btn));

  document.getElementById('audit-refresh-btn')?.addEventListener('click', () => loadAuditLog());
  document.getElementById('audit-search-btn')?.addEventListener('click', () => {
    currentPage = 1;
    loadAuditLog();
  });

  document.getElementById('audit-prev-btn')?.addEventListener('click', () => {
    if (currentPage > 1) { currentPage--; loadAuditLog(); }
  });
  document.getElementById('audit-next-btn')?.addEventListener('click', () => {
    if (hasMore) { currentPage++; loadAuditLog(); }
  });

  // Enter en filtro tenant
  document.getElementById('audit-filter-tenant')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { currentPage = 1; loadAuditLog(); }
  });
}

let currentPage = 1;
let hasMore = false;

function switchAuditTab(btn) {
  // Ocultar todos los tabs
  document.querySelectorAll('.tab-content').forEach(tc => tc.style.display = 'none');
  document.querySelectorAll('.tab-btn').forEach(tb => tb.classList.remove('active'));

  // Mostrar este tab
  const content = document.getElementById('tab-auditoria');
  if (content) content.style.display = 'block';
  btn.classList.add('active');

  // Cargar datos
  loadAuditLog();
}

async function loadAuditLog() {
  const contentEl = document.getElementById('audit-content');
  if (!contentEl) return;

  contentEl.innerHTML = '<div class="audit-loading"><i class="fas fa-spinner fa-spin"></i> Cargando...</div>';

  const supabase = window.supabaseClient || window.supabase;
  if (!supabase) {
    contentEl.innerHTML = '<div class="audit-empty"><i class="fas fa-exclamation-triangle"></i> Cliente Supabase no disponible</div>';
    return;
  }

  try {
    const tableFilter = document.getElementById('audit-filter-table')?.value || '';
    const opFilter = document.getElementById('audit-filter-operation')?.value || '';
    const tenantFilter = document.getElementById('audit-filter-tenant')?.value?.trim() || '';

    let query = supabase
      .from('audit_log')
      .select('*', { count: 'estimated' })
      .order('created_at', { ascending: false })
      .range((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE - 1);

    if (tableFilter) query = query.eq('table_name', tableFilter);
    if (opFilter) query = query.eq('operation', opFilter);
    if (tenantFilter) query = query.eq('tenant_id', tenantFilter);

    const { data, error, count } = await query;

    if (error) {
      contentEl.innerHTML = `<div class="audit-empty">
        <i class="fas fa-exclamation-triangle"></i>
        <p>Error al cargar auditoría: ${error.message}</p>
        <p style="font-size:12px;color:var(--text-muted);">Solo super admin puede ver este registro.</p>
      </div>`;
      document.getElementById('audit-pagination').style.display = 'none';
      return;
    }

    if (!data || data.length === 0) {
      contentEl.innerHTML = '<div class="audit-empty"><i class="fas fa-inbox"></i> No hay registros de auditoría con estos filtros.</div>';
      document.getElementById('audit-pagination').style.display = 'none';
      return;
    }

    // Renderizar tabla
    let html = '<div class="audit-table-container"><table class="audit-table"><thead><tr>' +
      '<th>Fecha</th><th>Tabla</th><th>Operación</th><th>Tenant</th><th>Usuario</th><th>Detalles</th>' +
      '</tr></thead><tbody>';

    for (const row of data) {
      const opIcon = OPERATION_ICONS[row.operation] || 'fa-info-circle';
      const oldData = row.old_data ? truncateJSON(row.old_data) : '';
      const newData = row.new_data ? truncateJSON(row.new_data) : '';

      html += `<tr>
        <td style="white-space:nowrap;">${formatDate(row.created_at)}</td>
        <td><code>${row.table_name || '-'}</code></td>
        <td><span class="audit-badge audit-badge-${row.operation}"><i class="fas ${opIcon}"></i> ${row.operation}</span></td>
        <td style="font-size:12px;">${row.tenant_id ? row.tenant_id.slice(0, 12) + '...' : '-'}</td>
        <td style="font-size:12px;">${row.user_id ? row.user_id.slice(0, 12) + '...' : '-'}</td>
        <td>
          ${oldData ? `<div class="audit-details" title="${oldData}"><i class="fas fa-arrow-left" style="color:#dc3545;"></i> ${oldData}</div>` : ''}
          ${newData ? `<div class="audit-details" title="${newData}"><i class="fas fa-arrow-right" style="color:#28a745;"></i> ${newData}</div>` : ''}
        </td>
      </tr>`;
    }

    html += '</tbody></table></div>';
    contentEl.innerHTML = html;

    // Paginación
    hasMore = data.length === PAGE_SIZE;
    const pagination = document.getElementById('audit-pagination');
    if (pagination) {
      pagination.style.display = 'flex';
      document.getElementById('audit-prev-btn').disabled = currentPage <= 1;
      document.getElementById('audit-next-btn').disabled = !hasMore;
      document.getElementById('audit-page-info').textContent = `Página ${currentPage}${count ? ` (${count} registros)` : ''}`;
    }
  } catch (err) {
    contentEl.innerHTML = `<div class="audit-empty"><i class="fas fa-exclamation-triangle"></i> Error: ${err.message}</div>`;
    document.getElementById('audit-pagination').style.display = 'none';
  }
}

/**
 * Inicializa el panel de auditoría en superadmin
 */
export function initAuditDashboard() {
  const esSuperAdmin = document.querySelector('.superadmin-screen');
  if (!esSuperAdmin) return;

  injectStyles();
  injectAuditTab();
  console.log('[AuditDashboard] Panel de auditoría listo');
}
