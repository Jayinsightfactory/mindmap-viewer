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

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await pool.query(sql);
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

module.exports = { runMigrations };
