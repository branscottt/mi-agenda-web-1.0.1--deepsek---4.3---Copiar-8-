// mercadopago-webhook/index.ts
// Webhook IPN (Instant Payment Notification) de Mercado Pago.
// Mercado Pago envía POST aquí cuando cambia el estado de un pago.
//
// Flujo:
//   1. MP envía POST con { type: "payment", data.id: "12345" }
//   2. Buscamos el payment en MP API
//   3. Si status = "approved", activamos la suscripción
//
// Debug: MP puede enviar notificaciones de prueba (type: "test").
// Esas se ignoran silenciosamente.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

const MERCADOPAGO_API = 'https://api.mercadopago.com/v1/payments';

// Mapeo de estados de MP a nuestros estados
const STATUS_MAP: Record<string, string> = {
  approved: 'approved',
  rejected: 'rejected',
  cancelled: 'cancelled',
  refunded: 'refunded',
  charged_back: 'refunded',
  in_mediation: 'pending',
  pending: 'pending',
  in_process: 'pending',
};

serve(async (req) => {
  // CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' },
    });
  }

  if (req.method !== 'POST') {
    return new Response('Método no permitido', { status: 405 });
  }

  const accessToken = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN');
  if (!accessToken) {
    console.error('MERCADOPAGO_ACCESS_TOKEN no configurado');
    return new Response('Error de configuración', { status: 500 });
  }

  try {
    const body = await req.json();

    // MP envía { type: "payment", action: "payment.created", data: { id: "123456" } }
    // También puede enviar { id: "12345", topic: "payment" } (formato anterior)
    const paymentId = body.data?.id || body.id;
    const topic = body.type || body.topic || 'unknown';

    console.log(`[MP-Webhook] Recibido: type=${topic}, payment_id=${paymentId}`);

    // Ignorar notificaciones de prueba
    if (topic === 'test' || !paymentId || paymentId === '123456') {
      console.log('[MP-Webhook] Ignorando notificación de prueba');
      return new Response('OK', { status: 200 });
    }

    // Consultar el payment en MP API
    const mpResp = await fetch(`${MERCADOPAGO_API}/${paymentId}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!mpResp.ok) {
      const errText = await mpResp.text();
      console.error(`[MP-Webhook] Error consultando payment ${paymentId}:`, errText);
      return new Response('Error consultando pago', { status: 502 });
    }

    const payment = await mpResp.json();
    const mpStatus = payment.status;
    const mpStatusDetail = payment.status_detail;
    const externalRef = payment.external_reference || '';

    console.log(`[MP-Webhook] Payment ${paymentId}: status=${mpStatus}, detail=${mpStatusDetail}`);

    // Parsear external_reference (JSON: { tenant_id, plan, email })
    let tenantId: string | null = null;
    let plan: string | null = null;
    let email: string | null = null;

    try {
      const ref = JSON.parse(externalRef);
      tenantId = ref.tenant_id || null;
      plan = ref.plan || null;
      email = ref.email || null;
    } catch {
      console.warn(`[MP-Webhook] external_reference no es JSON válido: ${externalRef}`);
    }

    // Actualizar mercadopago_payments
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

    if (supabaseUrl && serviceRoleKey) {
      // Buscar si ya existe un registro con este mp_payment_id
      const findResp = await fetch(
        `${supabaseUrl}/rest/v1/mercadopago_payments?mp_payment_id=eq.${paymentId}&select=id`,
        {
          headers: {
            'apikey': serviceRoleKey,
            'Authorization': `Bearer ${serviceRoleKey}`,
          },
        }
      );
      const existing = await findResp.json();

      const ourStatus = STATUS_MAP[mpStatus] || 'pending';
      const updateData: Record<string, unknown> = {
        mp_status: ourStatus,
        mp_status_detail: mpStatusDetail,
        mp_payer_email: payment.payer?.email || email,
        notified_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      if (ourStatus === 'approved') {
        updateData.paid_at = new Date().toISOString();
      }

      if (existing && existing.length > 0) {
        // Actualizar registro existente
        await fetch(
          `${supabaseUrl}/rest/v1/mercadopago_payments?id=eq.${existing[0].id}`,
          {
            method: 'PATCH',
            headers: {
              'apikey': serviceRoleKey,
              'Authorization': `Bearer ${serviceRoleKey}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal',
            },
            body: JSON.stringify(updateData),
          }
        );
      } else {
        // Crear nuevo registro
        const insertData = {
          mp_payment_id: paymentId,
          mp_preference_id: payment.preference_id || null,
          mp_status: ourStatus,
          mp_status_detail: mpStatusDetail,
          mp_payer_email: payment.payer?.email || email,
          tenant_id: tenantId,
          plan: plan,
          monto: payment.transaction_amount || 0,
          notified_at: new Date().toISOString(),
          ...(ourStatus === 'approved' ? { paid_at: new Date().toISOString() } : {}),
        };
        await fetch(
          `${supabaseUrl}/rest/v1/mercadopago_payments`,
          {
            method: 'POST',
            headers: {
              'apikey': serviceRoleKey,
              'Authorization': `Bearer ${serviceRoleKey}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal',
            },
            body: JSON.stringify(insertData),
          }
        );
      }

      // Si el pago fue aprobado y tenemos tenant_id y plan, activar suscripción
      if (ourStatus === 'approved' && tenantId && plan) {
        console.log(`[MP-Webhook] Activando suscripción para tenant ${tenantId}, plan ${plan}`);

        // Llamar a la función SQL activar_suscripcion_post_pago via REST
        await fetch(
          `${supabaseUrl}/rest/v1/rpc/activar_suscripcion_post_pago`,
          {
            method: 'POST',
            headers: {
              'apikey': serviceRoleKey,
              'Authorization': `Bearer ${serviceRoleKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              p_tenant_id: tenantId,
              p_plan: plan,
              p_mp_payment_id: paymentId,
            }),
          }
        );

        console.log(`[MP-Webhook] Suscripción activada para tenant ${tenantId}`);
      }
    } else {
      console.warn('[MP-Webhook] SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no configurados');
    }

    // Siempre responder 200 a MP para que no reintente
    return new Response('OK', { status: 200 });
  } catch (e) {
    console.error('[MP-Webhook] Error:', e.message);
    // MP reintenta si no responde 200, así que responder 200 incluso en error
    return new Response('OK', { status: 200 });
  }
});
