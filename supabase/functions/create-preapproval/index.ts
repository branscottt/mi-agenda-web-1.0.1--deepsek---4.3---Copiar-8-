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
import { applySecurityHeaders } from '../_shared/security-headers.ts';

const MERCADOPAGO_API = 'https://api.mercadopago.com/preapproval';

// Precios y frecuencia según plan (CLP)
// NOTA: MP solo acepta frequency_type 'days' o 'months' — el plan anual se
// modela como 1 cobro cada 12 meses (frequency: 12, frequency_type: 'months').
// 'years' devuelve 400 "Invalid value for frequency type" y rompía el plan anual.
const PLANS: Record<string, { title: string; amount: number; frequency: number; frequency_type: string }> = {
  pro: { title: 'Plan Pro', amount: 15000, frequency: 1, frequency_type: 'months' },
  premium_anual: { title: 'Plan Premium Anual', amount: 140000, frequency: 12, frequency_type: 'months' },
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

function validateJwt(req: Request): { userId: string | null; userTenantId: string | null; email: string | null; rol: string | null } {
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return { userId: null, userTenantId: null, email: null, rol: null };
  }

  const token = authHeader.slice(7).trim();
  const jwt = decodeJwtPayload(token);
  if (!jwt) {
    return { userId: null, userTenantId: null, email: null, rol: null };
  }

  const tenantId = jwt.user_metadata?.tenant_id || null;
  const rol = jwt.user_metadata?.rol || null;
  return {
    userId: jwt.sub || null,
    userTenantId: tenantId,
    email: jwt.email || null,
    rol,
  };
}

async function handle(req: Request): Promise<Response> {
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

    // Si el usuario no tiene tenant asignado y no es super_admin, no puede
    // crear suscripciones para ningún tenant.
    if (!jwtInfo.userTenantId && jwtInfo.rol !== 'super_admin') {
      console.warn(`[create-preapproval] Usuario ${jwtInfo.userId} sin tenant intentó crear suscripción para tenant ${tenant_id}`);
      return new Response(JSON.stringify({ error: 'No autorizado: tu cuenta no tiene tenant asignado' }), {
        status: 403,
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
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Nota: el cupón 50% NO afecta la creación de la suscripción. El precio
    // SIEMPRE es el normal ($15.000/mes o $140.000/año). Cuando el superadmin
    // aprueba el cupón (cada 3 meses), el webhook reembolsa automáticamente
    // $7.500 de UN cobro mensual (refund parcial) y el mes siguiente sigue
    // cobrando el precio normal.
    const amount = planInfo.amount;
    const reason = `${planInfo.title} - Organify`;

    const accessToken = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN');
    if (!accessToken) {
      console.error('MERCADOPAGO_ACCESS_TOKEN no configurado');
      return new Response(JSON.stringify({ error: 'Error de configuración del servidor' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // URLs de retorno — baseUrl desde fuentes confiables (env o ALLOWED_ORIGINS),
    // NUNCA del Origin de la request (anti-phishing post-pago).
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || 'https://dfcfimipkfhitlsyixqu.supabase.co';
    const baseUrl = (Deno.env.get('AGENDA_BASE_URL') || allowedOrigins[0] || supabaseUrl).replace(/\/$/, '');

    // Crear preapproval (suscripción recurrente) en Mercado Pago
    const preapprovalBody = {
      reason,
      auto_recurring: {
        frequency: planInfo.frequency,
        frequency_type: planInfo.frequency_type,
        transaction_amount: amount,
        currency_id: 'CLP',
      },
      payer_email: email,
      back_url: `${baseUrl}/planes.html?status=success`,
      external_reference: JSON.stringify({ tenant_id, plan, email }),
      notification_url: `${supabaseUrl}/functions/v1/mercadopago-webhook`,
    };

    console.log('Creando preapproval MP:', JSON.stringify({ reason: preapprovalBody.reason, amount: planInfo.amount }));

    const mpHeaders: Record<string, string> = {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
    const integratorId = Deno.env.get('MERCADOPAGO_INTEGRATOR_ID');
    if (integratorId) mpHeaders['X-Integrator-Id'] = integratorId;

    const mpResp = await fetch(MERCADOPAGO_API, {
      method: 'POST',
      headers: mpHeaders,
      body: JSON.stringify(preapprovalBody),
    });

    const mpData = await mpResp.json();

    if (!mpResp.ok) {
      console.error('Error MP (preapproval):', JSON.stringify(mpData));
      // Mensaje claro para el caso verificado: email ya registrado en otro site de MP
      // (test users / cuentas demo como algo@mail.com o algo@test.com)
      let errorMsg = 'Error al procesar la suscripción. Intenta de nuevo más tarde.';
      if (mpData?.code === 'guest_site_mismatch') {
        errorMsg = 'Este email ya está asociado a otra cuenta de Mercado Pago. Inicia sesión con el email principal de tu negocio para pagar.';
      }
      return new Response(JSON.stringify({ error: errorMsg }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
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
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}

// Cabeceras de seguridad OWASP en TODAS las respuestas (éxito, error, preflight)
serve(async (req) => applySecurityHeaders(await handle(req)));
