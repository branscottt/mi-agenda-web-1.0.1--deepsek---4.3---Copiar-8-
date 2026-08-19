// build.js — Bundle + minificación segura con esbuild
// Reduce exposición de código fuente manteniendo compatibilidad total
//
// ⚠️ ATENCIÓN CSP: Los hashes SHA256 en Content-Security-Policy (server.py y vercel.json)
// están calculados sobre los archivos GENERADOS por este build (dist/).
// Si modificas un <script> inline en cualquier archivo HTML fuente, debes REBUILD
// con `node build.js` y luego recalcular los hashes SHA256 para que coincidan.
// De lo contrario, el CSP bloqueará ese script en producción SILENCIOSAMENTE
// (sin errores en consola, sin warnings — el script simplemente no se ejecuta).
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

// Asegurar que dist/ existe y limpiar chunks viejos
if (!fs.existsSync('dist')) fs.mkdirSync('dist', { recursive: true });
const chunksDir = path.join('dist', 'chunks');
if (fs.existsSync(chunksDir)) fs.rmSync(chunksDir, { recursive: true });

console.log('📦 Building dist/app.js (ESM bundle + code splitting)...');

// 1. Bundle main.js con code splitting real
//    Con format: 'esm' + splitting, los import() dinámicos se convierten
//    en chunks separados que se cargan bajo demanda.
esbuild.buildSync({
    entryPoints: ['src/main.js'],
    bundle: true,
    format: 'esm',
    splitting: true,
    outdir: 'dist',
    entryNames: 'app',
    chunkNames: 'chunks/[name]-[hash]',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    keepNames: false,
    drop: ['debugger'],
    charset: 'utf8',
    target: ['es2020'],
});
console.log('   ✅ dist/app.js + chunks/ created');

// 2. Minificar script.js legacy → dist/legacy.js
console.log('📦 Building dist/legacy.js (legacy minified)...');
esbuild.buildSync({
    entryPoints: ['src/_legacy/script.js'],
    bundle: true,
    format: 'iife',
    outfile: 'dist/legacy.js',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    keepNames: false,
    drop: ['debugger'],
    charset: 'utf8',
    target: ['es2020'],
});
console.log('   ✅ dist/legacy.js created');

// 2b. Inyectar credenciales reales desde .env.local en los bundles generados.
//     El código fuente solo contiene placeholders (sin secretos en git).
//     .env.local está en .gitignore — la key real vive solo ahí.
//     Solo reemplaza si el valor de .env.local parece real (JWT de longitud >= 100).
function loadEnvLocal() {
    try {
        const raw = fs.readFileSync('.env.local', 'utf-8');
        const cfg = {};
        for (const line of raw.split('\n')) {
            const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
            if (m) cfg[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
        return cfg;
    } catch (e) {
        return {};
    }
}
const envLocal = loadEnvLocal();
// Prioridad: env vars del entorno de build (Vercel inyecta las del proyecto) > .env.local
const realKey = (process.env.SUPABASE_KEY || envLocal.SUPABASE_KEY || '').trim();
const realUrl = (process.env.SUPABASE_URL || envLocal.SUPABASE_URL || '').trim();
if (realKey.length >= 100 && !realKey.includes('...')) {
    for (const bundle of ['dist/app.js', 'dist/legacy.js']) {
        if (!fs.existsSync(bundle)) continue;
        let code = fs.readFileSync(bundle, 'utf-8');
        // Placeholder anon key truncada usada como fallback en src/ (nunca debe llegar a prod)
        const replaced = code.replace(/eyJhbG\.\.\.Ccw0/g, realKey);
        if (replaced !== code) {
            fs.writeFileSync(bundle, replaced);
            console.log(`   🔑 ${bundle}: key Supabase real inyectada desde .env.local`);
        }
    }
} else {
    console.warn('   ⚠️ SUPABASE_KEY de .env.local parece truncada — el bundle conservará el placeholder (NO desplegar así)');
}

// 3. Copiar style.css a dist/
console.log('📂 Copying assets to dist/...');
fs.copyFileSync('style.css', 'dist/style.css');

// 3b. Copiar logo a dist/ (imagen del login)
if (fs.existsSync('logo.png')) {
    fs.copyFileSync('logo.png', 'dist/logo.png');
    console.log('   ✅ dist/logo.png copied');
}

// 4. Copiar Service Worker a dist/
if (fs.existsSync('sw.js')) {
    fs.copyFileSync('sw.js', 'dist/sw.js');
    console.log('   ✅ dist/sw.js copied');
}

// 5. Copiar HTML files a dist/
const htmlFiles = ['index.html', 'login.html', 'admin.html', 'cliente.html', 'superadmin.html', 'planes.html', 'trabajador.html'];
for (const f of htmlFiles) {
    if (fs.existsSync(f)) {
        let content = fs.readFileSync(f, 'utf-8');
        // Reemplazar rutas de scripts en HTML
        // Los HTML fuente ya tienen src="dist/...", los reemplazamos sin dist/
        // porque en Vercel el outputDirectory=dist pone los archivos en la raiz
        content = content.replace(/src="dist\/app\.js"/g, 'src="app.js"');
        content = content.replace(/src="dist\/legacy\.js"/g, 'src="legacy.js"');
        fs.writeFileSync(path.join('dist', f), content);
        console.log(`   ✅ dist/${f} (paths updated)`);
    }
}

console.log('\n✅ Build complete!');
console.log('   Files in dist/:');
let totalSize = 0;
for (const f of fs.readdirSync('dist')) {
    const stats = fs.statSync(path.join('dist', f));
    const sizeKB = (stats.size / 1024).toFixed(1);
    totalSize += stats.size;
    console.log(`   - ${f} (${sizeKB} KB)`);
}
console.log(`   Total: ${(totalSize / 1024).toFixed(1)} KB`);
