// avisos-push/index.ts
// AVISOS GENERALES de la web (reservas y todo el panel) → Web Push al PC, móvil
// y tablet, con la web abierta o CERRADA. Web Push es gratis (no hay costo por
// mensaje). Si el dispositivo NO tiene los avisos activados, cae al CORREO de la
// cuenta para que el dueño se entere igual.
//
// Tres formas de llamarla (todas se validan ACÁ adentro):
//   1) base de datos (trigger `trg_notif_avisar_push` vía pg_net)
//      → header `x-avisos-token` = secreto compartido (Vault ↔ secrets)
//   2) servidor con la service_role            → avisos reales de otros flujos
//   3) panel, con el JWT de un admin del espacio → botón "Probar aviso"
//
// Body: { accion?: 'enviar'|'prueba', tenant_id?, titulo?, cuerpo?, url?, tag?,
//         tipo?, notificacion_id?, email_fallback? }
// Resp: { ok, origen, suscripciones, enviados, borrados, errores, email, email_estado }
//
// Deja una fila en avisos_log con el resultado REAL (así "no me llegó" se puede
// diagnosticar). Si faltan las claves VAPID responde ok:false sin romper nada;
// las suscripciones muertas (404/410) se borran solas.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { applySecurityHeaders } from '../_shared/security-headers.ts';
import webpush from 'npm:web-push@3.6.7';

const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY') || '';
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') || '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:no-reply@organifypyme.com';

// Secreto compartido con la base (mismo valor en Vault y en los secrets).
const TOKEN_SISTEMA = Deno.env.get('AVISOS_TOKEN') || '';
// Correo de respaldo (Resend). Sin clave simplemente no se envía correo.
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') || '';
const EMAIL_FROM = Deno.env.get('AVISOS_EMAIL_FROM') || 'Agenda Pro <avisos@organifypyme.com>';
// Un correo cada X minutos por espacio (evita ráfagas). Las reservas nuevas
// siempre avisan por correo (es el aviso que más importa).
const EMAIL_MINUTOS_ESPERA = 5;

function json(payload: unknown, status: number, corsOrigin = '*'): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
  });
}

/** Origen permitido para el navegador (allowlist en ALLOWED_ORIGINS). */
function corsDe(req: Request): string {
  const requestOrigin = req.headers.get('origin') || '';
  const lista = (Deno.env.get('ALLOWED_ORIGINS') || '')
    .split(',').map((o) => o.trim()).filter(Boolean);
  if (lista.length === 0) return requestOrigin || '*';
  return lista.includes(requestOrigin) ? requestOrigin : lista[0];
}

/** Rol del JWT (la firma ya la valida la plataforma / es la service_role). */
function rolDeJwt(token: string): string | null {
  try {
    const p = token.split('.');
    if (p.length !== 3) return null;
    const b64 = p[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
    const txt = new TextDecoder().decode(Uint8Array.from(atob(pad), (c) => c.charCodeAt(0)));
    return (JSON.parse(txt).role as string) || null;
  } catch (_) {
    return null;
  }
}

function sbHeaders(sr: string, extra: Record<string, string> = {}): Record<string, string> {
  return { 'apikey': sr, 'Authorization': `Bearer ${sr}`, ...extra };
}

async function borrarSub(supabaseUrl: string, sr: string, endpoint: string): Promise<void> {
  const q = `endpoint=eq.${encodeURIComponent(endpoint)}`;
  for (const tabla of ['avisos_subs', 'vl_push_subs']) {
    try {
      await fetch(`${supabaseUrl}/rest/v1/${tabla}?${q}`, { method: 'DELETE', headers: sbHeaders(sr) });
    } catch (_) { /* da igual */ }
  }
}

/** Nombre del negocio del espacio (para que el aviso diga de QUÉ cuenta es). */
async function negocioDe(supabaseUrl: string, sr: string, tenantId: string): Promise<string> {
  try {
    const r = await fetch(
      `${supabaseUrl}/rest/v1/tenants?id=eq.${encodeURIComponent(tenantId)}&select=nombre_negocio`,
      { headers: sbHeaders(sr) },
    );
    if (!r.ok) return '';
    const j = await r.json().catch(() => []);
    const n = (Array.isArray(j) && j[0]) ? String((j[0] as { nombre_negocio?: string }).nombre_negocio || '') : '';
    return n.trim();
  } catch (_) {
    return '';
  }
}

/**
 * TODOS los dispositivos del DUEÑO, no solo los del espacio que avisa.
 * Un mismo correo de cuenta tiene un espacio por proyecto (reservas y Ventas
 * Live): si el dueño activó los avisos en UNO, tiene que recibirlos en LOS DOS.
 * Se unen las suscripciones de avisos_subs (avisos generales/reservas) y de
 * vl_push_subs (activadas desde el panel de Ventas Live), sin duplicar endpoint.
 */
async function dispositivosDe(
  supabaseUrl: string,
  sr: string,
  tenantId: string,
): Promise<Array<{ endpoint: string; p256dh: string; auth: string }>> {
  const out = new Map<string, { endpoint: string; p256dh: string; auth: string }>();
  let ids: string[] = [tenantId];
  try {
    const t = await fetch(
      `${supabaseUrl}/rest/v1/tenants?id=eq.${encodeURIComponent(tenantId)}&select=email_contacto`,
      { headers: sbHeaders(sr) },
    ).then((r) => r.ok ? r.json() : []).catch(() => []);
    const email = String((Array.isArray(t) && t[0] && t[0].email_contacto) || '').trim();
    if (email && email.includes('@')) {
      const fam = await fetch(
        `${supabaseUrl}/rest/v1/tenants?email_contacto=eq.${encodeURIComponent(email)}&select=id`,
        { headers: sbHeaders(sr) },
      ).then((r) => r.ok ? r.json() : []).catch(() => []);
      const otros = (Array.isArray(fam) ? fam : []).map((x) => String((x as { id?: string }).id || '')).filter(Boolean);
      if (otros.length) ids = [...new Set([tenantId, ...otros])];
    }
  } catch (_) { /* sigue con el tenant solo */ }

  const filtro = `tenant_id=in.(${ids.map((i) => encodeURIComponent(i)).join(',')})` +
    `&select=endpoint,p256dh,auth`;
  for (const tabla of ['avisos_subs', 'vl_push_subs']) {
    try {
      const r = await fetch(`${supabaseUrl}/rest/v1/${tabla}?${filtro}`, { headers: sbHeaders(sr) });
      if (!r.ok) continue;
      const rows = await r.json().catch(() => []);
      for (const s of (Array.isArray(rows) ? rows : [])) {
        const row = s as { endpoint?: string; p256dh?: string; auth?: string };
        if (row.endpoint && row.p256dh && row.auth && !out.has(row.endpoint)) {
          out.set(row.endpoint, { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth });
        }
      }
    } catch (_) { /* sigue con la otra tabla */ }
  }
  return [...out.values()];
}

/** Una fila por envío: qué pasó de verdad. */
async function registrar(
  supabaseUrl: string,
  sr: string,
  fila: Record<string, unknown>,
): Promise<void> {
  try {
    await fetch(`${supabaseUrl}/rest/v1/avisos_log`, {
      method: 'POST',
      headers: sbHeaders(sr, { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
      body: JSON.stringify(fila),
    });
  } catch (_) { /* el log nunca rompe el envío */ }
}

/** Espacio del usuario que manda el JWT (con su propio token, RLS responde por él). */
async function contextoDeUsuario(
  supabaseUrl: string,
  sr: string,
  userToken: string,
): Promise<{ tenant_id: string; email: string } | null> {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/avisos_estado`, {
      method: 'POST',
      headers: { 'apikey': sr, 'Authorization': `Bearer ${userToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null) as { ok?: boolean; email?: string } | null;
    if (!j || j.ok !== true) return null;
    const tenant = await tenantDeUsuario(supabaseUrl, sr, userToken);
    if (!tenant) return null;
    return { tenant_id: tenant, email: String(j.email || '') };
  } catch (_) {
    return null;
  }
}

/** tenant_id del usuario vía RPC SECURITY DEFINER (usa su propio JWT). */
async function tenantDeUsuario(supabaseUrl: string, sr: string, userToken: string): Promise<string> {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/get_user_tenant_id`, {
      method: 'POST',
      headers: { 'apikey': sr, 'Authorization': `Bearer ${userToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!r.ok) return '';
    const t = await r.json().catch(() => null);
    return t ? String(t) : '';
  } catch (_) {
    return '';
  }
}

/** Correo de la cuenta (+ admins del espacio si los hay). */
async function destinatarios(supabaseUrl: string, sr: string, tenantId: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const t = await fetch(
      `${supabaseUrl}/rest/v1/tenants?id=eq.${encodeURIComponent(tenantId)}&select=email_contacto,nombre_negocio`,
      { headers: sbHeaders(sr) },
    ).then((r) => r.ok ? r.json() : []).catch(() => []);
    for (const row of (Array.isArray(t) ? t : [])) {
      const e = String((row as { email_contacto?: string }).email_contacto || '').trim();
      if (e && e.includes('@')) out.push(e);
    }
  } catch (_) { /* sigue */ }
  if (out.length === 0) {
    try {
      const u = await fetch(
        `${supabaseUrl}/rest/v1/usuarios_con_rol?tenant_id=eq.${encodeURIComponent(tenantId)}&rol=eq.admin&select=email&limit=3`,
        { headers: sbHeaders(sr) },
      ).then((r) => r.ok ? r.json() : []).catch(() => []);
      for (const row of (Array.isArray(u) ? u : [])) {
        const e = String((row as { email?: string }).email || '').trim();
        if (e && e.includes('@')) out.push(e);
      }
    } catch (_) { /* sigue */ }
  }
  return [...new Set(out)].slice(0, 3);
}

async function hacePocoQueAvisamos(
  supabaseUrl: string,
  sr: string,
  tenantId: string,
): Promise<boolean> {
  try {
    const desde = new Date(Date.now() - EMAIL_MINUTOS_ESPERA * 60_000).toISOString();
    const r = await fetch(
      `${supabaseUrl}/rest/v1/avisos_log?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&email_estado=eq.enviado&creado_en=gte.${encodeURIComponent(desde)}&select=id&limit=1`,
      { headers: sbHeaders(sr) },
    );
    if (!r.ok) return false;
    const j = await r.json().catch(() => []);
    return Array.isArray(j) && j.length > 0;
  } catch (_) {
    return false;
  }
}

/** Envía el aviso por correo (Resend). Devuelve el estado para la bitácora. */
async function enviarCorreo(
  destinatariosLista: string[],
  asunto: string,
  cuerpo: string,
  url: string,
): Promise<{ estado: string; detalle: string }> {
  if (!RESEND_KEY) return { estado: 'sin_proveedor', detalle: 'falta RESEND_API_KEY' };
  if (destinatariosLista.length === 0) return { estado: 'sin_email', detalle: 'el espacio no tiene correo de contacto' };

  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;padding:24px;font-family:Inter,Arial,sans-serif">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
      <table role="presentation" width="100%" style="max-width:520px;background:#fff;border-radius:14px;padding:26px 24px">
        <tr><td style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#7c3aed;font-weight:700">Agenda Pro</td></tr>
        <tr><td style="font-size:20px;font-weight:700;color:#111827;padding-top:10px">${escapeHtml(asunto)}</td></tr>
        <tr><td style="font-size:15px;color:#374151;padding-top:8px;line-height:1.5">${escapeHtml(cuerpo)}</td></tr>
        <tr><td style="padding-top:20px">
          <a href="${url}" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px">Abrir mi panel</a>
        </td></tr>
        <tr><td style="padding-top:22px;font-size:12px;color:#9ca3af;line-height:1.5">
          Recibes este correo porque es el correo de tu cuenta en Agenda Pro y este dispositivo no tiene los avisos activados.
        </td></tr>
      </table>
    </td></tr></table>
  </body></html>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: destinatariosLista,
        subject: `Agenda Pro · ${asunto}`,
        html,
        text: `${asunto}\n\n${cuerpo}\n\nAbrir mi panel: ${url}`,
      }),
    });
    if (r.ok) return { estado: 'enviado', detalle: destinatariosLista.join(', ') };
    const txt = await r.text().catch(() => '');
    return { estado: 'error', detalle: `HTTP ${r.status}: ${txt.slice(0, 200)}` };
  } catch (e) {
    return { estado: 'error', detalle: (e as Error).message.slice(0, 200) };
  }
}

function escapeHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function handle(req: Request): Promise<Response> {
  const corsOrigin = corsDe(req);
  const jsonR = (payload: unknown, status: number) => json(payload, status, corsOrigin);

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-avisos-token',
      },
    });
  }
  if (req.method !== 'POST') return jsonR({ ok: false, error: 'Método no permitido' }, 405);

  const sr = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const supabaseUrl = (Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '');
  if (!sr) return jsonR({ ok: false, error: 'sin service_role' }, 500);

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const tokenSistema = (req.headers.get('x-avisos-token') || '').trim();

  const esServidor = !!(token && (token === sr || rolDeJwt(token) === 'service_role'));
  const esSistema = !!(TOKEN_SISTEMA && tokenSistema && tokenSistema === TOKEN_SISTEMA);

  // tenant + origen según quién llama
  let tenantId = '';
  let origen = 'notificacion';
  let base = supabaseUrl;
  if (esSistema) {
    tenantId = String(body.tenant_id || '');
    origen = String(body.origen || 'notificacion');
    if (!tenantId) return jsonR({ ok: false, error: 'tenant_id requerido' }, 400);
  } else if (esServidor) {
    tenantId = String(body.tenant_id || '');
    origen = String(body.origen || 'servidor');
    if (!tenantId) return jsonR({ ok: false, error: 'tenant_id requerido' }, 400);
  } else {
    const ctx = token ? await contextoDeUsuario(supabaseUrl, sr, token) : null;
    if (!ctx || !ctx.tenant_id) return jsonR({ ok: false, error: 'No autorizado' }, 401);
    tenantId = ctx.tenant_id;
    origen = 'prueba';
  }

  const esPrueba = origen === 'prueba';
  const titulo = String(body.titulo || (esPrueba ? 'Aviso de prueba 🔔' : 'Aviso de tu agenda'));
  const cuerpo = String(body.cuerpo || (esPrueba
    ? 'Si ves esto, los avisos funcionan (aunque tengas la web cerrada).'
    : 'Tienes algo que revisar.'));
  const urlRel = String(body.url || '/admin.html');
  const url = urlRel.startsWith('http') ? urlRel : `https://agenda-pro-red.vercel.app${urlRel}`;
  const notificacionId = String(body.notificacion_id || '');
  const tipo = String(body.tipo || (esPrueba ? 'prueba' : 'aviso'));
  // Cada aviso real es su propia notificación (un tag único por aviso): si se
  // agruparan por tipo, la 2ª reserva REEMPLAZARÍA el aviso de la 1ª y el dueño
  // no se enteraría de la anterior. La prueba sí se agrupa.
  const tag = String(body.tag || (esPrueba
    ? 'avisos-prueba'
    : (notificacionId ? `avisos-${notificacionId}` : `avisos-${tipo}`)));
  const quiereEmail = body.email_fallback === undefined ? true : !!body.email_fallback;

  // ── Etiqueta de PROYECTO y de CUENTA en el título ────────────────────────
  // El dueño puede tener VARIAS cuentas en el mismo equipo (p.ej. dos negocios
  // de reservas): el título dice el proyecto y el NOMBRE DEL NEGOCIO, y el
  // cuerpo arranca con el tipo de aviso ("Nueva reserva: ...").
  const proyecto = String(body.proyecto || 'reservas');
  const etiquetaProyecto = proyecto === 'ventas_live' ? '💬 Ventas Live' : '📅 Reservas';
  const negocio = esPrueba ? '' : await negocioDe(base, sr, tenantId);
  const tituloFinal = esPrueba
    ? titulo
    : (negocio ? `${etiquetaProyecto} · ${negocio}` : `${etiquetaProyecto} · ${titulo}`);
  const cuerpoFinal = (!esPrueba && negocio && !cuerpo.startsWith(titulo)) ? `${titulo} · ${cuerpo}` : cuerpo;

  // ── Dispositivos del dueño (LOS DOS proyectos) ───────────────────────────
  const listaSubs = await dispositivosDe(base, sr, tenantId);

  let enviados = 0;
  let borrados = 0;
  const fallos: string[] = [];

  if (listaSubs.length > 0) {
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
      fallos.push('faltan claves VAPID en los secrets');
    } else {
      webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
      const payload = JSON.stringify({ title: tituloFinal, body: cuerpoFinal, url: urlRel, tag, tipo });
      for (const s of listaSubs) {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
          );
          enviados++;
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode || 0;
          const host = (String(s.endpoint).split('/')[2] || 'push');
          if (code === 404 || code === 410) {
            await borrarSub(base, sr, s.endpoint);   // suscripción muerta
            borrados++;
          } else {
            const msg = (e as Error).message || String(e);
            fallos.push(`${code} ${host}: ${msg.slice(0, 120)}`);
            console.error('[avisos-push] envío falló:', code, msg);
          }
        }
      }
    }
  }

  // ── Respaldo por CORREO: nadie tenía los avisos activados (o fallaron) ────
  let emailDestino = '';
  let emailEstado = 'no_aplica';
  if (quiereEmail && enviados === 0 && !esPrueba) {
    const yaAvisado = tipo !== 'nueva_reserva' && await hacePocoQueAvisamos(base, sr, tenantId);
    if (yaAvisado) {
      emailEstado = 'omitido_reciente';
    } else {
      const to = await destinatarios(base, sr, tenantId);
      emailDestino = to.join(', ');
      const r = await enviarCorreo(to, tituloFinal, cuerpoFinal, url);
      emailEstado = r.estado;
      if (r.estado === 'error') fallos.push(`correo: ${r.detalle}`);
    }
  }

  // ── Marcar el aviso como empujado (idempotencia del trigger) ─────────────
  if (notificacionId && (enviados > 0 || emailEstado === 'enviado' || emailEstado === 'omitido_reciente')) {
    try {
      await fetch(
        `${base}/rest/v1/notificaciones_admin?id=eq.${encodeURIComponent(notificacionId)}`,
        {
          method: 'PATCH',
          headers: sbHeaders(sr, { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
          body: JSON.stringify({ push_enviado_en: new Date().toISOString() }),
        },
      );
    } catch (_) { /* noop */ }
  }

  await registrar(base, sr, {
    tenant_id: tenantId, origen, tipo, notificacion_id: notificacionId || null, titulo: tituloFinal,
    suscripciones: listaSubs.length, enviados, borrados, errores: fallos.length,
    email: emailDestino || null, email_estado: emailEstado,
    detalle: fallos.join(' | ').slice(0, 800),
  });

  return jsonR({
    ok: true, origen, suscripciones: listaSubs.length, enviados, borrados,
    errores: fallos.length, email: emailDestino, email_estado: emailEstado,
    detalle: fallos.join(' | ').slice(0, 300),
  }, 200);
}

serve(async (req) => applySecurityHeaders(await handle(req)));
