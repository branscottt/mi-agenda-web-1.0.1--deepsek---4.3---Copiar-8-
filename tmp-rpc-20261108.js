#!/usr/bin/env node
// Prueba real de las RPC nuevas con la sesión demo (REST, misma ruta que el front).
const fs = require('fs');
const URL = 'https://dfcfimipkfhitlsyixqu.supabase.co';
const KEY = fs.readFileSync('/tmp/agendapro-key-clean.txt', 'utf8').trim();
const login = async (email, password) => {
  const r = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return r.json();
};
const rpc = async (tok, fn) => {
  const r = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  return { status: r.status, body: await r.json() };
};
(async () => {
  for (const [email, pass] of [['admin@demo.com', 'demo123']]) {
    const s = await login(email, pass);
    if (!s.access_token) { console.log(email, 'LOGIN FAIL', JSON.stringify(s).slice(0, 200)); continue; }
    const meta = s.user.user_metadata || {};
    console.log('=== ' + email + ' tenant=' + meta.tenant_id);
    const v = await rpc(s.access_token, 'vl_live_vendido');
    console.log('vl_live_vendido ->', v.status, JSON.stringify(v.body).slice(0, 800));
    const c = await rpc(s.access_token, 'vl_prendas_sin_contacto');
    console.log('vl_prendas_sin_contacto ->', c.status, JSON.stringify(c.body).slice(0, 1200));
  }
})();
