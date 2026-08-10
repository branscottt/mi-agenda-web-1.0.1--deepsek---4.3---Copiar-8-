// create-preapproval/index.ts
// Edge Function que crea una SUSCRIPCIÓN RECURRENTE en Mercado Pago (preapproval)
// y devuelve el init_point para redirigir al checkout de suscripción.
//
// Uso: POST /functions/v1/create-preapproval
// Body: { tenant_id, plan, email, nombre }
// Response: { preapproval_id, init_point }
//
// Variables de entorno requeridas:
//   MERCADOPAGO_ACCESS_TOKEN — Access token de MP (modo prueba o producción)
//
// Flujo:
//   1. El usuario elige un plan pagado sin cupón → se crea el preapproval
//   2. MP redirige al checkout de suscripción (primera cuota inmediata)
//   3. MP cobra automáticamente cada mes/año según frequency
//   4. Los cobros llegan al webhook (payment con preapproval_id) → se renueva la suscripción

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

const MERCADOPAGO_API = 'https://api.mercadopago.com/preapproval';

// Precios y frecuencia según plan (CLP)
const PLANS: Record<string, { title: string; amount: number; frequency: number; frequency_type: string }> = {
  pro: { title: 'Plan Pro', amount: 15000, frequency: 1, frequency_type: 'months' },
  premium_anual: { title: 'Plan Premium Anual', amount: 140000, frequency: 1, frequency_type: 'years' },
};

interface PreapprovalRequest {
  tenant_id: string;
  plan: string;
  email: string;
  nombre: string;
}

interface JwtPayload {
  sub?: string;
  email?: string;
  user_metadata?: {
    tenant_id?: string;
    rol?: string;
  };
}

/**
 * Decodifica el payload de un JWT (parte 2, base64url) sin verificar la firma.
 * La firma YA fue verificada por la plataforma Supabase (verify_jwt = true).
 */
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
  } catch (e) {
    console.error('[create-preapproval] Error decodificando JWT:', e);
    return null;
  }
}

function validateJwt(req: Request): { userId: string | null; userTenantId: string | null; email: string | null } {
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return { userId: null, userTenantId: null, email: null };
  }

  const token = authHeader.slice(7).trim();
  const jwt = decodeJwtPayload(token);
  if (!jwt) {
    return { userId: null, userTenantId: null, email: null };
  }

  const tenantId = jwt.user_metadata?.tenant_id || null;
  return {
    userId: jwt.sub || null,
    userTenantId: tenantId,
    email: jwt.email || null,
  };
}

serve(async (req) => {
  // CORS — permitir solo orígenes configurados
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
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body: PreapprovalRequest = await req.json();
    const { tenant_id, plan, email, nombre } = body;

    // Validación JWT: el usuario autenticado debe ser dueño del tenant
    const jwtInfo = validateJwt(req);
    if (!jwtInfo.userId) {
      return new Response(JSON.stringify({ error: 'Autenticación requerida' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    if (jwtInfo.userTenantId && jwtInfo.userTenantId !== tenant_id) {
      console.warn(`[create-preapproval] Usuario ${jwtInfo.userId} intentó crear suscripción para tenant ${tenant_id} (su tenant: ${jwtInfo.userTenantId})`);
      return new Response(JSON.stringify({ error: 'No autorizado para este tenant' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Validar plan
    const planInfo = PLANS[plan];
    if (!planInfo) {
      return new Response(JSON.stringify({ error: 'Plan inválido' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    if (!tenant_id || !email) {
      return new Response(JSON.stringify({ error: 'tenant_id y email son requeridos' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const accessToken = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN');
    if (!accessToken) {
      console.error('MERCADOPAGO_ACCESS_TOKEN no configurado');
      return new Response(JSON.stringify({ error: 'Error de configuración del servidor' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // URLs de retorno
    const origin = req.headers.get('origin') || '';
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || 'https://dfcfimipkfhitlsyixqu.supabase.co';
    const baseUrl = origin || supabaseUrl.replace(/\/$/, '');

    // Crear preapproval (suscripción recurrente) en Mercado Pago
    const preapprovalBody = {
      reason: `${planInfo.title} - Agenda Pro`,
      auto_recurring: {
        frequency: planInfo.frequency,
        frequency_type: planInfo.frequency_type,
        transaction_amount: planInfo.amount,
        currency_id: 'CLP',
      },
      payer_email: email,
      back_url: `${baseUrl}/planes.html?status=success`,
      external_reference: JSON.stringify({ tenant_id, plan, email }),
      notification_url: `${supabaseUrl}/functions/v1/mercadopago-webhook`,
    };

    console.log('Creando preapproval MP:', JSON.stringify({ reason: preapprovalBody.reason, amount: planInfo.amount }));

    const mpResp = await fetch(MERCADOPAGO_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Integrator-Id': 'dev_24c2ac8c0c86410e9718b2b12a9c9b77',
      },
      body: JSON.stringify(preapprovalBody),
    });

    const mpData = await mpResp.json();

    if (!mpResp.ok) {
      console.error('Error MP (preapproval):', JSON.stringify(mpData));
      return new Response(JSON.stringify({
        error: 'Error al procesar la suscripción. Intenta de nuevo más tarde.',
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    console.log('Preapproval creado:', mpData.id);

    return new Response(JSON.stringify({
      preapproval_id: mpData.id,
      init_point: mpData.init_point,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders,
      },
    });
  } catch (e: unknown) {
    const error = e as Error;
    console.error('[create-preapproval] Error inesperado:', error.message || String(e));
    return new Response(JSON.stringify({ error: 'Error interno del servidor' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
