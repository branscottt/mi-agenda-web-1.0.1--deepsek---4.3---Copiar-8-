// Mide el efecto del caché de credenciales y COMPRUEBA que no afloje los permisos.
// El caché guarda por (chat + usuario): un usuario sin acceso al chat debe seguir
// rebotando AUNQUE otro usuario ya haya mandado a esa misma conversación.
import { readFileSync } from 'node:fs';
const RAIZ = '/home/branscott/proyectos/mi-agenda-web 1.0.1 (deepsek) (4.3) (Copiar 13)';
const SUPA = 'https://dfcfimipkfhitlsyixqu.supabase.co';
const KEY = (readFileSync(`${RAIZ}/.env.local`, 'utf8').match(/^SUPABASE_KEY=(.*)$/m) || [, ''])[1].trim();
const CHAT = '3f063ab8-8b53-42bc-a11e-ee2a8cf443a8';   // número de prueba (ventana abierta)

const login = async (email, password) => {
    const r = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }) });
    return r.json();
};
const mandar = async (token, chatId, texto) => {
    const t0 = performance.now();
    const r = await fetch(`${SUPA}/functions/v1/wa-enviar`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ chat_id: chatId, texto }) });
    const j = await r.json().catch(() => ({}));
    return { ms: Math.round(performance.now() - t0), http: r.status, ok: j.ok === true, error: (j.error || '').slice(0, 90) };
};

const superTok = (await login('super@demo.com', 'demo123')).access_token;

// 1) CALENTAR: el primer envío después de un deploy incluye el arranque en frío de
//    la función (~2 s). Se descarta para no atribuirle ese tiempo al caché.
process.stdout.write('calentando la función… ');
const cal = await mandar(superTok, CHAT, '[calentamiento]');
console.log(cal.ms + ' ms');

// 2) Se espera a que VENZA el minuto del caché: así el próximo envío sí consulta la
//    credencial de nuevo y la comparación es limpia (caliente vs con caché).
process.stdout.write('esperando 65 s a que venza el caché… ');
await new Promise((s) => setTimeout(s, 65000));
console.log('listo');

console.log('── envíos seguidos al MISMO chat (super) ──');
const tiempos = [];
for (let i = 1; i <= 4; i++) {
    const r = await mandar(superTok, CHAT, `[cache ${i}/4] prueba`);
    tiempos.push(r);
    console.log(`   ${i}º: ${r.ms} ms · ok=${r.ok}${r.error ? ' · ' + r.error : ''}`);
    await new Promise((s) => setTimeout(s, 1200));
}
const frios = tiempos.slice(0, 1).map((t) => t.ms);
const calientes = tiempos.slice(1).map((t) => t.ms);
const prom = (a) => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;
console.log(`   el 1º (consulta la credencial): ${prom(frios)} ms`);
console.log(`   los siguientes (caché):        ${prom(calientes)} ms  → ahorro ${prom(frios) - prom(calientes)} ms`);

console.log('\n── SEGURIDAD: otro usuario sin acceso al mismo chat ──');
const otro = (await login('admin@demo.com', 'demo123')).access_token;
const rIntruso = await mandar(otro, CHAT, '[prueba de permisos] no debería salir');
console.log(`   admin del OTRO negocio → http=${rIntruso.http} ok=${rIntruso.ok} · "${rIntruso.error}"`);
console.log(rIntruso.ok === false ? '   ✅ el caché NO dejó pasar a un usuario sin permiso' : '   ❌ AGUJERO DE SEGURIDAD: pasó sin permiso');
