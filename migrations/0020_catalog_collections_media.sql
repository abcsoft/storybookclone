-- Migration 0020: catalog layer for the original storefront (V2 Phase 2).
-- Forward-only. Nothing in 0001-0019 is edited, reordered or dropped.
--
-- Scope (STORYBOOKCLONE_COMPLETE_CODING_PACK_V2.md §10 "Catalog", §12 Phase 2
-- items 5/6/8; requirement IDs SF-06, SF-07, SF-08, ADM-06):
--
--   * `collections` + `collection_products` — first-class curated groupings
--     (audience / theme / age / career / sticker / editorial). The homepage
--     sections, the catalog facets and the collection landing pages all read
--     from these instead of from hard-coded slug lists in TypeScript.
--   * `collection_faqs` — per-collection FAQ entries for the landing pages.
--   * `media_assets` + `product_media` — one media record (with alt text and a
--     focal point) reusable by any product, ordered and role-tagged. Alt text
--     and focal point live on the media record so an image can never be
--     rendered without them.
--   * `product_facts` — the factual PDP spec table (pages, trim, binding,
--     format, themes). `production_estimate_days` is NULLABLE ON PURPOSE:
--     nothing in this version prints or ships an order, so there is no real
--     production estimate to publish and the renderer only shows it when a
--     real value exists (see src/pdp.ts).
--
-- Seed rules honoured here:
--   * EVERY product/collection/media row inserted below is ORIGINAL content
--     authored for this project. No reference catalogue title, artwork,
--     review, statistic or endorsement is reproduced, and no file referenced
--     here is a third-party asset (all of them are produced by
--     scripts/generate-original-art.mjs).
--   * INSERTS are `INSERT OR IGNORE` keyed on a natural uniqueness constraint,
--     so re-running this migration is a no-op and an operator's edits are
--     never overwritten.
--
-- Idempotent: every statement is CREATE ... IF NOT EXISTS / INSERT OR IGNORE.

-- ---- collections ----
CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  -- 'audience' | 'theme' | 'age' | 'career' | 'sticker' | 'editorial'
  kind TEXT NOT NULL CHECK (kind IN ('audience', 'theme', 'age', 'career', 'sticker', 'editorial')),
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  hero_image TEXT NOT NULL DEFAULT '',
  hero_alt TEXT NOT NULL DEFAULT '',
  -- Optional machine-readable facet the collection pins (e.g. gender=girl,
  -- age 4-6, career=1). Stored as an explicit small set of columns rather
  -- than a JSON blob so the catalog query can use them in SQL.
  facet_gender TEXT CHECK (facet_gender IS NULL OR facet_gender IN ('girl', 'boy', 'unisex')),
  facet_age_min INTEGER,
  facet_age_max INTEGER,
  facet_career INTEGER NOT NULL DEFAULT 0,
  facet_category TEXT CHECK (facet_category IS NULL OR facet_category IN ('book', 'sticker')),
  seo_title TEXT NOT NULL DEFAULT '',
  seo_description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_collections_active_order ON collections(active, sort_order);
CREATE INDEX IF NOT EXISTS idx_collections_kind ON collections(kind, active);

-- ---- collection_products ----
-- The join is its own entity (position + optional merchandising pin) so a
-- product can appear in several collections with a different order in each.
CREATE TABLE IF NOT EXISTS collection_products (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (collection_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_collection_products_product ON collection_products(product_id);
CREATE INDEX IF NOT EXISTS idx_collection_products_order ON collection_products(collection_id, sort_order);

-- ---- collection_faqs ----
CREATE TABLE IF NOT EXISTS collection_faqs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_collection_faqs_collection ON collection_faqs(collection_id, active, sort_order);

-- ---- media_assets ----
-- `alt_text` defaults to '' but the admin form REQUIRES an authored value for
-- non-decorative media (see src/admin_catalog.ts) and the renderer marks an
-- asset with empty alt as decorative explicitly (`alt=""`), never as a
-- missing attribute.
CREATE TABLE IF NOT EXISTS media_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Storage location. `storage_key` is the private R2 key when the asset is
  -- private; `public_path` is the served path for committed storefront art.
  -- Exactly one of them is used for any given row; `is_private` says which.
  public_path TEXT NOT NULL DEFAULT '',
  storage_key TEXT NOT NULL DEFAULT '',
  is_private INTEGER NOT NULL DEFAULT 0,
  alt_text TEXT NOT NULL DEFAULT '',
  -- Focal point in normalised coordinates, so a cropped card still frames the
  -- subject. 0.5/0.5 is the centre.
  focal_x REAL NOT NULL DEFAULT 0.5 CHECK (focal_x >= 0 AND focal_x <= 1),
  focal_y REAL NOT NULL DEFAULT 0.5 CHECK (focal_y >= 0 AND focal_y <= 1),
  width INTEGER,
  height INTEGER,
  mime_type TEXT NOT NULL DEFAULT '',
  byte_size INTEGER,
  -- Provenance: 'generated' for the committed original art set, 'upload' for
  -- an operator upload. Kept so an audit can tell where an asset came from.
  source TEXT NOT NULL DEFAULT 'generated' CHECK (source IN ('generated', 'upload')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CHECK (is_private IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_media_assets_public ON media_assets(public_path);
CREATE INDEX IF NOT EXISTS idx_media_assets_private ON media_assets(is_private, created_at);
-- One row per committed PUBLIC asset. Partial, so the many PRIVATE assets
-- (which have no public path at all) are unaffected — this is what makes the
-- seed below idempotent when the migration is re-applied.
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_assets_public_path_unique
  ON media_assets(public_path) WHERE public_path <> '';

-- ---- product_media ----
CREATE TABLE IF NOT EXISTS product_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'gallery' CHECK (role IN ('cover', 'gallery', 'video', 'demo')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (product_id, media_id, role)
);
CREATE INDEX IF NOT EXISTS idx_product_media_product ON product_media(product_id, role, active, sort_order);
CREATE INDEX IF NOT EXISTS idx_product_media_media ON product_media(media_id);
-- Exactly one cover per product, enforced by the database rather than by the
-- admin handler remembering to unset the previous one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_media_one_cover
  ON product_media(product_id) WHERE role = 'cover';

-- ---- product_facts ----
CREATE TABLE IF NOT EXISTS product_facts (
  product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  page_count INTEGER CHECK (page_count IS NULL OR page_count > 0),
  trim_size TEXT NOT NULL DEFAULT '',
  binding TEXT NOT NULL DEFAULT '',
  format_label TEXT NOT NULL DEFAULT '',
  -- A factual, non-promissory statement about production in THIS version.
  production_note TEXT NOT NULL DEFAULT '',
  -- Only populated once a real print/fulfilment pipeline exists. While it is
  -- NULL the PDP does not render a delivery estimate at all (rather than
  -- inventing one) — the truthful-claims guard in
  -- test/unit/phase2-catalog-content.test.ts asserts this.
  production_estimate_days INTEGER CHECK (production_estimate_days IS NULL OR production_estimate_days > 0),
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ===========================================================================
-- Default (original) content
-- ===========================================================================

INSERT OR IGNORE INTO collections (slug, kind, title, subtitle, description, hero_image, hero_alt, facet_gender, facet_career, facet_category, sort_order) VALUES
  ('all-books', 'editorial', 'Every storybook', 'The complete personalised storybook catalogue.', 'Browse every personalised storybook in the catalogue. Each one is built from the photo, name and age you provide.', '/static/img/art/books-header.svg', 'Layered illustrated landscape with a small sailing boat', NULL, 0, 'book', 0),
  ('all-stickers', 'sticker', 'Every sticker pack', 'Personalised sticker sheets.', 'Sticker packs that use the same photo and name as your book, printed on one sheet per pack.', '/static/img/art/stickers-header.svg', 'Illustrated sticker sheet with abstract shapes', NULL, 0, 'sticker', 1),
  ('girls-books', 'audience', 'Stories for girls', 'Heroines, helpers and big ideas.', 'A selection of stories written so a girl can see herself as the one who solves the problem.', '/static/img/art/cover-the-moon-garden.svg', 'Illustrated moonlit garden with white flowers', 'girl', 0, 'book', 10),
  ('boys-books', 'audience', 'Stories for boys', 'Adventures, machines and courage.', 'A selection of stories written so a boy can see himself as the one who solves the problem.', '/static/img/art/cover-the-little-fire-crew.svg', 'Illustrated landscape with a small vehicle', 'boy', 0, 'book', 11),
  ('adventure-and-discovery', 'theme', 'Adventure & discovery', 'Journeys, maps and the unknown.', 'Stories about setting out, getting lost and finding the way back.', '/static/img/art/cover-the-little-explorer.svg', 'Illustrated forest with a kite in the sky', NULL, 0, 'book', 20),
  ('bedtime-and-calm', 'theme', 'Bedtime & calm', 'Gentle stories for the end of the day.', 'Quiet stories that slow down towards the last page.', '/static/img/art/cover-the-lantern-and-the-long-night.svg', 'Illustrated night-time pines with a hanging lantern', NULL, 0, 'book', 21),
  ('animals-and-nature', 'theme', 'Animals & nature', 'Creatures, woods and weather.', 'Stories where an animal, a plant or a season causes the trouble and helps fix it.', '/static/img/art/cover-the-snow-fox.svg', 'Illustrated snowy landscape with a white fox', NULL, 0, 'book', 22),
  ('sky-and-space', 'theme', 'Sky & space', 'Rockets, stars and long journeys.', 'Stories that look up: flight, planets and the very long way home.', '/static/img/art/cover-the-star-collector.svg', 'Illustrated night sky with a rocket and stars', NULL, 0, 'book', 23),
  ('kindness-and-feelings', 'theme', 'Kindness & feelings', 'Naming big feelings in small people.', 'Stories about sharing, waiting, apologising and being brave enough to be gentle.', '/static/img/art/cover-the-forest-that-sang.svg', 'Illustrated forest clearing with a drum', NULL, 0, 'book', 24),
  ('ages-2-4', 'age', 'Ages 2–4', 'Short, rhythmic and sturdy.', 'Short lines, repetition and a single idea per page.', '/static/img/art/age-2-4.svg', 'Three illustrated circles in a row', NULL, 0, 'book', 30),
  ('ages-4-6', 'age', 'Ages 4–6', 'A problem, a plan and a helper.', 'A clear problem, one helper and a solution the child reaches themselves.', '/static/img/art/age-4-6.svg', 'Illustrated kite above a warm landscape', NULL, 0, 'book', 31),
  ('ages-6-8', 'age', 'Ages 6–8', 'Longer arcs, real stakes.', 'Longer sentences and a story that spans more than one day.', '/static/img/art/age-6-8.svg', 'Illustrated rocket in a starry sky', NULL, 0, 'book', 32),
  ('when-i-grow-up', 'career', 'When I grow up', 'Careers, helpers and craft.', 'Stories that show a job as a set of things a person actually does.', '/static/img/art/cover-the-curious-scientist.svg', 'Illustrated laboratory flask in a bright landscape', NULL, 1, 'book', 40),
  ('sticker-packs', 'sticker', 'Sticker packs', 'Personalised sheets.', 'Sticker packs built from the same photo and name as your book.', '/static/img/art/cover-meadow-sticker-sheet.svg', 'Illustrated sticker sheet with green shapes', NULL, 0, 'sticker', 50);

-- Every product belongs to the collection that matches its own catalog facets.
-- These are DERIVED membership rows (no editorial judgement is invented here),
-- and they are what the homepage/catalog read.
INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
  SELECT c.id, p.id, p.id FROM collections c JOIN products p ON c.slug = 'all-books' AND p.category = 'book';
INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
  SELECT c.id, p.id, p.id FROM collections c JOIN products p ON c.slug = 'all-stickers' AND p.category = 'sticker';
INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
  SELECT c.id, p.id, p.id FROM collections c JOIN products p ON c.slug = 'ages-2-4' AND p.category = 'book' AND p.age_min >= 2 AND p.age_max <= 6;
INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
  SELECT c.id, p.id, p.id FROM collections c JOIN products p ON c.slug = 'ages-4-6' AND p.category = 'book' AND p.age_min <= 4 AND p.age_max >= 6;
INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
  SELECT c.id, p.id, p.id FROM collections c JOIN products p ON c.slug = 'ages-6-8' AND p.category = 'book' AND p.age_max >= 8;
INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
  SELECT c.id, p.id, p.id FROM collections c JOIN products p ON c.slug = 'when-i-grow-up' AND p.career = 1;
INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
  SELECT c.id, p.id, p.id FROM collections c JOIN products p ON c.slug = 'girls-books' AND p.category = 'book' AND (p.gender = 'girl' OR p.gender = 'unisex');
INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
  SELECT c.id, p.id, p.id FROM collections c JOIN products p ON c.slug = 'boys-books' AND p.category = 'book' AND (p.gender = 'boy' OR p.gender = 'unisex');
INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
  SELECT c.id, p.id, p.id FROM collections c JOIN products p ON c.slug = 'sticker-packs' AND p.category = 'sticker';

-- Theme membership is an EDITORIAL choice (a title's theme is not derivable
-- from its facets), so it is listed explicitly here and in the application
-- bootstrap. Both are idempotent, and both use the same original catalogue.
INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
  SELECT c.id, p.id, 100 + p.id FROM collections c JOIN products p
   WHERE c.slug = 'adventure-and-discovery' AND p.slug IN ('captain-of-the-cardboard-sea', 'the-great-paper-boat-race', 'the-sunrise-kite-club', 'the-little-explorer', 'the-paper-aeroplane-race', 'the-puddle-who-met-the-sea');
INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
  SELECT c.id, p.id, 100 + p.id FROM collections c JOIN products p
   WHERE c.slug = 'bedtime-and-calm' AND p.slug IN ('the-lantern-and-the-long-night', 'the-moon-garden', 'the-snowy-night-parade', 'the-moonlight-parade', 'the-snow-fox');
INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
  SELECT c.id, p.id, 100 + p.id FROM collections c JOIN products p
   WHERE c.slug = 'animals-and-nature' AND p.slug IN ('the-snow-fox', 'the-lost-little-dinosaur', 'the-forest-that-sang', 'the-puddle-who-met-the-sea');
INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
  SELECT c.id, p.id, 100 + p.id FROM collections c JOIN products p
   WHERE c.slug = 'sky-and-space' AND p.slug IN ('the-star-collector', 'the-paper-aeroplane-race', 'up-in-the-clouds', 'the-sunrise-kite-club');
INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
  SELECT c.id, p.id, 100 + p.id FROM collections c JOIN products p
   WHERE c.slug = 'kindness-and-feelings' AND p.slug IN ('the-quiet-drum', 'the-brave-little-baker', 'the-kind-vet', 'the-helping-hands-clinic', 'the-forest-that-sang');

-- Collection landing-page FAQs: original copy, describing what this build
-- really does (no shipping/print/refund promise — see the truthful-claims
-- guards in test/unit/phase1-truthful-claims.test.ts).
INSERT OR IGNORE INTO collection_faqs (collection_id, question, answer, sort_order)
  SELECT id, 'What makes this collection different?', 'Each story in this collection shares the same tone and age range, so you can pick by theme rather than by guessing from the cover.', 1 FROM collections WHERE slug = 'when-i-grow-up';
INSERT OR IGNORE INTO collection_faqs (collection_id, question, answer, sort_order)
  SELECT id, 'Can I preview the personalisation before I order?', 'Yes. After you upload a photo and set the name and age you can open the reader and check every page. Each edit is saved as its own revision.', 2 FROM collections WHERE slug = 'when-i-grow-up';
INSERT OR IGNORE INTO collection_faqs (collection_id, question, answer, sort_order)
  SELECT id, 'Does this version print or ship the book?', 'No. This version records an order and stores your personalisation; it does not collect a real payment, print or ship anything.', 3 FROM collections WHERE slug = 'when-i-grow-up';

INSERT OR IGNORE INTO collection_faqs (collection_id, question, answer, sort_order)
  SELECT id, 'How do I choose a bedtime story?', 'Pick by age first, then by how long you want the last page to take. The shortest stories in this collection are marked with a 2–4 age range.', 1 FROM collections WHERE slug = 'bedtime-and-calm';
INSERT OR IGNORE INTO collection_faqs (collection_id, question, answer, sort_order)
  SELECT id, 'Can I change the dedication later?', 'You can edit the dedication in the reader before checkout, and each change is stored as its own revision.', 2 FROM collections WHERE slug = 'bedtime-and-calm';

INSERT OR IGNORE INTO collection_faqs (collection_id, question, answer, sort_order)
  SELECT id, 'How is the photo used?', 'The uploaded photo is stored privately and used only to build the personalisation for your own order. You can remove it from your account at any time.', 1 FROM collections WHERE slug = 'all-books';
INSERT OR IGNORE INTO collection_faqs (collection_id, question, answer, sort_order)
  SELECT id, 'What photo works best?', 'A bright, front-facing photo where the face is not covered. The product page lists the exact formats and limits the server enforces.', 2 FROM collections WHERE slug = 'all-books';

-- ---- media_assets: the committed original illustration set ----
-- Every row points at a file produced by scripts/generate-original-art.mjs.
INSERT OR IGNORE INTO media_assets (public_path, alt_text, width, height, mime_type, source) VALUES
  ('/static/img/art/hero.svg', 'Illustrated layered landscape with an open book', 720, 560, 'image/svg+xml', 'generated'),
  ('/static/img/art/cta-reading.svg', 'Illustrated meadow with an open book and trees', 640, 420, 'image/svg+xml', 'generated'),
  ('/static/img/art/books-header.svg', 'Illustrated sea with two small sailing boats', 960, 540, 'image/svg+xml', 'generated'),
  ('/static/img/art/stickers-header.svg', 'Illustrated sticker sheet with abstract shapes', 960, 540, 'image/svg+xml', 'generated'),
  ('/static/img/art/step-1.svg', 'Illustrated open book on a plain background', 640, 420, 'image/svg+xml', 'generated'),
  ('/static/img/art/step-2.svg', 'Illustrated camera frame on a cool background', 640, 420, 'image/svg+xml', 'generated'),
  ('/static/img/art/step-3.svg', 'Illustrated stack of three coloured bars', 640, 420, 'image/svg+xml', 'generated'),
  ('/static/img/art/step-4.svg', 'Illustrated celebration cake', 640, 420, 'image/svg+xml', 'generated'),
  ('/static/img/art/age-2-4.svg', 'Three illustrated circles in a row', 640, 420, 'image/svg+xml', 'generated'),
  ('/static/img/art/age-4-6.svg', 'Illustrated kite above a warm landscape', 640, 420, 'image/svg+xml', 'generated'),
  ('/static/img/art/age-6-8.svg', 'Illustrated rocket in a starry sky', 640, 420, 'image/svg+xml', 'generated'),
  ('/static/img/art/og-default.svg', 'Illustrated sunrise landscape with an open book', 1200, 630, 'image/svg+xml', 'generated'),
  ('/static/img/art/login-art.svg', 'Illustrated night-time pines with a lantern', 640, 420, 'image/svg+xml', 'generated'),
  ('/static/img/placeholder-cover.svg', 'Neutral placeholder for a book cover', 512, 512, 'image/svg+xml', 'generated'),
  ('/static/img/placeholder-spread.svg', 'Neutral placeholder for a book spread', 640, 420, 'image/svg+xml', 'generated'),
  ('/static/img/photo-placeholder.svg', 'Neutral placeholder for an uploaded photo', 512, 512, 'image/svg+xml', 'generated'),
  ('/static/img/art/magic-before.svg', 'Illustration of an unpersonalised photo frame', 640, 420, 'image/svg+xml', 'generated'),
  ('/static/img/art/magic-after.svg', 'Illustration of a personalised book spread', 640, 420, 'image/svg+xml', 'generated'),
  ('/static/img/art/tip-blurry.svg', 'Illustration of a blurred image', 240, 240, 'image/svg+xml', 'generated'),
  ('/static/img/art/tip-angle.svg', 'Illustration of a tilted head shape', 240, 240, 'image/svg+xml', 'generated'),
  ('/static/img/art/tip-shadow.svg', 'Illustration of a face in harsh shadow', 240, 240, 'image/svg+xml', 'generated'),
  ('/static/img/art/tip-good-1.svg', 'Illustration of a bright, front-facing portrait', 240, 240, 'image/svg+xml', 'generated'),
  ('/static/img/art/tip-good-2.svg', 'Illustration of a portrait in natural light', 240, 240, 'image/svg+xml', 'generated'),
  ('/static/img/art/thumb-hardcover.svg', 'Illustration of a hardcover book', 240, 240, 'image/svg+xml', 'generated'),
  ('/static/img/art/thumb-softcover.svg', 'Illustration of a softcover book', 240, 240, 'image/svg+xml', 'generated');

-- One cover media row per product, taken from the product's own image column
-- so the media table is the single ordered source the PDP gallery reads.
INSERT OR IGNORE INTO media_assets (public_path, alt_text, width, height, mime_type, source)
  SELECT p.image, 'Illustrated cover for ' || p.title, 600, 600, 'image/svg+xml', 'generated'
  FROM products p WHERE p.image <> '';
INSERT OR IGNORE INTO product_media (product_id, media_id, role, sort_order)
  SELECT p.id, m.id, 'cover', 0
  FROM products p JOIN media_assets m ON m.public_path = p.image
  WHERE p.image <> '';

-- ---- product_facts ----
-- Trim/binding are the format the catalogue actually describes for this
-- build. `production_estimate_days` is deliberately left NULL: nothing here
-- prints or ships, so there is no real estimate to publish.
INSERT OR IGNORE INTO product_facts (product_id, page_count, trim_size, binding, format_label, production_note)
  SELECT id, pages, '210 × 210 mm', CASE WHEN category = 'book' THEN 'Hardcover / softcover' ELSE 'Sticker sheet set' END,
         CASE WHEN category = 'book' THEN 'Square picture book' ELSE 'Sticker pack' END,
         'This version records the order and keeps your personalisation. It does not print or ship anything yet, so no production or delivery date is scheduled.'
  FROM products;
