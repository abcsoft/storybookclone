#!/usr/bin/env node
// Migration smoke test (Phase 0/1 acceptance gate: "Add migration smoke
// tests from an empty database and from the existing [accepted] baseline").
//
// Uses Node's built-in node:sqlite as a deterministic local SQLite engine —
// no network, no real Cloudflare account, no wrangler process required, so
// this is safe to run in CI. It applies the real files under migrations/ in
// order, exactly as `wrangler d1 migrations apply` would (D1 is SQLite-
// compatible): each migration file is applied AT MOST ONCE, tracked by
// filename — never blindly re-executed. That distinction matters here
// because 0004+ uses `ALTER TABLE ADD COLUMN`, which (unlike `CREATE TABLE
// IF NOT EXISTS`) is not naturally idempotent if re-run raw.
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const migrationsDir = join(root, 'migrations')
const allFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()

const EXPECTED_TABLES = [
  'users', 'sessions', 'products', 'discounts', 'orders', 'order_items',
  'contacts', 'newsletter', 'pdp_page', 'pdp_gallery', 'pdp_accordions',
  'pdp_steps', 'pdp_photo_tips', 'pdp_magic', 'pdp_trust', 'pdp_reactions',
  'pdp_media', 'pdp_related', 'pdp_faqs', 'ai_settings', 'pdf_requests',
  'app_secrets', 'photo_uploads', 'password_reset_tokens', 'rate_limit_events'
]

const EXPECTED_NEW_COLUMNS = [
  ['orders', 'idempotency_key'],
  ['orders', 'idempotency_payload_hash'],
  ['pdf_requests', 'cover_type'],
  ['pdf_requests', 'status']
]

/** Applies a list of migration filenames, in order, exactly once each. */
function applyMigrationSet(db, files, label) {
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8')
    try {
      db.exec(sql)
    } catch (err) {
      console.error(`FAIL [${label}]: migration ${file} failed to apply:`, err.message)
      process.exit(1)
    }
  }
}

function assertTables(db, label) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
  const present = new Set(rows.map((r) => r.name))
  const missing = EXPECTED_TABLES.filter((t) => !present.has(t))
  if (missing.length) {
    console.error(`FAIL [${label}]: missing tables after migration: ${missing.join(', ')}`)
    process.exit(1)
  }
  for (const [table, column] of EXPECTED_NEW_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    if (!cols.includes(column)) {
      console.error(`FAIL [${label}]: ${table}.${column} missing after migration`)
      process.exit(1)
    }
  }
  console.log(`OK [${label}]: all ${EXPECTED_TABLES.length} expected tables + ${EXPECTED_NEW_COLUMNS.length} new columns present.`)
}

// 1) Empty database — apply every migration file, once each, in order.
{
  const db = new DatabaseSync(':memory:')
  applyMigrationSet(db, allFiles, 'empty database')
  assertTables(db, 'empty database')
  db.close()
}

// 2) Upgrade from the accepted baseline — simulate a database that already
// has every migration up to (and not including) the newest one applied
// (exactly what `wrangler d1 migrations apply` sees against a real,
// previously-migrated D1 database), then apply only the new migration(s).
{
  const previouslyApplied = allFiles.slice(0, -1)
  const newOnes = allFiles.slice(-1)
  if (newOnes.length === 0) {
    console.log('OK [upgrade from baseline]: no new migration beyond the accepted baseline yet — nothing to test.')
  } else {
    const db = new DatabaseSync(':memory:')
    applyMigrationSet(db, previouslyApplied, 'baseline (pre-existing)')
    applyMigrationSet(db, newOnes, 'baseline (upgrade)')
    assertTables(db, 'upgrade from accepted baseline')
  }
}

console.log('Migration smoke tests passed.')
