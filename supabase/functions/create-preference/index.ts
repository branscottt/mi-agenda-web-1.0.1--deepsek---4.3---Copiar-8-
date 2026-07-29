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

const MERCADOPAGO_API = 'https://api.mercadopago.com/checkout/preferences';

// Precios según plan
const PRICES: Record<string, { title: string; price: number }> = {
  pro: { title: 'Plan Pro', price: 15000 },
  premium_anual: { title: 'Plan Premium Anual', price: 140000 },
};

interface PrefRequest {
  tenant_id: string;
  plan: string;
  email: string;
  nombre: string;
  monto?: number; // Opcional: si se pasa, sobreescribe el precio del plan
}

serve(async (req) => {
  // CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
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

    // Validar plan
    const planInfo = PRICES[plan];
    if (!planInfo) {
      return new Response(JSON.stringify({ error: 'Plan inválido' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Usar monto personalizado si se proporcionó (ej: descuento 50%)
    const unitPrice = monto !== undefined ? monto : planInfo.price;
    const titleSuffix = monto !== undefined && monto < planInfo.price ? ' (50% desc.)' : '';

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

    // Construir URLs de retorno
    const origin = req.headers.get('origin') || '';
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || 'https://dfcfimipkfhitlsyixqu.supabase.co';
    const baseUrl = origin || supabaseUrl.replace(/\/$/, '');

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

    console.log('Creando preferencia MP:', JSON.stringify(prefBody));

    const mpResp = await fetch(MERCADOPAGO_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Integrator-Id': 'dev_24c2ac8c0c86410e9718b2b12a9c9b77',
      },
      body: JSON.stringify(prefBody),
    });

    const mpData = await mpResp.json();

    if (!mpResp.ok) {
      console.error('Error MP:', JSON.stringify(mpData));
      return new Response(JSON.stringify({
        error: 'Error al crear preferencia de pago',
        detail: mpData.message || mpData.error || 'Error desconocido',
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
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
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    console.error('Error inesperado:', e.message);
    return new Response(JSON.stringify({ error: 'Error interno del servidor' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
