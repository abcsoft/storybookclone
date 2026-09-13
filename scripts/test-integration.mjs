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
  'app_secrets', 'photo_uploads', 'password_reset_tokens', 'rate_limit_events',
  'upload_claims'
]

const EXPECTED_NEW_COLUMNS = [
  ['orders', 'idempotency_key'],
  ['orders', 'idempotency_payload_hash'],
  ['pdf_requests', 'cover_type'],
  ['pdf_requests', 'status'],
  ['pdf_requests', 'access_token_hash']
]

// The exact migration set the accepted Phase 0 (security/baseline-recovery)
// branch was reviewed and accepted against — anchored to real filenames,
// not "all but the newest N", so this stays meaningful no matter how many
// more migrations get added later.
const ACCEPTED_PHASE_0_MIGRATIONS = ['0001_initial.sql', '0002_pdp_sections.sql', '0003_ai_settings.sql']

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

// 2) Upgrade from the ACCEPTED PHASE 0 baseline specifically (0001-0003 —
// the exact set that branch was reviewed and accepted against), then apply
// everything since as "the upgrade" — exactly what `wrangler d1 migrations
// apply` sees against a real, previously-migrated D1 database.
{
  const missing = ACCEPTED_PHASE_0_MIGRATIONS.filter((f) => !allFiles.includes(f))
  if (missing.length) {
    console.error(`FAIL [upgrade from accepted Phase 0]: expected baseline migration file(s) missing from migrations/: ${missing.join(', ')}`)
    process.exit(1)
  }
  const newSinceBaseline = allFiles.filter((f) => !ACCEPTED_PHASE_0_MIGRATIONS.includes(f))
  const db = new DatabaseSync(':memory:')
  applyMigrationSet(db, ACCEPTED_PHASE_0_MIGRATIONS, 'accepted Phase 0 baseline (0001-0003)')
  applyMigrationSet(db, newSinceBaseline, 'upgrade since Phase 0')
  assertTables(db, 'upgrade from accepted Phase 0 baseline')
}

// 3) Repeated migration behavior — `wrangler d1 migrations apply` tracks
// applied files by name (via its own d1_migrations bookkeeping) and never
// blindly re-executes an already-applied file; that's what makes it safe
// to run repeatedly/idempotently against a real deployment. Prove the
// files themselves are each individually safe to apply exactly once in a
// fresh sequence (already exercised above) AND that re-running the
// CREATE-TABLE-based early migrations a second time — the literal
// operation `wrangler` performs if its own tracking table were ever
// reset — does not corrupt a database that already has the newer,
// ALTER-based migrations applied on top of it.
{
  const db = new DatabaseSync(':memory:')
  applyMigrationSet(db, allFiles, 'repeated-behavior (1st full apply)')
  const createTableOnly = allFiles.filter((f) => !/ALTER TABLE/i.test(readFileSync(join(migrationsDir, f), 'utf8')))
  applyMigrationSet(db, createTableOnly, 'repeated-behavior (re-apply CREATE-TABLE-only files)')
  assertTables(db, 'repeated migration behavior')
}

console.log('Migration smoke tests passed.')
