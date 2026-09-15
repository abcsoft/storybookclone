-- Migration 0025: V2 Phase 3 — original template scaffold, prompt versions,
-- generation limits and the consent version.
--
-- Forward-only. 0001-0024 are untouched by anything after this file.
--
-- WHY A SCAFFOLD TABLE: the ordered scene set, the placeholder contract and
-- the structured layout config are authored EXACTLY ONCE, here, as data an
-- operator can read and review. `ensurePublishedTemplateForProduct()`
-- (src/generation/templates.ts) instantiates an immutable published
-- `book_templates` version (plus its `book_scenes`/`scene_placeholders`) from
-- this scaffold for a given product + language. There is therefore no second
-- copy of the story structure in application code that could drift from the
-- schema, and adding a scene is a reviewed migration rather than a code edit.
--
-- ALL CONTENT IN THIS FILE IS ORIGINAL to this project. No story text,
-- illustration, prompt or title is copied from any reference product.

-- ===========================================================================
-- Scaffold tables
-- ===========================================================================
CREATE TABLE IF NOT EXISTS template_scaffolds (
  key TEXT PRIMARY KEY,                          -- e.g. 'picture-book-en-v1'
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  language_code TEXT NOT NULL REFERENCES languages(code) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS template_scaffold_scenes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scaffold_key TEXT NOT NULL REFERENCES template_scaffolds(key) ON DELETE CASCADE,
  scene_key TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cover', 'page', 'spread', 'back_cover')),
  -- Structured configuration ONLY (slots, output geometry, style tokens and a
  -- scene subject string). Validated strictly in
  -- src/generation/templates.ts; never evaluated as code.
  layout_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(layout_json)),
  UNIQUE(scaffold_key, scene_key)
);
CREATE INDEX IF NOT EXISTS idx_template_scaffold_scenes_order ON template_scaffold_scenes(scaffold_key, sort_order);

CREATE TABLE IF NOT EXISTS template_scaffold_placeholders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scaffold_scene_id INTEGER NOT NULL REFERENCES template_scaffold_scenes(id) ON DELETE CASCADE,
  placeholder_key TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('face', 'text', 'image_static')),
  required INTEGER NOT NULL DEFAULT 1,
  -- Plain data (e.g. {"source":"child_name","maxLength":24}). Read as values
  -- by application code; NEVER executed, interpolated into SQL/HTML, or used
  -- as a regular expression source.
  constraints_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(constraints_json)),
  UNIQUE(scaffold_scene_id, placeholder_key)
);

-- ===========================================================================
-- The original picture-book scaffold
-- ===========================================================================
INSERT OR IGNORE INTO template_scaffolds (key, name, description, language_code, version) VALUES
  ('picture-book-en-v1', 'Picture book (English)', 'The original six-scene picture-book structure this project authors and generates from: a cover, four story pages and a back cover.', 'en', 1);

-- The six scenes, in order. Every subject string and every slot is ours.
INSERT OR IGNORE INTO template_scaffold_scenes (scaffold_key, scene_key, sort_order, kind, layout_json) VALUES
  ('picture-book-en-v1', 'cover', 0, 'cover', '{"slots":[{"key":"face","box":[0.3,0.1,0.4,0.36]},{"key":"title","box":[0.08,0.56,0.84,0.18]}],"output":{"width":1200,"height":1500,"aspect":"4:5","printWidthIn":4,"printHeightIn":5,"minPpi":300},"style":{"palette":"first-light","mood":"warm"},"subject":"a child standing in an open doorway at first light, holding nothing, looking out"}'),
  ('picture-book-en-v1', 'page-01-the-quiet-door', 1, 'page', '{"slots":[{"key":"face","box":[0.36,0.1,0.28,0.26]},{"key":"story_text","box":[0.08,0.7,0.84,0.2]}],"output":{"width":1200,"height":1500,"aspect":"4:5","printWidthIn":4,"printHeightIn":5,"minPpi":300},"style":{"palette":"first-light","mood":"warm"},"subject":"a child stepping through a small round door into a garden that is taller than the house"}'),
  ('picture-book-en-v1', 'page-02-the-lantern-path', 2, 'page', '{"slots":[{"key":"face","box":[0.36,0.1,0.28,0.26]},{"key":"story_text","box":[0.08,0.7,0.84,0.2]}],"output":{"width":1200,"height":1500,"aspect":"4:5","printWidthIn":4,"printHeightIn":5,"minPpi":300},"style":{"palette":"dusk","mood":"curious"},"subject":"a child walking a winding path at dusk carrying one small lantern that lights only the next step"}'),
  ('picture-book-en-v1', 'page-03-the-kind-stranger', 3, 'page', '{"slots":[{"key":"face","box":[0.36,0.1,0.28,0.26]},{"key":"story_text","box":[0.08,0.7,0.84,0.2]}],"output":{"width":1200,"height":1500,"aspect":"4:5","printWidthIn":4,"printHeightIn":5,"minPpi":300},"style":{"palette":"dusk","mood":"gentle"},"subject":"a child sharing bread with a tall gentle stranger beside a stream, both sitting on stones"}'),
  ('picture-book-en-v1', 'page-04-the-way-home', 4, 'page', '{"slots":[{"key":"face","box":[0.36,0.1,0.28,0.26]},{"key":"story_text","box":[0.08,0.7,0.84,0.2]}],"output":{"width":1200,"height":1500,"aspect":"4:5","printWidthIn":4,"printHeightIn":5,"minPpi":300},"style":{"palette":"sunset","mood":"triumphant"},"subject":"a child running home along the same path at sunset, the lantern now held high and bright"}'),
  ('picture-book-en-v1', 'back-cover', 5, 'back_cover', '{"slots":[{"key":"dedication","box":[0.12,0.28,0.76,0.4]}],"output":{"width":1200,"height":1500,"aspect":"4:5","printWidthIn":4,"printHeightIn":5,"minPpi":300},"style":{"palette":"sunset","mood":"warm"},"subject":"a closed picture book resting on a window sill with the sun going down behind it"}');

-- The placeholder contract for each scene.
INSERT OR IGNORE INTO template_scaffold_placeholders (scaffold_scene_id, placeholder_key, type, required, constraints_json)
  SELECT id, 'face', 'face', 1, '{"source":"selected_face","minConfidence":0.5}' FROM template_scaffold_scenes WHERE scaffold_key = 'picture-book-en-v1' AND scene_key = 'cover';
INSERT OR IGNORE INTO template_scaffold_placeholders (scaffold_scene_id, placeholder_key, type, required, constraints_json)
  SELECT id, 'title', 'text', 1, '{"source":"child_name","maxLength":24,"minLength":1}' FROM template_scaffold_scenes WHERE scaffold_key = 'picture-book-en-v1' AND scene_key = 'cover';
INSERT OR IGNORE INTO template_scaffold_placeholders (scaffold_scene_id, placeholder_key, type, required, constraints_json)
  SELECT id, 'face', 'face', 1, '{"source":"selected_face","minConfidence":0.5}' FROM template_scaffold_scenes WHERE scaffold_key = 'picture-book-en-v1' AND scene_key = 'page-01-the-quiet-door';
INSERT OR IGNORE INTO template_scaffold_placeholders (scaffold_scene_id, placeholder_key, type, required, constraints_json)
  SELECT id, 'story_text', 'text', 1, '{"source":"generated_story","maxWords":40,"minWords":4}' FROM template_scaffold_scenes WHERE scaffold_key = 'picture-book-en-v1' AND scene_key = 'page-01-the-quiet-door';
INSERT OR IGNORE INTO template_scaffold_placeholders (scaffold_scene_id, placeholder_key, type, required, constraints_json)
  SELECT id, 'face', 'face', 1, '{"source":"selected_face","minConfidence":0.5}' FROM template_scaffold_scenes WHERE scaffold_key = 'picture-book-en-v1' AND scene_key = 'page-02-the-lantern-path';
INSERT OR IGNORE INTO template_scaffold_placeholders (scaffold_scene_id, placeholder_key, type, required, constraints_json)
  SELECT id, 'story_text', 'text', 1, '{"source":"generated_story","maxWords":40,"minWords":4}' FROM template_scaffold_scenes WHERE scaffold_key = 'picture-book-en-v1' AND scene_key = 'page-02-the-lantern-path';
INSERT OR IGNORE INTO template_scaffold_placeholders (scaffold_scene_id, placeholder_key, type, required, constraints_json)
  SELECT id, 'face', 'face', 1, '{"source":"selected_face","minConfidence":0.5}' FROM template_scaffold_scenes WHERE scaffold_key = 'picture-book-en-v1' AND scene_key = 'page-03-the-kind-stranger';
INSERT OR IGNORE INTO template_scaffold_placeholders (scaffold_scene_id, placeholder_key, type, required, constraints_json)
  SELECT id, 'story_text', 'text', 1, '{"source":"generated_story","maxWords":40,"minWords":4}' FROM template_scaffold_scenes WHERE scaffold_key = 'picture-book-en-v1' AND scene_key = 'page-03-the-kind-stranger';
INSERT OR IGNORE INTO template_scaffold_placeholders (scaffold_scene_id, placeholder_key, type, required, constraints_json)
  SELECT id, 'face', 'face', 1, '{"source":"selected_face","minConfidence":0.5}' FROM template_scaffold_scenes WHERE scaffold_key = 'picture-book-en-v1' AND scene_key = 'page-04-the-way-home';
INSERT OR IGNORE INTO template_scaffold_placeholders (scaffold_scene_id, placeholder_key, type, required, constraints_json)
  SELECT id, 'story_text', 'text', 1, '{"source":"generated_story","maxWords":40,"minWords":4}' FROM template_scaffold_scenes WHERE scaffold_key = 'picture-book-en-v1' AND scene_key = 'page-04-the-way-home';
INSERT OR IGNORE INTO template_scaffold_placeholders (scaffold_scene_id, placeholder_key, type, required, constraints_json)
  SELECT id, 'dedication', 'text', 0, '{"source":"dedication","maxLength":200,"minLength":0}' FROM template_scaffold_scenes WHERE scaffold_key = 'picture-book-en-v1' AND scene_key = 'back-cover';

-- ===========================================================================
-- Prompt versions (GEN-01) — original prompt templates, authored here.
-- ===========================================================================
-- One published local version per kind, bound to the deterministic offline
-- provider so a local/CI run can exercise the whole pipeline with ZERO paid
-- calls. The `provider` column is what actually selects the adapter at run
-- time, so shipping these as `published` cannot reach a paid endpoint: the
-- deterministic adapter additionally refuses to exist outside an explicitly
-- configured development environment (src/generation/providers/index.ts).
--
-- A draft sibling per kind shows the documented real-adapter path: an operator
-- configures GENERATION_<KIND>_API_URL / _API_KEY, then publishes the http
-- version on /admin/generation/prompts. Nothing runs over HTTP until then.
INSERT OR IGNORE INTO prompt_versions (prompt_key, kind, version, status, provider, model, params_json, template_text, published_at) VALUES
  ('scene.story_text', 'story_text', 1, 'published', 'deterministic-fake', 'original-deterministic-text-1', '{"temperature":0,"maxWords":40}',
   'Write ONE short, gentle sentence for a page of a children''s picture book.
Child name: {{child_name}}
Child age: {{child_age}}
Language: {{language}}
Scene: {{scene_subject}}
Rules: at most {{max_words}} words, no brand names, no rhyming couplets, end with a full stop.',
   CURRENT_TIMESTAMP),
  ('scene.illustration', 'illustration', 1, 'published', 'deterministic-fake', 'original-deterministic-image-1', '{"guidanceScale":7,"steps":30}',
   'Illustrate ONE scene for a children''s picture book, warm hand-painted style, no text and no logos.
Scene: {{scene_subject}}
Recurring child: {{child_name}}, age {{child_age}}
Palette: {{style_palette}} ({{style_mood}})
Show exactly one child. Canvas: {{output_width}}x{{output_height}} pixels, aspect {{output_aspect}}.',
   CURRENT_TIMESTAMP),
  ('scene.translation', 'translation', 1, 'published', 'deterministic-fake', 'original-deterministic-translate-1', '{"temperature":0}',
   'Translate this children''s picture-book line into {{language}}. Keep it warm and simple. Reply with the translation only.
Source: {{source_text}}',
   CURRENT_TIMESTAMP),
  ('asset.validation', 'validation', 1, 'published', 'deterministic-fake', 'original-deterministic-validate-1', '{"temperature":0}',
   'Review the supplied output for a children''s picture book and report: the number of children visible, whether it matches the described scene, and whether it contains unsafe content. Scene: {{scene_subject}}',
   CURRENT_TIMESTAMP),
  ('scene.story_text', 'story_text', 2, 'draft', 'http', 'configure-your-model', '{"temperature":0.6,"maxWords":40}',
   'Write ONE short, gentle sentence for a page of a children''s picture book.
Child name: {{child_name}}
Child age: {{child_age}}
Language: {{language}}
Scene: {{scene_subject}}
Rules: at most {{max_words}} words, no brand names, no rhyming couplets, end with a full stop.',
   NULL),
  ('scene.illustration', 'illustration', 2, 'draft', 'http', 'configure-your-model', '{"guidanceScale":7,"steps":30}',
   'Illustrate ONE scene for a children''s picture book, warm hand-painted style, no text and no logos.
Scene: {{scene_subject}}
Recurring child: {{child_name}}, age {{child_age}}
Palette: {{style_palette}} ({{style_mood}})
Show exactly one child. Canvas: {{output_width}}x{{output_height}} pixels, aspect {{output_aspect}}.',
   NULL),
  ('scene.translation', 'translation', 2, 'draft', 'http', 'configure-your-model', '{"temperature":0}',
   'Translate this children''s picture-book line into {{language}}. Keep it warm and simple. Reply with the translation only.
Source: {{source_text}}',
   NULL),
  ('asset.validation', 'validation', 2, 'draft', 'http', 'configure-your-model', '{"temperature":0}',
   'Review the supplied output for a children''s picture book and report: the number of children visible, whether it matches the described scene, and whether it contains unsafe content. Scene: {{scene_subject}}',
   NULL);

-- ===========================================================================
-- Generation limits (GEN-12) — operator-editable, no deploy needed.
-- ===========================================================================
INSERT OR IGNORE INTO generation_limits (key, value, kind, description) VALUES
  ('generation.owner_jobs_per_window', '10', 'number', 'Maximum generation jobs a single owner (account or guest capability) may start inside the quota window.'),
  ('generation.owner_window_seconds', '86400', 'number', 'Quota window length for the per-owner job limit (seconds).'),
  ('generation.global_jobs_per_window', '200', 'number', 'Maximum generation jobs the whole deployment may start inside the global quota window.'),
  ('generation.global_window_seconds', '86400', 'number', 'Quota window length for the global job limit (seconds).'),
  ('generation.global_cost_minor_per_window', '200000', 'number', 'Maximum provider spend (integer minor units) the deployment may accumulate inside the global window before new jobs are refused. A real ceiling on runaway spend, not a display value.'),
  ('generation.max_scenes_per_job', '24', 'number', 'Hard cap on how many scenes one job may generate, so a malformed template cannot fan out into unbounded provider calls.'),
  ('generation.lease_seconds', '120', 'number', 'How long a consumer lease is valid before another consumer may reclaim the job (and how often a heartbeat must renew it).'),
  ('generation.max_attempts', '3', 'number', 'Attempts (including the first) before a job or task is dead-lettered.');

-- ===========================================================================
-- Consent version (PER-09)
-- ===========================================================================
-- The wording itself is the reviewed content page named in `page_slug`;
-- `summary` restates it for the admin surface, and `text_hash` is the SHA-256
-- of exactly that summary so the stored hash and the stored wording can be
-- verified against each other (asserted in the Phase 3 unit suite).
INSERT OR IGNORE INTO consent_versions (key, version, status, title, summary, text_hash, page_slug, published_at) VALUES
  ('personalization_photo_processing', '2026-09-01', 'published',
   'Photo processing for your personalised book',
   'To create your personalised book we process the photo you upload: we look for a face, we build a private illustration that includes your child, and we check the result. Your photo and the illustrations built from it stay private to your account, are never shown publicly, and are deleted on the retention date you were shown when you gave consent. You can ask us to delete them sooner at any time.',
   '7477f93e535a47be18ccb3312b4bd430368f38bcaf9a4b7eeb548f6ea8f12449',
   'support/photo-guidelines',
   CURRENT_TIMESTAMP);
