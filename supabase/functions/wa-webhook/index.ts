// wa-webhook/index.ts
// Webhook de WhatsApp Business Platform (Cloud API de Meta) para Ventas Live.
// Meta envía aquí los mensajes que recibe el número de WhatsApp del negocio.
//
// Flujo:
//   1. GET  = verificación del webhook por Meta (hub.mode / hub.verify_token / hub.challenge)
//   2. POST = mensaje entrante de un cliente
//   3. Buscar el tenant por el phone_number_id que RECIBIÓ el mensaje
//      (vl_config.wa_phone_id) — el mismo webhook sirve a N tenants.
//   4. Validar X-Hub-Signature-256 (HMAC SHA-256 con el app secret de la app
//      de Meta guardado en vl_config.wa_app_secret).
//   5. Llamar al cerebro vl_wa_conversacion_avanzar (máquina de estados pura,
//      spec §8): él registra el mensaje in, avanza el chat y devuelve la
//      respuesta a enviar (y el log 'out' ya queda guardado).
//   6. Si el cerebro dice enviar → POST a Graph API /<phone_id>/messages con
//      el token del tenant.
//
// Seguridad:
//   - verify_jwt = false (lo llama Meta, no un usuario de la app).
//   - wa_token y wa_app_secret viven SOLO en vl_config (server-side); esta
//     función los lee con service_role y nunca los devuelve.
//   - 200 rápido ante eventos sin acción (statuses, echo); 500 solo en
//     errores reales para que Meta reintente.
//   - Firma inválida o tenant desconocido → 200 silencioso (no alimenta
//     reintentos de Meta contra eventos basura).
//
// Debug: Meta envía el campo "statuses" (delivered/read) y, si la app está
// mal configurada, eco de mensajes propios. Ambos se ignoran.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { applySecurityHeaders } from '../_shared/security-headers.ts';

const GRAPH_API = 'https://graph.facebook.com/v21.0';

// ── Tipos mínimos del payload de Meta ────────────────────────────────────
interface WaConfigRow {
  tenant_id: string;
  wa_token: string;
  wa_app_secret: string;
}

interface WaMessage {
  from: string;
  id: string;
  type: string;
  text?: { body?: string };
}

interface WaChangeValue {
  metadata?: { phone_number_id?: string };
  messages?: WaMessage[];
  statuses?: unknown[];
}

interface WaWebhookPayload {
  object?: string;
  entry?: Array<{ id?: string; changes?: Array<{ value?: WaChangeValue }> }>;
}

/** Compara dos strings en tiempo constante (evita timing attacks). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Calcula el HMAC SHA-256 hex de un body con un app secret. */
async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Lee la config de conexión de un tenant por su phone_number_id (service_role). */
async function buscarConfigPorPhone(
  supabaseUrl: string,
  serviceRoleKey: string,
  phoneNumberId: string,
): Promise<WaConfigRow | null> {
  const resp = await fetch(
    `${supabaseUrl}/rest/v1/vl_config?select=tenant_id,wa_token,wa_app_secret&wa_phone_id=eq.${encodeURIComponent(phoneNumberId)}&wa_estado=eq.conectado&limit=1`,
    {
      headers: {
        'apikey': serviceRoleKey,
        'Authorization': `Bearer ${serviceRoleKey}`,
      },
    },
  );
  if (!resp.ok) {
    console.error(`[WA-Webhook] Error leyendo vl_config (${resp.status}):`, (await resp.text().catch(() => '')).slice(0, 200));
    return null;
  }
  const rows = await resp.json();
  const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  if (!row) return null;
  return { tenant_id: row.tenant_id, wa_token: row.wa_token || '', wa_app_secret: row.wa_app_secret || '' };
}

/** Llama al cerebro del bot y devuelve su respuesta JSON. */
async function avanzarConversacion(
  supabaseUrl: string,
  serviceRoleKey: string,
  tenantId: string,
  waId: string,
  texto: string,
  tipo: string,
): Promise<Record<string, unknown> | null> {
  const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/vl_wa_conversacion_avanzar`, {
    method: 'POST',
    headers: {
      'apikey': serviceRoleKey,
      'Authorization': `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_tenant_id: tenantId,
      p_wa_id: waId,
      p_texto: texto,
      p_tipo: tipo,
    }),
  });
  if (!resp.ok) {
    console.error(`[WA-Webhook] Error llamando al cerebro (${resp.status}):`, (await resp.text().catch(() => '')).slice(0, 300));
    return null;
  }
  const data = await resp.json();
  return Array.isArray(data) ? (data[0] as Record<string, unknown>) : (data as Record<string, unknown>);
}

/** Envía un mensaje de texto por Graph API. */
async function enviarMensaje(
  phoneId: string,
  token: string,
  to: string,
  body: string,
): Promise<boolean> {
  const resp = await fetch(`${GRAPH_API}/${phoneId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body, preview_url: false },
    }),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    console.error(`[WA-Webhook] Error enviando mensaje a ${to} (${resp.status}):`, err.slice(0, 300));
    return false;
  }
  return true;
}

/** Traduce el type de mensaje de Meta al tipo del dominio (cerebro). */
function mapearTipo(type: string): string {
  switch (type) {
    case 'text': return 'texto';
    case 'image': return 'imagen';
    case 'audio': return 'audio';
    case 'video': return 'video';
    case 'document': return 'documento';
    default: return 'texto';
  }
}

/** GET: handshake de verificación que Meta ejecuta al guardar el webhook. */
async function handleVerify(
  url: URL,
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<Response> {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token') || '';
  const challenge = url.searchParams.get('hub.challenge') || '';

  if (mode !== 'subscribe' || !challenge) {
    return new Response('Bad request', { status: 400 });
  }

  // El verify_token es por tenant: buscamos cuál lo declaró.
  const resp = await fetch(
    `${supabaseUrl}/rest/v1/vl_config?select=tenant_id&wa_verify_token=eq.${encodeURIComponent(token)}&limit=1`,
    {
      headers: {
        'apikey': serviceRoleKey,
        'Authorization': `Bearer ${serviceRoleKey}`,
      },
    },
  );
  if (!resp.ok) {
    console.error(`[WA-Webhook] Error verificando token (${resp.status})`);
    return new Response('Error interno', { status: 500 });
  }
  const rows = await resp.json();
  const found = Array.isArray(rows) && rows.length > 0;
  if (!found) {
    console.warn('[WA-Webhook] verify_token inválido en handshake');
    return new Response('Forbidden', { status: 403 });
  }
  return new Response(challenge, { status: 200 });
}

async function handle(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('[WA-Webhook] SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no configurados');
    return new Response(JSON.stringify({ error: 'Configuración incompleta del servidor' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(req.url);

  // Preflight CORS (Meta no lo usa; se responde por completitud)
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  // Handshake de Meta (al guardar el webhook en la app)
  if (req.method === 'GET') {
    return await handleVerify(url, supabaseUrl, serviceRoleKey);
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const rawBody = await req.text();
    const payload = JSON.parse(rawBody) as WaWebhookPayload;

    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value || !value.messages || value.messages.length === 0) continue; // statuses/eco: ignorar

        const phoneNumberId = value.metadata?.phone_number_id || '';
        if (!phoneNumberId) {
          console.warn('[WA-Webhook] payload sin phone_number_id — ignorando');
          continue;
        }

        // Config del tenant que RECIBIÓ el mensaje
        const cfg = await buscarConfigPorPhone(supabaseUrl, serviceRoleKey, phoneNumberId);
        if (!cfg) {
          console.warn(`[WA-Webhook] Sin tenant conectado para phone_number_id ${phoneNumberId} — ignorando`);
          continue;
        }

        // Validar firma HMAC (X-Hub-Signature-256) contra el app secret
        const signatureHeader = req.headers.get('x-hub-signature-256') || '';
        if (cfg.wa_app_secret) {
          const expected = 'sha256=' + await hmacSha256Hex(cfg.wa_app_secret, rawBody);
          if (!timingSafeEqual(signatureHeader, expected)) {
            console.warn(`[WA-Webhook] Firma HMAC inválida para tenant ${cfg.tenant_id} — mensaje descartado`);
            continue;
          }
        } else {
          console.warn(`[WA-Webhook] Tenant ${cfg.tenant_id} sin wa_app_secret — saltando validación de firma`);
        }

        for (const message of value.messages) {
          const waId = message.from || '';
          const texto = message.text?.body || '';
          const tipo = mapearTipo(message.type || '');

          if (!waId) continue;

          const brain = await avanzarConversacion(
            supabaseUrl, serviceRoleKey, cfg.tenant_id, waId, texto, tipo,
          );
          if (!brain || brain.ok === false) {
            console.error(`[WA-Webhook] Cerebro falló para wa_id ${waId}:`, JSON.stringify(brain || { ok: false }).slice(0, 200));
            return new Response(JSON.stringify({ error: 'Error procesando mensaje' }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          if (brain.enviar === true && typeof brain.mensaje === 'string' && brain.mensaje !== '') {
            const ok = await enviarMensaje(phoneNumberId, cfg.wa_token, waId, brain.mensaje);
            if (!ok) {
              // Meta reintentará el webhook; el cerebro ya registró el 'out',
              // así que el reintento puede duplicar la respuesta. Aceptado en
              // v1 (baja probabilidad); el log queda consistente.
              return new Response(JSON.stringify({ error: 'Error enviando a Graph API' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
              });
            }
          }
        }
      }
    }

    // Responder 200 rápido: Meta no debe esperar trabajo pesado aquí
    return new Response('OK', { status: 200 });
  } catch (e: unknown) {
    const error = e as Error;
    console.error('[WA-Webhook] Error inesperado:', error.message || String(e));
    // 500 para que Meta reintente (backoff exponencial)
    return new Response(JSON.stringify({ error: 'Error interno del servidor' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// Cabeceras de seguridad OWASP en TODAS las respuestas (éxito, error, preflight)
serve(async (req) => applySecurityHeaders(await handle(req)));
