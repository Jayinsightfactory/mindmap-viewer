#!/usr/bin/env node
'use strict';
/**
 * bin/migrate.js — CLI migration runner
 *
 * Usage: node bin/migrate.js
 *        npm run migrate
 *
 * Requires DATABASE_URL environment variable for PostgreSQL.
 */
require('dotenv').config();

const { Pool } = require('pg');
const { runMigrations } = require('../src/migrate');

if (!process.env.DATABASE_URL) {
  console.error('[migrate] DATABASE_URL not set. Migrations are for PostgreSQL only.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  connectionTimeoutMillis: 5000,
});

(async () => {
  try {
    await runMigrations(pool);
  } catch (e) {
    console.error('[migrate] Fatal error:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
