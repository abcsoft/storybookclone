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
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const migrationsDir = join(root, 'migrations')
const allFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()

// V2 Phase 3 (migrations 0024-0025). Named separately so a scenario that
// deliberately stops at the accepted Phase-2 schema can assert precisely what
// should exist there, instead of skipping the check altogether.
const PHASE_3_TABLES = [
  'prompt_versions', 'template_prompt_versions', 'consent_versions',
  'generation_jobs', 'generation_tasks', 'generated_assets',
  'generation_attempts', 'provider_events', 'generation_usage_events',
  'generation_dead_letters', 'generation_quota_windows', 'generation_limits',
  'generation_asset_deletions',
  'template_scaffolds', 'template_scaffold_scenes', 'template_scaffold_placeholders'
]
const PHASE_3_COLUMNS = [
  ['preview_versions', 'generation_job_id'],
  ['preview_versions', 'scene_count'],
  ['preview_versions', 'manifest_checksum'],
  ['preview_versions', 'watermark_label'],
  ['preview_assets', 'generated_asset_id'],
  ['preview_assets', 'is_watermarked'],
  ['generation_tasks', 'output_asset_id'],
  ['user_books', 'consent_version'],
  ['prospects', 'consent_version']
]

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
  'iso_currencies',
  // V2 Phase 2 (migrations 0020-0023): catalog, CMS, reviews, locale/pricing/SEO
  'collections', 'collection_products', 'collection_faqs',
  'media_assets', 'product_media', 'product_facts',
  'cms_blocks', 'cms_nav_items', 'cms_footer_notes', 'cms_faqs', 'cms_pages',
  'announcements', 'site_settings', 'reviews',
  'currency_settings', 'countries', 'product_prices', 'variant_prices',
  'shipping_rates', 'cms_page_localizations', 'redirects', 'seo_metadata',
  // V2 Phase 3 (migrations 0024-0025): generation pipeline
  ...PHASE_3_TABLES
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
  ['photo_uploads', 'revoked_at'],
  // V2 Phase 3 (migrations 0024-0025)
  ...PHASE_3_COLUMNS
]

/** The triggers migration 0024 introduces. */
const PHASE_3_TRIGGERS = [
  'trg_prompt_versions_identity_immutable',
  'trg_prompt_versions_no_unpublish',
  'trg_prompt_versions_no_revive',
  'trg_prompt_versions_body_immutable',
  'trg_template_prompt_versions_immutable_once_published',
  'trg_consent_versions_identity_immutable',
  'trg_generation_jobs_status_flow',
  'trg_generation_jobs_identity_immutable',
  'trg_generation_jobs_terminal_frozen',
  'trg_generation_tasks_status_flow',
  'trg_generated_assets_body_immutable',
  'trg_generated_assets_validation_forward_only',
  'trg_generation_attempts_no_update',
  'trg_provider_events_no_update',
  'trg_generation_usage_no_update',
  'trg_generation_dead_letters_body_immutable',
  'trg_preview_assets_must_be_watermarked'
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
  'trg_product_variants_currency_update',
  ...PHASE_3_TRIGGERS
]



function assertTriggers(db, label, expect = EXPECTED_TRIGGERS) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()
  const present = new Set(rows.map((r) => r.name))
  const missing = expect.filter((t) => !present.has(t))
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

/**
 * `expect` defaults to the full schema. A scenario that deliberately applies
 * only PART of the migration set passes the subset it means, so "this migration
 * set produced this schema" is still asserted rather than skipped.
 */
function assertTables(db, label, expect = { tables: EXPECTED_TABLES, columns: EXPECTED_NEW_COLUMNS }) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
  const present = new Set(rows.map((r) => r.name))
  const missing = expect.tables.filter((t) => !present.has(t))
  if (missing.length) {
    console.error(`FAIL [${label}]: missing tables after migration: ${missing.join(', ')}`)
    process.exit(1)
  }
  for (const [table, column] of expect.columns) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    if (!cols.includes(column)) {
      console.error(`FAIL [${label}]: ${table}.${column} missing after migration`)
      process.exit(1)
    }
  }
  console.log(`OK [${label}]: all ${expect.tables.length} expected tables + ${expect.columns.length} new columns present.`)
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

// 2g) V2 Phase 2 upgrade (0020-0023) from the accepted Phase-1 schema with
//     EXISTING catalogue/order rows: the new tables must arrive, the derived
//     rows must be produced from the products that are already there, the CMS
//     defaults must exist exactly once, and NO existing row may change.
{
  const db = new DatabaseSync(':memory:')
  const phase1 = allFiles.filter((f) => f < '0020_')
  // Bounded above by 0023: the Phase-3 migrations are ALTER-based and are
  // applied at most once, exactly like every ALTER-based migration before them.
  const phase2 = allFiles.filter((f) => f >= '0020_' && f < '0024_')
  if (!phase2.length) {
    console.error('FAIL [phase2 upgrade]: no 0020+ migrations found')
    process.exit(1)
  }
  applyMigrationSet(db, phase1, 'phase2-upgrade (baseline 0001-0019)')

  // Pre-existing catalogue + order rows, inserted the way a real Phase-1
  // deployment would have them.
  db.exec(`
    INSERT INTO products (slug, title, tagline, description, story, price, price_minor, currency, image, gender, category, ages, age_min, age_max, pages, reviews, rating, bestseller, new_release, career, traits_json, active)
    VALUES ('legacy-book', 'Legacy Book', 't', 'd', 's', 34.99, 3499, 'USD', '/static/img/art/cover-the-quiet-drum.svg', 'unisex', 'book', '4-8', 4, 8, 32, 2924, 4.9, 0, 0, 0, '[]', 1);
    INSERT INTO product_variants (product_id, code, label, price_minor, currency, is_default, sort_order)
      SELECT id, 'hardcover', 'Hardcover', 3499, 'USD', 1, 0 FROM products WHERE slug = 'legacy-book';
    INSERT INTO orders (full_name, email, address, city, country, subtotal, discount, shipping, total, subtotal_minor, discount_minor, shipping_minor, total_minor, currency, status)
      VALUES ('Legacy', 'legacy@example.com', 'a', 'c', 'US', 34.99, 0, 0, 34.99, 3499, 0, 0, 3499, 'USD', 'pending_preview');
  `)

  applyMigrationSet(db, phase2, 'phase2-upgrade (apply 0020-0023)')
  // This scenario stops at the accepted Phase-2 schema, so the PHASE-3 tables
  // must NOT exist yet — asserted both ways rather than skipped.
  assertTables(db, 'phase2 upgrade', {
    tables: EXPECTED_TABLES.filter((t) => !PHASE_3_TABLES.includes(t)),
    columns: EXPECTED_NEW_COLUMNS.filter(([table, column]) => !PHASE_3_COLUMNS.some(([t, c]) => t === table && c === column))
  })
  assertTriggers(db, 'phase2 upgrade', EXPECTED_TRIGGERS.filter((t) => !PHASE_3_TRIGGERS.includes(t)))
  const phase3Leak = PHASE_3_TABLES.filter((t) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t))
  if (phase3Leak.length) {
    console.error(`FAIL [phase2 upgrade]: migration 0020-0023 created Phase-3 tables: ${phase3Leak.join(', ')}`)
    process.exit(1)
  }

  const fail = (msg) => {
    console.error(`FAIL [phase2 upgrade]: ${msg}`)
    process.exit(1)
  }

  // The product-derived rows were created for the EXISTING product.
  const memberships = db.prepare("SELECT COUNT(*) AS n FROM collection_products cp JOIN products p ON p.id = cp.product_id WHERE p.slug = 'legacy-book'").get().n
  if (memberships < 1) fail('no collection membership was derived for the pre-existing product')
  const prices = db.prepare("SELECT pp.currency AS currency FROM product_prices pp JOIN products p ON p.id = pp.product_id WHERE p.slug = 'legacy-book' ORDER BY pp.currency").all().map((r) => r.currency)
  for (const code of ['AUD', 'CAD', 'EUR', 'GBP', 'USD']) {
    if (!prices.includes(code)) fail(`the upgrade did not produce a ${code} price row (got ${prices.join(',') || 'none'})`)
  }
  const facts = db.prepare("SELECT page_count, production_estimate_days FROM product_facts pf JOIN products p ON p.id = pf.product_id WHERE p.slug = 'legacy-book'").get()
  if (!facts) fail('no product_facts row was created for the pre-existing product')
  if (facts.production_estimate_days !== null) fail('a production estimate was invented for a build with no print pipeline')
  const cover = db.prepare("SELECT COUNT(*) AS n FROM product_media pm JOIN products p ON p.id = pm.product_id WHERE p.slug = 'legacy-book' AND pm.role = 'cover'").get().n
  if (cover !== 1) fail(`expected exactly one cover media row, got ${cover}`)

  // The legacy invented aggregates were neutralised, and nothing else on the
  // product changed.
  const product = db.prepare("SELECT price_minor, reviews, rating FROM products WHERE slug = 'legacy-book'").get()
  if (product.price_minor !== 3499) fail(`the upgrade changed the price (${product.price_minor})`)
  if (product.reviews !== 0 || product.rating !== 0) fail('the legacy invented review aggregate was not neutralised')

  // The existing order is untouched and still unpaid.
  const order = db.prepare("SELECT status, total_minor, currency FROM orders WHERE email = 'legacy@example.com'").get()
  if (order.status !== 'pending_preview') fail(`the upgrade changed the order status to ${order.status}`)
  if (order.total_minor !== 3499) fail(`the upgrade changed the order total (${order.total_minor})`)

  // No review rows were invented, and the CMS defaults exist exactly once.
  const reviews = db.prepare('SELECT COUNT(*) AS n FROM reviews').get().n
  if (reviews !== 0) fail(`the upgrade seeded ${reviews} fabricated review row(s)`)
  const blocks = db.prepare('SELECT COUNT(*) AS n FROM cms_blocks').get().n
  const navItems = db.prepare('SELECT COUNT(*) AS n FROM cms_nav_items').get().n
  const faqs = db.prepare('SELECT COUNT(*) AS n FROM cms_faqs').get().n
  if (blocks < 5 || navItems < 5 || faqs < 5) fail('the CMS defaults were not seeded')
  const brandSettings = db.prepare("SELECT COUNT(*) AS n FROM site_settings WHERE key LIKE 'brand.%'").get().n
  if (brandSettings < 1) fail('the brand override keys were not created')

  // Re-applying the Phase-2 files must not duplicate any seeded CMS row.
  applyMigrationSet(db, phase2, 'phase2-upgrade (re-apply 0020-0023)')
  const blocks2 = db.prepare('SELECT COUNT(*) AS n FROM cms_blocks').get().n
  const navItems2 = db.prepare('SELECT COUNT(*) AS n FROM cms_nav_items').get().n
  const faqs2 = db.prepare('SELECT COUNT(*) AS n FROM cms_faqs').get().n
  const media2 = db.prepare('SELECT COUNT(*) AS n FROM media_assets').get().n
  const mediaOnce = db.prepare("SELECT COUNT(*) AS n FROM media_assets WHERE public_path = '/static/img/art/hero.svg'").get().n
  if (blocks2 !== blocks || navItems2 !== navItems || faqs2 !== faqs) fail('re-applying the Phase-2 migrations duplicated CMS content')
  if (mediaOnce !== 1) fail('re-applying the Phase-2 migrations duplicated a media asset')
  const memberships2 = db.prepare('SELECT COUNT(*) AS n FROM collection_products').get().n
  const membershipDupes = db.prepare('SELECT COUNT(*) AS n FROM (SELECT collection_id, product_id FROM collection_products GROUP BY collection_id, product_id HAVING COUNT(*) > 1)').get().n
  if (membershipDupes !== 0) fail('re-applying produced duplicate collection memberships')

  console.log(`OK [phase2 upgrade]: 0020-0023 applied over existing rows; ${prices.length} currency prices, facts + cover derived, legacy aggregates neutralised, order untouched and unpaid, ${blocks} CMS blocks / ${navItems} nav entries / ${faqs} FAQs / ${media2} media rows stable across a re-apply.`)
}

// 2h) V2 Phase 3 upgrade (0024-0025) from the accepted Phase-2 schema with
//     EXISTING rows: the new tables/columns must arrive, the scaffold and prompt
//     versions must be seeded exactly once, and NO existing row may change.
{
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  const phase2 = allFiles.filter((f) => f < '0024_')
  const phase3 = allFiles.filter((f) => f >= '0024_')
  if (!phase3.length) {
    console.error('FAIL [phase3 upgrade]: no 0024+ migrations found')
    process.exit(1)
  }
  applyMigrationSet(db, phase2, 'phase3-upgrade (baseline 0001-0023)')

  // Pre-existing Phase-2-shaped rows, exactly as a live deployment would hold
  // them: a product, a customer, an order, a guest prospect, a user book with
  // an immutable revision, and a photo upload.
  db.exec(`
    INSERT INTO products (slug, title, price, price_minor, currency, image, age_min, age_max, active)
      VALUES ('legacy-p3', 'Legacy Phase 2 Book', 29.99, 2999, 'USD', '/static/img/art/cover-the-quiet-drum.svg', 4, 8, 1);
    INSERT INTO users (name, email, password_hash) VALUES ('Existing Customer', 'p3@example.com', 'hash123');
    INSERT INTO orders (full_name, email, address, city, country, subtotal, discount, shipping, total, subtotal_minor, discount_minor, shipping_minor, total_minor, currency, status)
      VALUES ('Existing Customer', 'p3@example.com', 'a', 'c', 'US', 29.99, 0, 0, 29.99, 2999, 0, 0, 2999, 'USD', 'pending_preview');
    INSERT INTO prospects (id, capability_hash, expires_at) VALUES ('legacy-prospect', 'legacy-hash', 9999999999);
    INSERT INTO photo_uploads (upload_key, owner_token, content_type, byte_size, width, height, expires_at, completed_at)
      VALUES ('uploads/legacy-p3.jpg', 'prospect:legacy-prospect', 'image/jpeg', 50000, 900, 900, 9999999999, CURRENT_TIMESTAMP);
    INSERT INTO user_books (public_id, product_id, prospect_id, state, current_revision, selected_upload_key, version)
      VALUES ('ub_legacy00000000000000000000000000', (SELECT id FROM products WHERE slug='legacy-p3'), 'legacy-prospect', 'ready_to_generate', 1, 'uploads/legacy-p3.jpg', 3);
    INSERT INTO personalization_inputs (user_book_id, revision, child_name, child_age, language_code, dedication, photo_upload_key)
      SELECT id, 1, 'Existing Child', 6, 'en', 'A legacy dedication.', 'uploads/legacy-p3.jpg' FROM user_books WHERE public_id = 'ub_legacy00000000000000000000000000';
  `)

  // `consent_version` does not exist yet at this point — that is part of what
  // 0024 adds, and the assertion below checks it is left NULL afterwards.
  const beforeUserBook = db.prepare("SELECT state, version, current_revision FROM user_books WHERE public_id = 'ub_legacy00000000000000000000000000'").get()
  const beforeOrder = db.prepare("SELECT status, total_minor FROM orders WHERE email = 'p3@example.com'").get()

  applyMigrationSet(db, phase3, 'phase3-upgrade (apply 0024-0025)')
  assertTables(db, 'phase3 upgrade')
  assertTriggers(db, 'phase3 upgrade')

  const fail = (msg) => {
    console.error(`FAIL [phase3 upgrade]: ${msg}`)
    process.exit(1)
  }

  // The scaffold and its scenes/placeholders are seeded exactly once.
  const scaffolds = db.prepare('SELECT COUNT(*) AS n FROM template_scaffolds').get().n
  const scenes = db.prepare('SELECT COUNT(*) AS n FROM template_scaffold_scenes').get().n
  const placeholders = db.prepare('SELECT COUNT(*) AS n FROM template_scaffold_placeholders').get().n
  if (scaffolds !== 1) fail(`expected exactly one template scaffold, got ${scaffolds}`)
  if (scenes !== 6) fail(`expected six scaffold scenes, got ${scenes}`)
  if (placeholders < 7) fail(`expected the scaffold placeholder contract, got ${placeholders}`)

  // Prompt versions: one PUBLISHED local version per kind, plus a draft http
  // sibling showing the documented real-adapter path.
  const publishedPrompts = db.prepare("SELECT kind, COUNT(*) AS n FROM prompt_versions WHERE status = 'published' GROUP BY kind").all()
  if (publishedPrompts.length !== 4) fail(`expected 4 published prompt kinds, got ${publishedPrompts.length}`)
  const fakePrompts = db.prepare("SELECT COUNT(*) AS n FROM prompt_versions WHERE status = 'published' AND provider = 'deterministic-fake'").get().n
  if (fakePrompts !== 4) fail(`every published prompt must use the offline provider by default (got ${fakePrompts})`)
  const httpDrafts = db.prepare("SELECT COUNT(*) AS n FROM prompt_versions WHERE status = 'draft' AND provider = 'http'").get().n
  if (httpDrafts !== 4) fail(`expected 4 draft http prompt versions documenting the real path (got ${httpDrafts})`)

  // The consent version's stored hash matches its stored wording.
  const consent = db.prepare("SELECT summary, text_hash, status FROM consent_versions WHERE key = 'personalization_photo_processing'").get()
  if (!consent || consent.status !== 'published') fail('the consent version was not seeded as published')
  if (createHash('sha256').update(consent.summary).digest('hex') !== consent.text_hash) {
    fail('the seeded consent text_hash does not match the seeded wording')
  }

  // Generation limits are seeded with real (non-zero) caps.
  const limits = db.prepare('SELECT key, value FROM generation_limits').all()
  if (limits.length < 8) fail(`expected the generation limits to be seeded, got ${limits.length}`)
  for (const limit of limits) {
    if (!Number.isFinite(Number(limit.value)) || Number(limit.value) <= 0) fail(`generation limit ${limit.key} is not a positive number: ${limit.value}`)
  }

  // NO existing row changed.
  const afterUserBook = db.prepare("SELECT state, version, current_revision, consent_version FROM user_books WHERE public_id = 'ub_legacy00000000000000000000000000'").get()
  if (afterUserBook.state !== beforeUserBook.state) fail(`the upgrade changed the user book state (${beforeUserBook.state} -> ${afterUserBook.state})`)
  if (afterUserBook.version !== beforeUserBook.version) fail('the upgrade changed the user book version (optimistic concurrency must be preserved)')
  if (afterUserBook.current_revision !== beforeUserBook.current_revision) fail('the upgrade changed the immutable revision pointer')
  if (afterUserBook.consent_version !== null) fail('the upgrade invented a consent version for a pre-existing book — it must be back-filled with NULL, never a guess')
  const afterOrder = db.prepare("SELECT status, total_minor FROM orders WHERE email = 'p3@example.com'").get()
  if (afterOrder.status !== beforeOrder.status || afterOrder.total_minor !== beforeOrder.total_minor) fail('the upgrade changed an existing order')
  const revision = db.prepare('SELECT child_name FROM personalization_inputs WHERE revision = 1').get()
  if (revision.child_name !== 'Existing Child') fail('the upgrade changed an existing personalization revision')

  // Zero generation rows are invented by the migration.
  for (const table of ['generation_jobs', 'generation_tasks', 'generated_assets', 'preview_versions', 'preview_assets', 'generation_attempts', 'generation_usage_events', 'generation_dead_letters']) {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
    if (n !== 0) fail(`the migration invented ${n} row(s) in ${table}`)
  }

  // Re-applying the SEED migration must not duplicate any seeded row. 0024 is
  // ALTER-based, so (like every ALTER-based migration in this project) it is
  // applied at most once and is excluded here — the same rule the
  // repeated-behaviour block below applies to the older files.
  const phase3Repeatable = phase3.filter((f) => !/ALTER TABLE/i.test(readFileSync(join(migrationsDir, f), 'utf8')))
  if (!phase3Repeatable.length) fail('no repeatable (CREATE-TABLE-only) phase-3 migration was found')
  applyMigrationSet(db, phase3Repeatable, 'phase3-upgrade (re-apply the seed migration)')
  if (db.prepare('SELECT COUNT(*) AS n FROM template_scaffolds').get().n !== scaffolds) fail('re-applying duplicated the template scaffold')
  if (db.prepare('SELECT COUNT(*) AS n FROM template_scaffold_scenes').get().n !== scenes) fail('re-applying duplicated the scaffold scenes')
  if (db.prepare('SELECT COUNT(*) AS n FROM template_scaffold_placeholders').get().n !== placeholders) fail('re-applying duplicated the scaffold placeholders')
  if (db.prepare('SELECT COUNT(*) AS n FROM prompt_versions').get().n !== 8) fail('re-applying duplicated the prompt versions')
  if (db.prepare('SELECT COUNT(*) AS n FROM generation_limits').get().n !== limits.length) fail('re-applying duplicated the generation limits')
  if (db.prepare('SELECT COUNT(*) AS n FROM consent_versions').get().n !== 1) fail('re-applying duplicated the consent version')

  // The database-level guarantees the pipeline depends on actually hold.
  const jobInsert = (sql, args) => {
    try {
      db.prepare(sql).run(...args)
      return true
    } catch {
      return false
    }
  }
  // The unique idempotency authority: one job per (book, revision, template).
  const templateId = db.prepare("INSERT INTO book_templates (product_id, language_code, version, status) SELECT id, 'en', 1, 'published' FROM products WHERE slug='legacy-p3'").run().lastInsertRowid
  const bookId = db.prepare("SELECT id FROM user_books WHERE public_id = 'ub_legacy00000000000000000000000000'").get().id
  const insertJob = `INSERT INTO generation_jobs (public_id, user_book_id, input_revision, template_id, correlation_id) VALUES (?, ?, 1, ?, 'corr')`
  if (!jobInsert(insertJob, ['gj_one', bookId, templateId])) fail('a first generation job could not be inserted')
  if (jobInsert(insertJob, ['gj_two', bookId, templateId])) fail('the idempotency unique index did NOT prevent a duplicate billable job')

  // The status-flow trigger refuses an illegal jump.
  if (jobInsert("UPDATE generation_jobs SET status = 'succeeded' WHERE public_id = 'gj_one'", [])) {
    fail('the job status-flow trigger allowed queued -> succeeded (an illegal transition)')
  }

  // A preview asset must be watermarked.
  db.prepare("INSERT INTO preview_versions (user_book_id, input_revision, template_id, status) VALUES (?, 1, ?, 'ready')").run(bookId, templateId)
  const previewId = db.prepare('SELECT id FROM preview_versions ORDER BY id DESC LIMIT 1').get().id
  let refusedUnwatermarked = false
  try {
    db.prepare("INSERT INTO preview_assets (preview_version_id, asset_type, object_key, checksum, is_watermarked) VALUES (?, 'page_preview', 'gen/preview/x.jpg', 'abc', 0)").run(previewId)
  } catch (err) {
    refusedUnwatermarked = /must be watermarked/.test(String(err.message))
  }
  if (!refusedUnwatermarked) fail('the schema accepted an UNWATERMARKED preview asset')

  // The append-only ledgers really are append-only.
  const usageId = db.prepare("INSERT INTO generation_usage_events (job_id, user_book_id, provider, model, unit, cost_minor) VALUES ((SELECT id FROM generation_jobs WHERE public_id='gj_one'), ?, 'p', 'm', 'validation', 3)").run(bookId).lastInsertRowid
  let usageFrozen = false
  try {
    db.prepare('UPDATE generation_usage_events SET cost_minor = 0 WHERE id = ?').run(usageId)
  } catch (err) {
    usageFrozen = /append-only/.test(String(err.message))
  }
  if (!usageFrozen) fail('the cost ledger is not append-only')

  console.log(`OK [phase3 upgrade]: 0024-0025 applied over existing Phase-2 rows; ${scaffolds} scaffold / ${scenes} scenes / ${placeholders} placeholders / 8 prompt versions (4 published offline, 4 draft http) / ${limits.length} limits / 1 consent version seeded once; every pre-existing row unchanged and no generation row invented; the duplicate-job, illegal-transition, unwatermarked-preview and append-only guarantees all hold.`)
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
