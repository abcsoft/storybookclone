#!/usr/bin/env node
// Migration smoke test (Phase 0 acceptance gate: "Add migration smoke tests
// from an empty database and from the existing baseline").
//
// Uses Node's built-in node:sqlite as a deterministic local SQLite engine —
// no network, no real Cloudflare account, no wrangler process required, so
// this is safe to run in CI. It applies the real files under migrations/ in
// order, exactly as `wrangler d1 migrations apply` would apply them to D1
// (D1 is SQLite-compatible), then asserts every expected table exists.
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const migrationsDir = join(root, 'migrations')
const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()

const EXPECTED_TABLES = [
  'users', 'sessions', 'products', 'discounts', 'orders', 'order_items',
  'contacts', 'newsletter', 'pdp_page', 'pdp_gallery', 'pdp_accordions',
  'pdp_steps', 'pdp_photo_tips', 'pdp_magic', 'pdp_trust', 'pdp_reactions',
  'pdp_media', 'pdp_related', 'pdp_faqs', 'ai_settings', 'pdf_requests'
]

function applyMigrations(db, label) {
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
  console.log(`OK [${label}]: all ${EXPECTED_TABLES.length} expected tables present.`)
}

// 1) Empty database
{
  const db = new DatabaseSync(':memory:')
  applyMigrations(db, 'empty database')
  assertTables(db, 'empty database')
  db.close()
}

// 2) "Existing baseline" — migrations are forward-only and every CREATE TABLE
// uses IF NOT EXISTS, so re-applying the full set on top of an already-migrated
// database must be a safe no-op (this is what a redeploy / repeat `migrations
// apply` does in practice).
{
  const db = new DatabaseSync(':memory:')
  applyMigrations(db, 'baseline (1st apply)')
  applyMigrations(db, 'baseline (re-apply)')
  assertTables(db, 'existing baseline (re-applied)')
  db.close()
}

console.log('Migration smoke tests passed.')
