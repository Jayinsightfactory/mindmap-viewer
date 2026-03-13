/* db-interface.js — DB interface validation (prevents SQLite/PG sync drift) */

/**
 * Reads module.exports from a DB module file and extracts exported function names.
 * Works with both `module.exports = { fn1, fn2 }` and `exports.fn = ...` patterns.
 */
const fs = require('fs');
const path = require('path');

function extractExports(filePath) {
  const src = fs.readFileSync(filePath, 'utf-8');
  const names = new Set();

  // Pattern 1: module.exports = { fn1, fn2, ... }
  const moduleExportsMatch = src.match(/module\.exports\s*=\s*\{([\s\S]*?)\};/);
  if (moduleExportsMatch) {
    const block = moduleExportsMatch[1];
    // Strip line comments, then extract all identifiers
    const cleaned = block
      .split('\n')
      .map(line => line.replace(/\/\/.*$/, ''))  // strip // comments
      .join(' ');
    // Match comma-separated identifiers (bare or aliased via key: value)
    // Handles: "fnName," and "fnName: actualFn," and "fnName" at end
    const tokens = cleaned.match(/\b(\w+)\s*(?::\s*\w+)?\s*[,}]/g) || [];
    for (const token of tokens) {
      const m = token.match(/^(\w+)/);
      if (m) names.add(m[1]);
    }
    // Also catch trailing identifier before closing brace (no comma)
    const trailingMatch = cleaned.match(/(\w+)\s*$/);
    if (trailingMatch) names.add(trailingMatch[1]);
  }

  // Pattern 2: exports.fnName = ... (individual exports)
  const individualExports = src.matchAll(/exports\.(\w+)\s*=/g);
  for (const m of individualExports) {
    names.add(m[1]);
  }

  return [...names].sort();
}

/**
 * Compares exported function lists from db.js and db-pg.js.
 * Returns { pass, sqliteOnly, pgOnly, shared }.
 */
function validateSync() {
  const dbPath = path.join(__dirname, 'db.js');
  const dbPgPath = path.join(__dirname, 'db-pg.js');

  if (!fs.existsSync(dbPath)) {
    return { pass: false, error: `File not found: ${dbPath}` };
  }
  if (!fs.existsSync(dbPgPath)) {
    return { pass: false, error: `File not found: ${dbPgPath}` };
  }

  const sqliteExports = extractExports(dbPath);
  const pgExports = extractExports(dbPgPath);

  const sqliteSet = new Set(sqliteExports);
  const pgSet = new Set(pgExports);

  const sqliteOnly = sqliteExports.filter(fn => !pgSet.has(fn));
  const pgOnly = pgExports.filter(fn => !sqliteSet.has(fn));
  const shared = sqliteExports.filter(fn => pgSet.has(fn));

  return {
    pass: sqliteOnly.length === 0 && pgOnly.length === 0,
    sqliteExportCount: sqliteExports.length,
    pgExportCount: pgExports.length,
    sharedCount: shared.length,
    sqliteOnly,
    pgOnly,
    shared,
  };
}

// ─── CLI: run as standalone script ──────────────────
if (require.main === module) {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   DB Interface Validation (SQLite ↔ PostgreSQL)     ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log();

  const result = validateSync();

  if (result.error) {
    console.error(`ERROR: ${result.error}`);
    process.exit(1);
  }

  console.log(`  db.js exports:    ${result.sqliteExportCount} functions`);
  console.log(`  db-pg.js exports: ${result.pgExportCount} functions`);
  console.log(`  Shared:           ${result.sharedCount} functions`);
  console.log();

  if (result.sqliteOnly.length > 0) {
    console.log('  ⚠ In db.js but MISSING from db-pg.js:');
    for (const fn of result.sqliteOnly) {
      console.log(`    - ${fn}`);
    }
    console.log();
  }

  if (result.pgOnly.length > 0) {
    console.log('  ⚠ In db-pg.js but MISSING from db.js:');
    for (const fn of result.pgOnly) {
      console.log(`    - ${fn}`);
    }
    console.log();
  }

  if (result.pass) {
    console.log('  ✅ PASS — All exports are in sync.');
  } else {
    console.log('  ❌ FAIL — Export mismatch detected!');
    console.log(`     Missing from db-pg.js: ${result.sqliteOnly.length}`);
    console.log(`     Missing from db.js:    ${result.pgOnly.length}`);
  }

  process.exit(result.pass ? 0 : 1);
}

module.exports = { validateSync, extractExports };
