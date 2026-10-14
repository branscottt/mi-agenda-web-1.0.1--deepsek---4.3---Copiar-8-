// Mide el envío REAL de texto (de punta a punta) contra la versión desplegada.
// Uso: node scripts/mide-envio.mjs "<etiqueta>" N
import { readFileSync } from 'node:fs';
const RAIZ = '/home/branscott/proyectos/mi-agenda-web 1.0.1 (deepsek) (4.3) (Copiar 13)';
const SUPA = 'https://dfcfimipkfhitlsyixqu.supabase.co';
const KEY = (readFileSync(`${RAIZ}/.env.local`, 'utf8').match(/^SUPABASE_KEY=(.*)$/m) || [, ''])[1].trim();
const etiqueta = process.argv[2] || 'medicion';
const n = Number(process.argv[3] || 2);
const CHAT = '3f063ab8-8b53-42bc-a11e-ee2a8cf443a8';   // número de prueba (sin cliente)

const tok = await (await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'super@demo.com', password: 'demo123' }) })).json();
if (!tok.access_token) { console.log('login super FALLÓ: ' + JSON.stringify(tok).slice(0, 200)); process.exit(1); }

const tiempos = [];
for (let i = 1; i <= n; i++) {
    const texto = `[${etiqueta} ${i}/${n}] prueba de velocidad`;
    const t0 = performance.now();
    const r = await fetch(`${SUPA}/functions/v1/wa-enviar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok.access_token },
        body: JSON.stringify({ chat_id: CHAT, texto })
    });
    const cuerpo = await r.json().catch(() => ({}));
    const ms = Math.round(performance.now() - t0);
    tiempos.push({ ms, http: r.status, ok: cuerpo.ok === true, err: (cuerpo.error || '').slice(0, 120) });
    await new Promise((s) => setTimeout(s, 1200));
}
const ok = tiempos.filter((t) => t.ok);
const prom = ok.length ? Math.round(ok.reduce((a, t) => a + t.ms, 0) / ok.length) : 0;
console.log(`── ${etiqueta} ──`);
for (const t of tiempos) console.log(`   ${t.ms} ms  ok=${t.ok}  http=${t.http}${t.err ? '  ' + t.err : ''}`);
console.log(`   prom de los enviados: ${prom} ms  (${ok.length}/${n} ok)`);
