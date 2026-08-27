-- PDP (Product Detail Page) content editor.
-- Every product has a row here; sections below are stored separately.

CREATE TABLE IF NOT EXISTS pdp_page (
  product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  banner_text TEXT DEFAULT 'Save 20% on 3+ items using code: RATRI20',
  banner_code TEXT DEFAULT 'RATRI20',
  banner_badge TEXT DEFAULT 'SAVE 40%',
  preorder_note TEXT DEFAULT '',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Hero gallery (left thumbnail rail + main image)
CREATE TABLE IF NOT EXISTS pdp_gallery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  alt TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_pdp_gallery_product ON pdp_gallery(product_id, sort_order);

-- Hero accordions ("How is the book personalised…", "Changes after…", "Size & Quality")
CREATE TABLE IF NOT EXISTS pdp_accordions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_pdp_accordions_product ON pdp_accordions(product_id, sort_order);

-- "Start Personalising" — three numbered steps
CREATE TABLE IF NOT EXISTS pdp_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  step_no INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pdp_steps_product ON pdp_steps(product_id, step_no);

-- Photo upload tips (Bad vs Good examples for the personalised photo)
CREATE TABLE IF NOT EXISTS pdp_photo_tips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,            -- 'bad' or 'good'
  label TEXT NOT NULL,
  image_url TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_pdp_photo_tips_product ON pdp_photo_tips(product_id, kind, sort_order);

-- "See how a simple photo becomes a beautiful story" before/after
CREATE TABLE IF NOT EXISTS pdp_magic (
  product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  heading TEXT DEFAULT 'See How a Simple Photo Becomes a Beautiful Story',
  left_image TEXT DEFAULT '',
  left_caption TEXT DEFAULT '',
  right_image TEXT DEFAULT '',
  right_caption TEXT DEFAULT '',
  body TEXT DEFAULT ''
);

-- "Why 100K+ parents trust WonderWraps" — three cards
CREATE TABLE IF NOT EXISTS pdp_trust (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  icon TEXT DEFAULT 'sparkle',
  sort_order INTEGER DEFAULT 0
);

-- "Reactions You Can Count On" — review cards
CREATE TABLE IF NOT EXISTS pdp_reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  rating INTEGER DEFAULT 5,
  review TEXT NOT NULL,
  image_url TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);

-- "Featured on" media logos
CREATE TABLE IF NOT EXISTS pdp_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  image_url TEXT DEFAULT '',
  href TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0
);

-- "You may also like" related product handles (manual selection)
CREATE TABLE IF NOT EXISTS pdp_related (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  related_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sort_order INTEGER DEFAULT 0,
  PRIMARY KEY (product_id, related_id)
);

-- Frequently asked questions on the product page (per product)
CREATE TABLE IF NOT EXISTS pdp_faqs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_pdp_faqs_product ON pdp_faqs(product_id, sort_order);
