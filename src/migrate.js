'use strict';
/**
 * migrate.js — Simple database migration runner
 *
 * Migrations are SQL files in /migrations/ directory.
 * Each file: NNNN_description.sql
 * Tracks applied migrations in `_migrations` table.
 */
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

/**
 * Splits a SQL script into top-level executable statements while preserving
 * dollar-quoted blocks ($$ ... $$, $tag$ ... $tag$), quoted strings, and comments.
 * Needed so migrations containing CREATE/DROP INDEX CONCURRENTLY run each statement
 * outside an implicit transaction block.
 */
function splitSqlStatements(sql) {
  const statements = [];
  let buf = '';
  let i = 0;
  const len = sql.length;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag = null;

  while (i < len) {
    const ch = sql[i];
    const next = i + 1 < len ? sql[i + 1] : '';

    if (inLineComment) {
      buf += ch;
      if (ch === '\n') inLineComment = false;
      i++;
      continue;
    }

    if (inBlockComment) {
      buf += ch;
      if (ch === '*' && next === '/') {
        buf += next;
        inBlockComment = false;
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if (dollarTag !== null) {
      if (sql.startsWith(dollarTag, i)) {
        buf += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else {
        buf += ch;
        i++;
      }
      continue;
    }

    if (inSingle) {
      buf += ch;
      if (ch === "'" && next === "'") {
        buf += next;
        i += 2;
      } else {
        if (ch === "'") inSingle = false;
        i++;
      }
      continue;
    }

    if (inDouble) {
      buf += ch;
      if (ch === '"' && next === '"') {
        buf += next;
        i += 2;
      } else {
        if (ch === '"') inDouble = false;
        i++;
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      buf += ch + next;
      inLineComment = true;
      i += 2;
      continue;
    }

    if (ch === '/' && next === '*') {
      buf += ch + next;
      inBlockComment = true;
      i += 2;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      buf += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      buf += ch;
      i++;
      continue;
    }

    if (ch === '$') {
      const m = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (m) {
        dollarTag = m[0];
        buf += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }

    if (ch === ';') {
      const trimmed = buf.trim();
      if (trimmed && trimmed.replace(/--[^\n]*\n?/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()) {
        statements.push(trimmed);
      }
      buf = '';
      i++;
      continue;
    }

    buf += ch;
    i++;
  }

  const tail = buf.trim();
  if (tail && tail.replace(/--[^\n]*\n?/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()) {
    statements.push(tail);
  }
  return statements;
}

async function runMigrations(pool) {
  // Create migrations tracking table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Get applied migrations
  const { rows } = await pool.query('SELECT name FROM _migrations ORDER BY name');
  const applied = new Set(rows.map(r => r.name));

  // Get migration files
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
    console.log('[migrate] migrations/ directory created');
    return;
  }

  // Only forward migrations: explicitly exclude rollback (*.down.sql) scripts
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    try {
      if (/\bCONCURRENTLY\b/i.test(sql)) {
        const statements = splitSqlStatements(sql);
        for (const stmt of statements) {
          await pool.query(stmt);
        }
      } else {
        await pool.query(sql);
      }
      await pool.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      console.log(`[migrate] applied: ${file}`);
      count++;
    } catch (e) {
      console.error(`[migrate] FAILED: ${file}: ${e.message}`);
      throw e; // Stop on error
    }
  }

  if (count === 0) {
    console.log('[migrate] all migrations already applied');
  } else {
    console.log(`[migrate] ${count} migration(s) applied`);
  }
}

module.exports = { runMigrations, splitSqlStatements };
