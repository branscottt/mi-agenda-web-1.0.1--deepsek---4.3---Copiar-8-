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

// ============================================================
// Registro durable de preapprovals (mp_preapprovals)
// ============================================================
// Esta tabla es la fuente de verdad de "qué suscripciones recurrentes existen
// y si pueden activar plan". allow_activation=false = el superadmin o el
// inquilino decidieron no cobrar más: ningún IPN rezagado puede reactivarlo.
interface TrackingPreapproval {
  id: string;
  tenant_id: string;
  plan: string | null;
  allow_activation: boolean;
  status: string;
}

async function getTracking(
  supabaseUrl: string,
  serviceRoleKey: string,
  preapprovalId: string
): Promise<TrackingPreapproval | null> {
  try {
    const resp = await fetch(
      `${supabaseUrl}/rest/v1/mp_preapprovals?mp_preapproval_id=eq.${encodeURIComponent(preapprovalId)}&select=id,tenant_id,plan,allow_activation,status&limit=1`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
      }
    );
    if (!resp.ok) return null;
    const rows = await resp.json();
    return rows?.[0] || null;
  } catch {
    return null;
  }
}

async function upsertTracking(
  supabaseUrl: string,
  serviceRoleKey: string,
  row: Record<string, unknown>
): Promise<void> {
  try {
    const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/mp_preapproval_registrar`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_tenant_id: row.tenant_id,
        p_preapproval_id: row.mp_preapproval_id,
        p_plan: row.plan ?? null,
        p_monto: row.monto ?? null,
        p_frequency: row.frequency ?? null,
        p_frequency_type: row.frequency_type ?? null,
        p_payer_email: row.payer_email ?? null,
        p_status: row.status ?? 'pending',
        p_allow_activation: row.allow_activation !== false,
        p_cancel_source: row.cancel_source ?? null,
        p_cancelled_at: row.cancelled_at ?? null,
        p_last_error: row.last_error ?? null,
      }),
    });
    if (!resp.ok) {
      console.warn(`[MP-Webhook] No se pudo registrar mp_preapproval (${resp.status}):`, (await resp.text().catch(() => '')).slice(0, 200));
    }
  } catch (e) {
    console.warn('[MP-Webhook] Error registrando mp_preapproval:', e);
  }
}

/** ¿El tenant existe todavía? (un tenant borrado deja preapprovals huérfanos) */
async function tenantExiste(supabaseUrl: string, serviceRoleKey: string, tenantId: string): Promise<boolean> {
  try {
    const resp = await fetch(`${supabaseUrl}/rest/v1/tenants?id=eq.${tenantId}&select=id&limit=1`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    });
    if (!resp.ok) return false;
    const rows = await resp.json();
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** Fallback: tenant actual que usa el email del pagador. */
async function buscarTenantPorEmail(
  supabaseUrl: string,
  serviceRoleKey: string,
  email: string | null
): Promise<string | null> {
  if (!email) return null;
  try {
    const resp = await fetch(
      `${supabaseUrl}/rest/v1/tenants?email_contacto=eq.${encodeURIComponent(email)}&select=id&order=fecha_registro.desc&limit=1`,
      { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } }
    );
    if (!resp.ok) return null;
    const rows = await resp.json();
    return rows?.[0]?.id || null;
  } catch {
    return null;
  }
}

/** Fallback: tenant vinculado a un preapproval con ese email de pagador. */
async function buscarTenantPorPreapprovalEmail(
  supabaseUrl: string,
  serviceRoleKey: string,
  email: string | null
): Promise<string | null> {
  if (!email) return null;
  try {
    const resp = await fetch(
      `${supabaseUrl}/rest/v1/mp_preapprovals?payer_email=eq.${encodeURIComponent(email)}&select=tenant_id&order=created_at.desc&limit=10`,
      { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } }
    );
    if (!resp.ok) return null;
    const rows = await resp.json();
    for (const r of rows) {
      if (r?.tenant_id && await tenantExiste(supabaseUrl, serviceRoleKey, r.tenant_id)) {
        return r.tenant_id;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resuelve el tenant REAL de una notificación. Si el tenant del
 * external_reference ya no existe (fue eliminado sin cancelar su
 * preapproval — caso umbralis), usa el registro durable y luego el email.
 */
async function resolverTenantVivo(
  supabaseUrl: string,
  serviceRoleKey: string,
  candidatos: Array<string | null | undefined>,
  email: string | null
): Promise<string | null> {
  for (const c of candidatos) {
    if (c && await tenantExiste(supabaseUrl, serviceRoleKey, c)) return c;
  }
  // 1º el tenant que REGISTRÓ un preapproval con ese email de pagador
  // (evita elegir un tenant duplicado con el mismo email de contacto).
  const porPreapproval = await buscarTenantPorPreapprovalEmail(supabaseUrl, serviceRoleKey, email);
  if (porPreapproval) {
    console.warn(`[MP-Webhook] Tenant original ya no existe — usando ${porPreapproval} (dueño del preapproval)`);
    return porPreapproval;
  }
  // 2º cualquier tenant con ese email de contacto
  const porEmail = await buscarTenantPorEmail(supabaseUrl, serviceRoleKey, email);
  if (porEmail) {
    console.warn(`[MP-Webhook] Tenant original ya no existe — usando ${porEmail} (mismo email del pagador)`);
  }
  return porEmail;
}

/**
 * Detecta un cobro que viene de una suscripción DESACTIVADA aunque el payment
 * no traiga preapproval_id (MP no siempre lo incluye en las cuotas).
 *
 * Condiciones (todas):
 *   - el tenant tiene un preapproval con allow_activation=false del mismo
 *     plan y monto que el cobro;
 *   - NO tiene ningún preapproval habilitado (pending/authorized) — si lo
 *     tuviera, sería una compra nueva legítima;
 *   - NO tiene una suscripción de pago activa (si la tuviera, es una
 *     renovación normal).
 */
async function detectarCobroDeSuscripcionDesactivada(
  supabaseUrl: string,
  serviceRoleKey: string,
  tenantId: string,
  plan: string | null,
  monto: number
): Promise<{ bloqueado: boolean; preapprovalId: string | null }> {
  const h = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
  try {
    const [descResp, actResp, subResp] = await Promise.all([
      fetch(`${supabaseUrl}/rest/v1/mp_preapprovals?tenant_id=eq.${tenantId}&allow_activation=eq.false&select=mp_preapproval_id,plan,monto,status&order=created_at.desc`, { headers: h }),
      fetch(`${supabaseUrl}/rest/v1/mp_preapprovals?tenant_id=eq.${tenantId}&allow_activation=eq.true&status=in.(pending,authorized)&select=id&limit=1`, { headers: h }),
      fetch(`${supabaseUrl}/rest/v1/subscriptions?tenant_id=eq.${tenantId}&status=eq.active&plan=in.(pro,premium_anual)&select=id&limit=1`, { headers: h }),
    ]);
    const desactivadas = descResp.ok ? await descResp.json() : [];
    const habilitadas = actResp.ok ? await actResp.json() : [];
    const pagoActivo = subResp.ok ? await subResp.json() : [];

    if (pagoActivo.length > 0 || habilitadas.length > 0) {
      return { bloqueado: false, preapprovalId: null };
    }

    const match = (desactivadas as Array<{ mp_preapproval_id: string; plan: string | null; monto: number | null }>)
      .find((r) => Number(r.monto) === Number(monto) && (!r.plan || !plan || r.plan === plan));
    if (match) return { bloqueado: true, preapprovalId: match.mp_preapproval_id };
    return { bloqueado: false, preapprovalId: null };
  } catch {
    return { bloqueado: false, preapprovalId: null };
  }
}

/** Cancela una suscripción recurrente en MP. Idempotente. */
async function cancelarPreapprovalEnMp(accessToken: string, preapprovalId: string): Promise<boolean> {
  try {
    const resp = await fetch(`https://api.mercadopago.com/preapproval/${preapprovalId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'cancelled' }),
    });
    if (resp.ok) {
      console.log(`[MP-Webhook] Preapproval ${preapprovalId} cancelado en MP`);
      return true;
    }
    const txt = (await resp.text().catch(() => '')).slice(0, 200);
    console.error(`[MP-Webhook] No se pudo cancelar preapproval ${preapprovalId} (${resp.status}):`, txt);
    return false;
  } catch (e) {
    console.error(`[MP-Webhook] Excepción cancelando preapproval ${preapprovalId}:`, e);
    return false;
  }
}

/** Reembolso TOTAL de un cobro. Devuelve el id del refund si funcionó. */
async function reembolsarPayment(
  accessToken: string,
  paymentId: string,
  motivo: string
): Promise<{ ok: boolean; refundId?: string; error?: string; monto?: number }> {
  try {
    const resp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}/refunds`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': `${paymentId}-${motivo}`,
      },
      body: JSON.stringify({}),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) {
      console.log(`[MP-Webhook] Payment ${paymentId} reembolsado (refund ${data?.id}) — motivo: ${motivo}`);
      return { ok: true, refundId: data?.id ? String(data.id) : undefined, monto: data?.amount };
    }
    const errMsg = JSON.stringify(data).slice(0, 250);
    console.error(`[MP-Webhook] Error reembolsando payment ${paymentId} (${resp.status}):`, errMsg);
    return { ok: false, error: `${resp.status}: ${errMsg}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
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
  const ref = parseExternalRef(pa.external_reference || '');
  // Registro durable: permite resolver tenant/plan aunque el preapproval sea
  // viejo y no exista ninguna fila en mercadopago_payments.
  const tracking = await getTracking(supabaseUrl, serviceRoleKey, preapprovalId);
  let tenantId = ref.tenantId || tracking?.tenant_id || null;
  const plan = ref.plan || tracking?.plan || null;

  // Un tenant eliminado deja su preapproval cobrando: resolver al tenant vivo
  // (registro durable o email del pagador) antes de tocar nada.
  tenantId = await resolverTenantVivo(supabaseUrl, serviceRoleKey, [tenantId, tracking?.tenant_id], ref.email || pa.payer_email || null);

  console.log(`[MP-Webhook] Preapproval ${preapprovalId}: status=${paStatus}, tenant=${tenantId}, plan=${plan}, allow_activation=${tracking?.allow_activation ?? 'sin-registro'}`);

  if (!tenantId) {
    console.warn('[MP-Webhook] Preapproval sin tenant válido — ignorando');
    return true;
  }

  // Sincronizar el estado real en mp_preapprovals. Una suscripción cancelada
  // o terminada NUNCA vuelve a permitir activación (last decision wins).
  const allowActivation = (paStatus === 'cancelled' || paStatus === 'finished')
    ? false
    : (tracking ? tracking.allow_activation : true);
  await upsertTracking(supabaseUrl, serviceRoleKey, {
    tenant_id: tenantId,
    mp_preapproval_id: preapprovalId,
    plan,
    monto: pa.auto_recurring?.transaction_amount ?? null,
    frequency: pa.auto_recurring?.frequency ?? null,
    frequency_type: pa.auto_recurring?.frequency_type ?? null,
    payer_email: pa.payer_email || null,
    status: paStatus,
    allow_activation: allowActivation,
    ...((paStatus === 'cancelled' || paStatus === 'finished')
      ? {
        cancelled_at: new Date().toISOString(),
        cancel_source: tracking && tracking.allow_activation === false ? undefined : 'webhook',
      }
      : {}),
  });

  if (paStatus === 'authorized' && plan) {
    // Defensa: si el cobro automático fue desactivado (superadmin pasó la
    // cuenta a freemium, o el inquilino canceló), un 'authorized' rezagado de
    // MP NO debe reactivar el plan. Se vuelve a cancelar por si MP la reactivó.
    if (tracking && tracking.allow_activation === false) {
      console.log(`[MP-Webhook] Preapproval ${preapprovalId} con allow_activation=false — NO se activa; re-cancelando en MP`);
      await cancelarPreapprovalEnMp(accessToken, preapprovalId);
      return true;
    }
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

    // Estado del preapproval (cuando el pago proviene de una suscripción
    // recurrente). Si está 'cancelled', el cobro NO debe reactivar el plan: el
    // superadmin o el inquilino cancelaron la suscripción a propósito. Evita
    // que un IPN rezagado pise esa decisión.
    let preapprovalStatus: string | null = null;
    let trackingPago: TrackingPreapproval | null = null;

    if (payment.preapproval_id) {
      try {
        const paResp = await fetch(`https://api.mercadopago.com/preapproval/${payment.preapproval_id}`, {
          headers: { 'Authorization': `Bearer ${accessToken}` },
        });
        if (paResp.ok) {
          const pa = await paResp.json();
          preapprovalStatus = pa.status || null;
          const ref = parseExternalRef(pa.external_reference || '');
          if (!tenantId) tenantId = ref.tenantId;
          if (!plan) plan = ref.plan;
          if (!email) email = ref.email;

          // Registro durable: resuelve tenant/plan incluso si el preapproval
          // es viejo y no hay fila en mercadopago_payments (caso umbralis).
          trackingPago = await getTracking(supabaseUrl, serviceRoleKey, payment.preapproval_id);
          if (trackingPago) {
            if (!tenantId) tenantId = trackingPago.tenant_id;
            if (!plan) plan = trackingPago.plan;
          }
          console.log(`[MP-Webhook] Payment recurrente ${paymentId} → preapproval ${payment.preapproval_id}: status=${preapprovalStatus}, tenant=${tenantId}, plan=${plan}, allow_activation=${trackingPago?.allow_activation ?? 'sin-registro'}`);
        }
      } catch (e) {
        console.warn(`[MP-Webhook] Error consultando preapproval ${payment.preapproval_id}:`, e);
      }

      // Si el tenant del external_reference fue eliminado (preapproval huérfano
      // que MP sigue cobrando), resolver al tenant vivo por registro/email.
      tenantId = await resolverTenantVivo(
        supabaseUrl,
        serviceRoleKey,
        [tenantId, trackingPago?.tenant_id],
        payment.payer?.email || email
      );
    }

    // Resolver SIEMPRE el tenant vivo: hay cuotas de suscripción que NO traen
    // preapproval_id y su external_reference puede apuntar a un tenant borrado.
    if (tenantId && supabaseUrl && serviceRoleKey) {
      tenantId = await resolverTenantVivo(
        supabaseUrl,
        serviceRoleKey,
        [tenantId, trackingPago?.tenant_id],
        payment.payer?.email || email
      );
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
      // Decisión comercial firme: esta suscripción fue desactivada por el
      // superadmin (plan gratuito) o cancelada por el inquilino. Un cobro
      // rezagado de MP NO debe reactivar el plan.
      let bloqueadoPorAdmin = trackingPago?.allow_activation === false;
      let preapprovalDesactivadoId: string | null = null;
      if (!bloqueadoPorAdmin && ourStatus === 'approved' && tenantId && plan) {
        // Cuotas sin preapproval_id: detectar por tenant + plan + monto.
        const det = await detectarCobroDeSuscripcionDesactivada(
          supabaseUrl, serviceRoleKey, tenantId, plan, Number(payment.transaction_amount || 0)
        );
        bloqueadoPorAdmin = det.bloqueado;
        preapprovalDesactivadoId = det.preapprovalId;
      }
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

      let dbSaveOk = true;
      let dbSaveError = '';
      if (existing && existing.length > 0) {
        // Actualizar registro existente
        const patchResp = await fetch(
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
        dbSaveOk = patchResp.ok;
        if (!patchResp.ok) dbSaveError = `${patchResp.status}: ${(await patchResp.text().catch(() => '')).slice(0, 200)}`;
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
        const insertResp = await fetch(
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
        dbSaveOk = insertResp.ok;
        if (!insertResp.ok) dbSaveError = `${insertResp.status}: ${(await insertResp.text().catch(() => '')).slice(0, 200)}`;
      }

      if (!dbSaveOk) {
        // Antes esto se ignoraba → MP recibía 200 y el pago se perdía para
        // siempre (sin fila, sin activación). Si había tenant/plan, devolvemos
        // error para que MP reintente.
        console.error(`[MP-Webhook] No se pudo guardar el payment ${paymentId}:`, dbSaveError);
        if (tenantId && plan) {
          return new Response(JSON.stringify({ error: 'No se pudo registrar el pago', detail: dbSaveError }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // Si el pago fue aprobado y tenemos tenant_id y plan, activar suscripción
      // (solo si NO fue procesado antes — idempotencia ante reintentos de MP)
      if (ourStatus === 'approved' && tenantId && plan && !yaProcesado && preapprovalStatus !== 'cancelled' && !bloqueadoPorAdmin) {
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
      } else if (ourStatus === 'approved' && bloqueadoPorAdmin) {
        // COBRO INDEBIDO: llegó una cuota de una suscripción que el superadmin
        // había desactivado (p. ej. cuenta pasada a freemium y MP siguió
        // cobrando). Se respeta la última decisión: NO se activa, se cancela
        // la suscripción en MP y se reembolsa el cobro completo.
        console.warn(`[MP-Webhook] COBRO DE SUSCRIPCIÓN DESACTIVADA — tenant ${tenantId}, preapproval ${payment.preapproval_id}, payment ${paymentId}. Se cancela y se reembolsa.`);

        const paId = payment.preapproval_id || preapprovalDesactivadoId;
        if (paId) {
          await cancelarPreapprovalEnMp(accessToken, paId);
          await upsertTracking(supabaseUrl, serviceRoleKey, {
            tenant_id: tenantId,
            mp_preapproval_id: paId,
            plan,
            status: 'cancelled',
            allow_activation: false,
            cancel_source: 'webhook',
            cancelled_at: new Date().toISOString(),
          });
        }

        const refund = await reembolsarPayment(accessToken, paymentId, 'cobro-plan-gratuito');
        if (refund.ok) {
          // Reflejar la realidad: el cobro quedó devuelto.
          await fetch(
            `${supabaseUrl}/rest/v1/mercadopago_payments?mp_payment_id=eq.${paymentId}`,
            {
              method: 'PATCH',
              headers: {
                'apikey': serviceRoleKey,
                'Authorization': `Bearer ${serviceRoleKey}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal',
              },
              body: JSON.stringify({
                mp_status: 'refunded',
                updated_at: new Date().toISOString(),
              }),
            }
          );
        }
      } else if (ourStatus === 'approved' && preapprovalStatus === 'cancelled') {
        console.log(`[MP-Webhook] Payment ${paymentId} de un preapproval CANCELADO — suscripción NO reactivada (decisión del superadmin/inquilino respetada)`);
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
