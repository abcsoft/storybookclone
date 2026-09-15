-- Migration 0021: CMS content layer (V2 Phase 2).
-- Forward-only. Nothing in 0001-0020 is edited, reordered or dropped.
--
-- Scope (§10 CMS, §12 Phase 2 items 4/7/9; requirement IDs SF-04, SF-05,
-- SF-10, SF-11, SF-12, ADM-07):
--
--   * `cms_blocks`      — the homepage (and any content page) is a ORDERED
--                         list of typed blocks. Adding, reordering, hiding or
--                         re-typing a block is an admin action; the renderer
--                         maps block `kind` -> a component and knows nothing
--                         about any specific headline.
--   * `cms_nav_items`   — primary / mobile / footer navigation, ordered and
--                         nestable, with a `menu` discriminator.
--   * `cms_footer_notes`— the truthful operational notes in the footer.
--   * `cms_faqs`        — the global FAQ, grouped, ordered, editable.
--   * `cms_pages`       — record-backed content pages: blog posts, FAQ pages
--                         and the legal drafts. The blog index and the blog
--                         post route read THIS table, so an unknown slug is a
--                         real 404 (the Phase-1 T-07 fix) and a new post is an
--                         admin insert, not a code change.
--   * `announcements`   — the promotional banner, with an optional active
--                         window, so a promotion can expire by itself.
--   * `site_settings`   — the key/value store the brand boundary reads, so the
--                         site name/tagline/contact/social/logo can be set in
--                         admin without a redeploy (src/brand.ts merges these
--                         OVER the environment defaults).
--
-- TRUTHFULNESS: every seeded string below describes what this build actually
-- does. There is no shipping, printing, payment, review or press claim in here,
-- because none of those exist in this version. The seeded legal pages keep the
-- explicit "Draft / placeholder / legal counsel" marking that Phase 1 (S-14)
-- requires — see test/unit/phase1-truthful-claims.test.ts.
--
-- Idempotent: CREATE ... IF NOT EXISTS + INSERT OR IGNORE keyed on a natural
-- unique column (`key`). An operator's edit to any seeded row survives a
-- re-run.

-- ---- cms_blocks ----
CREATE TABLE IF NOT EXISTS cms_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Stable machine key, unique across all pages. The renderer dispatches on
  -- `kind`; `key` exists so a block can be targeted/ordered deterministically
  -- and so a seed cannot duplicate it.
  key TEXT NOT NULL UNIQUE,
  -- Which page this block belongs to. '/' for the homepage.
  page_path TEXT NOT NULL DEFAULT '/',
  kind TEXT NOT NULL CHECK (kind IN (
    'announcement', 'hero', 'product-grid', 'collection-grid', 'steps',
    'photo-guidance', 'age-grid', 'sticker-cross-sell', 'faq-preview',
    'final-cta', 'newsletter', 'rich-text', 'trust'
  )),
  eyebrow TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  subtitle TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  cta_label TEXT NOT NULL DEFAULT '',
  cta_href TEXT NOT NULL DEFAULT '',
  secondary_cta_label TEXT NOT NULL DEFAULT '',
  secondary_cta_href TEXT NOT NULL DEFAULT '',
  image_path TEXT NOT NULL DEFAULT '',
  image_alt TEXT NOT NULL DEFAULT '',
  -- A product-grid block either names a collection or a product set; both are
  -- resolved in SQL by the loader (never by a hard-coded slug list in TS).
  collection_slug TEXT NOT NULL DEFAULT '',
  product_slugs TEXT NOT NULL DEFAULT '',
  -- Optional grouping key for blocks that render a SET of things rather than
  -- one: a collection-grid's collection kind, an age-grid's buckets, a
  -- steps block's step count. Empty means "not applicable".
  data_key TEXT NOT NULL DEFAULT '',
  max_items INTEGER NOT NULL DEFAULT 4,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cms_blocks_page ON cms_blocks(page_path, active, sort_order);
CREATE INDEX IF NOT EXISTS idx_cms_blocks_kind ON cms_blocks(kind, active);

-- ---- cms_nav_items ----
CREATE TABLE IF NOT EXISTS cms_nav_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  menu TEXT NOT NULL CHECK (menu IN ('primary', 'mobile', 'footer')),
  -- Footer columns are addressed as `footer:<column-key>` so one table serves
  -- both the top-level footer and its headings without a second schema.
  column_key TEXT NOT NULL DEFAULT '',
  column_title TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL,
  href TEXT NOT NULL,
  parent_id INTEGER REFERENCES cms_nav_items(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- Makes the seed below genuinely idempotent: re-applying this migration
  -- cannot duplicate a navigation entry.
  UNIQUE (menu, column_key, label, href)
);
CREATE INDEX IF NOT EXISTS idx_cms_nav_menu ON cms_nav_items(menu, active, sort_order);
CREATE INDEX IF NOT EXISTS idx_cms_nav_parent ON cms_nav_items(parent_id);

-- ---- cms_footer_notes ----
CREATE TABLE IF NOT EXISTS cms_footer_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- ---- cms_faqs ----
CREATE TABLE IF NOT EXISTS cms_faqs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_key TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (group_key, question)
);
CREATE INDEX IF NOT EXISTS idx_cms_faqs_group ON cms_faqs(group_key, active, sort_order);

-- ---- cms_pages ----
CREATE TABLE IF NOT EXISTS cms_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('blog', 'faq', 'legal', 'shipping', 'refund', 'content')),
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  -- `body` is authored HTML produced by the admin editor; the renderer treats
  -- it as trusted-operator content and still escapes the surrounding template
  -- values. Legacy `blogPosts()`-style string literals are NOT used any more.
  body TEXT NOT NULL DEFAULT '',
  image_path TEXT NOT NULL DEFAULT '',
  image_alt TEXT NOT NULL DEFAULT '',
  seo_title TEXT NOT NULL DEFAULT '',
  seo_description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  published_at DATETIME,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cms_pages_kind ON cms_pages(kind, status, sort_order);

-- ---- announcements ----
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  href TEXT NOT NULL DEFAULT '',
  -- Optional active window (ISO-8601). A NULL bound means "no bound on that
  -- side", so a banner can be scheduled and can also expire by itself.
  starts_at DATETIME,
  ends_at DATETIME,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(active, sort_order);

-- ---- site_settings ----
-- The single key/value store the brand boundary (src/brand.ts) overlays on
-- top of the environment. `value` is TEXT; `kind` documents the expected shape
-- for the admin editor's validation.
CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'string' CHECK (kind IN ('string', 'url', 'email', 'number')),
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_site_settings_kind ON site_settings(kind);

-- ===========================================================================
-- Default (original) content — the homepage as an ordered block list
-- ===========================================================================
INSERT OR IGNORE INTO cms_blocks (key, page_path, kind, eyebrow, title, subtitle, cta_label, cta_href, secondary_cta_label, secondary_cta_href, image_path, image_alt, collection_slug, data_key, max_items, sort_order) VALUES
  ('home.hero', '/', 'hero',
   'The gift of a story that stars them',
   'Put your child in the story',
   'Choose a story, upload one photo and set their name and age. You can read every page before you decide anything.',
   'Browse storybooks', '/books', 'See sticker packs', '/stickers',
   '/static/img/art/hero.svg', 'Illustrated layered landscape with an open book',
   '', '', 0, 10),
  ('home.bestsellers', '/', 'product-grid',
   'Most read in this catalogue',
   'Storybooks families come back to',
   'Ordered by how often the title has been ordered, not by a marketing claim.',
   'See all storybooks', '/books', '', '',
   '', '', 'all-books', '', 4, 20),
  ('home.new-releases', '/', 'product-grid',
   'Added recently',
   'New in the catalogue',
   'The newest titles, in the order they were added.',
   'Browse the catalogue', '/books', '', '',
   '', '', 'ages-4-6', '', 4, 30),
  ('home.steps', '/', 'steps',
   'Four steps',
   'How personalisation works',
   'Nothing is charged in this version: the last step saves the order record for you.',
   '', '', '', '',
   '/static/img/art/step-1.svg', 'Illustrated open book', '', '', 4, 40),
  ('home.audience', '/', 'collection-grid',
   'Shop by audience',
   'A story written for them',
   'Pick a collection to see every title that fits.',
   '', '', '', '',
   '', '', 'girls-books', 'audience', 3, 50),
  ('home.photo-guidance', '/', 'photo-guidance',
   'Photos',
   'One photo is all it takes',
   'The upload limits on this page are the limits the server enforces — nothing is claimed that the app does not check.',
   '', '', '', '',
   '', '', '', '', 0, 60),
  ('home.theme', '/', 'collection-grid',
   'Shop by theme',
   'Find the right kind of story',
   'Themes group titles by the feeling of the story, not by the cover.',
   '', '', '', '',
   '', '', 'bedtime-and-calm', 'theme', 3, 70),
  ('home.careers', '/', 'product-grid',
   'When I grow up',
   'Stories about what people do all day',
   'Each career story shows the job as a set of tasks a person really carries out.',
   'See all career stories', '/collections/when-i-grow-up', '', '',
   '', '', 'when-i-grow-up', '', 4, 80),
  ('home.ages', '/', 'age-grid',
   'Shop by age',
   'Stories matched to their reading age',
   'Each title lists the age range the text was written for.',
   '', '', '', '',
   '', '', '', 'age', 3, 90),
  ('home.stickers', '/', 'sticker-cross-sell',
   'Add-ons',
   'Matching sticker packs',
   'The same photo and name on a sheet of stickers — a separate product, priced separately.',
   'See sticker packs', '/stickers', '', '',
   '/static/img/art/stickers-header.svg', 'Illustrated sticker sheet with abstract shapes',
   'sticker-packs', '', 1, 100),
  ('home.faq', '/', 'faq-preview',
   'Questions',
   'Answers before you order',
   'These are the questions the support inbox actually receives most often.',
   'Read all FAQs', '/faqs', '', '',
   '', '', '', '', 5, 110),
  ('home.cta', '/', 'final-cta',
   '',
   'Start with one photo',
   'Pick a story, add their name and age, and read the pages before you decide.',
   'Browse storybooks', '/books', '', '',
   '/static/img/art/cta-reading.svg', 'Illustrated meadow with an open book',
   '', '', 0, 120),
  ('home.newsletter', '/', 'newsletter',
   'Keep in touch',
   'New titles, occasionally',
   'We send an email when a new title or sticker pack is added. Nothing else.',
   '', '', '', '',
   '', '', '', '', 0, 130);

-- ---- navigation ----
INSERT OR IGNORE INTO cms_nav_items (menu, label, href, sort_order) VALUES
  ('primary', 'Home', '/', 10),
  ('primary', 'Storybooks', '/books', 20),
  ('primary', 'Stickers', '/stickers', 30),
  ('primary', 'Collections', '/collections', 40),
  ('primary', 'My Books', '/my-books', 50),
  ('primary', 'Support', '/support', 60);

INSERT OR IGNORE INTO cms_nav_items (menu, label, href, sort_order) VALUES
  ('mobile', 'Home', '/', 10),
  ('mobile', 'Storybooks', '/books', 20),
  ('mobile', 'Stickers', '/stickers', 30),
  ('mobile', 'Collections', '/collections', 40),
  ('mobile', 'When I grow up', '/collections/when-i-grow-up', 50),
  ('mobile', 'My Books', '/my-books', 60),
  ('mobile', 'Blog', '/blog', 70),
  ('mobile', 'FAQs', '/faqs', 80),
  ('mobile', 'Support', '/support', 90),
  ('mobile', 'Contact', '/contact', 100);

INSERT OR IGNORE INTO cms_nav_items (menu, column_key, column_title, label, href, sort_order) VALUES
  ('footer', 'shop', 'Shop', 'All storybooks', '/books', 10),
  ('footer', 'shop', 'Shop', 'Sticker packs', '/stickers', 20),
  ('footer', 'shop', 'Shop', 'Collections', '/collections', 30),
  ('footer', 'shop', 'Shop', 'When I grow up', '/collections/when-i-grow-up', 40),
  ('footer', 'help', 'Help', 'FAQs', '/faqs', 10),
  ('footer', 'help', 'Help', 'Contact us', '/contact', 20),
  ('footer', 'help', 'Help', 'Support', '/support', 30),
  ('footer', 'help', 'Help', 'Photo guidelines', '/support/photo-guidelines', 40),
  ('footer', 'company', 'About', 'How it works', '/how-it-works', 10),
  ('footer', 'company', 'About', 'Blog', '/blog', 20),
  ('footer', 'legal', 'Legal', 'Privacy policy', '/support/privacy-policy', 10),
  ('footer', 'legal', 'Legal', 'Terms & conditions', '/support/terms-and-conditions', 20),
  ('footer', 'legal', 'Legal', 'Refund policy', '/support/refund-policy', 30),
  ('footer', 'legal', 'Legal', 'Shipping information', '/support/shipping', 40);

-- ---- footer notes (truthful operational statements only) ----
INSERT OR IGNORE INTO cms_footer_notes (body, sort_order) VALUES
  ('This is a test storefront: no real payment is collected, and nothing is printed or shipped.', 10);

-- ---- announcements ----
-- The code below is a REAL discount row seeded in seed.sql (EXTRA20, 20% off
-- 2+ books, auto-applied by the server-side quote). The banner therefore
-- advertises exactly the discount the server will apply, and nothing else.
INSERT OR IGNORE INTO announcements (message, code, href, active, sort_order)
  SELECT 'Save 20% on 2 or more storybooks with code', 'EXTRA20', '/books', 1, 10
  WHERE NOT EXISTS (SELECT 1 FROM announcements);

-- ---- global FAQ ----
INSERT OR IGNORE INTO cms_faqs (group_key, question, answer, sort_order) VALUES
  ('Popular', 'How do I personalise a book?', 'Choose the book, upload a photo of your child, and enter their name and age. You can read every page in the reader before you add it to your cart. This version does not charge a real payment and does not print a book.', 10),
  ('Popular', 'Do you ship internationally?', 'No — shipping is not available in this version. Printing and delivery are later milestones, so no order placed today will be shipped. Checkout collects shipping details so the order record is complete.', 20),
  ('Popular', 'What is your refund policy?', 'Not applicable yet — this version does not collect a real payment, so there is nothing to refund. Orders placed here are test orders.', 30),
  ('Popular', 'How long does shipping take?', 'Delivery is not scheduled in this version — there is no fulfilment or shipping integration yet.', 40),
  ('Popular', 'Are taxes and customs included?', 'Not applicable yet — no real payment, shipping or customs handling exists in this version.', 50),
  ('Popular', 'Can I review the book before it is printed?', 'You can read and edit your book in the reader before ordering, and every edit is saved as its own revision. There is no post-order approval or revision workflow in this version yet.', 60),
  ('Popular', 'Which languages can I personalise a book in?', 'The personalisation form lists the languages configured in the language table. Open the form on any product page to see the current list.', 70),
  ('About the books', 'How is the book personalised for my child?', 'The story text is written to include the name and age you provide, and the photo you upload is used to build the personalisation for your order. You confirm every page in the reader before you check out.', 10),
  ('About the books', 'What format are the books?', 'The catalogue describes each title as a square picture book with a hardcover or softcover variant choice. Nothing is printed in this version — the format is the one a later print pipeline would use.', 20),
  ('About the books', 'Can I submit my own story?', 'No. The catalogue contains a fixed set of stories; custom story submissions are not offered.', 30),
  ('Photos', 'What photo should I upload?', 'A bright, front-facing photo where the face is not covered. The product page lists every format and size limit, and those are the limits the server enforces.', 10),
  ('Photos', 'What happens to my photo?', 'It is stored in private object storage, readable only through the application''s ownership checks. It is used to build your own personalisation and is not published anywhere.', 20),
  ('Your account', 'Do I need an account to order?', 'No, you can check out as a guest. Creating an account keeps the orders you place while signed in under My Books. Guest orders cannot be linked to an account in this version.', 10),
  ('Your account', 'What payment methods do you accept?', 'None — this version does not collect a real payment. Checkout records the order without charging anything and does not offer card or PayPal payment.', 20),
  ('Shipping & refunds', 'How can I track my order?', 'Order tracking is not available in this version: no tracking emails or links are sent, and no orders are printed or shipped. For the status of an order you placed here, use the contact form.', 10),
  ('Shipping & refunds', 'Can I change my shipping address?', 'Use the contact form and we will look at the order record. Nothing ships in this version, so no shipment can be affected.', 20),
  ('Shipping & refunds', 'Can I get a refund?', 'There is nothing to refund in this version: no real payment is collected. The refund policy page is an explicit draft and has not been reviewed by legal counsel.', 30);

-- ---- cms_pages: blog ----
-- Original copy. No statistics, expert bylines, awards or press mentions are
-- invented here (T-06).
INSERT OR IGNORE INTO cms_pages (slug, kind, title, category, excerpt, body, image_path, image_alt, status, published_at, sort_order) VALUES
  ('why-personalised-books-hold-attention', 'blog', 'Why a child stays with a story that has them in it', 'Reading',
   'Seeing their own name and face on the page gives a child a reason to keep turning it.',
   '<p>When a child opens a book and finds their own name — and a drawing built from their own photo — the story stops being somebody else''s. That ownership is the simplest reason a personalised book gets picked up again.</p><h2>Self-representation keeps attention</h2><p>A child who is the hero of the page has a reason to find out what happens next. Familiar characters are simply more interesting to a young reader.</p><h2>Reading together is the real habit</h2><p>Time spent reading side by side is what builds a habit. A personalised book puts your child at the centre of that time, night after night.</p><h2>You can check every page first</h2><p>On this storefront you upload a photo, set the name and age, then read the whole book in the reader before adding it to your cart. Each edit is stored as its own revision.</p>',
   '/static/img/art/cta-reading.svg', 'Illustrated meadow with an open book', 'published', '2026-08-04 09:00:00', 10),
  ('choosing-a-personalised-book-as-a-gift', 'blog', 'Choosing a personalised book as a gift', 'Gifts',
   'A practical checklist: pick the story, then the age range, then the photo.',
   '<p>A personalised book works as a gift because it is specific to one child. Here is how to choose well.</p><h2>Start from the interest</h2><p>Adventure, animals, space, machines — start from what they already love, then check the age range on the product page.</p><h2>Choose a photo that will work on the page</h2><p>A bright, front-facing photo gives the best result. Blur, strong shadows and side-on angles are the usual cause of a page that disappoints.</p><h2>Check the details before you order</h2><p>You can review the name, age, language and dedication in the reader before you check out.</p>',
   '/static/img/art/cover-the-lantern-and-the-long-night.svg', 'Illustrated night-time pines with a lantern', 'published', '2026-08-18 09:00:00', 20),
  ('building-a-bedtime-routine-around-a-book', 'blog', 'Building a bedtime routine around a book', 'Bedtime',
   'A short, repeatable routine that ends with a story your child is part of.',
   '<p>A routine works because it is predictable. A story at the end of it gives the whole sequence a destination.</p><h2>Keep the order the same each night</h2><p>Bath, teeth, pyjamas, story. The order matters more than the clock.</p><h2>Let them choose the book</h2><p>Giving your child one decision — which book — makes the rest of the routine easier to follow.</p><h2>End on the story, not on a screen</h2><p>Holding a physical book to the last page gives a natural, quiet stopping point for the day.</p>',
   '/static/img/art/cover-the-moon-garden.svg', 'Illustrated moonlit garden with white flowers', 'published', '2026-09-01 09:00:00', 30);

-- ---- cms_pages: how it works (a real content page, not a placeholder) ----
INSERT OR IGNORE INTO cms_pages (slug, kind, title, category, excerpt, body, status, sort_order) VALUES
  ('how-it-works', 'content', 'How it works', '', 'What happens between choosing a story and reading it in the reader.',
   '<h2>1. Choose a story</h2><p>Every title lists the age range and the format. Collections group titles by audience, theme and age.</p><h2>2. Upload a photo and set the details</h2><p>The product page takes one photo, a name and an age, and lists exactly which file types and sizes are accepted.</p><h2>3. Read every page</h2><p>The reader shows the personalisation you just created. Edits are saved as separate revisions, so you can change your mind without losing the previous version.</p><h2>4. Add it to your cart</h2><p>Cart totals are computed on the server from the catalogue, never from the browser. In this version the last step records the order without charging a payment or printing a book.</p>',
   'published', 10);

-- ---- cms_pages: standalone FAQ page ----
INSERT OR IGNORE INTO cms_pages (slug, kind, title, category, excerpt, body, status, sort_order) VALUES
  ('faq', 'faq', 'Frequently asked questions', '', 'Answers about personalisation, photos, languages and this version''s limits.',
   '<p>Every answer on this page describes what this build of the storefront actually does. The full list is grouped below.</p>',
   'published', 10);

-- ---- cms_pages: photo guidelines ----
INSERT OR IGNORE INTO cms_pages (slug, kind, title, category, excerpt, body, status, sort_order) VALUES
  ('photo-guidelines', 'content', 'Photo guidelines', '', 'What makes a photo work on the page, and what the server will reject.',
   '<h2>What works</h2><p>A bright, front-facing photo where the face is clearly visible and not covered by a hand, hat or food.</p><h2>What does not</h2><p>Blur, strong shadows across the face, and far-away or side-on shots. The product page lists every accepted format and the exact size limits, and those are the limits the upload endpoint enforces.</p><h2>Your photo is private</h2><p>Uploaded photos are stored in private object storage and are readable only through the application''s ownership checks.</p>',
   'published', 20);

-- ---- cms_pages: legal drafts (S-14 — these must stay visibly marked) ----
INSERT OR IGNORE INTO cms_pages (slug, kind, title, category, excerpt, body, status, sort_order) VALUES
  ('privacy-policy', 'legal', 'Privacy policy', '', 'Placeholder content — not final legal terms.',
   '<h2>1. Overview (draft)</h2><p>This draft describes the intended handling of personal data for a personalised children''s book service: photos uploaded for personalisation would be used solely to create the ordered product.</p><h2>2. Data and security (draft)</h2><p>In the current implementation, uploaded photos are stored in private object storage and are readable only through the application''s ownership checks. Authentication tokens and password-reset tokens are stored only as hashes. No retention or deletion schedule is deployed in this version.</p><h2>3. Orders, shipping and refunds (draft)</h2><p>Not applicable in this version: no real payment is collected, nothing is printed or shipped, and therefore no refund, delivery or satisfaction guarantee applies.</p><h2>4. Legal review required</h2><p>Owner action required: configure the final legal entity and contact address in the site settings, engage legal counsel, then replace this page with reviewed policy text before launch.</p>',
   'published', 10);
INSERT OR IGNORE INTO cms_pages (slug, kind, title, category, excerpt, body, status, sort_order) VALUES
  ('terms-and-conditions', 'legal', 'Terms and conditions', '', 'Placeholder content — not final legal terms.',
   '<h2>1. What this service is (draft)</h2><p>This draft describes the intended terms for a personalised children''s book service. It is not binding text.</p><h2>2. What this version does (draft)</h2><p>This version lets you build a personalisation and record a test order. It does not collect a real payment, print, ship, or provide refunds.</p><h2>3. Your content (draft)</h2><p>You would be responsible for having the right to upload the photograph you provide. Photos are stored privately and used only to build your own order.</p><h2>4. Legal review required</h2><p>Owner action required: this page must be replaced with jurisdiction-aware terms reviewed by qualified legal counsel before the storefront accepts real customers or payments.</p>',
   'published', 20);
INSERT OR IGNORE INTO cms_pages (slug, kind, title, category, excerpt, body, status, sort_order) VALUES
  ('refund-policy', 'refund', 'Refund policy', '', 'Placeholder content — no refunds apply in this version.',
   '<h2>1. Current status (draft)</h2><p>No refund policy applies in this version, because no real payment is collected. Orders placed here are test orders and there is nothing to refund.</p><h2>2. What a real policy would cover (draft)</h2><p>A production refund policy would need to describe cancellation windows, personalisation approval, and what happens when a printed item is faulty. None of that is implemented yet.</p><h2>3. Legal review required</h2><p>Owner action required: this page must be replaced with reviewed text before any real payment is taken.</p>',
   'published', 30);
INSERT OR IGNORE INTO cms_pages (slug, kind, title, category, excerpt, body, status, sort_order) VALUES
  ('shipping', 'shipping', 'Shipping information', '', 'Placeholder content — nothing is shipped in this version.',
   '<h2>1. Current status (draft)</h2><p>Shipping is not available in this version. No order placed today will be printed or shipped, and no delivery window is offered or implied.</p><h2>2. Why checkout still asks for an address</h2><p>The shipping details are recorded so the order record is complete and so a later fulfilment milestone has the data it needs. No shipment is created from them.</p><h2>3. Legal review required</h2><p>Owner action required: replace this page with real carrier, region and timing information before shipping is offered.</p>',
   'published', 40);

-- ---- site_settings: neutral defaults, all owner-overridable ----
-- The rows exist so the admin screen lists every override an operator can
-- set, but every VALUE starts EMPTY ON PURPOSE: a blank setting falls back to
-- the deployment's environment configuration (src/brand.ts::applyBrandSettings
-- ignores blanks). That is what keeps the L-D identity boundary a single
-- source of truth — a seeded non-empty value here would silently shadow a
-- BRAND_NAME set by the deployment.
INSERT OR IGNORE INTO site_settings (key, value, kind) VALUES
  ('brand.name', '', 'string'),
  ('brand.tagline', '', 'string'),
  ('brand.description', '', 'string'),
  ('brand.legal_name', '', 'string'),
  ('brand.contact_email', '', 'email'),
  ('brand.logo_path', '', 'url'),
  ('brand.copyright_year', '', 'number'),
  ('seo.default_title_suffix', 'Personalised storybooks', 'string'),
  ('seo.robots', 'index,follow', 'string');
