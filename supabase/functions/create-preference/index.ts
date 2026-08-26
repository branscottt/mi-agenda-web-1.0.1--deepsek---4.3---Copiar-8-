// create-preference/index.ts
// Edge Function que crea una preferencia de pago en Mercado Pago
// y devuelve el init_point para redirigir al checkout.
//
// Uso: POST /functions/v1/create-preference
// Body: { tenant_id, plan, email, nombre }
// Response: { preference_id, init_point }
//
// Variables de entorno requeridas:
//   MERCADOPAGO_ACCESS_TOKEN — Access token de MP (se setea con `supabase secrets set`)

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { applySecurityHeaders } from '../_shared/security-headers.ts';

const MERCADOPAGO_API = 'https://api.mercadopago.com/checkout/preferences';

// Precios según plan
const PRICES: Record<string, { title: string; price: number }> = {
  pro: { title: 'Plan Pro', price: 15000 },
  premium_anual: { title: 'Plan Premium Anual', price: 140000 },
};

// Montos permitidos por plan (CLP) — protege contra montos arbitrarios
// 7500 = cupón promocional 50% del Plan Pro mensual
const ALLOWED_AMOUNTS: Record<string, number[]> = {
  pro: [15000, 7500],
  premium_anual: [140000],
};

interface PrefRequest {
  tenant_id: string;
  plan: string;
  email: string;
  nombre: string;
  monto?: number;
}

interface JwtPayload {
  sub?: string;
  email?: string;
  user_metadata?: {
    tenant_id?: string;
    rol?: string;
  };
  role?: string;
  aud?: string;
}

/**
 * Decodifica el payload de un JWT (parte 2, base64url) sin verificar la firma.
 * La firma YA fue verificada por la plataforma Supabase (verify_jwt = true),
 * por lo que aquí solo necesitamos LEER los claims (sub, email, user_metadata).
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
    console.error('[create-preference] Error decodificando JWT:', e);
    return null;
  }
}

/**
 * Valida el JWT y extrae el tenant_id del usuario autenticado.
 * Supabase verifica el JWT automáticamente cuando verify_jwt = true,
 * pero hacemos validación adicional por seguridad.
 */
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
  const rol = jwt.user_metadata?.rol || jwt.role || null;
  return {
    userId: jwt.sub || null,
    userTenantId: tenantId,
    email: jwt.email || null,
    rol,
  };
}

async function handle(req: Request): Promise<Response> {
  // CORS — permitir solo orígenes configurados o el mismo de la solicitud
  const requestOrigin = req.headers.get('origin') || '';
  const allowedOriginsEnv = Deno.env.get('ALLOWED_ORIGINS') || '';
  const allowedOrigins = allowedOriginsEnv
    ? allowedOriginsEnv.split(',').map(o => o.trim())
    : [];
  const corsOrigin = allowedOrigins.length > 0 && allowedOrigins.includes(requestOrigin)
    ? requestOrigin
    : allowedOrigins.length > 0 ? allowedOrigins[0] : requestOrigin || '*';

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
    const body: PrefRequest = await req.json();
    const { tenant_id, plan, email, nombre, monto } = body;

    // ============================================================
    // VALIDACIÓN JWT: el usuario autenticado debe ser dueño del tenant
    // o ser super_admin. Mitiga el riesgo de que un atacante cree
    // preferencias de pago para tenants que no le pertenecen.
    // ============================================================
    const jwtInfo = validateJwt(req);
    if (!jwtInfo.userId) {
      return new Response(JSON.stringify({ error: 'Autenticación requerida' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
      });
    }

    // Si el usuario no tiene tenant asignado y no es super_admin, no puede
    // crear preferencias para ningún tenant (cierra el bypass cuando
    // user_metadata.tenant_id es null).
    if (!jwtInfo.userTenantId && jwtInfo.rol !== 'super_admin') {
      console.warn(`[create-preference] Usuario ${jwtInfo.userId} sin tenant intentó crear preferencia para tenant ${tenant_id}`);
      return new Response(JSON.stringify({ error: 'No autorizado: tu cuenta no tiene tenant asignado' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
      });
    }

    // Si el usuario tiene un tenant_id en su JWT, debe coincidir
    if (jwtInfo.userTenantId && jwtInfo.userTenantId !== tenant_id) {
      console.warn(`[create-preference] Usuario ${jwtInfo.userId} intentó crear preferencia para tenant ${tenant_id} (su tenant: ${jwtInfo.userTenantId})`);
      return new Response(JSON.stringify({ error: 'No autorizado para este tenant' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
      });
    }

    // Validar plan
    const planInfo = PRICES[plan];
    if (!planInfo) {
      return new Response(JSON.stringify({ error: 'Plan inválido' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Usar monto personalizado si se proporcionó (ej: descuento 50%)
    // SOLO se aceptan montos exactos permitidos para el plan (anti-fraude)
    let unitPrice = planInfo.price;
    let titleSuffix = '';
    if (monto !== undefined) {
      if (!Number.isFinite(monto) || !ALLOWED_AMOUNTS[plan].includes(monto)) {
        console.warn(`[create-preference] Monto inválido para plan ${plan}: ${monto}`);
        return new Response(JSON.stringify({ error: 'Monto inválido para este plan' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
        });
      }
      unitPrice = monto;
      titleSuffix = monto < planInfo.price ? ' (50% desc.)' : '';
    }

    if (!tenant_id || !email) {
      return new Response(JSON.stringify({ error: 'tenant_id y email son requeridos' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
      });
    }

    const accessToken = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN');
    if (!accessToken) {
      console.error('MERCADOPAGO_ACCESS_TOKEN no configurado');
      return new Response(JSON.stringify({ error: 'Error de configuración del servidor' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
      });
    }

    // Construir URLs de retorno
    // baseUrl SIEMPRE desde fuentes confiables (env AGENDA_BASE_URL o primer
    // origen de ALLOWED_ORIGINS), NUNCA del Origin de la request:
    // evita que back_urls redirija al comprador a sitios de phishing tras pagar.
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || 'https://dfcfimipkfhitlsyixqu.supabase.co';
    const baseUrl = (Deno.env.get('AGENDA_BASE_URL') || allowedOrigins[0] || supabaseUrl).replace(/\/$/, '');

    // Crear preferencia en Mercado Pago
    const prefBody = {
      items: [
        {
          id: `plan_${plan}`,
          title: `${planInfo.title}${titleSuffix} - Agenda Pro`,
          description: `Suscripción ${plan === 'premium_anual' ? 'anual' : 'mensual'} a Agenda Pro${monto !== undefined ? ' (con descuento)' : ''}`,
          quantity: 1,
          currency_id: 'CLP',
          unit_price: unitPrice,
        },
      ],
      payer: {
        email,
        name: nombre || email,
      },
      back_urls: {
        success: `${baseUrl}/planes.html?status=success`,
        failure: `${baseUrl}/planes.html?status=failure`,
        pending: `${baseUrl}/planes.html?status=pending`,
      },
      auto_return: 'approved',
      notification_url: `${supabaseUrl}/functions/v1/mercadopago-webhook`,
      external_reference: JSON.stringify({ tenant_id, plan, email }),
      purpose: 'subscription',
    };

    console.log('Creando preferencia MP:', JSON.stringify({ plan, tenant_id, unit_price: unitPrice }));

    const mpHeaders: Record<string, string> = {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
    const integratorId = Deno.env.get('MERCADOPAGO_INTEGRATOR_ID');
    if (integratorId) mpHeaders['X-Integrator-Id'] = integratorId;

    const mpResp = await fetch(MERCADOPAGO_API, {
      method: 'POST',
      headers: mpHeaders,
      body: JSON.stringify(prefBody),
    });

    const mpData = await mpResp.json();

    if (!mpResp.ok) {
      console.error('Error MP:', JSON.stringify(mpData));
      return new Response(JSON.stringify({
        error: 'Error al procesar el pago. Intenta de nuevo más tarde.',
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
      });
    }

    console.log('Preferencia creada:', mpData.id);

    return new Response(JSON.stringify({
      preference_id: mpData.id,
      init_point: mpData.init_point,
      sandbox_init_point: mpData.sandbox_init_point,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': corsOrigin,
      },
    });
  } catch (e) {
    console.error('Error inesperado:', e.message);
    return new Response(JSON.stringify({ error: 'Error interno del servidor' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
    });
  }
}

// Cabeceras de seguridad OWASP en TODAS las respuestas (éxito, error, preflight)
serve(async (req) => applySecurityHeaders(await handle(req)));
