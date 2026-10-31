// wa-signup/index.ts
// ALTA AUTOMÁTICA DE WHATSAPP ("Conectar con Facebook" / Embedded Signup de Meta)
//
// Qué hace
//   El panel abre el diálogo de Meta; Meta devuelve un `code` + el WABA y el
//   phone_number_id elegidos por el negocio. Esta función:
//     1. canjea el code por un access token (server-side, con el App Secret),
//     2. suscribe la app al WABA (para que lleguen los mensajes al webhook),
//     3. lee el número real (display_phone_number) para mostrarlo en el panel,
//     4. opcional: registra el número con un PIN de 6 dígitos,
//     5. guarda TODO con la RPC vl_wa_signup_guardar usando el JWT del usuario
//        (el tenant se resuelve en la base: el navegador no lo elige).
//
// Acciones (POST JSON)
//   { action: 'estado' }   → { ok, disponible, app_id, config_id, graph_version }
//   { action: 'conectar', code, waba_id, phone_number_id, business_id?, pin? }
//                          → { ok, telefono, nombre }
//
// Secretos (Supabase → Edge Functions → Secrets)
//   META_APP_ID        App ID de la app de Meta
//   META_APP_SECRET    App Secret (NUNCA se expone al navegador)
//   META_CONFIG_ID     Config ID del Embedded Signup
//   META_GRAPH_VERSION opcional (por defecto v21.0)
//
// Seguridad
//   verify_jwt = true: la plataforma exige un JWT válido. La autorización fina
//   (admin del espacio) la hace la RPC en la base, no esta función.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';
const APP_ID = Deno.env.get('META_APP_ID') || '';
const APP_SECRET = Deno.env.get('META_APP_SECRET') || '';
const CONFIG_ID = Deno.env.get('META_CONFIG_ID') || '';
const GRAPH = Deno.env.get('META_GRAPH_VERSION') || 'v21.0';

function corsDe(req: Request): string {
  const requestOrigin = req.headers.get('origin') || '';
  const lista = (Deno.env.get('ALLOWED_ORIGINS') || '')
    .split(',').map((o) => o.trim()).filter(Boolean);
  if (lista.length === 0) return requestOrigin || '*';
  return lista.includes(requestOrigin) ? requestOrigin : lista[0];
}

function json(payload: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Vary': 'Origin',
    },
  });
}

async function graph(path: string, init: RequestInit = {}): Promise<{ ok: boolean; data: any }> {
  const url = path.startsWith('http') ? path : `https://graph.facebook.com/${GRAPH}/${path}`;
  const resp = await fetch(url, init);
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, data };
}

serve(async (req) => {
  const origin = corsDe(req);
  if (req.method === 'OPTIONS') return json({ ok: true }, 204, origin);
  if (req.method !== 'POST') return json({ ok: false, error: 'Método no permitido' }, 405, origin);

  let body: any = {};
  try { body = await req.json(); } catch { /* body vacío */ }
  const action = String(body?.action || 'estado');

  // ── Estado: ¿se puede usar "Conectar con Facebook"? ──
  if (action === 'estado') {
    return json({
      ok: true,
      disponible: Boolean(APP_ID && CONFIG_ID),
      app_id: APP_ID,
      config_id: CONFIG_ID,
      graph_version: GRAPH,
      // Para diagnosticar sin filtrar el secreto:
      tiene_secret: Boolean(APP_SECRET),
    }, 200, origin);
  }

  if (action !== 'conectar') {
    return json({ ok: false, error: 'Acción desconocida' }, 400, origin);
  }

  if (!APP_ID || !APP_SECRET || !CONFIG_ID) {
    return json({
      ok: false,
      error: 'Falta configurar la app de Meta (META_APP_ID / META_APP_SECRET / META_CONFIG_ID).',
    }, 503, origin);
  }

  const code = String(body?.code || '').trim();
  const wabaId = String(body?.waba_id || '').trim();
  const phoneId = String(body?.phone_number_id || '').trim();
  const businessId = String(body?.business_id || '').trim();
  const pin = String(body?.pin || '').trim();

  if (!code || !wabaId || !phoneId) {
    return json({ ok: false, error: 'Meta no devolvió el código, el WABA o el número' }, 400, origin);
  }

  try {
    // 1) code → token
    const qs = new URLSearchParams({
      client_id: APP_ID,
      client_secret: APP_SECRET,
      code,
    });
    const tok = await graph(`oauth/access_token?${qs.toString()}`);
    const token = tok.data?.access_token || '';
    if (!tok.ok || !token) {
      return json({
        ok: false,
        error: tok.data?.error?.message || 'Meta rechazó el código de autorización',
      }, 400, origin);
    }

    // 2) suscribir la app al WABA (sin esto no llegan los mensajes al webhook)
    const sub = await graph(`${wabaId}/subscribed_apps?access_token=${encodeURIComponent(token)}`, { method: 'POST' });
    if (!sub.ok) {
      return json({
        ok: false,
        error: sub.data?.error?.message || 'No se pudo suscribir la app al WABA',
      }, 400, origin);
    }

    // 3) datos del número (para mostrarlo en el panel)
    const info = await graph(`${phoneId}?fields=display_phone_number,verified_name&access_token=${encodeURIComponent(token)}`);
    const telefono = info.data?.display_phone_number || '';
    const nombre = info.data?.verified_name || '';

    // 4) registro con PIN (opcional; algunos flujos ya lo dejan registrado)
    if (pin) {
      const reg = await graph(`${phoneId}/register?access_token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
      });
      if (!reg.ok) {
        return json({
          ok: false,
          error: reg.data?.error?.message || 'El número no se pudo registrar con el PIN',
        }, 400, origin);
      }
    }

    // 5) guardar con el JWT del usuario (autoriza la RPC)
    const auth = req.headers.get('Authorization') || '';
    const save = await fetch(`${SUPABASE_URL}/rest/v1/rpc/vl_wa_signup_guardar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': ANON_KEY,
        'Authorization': auth,
      },
      body: JSON.stringify({
        p_phone_id: phoneId,
        p_token: token,
        p_waba_id: wabaId,
        p_business_id: businessId || null,
      }),
    });
    const saved = await save.json().catch(() => ({}));
    if (!save.ok || saved?.ok !== true) {
      return json({
        ok: false,
        error: saved?.error || `No se pudo guardar la conexión (HTTP ${save.status})`,
      }, 400, origin);
    }

    return json({ ok: true, telefono, nombre }, 200, origin);
  } catch (e) {
    return json({ ok: false, error: (e as Error)?.message || 'Error inesperado' }, 500, origin);
  }
});
