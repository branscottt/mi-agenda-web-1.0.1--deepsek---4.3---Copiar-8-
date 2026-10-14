// wa-enviar/index.ts
// Envío MANUAL de un mensaje de WhatsApp desde el panel de Ventas Live
// (intervención humana en una conversación del bot): TEXTO o FOTO/VIDEO con
// comentario, desde computador, celular o tablet.
//
// Uso: POST /functions/v1/wa-enviar
// Body texto: { chat_id: uuid, texto: string }
// Body media: { chat_id, texto?: string (comentario), media_path, media_tipo, media_mime }
// Response: { ok: true, mensaje: { id, body, creado_en } }
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
//      se sube a Meta (media endpoint) y se manda como imagen/video con el
//      comentario como caption.
//   4. POST a Graph API /<phone_id>/messages.
//   5. `vl_wa_registrar_saliente` / `vl_wa_registrar_saliente_media`
//      (service_role) guardan el 'out' en el historial y actualizan el resumen.
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
};
const MIMES: Record<string, string[]> = {
  imagen: ['image/jpeg', 'image/jpg', 'image/png'],
  video: ['video/mp4', 'video/3gpp'],
};

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
  phoneId: string, token: string, to: string, body: string,
): Promise<{ ok: boolean; detalle: string; wamid: string }> {
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
}): Promise<void> {
  if (!p.wamid) return;
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
          p_wa_message_id: p.wamid,
          p_chat_id: p.chatId,
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
): Promise<{ ok: boolean; mediaId: string; detalle: string }> {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', tipo);
  form.append('file', new Blob([bytes], { type: mime }), tipo === 'video' ? 'video.mp4' : 'foto.jpg');

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

/** Manda la imagen/video ya subida, con el comentario como caption. */
async function enviarMediaGraph(
  phoneId: string, token: string, to: string, tipo: string, mediaId: string, caption: string,
): Promise<{ ok: boolean; detalle: string; wamid: string }> {
  const cuerpo: Record<string, unknown> = { id: mediaId };
  if (caption) cuerpo.caption = caption.slice(0, MAX_COMENTARIO);
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
      type: tipo,                    // 'image' | 'video'
      [tipo]: cuerpo,
    }),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    console.error(`[wa-enviar] Graph API media error (${resp.status}):`, err.slice(0, 400));
    return { ok: false, detalle: err.slice(0, 300), wamid: '' };
  }
  const data = await resp.json().catch(() => ({})) as { messages?: Array<{ id?: string }> };
  return { ok: true, detalle: '', wamid: data?.messages?.[0]?.id || '' };
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

    if (!UUID_RE.test(chatId)) {
      return json({ ok: false, error: 'chat_id inválido' }, 400);
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
        return json({ ok: false, error: 'Solo se pueden mandar fotos o videos' }, 400);
      }
      if (texto.length > MAX_COMENTARIO) {
        return json({ ok: false, error: `El comentario supera ${MAX_COMENTARIO} caracteres` }, 400);
      }
    }

    // Autorización + credenciales del tenant (service_role)
    const cfg = await rpc('vl_wa_chat_para_envio', { p_chat_id: chatId, p_user_id: jwt.sub });
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
        return json({
          ok: false,
          error: mediaTipo === 'imagen'
            ? 'WhatsApp solo acepta fotos JPG o PNG'
            : 'WhatsApp solo acepta videos MP4',
        }, 400);
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

      const tipoMeta = mediaTipo === 'video' ? 'video' : 'image';
      const mimeReal = mediaMime || (tipoMeta === 'video' ? 'video/mp4' : 'image/jpeg');
      const subida = await subirAMeta(phoneId, token, bytes, mimeReal, tipoMeta);
      if (!subida.ok) {
        return json({ ok: false, error: 'WhatsApp rechazó el archivo', detalle: subida.detalle }, 502);
      }

      const envio = await enviarMediaGraph(phoneId, token, waId, tipoMeta, subida.mediaId, texto);
      if (!envio.ok) {
        return json({ ok: false, error: 'WhatsApp rechazó el envío', detalle: envio.detalle }, 502);
      }

      const reg = await rpc('vl_wa_registrar_saliente_media', {
        p_chat_id: chatId,
        p_texto: texto,
        p_tipo: mediaTipo,
        p_media_path: mediaPath,
      });
      if (!reg || reg.ok !== true) {
        console.error('[wa-enviar] El archivo se envió pero no se pudo registrar en el historial');
        return json({ ok: false, error: 'Se envió, pero no se pudo guardar en el historial' }, 500);
      }

      // Wamid del archivo enviado: permite resolver después si el cliente lo cita.
      await guardarWamid({
        tenantId,
        chatId,
        wamid: envio.wamid,
        tipo: mediaTipo,
        mediaPath,
      });

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
    const envio = await enviarGraph(phoneId, token, waId, texto);
    if (!envio.ok) {
      return json({ ok: false, error: 'WhatsApp rechazó el envío', detalle: envio.detalle }, 502);
    }

    const reg = await rpc('vl_wa_registrar_saliente', { p_chat_id: chatId, p_texto: texto });
    if (!reg || reg.ok !== true) {
      console.error('[wa-enviar] El mensaje se envió pero no se pudo registrar en el historial');
      return json({ ok: false, error: 'El mensaje se envió pero no se pudo guardar en el historial' }, 500);
    }

    await guardarWamid({ tenantId, chatId, wamid: envio.wamid, tipo: 'texto', texto });

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
