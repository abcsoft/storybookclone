-- Migration 0010: Phase 2 personalization domain — catalog layer.
-- Forward-only. Nothing in 0001-0009 is edited, reordered, or dropped.
--
-- This is the first of four Phase 2 migrations (0010-0013), split by
-- concern for reviewability:
--   0010 catalog:    languages, product_localizations, book_templates,
--                     book_scenes, scene_placeholders
--   0011 ownership:  prospects, user_books, personalization_inputs,
--                     detected_faces (+ photo_uploads two-phase columns)
--   0012 review:     preview_versions, preview_assets, revision_requests,
--                     approvals, user_book_events
--   0013 order link: order_items.user_book_id / personalization_input_revision
--
-- None of this wires up real AI generation, payment, email, PDF rendering,
-- or fulfillment — those are explicitly later phases. This migration only
-- establishes structure.

-- ---- languages ----
-- BCP-47-compatible codes. Seeded to match the existing storefront's plain-
-- English language names (src/data.ts's `languages` array) so Phase 2 can
-- key by code internally while still presenting the same names the UI
-- already shows. `fallback_code` lets a not-yet-localized product still
-- resolve to English content instead of failing outright.
CREATE TABLE IF NOT EXISTS languages (
  code TEXT PRIMARY KEY,                                  -- e.g. 'en', 'es', 'pt-BR', 'ar'
  name TEXT NOT NULL,                                      -- English display name, e.g. "Spanish"
  native_name TEXT NOT NULL,                                -- e.g. "Español"
  direction TEXT NOT NULL DEFAULT 'ltr' CHECK (direction IN ('ltr', 'rtl')),
  fallback_code TEXT REFERENCES languages(code) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_languages_active ON languages(active);

INSERT OR IGNORE INTO languages (code, name, native_name, direction, fallback_code) VALUES
  ('en', 'English', 'English', 'ltr', NULL),
  ('es', 'Spanish', 'Español', 'ltr', 'en'),
  ('pt-BR', 'Portuguese (Brazil)', 'Português (Brasil)', 'ltr', 'en'),
  ('ar', 'Arabic', 'العربية', 'rtl', 'en'),
  ('fr', 'French', 'Français', 'ltr', 'en'),
  ('tr', 'Turkish', 'Türkçe', 'ltr', 'en'),
  ('de', 'German', 'Deutsch', 'ltr', 'en'),
  ('it', 'Italian', 'Italiano', 'ltr', 'en'),
  ('nl', 'Dutch', 'Nederlands', 'ltr', 'en'),
  ('sq', 'Albanian', 'Shqip', 'ltr', 'en');

-- ---- product_localizations ----
-- Per-language product copy, versioned. Only one row per (product,
-- language) may be 'published' at a time — the partial unique index below
-- enforces that at the database level, not just in application code.
CREATE TABLE IF NOT EXISTS product_localizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  language_code TEXT NOT NULL REFERENCES languages(code) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  story TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(product_id, language_code, version)
);
CREATE INDEX IF NOT EXISTS idx_product_localizations_lookup ON product_localizations(product_id, language_code, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_localizations_one_published
  ON product_localizations(product_id, language_code) WHERE status = 'published';

-- ---- book_templates ----
-- One version per (product, language). Immutable once it leaves 'draft':
-- its identity fields can never change, it can never revert from
-- 'published' to 'draft', and a 'retired' template can never come back.
CREATE TABLE IF NOT EXISTS book_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  language_code TEXT NOT NULL REFERENCES languages(code) ON DELETE RESTRICT,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  published_at DATETIME,
  UNIQUE(product_id, language_code, version)
);
CREATE INDEX IF NOT EXISTS idx_book_templates_lookup ON book_templates(product_id, language_code, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_book_templates_one_published
  ON book_templates(product_id, language_code) WHERE status = 'published';

CREATE TRIGGER IF NOT EXISTS trg_book_templates_identity_immutable
BEFORE UPDATE OF product_id, language_code, version ON book_templates
WHEN OLD.status != 'draft'
BEGIN
  SELECT RAISE(ABORT, 'book_templates: identity fields are immutable once published or retired');
END;

CREATE TRIGGER IF NOT EXISTS trg_book_templates_no_unpublish
BEFORE UPDATE OF status ON book_templates
WHEN OLD.status = 'published' AND NEW.status = 'draft'
BEGIN
  SELECT RAISE(ABORT, 'book_templates: a published template cannot revert to draft');
END;

CREATE TRIGGER IF NOT EXISTS trg_book_templates_no_revive
BEFORE UPDATE OF status ON book_templates
WHEN OLD.status = 'retired' AND NEW.status != 'retired'
BEGIN
  SELECT RAISE(ABORT, 'book_templates: a retired template cannot be revived');
END;

-- ---- book_scenes ----
-- Ordered pages/spreads for a template. `layout_json` is structured
-- configuration ONLY (positions, placeholder slots, style tokens) — never
-- raw HTML or a script of any kind. json_valid() is a cheap DB-level
-- sanity check (it is valid JSON at all); the actual shape is validated in
-- application code, which never evaluates it as code, only reads it as data.
CREATE TABLE IF NOT EXISTS book_scenes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES book_templates(id) ON DELETE CASCADE,
  scene_key TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'page' CHECK (kind IN ('cover', 'page', 'spread', 'back_cover')),
  layout_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(layout_json)),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(template_id, scene_key)
);
CREATE INDEX IF NOT EXISTS idx_book_scenes_template_order ON book_scenes(template_id, sort_order);

CREATE TRIGGER IF NOT EXISTS trg_book_scenes_immutable_once_published
BEFORE UPDATE ON book_scenes
WHEN (SELECT status FROM book_templates WHERE id = OLD.template_id) != 'draft'
BEGIN
  SELECT RAISE(ABORT, 'book_scenes: immutable once the owning template leaves draft');
END;

-- ---- scene_placeholders ----
-- What a scene expects to be filled in (a face, a text field, a static
-- image) and how to validate it — `constraints_json` is read as plain data
-- (e.g. {"maxLength":24}) by application code, never evaluated as code.
CREATE TABLE IF NOT EXISTS scene_placeholders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL REFERENCES book_scenes(id) ON DELETE CASCADE,
  placeholder_key TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('face', 'text', 'image_static')),
  required INTEGER NOT NULL DEFAULT 1,
  constraints_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(constraints_json)),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(scene_id, placeholder_key)
);
CREATE INDEX IF NOT EXISTS idx_scene_placeholders_scene ON scene_placeholders(scene_id);

CREATE TRIGGER IF NOT EXISTS trg_scene_placeholders_immutable_once_published
BEFORE UPDATE ON scene_placeholders
WHEN (
  SELECT bt.status FROM book_scenes bs JOIN book_templates bt ON bt.id = bs.template_id WHERE bs.id = OLD.scene_id
) != 'draft'
BEGIN
  SELECT RAISE(ABORT, 'scene_placeholders: immutable once the owning template leaves draft');
END;
