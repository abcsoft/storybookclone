# V2 Autonomous Completion — Progress Record

Purpose: a single, current record of what was done autonomously, what is
verified, what still needs an owner/external input, and what the next automatic
action would be. Every claim here was executed; nothing is aspirational.

## 1. Branch / commits

| Item | Value |
|---|---|
| Branch | `feat/generation-pipeline-v2` |
| Baseline HEAD (accepted Phase-2 tip) | `5a17cd2046caf8c27e9bab8e6a992d7a3bd91fbb` |
| Phase | **V2 Phase 3 — Templates, Real AI Generation and Preview Pipeline** |
| `main` | `4d76779` — **untouched** (never merged, never checked out, never pushed) |
| Pushed? | **No.** AutoCoder reviews and pushes. |
| History rewritten? | **No.** Every change is a new commit on top of `5a17cd20`. |
| Migrations added | `0024`, `0025` (forward-only; `0001`–`0023` byte-identical) |

Final HEAD: this branch's tip after the Phase-3 commits (`git rev-parse HEAD` on
`feat/generation-pipeline-v2`).

## 2. Migration ledger

| Migration | Contents |
|---|---|
| `0024_generation_pipeline.sql` | `prompt_versions` + `template_prompt_versions` (immutable prompt/model/config versions and the exact prompts a template pins), `consent_versions` + `consent_version` columns, `generation_jobs`, `generation_tasks`, `generated_assets`, `generation_attempts`, `provider_events`, `generation_usage_events`, `generation_dead_letters`, `generation_quota_windows`, `generation_limits`, `generation_asset_deletions`; preview lineage/watermark/dimension columns; status-flow, identity-immutability, terminal-freeze and append-only triggers; four unique idempotency indexes. Deliberately does **not** touch the published `preview_versions` immutability trigger from `0012`. |
| `0025_generation_templates_seed.sql` | The original six-scene picture-book scaffold (scenes, placeholders, structured layout config), eight prompt versions (four published offline + four draft `http`), eight operator-editable generation limits, and the published consent version whose `text_hash` matches its wording. |

`0024` is ALTER-based and therefore applied at most once (the established rule in
this repository); its CREATE-TABLE/INDEX portions are `IF NOT EXISTS`. `0025` is
fully idempotent (`INSERT OR IGNORE`) and is re-applied by the integration test.

## 3. Deployment / Queue decision (required by the prompt, done first)

Cloudflare **Pages cannot host a Queue consumer** — a `queue()` handler and
`queues.consumers` are Worker configuration, and a Pages project cannot be a
Queue producer either. Smallest compatible adjustment: **a companion Worker** —
`src/worker.ts` + `wrangler.generation-worker.jsonc` — exporting `queue()`,
`scheduled()` and a minimal `fetch()` (`/healthz` only). The framework is
unchanged (Hono/TypeScript/D1/R2) and `npm run deploy` still deploys Pages
exactly as before. The durable D1 job rows are the source of truth, so the
message path is only a wake-up: with no producer the cron drains due work, and
`GENERATION_INLINE_DISPATCH=1` (development + explicit flag) does it in-request
for local/E2E. Full detail in `docs/V2_ARCHITECTURE_BASELINE.md`.

## 4. Requirement IDs

### 4.1 Delivered (detail: `docs/V2_PHASE3_TRACEABILITY.md`)

**Complete:** GEN-01…GEN-12, PER-06/07/09 (extended onto the new pipeline), and
**foundations** for ADM-08/09/10/11.

Every row in the traceability file carries a code path, test (or browser) proof
and an explicit limitation. Two honest limits repeat:

* **GEN-03** — the real HTTP adapters exist, are hardened, are health-reported and
  are fail-closed, but **no real provider is configured** in this repo or CI, so
  no real call happens until the owner supplies endpoints and keys. This is why
  every automated run makes **zero paid calls**.
* **PER-09 / S-11** — the retention sweep now purges generated originals AND
  previews with retryable tombstones, but it is still **not scheduled** (Phase 8).

### 4.2 Still open, each with an owning phase

| ID | Status | Owner |
|---|---|---|
| S-08 (RBAC), S-09 (re-auth), ADM-20 (audit UI) | open | Phase 6 — the audit trail exists and every Phase-3 admin mutation writes to it |
| S-11 (retention not scheduled) | open | Phase 8 — the sweep itself is implemented and tested |
| S-14 (legal text is a draft) | open — kept explicitly marked | owner + counsel (the consent wording is hash-referenced, so replacing it means publishing a new consent version) |
| COM-01/04/05/06/07… (server cart, quote, coupons, payment) | open | Phase 4 |
| CUS-01…CUS-14 (account depth, approval UI beyond the preview panel) | open | Phase 5 — the preview panel, approvals and revision requests exist as foundations |
| FUL-01…FUL-10 (PDF/print/fulfilment) | open | Phase 7 |
| PLT-10 (retention cron), PLT-12 (metrics/alerts) | open | Phase 8 |

## 5. Exact verification (final code state)

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | `0` | 0 errors |
| `npm run test` | `0` | **547 passed / 547** across 32 files (baseline 492/30; **+55 tests in 3 new files**) |
| `npm run test:integration` | `0` | **11/11 scenarios**, including the new `[phase3 upgrade]` (83 expected tables; `0024`-`0025` over existing Phase-2 rows; every pre-existing row unchanged; no generation row invented; duplicate-job / illegal-transition / unwatermarked-preview / append-only guarantees asserted) |
| `npm run secrets:scan` | `0` | no matches across 293 files |
| `npm run secrets:scan -- --mode=archive` | `0` | no matches across 294 files |
| `npm run build` | `0` | `dist/_worker.js` 577.40 kB (gzip 155.33 kB) — up from 423.35 kB in Phase 2 |
| `npm run test:e2e` | `0` | **12 journey groups** including the new `phase3-generation-preview` group |
| `npm run audit:frontend -- phase3-generation` | `0` | **0 findings** across 29 public + 24 admin routes at 360/390/768/1024/1440/1920 plus the accessibility pass |
| `npm audit --omit=dev` | `0` | 0 vulnerabilities |
| `npm audit` | `1` | 3 high, dev-only `sharp <0.35.4` ← `miniflare` ← `wrangler`; **pre-existing, not in the worker bundle, unchanged** |

New test files: `phase3-generation-pipeline.test.ts` (23 tests),
`phase3-templates-preview-admin.test.ts` (32 tests), plus the shared
`test/helpers/generationFixtures.ts`.

## 6. The multi-scene preview journey (real rows and real assets)

`phase3-generation-preview` — real Chromium against a real local
`wrangler pages dev` with real local D1 + R2, using the deterministic offline
providers and therefore making **zero external calls**:

1. register an account and personalize a book through the real PDP (real photo
   upload + face analysis);
2. the reader page renders a **server-rendered** generation panel with a working
   "Create my preview" control, and does not claim generation is switched off
   when it is configured;
3. clicking it runs the pipeline; the panel polls until the pages appear, then
   reloads itself once so the stored pages are shown;
4. the assertions are on REAL rows and REAL objects: exactly one
   `preview_versions` row (`ready`, `scene_count = 6`, a SHA-256 manifest
   checksum, a watermark label), 6 `preview_assets` rows all `is_watermarked = 1`
   under `gen/preview/`, 6 `generated_assets` originals under `gen/original/`,
   and generated story text that names the child;
5. the preview images are fetched over the private route: HTTP 200, real JPEG
   magic bytes, `Cache-Control: private, no-store`, at least 5 KB;
6. all 6 pages render with descriptive alt text, and a **full page reload** still
   shows them and names the stored version;
7. the **originals are 404 for the owner**, and the preview is 404 for a second
   registered user and for an anonymous caller;
8. approving works against an exact version; the approve control is no longer
   actionable afterwards; editing the details then invalidates the approval,
   advances the revision to 2, and re-approving version 1 is refused with 409;
9. the admin generation screens render real data and expose no storage key,
   provider payload or credential.

## 7. Audit verdict

`npm run audit:frontend -- phase3-generation` reports **0 findings** across 29
public and 24 admin routes at six widths plus the accessibility pass: no
horizontal overflow, no console error, no failed or 4xx/5xx request, no
overclaim copy, and a clean a11y pass. The overclaim guard list was **not**
relaxed now that generation is real — the panel's copy deliberately does not
match any guarded pattern, and the list is unchanged.

The one remaining red gate is `npm audit` (3 high in the dev-only
`wrangler`/`miniflare`/`sharp` chain) — pre-existing and unchanged from Phase 1.

## 8. Required credentials / owner inputs

Nothing below blocks the work completed here.

1. **AI provider endpoints + keys (GEN-03).** `GENERATION_STORY_API_URL`/`_API_KEY`,
   `GENERATION_ILLUSTRATION_API_URL`/`_API_KEY`,
   `GENERATION_TRANSLATION_API_URL`/`_API_KEY`,
   `GENERATION_VALIDATION_API_URL`/`_API_KEY` — then publish the corresponding
   `http` prompt version on `/admin/generation/prompts`. Until then generation
   runs on the deterministic offline providers (or fails closed when they are
   disabled), and no paid call is made.
2. **Queue deployment decision.** Create `webapp-generation` and its dead-letter
   queue, then deploy `wrangler.generation-worker.jsonc` with the real D1
   `database_id` and R2 bucket. Without a producer the cron path still works.
3. **Real D1 `database_id`.** `wrangler.jsonc` still carries
   `local-dev-placeholder` (pre-existing Phase-0 item; a release blocker for any
   real deploy).
4. **Legal review of the consent wording (S-14 + PER-09).** The published
   consent version is an authored draft; replacing it means publishing a new
   `consent_versions` row, and existing books keep recording the version they
   actually agreed to.
5. **Final brand + artwork (SF-01).** The watermark label is the configured brand
   name (`BRAND_NAME` / `/admin/settings`), so it follows the brand.
6. **Retention cron (S-11).** Decide when to schedule the retention sweep; the
   companion Worker can already run it via `runScheduledRetention`.
7. **`npm audit` dev chain.** Fixing the 3 high advisories needs a deliberate
   `wrangler`/`miniflare`/`sharp` bump.

## 9. Next automatic action

**None without owner input for a real provider.** When authorised, the next
automatic action is V2 **Phase 4 — Server Cart, Money, Quotes, Payments and
Refunds** (`feat/commerce-payments-v2`) on a new branch from this tip, starting
with COM-01/COM-03 (server cart + integer minor units) and wiring the generation
usage ledger in as the unit-economics input rather than building a second cost
model.

## 10. Deviations and disclosures

* **`preview_versions` was not weakened.** Migration `0012`'s
  `trg_preview_versions_no_update` is exactly as published. Instead of permitting
  a status transition, the pipeline inserts a preview row once, already `ready`,
  and represents in-flight work in `generation_jobs` — no fabricated `pending`
  preview row is ever created.
* **The task status flow was corrected inside `0024` (a new migration).** The task
  trigger permits `queued -> running` (and `retry_wait -> running`) because
  `claimTask()` acquires a task's lease and starts its provider call in one
  statement; the JOB contract still uses `queued -> leased -> running`. The
  reason is documented in the migration.
* **Two pre-existing retention defects were fixed** — a book whose object deletion
  failed was marked `expired` and then excluded from every later sweep, and the
  sweep had no ordered purge for the generation lineage foreign keys. Both are
  covered by a regression test.
* **The browser journey found three real UI defects**, all fixed: the panel
  re-offered "Approve" after an approval (a second approve control was being
  created by the client next to the server-rendered one), the status endpoint did
  not report the approval state, and a double click could append a second
  identical decision row (now an idempotent no-op).
* **Three harness/test corrections were needed and are disclosed**: the E2E
  registration helper now uses the same selectors and wait as the existing
  authenticated journey; the phase-3 photo fixture is passed as an in-memory
  payload; and two DELIBERATE denials (an original 404 and a stale-approval 409)
  are allow-listed in the journey's diagnostics while every other 4xx/5xx still
  fails it.
* **`WW_E2E_ONLY`** was added as an explicitly-logged local debugging filter so a
  single journey group can be iterated on. Unset — which is what
  `npm run test:e2e` and the gates use — runs **every** group.
* **A synthetic test fixture tripped the secret scanner** during development and
  was rewritten so its shape cannot be mistaken for a credential. No real
  credential was ever present.
* **The deterministic illustration is generated, not commissioned art.** It is a
  real, reproducible JPEG rendered from pixels by committed code, with a
  pixel-level identity marker so validation reads the actual bytes; it is
  development/test-only and documented as such.
* **Cost figures from the fakes are fake prices** (documented as such), present
  only so the cost ledger, quota and admin cost views are genuinely exercised.
* **`.openclaw_test_out.txt`** (untracked diagnostic) was never staged.
