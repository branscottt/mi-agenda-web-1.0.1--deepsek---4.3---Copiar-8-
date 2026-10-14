// Prueba la FUNCIÓN REAL del edge function (extraída del archivo, no una copia)
// con los errores que devuelve Meta, para verificar el aviso de la ventana 24 h.
import { readFileSync } from 'node:fs';
const RAIZ = '/home/branscott/proyectos/mi-agenda-web 1.0.1 (deepsek) (4.3) (Copiar 13)';
const src = readFileSync(`${RAIZ}/supabase/functions/wa-enviar/index.ts`, 'utf8');
const m = src.match(/function mensajeDeRechazo\(detalle: string\): string \{([\s\S]*?)\n\}/);
if (!m) { console.log('❌ no se encontró mensajeDeRechazo en el archivo'); process.exit(1); }
const js = `const mensajeDeRechazo = (detalle) => {${m[1].replace(': string', '')}};`;
const fn = new Function(js + ' return mensajeDeRechazo;')();

const casos = [
    ['131047 (ventana cerrada)', '{"error":{"message":"(#131047) Re-engagement message","code":131047,"type":"OAuthException"}}'],
    ['131026 (número sin WA)', '{"error":{"message":"(#131026) Message undeliverable","code":131026}}'],
    ['470 (ventana)', '{"error":{"message":"More than 24 hours have passed","code":470}}'],
    ['190 (token vencido)', '{"error":{"message":"Authentication Error","code":190,"type":"OAuthException"}}'],
    ['vacío', ''],
];
let ok = true;
for (const [etq, detalle] of casos) {
    const out = fn(detalle);
    const espera = etq.startsWith('131047') ? out.includes('24 horas')
        : etq.startsWith('131026') ? out.includes('no tiene WhatsApp')
        : etq.startsWith('470') ? out.includes('ventana de 24 horas')
        : out === 'WhatsApp rechazó el envío';
    if (!espera) ok = false;
    console.log(`  ${etq.padEnd(24)} -> ${out}`);
}
console.log(ok ? '\nRESULTADO: ✅ los 5 casos traducen bien' : '\nRESULTADO: ❌ algún caso falló');
process.exit(ok ? 0 : 1);
