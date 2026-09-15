-- Migration 0024: V2 Phase 3 — generation pipeline STRUCTURE.
-- Forward-only. 0001-0023 are PUBLISHED and byte-identical; every schema
-- change in Phase 3 lives here or in 0025.
--
-- Scope (GEN-01..GEN-12, PER-06/07/09, ADM-08/09/10/11):
--   * prompt_versions / template_prompt_versions  — immutable prompt+model+
--     config versions and the exact prompt versions a template pins (GEN-01).
--   * generation_jobs / generation_tasks          — durable queue state with
--     leases, heartbeat, retry scheduling and cancellation (GEN-04/GEN-05).
--   * generation_attempts / provider_events       — append-only attempt and
--     (sanitized) provider-event history (GEN-05/GEN-06).
--   * generated_assets                            — per-scene outputs with full
--     lineage and checksums (GEN-06).
--   * generation_usage_events                     — the cost/token ledger, with
--     a per-attempt uniqueness authority so a replayed delivery cannot
--     double-bill (GEN-10/GEN-12).
--   * generation_dead_letters                     — the dead-letter surface.
--   * generation_quota_windows / generation_limits — abuse and spend control.
--   * consent_versions + consent-version columns  — PER-09.
--   * preview_versions / preview_assets additions  — preview lineage, watermark
--     and dimension columns (GEN-08).
--
-- IMPORTANT — what is deliberately NOT changed:
--   * `preview_versions`' `trg_preview_versions_no_update` trigger is left
--     EXACTLY as published in 0012. Phase 3 therefore never UPDATEs a
--     preview_versions row: a preview row is INSERTed once, already `ready`,
--     at the single moment a verified multi-scene preview genuinely exists.
--     An in-flight/failed generation is represented by generation_jobs, never
--     by a fabricated `pending` preview row.
--   * `retention_failures.object_type` keeps its 0014 CHECK. Generated-asset
--     deletion tombstones get their own table below instead of widening a
--     published constraint (which would require a table rebuild).
--
-- D1 runs with foreign keys ON and (like every earlier migration here)
-- rejects a NULL/duplicate/illegal row at the schema level wherever the
-- invariant can be expressed declaratively.

-- ===========================================================================
-- GEN-01: prompt + model + config versions
-- ===========================================================================
-- Same immutability discipline as book_templates (0010): identity is frozen
-- the moment a version leaves 'draft', a published version can never revert
-- to draft, a retired version can never be revived, and only ONE published
-- version per prompt_key may exist. Editing a published prompt means cloning
-- a new version — never mutating the old one, because a generated asset's
-- lineage points at the exact version that produced it.
--
-- `template_text` uses declared {{placeholder}} tokens that this project
-- substitutes as plain values. It is NEVER evaluated as code, never
-- `eval`'d, never interpolated into SQL/HTML, and never executed.
CREATE TABLE IF NOT EXISTS prompt_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_key TEXT NOT NULL,                     -- stable, e.g. 'scene.story_text'
  kind TEXT NOT NULL CHECK (kind IN ('story_text', 'illustration', 'translation', 'validation')),
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  provider TEXT NOT NULL,                       -- adapter key, e.g. 'deterministic-fake' | 'http'
  model TEXT NOT NULL,                          -- model identifier string
  params_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(params_json)),
  template_text TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  published_at DATETIME,
  UNIQUE(prompt_key, version)
);
CREATE INDEX IF NOT EXISTS idx_prompt_versions_lookup ON prompt_versions(prompt_key, kind, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_versions_one_published
  ON prompt_versions(prompt_key) WHERE status = 'published';

CREATE TRIGGER IF NOT EXISTS trg_prompt_versions_identity_immutable
BEFORE UPDATE OF prompt_key, kind, version ON prompt_versions
WHEN OLD.status != 'draft'
BEGIN
  SELECT RAISE(ABORT, 'prompt_versions: identity fields are immutable once published or retired');
END;

CREATE TRIGGER IF NOT EXISTS trg_prompt_versions_no_unpublish
BEFORE UPDATE OF status ON prompt_versions
WHEN OLD.status = 'published' AND NEW.status = 'draft'
BEGIN
  SELECT RAISE(ABORT, 'prompt_versions: a published prompt version cannot revert to draft');
END;

CREATE TRIGGER IF NOT EXISTS trg_prompt_versions_no_revive
BEFORE UPDATE OF status ON prompt_versions
WHEN OLD.status = 'retired' AND NEW.status != 'retired'
BEGIN
  SELECT RAISE(ABORT, 'prompt_versions: a retired prompt version cannot be revived');
END;

-- A published/used prompt version's prompt text and model binding are frozen:
-- silently editing the wording would make every existing asset's recorded
-- lineage a lie.
CREATE TRIGGER IF NOT EXISTS trg_prompt_versions_body_immutable
BEFORE UPDATE OF template_text, provider, model, params_json ON prompt_versions
WHEN OLD.status != 'draft'
BEGIN
  SELECT RAISE(ABORT, 'prompt_versions: prompt text/model/config are immutable once published — clone a new version');
END;

-- Which exact prompt version each kind resolves to for a template. A template
-- that has left draft pins its prompts permanently, so "what produced this
-- page" is answerable from the template id alone.
CREATE TABLE IF NOT EXISTS template_prompt_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES book_templates(id) ON DELETE CASCADE,
  prompt_version_id INTEGER NOT NULL REFERENCES prompt_versions(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('story_text', 'illustration', 'translation')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(template_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_template_prompt_versions_template ON template_prompt_versions(template_id);
CREATE INDEX IF NOT EXISTS idx_template_prompt_versions_prompt ON template_prompt_versions(prompt_version_id);

CREATE TRIGGER IF NOT EXISTS trg_template_prompt_versions_immutable_once_published
BEFORE UPDATE ON template_prompt_versions
WHEN (SELECT status FROM book_templates WHERE id = OLD.template_id) != 'draft'
BEGIN
  SELECT RAISE(ABORT, 'template_prompt_versions: immutable once the owning template leaves draft');
END;

-- ===========================================================================
-- PER-09: consent versions
-- ===========================================================================
-- The published text itself lives in cms_pages (reviewed like any other legal
-- copy); this table records WHICH version wording was in force and a hash of
-- it, so "what exactly did this person agree to" is answerable later without
-- storing a second copy of the text.
CREATE TABLE IF NOT EXISTS consent_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,                            -- e.g. 'personalization_photo_processing'
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  text_hash TEXT NOT NULL,                      -- SHA-256 of the published wording
  page_slug TEXT,                               -- where the wording is readable
  published_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(key, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_consent_versions_one_published
  ON consent_versions(key) WHERE status = 'published';

CREATE TRIGGER IF NOT EXISTS trg_consent_versions_identity_immutable
BEFORE UPDATE OF key, version, text_hash ON consent_versions
WHEN OLD.status != 'draft'
BEGIN
  SELECT RAISE(ABORT, 'consent_versions: identity and text hash are immutable once published');
END;

-- The consent version an owner actually accepted. NULL means "recorded before
-- consent versioning existed" — never back-filled with a guess.
ALTER TABLE prospects ADD COLUMN consent_version TEXT;
ALTER TABLE user_books ADD COLUMN consent_version TEXT;

-- ===========================================================================
-- GEN-04 / GEN-05: durable jobs
-- ===========================================================================
-- The job row IS the durable work record; a queue message is only a hint that
-- wakes a consumer. Every state change is one guarded compare-and-swap UPDATE,
-- so duplicate delivery and two concurrent consumers are both harmless.
--
-- Status machine (mirrors STORYBOOKCLONE_COMPLETE_CODING_PACK_V2.md §7):
--   queued -> leased -> running -> succeeded
--                      |        -> retry_wait -> queued
--                      |        -> failed_permanent
--                      |        -> dead_letter
--                      -> cancelled
--   plus `superseded`: the work completed but its input revision was no
--   longer current, so the output was discarded rather than published
--   (GEN-11 stale-revision protection).
CREATE TABLE IF NOT EXISTS generation_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  user_book_id INTEGER NOT NULL REFERENCES user_books(id) ON DELETE CASCADE,
  input_revision INTEGER NOT NULL,
  template_id INTEGER NOT NULL REFERENCES book_templates(id) ON DELETE RESTRICT,
  preview_version_id INTEGER REFERENCES preview_versions(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'leased', 'running', 'retry_wait', 'succeeded', 'failed_permanent', 'dead_letter', 'cancelled', 'superseded')),
  priority INTEGER NOT NULL DEFAULT 100,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  available_at INTEGER NOT NULL DEFAULT 0,        -- unix seconds; the backoff gate
  lease_owner TEXT,
  lease_expires_at INTEGER,                        -- unix seconds
  heartbeat_at INTEGER,                            -- unix seconds
  last_error_code TEXT,
  last_error_message TEXT,
  cancel_requested_at DATETIME,
  cancelled_by_type TEXT CHECK (cancelled_by_type IS NULL OR cancelled_by_type IN ('user', 'prospect', 'admin', 'system')),
  cancelled_by_id TEXT,
  correlation_id TEXT NOT NULL,
  idempotency_key TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME,
  FOREIGN KEY (user_book_id, input_revision) REFERENCES personalization_inputs(user_book_id, revision) ON DELETE CASCADE
);
-- THE idempotency authority for billable work (GEN-05/GEN-12): at most ONE job
-- per (book, input revision, template). A duplicate request — whether it comes
-- from a double-clicked button, a retried HTTP call or a replayed queue
-- message — collides with this index and returns the existing job instead of
-- starting (and paying for) a second one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_jobs_idempotent
  ON generation_jobs(user_book_id, input_revision, template_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_jobs_request_key
  ON generation_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_generation_jobs_dispatch ON generation_jobs(status, available_at, priority);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_lease ON generation_jobs(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_book ON generation_jobs(user_book_id, created_at);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_preview ON generation_jobs(preview_version_id);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_correlation ON generation_jobs(correlation_id);

CREATE TRIGGER IF NOT EXISTS trg_generation_jobs_status_flow
BEFORE UPDATE OF status ON generation_jobs
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'queued'          AND NEW.status IN ('leased', 'cancelled', 'superseded')) OR
  (OLD.status = 'leased'          AND NEW.status IN ('running', 'queued', 'retry_wait', 'dead_letter', 'cancelled', 'superseded')) OR
  (OLD.status = 'running'         AND NEW.status IN ('succeeded', 'queued', 'retry_wait', 'failed_permanent', 'dead_letter', 'cancelled', 'superseded')) OR
  (OLD.status = 'retry_wait'      AND NEW.status IN ('queued', 'dead_letter', 'cancelled', 'superseded')) OR
  (OLD.status = 'failed_permanent' AND NEW.status IN ('queued', 'cancelled')) OR
  (OLD.status = 'dead_letter'     AND NEW.status IN ('queued', 'cancelled'))
)
BEGIN
  SELECT RAISE(ABORT, 'generation_jobs: illegal status transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_generation_jobs_identity_immutable
BEFORE UPDATE ON generation_jobs
WHEN NEW.public_id <> OLD.public_id
  OR NEW.user_book_id <> OLD.user_book_id
  OR NEW.input_revision <> OLD.input_revision
  OR NEW.template_id <> OLD.template_id
  OR NEW.correlation_id <> OLD.correlation_id
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'generation_jobs: identity columns are immutable');
END;

-- A finished job is frozen. `failed_permanent`/`dead_letter` are deliberately
-- NOT in this list: an explicit operator retry is a legitimate transition
-- (`-> queued`), and the flow trigger above is still the gate for it.
CREATE TRIGGER IF NOT EXISTS trg_generation_jobs_terminal_frozen
BEFORE UPDATE ON generation_jobs
WHEN OLD.status IN ('succeeded', 'cancelled', 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'generation_jobs: a succeeded/cancelled/superseded job is immutable');
END;

-- ===========================================================================
-- GEN-04 / GEN-06: per-scene tasks
-- ===========================================================================
CREATE TABLE IF NOT EXISTS generation_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  scene_id INTEGER REFERENCES book_scenes(id) ON DELETE RESTRICT,
  scene_key TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('story_text', 'illustration', 'translation', 'preview_render')),
  sort_order INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'leased', 'running', 'retry_wait', 'succeeded', 'failed_permanent', 'dead_letter', 'cancelled', 'skipped')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  available_at INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  heartbeat_at INTEGER,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME,
  CHECK (
    (kind = 'preview_render' AND scene_id IS NULL) OR
    (kind IN ('story_text', 'illustration', 'translation') AND scene_id IS NOT NULL)
  )
);
-- One task per (job, scene, kind) — a replayed delivery cannot fan a scene out
-- into two billable provider calls.
CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_tasks_unique
  ON generation_tasks(job_id, COALESCE(scene_id, 0), kind);
CREATE INDEX IF NOT EXISTS idx_generation_tasks_job_order ON generation_tasks(job_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_generation_tasks_dispatch ON generation_tasks(status, available_at);
CREATE INDEX IF NOT EXISTS idx_generation_tasks_lease ON generation_tasks(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_generation_tasks_scene ON generation_tasks(scene_id);

-- NOTE ON `queued -> running`: a JOB separates "leased" from "running" because
-- a lease is visible to the customer and to other consumers as "someone owns
-- this work". A TASK does not: `claimTask()` acquires the task lease and starts
-- the provider call in the SAME statement, so requiring an intermediate
-- 'leased' write would add a round trip that means nothing. The job-level
-- queue -> leased -> running contract is unchanged.
CREATE TRIGGER IF NOT EXISTS trg_generation_tasks_status_flow
BEFORE UPDATE OF status ON generation_tasks
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'queued'          AND NEW.status IN ('leased', 'running', 'cancelled', 'skipped')) OR
  (OLD.status = 'leased'          AND NEW.status IN ('running', 'queued', 'retry_wait', 'dead_letter', 'cancelled', 'skipped')) OR
  (OLD.status = 'running'         AND NEW.status IN ('succeeded', 'queued', 'retry_wait', 'failed_permanent', 'dead_letter', 'cancelled', 'skipped')) OR
  (OLD.status = 'retry_wait'      AND NEW.status IN ('queued', 'running', 'dead_letter', 'cancelled', 'skipped')) OR
  (OLD.status = 'failed_permanent' AND NEW.status IN ('queued', 'cancelled')) OR
  (OLD.status = 'dead_letter'     AND NEW.status IN ('queued', 'cancelled'))
)
BEGIN
  SELECT RAISE(ABORT, 'generation_tasks: illegal status transition');
END;

-- ===========================================================================
-- GEN-06: generated assets with lineage + checksums
-- ===========================================================================
-- `asset_type` separates the private ORIGINAL from the watermarked preview
-- derivative. Originals live under the `gen/original/` R2 prefix and are never
-- served to a browser; preview derivatives live under `gen/preview/` and are
-- only ever streamed through an entitlement-checked route.
CREATE TABLE IF NOT EXISTS generated_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES generation_tasks(id) ON DELETE CASCADE,
  user_book_id INTEGER NOT NULL REFERENCES user_books(id) ON DELETE CASCADE,
  input_revision INTEGER NOT NULL,
  template_id INTEGER NOT NULL REFERENCES book_templates(id) ON DELETE RESTRICT,
  scene_id INTEGER REFERENCES book_scenes(id) ON DELETE SET NULL,
  scene_key TEXT,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('story_text', 'illustration_original', 'illustration_watermarked', 'page_preview', 'thumbnail')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version_id INTEGER REFERENCES prompt_versions(id) ON DELETE RESTRICT,
  prompt_hash TEXT,                          -- SHA-256 of the resolved prompt
  checksum TEXT NOT NULL,                    -- SHA-256 of the stored bytes/text
  object_key TEXT,                           -- private R2 key; NULL for text assets
  text_content TEXT,                         -- story text; NULL for image assets
  mime_type TEXT,
  width INTEGER,
  height INTEGER,
  byte_size INTEGER,
  is_watermarked INTEGER NOT NULL DEFAULT 0,
  cost_minor INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  validation_status TEXT NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending', 'passed', 'failed')),
  validation_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(validation_json)),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(task_id, asset_type)
);
CREATE INDEX IF NOT EXISTS idx_generated_assets_job ON generated_assets(job_id);
CREATE INDEX IF NOT EXISTS idx_generated_assets_task ON generated_assets(task_id);
CREATE INDEX IF NOT EXISTS idx_generated_assets_book_revision ON generated_assets(user_book_id, input_revision);
CREATE INDEX IF NOT EXISTS idx_generated_assets_scene ON generated_assets(scene_id);
CREATE INDEX IF NOT EXISTS idx_generated_assets_object_key ON generated_assets(object_key);
CREATE INDEX IF NOT EXISTS idx_generated_assets_validation ON generated_assets(validation_status);
CREATE INDEX IF NOT EXISTS idx_generated_assets_prompt_version ON generated_assets(prompt_version_id);

-- Lineage/content is frozen once written. Only the validation verdict may
-- advance, and only forward, once.
CREATE TRIGGER IF NOT EXISTS trg_generated_assets_body_immutable
BEFORE UPDATE OF asset_type, provider, model, prompt_version_id, prompt_hash, checksum, object_key, text_content, mime_type, width, height, byte_size, is_watermarked, cost_minor, currency, input_tokens, output_tokens, user_book_id, input_revision, template_id, scene_id, job_id, created_at ON generated_assets
BEGIN
  SELECT RAISE(ABORT, 'generated_assets: lineage and content are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_generated_assets_validation_forward_only
BEFORE UPDATE OF validation_status ON generated_assets
WHEN NOT (OLD.validation_status = 'pending' AND NEW.validation_status IN ('passed', 'failed'))
BEGIN
  SELECT RAISE(ABORT, 'generated_assets: validation status may only move pending -> passed|failed');
END;

-- Now that generated_assets exists, a task can point at its own output with a
-- real foreign key. Added as a separate ALTER so the two tables can reference
-- each other without a circular CREATE-order problem.
ALTER TABLE generation_tasks ADD COLUMN output_asset_id INTEGER REFERENCES generated_assets(id);
CREATE INDEX IF NOT EXISTS idx_generation_tasks_output_asset ON generation_tasks(output_asset_id);

-- ===========================================================================
-- GEN-05 / GEN-10: append-only attempts, provider events and the cost ledger
-- ===========================================================================
CREATE TABLE IF NOT EXISTS generation_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES generation_tasks(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'retry_scheduled', 'failed_permanent', 'dead_lettered', 'cancelled', 'lease_expired', 'malformed_output', 'validation_failed', 'safety_rejected', 'superseded')),
  provider TEXT,
  model TEXT,
  prompt_version_id INTEGER REFERENCES prompt_versions(id) ON DELETE RESTRICT,
  latency_ms INTEGER,
  error_code TEXT,
  error_message TEXT,
  cost_minor INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  correlation_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- The record of an attempt is unique per (job, task, attempt number, outcome):
-- a duplicate/concurrent consumer inserting the same attempt twice collides
-- here rather than inventing a second history entry. COALESCE is required
-- because SQLite treats NULLs as distinct in a unique index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_attempts_unique
  ON generation_attempts(job_id, COALESCE(task_id, 0), attempt_no, outcome);
CREATE INDEX IF NOT EXISTS idx_generation_attempts_job ON generation_attempts(job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_generation_attempts_task ON generation_attempts(task_id);
CREATE INDEX IF NOT EXISTS idx_generation_attempts_prompt ON generation_attempts(prompt_version_id);

CREATE TRIGGER IF NOT EXISTS trg_generation_attempts_no_update
BEFORE UPDATE ON generation_attempts
BEGIN
  SELECT RAISE(ABORT, 'generation_attempts rows are append-only');
END;

-- A SANITIZED projection of a provider interaction. Never the raw provider
-- body, never a signed URL, never child data, never a credential: the columns
-- are status codes, counts, durations and hashes only, and the writer
-- (src/generation/pipeline.ts) refuses to store anything else.
CREATE TABLE IF NOT EXISTS provider_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER REFERENCES generation_jobs(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES generation_tasks(id) ON DELETE CASCADE,
  attempt_id INTEGER REFERENCES generation_attempts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  correlation_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_provider_events_job ON provider_events(job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_provider_events_attempt ON provider_events(attempt_id);
CREATE INDEX IF NOT EXISTS idx_provider_events_type ON provider_events(event_type, created_at);

CREATE TRIGGER IF NOT EXISTS trg_provider_events_no_update
BEFORE UPDATE ON provider_events
BEGIN
  SELECT RAISE(ABORT, 'provider_events rows are append-only');
END;

-- The cost/token ledger. The unique index is what makes duplicate delivery
-- safe for MONEY: replaying an attempt cannot add its cost a second time.
CREATE TABLE IF NOT EXISTS generation_usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES generation_tasks(id) ON DELETE CASCADE,
  attempt_id INTEGER REFERENCES generation_attempts(id) ON DELETE CASCADE,
  user_book_id INTEGER NOT NULL REFERENCES user_books(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('story_text', 'illustration', 'translation', 'validation', 'preview_render')),
  quantity INTEGER NOT NULL DEFAULT 1,
  cost_minor INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_usage_idempotent
  ON generation_usage_events(COALESCE(attempt_id, 0), unit);
CREATE INDEX IF NOT EXISTS idx_generation_usage_job ON generation_usage_events(job_id);
CREATE INDEX IF NOT EXISTS idx_generation_usage_book ON generation_usage_events(user_book_id, created_at);
CREATE INDEX IF NOT EXISTS idx_generation_usage_provider ON generation_usage_events(provider, created_at);

CREATE TRIGGER IF NOT EXISTS trg_generation_usage_no_update
BEFORE UPDATE ON generation_usage_events
BEGIN
  SELECT RAISE(ABORT, 'generation_usage_events rows are append-only');
END;

-- ===========================================================================
-- GEN-05: dead-letter surface
-- ===========================================================================
CREATE TABLE IF NOT EXISTS generation_dead_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES generation_tasks(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('job', 'task')),
  reason_code TEXT NOT NULL,
  reason_message TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  dead_lettered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME,
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('retried', 'cancelled', 'discarded')),
  resolved_by_type TEXT,
  resolved_by_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_dead_letters_unique
  ON generation_dead_letters(job_id, COALESCE(task_id, 0));
CREATE INDEX IF NOT EXISTS idx_generation_dead_letters_unresolved ON generation_dead_letters(resolved_at);

CREATE TRIGGER IF NOT EXISTS trg_generation_dead_letters_body_immutable
BEFORE UPDATE OF job_id, task_id, scope, reason_code, reason_message, attempts, payload_json, dead_lettered_at ON generation_dead_letters
BEGIN
  SELECT RAISE(ABORT, 'generation_dead_letters: the dead-letter record is immutable — only its resolution may be set');
END;

-- ===========================================================================
-- GEN-12: quota / spend windows
-- ===========================================================================
-- Same atomic increment-then-read shape as rate_limit_windows (0009): the
-- check and the increment are ONE statement, so two simultaneous requests
-- cannot both observe an under-limit count and both proceed.
CREATE TABLE IF NOT EXISTS generation_quota_windows (
  bucket_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_seconds INTEGER NOT NULL,
  jobs_started INTEGER NOT NULL DEFAULT 0,
  cost_minor INTEGER NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (bucket_hash, window_start)
);
CREATE INDEX IF NOT EXISTS idx_generation_quota_windows_start ON generation_quota_windows(window_start);

-- Operator-editable limits, so a spend cap can be tightened without a deploy.
CREATE TABLE IF NOT EXISTS generation_limits (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'number' CHECK (kind IN ('number', 'string')),
  description TEXT NOT NULL DEFAULT '',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ===========================================================================
-- GEN-08: preview lineage, watermarking and dimensions
-- ===========================================================================
-- Added columns are written ONLY at INSERT (see the header note: the
-- published preview_versions immutability trigger stays exactly as it is).
ALTER TABLE preview_versions ADD COLUMN generation_job_id INTEGER REFERENCES generation_jobs(id);
ALTER TABLE preview_versions ADD COLUMN scene_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE preview_versions ADD COLUMN manifest_checksum TEXT;
ALTER TABLE preview_versions ADD COLUMN watermark_label TEXT;
ALTER TABLE preview_versions ADD COLUMN finalized_at DATETIME;

ALTER TABLE preview_assets ADD COLUMN scene_id INTEGER REFERENCES book_scenes(id);
ALTER TABLE preview_assets ADD COLUMN generated_asset_id INTEGER REFERENCES generated_assets(id);
ALTER TABLE preview_assets ADD COLUMN is_watermarked INTEGER NOT NULL DEFAULT 1;
ALTER TABLE preview_assets ADD COLUMN width INTEGER;
ALTER TABLE preview_assets ADD COLUMN height INTEGER;
ALTER TABLE preview_assets ADD COLUMN byte_size INTEGER;

CREATE INDEX IF NOT EXISTS idx_preview_versions_job ON preview_versions(generation_job_id);
CREATE INDEX IF NOT EXISTS idx_preview_assets_scene ON preview_assets(scene_id);
CREATE INDEX IF NOT EXISTS idx_preview_assets_generated_asset ON preview_assets(generated_asset_id);

-- An asset served as a preview MUST be watermarked at write time. Without this
-- the "immutable watermarked preview" guarantee would rest on application code
-- alone; with it, a row that could leak an unwatermarked original into a
-- preview cannot be inserted at all.
CREATE TRIGGER IF NOT EXISTS trg_preview_assets_must_be_watermarked
BEFORE INSERT ON preview_assets
WHEN NEW.is_watermarked != 1
BEGIN
  SELECT RAISE(ABORT, 'preview_assets: a preview asset must be watermarked');
END;

-- ===========================================================================
-- Retention: retryable tombstones for generated-asset object deletion
-- ===========================================================================
-- Mirrors retention_failures (0014) for the new object kind. A sweep must
-- never report success, and never remove the D1 rows, before R2 confirms the
-- private object is gone.
CREATE TABLE IF NOT EXISTS generation_asset_deletions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_key TEXT NOT NULL UNIQUE,
  user_book_id INTEGER REFERENCES user_books(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 1,
  last_error TEXT NOT NULL DEFAULT '',
  first_attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_generation_asset_deletions_unresolved ON generation_asset_deletions(resolved_at);
