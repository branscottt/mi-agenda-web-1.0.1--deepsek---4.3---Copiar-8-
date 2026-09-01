// cancelar-suscripcion/index.ts
// Edge Function que CANCELA una suscripción recurrente de Mercado Pago
// (preapproval) y desactiva la suscripción en la base de datos.
//
// Uso: POST /functions/v1/cancelar-suscripcion
// Body: { tenant_id?: string } — opcional; el dueño del tenant NO puede
//       pasar tenant_id (siempre usa el suyo). El super_admin SÍ puede
//       pasar tenant_id para cancelar la suscripción de cualquier tenant.
// Response: { ok: boolean, mp_cancelled: boolean, preapproval_id: string|null }
//
// Flujo:
//   1. Valida JWT (verify_jwt=true) y permisos (dueño del tenant o super_admin)
//   2. Busca el mp_preapproval_id más reciente del tenant en mercadopago_payments
//   3. Si existe → PUT https://api.mercadopago.com/preapproval/{id} { status: 'cancelled' }
//      (esto detiene los cobros automáticos en Mercado Pago)
//   4. Llama a la RPC desactivar_suscripcion(p_tenant_id) para poner la
//      suscripción activa en la base de datos como 'inactive'
//   5. El webhook también recibe el topic preapproval 'cancelled' de MP y
//      desactiva la suscripción (doble seguro, idempotente)
//
// Nota de diseño: el botón "Cancelar Suscripción" de la página DEBE llamar
// a esta función. La alternativa anterior (UPDATE subscriptions SET
// status='inactive') NO detenía los cobros automáticos de MP.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { applySecurityHeaders } from '../_shared/security-headers.ts';

const MERCADOPAGO_API = 'https://api.mercadopago.com/preapproval';

interface CancelRequest {
  tenant_id?: string;
}

interface JwtPayload {
  sub?: string;
  email?: string;
  user_metadata?: {
    tenant_id?: string;
    rol?: string;
  };
}

/** Decodifica el payload de un JWT (parte 2, base64url) sin verificar la firma. */
function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
    );
    return JSON.parse(json) as JwtPayload;
  } catch {
    return null;
  }
}

function validateJwt(req: Request): { userId: string | null; userTenantId: string | null; rol: string | null } {
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return { userId: null, userTenantId: null, rol: null };
  }
  const token = authHeader.slice(7).trim();
  const jwt = decodeJwtPayload(token);
  if (!jwt) return { userId: null, userTenantId: null, rol: null };
  return {
    userId: jwt.sub || null,
    userTenantId: jwt.user_metadata?.tenant_id || null,
    rol: jwt.user_metadata?.rol || null,
  };
}

async function handle(req: Request): Promise<Response> {
  // CORS — mismo patrón que create-preapproval
  const requestOrigin = req.headers.get('origin') || '';
  const allowedOriginsEnv = Deno.env.get('ALLOWED_ORIGINS') || '';
  const allowedOrigins = allowedOriginsEnv
    ? allowedOriginsEnv.split(',').map(o => o.trim())
    : [];
  const corsOrigin = allowedOrigins.length > 0 && allowedOrigins.includes(requestOrigin)
    ? requestOrigin
    : allowedOrigins.length > 0 ? allowedOrigins[0] : requestOrigin || '*';
  const corsHeaders = { 'Access-Control-Allow-Origin': corsOrigin };

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
    return new Response(JSON.stringify({ error: 'Método no permitido' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  try {
    const jwtInfo = validateJwt(req);
    if (!jwtInfo.userId) {
      return new Response(JSON.stringify({ error: 'Autenticación requerida' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const body: CancelRequest = await req.json().catch(() => ({}));
    const isSuperAdmin = jwtInfo.rol === 'super_admin';

    // El tenant a cancelar: el del JWT, o el indicado si es super_admin.
    // El dueño puede mandar su propio tenant_id en el body (lo hace el
    // frontend); solo se rechaza si intenta cancelar un tenant AJENO.
    let tenantId = jwtInfo.userTenantId;
    if (body.tenant_id) {
      if (isSuperAdmin) {
        tenantId = body.tenant_id;
      } else if (body.tenant_id === jwtInfo.userTenantId) {
        tenantId = body.tenant_id;
      } else {
        console.warn(`[cancelar-suscripcion] Usuario ${jwtInfo.userId} intentó cancelar tenant ajeno ${body.tenant_id}`);
        return new Response(JSON.stringify({ error: 'No autorizado para este tenant' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    if (!tenantId) {
      return new Response(JSON.stringify({ error: 'No se pudo determinar el tenant' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const accessToken = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN');
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    if (!accessToken || !supabaseUrl || !serviceRoleKey) {
      console.error('[cancelar-suscripcion] Configuración incompleta del servidor');
      return new Response(JSON.stringify({ error: 'Error de configuración del servidor' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // 1) Buscar el preapproval más reciente del tenant
    const searchResp = await fetch(
      `${supabaseUrl}/rest/v1/mercadopago_payments?tenant_id=eq.${tenantId}&mp_preapproval_id=not.is.null&select=mp_preapproval_id&order=created_at.desc&limit=1`,
      {
        headers: {
          'apikey': serviceRoleKey,
          'Authorization': `Bearer ${serviceRoleKey}`,
        },
      }
    );
    const rows = searchResp.ok ? await searchResp.json() : [];
    const preapprovalId = rows && rows.length > 0 ? rows[0].mp_preapproval_id : null;

    let mpCancelled = false;

    // 2) Cancelar el preapproval en Mercado Pago (detiene los cobros automáticos)
    if (preapprovalId) {
      const mpResp = await fetch(`${MERCADOPAGO_API}/${preapprovalId}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'cancelled' }),
      });

      if (mpResp.ok) {
        mpCancelled = true;
        console.log(`[cancelar-suscripcion] Preapproval ${preapprovalId} cancelado en MP para tenant ${tenantId}`);
      } else {
        const errText = await mpResp.text().catch(() => '');
        console.error(`[cancelar-suscripcion] Error cancelando preapproval ${preapprovalId} (${mpResp.status}):`, errText.slice(0, 300));
        // Si MP ya lo tenía cancelado (400 con status cancelled), no es un error real.
        // Se intenta igual desactivar en DB y se reporta mp_cancelled=false para
        // que el frontend pueda mostrar un mensaje adecuado.
      }
    } else {
      console.log(`[cancelar-suscripcion] Tenant ${tenantId} sin preapproval registrado — solo se desactiva en DB`);
    }

    // 3) Desactivar la suscripción en la base de datos (idempotente)
    const rpcResp = await fetch(
      `${supabaseUrl}/rest/v1/rpc/desactivar_suscripcion`,
      {
        method: 'POST',
        headers: {
          'apikey': serviceRoleKey,
          'Authorization': `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_tenant_id: tenantId }),
      }
    );
    if (!rpcResp.ok) {
      const err = await rpcResp.text().catch(() => '');
      console.error(`[cancelar-suscripcion] Error desactivando suscripción en DB (${rpcResp.status}):`, err.slice(0, 200));
    }

    return new Response(JSON.stringify({
      ok: true,
      mp_cancelled: mpCancelled,
      preapproval_id: preapprovalId,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (e: unknown) {
    const error = e as Error;
    console.error('[cancelar-suscripcion] Error inesperado:', error.message || String(error));
    return new Response(JSON.stringify({ error: 'Error interno del servidor' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}

serve(async (req) => applySecurityHeaders(await handle(req)));
