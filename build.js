// build.js — Bundle + minificación segura con esbuild
// Reduce exposición de código fuente manteniendo compatibilidad total
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

// Asegurar que dist/ existe
if (!fs.existsSync('dist')) fs.mkdirSync('dist', { recursive: true });

console.log('📦 Building dist/app.js (modular bundle + minified)...');

// 1. Bundle main.js + todos sus imports dinámicos → dist/app.js
//    esbuild resuelve e inlinea los import() en tiempo de build
esbuild.buildSync({
    entryPoints: ['src/main.js'],
    bundle: true,
    format: 'iife',
    outfile: 'dist/app.js',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    keepNames: false,
    drop: ['debugger'],
    charset: 'utf8',
    target: ['es2020'],
});
console.log('   ✅ dist/app.js created');

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

// 4. Copiar HTML files a dist/
const htmlFiles = ['index.html', 'login.html', 'admin.html', 'cliente.html', 'superadmin.html', 'planes.html', 'trabajador.html'];
for (const f of htmlFiles) {
    if (fs.existsSync(f)) {
        let content = fs.readFileSync(f, 'utf-8');
        // Reemplazar rutas de scripts en HTML
        content = content.replace(/src="src\/main\.js"/g, 'src="dist/app.js"');
        content = content.replace(/src="script\.js"/g, 'src="dist/legacy.js"');
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
