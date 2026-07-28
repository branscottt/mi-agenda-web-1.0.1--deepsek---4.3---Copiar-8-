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

// 3. Copiar style.css a dist/
console.log('📂 Copying assets to dist/...');
fs.copyFileSync('style.css', 'dist/style.css');

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
        // Si están en formato module/defer (moderno) o simple (legacy)
        content = content.replace(/src="src\/main\.js"/g, 'type="module" src="dist/app.js"');
        content = content.replace(/src="script\.js"/g, 'defer src="dist/legacy.js"');
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
