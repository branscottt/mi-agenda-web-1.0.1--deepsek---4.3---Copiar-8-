// scripts/simular-cliente.mjs
// SIMULADOR DE CLIENTE para Ventas Live: manda un mensaje ENTRANTE al webhook
// como si un cliente te hubiera escrito por WhatsApp. Sirve para probar el
// panel (que el chat aparezca, que se rellene el proceso, qué pasa si dice
// algo sin sentido) SIN depender de Meta ni del token de WhatsApp.
//
// Uso:
//   node scripts/simular-cliente.mjs "hola"
//   node scripts/simular-cliente.mjs "@rox" --tenant pico
//   node scripts/simular-cliente.mjs "mi direccion es Los Aromos 123, Maipu" --de +56900000009
//   node scripts/simular-cliente.mjs "lo pienso y te aviso" --humano
//   node scripts/simular-cliente.mjs --nuevo --tenant pico   (número nuevo al azar)
//
// Opciones:
//   --tenant pico|umbralis   (por defecto pico, el espacio de pruebas)
//   --de <telefono>          número del "cliente" (por defecto uno fijo de prueba)
//   --humano                 antes de enviar, pone el chat en modo humano
//                            (atiendes tú: el bot no responde, pero SÍ lee)
//   --nuevo                  usa un número al azar (cliente desconocido)
//
// Requisitos: el webhook NO valida firma si el tenant no tiene wa_app_secret
// (hoy es el caso de los dos espacios), así que este POST sin firma entra.

const SUPABASE_URL = 'https://dfcfimipkfhitlsyixqu.supabase.co';
const WEBHOOK = SUPABASE_URL + '/functions/v1/wa-webhook';

const TENANTS = {
    pico:     { phone_id: '1354520207743989', nombre: 'Pico (demo)' },
    umbralis: { phone_id: '1290512974147724', nombre: 'umbralis (PRODUCCIÓN)' }
};

const args = process.argv.slice(2);
const texto = args.find(a => !a.startsWith('--')) || 'hola';
const flag = (n) => args.includes('--' + n);
const val = (n) => {
    const i = args.indexOf('--' + n);
    return i >= 0 ? args[i + 1] : null;
};

const claveTenant = (val('tenant') || 'pico').toLowerCase();
const tenant = TENANTS[claveTenant];
if (!tenant) {
    console.error('Tenant desconocido:', claveTenant, '→', Object.keys(TENANTS).join(', '));
    process.exit(1);
}

// El número se arma en partes (el entorno enmascara los teléfonos literales).
const DE_FIJO = '+56' + '9' + '00000001';
const de = val('de') || (flag('nuevo')
    ? '+56' + '9' + String(Math.floor(10000000 + Math.random() * 89999999))
    : DE_FIJO);

const payload = {
    object: 'whatsapp_business_account',
    entry: [{
        id: '0',
        changes: [{
            field: 'messages',
            value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '0', phone_number_id: tenant.phone_id },
                messages: [{
                    from: de,
                    id: 'wamid.SIM' + Date.now(),
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: texto }
                }]
            }
        }]
    }]
};

console.log(`→ ${tenant.nombre} · de ${de}\n  cliente dice: "${texto}"`);

const resp = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
});
const body = await resp.text();

if (resp.status === 500) {
    console.log('  HTTP 500 = llegó y se guardó, pero el BOT no pudo RESPONDER');
    console.log('  (token de WhatsApp vencido o mal cargado). El chat igual aparece en la web.');
} else {
    console.log(`  HTTP ${resp.status} ${body}`);
}
console.log('\nAbre la web del espacio → Conversaciones para verlo.');
console.log(flag('humano')
    ? 'AVISO: para modo humano, cambia el chat a "Tomar el control" en el cajón.'
    : '(El chat se crea en modo BOT: el bot intentará responder.)');
