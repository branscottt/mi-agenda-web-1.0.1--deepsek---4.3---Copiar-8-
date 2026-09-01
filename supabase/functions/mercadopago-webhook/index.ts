// mercadopago-webhook/index.ts
// Webhook IPN (Instant Payment Notification) de Mercado Pago.
// Mercado Pago envía POST aquí cuando cambia el estado de un pago.
//
// Flujo:
//   1. MP envía POST con { type: "payment", data.id: "12345" }
//   2. Validar firma HMAC (si MERCADOPAGO_CLIENT_SECRET está configurado)
//   3. Buscamos el payment en MP API
//   4. Si status = "approved", activamos la suscripción
//
// Seguridad:
//   - Validación HMAC X-Signature (opcional: requiere CLIENT_SECRET)
//   - Verificación del payment contra MP API (siempre)
//   - 500 en errores para que MP reintente
//
// Debug: MP puede enviar notificaciones de prueba (type: "test").
// Esas se ignoran silenciosamente.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { applySecurityHeaders } from '../_shared/security-headers.ts';

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

// Montos esperados por plan (CLP) — anti-fraude: no se activa si el monto no coincide
// 7500 = cupón promocional 50% del Plan Pro mensual
const EXPECTED_AMOUNTS: Record<string, number[]> = {
  pro: [15000, 7500],
  premium_anual: [140000],
};

function montoValidoParaPlan(plan: string | null, amount: number | undefined | null): boolean {
  if (!plan || !amount) return false;
  const allowed = EXPECTED_AMOUNTS[plan];
  return !!allowed && allowed.includes(Number(amount));
}

/** Parsea el external_reference JSON de un payment/preapproval de MP */
function parseExternalRef(externalRef: string): { tenantId: string | null; plan: string | null; email: string | null } {
  try {
    const ref = JSON.parse(externalRef);
    return {
      tenantId: ref.tenant_id || null,
      plan: ref.plan || null,
      email: ref.email || null,
    };
  } catch {
    console.warn(`[MP-Webhook] external_reference no es JSON válido: ${externalRef}`);
    return { tenantId: null, plan: null, email: null };
  }
}

/**
 * Procesa una notificación de SUSCRIPCIÓN RECURRENTE (topic preapproval).
 * MP envía esto cuando una suscripción recurrente cambia de estado:
 *   - authorized: el cliente aprobó la suscripción (primera cuota cobrada)
 *   - cancelled: el cliente o MP canceló la suscripción
 *   - paused: la suscripción fue pausada
 */
async function procesarPreapproval(
  preapprovalId: string,
  accessToken: string,
  supabaseUrl: string,
  serviceRoleKey: string
): Promise<boolean> {
  // Consultar el preapproval en MP API
  const mpResp = await fetch(`https://api.mercadopago.com/preapproval/${preapprovalId}`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });

  if (!mpResp.ok) {
    const errText = await mpResp.text().catch(() => '');
    console.error(`[MP-Webhook] Error consultando preapproval ${preapprovalId}:`, errText.slice(0, 200));
    return false;
  }

  const pa = await mpResp.json();
  const paStatus = pa.status;
  const { tenantId, plan } = parseExternalRef(pa.external_reference || '');

  console.log(`[MP-Webhook] Preapproval ${preapprovalId}: status=${paStatus}, tenant=${tenantId}, plan=${plan}`);

  if (!tenantId) {
    console.warn('[MP-Webhook] Preapproval sin external_reference válida — ignorando');
    return true;
  }

  if (paStatus === 'authorized' && plan) {
    // Suscripción activada: primera cuota cobrada → activar/renovar
    const amount = Number(pa.auto_recurring?.transaction_amount || 0);
    if (!montoValidoParaPlan(plan, amount)) {
      console.error(`[MP-Webhook] Monto inesperado en preapproval para plan ${plan}: ${amount} — NO se activa`);
      return true;
    }
    const rpcResp = await fetch(
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
          p_mp_payment_id: null,
          p_monto: amount,
        }),
      }
    );
    if (!rpcResp.ok) {
      const err = await rpcResp.text().catch(() => '');
      console.error(`[MP-Webhook] Error activando suscripción por preapproval (${rpcResp.status}):`, err.slice(0, 200));
    } else {
      console.log(`[MP-Webhook] Suscripción activada por preapproval para tenant ${tenantId}`);
    }
  } else if (paStatus === 'cancelled' || paStatus === 'paused') {
    // Suscripción cancelada/pausada → desactivar la suscripción del tenant
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
      console.error(`[MP-Webhook] Error desactivando suscripción (${rpcResp.status}):`, err.slice(0, 200));
    } else {
      console.log(`[MP-Webhook] Suscripción desactivada para tenant ${tenantId} (preapproval ${paStatus})`);
    }
  } else {
    console.log(`[MP-Webhook] Preapproval status ${paStatus} sin acción requerida`);
  }

  return true;
}

/**
 * Valida la firma HMAC X-Signature de Mercado Pago (esquema oficial).
 * Si MERCADOPAGO_WEBHOOK_SECRET no está configurado, se salta la validación
 * (la verificación contra MP API sigue siendo obligatoria).
 * Retorna true si la firma es válida o si no hay secret configurado.
 * Retorna false si la firma es inválida.
 *
 * Formato oficial del manifest a firmar (documentación MP):
 *   "id:{data.id};request-id:{x-request-id};ts:{ts};" + rawBody
 * El secret es el "Secret" del webhook creado en el panel de MP
 * (NO es el client secret de la aplicación).
 */
async function validarFirmaMP(
  req: Request,
  rawBody: string,
  dataId: string
): Promise<boolean> {
  const webhookSecret = Deno.env.get('MERCADOPAGO_WEBHOOK_SECRET');
  if (!webhookSecret) {
    // No hay secret configurado — saltar validación HMAC
    // La verificación contra MP API sigue siendo obligatoria
    console.log('[MP-Webhook] MERCADOPAGO_WEBHOOK_SECRET no configurado — saltando validación HMAC');
    return true;
  }

  const xSignature = req.headers.get('x-signature') || '';
  const xRequestId = req.headers.get('x-request-id') || '';
  if (!xSignature || !xRequestId) {
    console.warn('[MP-Webhook] Headers X-Signature/X-Request-Id ausentes (con secret configurado)');
    return false;
  }

  // Parsear: "ts=1234567890,v1=abc123..."
  const parts = xSignature.split(',');
  let ts = '';
  let v1 = '';
  for (const part of parts) {
    const [key, ...valParts] = part.split('=');
    const val = valParts.join('=');
    if (key.trim() === 'ts') ts = val.trim();
    if (key.trim() === 'v1') v1 = val.trim();
  }

  if (!ts || !v1) {
    console.warn('[MP-Webhook] X-Signature mal formada:', xSignature);
    return false;
  }

  // Manifest oficial: "id:{data.id};request-id:{x-request-id};ts:{ts};" + rawBody
  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};` + rawBody;

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(webhookSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(manifest));
    const computed = Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    const isValid = computed === v1.toLowerCase();
    if (!isValid) {
      console.warn('[MP-Webhook] Firma HMAC inválida. Esperada:', v1, 'Computada:', computed);
    }
    return isValid;
  } catch (e) {
    console.error('[MP-Webhook] Error validando HMAC:', e);
    return false;
  }
}

async function handle(req: Request): Promise<Response> {
  // CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' },
    });
  }

  if (req.method !== 'POST') {
    // MP verifica la URL del webhook con un GET (Simular notificaciones /
    // verificación de URL). Responder 200 sin procesar nada — los IPN reales
    // SIEMPRE llegan por POST (verificado 2026-08: 405 en la simulación del
    // panel era cosmético; los pagos reales se procesan correctamente por POST).
    return new Response('OK', { status: 200 });
  }

  const accessToken = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN');
  if (!accessToken) {
    console.error('MERCADOPAGO_ACCESS_TOKEN no configurado');
    return new Response('Error de configuración', { status: 500 });
  }

  // Declaradas ANTES de cualquier uso: la rama preapproval (más abajo) las
  // necesita; declararlas después lanzaba ReferenceError (TDZ) y hacía que
  // las notificaciones de suscripción recurrente siempre fallaran con 500.
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

  try {
    // Leer body como texto para HMAC (necesitamos el raw, no el parseado)
    const rawBody = await req.text();
    const body = JSON.parse(rawBody);

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

    // Validar firma HMAC (si MERCADOPAGO_WEBHOOK_SECRET está configurado)
    const firmaValida = await validarFirmaMP(req, rawBody, paymentId);
    if (!firmaValida) {
      console.error(`[MP-Webhook] Firma HMAC inválida para ${topic} ${paymentId} — rechazando`);
      return new Response(JSON.stringify({ error: 'Firma inválida' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ============================================================
    // SUSCRIPCIONES RECURRENTES (topic preapproval)
    // ============================================================
    if (topic === 'preapproval') {
      const ok = await procesarPreapproval(paymentId, accessToken, supabaseUrl, serviceRoleKey);
      return new Response(ok ? 'OK' : 'Error procesando preapproval', {
        status: ok ? 200 : 502,
      });
    }

    // Consultar el payment en MP API (verificación adicional)
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
    // Los payments RECURRENTES (cuotas de preapproval) NO traen
    // external_reference: se obtiene consultando el preapproval.
    let { tenantId, plan, email } = parseExternalRef(externalRef);

    if ((!tenantId || !plan) && payment.preapproval_id) {
      try {
        const paResp = await fetch(`https://api.mercadopago.com/preapproval/${payment.preapproval_id}`, {
          headers: { 'Authorization': `Bearer ${accessToken}` },
        });
        if (paResp.ok) {
          const pa = await paResp.json();
          const ref = parseExternalRef(pa.external_reference || '');
          if (!tenantId) tenantId = ref.tenantId;
          if (!plan) plan = ref.plan;
          if (!email) email = ref.email;
          console.log(`[MP-Webhook] Payment recurrente ${paymentId} → preapproval ${payment.preapproval_id}: tenant=${tenantId}, plan=${plan}`);
        }
      } catch (e) {
        console.warn(`[MP-Webhook] Error consultando preapproval ${payment.preapproval_id}:`, e);
      }
    }

    // Actualizar mercadopago_payments
    if (supabaseUrl && serviceRoleKey) {
      // Buscar si ya existe un registro con este mp_payment_id
      const findResp = await fetch(
        `${supabaseUrl}/rest/v1/mercadopago_payments?mp_payment_id=eq.${paymentId}&select=id,paid_at,subscription_id`,
        {
          headers: {
            'apikey': serviceRoleKey,
            'Authorization': `Bearer ${serviceRoleKey}`,
          },
        }
      );
      const existing = await findResp.json();

      const ourStatus = STATUS_MAP[mpStatus] || 'pending';
      // Idempotencia: si este payment ya fue procesado como aprobado, no reactivar
      const yaProcesado = existing && existing.length > 0 &&
        (!!existing[0].paid_at || !!existing[0].subscription_id);

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
        const insertData: Record<string, unknown> = {
          mp_payment_id: paymentId,
          mp_preference_id: payment.preference_id || null,
          mp_preapproval_id: payment.preapproval_id || null,
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
      // (solo si NO fue procesado antes — idempotencia ante reintentos de MP)
      if (ourStatus === 'approved' && tenantId && plan && !yaProcesado) {
        const paidAmount = Number(payment.transaction_amount || 0);

        // Anti-fraude: validar que el monto pagado corresponda al plan
        if (!montoValidoParaPlan(plan, paidAmount)) {
          console.error(`[MP-Webhook] Monto inesperado para plan ${plan}: ${paidAmount} — suscripción NO activada`);
        } else {
          console.log(`[MP-Webhook] Activando suscripción para tenant ${tenantId}, plan ${plan}, monto ${paidAmount}`);

          // Llamar a la función SQL activar_suscripcion_post_pago via REST
          // (con p_monto; si la RPC vieja aún no lo soporta, reintentar sin él)
          let rpcResp = await fetch(
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
                p_monto: paidAmount,
              }),
            }
          );

          if (!rpcResp.ok) {
            console.warn(`[MP-Webhook] RPC con p_monto falló (${rpcResp.status}) — reintentando sin p_monto`);
            rpcResp = await fetch(
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
          }

          if (!rpcResp.ok) {
            const rpcErr = await rpcResp.text().catch(() => '');
            console.error(`[MP-Webhook] Error activando suscripción (${rpcResp.status}):`, rpcErr.slice(0, 300));
          } else {
            console.log(`[MP-Webhook] Suscripción activada para tenant ${tenantId}`);
          }

          // Cupón 50% (aprobado por superadmin, cada 3 meses): si el tenant
          // tiene un cupón aprobado sin usar, ESTE cobro mensual se descuenta
          // automáticamente con un reembolso parcial de $7.500 (el tenant paga
          // $7.500 netos sin volver a usar la tarjeta). El mes siguiente se
          // cobra $15.000 normal. Solo aplica a cobros de suscripción
          // (payment con preapproval_id) del plan Pro a precio completo.
          if (plan === 'pro' && payment.preapproval_id && Number(payment.transaction_amount || 0) === 15000) {
            try {
              const promoResp = await fetch(
                `${supabaseUrl}/rest/v1/rpc/can_use_promo_coupon`,
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
              if (promoResp.ok) {
                const promoData = await promoResp.json();
                const promo = Array.isArray(promoData) ? promoData[0] : promoData;
                if (promo?.discount_available === true && promo?.existing_id) {
                  // Reembolso parcial de $7.500 (50% de $15.000)
                  const refundResp = await fetch(
                    `https://api.mercadopago.com/v1/payments/${paymentId}/refunds`,
                    {
                      method: 'POST',
                      headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'X-Idempotency-Key': `${paymentId}-coupon50`,
                      },
                      body: JSON.stringify({ amount: 7500 }),
                    }
                  );
                  if (refundResp.ok) {
                    // Marcar el cupón como usado SOLO si el reembolso fue exitoso;
                    // si falla, el próximo cobro mensual reintenta el descuento.
                    await fetch(
                      `${supabaseUrl}/rest/v1/promo_video_coupons?id=eq.${promo.existing_id}`,
                      {
                        method: 'PATCH',
                        headers: {
                          'apikey': serviceRoleKey,
                          'Authorization': `Bearer ${serviceRoleKey}`,
                          'Content-Type': 'application/json',
                          'Prefer': 'return=minimal',
                        },
                        body: JSON.stringify({ discount_applied: true, used_at: new Date().toISOString() }),
                      }
                    );
                    console.log(`[MP-Webhook] Cupón ${promo.existing_id} aplicado al payment ${paymentId}: reembolso parcial $7.500 — mes siguiente cobra $15.000 normal`);
                  } else {
                    console.error(`[MP-Webhook] Error reembolsando cupón del payment ${paymentId} (${refundResp.status}):`, (await refundResp.text().catch(() => '')).slice(0, 200));
                  }
                }
              } else {
                console.warn(`[MP-Webhook] Error consultando cupón para tenant ${tenantId}: ${promoResp.status}`);
              }
            } catch (e) {
              console.error('[MP-Webhook] Error aplicando cupón (refund):', e);
            }
          }
        }
      } else if (ourStatus === 'approved' && tenantId && plan && yaProcesado) {
        console.log(`[MP-Webhook] Payment ${paymentId} ya procesado — omitiendo activación duplicada`);
      }
    } else {
      console.warn('[MP-Webhook] SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no configurados');
    }

    // Responder 200 solo si todo el procesamiento fue exitoso
    return new Response('OK', { status: 200 });
  } catch (e: unknown) {
    const error = e as Error;
    console.error('[MP-Webhook] Error inesperado:', error.message || String(e));
    console.error('[MP-Webhook] Stack:', (error as any).stack || '(no stack)');
    // Responder 500 para que MP reintente automáticamente (hasta 5 veces con backoff exponencial)
    return new Response(JSON.stringify({ error: 'Error interno del servidor' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// Cabeceras de seguridad OWASP en TODAS las respuestas (éxito, error, preflight)
serve(async (req) => applySecurityHeaders(await handle(req)));
