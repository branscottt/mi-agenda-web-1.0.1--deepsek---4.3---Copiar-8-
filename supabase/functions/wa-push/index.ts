// wa-push/index.ts
// Envía una NOTIFICACIÓN PUSH (Web Push) a los dispositivos suscritos de un
// tenant de Ventas Live. Web Push es gratuito: no hay costo por mensaje.
//
// Dos formas de llamarla (ambas se validan ACÁ adentro):
//   1) servidor (wa-webhook) con la service_role  -> avisos reales
//   2) panel, con el JWT de un ADMIN del espacio   -> botón "Probar aviso"
// Body: { tenant_id?: uuid, titulo?, cuerpo?, url?, tag?, chatId? }
// Resp: { ok: true, origen, suscripciones, enviados, borrados, errores }
//
// Deja una fila en vl_push_log con el resultado REAL de la entrega (hasta ahora
// un fallo de envío no dejaba rastro: "no me llegó el aviso" era invisible).
// Si las claves VAPID no están configuradas, responde ok:false sin romper nada.
// Las suscripciones muertas (404/410) se borran solas.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { applySecurityHeaders } from '../_shared/security-headers.ts';
import webpush from 'npm:web-push@3.6.7';

const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY') || '';
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') || '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:no-reply@organifypyme.com';

function json(payload: unknown, status: number, corsOrigin = '*'): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
  });
}

/**
 * Origen permitido para el navegador (el panel llama a esta función para el
 * aviso de prueba). Mismo criterio que wa-enviar: allowlist en ALLOWED_ORIGINS.
 */
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

async function borrarSub(supabaseUrl: string, sr: string, endpoint: string): Promise<void> {
  const q = `endpoint=eq.${encodeURIComponent(endpoint)}`;
  for (const tabla of ['vl_push_subs', 'avisos_subs']) {
    try {
      await fetch(`${supabaseUrl}/rest/v1/${tabla}?${q}`, {
        method: 'DELETE',
        headers: { 'apikey': sr, 'Authorization': `Bearer ${sr}` },
      });
    } catch (_) { /* da igual */ }
  }
}

/** Nombre del negocio (para distinguir CUENTAS distintas en el mismo equipo). */
async function negocioDe(supabaseUrl: string, sr: string, tenantId: string): Promise<string> {
  try {
    const r = await fetch(
      `${supabaseUrl}/rest/v1/tenants?id=eq.${encodeURIComponent(tenantId)}&select=nombre_negocio`,
      { headers: { 'apikey': sr, 'Authorization': `Bearer ${sr}` } },
    );
    if (!r.ok) return '';
    const j = await r.json().catch(() => []);
    return (Array.isArray(j) && j[0]) ? String((j[0] as { nombre_negocio?: string }).nombre_negocio || '').trim() : '';
  } catch (_) {
    return '';
  }
}

/**
 * Dispositivos del DUEÑO (los dos proyectos). El dueño tiene un espacio de
 * reservas y uno de Ventas Live con el MISMO correo: si activó los avisos en
 * cualquiera de los dos, los recibe en ambos. Se unen vl_push_subs (Ventas
 * Live) y avisos_subs (avisos generales/reservas) sin duplicar endpoint.
 */
async function dispositivosDe(
  supabaseUrl: string,
  sr: string,
  tenantId: string,
): Promise<Array<{ endpoint: string; p256dh: string; auth: string }>> {
  const out = new Map<string, { endpoint: string; p256dh: string; auth: string }>();
  const h = { 'apikey': sr, 'Authorization': `Bearer ${sr}` };
  let ids: string[] = [tenantId];
  try {
    const t = await fetch(
      `${supabaseUrl}/rest/v1/tenants?id=eq.${encodeURIComponent(tenantId)}&select=email_contacto`,
      { headers: h },
    ).then((r) => r.ok ? r.json() : []).catch(() => []);
    const email = String((Array.isArray(t) && t[0] && t[0].email_contacto) || '').trim();
    if (email && email.includes('@')) {
      const fam = await fetch(
        `${supabaseUrl}/rest/v1/tenants?email_contacto=eq.${encodeURIComponent(email)}&select=id`,
        { headers: h },
      ).then((r) => r.ok ? r.json() : []).catch(() => []);
      const otros = (Array.isArray(fam) ? fam : []).map((x) => String((x as { id?: string }).id || '')).filter(Boolean);
      if (otros.length) ids = [...new Set([tenantId, ...otros])];
    }
  } catch (_) { /* sigue con el tenant solo */ }

  const filtro = `tenant_id=in.(${ids.map((i) => encodeURIComponent(i)).join(',')})` +
    `&select=endpoint,p256dh,auth`;
  for (const tabla of ['vl_push_subs', 'avisos_subs']) {
    try {
      const r = await fetch(`${supabaseUrl}/rest/v1/${tabla}?${filtro}`, { headers: h });
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

/** Una fila por llamada: qué pasó de verdad con la entrega. */
async function registrar(
  supabaseUrl: string,
  sr: string,
  fila: { tenant_id: string; origen: string; suscripciones: number; enviados: number; borrados: number; errores: number; detalle: string },
): Promise<void> {
  try {
    await fetch(`${supabaseUrl}/rest/v1/vl_push_log`, {
      method: 'POST',
      headers: {
        'apikey': sr,
        'Authorization': `Bearer ${sr}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(fila),
    });
  } catch (_) { /* el log nunca rompe el envío */ }
}

/**
 * Espacio de Ventas Live del usuario que manda el JWT (con su propio token, así
 * RLS/auth.uid() responden por él). Sirve para el aviso de prueba del panel.
 */
async function contextoDeUsuario(
  supabaseUrl: string,
  sr: string,
  userToken: string,
): Promise<{ tenant_id: string; es_admin: boolean } | null> {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/vl_push_contexto`, {
      method: 'POST',
      headers: {
        'apikey': sr,
        'Authorization': `Bearer ${userToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null) as { ok?: boolean; tenant_id?: string; es_admin?: boolean } | null;
    if (!j || j.ok !== true || !j.tenant_id) return null;
    return { tenant_id: String(j.tenant_id), es_admin: !!j.es_admin };
  } catch (_) {
    return null;
  }
}

async function handle(req: Request): Promise<Response> {
  // CORS: el panel manda el "aviso de prueba" desde el navegador (con su JWT).
  const corsOrigin = corsDe(req);
  const jsonR = (payload: unknown, status: number) => json(payload, status, corsOrigin);

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
      },
    });
  }
  if (req.method !== 'POST') return jsonR({ ok: false, error: 'Método no permitido' }, 405);

  const sr = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const supabaseUrl = (Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '');
  if (!sr) return jsonR({ ok: false, error: 'sin service_role' }, 500);

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const esServidor = !!(token && (token === sr || rolDeJwt(token) === 'service_role'));

  // tenant + origen según quién llama
  let tenantId = '';
  let origen = 'webhook';
  if (esServidor) {
    tenantId = String(body.tenant_id || '');
    if (!tenantId) return jsonR({ ok: false, error: 'tenant_id requerido' }, 400);
  } else {
    const ctx = token ? await contextoDeUsuario(supabaseUrl, sr, token) : null;
    // Solo un admin de un espacio puede mandarse un aviso de prueba a sí mismo.
    if (!ctx || !ctx.es_admin) return jsonR({ ok: false, error: 'No autorizado' }, 401);
    tenantId = ctx.tenant_id;
    origen = 'prueba';
  }

  const titulo = String(body.titulo || (origen === 'prueba' ? 'Aviso de prueba 🔔' : 'Ventas Live'));
  const cuerpo = String(body.cuerpo || (origen === 'prueba'
    ? 'Si ves esto, las notificaciones funcionan (aunque tengas la web cerrada).'
    : 'Tienes algo que revisar.'));
  const url = String(body.url || '/ventas-live.html');
  // tag: agrupa/reemplaza avisos del mismo tipo en la conversación (evita que el
  // mensaje del cliente desaparezca debajo de la respuesta del bot).
  const tag = String(body.tag || (origen === 'prueba' ? 'vl-prueba' : 'vl-aviso'));
  // chatId: al tocar la notificación, el panel abre ESA conversación.
  const chatMatch = String(url).match(/chat=([0-9a-fA-F-]{36})/);
  const chatId = String(body.chatId || (chatMatch ? chatMatch[1] : ''));

  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    await registrar(supabaseUrl, sr, {
      tenant_id: tenantId, origen, suscripciones: 0, enviados: 0, borrados: 0, errores: 1,
      detalle: 'faltan claves VAPID en los secrets',
    });
    return jsonR({ ok: false, error: 'Web Push sin configurar (faltan claves VAPID)' }, 500);
  }

  const subs = await dispositivosDe(supabaseUrl, sr, tenantId);
  if (subs.length === 0) {
    await registrar(supabaseUrl, sr, {
      tenant_id: tenantId, origen, suscripciones: 0, enviados: 0, borrados: 0, errores: 0,
      detalle: 'sin dispositivos suscritos',
    });
    return jsonR({ ok: true, origen, suscripciones: 0, enviados: 0, borrados: 0, errores: 0 }, 200);
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  // Etiqueta del PROYECTO y de la CUENTA en el título: el dueño puede tener
  // varios negocios en el mismo teléfono y tiene que saber de dónde viene.
  const negocio = origen === 'prueba' ? '' : await negocioDe(supabaseUrl, sr, tenantId);
  const tituloFinal = origen === 'prueba'
    ? titulo
    : (negocio ? `💬 ${negocio} · ${titulo}` : (/Ventas Live/.test(titulo) ? titulo : `💬 Ventas Live · ${titulo}`));
  const payload = JSON.stringify({ title: tituloFinal, body: cuerpo, url, tag, chatId });

  let enviados = 0;
  let borrados = 0;
  const fallos: string[] = [];
  for (const s of subs) {
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
        await borrarSub(supabaseUrl, sr, s.endpoint);   // suscripción muerta
        borrados++;
      } else {
        const msg = (e as Error).message || String(e);
        fallos.push(`${code} ${host}: ${msg.slice(0, 120)}`);
        console.error(`[wa-push] envío falló (${code}):`, msg);
      }
    }
  }

  await registrar(supabaseUrl, sr, {
    tenant_id: tenantId, origen, suscripciones: subs.length, enviados, borrados,
    errores: fallos.length, detalle: fallos.join(' | ').slice(0, 800),
  });

  return jsonR({
    ok: true, origen, suscripciones: subs.length, enviados, borrados, errores: fallos.length,
    detalle: fallos.join(' | ').slice(0, 300),
  }, 200);
}

serve(async (req) => applySecurityHeaders(await handle(req)));
