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
  /**
   * "Responder a…": el mensaje CITADO. Meta manda acá el wamid de ese mensaje
   * (no su texto). Sin esto no se puede saber a QUÉ se refería el cliente
   * cuando escribe "quiero este" sobre una foto.
   */
  context?: { id?: string; from?: string };
  // Tipos que el cerebro NO procesa: se guardan para que se VEAN en el panel.
  reaction?: { emoji?: string; message_id?: string };
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  button?: { text?: string };
  interactive?: {
    type?: string;
    button_reply?: { title?: string };
    list_reply?: { title?: string };
  };
  system?: { body?: string };
  contacts?: Array<{ name?: { formatted_name?: string } }>;
}

interface WaStatusError {
  code?: number;
  title?: string;
  message?: string;
  error_data?: { details?: string };
}

/** Aviso de entrega de un mensaje NUESTRO (sent / delivered / read / failed). */
interface WaStatus {
  id?: string;
  status?: string;
  timestamp?: string;
  recipient_id?: string;
  errors?: WaStatusError[];
}

interface WaChangeValue {
  metadata?: { phone_number_id?: string };
  messages?: WaMessage[];
  statuses?: WaStatus[];
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

/**
 * Notificación PUSH al dueño (Web Push, gratis). Llega aunque tenga la web
 * CERRADA. Es "mejor esfuerzo": si falla, el bot sigue funcionando igual.
 * La manda la Edge Function wa-push (aislada, con las claves VAPID).
 */
async function avisarPush(
  supabaseUrl: string,
  serviceRoleKey: string,
  tenantId: string,
  titulo: string,
  cuerpo: string,
): Promise<void> {
  try {
    await fetch(`${supabaseUrl}/functions/v1/wa-push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({ tenant_id: tenantId, titulo, cuerpo }),
    });
  } catch (e) {
    console.error('[WA-Webhook] push falló:', (e as Error).message || String(e));
  }
}

/**
 * Red de seguridad: deja un aviso "te escribieron y el bot no respondió" cuando
 * el cerebro no respondió y no dejó aviso propio. Los acuses y los avisos
 * repetidos los filtra la propia RPC (vl_wa_avisar_sin_respuesta).
 */
async function rpcAvisoSinRespuesta(
  supabaseUrl: string,
  serviceRoleKey: string,
  tenantId: string,
  waId: string,
  texto: string,
): Promise<void> {
  try {
    await fetch(`${supabaseUrl}/rest/v1/rpc/vl_wa_avisar_sin_respuesta`, {
      method: 'POST',
      headers: {
        'apikey': serviceRoleKey,
        'Authorization': `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_tenant_id: tenantId, p_wa_id: waId, p_texto: texto }),
    });
  } catch (e) {
    console.error('[WA-Webhook] No pude crear el aviso "sin respuesta":', (e as Error).message || String(e));
  }
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

/** Envía un mensaje de texto por Graph API. Devuelve el wamid que asigna Meta. */
async function enviarMensaje(
  phoneId: string,
  token: string,
  to: string,
  body: string,
): Promise<{ ok: boolean; wamid: string }> {
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
    return { ok: false, wamid: '' };
  }
  const data = await resp.json().catch(() => ({})) as { messages?: Array<{ id?: string }> };
  return { ok: true, wamid: data?.messages?.[0]?.id || '' };
}

/**
 * Pega el wamid — y la CITA (a qué mensaje responde) — al mensaje que YA quedó
 * registrado en vl_wa_mensajes. Es "mejor esfuerzo": si falla, el chat sigue
 * funcionando igual, solo ese mensaje no se podrá resolver como cita.
 */
async function guardarMetaWa(
  supabaseUrl: string,
  serviceRoleKey: string,
  p: {
    tenantId: string;
    direction: 'in' | 'out';
    wamid?: string;
    contextId?: string;
    chatId?: string;
    waId?: string;
    tipo?: string;
    texto?: string;
    mediaPath?: string;
  },
): Promise<void> {
  if (!p.wamid && !p.contextId) return;
  try {
    const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/vl_wa_guardar_meta_wa`, {
      method: 'POST',
      headers: {
        'apikey': serviceRoleKey,
        'Authorization': `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_tenant_id: p.tenantId,
        p_direction: p.direction,
        p_wa_message_id: p.wamid || null,
        p_chat_id: p.chatId || null,
        p_wa_id: p.waId || null,
        p_context_wa_id: p.contextId || null,
        p_tipo: p.tipo || null,
        p_texto: p.texto || null,
        p_media_path: p.mediaPath || null,
      }),
    });
    if (!resp.ok) {
      console.warn(`[WA-Webhook] No pude guardar el wamid (${resp.status})`);
      return;
    }
    const data = await resp.json().catch(() => null);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || row.ok !== true) {
      console.warn('[WA-Webhook] wamid sin fila destino:', JSON.stringify(row || {}).slice(0, 160));
    }
  } catch (e) {
    console.warn('[WA-Webhook] Error guardando el wamid:', (e as Error).message || String(e));
  }
}

/**
 * Guarda el estado de entrega de un mensaje nuestro (✓ enviado, ✓✓ entregado,
 * ✓✓ azul leído, o falló + motivo). Se cruza por wamid. Mejor esfuerzo.
 */
async function actualizarEstado(
  supabaseUrl: string,
  serviceRoleKey: string,
  tenantId: string,
  wamid: string,
  estado: string,
  error: string,
): Promise<void> {
  try {
    const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/vl_wa_actualizar_estado`, {
      method: 'POST',
      headers: {
        'apikey': serviceRoleKey,
        'Authorization': `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_tenant_id: tenantId,
        p_wa_message_id: wamid,
        p_estado: estado,
        p_error: error || null,
      }),
    });
    if (!resp.ok) {
      console.warn(`[WA-Webhook] No pude guardar el estado '${estado}' (${resp.status})`);
    }
  } catch (e) {
    console.warn('[WA-Webhook] Error guardando el estado:', (e as Error).message || String(e));
  }
}

/** Traduce el status de Meta al estado que guarda el panel. */
function mapearEstado(status: string): string {
  switch (status) {
    case 'sent': return 'enviado';
    case 'delivered': return 'entregado';
    case 'read':
    case 'played': return 'leido';     // 'played' = audio escuchado
    case 'failed': return 'fallido';
    default: return '';
  }
}

/**
 * Guarda un mensaje que el cerebro NO entiende (reacción, ubicación, contacto,
 * respuesta de botón…) para que se vea en el panel, sin correr el bot.
 */
async function registrarEntranteCrudo(
  supabaseUrl: string,
  serviceRoleKey: string,
  tenantId: string,
  waId: string,
  tipo: string,
  texto: string,
  messageId: string,
  contextId: string,
): Promise<void> {
  try {
    const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/vl_wa_registrar_entrante_crudo`, {
      method: 'POST',
      headers: {
        'apikey': serviceRoleKey,
        'Authorization': `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_tenant_id: tenantId,
        p_wa_id: waId,
        p_tipo: tipo,
        p_texto: texto || null,
        p_wa_message_id: messageId || null,
        p_context_wa_id: contextId || null,
      }),
    });
    if (!resp.ok) {
      console.warn(`[WA-Webhook] No pude guardar el mensaje '${tipo}' (${resp.status})`);
    }
  } catch (e) {
    console.warn('[WA-Webhook] Error guardando el mensaje crudo:', (e as Error).message || String(e));
  }
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
    // Mensajes que el cerebro NO entiende. Antes caían en `default: 'texto'` y
    // entraban a la máquina de estados como mensaje VACÍO (ensuciaban el estado
    // del chat y disparaban avisos que no correspondían). Ahora se guardan —
    // para que se VEAN en el panel — y NO despiertan al bot.
    case 'reaction': return 'reaccion';
    case 'location': return 'ubicacion';
    case 'contacts': return 'contacto';
    case 'interactive':
    case 'button': return 'respuesta';
    case 'order': return 'pedido';
    case 'system': return 'sistema';
    default: return 'otro';
  }
}

/** Tipos que SÍ corren el cerebro (los demás solo se registran). */
const TIPOS_CEREBRO = new Set(['texto', 'imagen', 'audio', 'video', 'documento', 'sticker']);

/**
 * Texto del mensaje: el body de texto, la LEYENDA de la foto/archivo o el
 * contenido de los tipos "raros" (emoji de una reacción, respuesta de botón,
 * dirección de una ubicación…) para que la burbuja nunca quede vacía.
 */
function textoDe(message: WaMessage): string {
  return message.text?.body
    || message.image?.caption
    || message.video?.caption
    || message.document?.caption
    || message.reaction?.emoji
    || message.button?.text
    || message.interactive?.button_reply?.title
    || message.interactive?.list_reply?.title
    || message.system?.body
    || (message.location
        ? [message.location.name, message.location.address].filter(Boolean).join(' — ')
          || [message.location.latitude, message.location.longitude]
              .filter((v) => v != null).join(', ')
        : '')
    || message.contacts?.[0]?.name?.formatted_name
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
        const hayMensajes = Array.isArray(value?.messages) && value!.messages!.length > 0;
        // `statuses` = avisos de entrega de mensajes NUESTROS (✓ ✓✓ leído, o falló).
        const hayEstados = Array.isArray(value?.statuses) && value!.statuses!.length > 0;
        if (!value || (!hayMensajes && !hayEstados)) continue;

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

        // ── Avisos de entrega (ticks) ────────────────────────────────────────
        if (hayEstados) {
          const estados = async () => {
            for (const st of value.statuses || []) {
              const estado = mapearEstado(st.status || '');
              const wamid = st.id || '';
              if (!estado || !wamid) continue;
              const detalle = (st.errors || [])
                .map((e) => [e.title, e.message, e.error_data?.details]
                  .filter(Boolean).join(' — '))
                .filter(Boolean).join(' | ');
              await actualizarEstado(
                supabaseUrl, serviceRoleKey, cfg.tenant_id, wamid, estado, detalle,
              );
            }
          };
          const rtE = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
          if (rtE && typeof rtE.waitUntil === 'function') rtE.waitUntil(estados());
          else await estados();
        }

        if (!hayMensajes) continue;

        for (const message of value.messages!) {
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
              // Mensajes que el cerebro NO entiende (reacción 👍, ubicación,
              // contacto, respuesta de botón…): se guardan para que se VEAN en
              // el panel, pero NO corren el bot ni disparan avisos. Antes caían
              // como 'texto' vacío y ensuciaban el estado de la conversación.
              if (!TIPOS_CEREBRO.has(tipo)) {
                await registrarEntranteCrudo(
                  supabaseUrl, serviceRoleKey, cfg.tenant_id, waId,
                  tipo, texto, message.id || '', message.context?.id || '',
                );
                return;
              }

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

              // El mensaje ya quedó registrado por el cerebro: se le pega su
              // wamid y — si el cliente respondió CITANDO otro mensaje — a qué
              // mensaje responde. Esto es lo que permite que el panel muestre
              // "Respondiendo a: …" en vez de un "quiero este" a ciegas.
              await guardarMetaWa(supabaseUrl, serviceRoleKey, {
                tenantId: cfg.tenant_id,
                direction: 'in',
                wamid: message.id || '',
                contextId: message.context?.id || '',
                waId,
                tipo,
                texto: textoFinal,
                mediaPath: mediaPath || undefined,
              });

              const modoHumano = String(brain.modo || '') === 'humano';
              const respondio = brain.enviar === true
                && typeof brain.mensaje === 'string' && brain.mensaje !== '';

              if (respondio) {
                const envio = await enviarMensaje(phoneNumberId, cfg.wa_token, waId, brain.mensaje as string);
                if (!envio.ok) {
                  console.error(`[WA-Webhook] No pude enviar la respuesta a ${waId}`);
                } else if (envio.wamid) {
                  // Wamid de la respuesta del bot: si el cliente la cita después,
                  // se podrá resolver igual que cualquier otro mensaje.
                  await guardarMetaWa(supabaseUrl, serviceRoleKey, {
                    tenantId: cfg.tenant_id,
                    direction: 'out',
                    wamid: envio.wamid,
                    waId,
                    tipo: 'texto',
                    texto: brain.mensaje as string,
                  });
                }
              } else if (!modoHumano && brain.avisar_negocio !== true) {
                // RED DE SEGURIDAD: el bot no respondió y tampoco dejó aviso
                // (p. ej. cliente conocido SIN pedido en curso que escribe algo que
                // el bot no entiende). Al menos queda el aviso de que le
                // escribieron, con el mismo tipo que ya pinta la web ("Contesta tú").
                await rpcAvisoSinRespuesta(supabaseUrl, serviceRoleKey, cfg.tenant_id, waId, textoFinal);
              }

              // PUSH al dueño: hay algo que revisar y NO está atendiendo a mano.
              // Llega con la web cerrada; si falla, no afecta al bot.
              if (!respondio && !modoHumano) {
                const nick = typeof brain.cliente_tiktok === 'string' && brain.cliente_tiktok
                  ? ' (@' + brain.cliente_tiktok + ')' : '';
                await avisarPush(
                  supabaseUrl, serviceRoleKey, cfg.tenant_id,
                  '💬 Ventas Live',
                  'Te escribieron y el bot necesita que respondas tú' + nick + '.',
                );
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
