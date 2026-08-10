#!/usr/bin/env python3
"""Post-fix: verificar cierre de vectores (sin modificar datos reales)."""
import json, re, urllib.request, urllib.error

env = {}
with open('.env.local') as f:
    for line in f:
        m = re.match(r'^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$', line)
        if m:
            env[m.group(1)] = m.group(2).strip().strip('"').strip("'")

url = env['SUPABASE_URL']; key = env['SUPABASE_KEY']

def call(method, path, payload=None, headers=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url + path, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

# Login usuario normal
s, b = call('POST', '/auth/v1/token?grant_type=password',
            {"email": "admin@demo.com", "password": "demo123"},
            {"apikey": key, "Content-Type": "application/json"})
data = json.loads(b)
at = data['access_token']
my_tenant = data['user']['user_metadata'].get('tenant_id')
h = {"apikey": key, "Authorization": f"Bearer {at}", "Content-Type": "application/json"}
print(f"[*] login OK. tenant propio: {my_tenant}")

# 1) Vista usuarios_con_rol -> debe fallar (401/403), NO 200
s, b = call('GET', "/rest/v1/usuarios_con_rol?select=email&limit=1", headers=h)
print(f"[1] usuarios_con_rol -> {s} (esperado !=200) | {b[:120]}")

# 2) can_use_promo_coupon con tenant PROPIO -> 200 (feature intacta)
s, b = call('POST', "/rest/v1/rpc/can_use_promo_coupon", {"p_tenant_id": my_tenant}, h)
print(f"[2] can_use_promo_coupon (tenant propio) -> {s} | {b[:200]}")

# 3) can_use_promo_coupon con tenant AJENO -> 200 pero can_use=false (sin leak)
fake = "00000000-0000-0000-0000-000000000001"
s, b = call('POST', "/rest/v1/rpc/can_use_promo_coupon", {"p_tenant_id": fake}, h)
print(f"[3] can_use_promo_coupon (tenant ajeno) -> {s} | {b[:200]}")

# 4) get_all_users_for_superadmin con usuario normal -> 401/403
s, b = call('POST', "/rest/v1/rpc/get_all_users_for_superadmin", {}, h)
print(f"[4] get_all_users_for_superadmin (no super) -> {s} | {b[:150]}")

# 5) activar_suscripcion_post_pago -> no invocable (404/403)
s, b = call('POST', "/rest/v1/rpc/activar_suscripcion_post_pago",
            {"p_tenant_id": my_tenant, "p_plan": "pro", "p_mp_payment_id": None, "p_monto": 15000}, h)
print(f"[5] activar_suscripcion_post_pago -> {s} | {b[:150]}")

# 6) desactivar_suscripcion -> no invocable
s, b = call('POST', "/rest/v1/rpc/desactivar_suscripcion", {"p_tenant_id": my_tenant}, h)
print(f"[6] desactivar_suscripcion -> {s} | {b[:150]}")

# 7) RPC admin seguras con usuario normal -> 401/403 (denegadas)
s, b = call('POST', "/rest/v1/rpc/actualizar_rol_usuario", {"p_user_id": "00000000-0000-0000-0000-000000000002", "p_rol": "admin"}, h)
print(f"[7] actualizar_rol_usuario (no super) -> {s} | {b[:150]}")
s, b = call('POST', "/rest/v1/rpc/eliminar_usuario", {"p_user_id": "00000000-0000-0000-0000-000000000002"}, h)
print(f"[8] eliminar_usuario (no super) -> {s} | {b[:150]}")
