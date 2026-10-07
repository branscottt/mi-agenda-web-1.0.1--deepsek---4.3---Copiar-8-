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

interface WaMediaRef {
  id?: string;
  caption?: string;
  filename?: string;
  mime_type?: string;
}

interface WaMessage {
  from: string;
  id: string;
  type: string;
  text?: { body?: string };
  image?: WaMediaRef;
  audio?: WaMediaRef;
  video?: WaMediaRef;
  document?: WaMediaRef;
  sticker?: WaMediaRef;
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
  mediaPath: string | null = null,
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
      p_media_path: mediaPath,
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
    case 'sticker': return 'sticker';
    default: return 'texto';
  }
}

/** Texto del mensaje: el body de texto o la LEYENDA de la foto/archivo. */
function textoDe(message: WaMessage): string {
  return message.text?.body
    || message.image?.caption
    || message.video?.caption
    || message.document?.caption
    || '';
}

/** Extensión de archivo a partir del mime que reporta Meta. */
function extensionDe(mime: string, tipo: string): string {
  const m = (mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('mp4')) return tipo === 'audio' ? 'm4a' : 'mp4';
  if (m.includes('amr')) return 'amr';
  if (m.includes('3gpp')) return '3gp';
  if (m.includes('pdf')) return 'pdf';
  return tipo === 'imagen' ? 'jpg' : 'bin';
}

interface ResultadoMedia {
  ruta: string | null;
  transcripcion: string | null;
}

/**
 * Transcribe un audio a texto. Se usa Groq (whisper-large-v3, gratis y rápido)
 * si hay GROQ_API_KEY; si no, OpenAI (whisper-1) con OPENAI_API_KEY. Sin clave
 * devuelve null: el audio se guarda y se reproduce igual, solo sin texto.
 * El prompt sesga el vocabulario al negocio (jerga chilena, envíos, prendas).
 */
async function transcribirAudio(bytes: Uint8Array, mime: string): Promise<string | null> {
  const groq = Deno.env.get('GROQ_API_KEY') || '';
  const openai = Deno.env.get('OPENAI_API_KEY') || '';
  let url = '', key = '', modelo = '';
  if (groq) { url = 'https://api.groq.com/openai/v1/audio/transcriptions'; key = groq; modelo = 'whisper-large-v3'; }
  else if (openai) { url = 'https://api.openai.com/v1/audio/transcriptions'; key = openai; modelo = 'whisper-1'; }
  else {
    console.warn('[WA-Webhook] Audio sin transcribir: falta GROQ_API_KEY u OPENAI_API_KEY');
    return null;
  }

  try {
    const form = new FormData();
    form.append('file', new Blob([bytes as unknown as BlobPart], { type: mime || 'audio/ogg' }), 'audio.ogg');
    form.append('model', modelo);
    form.append('language', 'es');
    form.append('response_format', 'json');
    form.append('prompt', 'Venta por TikTok Live en Chile. Prendas de ropa, poleras, faldas, blusas. '
      + 'Transferencia, comprobante, datos bancarios. Envío por Paket o Blue Express, entrega presencial. '
      + 'Usuario del live, precio en pesos chilenos.');

    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) {
      console.error(`[WA-Webhook] Transcripción falló (${r.status}):`, (await r.text().catch(() => '')).slice(0, 200));
      return null;
    }
    const data = await r.json() as { text?: string };
    const txt = (data.text || '').trim();
    return txt || null;
  } catch (e) {
    console.error('[WA-Webhook] Error transcribiendo el audio:', (e as Error).message || String(e));
    return null;
  }
}

/**
 * Baja el archivo que mandó el cliente por WhatsApp, lo guarda en el bucket
 * privado 'vl-media' y —si es un AUDIO— lo transcribe a texto (así el bot lo
 * "lee" y el panel muestra qué dijo).
 * Devuelve las dos cosas; null en lo que haya fallado (el chat sigue igual).
 */
async function procesarMedia(
  supabaseUrl: string,
  serviceRoleKey: string,
  tenantId: string,
  waId: string,
  message: WaMessage,
  token: string,
): Promise<ResultadoMedia> {
  const vacio: ResultadoMedia = { ruta: null, transcripcion: null };
  const medio = message.image || message.audio || message.video || message.document || message.sticker;
  const mediaId = medio?.id;
  if (!mediaId) return vacio;

  try {
    // 1) Meta entrega una URL temporal (expira en ~5 min) para ese id.
    const info = await fetch(`${GRAPH_API}/${mediaId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!info.ok) {
      console.error(`[WA-Webhook] No pude resolver el medio ${mediaId} (${info.status})`);
      return vacio;
    }
    const meta = await info.json() as { url?: string; mime_type?: string };
    if (!meta.url) return vacio;

    // 2) Descarga del binario.
    const bin = await fetch(meta.url, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!bin.ok) {
      console.error(`[WA-Webhook] No pude bajar el medio ${mediaId} (${bin.status})`);
      return vacio;
    }
    const bytes = new Uint8Array(await bin.arrayBuffer());
    if (!bytes.length) return vacio;

    const tipo = mapearTipo(message.type || '');
    const mime = meta.mime_type || medio?.mime_type || 'application/octet-stream';

    // 3) Subida a Storage con service_role. Ruta: tenant / número / uuid.ext
    const soloDigitos = (waId || '').replace(/\D/g, '');
    const ruta = `${tenantId}/${soloDigitos}/${crypto.randomUUID()}.${extensionDe(mime, tipo)}`;

    const up = await fetch(`${supabaseUrl}/storage/v1/object/vl-media/${ruta}`, {
      method: 'POST',
      headers: {
        'apikey': serviceRoleKey,
        'Authorization': `Bearer ${serviceRoleKey}`,
        'Content-Type': mime,
        'x-upsert': 'false',
      },
      body: bytes,
      signal: AbortSignal.timeout(20000),
    });
    if (!up.ok) {
      console.error(`[WA-Webhook] No pude subir el medio (${up.status}):`, (await up.text().catch(() => '')).slice(0, 200));
      return vacio;
    }

    // 4) Audio → texto (para que el bot lo entienda y el panel lo muestre).
    let transcripcion: string | null = null;
    if (tipo === 'audio') {
      transcripcion = await transcribirAudio(bytes, mime);
    }

    return { ruta, transcripcion };
  } catch (e) {
    console.error('[WA-Webhook] Error guardando el medio:', (e as Error).message || String(e));
    return vacio;
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
          const texto = textoDe(message);
          const tipo = mapearTipo(message.type || '');

          if (!waId) continue;

          // El trabajo (bajar el archivo de Meta, subirlo a Storage, transcribir
          // el audio y llamar al cerebro) se hace en SEGUNDO PLANO: Meta espera
          // un 200 rápido y, si no llega, REINTENTA el webhook y el cliente
          // recibiría la respuesta duplicada. Con foto+audio ya no alcanza a
          // responder a tiempo, así que se responde 200 primero (waitUntil).
          const trabajo = async () => {
            try {
              // Foto/audio/video/archivo: se guarda en Storage para que se
              // VEA/ESCUCHE en el panel. Si es AUDIO, además se transcribe: el
              // texto hace de mensaje, así el bot lo entiende igual que escrito.
              let mediaPath: string | null = null;
              let textoFinal = texto;
              if (tipo !== 'texto') {
                const media = await procesarMedia(
                  supabaseUrl, serviceRoleKey, cfg.tenant_id, waId, message, cfg.wa_token,
                );
                mediaPath = media.ruta;
                if (tipo === 'audio' && !textoFinal && media.transcripcion) {
                  textoFinal = media.transcripcion;
                }
              }

              const brain = await avanzarConversacion(
                supabaseUrl, serviceRoleKey, cfg.tenant_id, waId, textoFinal, tipo, mediaPath,
              );
              if (!brain || brain.ok === false) {
                console.error(`[WA-Webhook] Cerebro falló para wa_id ${waId}:`, JSON.stringify(brain || { ok: false }).slice(0, 200));
                return;
              }

              if (brain.enviar === true && typeof brain.mensaje === 'string' && brain.mensaje !== '') {
                const ok = await enviarMensaje(phoneNumberId, cfg.wa_token, waId, brain.mensaje);
                if (!ok) console.error(`[WA-Webhook] No pude enviar la respuesta a ${waId}`);
              }
            } catch (e) {
              console.error('[WA-Webhook] Error procesando el mensaje:', (e as Error).message || String(e));
            }
          };

          const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
          if (rt && typeof rt.waitUntil === 'function') {
            rt.waitUntil(trabajo());
          } else {
            await trabajo();   // sin EdgeRuntime (local): se hace en línea
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
