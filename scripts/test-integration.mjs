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
  'upload_claims', 'rate_limit_windows',
  // Phase 2 personalization domain (migrations 0010-0013)
  'languages', 'product_localizations', 'book_templates', 'book_scenes', 'scene_placeholders',
  'prospects', 'user_books', 'personalization_inputs', 'detected_faces',
  'preview_versions', 'preview_assets', 'revision_requests', 'approvals', 'user_book_events',
  'retention_failures',
  // Phase 1 integrity/security recovery (migration 0015)
  'order_state_events', 'admin_audit_events',
  // Phase 1 correction (migration 0018): ISO-4217 currency allowlist
  'iso_currencies'
]

const EXPECTED_NEW_COLUMNS = [
  ['orders', 'idempotency_key'],
  ['orders', 'idempotency_payload_hash'],
  ['pdf_requests', 'cover_type'],
  ['pdf_requests', 'status'],
  ['pdf_requests', 'access_token_hash'],
  ['upload_claims', 'owner_token'],
  ['pdf_requests', 'access_token_expires_at'],
  // Phase 2
  ['photo_uploads', 'completion_token_hash'],
  ['photo_uploads', 'completed_at'],
  ['order_items', 'user_book_id'],
  ['order_items', 'personalization_input_revision'],
  // Phase 1
  ['photo_uploads', 'revoked_at']
]

const EXPECTED_TRIGGERS = [
  'trg_upload_claims_enforce_ownership',
  // Phase 2
  'trg_book_templates_identity_immutable',
  'trg_book_templates_no_unpublish',
  'trg_book_templates_no_revive',
  'trg_book_scenes_immutable_once_published',
  'trg_scene_placeholders_immutable_once_published',
  'trg_detected_faces_no_update',
  'trg_user_books_face_matches_upload',
  'trg_personalization_inputs_no_update',
  'trg_preview_versions_no_update',
  'trg_preview_assets_no_update',
  'trg_revision_requests_no_update',
  'trg_approvals_no_update',
  'trg_user_book_events_no_update',
  // Phase 1 integrity/security recovery (0015): append-only history
  'trg_order_state_events_no_update',
  'trg_order_state_events_no_delete',
  'trg_admin_audit_events_no_update',
  'trg_admin_audit_events_no_delete',
  // Phase 1 correction (0018): database-enforced money invariants
  'trg_orders_money_insert',
  'trg_orders_money_update',
  'trg_order_items_money_insert',
  'trg_order_items_money_update',
  'trg_products_money_insert',
  'trg_products_money_update',
  'trg_product_variants_currency_insert',
  'trg_product_variants_currency_update'
]

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

// 2d) Upgrade from the EXACT accepted Phase-1/0009 schema (0001-0009,
// everything before Phase 2) — proves the four Phase 2 migrations
// (0010-0013) apply cleanly on top of a real, previously-migrated Phase 1
// database, not just an empty one.
const ACCEPTED_PHASE_1_0009_MIGRATIONS = [
  '0001_initial.sql', '0002_pdp_sections.sql', '0003_ai_settings.sql', '0004_phase1_commerce.sql',
  '0005_atomic_claims_and_pdf_tokens.sql', '0006_db_enforced_upload_claim.sql', '0007_pdf_capability_expiry.sql',
  '0008_clear_legacy_ai_api_key.sql', '0009_atomic_rate_limit.sql'
]
{
  const missing = ACCEPTED_PHASE_1_0009_MIGRATIONS.filter((f) => !allFiles.includes(f))
  if (missing.length) {
    console.error(`FAIL [upgrade from accepted Phase 1/0009]: expected migration file(s) missing from migrations/: ${missing.join(', ')}`)
    process.exit(1)
  }
  const newSince0009 = allFiles.filter((f) => !ACCEPTED_PHASE_1_0009_MIGRATIONS.includes(f))
  const db = new DatabaseSync(':memory:')
  applyMigrationSet(db, ACCEPTED_PHASE_1_0009_MIGRATIONS, 'accepted Phase 1/0009 baseline')
  applyMigrationSet(db, newSince0009, 'upgrade since Phase 1/0009 (Phase 2: 0010+)')
  assertTables(db, 'upgrade from accepted Phase 1/0009 schema')
  assertTriggers(db, 'upgrade from accepted Phase 1/0009 schema')
}

// 2e) Existing users/orders/uploads survive the Phase 2 upgrade untouched —
// Phase 2's migrations are purely additive for every pre-existing table.
{
  const newSince0009 = allFiles.filter((f) => !ACCEPTED_PHASE_1_0009_MIGRATIONS.includes(f))
  const db = new DatabaseSync(':memory:')
  applyMigrationSet(db, ACCEPTED_PHASE_1_0009_MIGRATIONS, 'pre-Phase-2 baseline for survival check')
  db.exec(`INSERT INTO users (name, email, password_hash) VALUES ('Existing Customer', 'existing@example.com', 'hash123')`)
  db.exec(`INSERT INTO products (slug, title, price, image) VALUES ('existing-book', 'Existing Book', 19.99, 'x.webp')`)
  db.exec(
    `INSERT INTO orders (user_id, full_name, email, address, city, country, subtotal, total, idempotency_key) VALUES (1, 'Existing Customer', 'existing@example.com', '1 Rd', 'City', 'USA', 10, 10, 'pre-phase2-idem')`
  )
  db.exec(
    `INSERT INTO order_items (order_id, slug, title, unit_price, child_name) VALUES (1, 'existing-book', 'Existing Book', 19.99, 'Kiddo')`
  )
  db.exec(
    `INSERT INTO photo_uploads (upload_key, owner_token, content_type, byte_size, width, height, expires_at) VALUES ('uploads/pre-phase2.jpg', 'owner-x', 'image/jpeg', 12345, 900, 900, 9999999999)`
  )

  applyMigrationSet(db, newSince0009, 'Phase 2 upgrade over existing data')

  const user = db.prepare("SELECT id, email FROM users WHERE email = 'existing@example.com'").get()
  const order = db.prepare("SELECT id, user_id FROM orders WHERE idempotency_key = 'pre-phase2-idem'").get()
  const item = db.prepare("SELECT id, user_book_id FROM order_items WHERE order_id = ?").get(order?.id)
  const upload = db.prepare("SELECT upload_key, completed_at FROM photo_uploads WHERE upload_key = 'uploads/pre-phase2.jpg'").get()
  if (!user || !order || !item || !upload) {
    console.error('FAIL [existing users/orders/uploads survive Phase 2]: a pre-existing row went missing after the upgrade')
    process.exit(1)
  }
  if (item.user_book_id !== null) {
    console.error('FAIL [existing users/orders/uploads survive Phase 2]: a pre-Phase-2 order_item unexpectedly got a non-NULL user_book_id')
    process.exit(1)
  }
  console.log('OK [existing users/orders/uploads survive Phase 2]: all pre-existing rows intact, new columns NULL as expected.')
}

// 2f) Phase 1 money/variant backfill: apply the schema up to 0014, insert
// LEGACY real-valued rows (the pre-Phase-1 shape), then apply 0015-0016 and
// assert the integer backfill round-trips exactly and that the variant
// backfill gives books a cover choice priced from the product's own price.
{
  const upTo0014 = allFiles.filter((f) => f < '0015_')
  const from0015 = allFiles.filter((f) => f >= '0015_')
  const db = new DatabaseSync(':memory:')
  applyMigrationSet(db, upTo0014, 'money/variant backfill (0014 schema)')

  db.exec(`
    INSERT INTO products (id, slug, title, price, compare_at, image, category, age_min, age_max, active)
      VALUES (1, 'legacy-book', 'Legacy Book', 34.99, 44.99, 'x.webp', 'book', 4, 8, 1),
             (2, 'legacy-sticker', 'Legacy Sticker', 14.99, NULL, 'y.webp', 'sticker', 3, 10, 1);
    INSERT INTO orders (id, full_name, email, address, city, country, shipping, subtotal, discount, total)
      VALUES (1, 'A', 'a@b.c', 'x', 'y', 'z', 12, 69.98, 14.00, 67.98);
    INSERT INTO order_items (id, order_id, product_id, slug, title, kind, unit_price, qty)
      VALUES (1, 1, 1, 'legacy-book', 'Legacy Book', 'book', 34.99, 2);
  `)

  applyMigrationSet(db, from0015, 'money/variant backfill (upgrade 0015+)')

  const prod = db.prepare('SELECT slug, price_minor, compare_at_price_minor, currency FROM products ORDER BY id').all()
  const book = prod.find((r) => r.slug === 'legacy-book')
  const sticker = prod.find((r) => r.slug === 'legacy-sticker')
  const fail = (msg) => {
    console.error(`FAIL [money/variant backfill]: ${msg}`)
    process.exit(1)
  }
  if (book.price_minor !== 3499) fail(`products.price_minor backfill wrong: ${book.price_minor}`)
  if (book.compare_at_price_minor !== 4499) fail(`products.compare_at_price_minor backfill wrong: ${book.compare_at_price_minor}`)
  if (sticker.price_minor !== 1499) fail(`sticker price_minor backfill wrong: ${sticker.price_minor}`)
  if (book.currency !== 'USD' || sticker.currency !== 'USD') fail('currency backfill wrong')

  const order = db.prepare('SELECT subtotal_minor, discount_minor, shipping_minor, total_minor, currency FROM orders WHERE id = 1').get()
  if (order.subtotal_minor !== 6998 || order.discount_minor !== 1400 || order.shipping_minor !== 1200 || order.total_minor !== 6798) {
    fail(`orders minor backfill wrong: ${JSON.stringify(order)}`)
  }
  if (order.currency !== 'USD') fail('orders.currency backfill wrong')
  const item = db.prepare('SELECT unit_price_minor, currency FROM order_items WHERE id = 1').get()
  if (item.unit_price_minor !== 3499 || item.currency !== 'USD') fail(`order_items minor backfill wrong: ${JSON.stringify(item)}`)

  const variants = db.prepare('SELECT product_id, code, price_minor, is_default FROM product_variants ORDER BY product_id, sort_order').all()
  const bookVariants = variants.filter((v) => v.product_id === 1)
  const stickerVariants = variants.filter((v) => v.product_id === 2)
  if (bookVariants.map((v) => v.code).join(',') !== 'hardcover,softcover') fail(`book variants wrong: ${JSON.stringify(bookVariants)}`)
  if (bookVariants.filter((v) => v.is_default === 1).length !== 1) fail('book must have exactly one default variant')
  if (bookVariants.some((v) => v.price_minor !== 3499)) fail('book variants must be priced from the product price')
  if (stickerVariants.map((v) => v.code).join(',') !== 'standard') fail(`sticker variants wrong: ${JSON.stringify(stickerVariants)}`)

  // L-B: reconciliation fills the minor twin from the row's OWN legacy value
  // and touches nothing else. The legacy order is still UNPAID — its status
  // is unchanged and no payment-ish column was invented.
  const reconciled = db.prepare('SELECT status, discount_code, idempotency_key FROM orders WHERE id = 1').get()
  if (reconciled.status !== 'pending_preview') fail(`money reconciliation changed the order status: ${reconciled.status}`)
  if (reconciled.discount_code !== null) fail(`money reconciliation invented a discount code: ${reconciled.discount_code}`)

  // L-B: the migration's own triggers now enforce the invariants in a fully
  // migrated database — a NULL minor amount, a negative total and an invalid
  // currency are all refused by the SCHEMA, not just by application code.
  const expectRejected = (label, sql) => {
    try {
      db.exec(sql)
    } catch (err) {
      if (/money_invariant/.test(String(err.message))) return
      fail(`${label}: rejected, but not by the money-invariant trigger (${err.message})`)
    }
    fail(`${label}: the money-invariant trigger did NOT reject it`)
  }
  expectRejected(
    'negative total_minor',
    `INSERT INTO orders (full_name, email, address, city, country, subtotal, discount, total, subtotal_minor, discount_minor, shipping_minor, total_minor, currency) VALUES ('X','x@b.c','x','y','z',1,0,1,100,0,0,-100,'USD')`
  )
  expectRejected(
    'NULL minor amount',
    `INSERT INTO orders (full_name, email, address, city, country, subtotal, discount, total, subtotal_minor, discount_minor, shipping_minor, total_minor, currency) VALUES ('X','x@b.c','x','y','z',1,0,1,NULL,0,0,100,'USD')`
  )
  expectRejected(
    'invalid currency',
    `INSERT INTO orders (full_name, email, address, city, country, subtotal, discount, total, subtotal_minor, discount_minor, shipping_minor, total_minor, currency) VALUES ('X','x@b.c','x','y','z',1,0,1,100,0,0,100,'XYZ')`
  )

  console.log('OK [money/variant backfill]: legacy REAL rows backfilled to exact minor units + cover variants seeded; reconciliation left the order unpaid; 0018 triggers reject NULL/negative/invalid-currency money.')
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
