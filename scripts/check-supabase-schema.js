/**
 * scripts/check-supabase-schema.js
 *
 * Verificador de esquema SQL vs codigo JS.
 * + VERIFICACION DE SEGURIDAD:
 *   - RLS policies activas por tabla
 *   - Permisos de anon/public (no debe tener DELETE/UPDATE)
 *   - CHECK constraints
 *   - Funciones SECURITY DEFINER accesibles por anon
 *   - Storage buckets (MIME types, tamaño máximo)
 *
 * USO:
 *   node scripts/check-supabase-schema.js
 *
 * REQUISITO: npm install pg (ya instalado en node_modules/)
 * Lee el esquema real de la DB remota via supabase db dump y compara.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ============================================================
// 1. Obtener esquema real desde Supabase (via CLI)
// ============================================================
function getRealSchema() {
    console.log('[1/3] Extrayendo esquema desde Supabase...');
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
// 2. Extraer tablas, columnas, policies, grants, checks del dump
// ============================================================
function parseSchema(sqlDump) {
    const tables = {};
    let currentTable = null;
    let inTable = false;
    const security = {
        policies: [],
        grants: [],
        checks: [],
        functions: [],
        storage_buckets: [],
    };
    const lines = sqlDump.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Detecta "CREATE TABLE IF NOT EXISTS "public"."tablename""
        const tableMatch = line.match(/CREATE\s+TABLE(?:s+IFs+NOTs+EXISTS)?s+"public"."(\w+)"s*\(/i);
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
            if (line.includes(');')) {
                inTable = false;
                currentTable = null;
            }
        }

        // Detecta funciones SECURITY DEFINER
        const funcMatch = line.match(/CREATE OR REPLACE FUNCTION\s+public\.(\w+)/i);
        if (funcMatch) {
            const fnName = funcMatch[1];
            const lookahead = (lines[i + 1] || '') + (lines[i + 2] || '') + (lines[i + 3] || '');
            const isSecurityDefiner = lookahead.includes('SECURITY DEFINER');
            security.functions.push({ name: fnName, security_definer: isSecurityDefiner });
        }

        // Detecta RLS policies
        const policyMatch = line.match(/CREATE POLICY\s+"([^"]+)"\s+ON\s+(?:"([^"]+)"\\.)?"?(\w+)"?\s+FOR\s+(\w+)\s+TO\s+(\w+)/i);
        if (policyMatch) {
            security.policies.push({
                name: policyMatch[1],
                table: policyMatch[3] || policyMatch[2],
                command: policyMatch[4],
                role: policyMatch[5]
            });
        }

        // Detecta GRANT statements
        const grantMatch = line.match(/GRANT\s+(\w+(?:\s*,\s*\w+)*)\s+ON\s+(?:"([^"]+)"\.)?"?(\w+)"?\s+TO\s+(\w+)/i);
        if (grantMatch) {
            security.grants.push({
                permissions: grantMatch[1],
                table: grantMatch[3] || grantMatch[2],
                role: grantMatch[4]
            });
        }

        // Detecta CHECK constraints
        const checkMatch = line.match(/ADD CONSTRAINT\s+(\w+)\s+CHECK\s*\(([^)]+)\)/i);
        if (checkMatch && currentTable) {
            security.checks.push({
                table: currentTable,
                constraint: checkMatch[1],
                condition: checkMatch[2].substring(0, 60)
            });
        }

        // Detecta bucket storage
        const bucketMatch = line.match(/INSERT INTO storage\.buckets.*VALUES\s*\([^)]+'([^']+)'/i);
        if (bucketMatch) {
            const fullLine = lines[i] + ' ' + (lines[i + 1] || '');
            const mimeMatch = fullLine.match(/allowed_mime_types[^}]*\{([^}]+)\}/);
            const sizeMatch = fullLine.match(/file_size_limit[^,]*,\s*(\d+)/);
            security.storage_buckets.push({
                name: bucketMatch[1],
                mime_types: mimeMatch ? mimeMatch[1] : 'unknown',
                size_limit: sizeMatch ? parseInt(sizeMatch[1]) : 'unknown'
            });
        }
    }

    return { tables, security };
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

        const fromMatches = content.matchAll(/\\.from\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
        for (const m of fromMatches) {
            const table = m[1];
            if (!used[table]) used[table] = { columns: [], selects: [], updates: [], inserts: [], files: [] };

            if (!used[table].files.includes(relativePath)) {
                used[table].files.push(relativePath);
            }

            const afterFrom = content.substring(m.index, Math.min(m.index + 500, content.length));
            const selectMatch = afterFrom.match(/\\.select\s*\(\s*['"]([^'"]+)['"]/);
            if (selectMatch) {
                const cols = selectMatch[1].split(/\s*,\s*/);
                used[table].selects.push(...cols.map(c => c.trim()));
            }

            const eqMatches = afterFrom.matchAll(/\.eq\s*\(\s*['"]([^'"]+)['"]/g);
            for (const eq of eqMatches) {
                if (!eq[1].startsWith('_')) {
                    used[table].columns.push(eq[1]);
                }
            }
        }

        const updateMatches = content.matchAll(/\\.update\s*\(\s*\{([^}]+)\}/gs);
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
// 4. Verificar SEGURIDAD
// ============================================================
function verifySecurity(security) {
    console.log();
    console.log('═══════════════════════════════════════');
    console.log('  VERIFICACION DE SEGURIDAD');
    console.log('═══════════════════════════════════════');

    const TABLAS_PUBLICAS = ['citas', 'servicios', 'tenants', 'trabajadores', 'servicios_trabajadores', 'tenant_config', 'notificaciones_admin', 'subscriptions', 'usuarios_con_rol'];
    const issues = [];

    // 4a. Verificar que anon NO tenga DELETE/UPDATE/TRUNCATE
    console.log('\n--- Permisos de anon (no debe tener DELETE/UPDATE) ---');
    const anonGrants = security.grants.filter(g => g.role.toLowerCase() === 'anon');
    for (const g of anonGrants) {
        const perms = g.permissions.toLowerCase();
        if (perms.includes('delete') || perms.includes('update') || perms.includes('truncate')) {
            if (g.table !== 'citas' || !perms.includes('select')) { // citas necesita SELECT e INSERT
                issues.push(`⚠️  anon tiene ${g.permissions} en ${g.table}`);
                console.log(`   ⚠️  ${g.permissions} en ${g.table}`);
            }
        }
        if (perms.includes('trigger') || perms.includes('references')) {
            issues.push(`⚠️  anon tiene ${g.permissions} en ${g.table} (privilegio innecesario)`);
            console.log(`   ⚠️  ${g.permissions} en ${g.table}`);
        }
    }
    if (issues.length === 0) {
        console.log('   ✅ anon sin permisos peligrosos');
    }

    // 4b. Verificar RLS policies por tabla
    console.log('\n--- RLS Policies por tabla ---');
    for (const table of TABLAS_PUBLICAS) {
        const policies = security.policies.filter(p => p.table === table);
        if (policies.length === 0) {
            console.log(`   ⚠️  ${table}: SIN POLICIES RLS  (acceso denegado por defecto para anon, verificar authenticated)`);
            continue;
        }
        console.log(`   📋 ${table}: ${policies.length} policy(ies)`);
        for (const p of policies) {
            console.log(`       ${p.command.toUpperCase()} → ${p.role}  "${p.name}"`);
        }

        // Verificar que las policies de authenticated no sean USING(true) sin restricción
        const permissiveSelect = policies.filter(p =>
            p.role === 'authenticated' && p.command === 'select'
        );
        for (const p of permissiveSelect) {
            console.log(`       ⚠️  Policy SELECT en ${table} para authenticated — verificar que no sea USING(true) sin tenant isolation`);
        }
    }

    // 4c. Verificar CHECK constraints
    console.log('\n--- CHECK constraints ---');
    const expectedChecks = {
        servicios: ['precio >= 0', 'nombre >= 2', 'descripcion <= 2000'],
        citas: ['precio >= 0', 'formato HH:MM'],
        trabajadores: ['nombre >= 2', 'tipo_jornada IN'],
        tenants: ['email', 'nombre >= 2', 'plan IN'],
        subscriptions: ['plan IN'],
        notificaciones_admin: ['tipo IN']
    };
    for (const [table, expected] of Object.entries(expectedChecks)) {
        const checks = security.checks.filter(c => c.table === table);
        if (checks.length === 0) {
            console.log(`   ⚠️  ${table}: SIN CHECK CONSTRAINTS`);
            continue;
        }
        const allFound = expected.every(exp => checks.some(c => c.condition.toLowerCase().includes(exp.toLowerCase())));
        if (allFound) {
            console.log(`   ✅ ${table}: ${checks.length} constraints`);
        } else {
            console.log(`   ⚠️  ${table}: ${checks.length} constraints (pueden faltar algunas)`);
        }
    }

    // 4d. Verificar funciones SECURITY DEFINER accesibles por anon
    console.log('\n--- Funciones SECURITY DEFINER ---');
    const sdFunctions = security.functions.filter(f => f.security_definer);
    const riskySdFunctions = sdFunctions.filter(f =>
        ['set_tenant', 'create_initial_subscription', 'get_all_users_for_superadmin', 'rls_auto_enable', 'crear_tenant_completo'].includes(f.name)
    );
    if (riskySdFunctions.length > 0) {
        console.log(`   ⚠️  ${riskySdFunctions.length} función(es) SECURITY DEFINER sensibles:`);
        for (const f of riskySdFunctions) {
            console.log(`       - public.${f.name} — verificar que anon no tenga EXECUTE`);
        }
        console.log('   ℹ️  Ejecutar: \\dp public.<funcion> para verificar permisos');
    } else {
        console.log('   ✅ Sin funciones SECURITY DEFINER riesgosas detectadas');
    }

    // 4e. Storage buckets
    console.log('\n--- Storage Buckets ---');
    if (security.storage_buckets.length === 0) {
        console.log('   ℹ️  No se detectaron buckets en el dump (pueden estar configurados manualmente)');
    } else {
        for (const b of security.storage_buckets) {
            const sizeOK = typeof b.size_limit === 'number' && b.size_limit <= 5242880;
            const mimeOK = b.mime_types.includes('image/jpeg') && b.mime_types.includes('image/png');
            console.log(`   ${sizeOK && mimeOK ? '✅' : '⚠️'} ${b.name}: ${(b.size_limit / 1024 / 1024).toFixed(0)}MB, ${b.mime_types}`);
        }
    }

    return issues;
}

// ============================================================
// 5. Comparar y reportar (esquema original)
// ============================================================
function compareAndReport(tables, usedColumns, security) {
    console.log('\n[3/3] Comparando esquema...\n');
    let errores = 0;
    let advertencias = 0;

    for (const [table, info] of Object.entries(usedColumns)) {
        if (table === '_updates_') continue;

        const realTable = tables[table];

        if (!realTable) {
            console.log(`❌ TABLA NO EXISTE: "${table}"`);
            console.log(`   Usada en: ${info.files.join(', ')}`);
            errores++;
            continue;
        }

        for (const col of info.columns) {
            if (!realTable.columns.includes(col)) {
                console.log(`❌ COLUMNA NO EXISTE: "${table}.${col}"`);
                console.log(`   Columnas reales: [${realTable.columns.join(', ')}]`);
                console.log(`   Usada en: ${info.files.join(', ')}`);
                errores++;
            }
        }

        for (const col of info.selects) {
            const colName = col.split(/\s+/).pop();
            if (!realTable.columns.includes(colName) && !colName.includes('(')) {
                console.log(`⚠️  POSIBLE COLUMNA FALTANTE: "${table}.${colName}"`);
                console.log(`   Usada en: ${info.files.join(', ')}`);
                advertencias++;
            }
        }
    }

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

    const realFunctions = (security?.functions || []).map(f => f.name);
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

    // Verificación de seguridad
    const securityIssues = verifySecurity(security);

    return { errores, advertencias };
}

// ============================================================
// Main
// ============================================================
console.log('=== Verificador de esquema Supabase + Seguridad ===\n');

const startTime = Date.now();
const sqlDump = getRealSchema();
const { tables: realSchema, security } = parseSchema(sqlDump);
const usedColumns = extractUsedColumns();
const compareResult = compareAndReport(realSchema, usedColumns, security);

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\nDuracion: ${elapsed}s`);

process.exit(compareResult.errores > 0 ? 1 : 0);
