#!/usr/bin/env python3
"""Verificación de vectores de autorización (sin modificar datos reales).
- Leak usuarios_con_rol: SELECT con token de un usuario normal.
- activar_suscripcion_post_pago: invocable por authenticated? (UUID inexistente -> FK error = expuesta)
- desactivar_suscripcion: idem con UUID inexistente.
- can_use_promo_coupon: acepta tenant ajeno? (lee suscripción de otro tenant)
"""
import json, re, sys, urllib.request, urllib.error

env = {}
with open('.env.local') as f:
    for line in f:
        m = re.match(r'^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$', line)
        if m:
            env[m.group(1)] = m.group(2).strip().strip('"').strip("'")

url = env['SUPABASE_URL']; key = env['SUPABASE_KEY']

def post(path, payload, headers):
    req = urllib.request.Request(url + path, data=json.dumps(payload).encode(), headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def get(path, headers):
    req = urllib.request.Request(url + path, headers=headers, method='GET')
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

# Login usuario normal (admin demo)
s, b = post('/auth/v1/token?grant_type=password', {"email": "admin@demo.com", "password": "demo123"},
            {"apikey": key, "Content-Type": "application/json"})
data = json.loads(b)
at = data['access_token']
my_tenant = data['user']['user_metadata'].get('tenant_id')
h = {"apikey": key, "Authorization": f"Bearer {at}"}
print(f"[*] login OK. tenant propio: {my_tenant}")

# 1) Leak: SELECT usuarios_con_rol (emails de TODOS los usuarios)
s, b = get(f"/rest/v1/usuarios_con_rol?select=email,rol,tenant_id&limit=3", h)
print(f"\n[1] usuarios_con_rol (usuario normal) -> {s}")
print(f"    {b[:250]}")

# 2) activar_suscripcion_post_pago con UUID inexistente (FK error = RPC invocable)
fake = "00000000-0000-0000-0000-000000000001"
s, b = post("/rest/v1/rpc/activar_suscripcion_post_pago",
            {"p_tenant_id": fake, "p_plan": "pro", "p_mp_payment_id": None, "p_monto": 15000}, h)
print(f"\n[2] activar_suscripcion_post_pago (tenant ajeno inexistente) -> {s}")
print(f"    {b[:250]}")

# 3) desactivar_suscripcion con UUID inexistente
s, b = post("/rest/v1/rpc/desactivar_suscripcion", {"p_tenant_id": fake}, h)
print(f"\n[3] desactivar_suscripcion (tenant ajeno inexistente) -> {s}")
print(f"    {b[:250]}")

# 4) can_use_promo_coupon con tenant ajeno (información de otro negocio)
s, b = post("/rest/v1/rpc/can_use_promo_coupon", {"p_tenant_id": fake}, h)
print(f"\n[4] can_use_promo_coupon (tenant ajeno) -> {s}")
print(f"    {b[:250]}")

# 5) get_all_users_for_superadmin con usuario NO super admin (debe fallar)
s, b = post("/rest/v1/rpc/get_all_users_for_superadmin", {}, h)
print(f"\n[5] get_all_users_for_superadmin (usuario normal) -> {s}")
print(f"    {b[:250]}")
