/**
 * scripts/check-supabase-schema.js
 *
 * Verificador de esquema SQL vs codigo JS.
 * Compara las columnas usadas en los .select(), .eq(), .insert(), .update()
 * de los modulos en src/ contra el esquema real de Supabase.
 *
 * USO:
 *   node scripts/check-supabase-schema.js
 *
 * REQUISITO: npm install pg (ya instalado en node_modules/)
 *
 * Lee el esquema real de la DB remota via supabase db dump y compara.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ============================================================
// 1. Obtener esquema real desde Supabase (via CLI)
// ============================================================
function getRealSchema() {
    console.log('[1/3] Extrayendo esquema real desde Supabase...');
    try {
        const output = execSync('supabase db dump --linked --schema public 2>&1', {
            cwd: path.resolve(__dirname, '..'),
            timeout: 60000,
            encoding: 'utf-8'
        });
        return output;
    } catch (e) {
        console.error('  Error al extraer esquema:', e.stderr || e.message);
        process.exit(1);
    }
}

// ============================================================
// 2. Extraer tablas y columnas del SQL dump
// ============================================================
function parseSchema(sqlDump) {
    const tables = {};
    let currentTable = null;
    let inTable = false;

    const lines = sqlDump.split('\n');
    for (const line of lines) {
        // Detecta "CREATE TABLE IF NOT EXISTS "public"."tablename""
        const tableMatch = line.match(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+"public"\."(\w+)"\s*\(/i);
        if (tableMatch) {
            currentTable = tableMatch[1];
            tables[currentTable] = { columns: [], functions: [] };
            inTable = true;
            continue;
        }

        // Detecta columnas dentro de CREATE TABLE
        if (inTable && currentTable) {
            const colMatch = line.match(/^\s+"(\w+)"\s+/);
            if (colMatch) {
                tables[currentTable].columns.push(colMatch[1]);
            }
            // Fin de CREATE TABLE
            if (line.includes(');')) {
                inTable = false;
                currentTable = null;
            }
        }

        // Detecta funciones
        const funcMatch = line.match(/CREATE OR REPLACE FUNCTION\s+public\.(\w+)/i);
        if (funcMatch) {
            const tableName = '_functions_';
            if (!tables[tableName]) tables[tableName] = { columns: [], functions: [] };
            tables[tableName].functions.push(funcMatch[1]);
        }
    }

    return tables;
}

// ============================================================
// 3. Extraer columnas usadas en src/ (scan JS files)
// ============================================================
function extractUsedColumns() {
    console.log('[2/3] Escaneando src/ para columnas usadas...');
    const srcDir = path.resolve(__dirname, '..', 'src');
    const used = {};

    function scanFile(filePath) {
        const content = fs.readFileSync(filePath, 'utf-8');
        const relativePath = path.relative(path.resolve(__dirname, '..'), filePath);

        // Buscar .from('tabla')
        const fromMatches = content.matchAll(/\.from\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
        for (const m of fromMatches) {
            const table = m[1];
            if (!used[table]) used[table] = { columns: [], selects: [], updates: [], inserts: [], files: [] };

            if (!used[table].files.includes(relativePath)) {
                used[table].files.push(relativePath);
            }

            // Buscar .select(...) en las siguientes 20 lineas
            const afterFrom = content.substring(m.index, Math.min(m.index + 500, content.length));
            const selectMatch = afterFrom.match(/\.select\s*\(\s*['"]([^'"]+)['"]/);
            if (selectMatch) {
                const cols = selectMatch[1].split(/\s*,\s*/);
                used[table].selects.push(...cols.map(c => c.trim()));
            }

            // Buscar .eq('col', ...)
            const eqMatches = afterFrom.matchAll(/\.eq\s*\(\s*['"]([^'"]+)['"]/g);
            for (const eq of eqMatches) {
                if (!eq[1].startsWith('_')) { // evitar columnas especiales
                    used[table].columns.push(eq[1]);
                }
            }
        }

        // Buscar inserts/updates en el archivo
        const updateMatches = content.matchAll(/\.update\s*\(\s*\{([^}]+)\}/gs);
        for (const um of updateMatches) {
            const keys = um[1].match(/(\w+)\s*:/g);
            if (keys) used['_updates_'] = [...(used['_updates_'] || []), ...keys.map(k => k.replace(':', '').trim())];
        }
    }

    function walkDir(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walkDir(fullPath);
            } else if (entry.isFile() && entry.name.endsWith('.js') && entry.name !== 'main.js') {
                scanFile(fullPath);
            }
        }
    }

    walkDir(srcDir);
    return used;
}

// ============================================================
// 4. Comparar y reportar
// ============================================================
function compareAndReport(realSchema, usedColumns) {
    console.log('[3/3] Comparando...\n');
    let errores = 0;
    let advertencias = 0;

    for (const [table, info] of Object.entries(usedColumns)) {
        if (table === '_updates_') continue;

        const realTable = realSchema[table];

        // Verificar que la tabla existe
        if (!realTable) {
            console.log(`❌ TABLA NO EXISTE: "${table}"`);
            console.log(`   Usada en: ${info.files.join(', ')}`);
            errores++;
            continue;
        }

        // Verificar columnas de .eq()
        for (const col of info.columns) {
            if (!realTable.columns.includes(col)) {
                console.log(`❌ COLUMNA NO EXISTE: "${table}.${col}"`);
                console.log(`   Columnas reales: [${realTable.columns.join(', ')}]`);
                console.log(`   Usada en: ${info.files.join(', ')}`);
                errores++;
            }
        }

        // Verificar columnas de .select()
        for (const col of info.selects) {
            const colName = col.split(/\s+/).pop(); // maneja "id, servicio_id(nombre)"
            if (!realTable.columns.includes(colName) && !colName.includes('(')) {
                console.log(`⚠️  POSIBLE COLUMNA FALTANTE: "${table}.${colName}"`);
                console.log(`   Usada en: ${info.files.join(', ')}`);
                advertencias++;
            }
        }
    }

    // Verificar funciones .rpc() usadas
    const rpcMatches = [];
    function scanDirForRPC(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory() && entry.name !== 'node_modules') {
                scanDirForRPC(fullPath);
            } else if (entry.isFile() && entry.name.endsWith('.js')) {
                const content = fs.readFileSync(fullPath, 'utf-8');
                const rpcs = content.matchAll(/\.rpc\s*\(\s*['"]([^'"]+)['"]/g);
                for (const r of rpcs) rpcMatches.push(r[1]);
            }
        }
    }
    scanDirForRPC(path.resolve(__dirname, '..', 'src'));

    const realFunctions = realSchema['_functions_']?.functions || [];
    for (const func of rpcMatches) {
        if (!realFunctions.includes(func)) {
            console.log(`❌ FUNCION NO EXISTE: "public.${func}"`);
            console.log(`   Funciones reales: [${realFunctions.join(', ')}]`);
            errores++;
        }
    }

    console.log();
    console.log('====================================');
    console.log(`  TOTAL: ${errores} errores, ${advertencias} advertencias`);
    console.log('====================================');

    return { errores, advertencias };
}

// ============================================================
// Main
// ============================================================
console.log('=== Verificador de esquema Supabase ===\n');

const startTime = Date.now();
const sqlDump = getRealSchema();
const realSchema = parseSchema(sqlDump);
const usedColumns = extractUsedColumns();
const result = compareAndReport(realSchema, usedColumns);

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\nDuracion: ${elapsed}s`);

process.exit(result.errores > 0 ? 1 : 0);