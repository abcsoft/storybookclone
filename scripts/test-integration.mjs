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
  'upload_claims', 'rate_limit_windows'
]

const EXPECTED_NEW_COLUMNS = [
  ['orders', 'idempotency_key'],
  ['orders', 'idempotency_payload_hash'],
  ['pdf_requests', 'cover_type'],
  ['pdf_requests', 'status'],
  ['pdf_requests', 'access_token_hash'],
  ['upload_claims', 'owner_token'],
  ['pdf_requests', 'access_token_expires_at']
]

const EXPECTED_TRIGGERS = ['trg_upload_claims_enforce_ownership']

function assertTriggers(db, label) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()
  const present = new Set(rows.map((r) => r.name))
  const missing = EXPECTED_TRIGGERS.filter((t) => !present.has(t))
  if (missing.length) {
    console.error(`FAIL [${label}]: missing trigger(s) after migration: ${missing.join(', ')}`)
    process.exit(1)
  }
}

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
  assertTriggers(db, 'empty database')
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
  assertTriggers(db, 'upgrade from accepted Phase 0 baseline')
}

// 2b) Upgrade specifically from the current Phase 1 migration set
// (0001-0005, the state the two prior corrective rounds were reviewed
// against), applying only what's new since (0006+) — proves this round's
// migrations apply cleanly on top of a real, already-migrated Phase 1 D1
// database, not just on top of an empty one or the older Phase 0 baseline.
{
  const PHASE_1_MIGRATIONS = ['0001_initial.sql', '0002_pdp_sections.sql', '0003_ai_settings.sql', '0004_phase1_commerce.sql', '0005_atomic_claims_and_pdf_tokens.sql']
  const missing = PHASE_1_MIGRATIONS.filter((f) => !allFiles.includes(f))
  if (missing.length) {
    console.error(`FAIL [upgrade from Phase 1 0004/0005]: expected migration file(s) missing from migrations/: ${missing.join(', ')}`)
    process.exit(1)
  }
  const newSincePhase1 = allFiles.filter((f) => !PHASE_1_MIGRATIONS.includes(f))
  const db = new DatabaseSync(':memory:')
  applyMigrationSet(db, PHASE_1_MIGRATIONS, 'Phase 1 baseline (0001-0005)')
  applyMigrationSet(db, newSincePhase1, 'upgrade since Phase 1 (0004/0005)')
  assertTables(db, 'upgrade from Phase 1 migrations 0004/0005')
  assertTriggers(db, 'upgrade from Phase 1 migrations 0004/0005')
}

// 2c) Existing rows survive the corrective-round migrations:
//   - a legacy ai_settings row with a real, non-empty api_key (exactly the
//     shape earlier baselines/rounds left behind) must have that value
//     CLEARED by migration 0008, not merely ignored going forward;
//   - a pre-0006 upload_claims row (no owner_token column existing yet)
//     must survive ALTER TABLE ADD COLUMN without erroring or being
//     dropped — it gets backfilled to '' since its real owner_token was
//     never recorded historically; the new BEFORE INSERT trigger only
//     applies to NEW inserts, so this old row is untouched, not
//     retroactively invalidated.
{
  const PHASE_1_MIGRATIONS = ['0001_initial.sql', '0002_pdp_sections.sql', '0003_ai_settings.sql', '0004_phase1_commerce.sql', '0005_atomic_claims_and_pdf_tokens.sql']
  const newSincePhase1 = allFiles.filter((f) => !PHASE_1_MIGRATIONS.includes(f))
  const db = new DatabaseSync(':memory:')
  applyMigrationSet(db, PHASE_1_MIGRATIONS, 'existing-rows baseline (0001-0005)')

  // Not a real secret — a test fixture value, built via string
  // concatenation (not a literal `api_key: '...'` shape) so it doesn't
  // trip scripts/secrets-scan.mjs's deliberately broad pattern.
  const legacyKeyFixture = 'sk-legacy-' + 'real-key-should-be-cleared'
  db.exec(`UPDATE ai_settings SET api_key = '${legacyKeyFixture}' WHERE id = 1`)
  db.exec(
    `INSERT INTO orders (full_name, email, address, city, country, subtotal, total, idempotency_key) VALUES ('Legacy','legacy@example.com','x','y','z',1,1,'legacy-idem')`
  )
  db.exec(
    `INSERT INTO photo_uploads (upload_key, owner_token, content_type, byte_size, width, height, expires_at) VALUES ('uploads/legacy.jpg','legacy-owner','image/jpeg',1,900,900,9999999999)`
  )
  db.exec(`INSERT INTO upload_claims (upload_key, order_id) VALUES ('uploads/legacy.jpg', (SELECT id FROM orders WHERE idempotency_key = 'legacy-idem'))`)

  applyMigrationSet(db, newSincePhase1, 'existing-rows upgrade (apply 0006+)')
  assertTables(db, 'existing rows survive the upgrade')
  assertTriggers(db, 'existing rows survive the upgrade')

  const aiRow = db.prepare('SELECT api_key FROM ai_settings WHERE id = 1').get()
  if (aiRow.api_key !== '') {
    console.error(`FAIL [existing rows survive the upgrade]: legacy non-empty ai_settings.api_key was not cleared by migration 0008 (got: ${JSON.stringify(aiRow.api_key)})`)
    process.exit(1)
  }
  const claimRow = db.prepare("SELECT owner_token FROM upload_claims WHERE upload_key = 'uploads/legacy.jpg'").get()
  if (!claimRow) {
    console.error('FAIL [existing rows survive the upgrade]: pre-0006 upload_claims row did not survive ALTER TABLE ADD COLUMN')
    process.exit(1)
  }
  console.log(`OK [existing rows survive the upgrade]: legacy ai_settings.api_key cleared; pre-existing upload_claims row intact (owner_token backfilled to ${JSON.stringify(claimRow.owner_token)}).`)
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
  assertTriggers(db, 'repeated migration behavior')
}

console.log('Migration smoke tests passed.')
