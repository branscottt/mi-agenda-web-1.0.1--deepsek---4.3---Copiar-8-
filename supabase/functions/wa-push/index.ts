// wa-push/index.ts
// Envía una NOTIFICACIÓN PUSH (Web Push) a los dispositivos suscritos de un
// tenant de Ventas Live. Web Push es gratuito: no hay costo por mensaje.
//
// Se llama SOLO desde el servidor (el webhook del bot), con la service_role en
// el header Authorization. NO está expuesta al navegador.
//
// Body: { tenant_id: uuid, titulo?: string, cuerpo?: string, url?: string }
// Resp: { ok: true, suscripciones, enviados, borrados }
//
// Si las claves VAPID no están configuradas, responde ok:false sin romper nada.
// Las suscripciones muertas (404/410) se borran solas.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { applySecurityHeaders } from '../_shared/security-headers.ts';
import webpush from 'npm:web-push@3.6.7';

const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY') || '';
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') || '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:no-reply@organifypyme.com';

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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
  try {
    await fetch(`${supabaseUrl}/rest/v1/vl_push_subs?endpoint=eq.${encodeURIComponent(endpoint)}`, {
      method: 'DELETE',
      headers: { 'apikey': sr, 'Authorization': `Bearer ${sr}` },
    });
  } catch (_) { /* da igual */ }
}

async function handle(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ ok: false, error: 'Método no permitido' }, 405);

  const sr = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const supabaseUrl = (Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '');
  if (!sr) return json({ ok: false, error: 'sin service_role' }, 500);

  // Solo el propio backend puede llamar: service_role (por coincidencia exacta
  // o por el rol del JWT, sirve para formatos legacy y nuevos).
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!(token && (token === sr || rolDeJwt(token) === 'service_role'))) {
    return json({ ok: false, error: 'No autorizado' }, 401);
  }

  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return json({ ok: false, error: 'Web Push sin configurar (faltan claves VAPID)' }, 500);
  }

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const tenantId = String(body.tenant_id || '');
  const titulo = String(body.titulo || 'Ventas Live');
  const cuerpo = String(body.cuerpo || 'Tienes algo que revisar.');
  const url = String(body.url || '/ventas-live.html');
  if (!tenantId) return json({ ok: false, error: 'tenant_id requerido' }, 400);

  const resp = await fetch(
    `${supabaseUrl}/rest/v1/vl_push_subs?tenant_id=eq.${encodeURIComponent(tenantId)}&select=endpoint,p256dh,auth`,
    { headers: { 'apikey': sr, 'Authorization': `Bearer ${sr}` } },
  );
  if (!resp.ok) return json({ ok: false, error: 'no pude leer las suscripciones' }, 500);
  const subs = await resp.json() as Array<{ endpoint: string; p256dh: string; auth: string }>;
  if (!Array.isArray(subs) || subs.length === 0) {
    return json({ ok: true, suscripciones: 0, enviados: 0, borrados: 0 }, 200);
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  const payload = JSON.stringify({ title: titulo, body: cuerpo, url });

  let enviados = 0;
  let borrados = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
      );
      enviados++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode || 0;
      if (code === 404 || code === 410) {
        await borrarSub(supabaseUrl, sr, s.endpoint);   // suscripción muerta
        borrados++;
      } else {
        console.error(`[wa-push] envío falló (${code}):`, (e as Error).message || String(e));
      }
    }
  }

  return json({ ok: true, suscripciones: subs.length, enviados, borrados }, 200);
}

serve(async (req) => applySecurityHeaders(await handle(req)));
