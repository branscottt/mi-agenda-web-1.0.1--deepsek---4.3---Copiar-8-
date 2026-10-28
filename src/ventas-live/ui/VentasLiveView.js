// ventas-live/ui/VentasLiveView.js
// Orquestador del workspace Ventas Live: identidad del espacio, plan
// y navegación entre secciones (LIVE / Procesos / Clientes / Envíos /
// Finanzas). Cada sección se construye en su propio módulo; el router
// las activa bajo demanda (patrón Strangler Fig de la app).
// El workspace vl se resuelve SIEMPRE vía RPC get_mis_proyectos
// (server-side), nunca desde el tenant_id del JWT.

import { getSupabase } from '../../shared/infrastructure/supabase.js';
import { vlApi } from '../domain/vlApi.js';
import { abrirModal, cerrarModal } from './vlModales.js';
import { abrirCapa, consumirCapa, hayCapa, reemplazarCapa } from './vlAtras.js';
import { mostrarToast } from '../../shared/infrastructure/toast.js';
import { escapeHtml } from '../../shared/infrastructure/formatters.js';
import { getAppConfig } from '../../shared/infrastructure/config.js';

const PLAN_LABELS = { vl_free: 'Gratis' };

// Situaciones del bot para el configurador de respuestas: agrupa los momentos
// del guion por el TIPO de situación (no una lista plana). El orden sigue el
// camino real de una clienta: nuevo → identificar → conocido → fotos → pago →
// comprobante → entrega (y sus ramas envío / presencial).
const GRUPOS = [
    { id: 'nuevo', emoji: '🟢', color: '#25d366', nombre: 'Cliente nuevo — primer contacto',
      claves: ['tiktok_inicial', 'prenda_sin_usuario'] },
    { id: 'identificar', emoji: '🔎', color: '#c77dff', nombre: 'Identificar al usuario (tipo buscador)',
      claves: ['eres_usuario', 'eres_lista_titulo', 'eres_lista_pie', 'no_encontrado_lista', 'sin_compras', 'reescribe_usuario', 'identif_no_se', 'tienes_fotito'] },
    { id: 'conocido', emoji: '👋', color: '#4dd0e1', nombre: 'Ya te conoce (escribe desde su WhatsApp)',
      claves: ['habitual_saludo', 'habitual_saludo_extra'] },
    { id: 'foto', emoji: '📸', color: '#ffb4a2', nombre: 'Cuando manda una foto',
      claves: ['prenda_llevas', 'prenda_anotado', 'prenda_total_prometido'] },
    { id: 'pago', emoji: '💰', color: '#ffd166', nombre: 'Total y datos para pagar (cuánto era / me mandas datos)',
      claves: ['identificado_total_prefix', 'identificado_total_sufijo', 'datos_intro', 'pago_parcial_prefix', 'pago_titulo', 'pago_sin_datos'] },
    { id: 'comprobante', emoji: '🧾', color: '#f5a3c7', nombre: 'Comprobante y pagos',
      claves: ['pago_confirmado', 'quiero_pagar_pregunta', 'comprobante_pedir', 'comprobante_recibido', 'ya_pago_comprobante'] },
    { id: 'entrega', emoji: '📦', color: '#9d4edd', nombre: 'Entrega: envío o presencial',
      claves: ['pregunta_entrega', 'responde_envio', 'responde_presencial', 'datos_mandados', 'identificado_datitos', 'pospone_compra'] },
    { id: 'envio', emoji: '🚚', color: '#4c8bf5', nombre: '↳ Rama ENVÍO (courier)',
      claves: ['confirma_misma_direccion', 'falta_courier', 'pide_otra_direccion'] },
    { id: 'presencial', emoji: '🤝', color: '#2dd4bf', nombre: '↳ Rama ENTREGA PRESENCIAL (vernos)',
      claves: ['pedir_dia', 'no_puede_pagar', 'pagara_presencial'] }
];

// URL pública del webhook de WhatsApp (la misma que se pega en Meta).
const WA_WEBHOOK_URL = (getAppConfig().supabaseUrl || '').replace(/\/+$/, '') + '/functions/v1/wa-webhook';

// Todas las vistas están implementadas (Live, Procesos, Clientes,
// Envíos, Finanzas).
const PENDIENTES = {};

let _initialized = false;

export function initVentasLive() {
    if (_initialized) return;
    _initialized = true;
    renderVentasLive().catch(e => {
        console.error('[VentasLiveView] Error:', e);
        const loading = document.getElementById('vl-loading');
        if (loading) loading.innerHTML = '<i class="fas fa-exclamation-triangle"></i> No se pudo cargar tu espacio. <a href="ventas-live.html" style="color:#c77dff;">Reintentar</a>';
    });
}

async function renderVentasLive() {
    const supabase = getSupabase();
    if (!supabase) {
        window.location.href = 'login.html';
        return;
    }

    const JwtManager = (await import('../../auth/infrastructure/JwtManager.js')).JwtManager;
    const userData = JwtManager.getUserData();
    if (!userData) {
        window.location.href = 'login.html';
        return;
    }
    if (userData.rol === 'super_admin') {
        window.location.href = 'superadmin.html';
        return;
    }

    // Volver al hub
    const backBtn = document.getElementById('vl-back-hub');
    if (backBtn) {
        backBtn.addEventListener('click', () => { window.location.href = 'hub.html'; });
    }

    // Logout
    const logoutBtn = document.getElementById('vl-logout');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            try { await supabase.auth.signOut(); } catch (_) {}
            JwtManager.clear();
            window.location.href = 'login.html';
        });
    }

    const { data: workspaces, error } = await supabase.rpc('get_mis_proyectos');
    if (error) throw error;

    const lista = Array.isArray(workspaces) ? workspaces : [];
    const wsVl = lista.find(ws => ws.proyecto === 'ventas_live');

    // Sin workspace de Ventas Live → al hub a crearlo
    if (!wsVl) {
        window.location.href = 'hub.html';
        return;
    }

    // Atajo directo a Reservas de Pymes (si el usuario también tiene ese
    // workspace): si entró a Ventas Live por error o quiere cambiar al toque,
    // no necesita volver al hub. admin.html resuelve solo el tenant correcto.
    const wsRes = lista.find(ws => ws.proyecto === 'reservas');
    const goReservasBtn = document.getElementById('vl-go-reservas');
    if (wsRes && goReservasBtn) {
        goReservasBtn.style.display = '';
        goReservasBtn.addEventListener('click', () => {
            window.location.href = 'admin.html';
        });
    }

    const loadingEl = document.getElementById('vl-loading');
    if (loadingEl) loadingEl.style.display = 'none';
    const contentEl = document.getElementById('vl-content');
    if (contentEl) contentEl.style.display = 'block';

    const nombreEl = document.getElementById('vl-nombre');
    if (nombreEl) nombreEl.textContent = wsVl.nombre_negocio || 'Mi espacio';

    const planEl = document.getElementById('vl-plan');
    if (planEl) {
        const suspendido = wsVl.estado === 'inactivo';
        if (suspendido) {
            planEl.textContent = 'Suspendido por administración';
            planEl.style.background = 'rgba(230,60,60,0.14)';
            planEl.style.borderColor = 'rgba(230,60,60,0.45)';
            planEl.style.color = '#ff9f9f';
        } else {
            const label = PLAN_LABELS[wsVl.sub_plan] || wsVl.sub_plan || 'Gratis';
            planEl.innerHTML = `<i class="fas fa-check-circle"></i> Plan ${label}`;
        }
    }

    // Router de secciones
    wireNav();
    activarVista('live');
    pintarWhatsappYConfig();

    // Puente Procesos → ficha del cliente (pestaña Clientes)
    window.__vlIrAFicha = async (clienteId) => {
        document.querySelectorAll('.vl-tab').forEach(t => t.classList.toggle('active', t.dataset.view === 'clientes'));
        document.querySelectorAll('.vl-view').forEach(v => v.classList.remove('active'));
        const cont = document.getElementById('vl-view-clientes');
        if (!cont) return;
        cont.classList.add('active');
        try {
            const mod = await import('./ClientesView.js');
            mod.initClientes();
            mod.abrirFicha(clienteId);
        } catch (e) {
            console.error('[VentasLiveView] Error abriendo ficha:', e);
        }
    };
}

function wireNav() {
    const nav = document.getElementById('vl-nav');
    if (!nav) return;
    nav.querySelectorAll('.vl-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const destino = tab.dataset.view;
            nav.querySelectorAll('.vl-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            aplicarCapaDeSeccion(destino);
            activarVista(destino);
        });
    });
}

// ── Pestañas y botón "atrás" del celular ────────────────────────────────
// Estar en Procesos/Clientes/Envíos/Finanzas es una capa del historial:
// "atrás" devuelve a LIVE (no sale de Ventas Live). Si había una ficha de
// cliente abierta, se cierra junto con el cambio para no volver a una ficha
// vieja al regresar a la pestaña Clientes.
function aplicarCapaDeSeccion(destino) {
    const habiaFicha = hayCapa('cli-ficha');
    if (habiaFicha) {
        import('./ClientesView.js').then(m => {
            if (typeof m.cerrarFichaVisual === 'function') m.cerrarFichaVisual();
        }).catch(() => { /* la pestaña se encarga al inicializarse */ });
    }
    if (destino === 'live') {
        if (hayCapa('vl-seccion')) consumirCapa('vl-seccion');
        else if (habiaFicha) reemplazarCapa('cli-ficha', null, null);
        return;
    }
    if (habiaFicha) reemplazarCapa('cli-ficha', 'vl-seccion', irAVistaLive);
    else if (!hayCapa('vl-seccion')) abrirCapa('vl-seccion', irAVistaLive);
}

// Vuelta a LIVE pedida por el botón "atrás" (cierre natural de la capa).
function irAVistaLive() {
    const nav = document.getElementById('vl-nav');
    if (nav) nav.querySelectorAll('.vl-tab').forEach(t => t.classList.toggle('active', t.dataset.view === 'live'));
    activarVista('live');
}

// Nombre y WhatsApp del espacio (propios de Ventas Live)
function pintarWhatsapp(whatsapp) {
    const sub = document.getElementById('vl-ws-sub');
    const waEl = document.getElementById('vl-whatsapp');
    if (!sub || !waEl) return;
    if (whatsapp) {
        waEl.textContent = whatsapp;
        sub.classList.remove('sin-numero');
    } else {
        waEl.textContent = 'Sin número configurado';
        sub.classList.add('sin-numero');
    }
}

async function pintarWhatsappYConfig() {
    const btn = document.getElementById('vl-config-btn');
    const info = await vlApi.workspaceInfo();
    if (info.ok && info.data) {
        pintarWhatsapp(info.data.whatsapp);
        if (info.data.nombre_negocio) {
            const nombreEl = document.getElementById('vl-nombre');
            if (nombreEl) nombreEl.textContent = info.data.nombre_negocio;
        }
    } else {
        pintarWhatsapp('');
    }
    if (btn) {
        // Datos SIEMPRE frescos al abrir (evita revertir cambios con caché vieja)
        btn.addEventListener('click', async () => {
            const fresh = await vlApi.workspaceInfo();
            const nombreEl = document.getElementById('vl-nombre');
            abrirModalConfig({
                nombre: (fresh.ok && fresh.data && fresh.data.nombre_negocio) || (nombreEl ? nombreEl.textContent : '') || '',
                whatsapp: (fresh.ok && fresh.data && fresh.data.whatsapp) || '',
                horario: (fresh.ok && fresh.data && fresh.data.horario_entrega) || ''
            });
        });
    }

    // Botón WhatsApp (bot automático): estado + wizard de conexión
    const waBtn = document.getElementById('vl-wa-btn');
    const conn = await vlApi.waConexionInfo();
    if (conn.ok && conn.data) pintarEstadoWa(conn.data);
    if (waBtn) {
        waBtn.addEventListener('click', async () => {
            const fresh = await vlApi.waConexionInfo();
            abrirModalWhatsApp(fresh.ok && fresh.data ? fresh.data : {});
        });
    }

    // Botón "Respuestas del bot" (configurador no-code del guion)
    const respBtn = document.getElementById('vl-resp-btn');
    if (respBtn) respBtn.addEventListener('click', () => abrirModalRespuestas());
}

function pintarEstadoWa(conn) {
    const btn = document.getElementById('vl-wa-btn');
    if (!btn) return;
    const on = !!conn && conn.wa_estado === 'conectado';
    btn.style.color = on ? '#25d366' : '';
    btn.style.borderColor = on ? 'rgba(37, 211, 102, 0.6)' : '';
    btn.title = on ? 'Bot de WhatsApp conectado' : 'Conectar WhatsApp (bot automático)';
}

// Wizard "Conectar WhatsApp": pegar los 4 valores de Meta Cloud API.
// El token y el app secret solo se escriben (vacío = conserva el actual);
// la lectura enmascarada (vl_wa_conexion_info) NUNCA los devuelve.
function abrirModalWhatsApp(conn) {
    const conectado = conn.wa_estado === 'conectado';
    const pill = conectado
        ? '<span class="vl-badge confiable" id="vww-pill">🟢 Conectado</span>'
        : '<span class="vl-badge problematico" id="vww-pill">⚪ Desconectado</span>';

    abrirModal({
        titulo: '🤖 Conectar WhatsApp',
        sub: 'El bot responde solo a tus clientes (Cloud API de Meta). Los valores se guardan solo del lado del servidor y el token nunca se vuelve a mostrar.',
        html: `
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
                <span style="font-size:0.82rem;font-weight:700;color:#ced4da;">Estado:</span> ${pill}
            </div>

            <div class="vl-form-row">
                <label for="vww-phone">ID del número (phone_number_id)</label>
                <input class="vl-control" id="vww-phone" value="${escapeHtml(conn.wa_phone_id || '')}" placeholder="123456789012345" autocomplete="off">
                <div style="font-size:0.75rem;color:var(--muted,#adb5bd);margin-top:5px;">Lo copiaste en WhatsApp Manager → tu número → "ID del número".</div>
            </div>
            <div class="vl-form-row">
                <label for="vww-token">Token de acceso ${conn.tiene_token ? '<span style="color:#7ff5d8;font-weight:700;">✓ guardado</span>' : ''}</label>
                <input class="vl-control" id="vww-token" type="password" placeholder="EAA…" autocomplete="off">
                <div style="font-size:0.75rem;color:var(--muted,#adb5bd);margin-top:5px;">Vacío = conserva el actual. ¿Token vencido? Pega el nuevo aquí.</div>
            </div>
            <div class="vl-form-row">
                <label for="vww-verify">Verify token</label>
                <input class="vl-control" id="vww-verify" value="${escapeHtml(conn.wa_verify_token || '')}" placeholder="el texto secreto que inventaste" autocomplete="off">
                <div style="font-size:0.75rem;color:var(--muted,#adb5bd);margin-top:5px;">Es el mismo que pegarás en Meta al configurar el webhook.</div>
            </div>
            <div class="vl-form-row">
                <label for="vww-secret">App secret ${conn.tiene_app_secret ? '<span style="color:#7ff5d8;font-weight:700;">✓ guardado</span>' : ''}</label>
                <input class="vl-control" id="vww-secret" type="password" placeholder="secreto de la app de Meta" autocomplete="off">
                <div style="font-size:0.75rem;color:var(--muted,#adb5bd);margin-top:5px;">Vacío = conserva el actual.</div>
            </div>

            <div class="vl-form-row">
                <label>URL del webhook (pégala en Meta)</label>
                <div style="display:flex;gap:8px;">
                    <input class="vl-control" id="vww-url" readonly value="${escapeHtml(WA_WEBHOOK_URL)}" style="flex:1;font-size:0.78rem;">
                    <button class="vl-btn" id="vww-copiar" type="button" title="Copiar URL"><i class="fas fa-copy"></i></button>
                </div>
            </div>

            <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:10px 14px;font-size:0.78rem;color:var(--muted,#adb5bd);line-height:1.7;">
                <b style="color:#ced4da;">Para terminar en Meta (una vez):</b><br>
                1. developers.facebook.com → tu app → WhatsApp → Configuración → Webhook.<br>
                2. Pega la URL de arriba y el verify token → "Verificar y guardar".<br>
                3. Suscríbete al campo <b style="color:#ced4da;">messages</b>.<br>
                Listo: cada mensaje que reciba tu número entra solo al sistema.
            </div>

            <div class="vl-modal-actions">
                <button class="vl-btn" id="vww-cancelar" type="button">Cancelar</button>
                <button class="vl-btn primary" id="vww-ok" type="button"><i class="fas fa-save"></i> Guardar conexión</button>
            </div>`,
        ancho: '560px',
        onMount: (modal, { marcarSucio }) => {
            const phoneEl = modal.querySelector('#vww-phone');
            const tokenEl = modal.querySelector('#vww-token');
            const verifyEl = modal.querySelector('#vww-verify');
            const secretEl = modal.querySelector('#vww-secret');
            [phoneEl, tokenEl, verifyEl, secretEl].forEach(el => el.addEventListener('input', marcarSucio));
            modal.querySelector('#vww-cancelar').addEventListener('click', () => cerrarModal(true));
            modal.querySelector('#vww-copiar').addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(WA_WEBHOOK_URL);
                    mostrarToast('URL copiada ✔', 'success');
                } catch (_) {
                    mostrarToast('No se pudo copiar; selecciónala manualmente', 'warning');
                }
            });
            modal.querySelector('#vww-ok').addEventListener('click', guardar);
            phoneEl.focus();

            async function guardar() {
                const btn = modal.querySelector('#vww-ok');
                btn.disabled = true;
                const res = await vlApi.guardarConfigWa({
                    p_phone_id: phoneEl.value.trim(),
                    p_token: tokenEl.value.trim(),
                    p_verify_token: verifyEl.value.trim(),
                    p_app_secret: secretEl.value.trim()
                });
                btn.disabled = false;
                if (!res.ok) { mostrarToast(res.error || 'No se pudo guardar la conexión', 'error'); return; }
                cerrarModal(true);
                const conn2 = await vlApi.waConexionInfo();
                if (conn2.ok && conn2.data) pintarEstadoWa(conn2.data);
                mostrarToast('Conexión guardada ✔', 'success');
            }
        }
    });
}

// Configurador de respuestas del bot (sin programar).
// Muestra el guion base (para todos) + las personalizaciones del tenant.
// Editar / Quitar / inventar reglas. Dejar un mensaje EN BLANCO => el bot NO lo
// dice y deja un aviso al negocio para que responda una persona.
function abrirModalRespuestas() {
    abrirModal({
        titulo: '💬 Respuestas del bot',
        sub: 'Estos son los mensajes que manda el bot. Los de arriba vienen para todos; puedes editarlos o inventar los tuyos. Si dejas uno en blanco, el bot no lo dice y te deja un aviso para que respondas tú.',
        ancho: '680px',
        html: `
            <div id="vlresp-body" style="max-height:62vh;overflow:auto;padding-right:6px;">
                <div style="text-align:center;color:#adb5bd;padding:26px;"><i class="fas fa-circle-notch fa-spin"></i> Cargando…</div>
            </div>
            <div class="vl-modal-actions" style="justify-content:space-between;flex-wrap:wrap;gap:8px;">
                <button class="vl-btn danger" id="vlresp-reset" type="button"><i class="fas fa-rotate-left"></i> Restaurar todo a las bases</button>
                <button class="vl-btn" id="vlresp-cerrar" type="button">Cerrar</button>
            </div>`,
        onMount: (modal) => {
            const body = modal.querySelector('#vlresp-body');
            modal.querySelector('#vlresp-cerrar').addEventListener('click', () => cerrarModal(true));
            modal.querySelector('#vlresp-reset').addEventListener('click', async () => {
                if (!window.confirm('Esto borra TODAS tus personalizaciones y deja las respuestas base nuestras. ¿Continuar?')) return;
                if (!window.confirm('¿Seguro? Esta acción no se puede deshacer.')) return;
                const r = await vlApi.respuestasReset();
                if (!r.ok) { mostrarToast(r.error || 'No se pudo restaurar', 'error'); return; }
                mostrarToast('Respuestas restauradas a las bases ✔', 'success');
                cargar();
            });

            async function cargar() {
                const res = await vlApi.respuestasListar();
                if (!res.ok) {
                    body.innerHTML = `<div style="color:#ff9f9f;padding:14px;">${escapeHtml(res.error || 'No se pudo cargar')}</div>`;
                    return;
                }
                const d = res.data || {};
                const momentos = Array.isArray(d.momentos) ? d.momentos : [];
                const reglas = Array.isArray(d.reglas) ? d.reglas : [];
                const cuentas = Array.isArray(d.cuentas) ? d.cuentas : [];

                const byClave = {};
                momentos.forEach(m => { byClave[m.clave] = m; });

                const itemHtml = (m) => {
                    const chip = m.blanqueada
                        ? '<span class="vlresp-chip aviso">En blanco: el bot te avisará para que respondas tú</span>'
                        : (m.editada ? '<span class="vlresp-chip editada">Personalizada</span>'
                                     : '<span class="vlresp-chip base">Base</span>');
                    const fijo = (m.modo === 'fijo');
                    const cuerpo = fijo ? `
                            <div class="vlresp-hint">Elegís UNA opción y el bot manda esa:</div>
                            <div class="vlresp-opc" data-clave="${escapeHtml(m.clave)}"></div>
                            <div class="vlresp-opc-nueva" data-clave="${escapeHtml(m.clave)}">
                                <input class="vl-control vlresp-opc-et" placeholder="Etiqueta (ej: Opción 1)">
                                <textarea class="vl-control vlresp-opc-tx" rows="2" placeholder="Respuesta de esta opción"></textarea>
                                <button class="vl-btn primary vlresp-opc-add" type="button"><i class="fas fa-plus"></i> Agregar opción</button>
                            </div>`
                        : `<textarea class="vl-control vlresp-txt" rows="2">${escapeHtml(m.cuerpo || '')}</textarea>`;
                    return `
                        <div class="vlresp-item" data-clave="${escapeHtml(m.clave)}" data-modo="${fijo ? 'fijo' : 'aleatorio'}">
                            <div class="vlresp-desc">${escapeHtml(m.descripcion)}</div>
                            ${cuerpo}
                            <div class="vlresp-acciones">${chip}
                                <span style="flex:1"></span>
                                <button class="vlresp-modo" data-clave="${escapeHtml(m.clave)}" data-modo="${fijo ? 'fijo' : 'aleatorio'}" type="button" title="Cómo elige el bot entre los textos">${fijo ? '✅ Elegir una' : '🔀 Aleatorio'}</button>
                                ${fijo ? '' : '<button class="vl-btn primary vlresp-guardar" type="button"><i class="fas fa-save"></i> Guardar</button>'}
                                ${(m.editada && !fijo) ? '<button class="vl-btn vlresp-quitar" type="button"><i class="fas fa-rotate-left"></i> Quitar</button>' : ''}
                            </div>
                        </div>`;
                };

                const gruposHtml = GRUPOS.map(g => {
                    const claves = g.claves.filter(c => byClave[c]);
                    if (!claves.length) return '';
                    const items = claves.map(c => itemHtml(byClave[c])).join('');
                    const editadas = claves.filter(c => byClave[c].editada).length;
                    const badge = editadas
                        ? `<span class="vlresp-g-edit">${editadas} tuya${editadas > 1 ? 's' : ''}</span>` : '';
                    return `
                        <div class="vlresp-grupo" data-grupo="${g.id}" style="--gc:${g.color}">
                            <button class="vlresp-grupo-head" type="button">
                                <span class="vlresp-g-ico">${g.emoji}</span>
                                <span class="vlresp-g-nom">${escapeHtml(g.nombre)}</span>
                                ${badge}
                                <span class="vlresp-g-n">${claves.length}</span>
                                <i class="fas fa-chevron-down vlresp-g-chev"></i>
                            </button>
                            <div class="vlresp-grupo-body">${items}</div>
                        </div>`;
                }).join('');

                const reglasHtml = reglas.map(r => `
                    <div class="vlresp-regla" data-id="${escapeHtml(String(r.id))}">
                        <div class="vlresp-desc">Si el cliente dice: <b>${escapeHtml((r.gatillos || []).join(', '))}</b></div>
                        <div class="vlresp-regla-txt">${escapeHtml(r.cuerpo || '')}</div>
                        <button class="vl-btn vlresp-regla-del" type="button"><i class="fas fa-trash"></i> Eliminar</button>
                    </div>`).join('');

                body.innerHTML = `
                    <input class="vl-control vlresp-search" id="vlresp-buscar" placeholder="🔎 Busca por situación o texto (banco, envío, cuánto, comprobante…)">
                    <div id="vlresp-grupos">${gruposHtml || '<div style="color:#adb5bd;">Sin mensajes.</div>'}</div>
                    <div class="vlresp-nota-final">☂️ <b>Cuando el bot no sabe qué decir</b> nunca inventa: te deja un aviso en el chat para que respondas tú. Eso está siempre activo (y también si dejas un mensaje en blanco).</div>
                    <div class="vlresp-tit" style="margin-top:20px;">💳 Cuentas para transferir</div>
                    <div class="vlresp-hint">${cuentas.length ? 'Marcá <b>Usar esta</b> para elegir la cuenta que manda el bot.' : 'Hoy el bot usa la cuenta cargada en ⚙️ <b>Configurar espacio</b>. Si agregás cuentas acá, podés elegir cuál manda (marcá <b>Usar esta</b>).'}</div>
                    <div class="vlresp-opc" data-clave="datos_pago"></div>
                    <div class="vlresp-opc-nueva" data-clave="datos_pago">
                        <input class="vl-control vlresp-opc-et" placeholder="Etiqueta (ej: Banco A)">
                        <textarea class="vl-control vlresp-opc-tx" rows="2" placeholder="Datos de la cuenta (banco, titular, cuenta, rut…)"></textarea>
                        <button class="vl-btn primary vlresp-opc-add" type="button"><i class="fas fa-plus"></i> Agregar cuenta</button>
                    </div>
                    <div class="vlresp-tit" style="margin-top:18px;">🙋 Respuestas inventadas (si dice X → responde Y)</div>
                    <div class="vlresp-hint">Si el cliente escribe algo que incluye una de estas frases, el bot responde esto y no sigue el guion. Ideal para preguntas frecuentes o casos propios de tu negocio.</div>
                    <div id="vlresp-reglas">${reglasHtml || '<div style="color:#adb5bd;font-size:0.82rem;">Todavía no inventaste ninguna.</div>'}</div>
                    <div class="vlresp-nueva">
                        <input class="vl-control" id="vlresp-gat" placeholder="Si el cliente dice… (varias frases separadas por coma)">
                        <textarea class="vl-control" id="vlresp-cuerpo" rows="2" placeholder="…responder esto"></textarea>
                        <button class="vl-btn primary" id="vlresp-agregar" type="button"><i class="fas fa-plus"></i> Agregar respuesta</button>
                    </div>`;

                // Acordeón por situación (la primera abierta)
                body.querySelectorAll('.vlresp-grupo-head').forEach(h => {
                    h.addEventListener('click', () => h.parentElement.classList.toggle('abierto'));
                });
                const primero = body.querySelector('.vlresp-grupo');
                if (primero) primero.classList.add('abierto');
                // Buscador: filtra por situación/texto y abre las que matchean
                const buscar = body.querySelector('#vlresp-buscar');
                buscar.addEventListener('input', () => {
                    const q = buscar.value.trim().toLowerCase();
                    body.querySelectorAll('.vlresp-grupo').forEach(g => {
                        let vis = 0;
                        g.querySelectorAll('.vlresp-item').forEach(it => {
                            const show = !q || it.textContent.toLowerCase().includes(q);
                            it.style.display = show ? '' : 'none';
                            if (show) vis++;
                        });
                        g.style.display = (!q || vis) ? '' : 'none';
                        if (q) g.classList.add('abierto');
                    });
                    if (!q) {
                        body.querySelectorAll('.vlresp-grupo').forEach(g => g.classList.remove('abierto'));
                        const p = body.querySelector('.vlresp-grupo'); if (p) p.classList.add('abierto');
                    }
                });

                // ── Modo del momento: aleatorio ↔ elegir una ──
                body.querySelectorAll('.vlresp-modo').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        const nuevo = btn.dataset.modo === 'fijo' ? 'aleatorio' : 'fijo';
                        const r = await vlApi.respuestaModo(btn.dataset.clave, nuevo);
                        if (!r.ok) { mostrarToast(r.error || 'No se pudo cambiar', 'error'); return; }
                        cargar();
                    });
                });

                // ── Opciones (burbujas etiquetadas): momentos "elegir una" y cuentas ──
                async function llenarOpciones(cont) {
                    const clave = cont.dataset.clave;
                    const res = await vlApi.opcionesListar(clave);
                    const ops = (res.ok && res.data && Array.isArray(res.data.opciones)) ? res.data.opciones : [];
                    cont.innerHTML = ops.length ? ops.map(o => `
                        <div class="vlresp-opc-item ${o.activa ? 'activa' : ''}" data-id="${escapeHtml(String(o.id))}">
                            <div class="vlresp-opc-cab"><span class="vlresp-opc-etq">${escapeHtml(o.etiqueta || '(sin etiqueta)')}</span>${o.activa ? '<span class="vlresp-opc-uso">✓ la que manda el bot</span>' : ''}</div>
                            <div class="vlresp-opc-tx">${escapeHtml(o.texto)}</div>
                            <div class="vlresp-acciones">
                                ${o.activa ? '' : '<button class="vl-btn vlresp-opc-usar" type="button"><i class="fas fa-check"></i> Usar esta</button>'}
                                <button class="vl-btn danger vlresp-opc-del" type="button"><i class="fas fa-trash"></i> Eliminar</button>
                            </div>
                        </div>`).join('')
                        : '<div class="vlresp-hint">Todavía no hay opciones. Agregá la primera 👇</div>';
                    cont.querySelectorAll('.vlresp-opc-usar').forEach(bt => bt.addEventListener('click', async () => {
                        const r = await vlApi.opcionActivar(bt.closest('.vlresp-opc-item').dataset.id);
                        if (!r.ok) { mostrarToast(r.error || 'No se pudo', 'error'); return; }
                        mostrarToast('Listo: el bot usará esa ✔', 'success'); cargar();
                    }));
                    cont.querySelectorAll('.vlresp-opc-del').forEach(bt => bt.addEventListener('click', async () => {
                        if (!window.confirm('¿Eliminar esta opción?')) return;
                        const r = await vlApi.opcionEliminar(bt.closest('.vlresp-opc-item').dataset.id);
                        if (!r.ok) { mostrarToast(r.error || 'No se pudo', 'error'); return; }
                        cargar();
                    }));
                }
                body.querySelectorAll('.vlresp-opc').forEach(cont => llenarOpciones(cont));
                body.querySelectorAll('.vlresp-opc-nueva').forEach(nueva => {
                    const clave = nueva.dataset.clave;
                    nueva.querySelector('.vlresp-opc-add').addEventListener('click', async () => {
                        const et = nueva.querySelector('.vlresp-opc-et').value;
                        const tx = nueva.querySelector('.vlresp-opc-tx').value;
                        if (!tx.trim()) { mostrarToast('Escribe la respuesta de la opción', 'warning'); return; }
                        const r = await vlApi.opcionGuardar(clave, et, tx, false);
                        if (!r.ok) { mostrarToast(r.error || 'No se pudo agregar', 'error'); return; }
                        mostrarToast('Opción agregada ✔', 'success'); cargar();
                    });
                });

                body.querySelectorAll('.vlresp-item').forEach(item => {
                    const clave = item.dataset.clave;
                    const txt = item.querySelector('.vlresp-txt');
                    const g = item.querySelector('.vlresp-guardar');
                    if (g && txt) g.addEventListener('click', async () => {
                        const r = await vlApi.respuestaGuardar(clave, txt.value, true);
                        if (!r.ok) { mostrarToast(r.error || 'No se pudo guardar', 'error'); return; }
                        mostrarToast('Guardado ✔', 'success');
                        cargar();
                    });
                    const q = item.querySelector('.vlresp-quitar');
                    if (q) q.addEventListener('click', async () => {
                        if (!window.confirm('¿Volver este mensaje a la base nuestra?')) return;
                        const r = await vlApi.respuestaRestaurar(clave);
                        if (!r.ok) { mostrarToast(r.error || 'No se pudo restaurar', 'error'); return; }
                        mostrarToast('Restaurado ✔', 'success');
                        cargar();
                    });
                });

                body.querySelectorAll('.vlresp-regla .vlresp-regla-del').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        const id = btn.closest('.vlresp-regla').dataset.id;
                        if (!window.confirm('¿Eliminar esta respuesta inventada?')) return;
                        const r = await vlApi.respuestaReglaEliminar(id);
                        if (!r.ok) { mostrarToast(r.error || 'No se pudo eliminar', 'error'); return; }
                        mostrarToast('Eliminada ✔', 'success');
                        cargar();
                    });
                });

                body.querySelector('#vlresp-agregar').addEventListener('click', async () => {
                    const gatillos = body.querySelector('#vlresp-gat').value.split(',').map(s => s.trim()).filter(Boolean);
                    const cuerpo = body.querySelector('#vlresp-cuerpo').value;
                    if (!gatillos.length) { mostrarToast('Escribe al menos una frase gatillo', 'warning'); return; }
                    if (!cuerpo.trim()) { mostrarToast('Escribe la respuesta', 'warning'); return; }
                    const r = await vlApi.respuestaCrear(gatillos, cuerpo);
                    if (!r.ok) { mostrarToast(r.error || 'No se pudo agregar', 'error'); return; }
                    mostrarToast('Respuesta agregada ✔', 'success');
                    cargar();
                });
            }
            cargar();
        }
    });
}

function abrirModalConfig(ws) {
    abrirModal({
        titulo: '⚙️ Configurar este espacio',
        sub: 'Ventas Live tiene su propio nombre, su propio WhatsApp y su horario de entrega, independientes del proyecto Reservas.',
        html: `
            <div class="vl-form-row">
                <label for="vw-nombre">Nombre del espacio</label>
                <input class="vl-control" id="vw-nombre" value="${escapeHtml(ws.nombre || '')}" maxlength="60">
            </div>
            <div class="vl-form-row">
                <label for="vw-whatsapp">WhatsApp a cargo</label>
                <input class="vl-control" id="vw-whatsapp" value="${escapeHtml(ws.whatsapp || '')}" placeholder="+56 9 …">
                <div style="font-size:0.75rem;color:var(--muted,#adb5bd);margin-top:5px;">
                    El número que recibirá los mensajes de tus clientes. Vacío = conserva el actual.
                </div>
            </div>
            <div class="vl-form-row">
                <label for="vw-horario">Horario de entrega presencial</label>
                <input class="vl-control" id="vw-horario" maxlength="300"
                       value="${escapeHtml(ws.horario || '')}"
                       placeholder="te puedo coordinar la entrega de lunes a sábado…">
                <div style="font-size:0.75rem;color:var(--muted,#adb5bd);margin-top:5px;">
                    El bot lo dice cuando el cliente elige <b>entrega presencial</b>. Vacío = usa el texto por defecto (lunes a sábado, avisando si no puedes).
                </div>
            </div>
            <div class="vl-modal-actions">
                <button class="vl-btn" id="vw-cancelar" type="button">Cancelar</button>
                <button class="vl-btn primary" id="vw-ok" type="button"><i class="fas fa-save"></i> Guardar</button>
            </div>`,
        onMount: (modal, { marcarSucio }) => {
            const nombreEl = modal.querySelector('#vw-nombre');
            const waEl = modal.querySelector('#vw-whatsapp');
            const horEl = modal.querySelector('#vw-horario');
            [nombreEl, waEl, horEl].forEach(el => el.addEventListener('input', marcarSucio));
            modal.querySelector('#vw-cancelar').addEventListener('click', () => cerrarModal(true));
            modal.querySelector('#vw-ok').addEventListener('click', guardar);
            nombreEl.focus();
            async function guardar() {
                const nombre = nombreEl.value.trim();
                const whatsapp = waEl.value.trim();
                const horario = horEl.value.trim();
                if (nombre.length < 2) { mostrarToast('El nombre debe tener al menos 2 caracteres', 'warning'); return; }
                const digits = whatsapp.replace(/\D/g, '');
                if (whatsapp && digits.length < 8) { mostrarToast('WhatsApp inválido (mínimo 8 dígitos)', 'warning'); return; }
                const btn = modal.querySelector('#vw-ok');
                btn.disabled = true;
                const res = await vlApi.actualizarWorkspace(nombre, whatsapp, horario);
                btn.disabled = false;
                if (!res.ok) { mostrarToast(res.error || 'No se pudo guardar', 'error'); return; }
                cerrarModal(true);
                const nombreElH = document.getElementById('vl-nombre');
                if (nombreElH && res.data && res.data.nombre_negocio) nombreElH.textContent = res.data.nombre_negocio;
                pintarWhatsapp(res.data && res.data.whatsapp ? res.data.whatsapp : whatsapp);
                mostrarToast('Espacio actualizado ✔', 'success');
            }
        }
    });
}

async function activarVista(nombre) {
    document.querySelectorAll('.vl-view').forEach(v => v.classList.remove('active'));
    const cont = document.getElementById('vl-view-' + nombre);
    if (!cont) return;
    cont.classList.add('active');

    if (nombre === 'live') {
        try {
            const mod = await import('./LiveView.js');
            (cont.dataset.cargada ? mod.activarLiveView : mod.initLiveView)();
            cont.dataset.cargada = '1';
        } catch (e) {
            console.error('[VentasLiveView] Error cargando LiveView:', e);
            cont.innerHTML = '<div class="vl-empty">No se pudo cargar el MODO LIVE.</div>';
        }
        return;
    }

    if (nombre === 'procesos') {
        try {
            const mod = await import('./ProcesosView.js');
            mod.initProcesos();
        } catch (e) {
            console.error('[VentasLiveView] Error cargando ProcesosView:', e);
            cont.innerHTML = '<div class="vl-empty">No se pudo cargar Procesos.</div>';
        }
        return;
    }

    if (nombre === 'clientes') {
        try {
            const mod = await import('./ClientesView.js');
            mod.initClientes();
        } catch (e) {
            console.error('[VentasLiveView] Error cargando ClientesView:', e);
            cont.innerHTML = '<div class="vl-empty">No se pudo cargar Clientes.</div>';
        }
        return;
    }

    if (nombre === 'envios') {
        try {
            const mod = await import('./EnviosView.js');
            mod.initEnvios();
        } catch (e) {
            console.error('[VentasLiveView] Error cargando EnviosView:', e);
            cont.innerHTML = '<div class="vl-empty">No se pudo cargar Envíos.</div>';
        }
        return;
    }

    if (nombre === 'finanzas') {
        try {
            const mod = await import('./FinanzasView.js');
            mod.initFinanzas();
        } catch (e) {
            console.error('[VentasLiveView] Error cargando FinanzasView:', e);
            cont.innerHTML = '<div class="vl-empty">No se pudo cargar Finanzas.</div>';
        }
        return;
    }

    const pend = PENDIENTES[nombre];
    if (pend) {
        cont.innerHTML = `
            <div class="vl-card" style="text-align:center;padding:44px 24px;">
                <div style="font-size:2rem;color:#c77dff;margin-bottom:14px;"><i class="fas ${pend.icono}"></i></div>
                <h2 style="margin:0 0 8px;color:#f8f9fa;font-size:1.15rem;">${pend.titulo}</h2>
                <p style="color:var(--muted,#adb5bd);max-width:480px;margin:0 auto;line-height:1.6;font-size:0.9rem;">${pend.texto}</p>
                <span class="vl-badge nuevo" style="margin-top:16px;">Próximamente</span>
            </div>`;
    }
}
