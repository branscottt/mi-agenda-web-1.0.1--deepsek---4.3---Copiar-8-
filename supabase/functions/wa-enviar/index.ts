// wa-enviar/index.ts
// Envío MANUAL de WhatsApp desde el panel de Ventas Live (intervención humana en
// una conversación del bot): TEXTO, FOTO/VIDEO, ARCHIVO (PDF/Word/Excel…), AUDIO,
// REACCIÓN a un mensaje y MARCAR COMO LEÍDO — desde computador, celular o tablet.
//
// Uso: POST /functions/v1/wa-enviar
// Body texto:   { chat_id: uuid, texto: string, contexto_wa_id?: string,
//                 origen?: 'humano' | 'bot' }
//               origen 'bot' = lo escribió el bot (seguir la venta tras asignar
//               el usuario a mano): queda como burbuja del bot y el bot no cede
//               el turno. Sin origen = 'humano'.
// Body archivo: { chat_id, texto?: string (comentario), media_path, media_tipo,
//                 media_mime, contexto_wa_id?: string }
//               media_tipo: 'imagen' | 'video' | 'documento' | 'audio'
// Body reacción:{ chat_id, reaccion: { wamid, emoji } }   (emoji '' = quitarla)
// Body leído:   { chat_id, marcar_leido: true }           (✓✓ azul al cliente)
// `contexto_wa_id` = wamid del mensaje que se está CITANDO (responder a…): se
// manda como `context.message_id` a Graph y se guarda para que el panel muestre
// la cita en la burbuja saliente.
// Response: { ok: true, mensaje: { id, body, creado_en } } | { ok: true, leido }
//
// Flujo:
//   1. verify_jwt = true → Supabase ya validó la firma; decodificamos los
//      claims solo para leer el user id.
//   2. `vl_wa_chat_para_envio` (service_role) autoriza: confirma que el
//      usuario es admin del tenant dueño de la conversación y devuelve
//      phone_id + token del tenant. Esos secretos viven server-side y
//      NUNCA se devuelven al cliente.
//   3. Para un archivo: el panel YA lo subió al bucket privado 'vl-media' en la
//      carpeta de su negocio (política propia) → acá se baja con service_role,
//      se sube a Meta (media endpoint) y se manda como imagen/video/archivo/audio
//      con el comentario como caption.
//   4. POST a Graph API /<phone_id>/messages.
//   5. `vl_wa_registrar_saliente` / `vl_wa_registrar_saliente_media` /
//      `vl_wa_reaccion` (service_role) guardan el 'out' en el historial y
//      actualizan el resumen.
//
// Seguridad:
//   - Sin JWT válido → 401 (la plataforma ya lo exige con verify_jwt).
//   - El usuario solo puede enviar en conversaciones de SU espacio.
//   - El archivo debe estar en la carpeta del tenant de ESA conversación.
//   - El token del tenant jamás sale de esta función hacia el navegador.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { applySecurityHeaders } from '../_shared/security-headers.ts';

const GRAPH_API = 'https://graph.facebook.com/v21.0';
const MAX_TEXTO = 4000;
const MAX_COMENTARIO = 1024; // caption de WhatsApp para imagen/video
const TIMEOUT_MS = 25000;

// Límites de WhatsApp y formatos que acepta.
const LIMITES: Record<string, number> = {
  imagen: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  documento: 100 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
};
const MIMES: Record<string, string[]> = {
  imagen: ['image/jpeg', 'image/jpg', 'image/png'],
  video: ['video/mp4', 'video/3gpp'],
  documento: [
    'application/pdf', 'text/plain', 'application/zip',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
  audio: ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg', 'audio/x-m4a'],
};

// Nombre de archivo que se le muestra al cliente (Meta lo exige en `document`).
function nombreArchivo(mediaPath: string, tipo: string): string {
  const base = String(mediaPath || '').split('/').pop() || '';
  if (base && /\.[A-Za-z0-9]{2,5}$/.test(base)) return base.slice(0, 240);
  const ext = tipo === 'imagen' ? 'jpg' : tipo === 'video' ? 'mp4' : tipo === 'audio' ? 'ogg' : 'archivo';
  return `archivo.${ext}`;
}

interface JwtPayload {
  sub?: string;
  email?: string;
}

interface EnviarRequest {
  chat_id?: string;
  texto?: string;
  media_path?: string;
  media_tipo?: string;
  media_mime?: string;
  contexto_wa_id?: string;
  /** Reaccionar a un mensaje: { wamid del mensaje, emoji ('' = quitarla) }. */
  reaccion?: { wamid?: string; emoji?: string };
  /** Marcar el chat como leído (✓✓ azul al cliente, como al abrir WhatsApp). */
  marcar_leido?: boolean;
  /**
   * Quién firma el mensaje: 'humano' (por defecto, lo escribió una persona desde
   * el panel) o 'bot' (lo escribió el bot: al asignar el usuario a mano el bot
   * sigue la venta y manda el total + los datos de pago). Va al campo `origen`
   * del historial y hace que el bot NO ceda el turno 15 min.
   */
  origen?: string;
}

/** Decodifica el payload del JWT (la firma ya la verificó la plataforma). */
function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)),
    );
    return JSON.parse(json) as JwtPayload;
  } catch (e) {
    console.error('[wa-enviar] Error decodificando JWT:', e);
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Llama una RPC con service_role y devuelve el JSONB resultante. */
async function rpc(
  fn: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('[wa-enviar] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes');
    return null;
  }
  const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'apikey': serviceRoleKey,
      'Authorization': `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    console.error(`[wa-enviar] RPC ${fn} falló (${resp.status}):`, (await resp.text().catch(() => '')).slice(0, 300));
    return null;
  }
  const data = await resp.json();
  return Array.isArray(data) ? (data[0] as Record<string, unknown>) : (data as Record<string, unknown>);
}

/** Envía un texto por Graph API. Devuelve el wamid que asigna WhatsApp. */
async function enviarGraph(
  phoneId: string, token: string, to: string, body: string, contextId = '',
): Promise<{ ok: boolean; detalle: string; wamid: string }> {
  const msg: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    // preview_url: true = WhatsApp arma la tarjeta del link (como cuando
    // escribís desde el celular). Antes iba en false y los enlaces llegaban
    // pelados, sin título ni imagen.
    text: { body, preview_url: true },
  };
  // Responder CITANDO: WhatsApp lo muestra como "respondiendo a…" en el chat del cliente.
  if (contextId) msg.context = { message_id: contextId };
  const resp = await fetch(`${GRAPH_API}/${phoneId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(msg),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    console.error(`[wa-enviar] Graph API error (${resp.status}):`, err.slice(0, 400));
    return { ok: false, detalle: err.slice(0, 300), wamid: '' };
  }
  const data = await resp.json().catch(() => ({})) as { messages?: Array<{ id?: string }> };
  return { ok: true, detalle: '', wamid: data?.messages?.[0]?.id || '' };
}

/**
 * Guarda el wamid del mensaje que se acaba de enviar (y la cita, si la hubiera)
 * en la fila que ya quedó registrada en vl_wa_mensajes. "Mejor esfuerzo": si
 * falla, el mensaje YA se envió y solo no se podrá resolver como cita.
 */
async function guardarWamid(p: {
  tenantId: string;
  chatId: string;
  wamid: string;
  tipo: string;
  texto?: string;
  mediaPath?: string;
  contextId?: string;
}): Promise<void> {
  if (!p.wamid && !p.contextId) return;
  try {
    const resp = await fetch(
      `${Deno.env.get('SUPABASE_URL') || ''}/rest/v1/rpc/vl_wa_guardar_meta_wa`,
      {
        method: 'POST',
        headers: {
          'apikey': Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          p_tenant_id: p.tenantId,
          p_direction: 'out',
          p_wa_message_id: p.wamid || null,
          p_chat_id: p.chatId,
          p_context_wa_id: p.contextId || null,
          p_tipo: p.tipo,
          p_texto: p.texto || null,
          p_media_path: p.mediaPath || null,
        }),
      },
    );
    if (!resp.ok) {
      console.warn(`[wa-enviar] No pude guardar el wamid (${resp.status})`);
    }
  } catch (e) {
    console.warn('[wa-enviar] Error guardando el wamid:', (e as Error).message || String(e));
  }
}

// ── Caché corta de las credenciales del negocio ─────────────────────────────
// `vl_wa_chat_para_envio` cuesta ~300 ms medidos (6 tomas) y devuelve LO MISMO
// mientras el dueño no reconecte el número, así que en una ráfaga (varios mensajes
// seguidos a la misma conversación) se pedía una y otra vez para nada.
//
// CLAVE: la clave incluye el ID DEL USUARIO. Esa RPC no solo trae credenciales,
// también es la que AUTORIZA (confirma que el usuario es admin del negocio dueño de
// la conversación). Si se cacheara solo por chat, otro usuario podría aprovechar la
// autorización del primero. Se guarda por (chat + usuario), nunca sin el usuario.
const CACHE_ENVIO_MS = 60_000;   // 1 minuto: si reconectás el número, se corrige solo
const CACHE_ENVIO_MAX = 200;     // tope de memoria; al llenarse, se tira entera
const cacheEnvio = new Map<string, { t: number; cfg: Record<string, unknown> }>();

async function cfgDeEnvio(chatId: string, userId: string): Promise<Record<string, unknown> | null> {
  const k = chatId + '|' + userId;
  const guardada = cacheEnvio.get(k);
  if (guardada && Date.now() - guardada.t < CACHE_ENVIO_MS) return guardada.cfg;
  const cfg = await rpc('vl_wa_chat_para_envio', { p_chat_id: chatId, p_user_id: userId });
  if (cfg && cfg.ok === true) {
    if (cacheEnvio.size >= CACHE_ENVIO_MAX) cacheEnvio.clear();
    cacheEnvio.set(k, { t: Date.now(), cfg });
  }
  return cfg;
}

/** Meta dijo que la credencial no sirve: se tira de la caché y se relee al toque. */
function olvidarCredencial(chatId: string, userId: string): void {
  cacheEnvio.delete(chatId + '|' + userId);
}

/** ¿El rechazo es porque el token quedó viejo? (el error real que devuelve Meta) */
function credencialVencida(detalle: string): boolean {
  const d = String(detalle || '');
  return d.includes('OAuthException') || d.includes('"code":190') || d.includes('"code": 190');
}

/**
 * Traduce el rechazo de WhatsApp a algo que se entienda en el panel. El caso que
 * importa es 131047: pasaron más de 24 h desde el último mensaje del cliente y
 * WhatsApp NO permite escribirle texto libre hasta que él vuelva a escribir (o
 * hasta mandar una plantilla aprobada). Antes eso salía como un genérico
 * "WhatsApp rechazó el envío" y no había forma de saber qué hacer.
 */
function mensajeDeRechazo(detalle: string): string {
  const d = detalle || '';
  if (d.includes('131047') || /re-?engagement/i.test(d)) {
    return 'Pasaron más de 24 horas desde el último mensaje del cliente y WhatsApp '
      + 'no deja escribirle sin una plantilla aprobada. Pedile que te escriba algo '
      + '(aunque sea un "hola") y contestá ahí mismo.';
  }
  if (d.includes('131026') || /not a valid whatsapp/i.test(d)) {
    return 'Ese número no tiene WhatsApp o no puede recibir mensajes.';
  }
  if (d.includes('470') && /24/.test(d)) {
    return 'La ventana de 24 horas se cerró: pedile al cliente que te escriba de nuevo.';
  }
  return 'WhatsApp rechazó el envío';
}

/**
 * Corre una promesa SIN que el navegador espere por ella. Es para tareas de
 * "mejor esfuerzo" que no deben retrasar la respuesta al panel (el mensaje ya
 * se envió y ya quedó registrado). EdgeRuntime.waitUntil mantiene viva la
 * función hasta que la tarea termine; si no está disponible, se deja correr
 * suelta (su propio catch evita un rechazo sin manejar).
 */
function enSegundoPlano(p: Promise<unknown>): void {
  const tarea = Promise.resolve(p).catch((e: unknown) => {
    console.warn('[wa-enviar] Tarea en segundo plano falló:', (e as Error)?.message || String(e));
  });
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (x: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt && typeof rt.waitUntil === 'function') rt.waitUntil(tarea);
}

/** Baja el archivo del bucket privado con service_role (nunca lo ve el navegador). */
async function bajarArchivo(ruta: string): Promise<Uint8Array | null> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const resp = await fetch(
    `${supabaseUrl}/storage/v1/object/vl-media/${ruta.split('/').map(encodeURIComponent).join('/')}`,
    {
      headers: { 'apikey': serviceRoleKey, 'Authorization': `Bearer ${serviceRoleKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!resp.ok) {
    console.error(`[wa-enviar] No pude bajar el archivo (${resp.status})`);
    return null;
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());
  return bytes.length ? bytes : null;
}

/**
 * Sube el archivo a Meta y devuelve su media id. Meta guarda el id ~30 días y
 * solo entonces se puede mandar por mensaje.
 */
async function subirAMeta(
  phoneId: string, token: string, bytes: Uint8Array, mime: string, tipo: string,
  nombre = '',
): Promise<{ ok: boolean; mediaId: string; detalle: string }> {
  const nombreReal = nombre || (tipo === 'video' ? 'video.mp4'
    : tipo === 'audio' ? 'audio.ogg' : tipo === 'document' ? 'archivo.pdf' : 'foto.jpg');
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', tipo);
  form.append('file', new Blob([bytes], { type: mime }), nombreReal);

  const resp = await fetch(`${GRAPH_API}/${phoneId}/media`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  const txt = await resp.text().catch(() => '');
  if (!resp.ok) {
    console.error(`[wa-enviar] Meta rechazó el archivo (${resp.status}):`, txt.slice(0, 400));
    return { ok: false, mediaId: '', detalle: txt.slice(0, 300) };
  }
  try {
    const data = JSON.parse(txt) as { id?: string };
    if (!data.id) return { ok: false, mediaId: '', detalle: 'Sin id de archivo' };
    return { ok: true, mediaId: data.id, detalle: '' };
  } catch (_) {
    return { ok: false, mediaId: '', detalle: 'Respuesta inesperada de WhatsApp' };
  }
}

/** Manda la imagen/video/archivo ya subida, con el comentario como caption. */
async function enviarMediaGraph(
  phoneId: string, token: string, to: string, tipo: string, mediaId: string,
  caption: string, contextId = '', nombre = '',
): Promise<{ ok: boolean; detalle: string; wamid: string }> {
  const cuerpo: Record<string, unknown> = { id: mediaId };
  // WhatsApp: el AUDIO no lleva caption (solo id); el ARCHIVO lleva filename.
  if (tipo === 'document') {
    cuerpo.filename = (nombre || 'archivo').slice(0, 240);
    if (caption) cuerpo.caption = caption.slice(0, MAX_COMENTARIO);
  } else if (tipo !== 'audio') {
    if (caption) cuerpo.caption = caption.slice(0, MAX_COMENTARIO);
  }
  const msg: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: tipo,                    // 'image' | 'video' | 'document' | 'audio'
    [tipo]: cuerpo,
  };
  if (contextId) msg.context = { message_id: contextId };
  const resp = await fetch(`${GRAPH_API}/${phoneId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(msg),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    console.error(`[wa-enviar] Graph API media error (${resp.status}):`, err.slice(0, 400));
    return { ok: false, detalle: err.slice(0, 300), wamid: '' };
  }
  const data = await resp.json().catch(() => ({})) as { messages?: Array<{ id?: string }> };
  return { ok: true, detalle: '', wamid: data?.messages?.[0]?.id || '' };
}

/**
 * REACCIÓN a un mensaje (😍👍🔥…), como en WhatsApp: va en su propio campo
 * (`reaction.message_id` + `reaction.emoji`), NO usa `context`.
 * Emoji vacío = quitar la reacción puesta antes.
 */
async function enviarReaccionGraph(
  phoneId: string, token: string, to: string, targetWamid: string, emoji: string,
): Promise<{ ok: boolean; detalle: string; wamid: string }> {
  const msg = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'reaction',
    reaction: { message_id: targetWamid, emoji },
  };
  const resp = await fetch(`${GRAPH_API}/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(msg),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    console.error(`[wa-enviar] Graph API reacción error (${resp.status}):`, err.slice(0, 400));
    return { ok: false, detalle: err.slice(0, 300), wamid: '' };
  }
  const data = await resp.json().catch(() => ({})) as { messages?: Array<{ id?: string }> };
  return { ok: true, detalle: '', wamid: data?.messages?.[0]?.id || '' };
}

/**
 * Marca como LEÍDO (✓✓ azul) un mensaje que NOS LLEGÓ, como cuando abres el chat
 * en WhatsApp. Meta solo lo acepta para mensajes recibidos y por su wamid.
 */
async function marcarLeidoGraph(
  phoneId: string, token: string, wamid: string,
): Promise<{ ok: boolean; detalle: string }> {
  const resp = await fetch(`${GRAPH_API}/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: wamid }),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    console.error(`[wa-enviar] Graph API marcar leído error (${resp.status}):`, err.slice(0, 300));
    return { ok: false, detalle: err.slice(0, 300) };
  }
  return { ok: true, detalle: '' };
}

async function handle(req: Request): Promise<Response> {
  const requestOrigin = req.headers.get('origin') || '';
  const allowedOriginsEnv = Deno.env.get('ALLOWED_ORIGINS') || '';
  const allowedOrigins = allowedOriginsEnv ? allowedOriginsEnv.split(',').map((o) => o.trim()) : [];
  const corsOrigin = allowedOrigins.length > 0 && allowedOrigins.includes(requestOrigin)
    ? requestOrigin
    : allowedOrigins.length > 0 ? allowedOrigins[0] : requestOrigin || '*';

  const json = (payload: unknown, status: number) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
    });

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  if (req.method !== 'POST') {
    return json({ ok: false, error: 'Método no permitido' }, 405);
  }

  try {
    const authHeader = req.headers.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      return json({ ok: false, error: 'Autenticación requerida' }, 401);
    }
    const jwt = decodeJwtPayload(authHeader.slice(7).trim());
    if (!jwt || !jwt.sub) {
      return json({ ok: false, error: 'Sesión inválida' }, 401);
    }

    const body = (await req.json().catch(() => ({}))) as EnviarRequest;
    const chatId = (body.chat_id || '').trim();
    const texto = (body.texto || '').trim();
    const mediaPath = (body.media_path || '').trim();
    const mediaTipo = (body.media_tipo || '').trim().toLowerCase();
    const mediaMime = (body.media_mime || '').trim().toLowerCase();
    // Wamid del mensaje que se cita (responder a…). Solo el id: si viene
    // cualquier otra cosa se ignora en vez de romper el envío.
    const contexto = /^wamid\.[A-Za-z0-9_\-=+/]{6,200}$/.test((body.contexto_wa_id || '').trim())
      ? (body.contexto_wa_id || '').trim()
      : '';

    // Quién firma el mensaje. El panel manda 'bot' SOLO cuando lo escribió el
    // bot (al asignar el usuario a mano el bot sigue la venta y manda el total
    // + los datos de pago): así queda como burbuja del bot en el historial y el
    // bot NO cede el turno 15 min. Cualquier otra cosa = 'humano' (por defecto).
    const origen = String(body.origen || '').trim().toLowerCase() === 'bot' ? 'bot' : 'humano';

    if (!UUID_RE.test(chatId)) {
      return json({ ok: false, error: 'chat_id inválido' }, 400);
    }

    // ── REACCIÓN / MARCAR LEÍDO ──────────────────────────────────────────────
    // No llevan texto ni archivo, así que se resuelven ANTES de la validación de
    // contenido y comparten la misma autorización (vl_wa_chat_para_envio).
    const targetReaccion = /^wamid\.[A-Za-z0-9_\-=+/]{6,200}$/.test(
      String((body.reaccion && body.reaccion.wamid) || '').trim(),
    ) ? String(body.reaccion!.wamid).trim() : '';
    const quiereReaccion = !!(body.reaccion && typeof body.reaccion === 'object');
    const quiereLeido = body.marcar_leido === true;

    if (quiereReaccion || quiereLeido) {
      const cfgR = await cfgDeEnvio(chatId, jwt.sub);
      if (!cfgR || cfgR.ok !== true) {
        const motivo = (cfgR && (cfgR.error as string)) || 'No se pudo autorizar el envío';
        return json({ ok: false, error: motivo }, 403);
      }
      const phoneIdR = String(cfgR.phone_id || '');
      const tokenR = String(cfgR.token || '');
      const waIdR = String(cfgR.wa_id || '');
      const tenantIdR = String(cfgR.tenant_id || '');
      if (!phoneIdR || !tokenR || !waIdR) {
        return json({ ok: false, error: 'Conexión de WhatsApp incompleta' }, 500);
      }

      if (quiereReaccion) {
        if (!targetReaccion) {
          return json({ ok: false, error: 'Falta el mensaje a reaccionar' }, 400);
        }
        // Emoji vacío = QUITAR la reacción (igual que WhatsApp).
        const emoji = String(body.reaccion!.emoji || '').trim().slice(0, 16);
        const env = await enviarReaccionGraph(phoneIdR, tokenR, waIdR, targetReaccion, emoji);
        if (!env.ok) {
          return json({ ok: false, error: 'WhatsApp rechazó la reacción', detalle: env.detalle }, 502);
        }
        // Se guarda SOLO después de que WhatsApp la aceptó (el historial no miente).
        const reg = await rpc('vl_wa_reaccion', {
          p_tenant_id: tenantIdR,
          p_wa_id: waIdR,
          p_target_wamid: targetReaccion,
          p_emoji: emoji,
          p_evento_wamid: env.wamid || null,
          p_direction: 'out',
        });
        if (!reg || reg.ok !== true) {
          console.error('[wa-enviar] La reacción se envió pero no se pudo registrar');
          return json({
            ok: false,
            error: 'La reacción se envió, pero no se pudo guardar en el historial',
          }, 500);
        }
        return json({ ok: true, reaccion: { wamid: targetReaccion, emoji } }, 200);
      }

      // MARCAR LEÍDO: ✓✓ azul al cliente, como al abrir el chat en WhatsApp.
      // Es "mejor esfuerzo": si Meta no lo acepta, el chat se abre igual.
      const ult = await rpc('vl_wa_ultimo_entrante', { p_chat_id: chatId });
      const wamidEntrante = (ult && ult.ok === true && ult.wamid) ? String(ult.wamid) : '';
      if (!wamidEntrante) {
        return json({ ok: true, leido: false, motivo: 'No hay mensajes del cliente por marcar' }, 200);
      }
      const env = await marcarLeidoGraph(phoneIdR, tokenR, wamidEntrante);
      return json({ ok: true, leido: env.ok, wamid: wamidEntrante, detalle: env.detalle || '' }, 200);
    }

    const conArchivo = mediaPath !== '';
    if (!conArchivo) {
      if (texto === '') {
        return json({ ok: false, error: 'El mensaje no puede estar vacío' }, 400);
      }
      if (texto.length > MAX_TEXTO) {
        return json({ ok: false, error: `El mensaje supera ${MAX_TEXTO} caracteres` }, 400);
      }
    } else {
      if (!(mediaTipo in LIMITES)) {
        return json({ ok: false, error: 'Solo se pueden mandar fotos, videos, archivos o audios' }, 400);
      }
      if (texto.length > MAX_COMENTARIO) {
        return json({ ok: false, error: `El comentario supera ${MAX_COMENTARIO} caracteres` }, 400);
      }
    }

    // Autorización + credenciales del tenant (service_role). Con caché corta: sólo
    // se consulta de nuevo si pasó el minuto o si Meta dijo que el token no sirve.
    const cfg = await cfgDeEnvio(chatId, jwt.sub);
    if (!cfg || cfg.ok !== true) {
      const motivo = (cfg && (cfg.error as string)) || 'No se pudo autorizar el envío';
      return json({ ok: false, error: motivo }, 403);
    }

    const phoneId = String(cfg.phone_id || '');
    const token = String(cfg.token || '');
    const waId = String(cfg.wa_id || '');
    const tenantId = String(cfg.tenant_id || '');
    if (!phoneId || !token || !waId) {
      return json({ ok: false, error: 'Conexión de WhatsApp incompleta' }, 500);
    }

    // ── CON ARCHIVO: bajar del bucket → subir a Meta → mandar con comentario ──
    if (conArchivo) {
      if (!tenantId || !mediaPath.startsWith(tenantId + '/')) {
        return json({ ok: false, error: 'El archivo no es de este negocio' }, 403);
      }
      const mimes = MIMES[mediaTipo] || [];
      if (mediaMime && mimes.length && !mimes.includes(mediaMime)) {
        const que = mediaTipo === 'imagen' ? 'WhatsApp solo acepta fotos JPG o PNG'
          : mediaTipo === 'video' ? 'WhatsApp solo acepta videos MP4'
          : mediaTipo === 'audio' ? 'WhatsApp solo acepta audios MP3, M4A, AAC, AMR u OGG'
          : 'WhatsApp no acepta ese formato de archivo (PDF, Word, Excel, ZIP o TXT)';
        return json({ ok: false, error: que }, 400);
      }

      const bytes = await bajarArchivo(mediaPath);
      if (!bytes) {
        return json({ ok: false, error: 'No se encontró el archivo subido' }, 404);
      }
      const limite = LIMITES[mediaTipo];
      if (bytes.length > limite) {
        return json({
          ok: false,
          error: `El archivo pesa ${(bytes.length / 1048576).toFixed(1)} MB y WhatsApp acepta hasta ${Math.round(limite / 1048576)} MB`,
        }, 413);
      }

      // Tipo con el que Meta conoce cada archivo (no es el nombre del dominio).
      const tipoMeta = mediaTipo === 'video' ? 'video'
        : mediaTipo === 'documento' ? 'document'
        : mediaTipo === 'audio' ? 'audio'
        : 'image';
      const mimePorDefecto: Record<string, string> = {
        image: 'image/jpeg', video: 'video/mp4', document: 'application/pdf', audio: 'audio/mpeg',
      };
      const mimeReal = mediaMime || mimePorDefecto[tipoMeta];
      const nombre = nombreArchivo(mediaPath, mediaTipo);
      const subida = await subirAMeta(phoneId, token, bytes, mimeReal, tipoMeta, nombre);
      if (!subida.ok) {
        if (credencialVencida(subida.detalle)) olvidarCredencial(chatId, jwt.sub);
        return json({ ok: false, error: 'WhatsApp rechazó el archivo', detalle: subida.detalle }, 502);
      }

      const envio = await enviarMediaGraph(
        phoneId, token, waId, tipoMeta, subida.mediaId, texto, contexto, nombre,
      );
      if (!envio.ok) {
        if (credencialVencida(envio.detalle)) olvidarCredencial(chatId, jwt.sub);
        return json({ ok: false, error: mensajeDeRechazo(envio.detalle), detalle: envio.detalle }, 502);
      }

      // El wamid va en la MISMA inserción: antes había que pegarlo después con
      // otra RPC (~300 ms de espera extra para el navegador, medido en vivo).
      const reg = await rpc('vl_wa_registrar_saliente_media', {
        p_chat_id: chatId,
        p_texto: texto,
        p_tipo: mediaTipo,
        p_media_path: mediaPath,
        p_wamid: envio.wamid || null,
        p_contexto_wa_id: contexto || null,
      });
      if (!reg || reg.ok !== true) {
        console.error('[wa-enviar] El archivo se envió pero no se pudo registrar en el historial');
        return json({ ok: false, error: 'Se envió, pero no se pudo guardar en el historial' }, 500);
      }

      // Red de seguridad: si la RPC no devolvió el wamid guardado (versión vieja
      // de la función), se intenta el guardado clásico SIN hacer esperar al
      // navegador (el envío ya está hecho y registrado).
      if (envio.wamid && !reg.wa_message_id) {
        enSegundoPlano(guardarWamid({
          tenantId,
          chatId,
          wamid: envio.wamid,
          tipo: mediaTipo,
          mediaPath,
          contextId: contexto,
        }));
      }

      return json({
        ok: true,
        mensaje: {
          id: reg.mensaje_id,
          body: reg.body,
          creado_en: reg.creado_en,
          media_path: reg.media_path,
          tipo: mediaTipo,
        },
      }, 200);
    }

    // ── SOLO TEXTO ──
    const envio = await enviarGraph(phoneId, token, waId, texto, contexto);
    if (!envio.ok) {
      if (credencialVencida(envio.detalle)) olvidarCredencial(chatId, jwt.sub);
      return json({ ok: false, error: mensajeDeRechazo(envio.detalle), detalle: envio.detalle }, 502);
    }

    // El wamid (y la cita) van en la MISMA inserción: antes había que pegarlos
    // después con otra RPC, que el navegador esperaba (~300 ms extra, medido).
    const reg = await rpc('vl_wa_registrar_saliente', {
      p_chat_id: chatId,
      p_texto: texto,
      p_wamid: envio.wamid || null,
      p_contexto_wa_id: contexto || null,
      p_origen: origen,
    });
    if (!reg || reg.ok !== true) {
      console.error('[wa-enviar] El mensaje se envió pero no se pudo registrar en el historial');
      return json({ ok: false, error: 'El mensaje se envió pero no se pudo guardar en el historial' }, 500);
    }

    // Red de seguridad: si la RPC no devolvió el wamid guardado (versión vieja
    // de la función), se intenta el guardado clásico SIN hacer esperar al
    // navegador (el mensaje ya se envió y quedó registrado).
    if (envio.wamid && !reg.wa_message_id) {
      enSegundoPlano(guardarWamid({
        tenantId, chatId, wamid: envio.wamid, tipo: 'texto', texto, contextId: contexto,
      }));
    }

    return json({
      ok: true,
      mensaje: {
        id: reg.mensaje_id,
        body: reg.body,
        creado_en: reg.creado_en,
      },
    }, 200);
  } catch (e) {
    console.error('[wa-enviar] Error inesperado:', (e as Error).message || String(e));
    return json({ ok: false, error: 'Error interno del servidor' }, 500);
  }
}

serve(async (req) => applySecurityHeaders(await handle(req)));
