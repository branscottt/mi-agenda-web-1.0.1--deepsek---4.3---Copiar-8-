// wa-enviar/index.ts
// Envío MANUAL de un mensaje de WhatsApp desde el panel de Ventas Live
// (intervención humana en una conversación del bot).
//
// Uso: POST /functions/v1/wa-enviar
// Body: { chat_id: uuid, texto: string }
// Response: { ok: true, mensaje: { id, body, creado_en } }
//
// Flujo:
//   1. verify_jwt = true → Supabase ya validó la firma; decodificamos los
//      claims solo para leer el user id.
//   2. `vl_wa_chat_para_envio` (service_role) autoriza: confirma que el
//      usuario es admin del tenant dueño de la conversación y devuelve
//      phone_id + token del tenant. Esos secretos viven server-side y
//      NUNCA se devuelven al cliente.
//   3. POST a Graph API /<phone_id>/messages.
//   4. `vl_wa_registrar_saliente` (service_role) guarda el 'out' en el
//      historial y actualiza el resumen del chat.
//
// Seguridad:
//   - Sin JWT válido → 401 (la plataforma ya lo exige con verify_jwt).
//   - El usuario solo puede enviar en conversaciones de SU espacio.
//   - El token del tenant jamás sale de esta función hacia el navegador.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { applySecurityHeaders } from '../_shared/security-headers.ts';

const GRAPH_API = 'https://graph.facebook.com/v21.0';
const MAX_TEXTO = 4000;

interface JwtPayload {
  sub?: string;
  email?: string;
}

interface EnviarRequest {
  chat_id?: string;
  texto?: string;
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

/** Envía un texto por Graph API. */
async function enviarGraph(phoneId: string, token: string, to: string, body: string): Promise<{ ok: boolean; detalle: string }> {
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

    if (!UUID_RE.test(chatId)) {
      return json({ ok: false, error: 'chat_id inválido' }, 400);
    }
    if (texto === '') {
      return json({ ok: false, error: 'El mensaje no puede estar vacío' }, 400);
    }
    if (texto.length > MAX_TEXTO) {
      return json({ ok: false, error: `El mensaje supera ${MAX_TEXTO} caracteres` }, 400);
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
    if (!phoneId || !token || !waId) {
      return json({ ok: false, error: 'Conexión de WhatsApp incompleta' }, 500);
    }

    const envio = await enviarGraph(phoneId, token, waId, texto);
    if (!envio.ok) {
      return json({ ok: false, error: 'WhatsApp rechazó el envío', detalle: envio.detalle }, 502);
    }

    const reg = await rpc('vl_wa_registrar_saliente', { p_chat_id: chatId, p_texto: texto });
    if (!reg || reg.ok !== true) {
      console.error('[wa-enviar] El mensaje se envió pero no se pudo registrar en el historial');
      return json({ ok: false, error: 'El mensaje se envió pero no se pudo guardar en el historial' }, 500);
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
