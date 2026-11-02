// cancelar-suscripcion/index.ts
// Edge Function que CANCELA una suscripción recurrente de Mercado Pago
// (preapproval) y, opcionalmente, desactiva la suscripción en la base.
//
// Uso: POST /functions/v1/cancelar-suscripcion
// Body: {
//   tenant_id?: string,      // solo super_admin (el dueño usa el suyo)
//   solo_mp?: boolean,       // true = cancela en MP y NO desactiva la DB
//   dry_run?: boolean,       // true = solo informa, no cancela ni escribe
//   reembolsar?: boolean,    // true = reembolsa los cobros aprobados encontrados
//   motivo?: string          // 'superadmin' | 'inquilino' (para auditoría)
// }
//
// Response: {
//   ok, mp_cancelled, preapproval_id, preapproval_ids, cancelados: [...],
//   encontrados_por: [...], reembolsos: [...], dry_run
// }
//
// CAMBIO CLAVE (2026-11, caso umbralis):
//   Antes el preapproval se buscaba SOLO en mercadopago_payments. Si el IPN
//   nunca llegó (o el INSERT falló) no había fila → la función respondía
//   {ok:true, mp_cancelled:false} y MP seguía cobrando todos los meses.
//   Ahora se busca en 4 fuentes y se registra en mp_preapprovals:
//     1) tabla mp_preapprovals (registro durable desde que se crea)
//     2) mercadopago_payments (legacy, por si hay filas viejas)
//     3) API MP: GET /preapproval/search?payer_email=<email del tenant>
//     4) API MP: GET /preapproval/search (filtrado por external_reference)
//   Toda suscripción encontrada queda con allow_activation=false, de modo que
//   un IPN rezagado NO pueda reactivar el plan de pago (la última decisión manda).
//
// Reembolso: con reembolsar=true busca los cobros aprobados de cada
// preapproval (payments search → authorized_payments/search) y hace un refund
// TOTAL por API. Es para devolver cobros hechos DESPUÉS de pasar a un plan
// gratuito. Con dry_run=true solo los lista.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { applySecurityHeaders } from '../_shared/security-headers.ts';

const MP_API = 'https://api.mercadopago.com';

interface CancelRequest {
  tenant_id?: string;
  solo_mp?: boolean;
  dry_run?: boolean;
  reembolsar?: boolean;
  /** IDs de pago exactos a reembolsar (super_admin). Evita reembolsos por aproximación. */
  pagos_a_reembolsar?: string[];
  /** Preapprovals exactos a cancelar (super_admin). Para limpiar huérfanos puntuales. */
  preapprovals_a_cancelar?: string[];
  motivo?: string;
}

interface JwtPayload {
  sub?: string;
  email?: string;
  user_metadata?: { tenant_id?: string; rol?: string };
}

interface PreapprovalEncontrado {
  id: string;
  fuentes: string[];
  status_mp?: string;
  mp_cancelled?: boolean;
  ref_tenant?: string | null;
  plan?: string | null;
  monto?: number | null;
  error?: string;
}

/** Decodifica el payload de un JWT (la firma ya la validó la plataforma). */
function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
    return JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
    )) as JwtPayload;
  } catch {
    return null;
  }
}

function validateJwt(req: Request): { userId: string | null; userTenantId: string | null; rol: string | null } {
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return { userId: null, userTenantId: null, rol: null };
  const jwt = decodeJwtPayload(authHeader.slice(7).trim());
  if (!jwt) return { userId: null, userTenantId: null, rol: null };
  return {
    userId: jwt.sub || null,
    userTenantId: jwt.user_metadata?.tenant_id || null,
    rol: jwt.user_metadata?.rol || null,
  };
}

function sbHeaders(serviceRoleKey: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };
}

/** fetch a MP con reintento corto ante 429 (rate limit del sandbox/API). */
async function mpFetch(url: string, init: RequestInit, intentos = 3): Promise<Response> {
  let resp = await fetch(url, init);
  for (let i = 1; i < intentos && resp.status === 429; i++) {
    await new Promise(r => setTimeout(r, 1200 * i));
    resp = await fetch(url, init);
  }
  return resp;
}

/** Busca preapprovals por email del pagador en la API de MP. */
async function buscarEnMpPorEmail(
  accessToken: string,
  email: string | null
): Promise<{ ids: string[]; error?: string }> {
  if (!email) return { ids: [] };
  const url = `${MP_API}/preapproval/search?payer_email=${encodeURIComponent(email)}&limit=50`;
  try {
    const resp = await mpFetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) {
      return { ids: [], error: `MP preapproval/search ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}` };
    }
    const data = await resp.json();
    const results = Array.isArray(data) ? data : (data.results || []);
    return { ids: results.map((p: { id?: string }) => p.id).filter(Boolean) as string[] };
  } catch (e) {
    return { ids: [], error: `MP preapproval/search excepción: ${(e as Error).message}` };
  }
}

/** Último recurso: lista preapprovals de la cuenta y filtra por tenant/email. */
async function buscarEnMpPorTenant(
  accessToken: string,
  tenantId: string,
  email: string | null
): Promise<{ ids: string[]; error?: string }> {
  try {
    const resp = await mpFetch(`${MP_API}/preapproval/search?limit=100`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) {
      return { ids: [], error: `MP preapproval/search(all) ${resp.status}` };
    }
    const data = await resp.json();
    const results = Array.isArray(data) ? data : (data.results || []);
    const ids = results
      .filter((p: { external_reference?: string; payer_email?: string }) => {
        const ref = p.external_reference || '';
        return ref.includes(tenantId) || (!!email && p.payer_email === email);
      })
      .map((p: { id?: string }) => p.id)
      .filter(Boolean) as string[];
    return { ids };
  } catch (e) {
    return { ids: [], error: `MP preapproval/search(all) excepción: ${(e as Error).message}` };
  }
}

/** Cobros aprobados de un preapproval (solo lectura). */
async function buscarCobros(
  accessToken: string,
  preapprovalId: string,
  tenantEmail: string | null,
  refTenant: string | null
): Promise<{
  cobros: Array<{ payment_id: string; monto?: number; status?: string; fecha?: string }>;
  errores: string[];
}> {
  const out: Array<{ payment_id: string; monto?: number; status?: string; fecha?: string }> = [];
  const errores: string[] = [];
  const vistos = new Set<string>();
  const agregar = (p: Record<string, any>) => {
    if (!p?.id || vistos.has(String(p.id))) return;
    vistos.add(String(p.id));
    out.push({
      payment_id: String(p.id),
      monto: p.transaction_amount,
      status: p.status,
      fecha: p.date_created,
    });
  };

  // 1) Barrido de los últimos 365 días filtrando por preapproval / pagador.
  // Nota: /v1/payments/search NO acepta preapproval_id como parámetro
  // (400 "the attribute preapproval_id is not a possible param" — verificado).
  const fin = new Date();
  const inicio = new Date(fin.getTime() - 365 * 24 * 60 * 60 * 1000);
  const url = `${MP_API}/v1/payments/search?sort=date_created&criteria=desc&range=date_created` +
    `&begin_date=${encodeURIComponent(inicio.toISOString())}&end_date=${encodeURIComponent(fin.toISOString())}&limit=100`;
  const r1 = await mpFetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (r1.ok) {
    const d1 = await r1.json();
    for (const p of (d1.results || [])) {
      const mismoPreapproval = String(p.preapproval_id || '') === preapprovalId;
      const mismoPagador = !p.preapproval_id && !!tenantEmail && (p.payer?.email || '') === tenantEmail;
      const mismoRef = !!refTenant && String(p.external_reference || '').includes(refTenant);
      if (mismoPreapproval || mismoPagador || mismoRef) agregar(p);
    }
  } else {
    errores.push(`payments/search(365d) → ${r1.status}: ${(await r1.text().catch(() => '')).slice(0, 160)}`);
  }

  // 2) authorized_payments (API de suscripciones). NO acepta 'limit'.
  if (out.length === 0) {
    const r2 = await mpFetch(
      `${MP_API}/authorized_payments/search?preapproval_id=${encodeURIComponent(preapprovalId)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (r2.ok) {
      const d2 = await r2.json();
      for (const ap of (d2.results || [])) {
        const p = ap?.payment;
        if (p?.id) agregar(p);
        else if (ap?.payment_id) {
          const rp = await mpFetch(`${MP_API}/v1/payments/${ap.payment_id}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (rp.ok) agregar(await rp.json());
        }
      }
    } else {
      errores.push(`authorized_payments/search → ${r2.status}: ${(await r2.text().catch(() => '')).slice(0, 160)}`);
    }
  }

  return { cobros: out, errores };
}

async function handle(req: Request): Promise<Response> {
  const requestOrigin = req.headers.get('origin') || '';
  const allowedOriginsEnv = Deno.env.get('ALLOWED_ORIGINS') || '';
  const allowedOrigins = allowedOriginsEnv ? allowedOriginsEnv.split(',').map(o => o.trim()) : [];
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
    const soloMp = body.solo_mp === true;
    const dryRun = body.dry_run === true;
    const reembolsar = body.reembolsar === true;
    const motivo = (body.motivo || (isSuperAdmin ? 'superadmin' : 'inquilino')).slice(0, 40);

    let tenantId = jwtInfo.userTenantId;
    if (body.tenant_id) {
      if (isSuperAdmin) tenantId = body.tenant_id;
      else if (body.tenant_id === jwtInfo.userTenantId) tenantId = body.tenant_id;
      else {
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

    const sb = sbHeaders(serviceRoleKey);
    const encontrados = new Map<string, PreapprovalEncontrado>();
    const encontradosPor = new Set<string>();
    const errores: string[] = [];

    const agregar = (id: string, fuente: string) => {
      if (!id) return;
      const prev = encontrados.get(id);
      if (prev) { if (!prev.fuentes.includes(fuente)) prev.fuentes.push(fuente); }
      else encontrados.set(id, { id, fuentes: [fuente] });
      encontradosPor.add(fuente);
    };

    // Datos del tenant (email para buscar en MP)
    let tenantEmail: string | null = null;
    const tResp = await fetch(`${supabaseUrl}/rest/v1/tenants?id=eq.${tenantId}&select=email_contacto`, { headers: sb });
    if (tResp.ok) {
      const tRows = await tResp.json();
      tenantEmail = tRows?.[0]?.email_contacto || null;
    }

    // Lista EXPLÍCITA de preapprovals (super_admin). Sirve para limpiar
    // huérfanos puntuales sin arrastrar los de otros tenants con igual email.
    const preapprovalsExplicitos = Array.isArray(body.preapprovals_a_cancelar)
      ? body.preapprovals_a_cancelar.filter((x) => typeof x === 'string' && /^[A-Za-z0-9]+$/.test(x)).slice(0, 20)
      : [];
    if (preapprovalsExplicitos.length && !isSuperAdmin) {
      return new Response(JSON.stringify({ error: 'Solo super_admin puede cancelar preapprovals explícitos' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    if (preapprovalsExplicitos.length) {
      for (const id of preapprovalsExplicitos) agregar(id, 'explicito');
    } else {
      // 1) Registro durable
      const trackResp = await fetch(
        `${supabaseUrl}/rest/v1/mp_preapprovals?tenant_id=eq.${tenantId}&select=mp_preapproval_id,status,allow_activation&order=created_at.desc`,
        { headers: sb }
      );
      if (trackResp.ok) {
        for (const r of (await trackResp.json())) agregar(r.mp_preapproval_id, 'mp_preapprovals');
      } else {
        errores.push(`No se pudo leer mp_preapprovals (${trackResp.status})`);
      }

      // 2) Legacy: mercadopago_payments
      const legacyResp = await fetch(
        `${supabaseUrl}/rest/v1/mercadopago_payments?tenant_id=eq.${tenantId}&mp_preapproval_id=not.is.null&select=mp_preapproval_id&order=created_at.desc&limit=20`,
        { headers: sb }
      );
      if (legacyResp.ok) {
        for (const r of (await legacyResp.json())) agregar(r.mp_preapproval_id, 'mercadopago_payments');
      }

      // 3) API MP por email del pagador
      const porEmail = await buscarEnMpPorEmail(accessToken, tenantEmail);
      if (porEmail.error) errores.push(porEmail.error);
      for (const id of porEmail.ids) agregar(id, 'mp_search_email');

      // 4) API MP por tenant (fallback)
      if (encontrados.size === 0) {
        const porTenant = await buscarEnMpPorTenant(accessToken, tenantId, tenantEmail);
        if (porTenant.error) errores.push(porTenant.error);
        for (const id of porTenant.ids) agregar(id, 'mp_search_tenant');
      }
    }

    console.log(`[cancelar-suscripcion] tenant=${tenantId} encontrados=${encontrados.size} fuentes=${[...encontradosPor].join(',')} dry_run=${dryRun}`);

    // Revisar/cancelar cada preapproval
    const cancelados: PreapprovalEncontrado[] = [];
    const activosRestantes: string[] = [];

    for (const cand of encontrados.values()) {
      const resp = await mpFetch(`${MP_API}/preapproval/${cand.id}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!resp.ok) {
        cand.error = `GET preapproval ${resp.status}`;
        errores.push(`GET preapproval ${cand.id}: ${resp.status}`);
        cancelados.push(cand);
        continue;
      }

      const pa = await resp.json();
      cand.status_mp = pa.status;
      cand.monto = pa.auto_recurring?.transaction_amount ?? null;
      try {
        const refPa = JSON.parse(pa.external_reference || '{}');
        cand.ref_tenant = refPa.tenant_id || null;
        cand.plan = refPa.plan || null;
      } catch { /* external_reference no-JSON */ }

      // Tenant para el registro: el del external_reference si sigue existiendo;
      // si es huérfano (tenant borrado) se usa el tenant desde el que se llama.
      let tenantRegistro = tenantId;
      if (cand.ref_tenant && cand.ref_tenant !== tenantId) {
        const exResp = await fetch(`${supabaseUrl}/rest/v1/tenants?id=eq.${cand.ref_tenant}&select=id`, { headers: sb });
        if (exResp.ok && (await exResp.json()).length > 0) tenantRegistro = cand.ref_tenant;
      }
      const cobraActivo = ['pending', 'authorized', 'paused'].includes(pa.status);

      if (cobraActivo && !dryRun) {
        const putResp = await mpFetch(`${MP_API}/preapproval/${cand.id}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'cancelled' }),
        });
        if (putResp.ok) {
          cand.mp_cancelled = true;
          cand.status_mp = 'cancelled';
          console.log(`[cancelar-suscripcion] Preapproval ${cand.id} CANCELADO en MP (tenant ${tenantId})`);
        } else {
          const errText = (await putResp.text().catch(() => '')).slice(0, 200);
          cand.mp_cancelled = false;
          cand.error = `PUT ${putResp.status}: ${errText}`;
          errores.push(`Cancelar ${cand.id}: ${putResp.status} ${errText}`);
          console.error(`[cancelar-suscripcion] Error cancelando ${cand.id} (${putResp.status}):`, errText);
          activosRestantes.push(cand.id);
        }
      } else if (cobraActivo && dryRun) {
        cand.mp_cancelled = false;
        activosRestantes.push(cand.id);
      } else {
        // Ya no cobra (cancelled/finished): se considera resuelto
        cand.mp_cancelled = ['cancelled', 'finished'].includes(pa.status);
      }

      // Registrar la decisión: allow_activation=false (no volver a activar).
      // La RPC nunca reasigna tenant_id ni vuelve a habilitar una suscripción.
      if (!dryRun) {
        const upsertResp = await fetch(
          `${supabaseUrl}/rest/v1/rpc/mp_preapproval_registrar`,
          {
            method: 'POST',
            headers: sb,
            body: JSON.stringify({
              p_tenant_id: tenantRegistro,
              p_preapproval_id: cand.id,
              p_plan: (() => { try { return JSON.parse(pa.external_reference || '{}').plan || null; } catch { return null; } })(),
              p_monto: pa.auto_recurring?.transaction_amount ?? null,
              p_frequency: pa.auto_recurring?.frequency ?? null,
              p_frequency_type: pa.auto_recurring?.frequency_type ?? null,
              p_payer_email: pa.payer_email || tenantEmail,
              p_status: cand.status_mp,
              p_allow_activation: false,
              p_cancel_source: motivo,
              p_cancelled_at: cand.mp_cancelled ? new Date().toISOString() : null,
              p_last_error: cand.error || null,
            }),
          }
        );
        if (!upsertResp.ok) {
          console.error(`[cancelar-suscripcion] No se pudo registrar ${cand.id}: ${upsertResp.status}`);
          errores.push(`Registrar ${cand.id}: ${upsertResp.status}`);
        }
      }

      cancelados.push(cand);
    }

    // 5) Desactivar la suscripción en la base (si no es solo_mp)
    if (!soloMp && !dryRun) {
      const rpcResp = await fetch(`${supabaseUrl}/rest/v1/rpc/desactivar_suscripcion`, {
        method: 'POST',
        headers: sb,
        body: JSON.stringify({ p_tenant_id: tenantId }),
      });
      if (!rpcResp.ok) {
        const err = (await rpcResp.text().catch(() => '')).slice(0, 200);
        console.error(`[cancelar-suscripcion] Error desactivando suscripción en DB (${rpcResp.status}):`, err);
        errores.push(`desactivar_suscripcion: ${rpcResp.status}`);
      }
    }

    // 6) Reembolso de cobros aprobados (opcional)
    const reembolsos: Array<Record<string, unknown>> = [];
    const pagosExplicitos = Array.isArray(body.pagos_a_reembolsar)
      ? body.pagos_a_reembolsar.filter((x) => typeof x === 'string' && /^\d+$/.test(x)).slice(0, 20)
      : [];

    if (pagosExplicitos.length) {
      // Reembolso de IDs exactos (super_admin). No adivina: consulta cada pago
      // y solo devuelve los que están aprobados.
      if (!isSuperAdmin) {
        return new Response(JSON.stringify({ error: 'Solo super_admin puede reembolsar pagos' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
      for (const pid of pagosExplicitos) {
        const pr = await mpFetch(`${MP_API}/v1/payments/${pid}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!pr.ok) {
          errores.push(`payment ${pid}: ${pr.status}`);
          reembolsos.push({ payment_id: pid, reembolsado: false, error: `GET ${pr.status}` });
          continue;
        }
        const pay = await pr.json();
        const item = {
          payment_id: pid,
          monto: pay.transaction_amount,
          status: pay.status,
          fecha: pay.date_created,
        };
        if (pay.status !== 'approved') {
          reembolsos.push({ ...item, reembolsado: false, error: `estado ${pay.status}` });
          continue;
        }
        if (dryRun) {
          reembolsos.push({ ...item, reembolsado: false, dry_run: true });
          continue;
        }
        const refundResp = await fetch(`${MP_API}/v1/payments/${pid}/refunds`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'X-Idempotency-Key': `${pid}-refund-admin`,
          },
          body: JSON.stringify({}),
        });
        const refundData = await refundResp.json().catch(() => ({}));
        if (refundResp.ok) {
          console.log(`[cancelar-suscripcion] Reembolsado payment ${pid} (${pay.transaction_amount})`);
          reembolsos.push({ ...item, reembolsado: true, refund_id: refundData?.id || null });
        } else {
          const errMsg = JSON.stringify(refundData).slice(0, 250);
          errores.push(`Reembolso ${pid}: ${refundResp.status}`);
          reembolsos.push({ ...item, reembolsado: false, error: errMsg });
        }
      }
    } else if (reembolsar) {
      for (const cand of cancelados) {
        const { cobros, errores: errCobros } = await buscarCobros(
          accessToken, cand.id, tenantEmail, cand.ref_tenant || null
        );
        if (errCobros.length) errores.push(...errCobros);
        for (const c of cobros) {
          if (c.status && c.status !== 'approved') continue;
          if (dryRun) {
            reembolsos.push({ preapproval_id: cand.id, ...c, reembolsado: false, dry_run: true });
            continue;
          }
          const refundResp = await fetch(`${MP_API}/v1/payments/${c.payment_id}/refunds`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
              'X-Idempotency-Key': `${c.payment_id}-refund-free-plan`,
            },
            body: JSON.stringify({}),
          });
          const refundData = await refundResp.json().catch(() => ({}));
          if (refundResp.ok) {
            console.log(`[cancelar-suscripcion] Reembolsado payment ${c.payment_id} (${c.monto ?? 'total'}) de ${cand.id}`);
            reembolsos.push({
              preapproval_id: cand.id,
              ...c,
              reembolsado: true,
              refund_id: refundData?.id || null,
            });
          } else {
            const errMsg = JSON.stringify(refundData).slice(0, 250);
            console.error(`[cancelar-suscripcion] Error reembolsando ${c.payment_id} (${refundResp.status}):`, errMsg);
            errores.push(`Reembolso ${c.payment_id}: ${refundResp.status}`);
            reembolsos.push({ preapproval_id: cand.id, ...c, reembolsado: false, error: errMsg });
          }
        }
      }
    }

    const ids = cancelados.map(c => c.id);
    const mpCancelled = cancelados.length > 0 && activosRestantes.length === 0;

    return new Response(JSON.stringify({
      ok: errores.length === 0,
      mp_cancelled: mpCancelled,
      preapproval_id: ids[0] || null,
      preapproval_ids: ids,
      cancelados,
      activos_restantes: activosRestantes,
      encontrados_por: [...encontradosPor],
      reembolsos,
      solo_mp: soloMp,
      dry_run: dryRun,
      errores,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (e: unknown) {
    const error = e as Error;
    console.error('[cancelar-suscripcion] Error inesperado:', error.message || String(error));
    return new Response(JSON.stringify({ error: 'Error interno del servidor' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

serve(async (req) => applySecurityHeaders(await handle(req)));
