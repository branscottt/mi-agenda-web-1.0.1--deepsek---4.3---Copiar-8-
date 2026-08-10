#!/usr/bin/env python3
"""Consulta permisos reales vía Management API de Supabase (token CLI, sin imprimirlo)."""
import json, urllib.request, urllib.error

ref = open('supabase/.temp/project-ref').read().strip()
token = open(__import__('os').path.expanduser('~/.supabase/access-token')).read().strip()

def run_query(q):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{ref}/database/query",
        data=json.dumps({"query": q}).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:500]

queries = {
 "1. Grants usuarios_con_rol": """
   SELECT grantee, privilege_type FROM information_schema.role_table_grants
   WHERE table_name='usuarios_con_rol' ORDER BY grantee, privilege_type""",
 "2. Vista actualizable": """
   SELECT table_name, is_updatable, is_insertable_into FROM information_schema.views
   WHERE table_name='usuarios_con_rol'""",
 "3. RLS vista": """
   SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
   WHERE relname='usuarios_con_rol'""",
 "4. RPC EXECUTE por rol": """
   SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
          p.prosecdef AS sec_definer
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname IN
     ('activar_suscripcion_post_pago','desactivar_suscripcion','can_use_promo_coupon',
      'get_worker_portal_data','create_initial_subscription','get_all_users_for_superadmin',
      'get_current_coupon_period','set_tenant_anon','crear_tenant_completo')
   ORDER BY p.proname""",
 "5. get_worker_portal_data def": """
   SELECT p.proname, pg_get_function_identity_arguments(p.oid), p.prosecdef
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_worker_portal_data'""",
}

for title, q in queries.items():
    s, b = run_query(q)
    print(f"\n=== {title} ({s}) ===")
    try:
        rows = json.loads(b)
        if isinstance(rows, list):
            for r in rows[:20]:
                print("  ", r)
        else:
            print("  ", b[:300])
    except Exception:
        print("  ", b[:300])
