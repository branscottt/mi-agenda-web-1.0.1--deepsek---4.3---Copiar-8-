#!/usr/bin/env python3
"""Consulta permisos reales de la BD remota (sin imprimir credenciales)."""
import re, sys
sys.path.insert(0, '/tmp/dbvenv/lib/python3.12/site-packages')
import psycopg2

conn_str = open('supabase/.temp/pooler-url').read().strip()
conn = psycopg2.connect(conn_str, connect_timeout=20)
cur = conn.cursor()

print("=== 1. Grants sobre usuarios_con_rol por rol ===")
cur.execute("""
  SELECT grantee, privilege_type FROM information_schema.role_table_grants
  WHERE table_name='usuarios_con_rol' ORDER BY grantee, privilege_type
""")
for r in cur.fetchall(): print("  ", r)

print("\n=== 2. Vista actualizable? ===")
cur.execute("""
  SELECT table_name, is_updatable, is_insertable_into, is_trigger_updatable
  FROM information_schema.views WHERE table_name='usuarios_con_rol'
""")
print("  ", cur.fetchall())

print("\n=== 3. RLS en la vista? ===")
cur.execute("""
  SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname='usuarios_con_rol'
""")
print("  ", cur.fetchall())

print("\n=== 4. RPCs: EXECUTE por rol (authenticated / anon) ===")
cur.execute("""
  SELECT p.proname,
         pg_get_function_identity_arguments(p.oid) AS args,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
         has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
         p.prosecdef AS security_definer
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public'
    AND p.proname IN ('activar_suscripcion_post_pago','desactivar_suscripcion',
                      'can_use_promo_coupon','get_worker_portal_data',
                      'create_initial_subscription','get_all_users_for_superadmin',
                      'get_current_coupon_period','set_tenant_anon',
                      'crear_tenant_completo','crear_suscripcion_inicial')
  ORDER BY p.proname
""")
for r in cur.fetchall(): print("  ", r)

print("\n=== 5. get_worker_portal_data existe? (definición resumida) ===")
cur.execute("""
  SELECT p.proname, pg_get_function_identity_arguments(p.oid),
         p.prosecdef, left(pg_get_functiondef(p.oid), 300)
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='get_worker_portal_data'
""")
rows = cur.fetchall()
for r in rows: print("  ", r)

conn.close()
print("\nDONE")
