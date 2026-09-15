# Phase 3 Completion Report — Templates, Real AI Generation and Preview Pipeline

Verdict: **COMPLETE** (with the owner decisions listed at the end)
Branch: `feat/generation-pipeline-v2`
Baseline HEAD: `5a17cd2046caf8c27e9bab8e6a992d7a3bd91fbb` (accepted Phase-2 tip)
Final HEAD: this branch's tip after the Phase-3 commits (see the commit list below)

## Confirmed starting state

| Item | Value |
|---|---|
| Branch | `feat/generation-pipeline-v2`, created from `5a17cd20` |
| `main` | `4d76779` — **untouched**: never merged, never checked out, never pushed |
| Migrations at start | `0001`–`0023` (published, **never edited** — verified: no diff to any of those files) |
| Unit baseline | 492 passed / 492 (30 files) |
| Gates at start | typecheck 0, unit 492/492, integration 10/10 scenarios, build 0, e2e 11 journey groups, frontend audit 0 findings |
| Generation at start | Schema only (`book_templates`, `book_scenes`, `scene_placeholders`, `preview_versions`, `preview_assets` from `0010`/`0012`) with **no** pipeline, no jobs, no previews. `/api/generate-book` returned an honest 501 and the PDP said plainly that no pages are generated. |

## Deployment / Queue architecture decision (done first, as required)

**The current Cloudflare Pages deployment cannot host the required Queue
consumer.** `wrangler.jsonc` is a Pages project (`pages_build_output_dir`,
`wrangler pages deploy dist`); a `queue()` handler and `queues.consumers` are
Worker configuration, and Pages cannot be a Queue producer either.

**Smallest Cloudflare-compatible adjustment made: a companion Worker.**
`src/worker.ts` (exports `queue()`, `scheduled()`, and a deliberately minimal
`fetch()` that serves only `/healthz`) plus `wrangler.generation-worker.jsonc`
(`queues.consumers` with batch 5 / 5 retries / a dead-letter queue, a
`GENERATION_QUEUE` producer binding, and a `* * * * *` cron). It imports the
**same** `src/generation/*` domain modules as the web app.

* **Framework unchanged**: Hono + TypeScript + D1 + R2, and `npm run deploy`
  still deploys the Pages project exactly as before.
* **Why it is safe**: the durable job rows in D1 are the source of truth; a
  message carries only ids. A lost/duplicated/delayed message can change *when*
  work happens, never *what* happens.
* **Fallback that is impossible to fake**: with no producer binding,
  `NullQueueProducer` reports `not_configured` truthfully and the companion
  Worker's cron reclaims dead leases, promotes due retries and drains every due
  job. The admin screen also offers an audited "Run a dispatch sweep now".
* **Local/E2E**: `GENERATION_INLINE_DISPATCH=1` (requires
  `ENVIRONMENT=development` AND that flag) drains in-request so the whole
  pipeline runs through the real HTTP surface with real local D1/R2.

Full detail: `docs/V2_ARCHITECTURE_BASELINE.md` → "Phase 3 additions".

## Requirement IDs addressed

| ID | Code path | Test / browser proof |
|---|---|---|
| GEN-01 versioned templates/scenes/placeholders/prompt+model+config | `src/generation/templates.ts`, `src/generation/layout.ts`, `migrations/0024`+`0025` | `phase3-templates-preview-admin.test.ts` (provisioning idempotent; published = immutable at the DB level; clone→edit draft→publish retires the predecessor atomically; strict layout/constraint validation; declared-token substitution only) |
| GEN-02 provider interfaces + deterministic fakes | `src/generation/providers/{types,fake,fake-image,pixels,disabled,storage}.ts` | `phase3-generation-pipeline.test.ts` (fakes deterministic; refused under `ENVIRONMENT=production`; a fetch spy is never called across a full generation) |
| GEN-03 real environment-configured adapter | `src/generation/providers/http.ts`, `providers/index.ts` | `phase3-generation-pipeline.test.ts` (URL-without-key is not a provider; non-HTTPS refused outside dev; complete config reported active); admin health endpoint test asserts no key/endpoint leaks |
| GEN-04 asynchronous queue-driven generation | `src/generation/queue.ts`, `pipeline.ts`, `src/worker.ts`, `wrangler.generation-worker.jsonc` | `phase3-generation-pipeline.test.ts` (request → queued job → drained → succeeded; admin dispatch audited); E2E journey clicks the real control |
| GEN-05 idempotent jobs, attempts, leases, heartbeat, retry, dead-letter | `src/generation/jobs.ts`, `migrations/0024` (4 unique indexes + 3 job triggers + 2 task triggers) | `phase3-generation-pipeline.test.ts` (duplicate delivery; concurrent consumers; lease expiry recovery; transient retry with backoff; permanent no-retry; malformed → retry → dead-letter → explicit retry resolves); integration scenario proves the duplicate index and illegal-transition trigger |
| GEN-06 per-scene generation + lineage | `src/generation/pipeline.ts`, `migrations/0024` (`generated_assets`) | happy-path test (6 scenes, 6 originals, 6 watermarked, text naming the child, provider/model/prompt-version lineage, per-unit cost) |
| GEN-07 output validation | `src/generation/validation.ts`, `providers/fake-image.ts` (pixel marker) | wrong-size, child-count mismatch, semantic mismatch, unsafe (immediate dead-letter), undecodable (dead-letter after budget) |
| GEN-08 immutable watermarked previews + private assets | `src/generation/watermark.ts`, `pipeline.ts` (finalize + manifest), `providers/storage.ts`, `GET /previews/:key` | watermark verified from bytes and absent from the original; DB refuses an unwatermarked preview asset; storage refuses cross-namespace writes; E2E fetches a preview (200, real JPEG, `private, no-store`), gets 404 for an original, for a second user and for an anonymous caller |
| GEN-09 customer progress/status/retry UI surviving refresh | `src/pages_generation.ts`, `public/static/generation.js`, `public/static/api.js`, `src/index.tsx`, state machine | status endpoint reports real phase/progress/cost/failure; E2E asserts the panel renders, the control works, 6 pages appear, and a full reload still shows them and names the version |
| GEN-10 admin observability, cost, retry, cancel | `src/generation/admin.ts`, `src/admin_routes.ts`, `src/admin.ts` | admin tests: deny anonymous + customer on every route; real job/attempt/cost/dead-letter data; no key or payload rendered; retry + cancel audited, cancel needs a reason |
| GEN-11 revision invalidates approval; stale job cannot overwrite | `src/personalization/state-machine.ts`, `user-books.ts`, `src/generation/pipeline.ts` | stale job → `superseded`, no preview rows, revision row unchanged, book not left in `preview_ready`; new revision → its own preview version; approval invalidated and stale re-approval refused (409); E2E asserts all of it |
| GEN-12 quotas, rate limits, no duplicate billable jobs | `migrations/0024`/`0025` (`generation_quota_windows`, `generation_limits`), `src/generation/jobs.ts`, `src/generation/routes.ts` | per-owner quota 429 with no job created; spend cap refuses; cost ledger dedupes per attempt and is append-only; duplicate request returns the same job with no extra quota |
| PER-06 face-selection integrity on the new pipeline | `pipeline.ts` preflight + min-confidence from scene config | `face_required` refusal; foreign-face selection denied (route + trigger); confidence threshold enforced |
| PER-07 immutable input revisions preserved | `migrations/0011` triggers + `generation_jobs.input_revision` | job/asset reference the exact revision; a revision row cannot be mutated; after an edit revision 1 is unchanged and its text still names the original child |
| PER-09 consent version + retention deadline honoured | `src/personalization/consent.ts`, `migrations/0024`/`0025`, `routes.ts`, `retention.ts` | consent recorded against the published version with a real deadline + append-only event; no silent extension; hash matches wording; generation past the deadline refused; sweep deletes all 12 generated objects; failing delete queues tombstones and keeps the book until objects are gone |
| ADM-08 templates/scenes/placeholders/prompts/publish | `src/generation/admin.ts`, `admin_routes.ts` | screen states immutability, offers clone→publish; service rules covered by the GEN-01 suite; audited at six widths |
| ADM-09 languages/translations/completeness | `generationLanguageCompleteness` on `/admin/localization` | per-language published-template coverage; a language with none is reported as `none`, never as complete |
| ADM-10 generation jobs/attempts/cost/manual review | `adminGenerationJobs`, `adminGenerationJobDetail` | real status/attempts/cost/tokens/events; unresolved dead letters and overdue leases surfaced |
| ADM-11 preview/revision/approval queues | `adminGenerationPreviews` | classification (awaiting/approved/changes requested), historical vs current revision, revision requests with notes; audited at six widths |

## Root causes reproduced

1. **There was no generation pipeline at all.** The Phase-2 schema had
   `book_templates`/`preview_versions` tables and nothing wrote to them; the PDP
   honestly said no pages are generated and `/api/generate-book` returned 501.
2. **The reader page showed a hand-written mock.** `src/pages_reader.ts` rendered
   a fixed cover/spread image plus two hard-coded story lines ("The crown looked
   so lovely…"). Phase 3 replaces that with stored, watermarked, per-scene
   assets served from the private preview route.
3. **`preview_versions` was immutable with no legal way to become ready.**
   Migration `0012` blocks every UPDATE. Rather than weaken a published
   constraint, the pipeline inserts a preview row **once, already `ready`**, only
   when a verified preview genuinely exists; in-flight and failed work is
   represented by `generation_jobs`, never by a fabricated `pending` preview row.
4. **A pre-existing retention leak.** A book whose photo/object deletion failed
   was marked `expired` and then excluded from every later sweep
   (`WHERE state NOT IN ('expired','cancelled')`), so its rows — and the
   reference a retry tombstone needs — leaked permanently. Fixed by keeping any
   book with an unresolved tombstone in scope, and captured in a regression
   test. The sweep had no ordered purge for the generation tables either, so
   cascading deletes hit non-cascading lineage FKs; the purge is now explicit
   and dependency-ordered.
5. **A wrong task-status edge.** The Phase-3 task flow trigger initially refused
   `queued -> running`, which the consumer legitimately performs (a task's lease
   and its start are one statement). Corrected in `0024` with the reason
   documented, and `queued -> leased -> running` is retained for JOBS.

## Implementation

**Files added (main):** `src/generation/{types,layout,templates,jobs,queue,pipeline,validation,watermark,routes,admin,worker-entry}.ts`,
`src/generation/providers/{types,fake,fake-image,pixels,http,disabled,storage,index}.ts`,
`src/pages_generation.ts`, `src/personalization/consent.ts`, `src/worker.ts`,
`wrangler.generation-worker.jsonc`, `public/static/generation.js`,
`scripts/e2e-phase3.mjs`, `docs/V2_PHASE3_TRACEABILITY.md`,
`test/helpers/generationFixtures.ts`, three Phase-3 unit suites.

**Files extended:** `src/index.tsx` (routes + env bindings + the reader's
server-rendered panel), `src/personalization/{types,state-machine,user-books,retention,ownership}.ts`,
`src/admin.ts` (nav), `src/admin_cms.ts` (localization coverage),
`src/admin_routes.ts` (admin routes), `src/secrets.ts` (`sha256BytesHex`),
`test/helpers/testApp.ts`, `scripts/test-integration.mjs`,
`scripts/test-e2e.mjs`, `scripts/audit-frontend.mjs`, `package.json`,
`README.md`, `docs/{V2_ARCHITECTURE_BASELINE,V2_BASELINE_TRACEABILITY,API_V1}.md`.

**Migrations added (forward-only; `0001`–`0023` untouched):**
* `0024_generation_pipeline.sql` — prompt versions + template prompt bindings,
  consent versions and consent columns, `generation_jobs`,
  `generation_tasks`, `generated_assets`, `generation_attempts`,
  `provider_events`, `generation_usage_events`, `generation_dead_letters`,
  `generation_quota_windows`, `generation_limits`,
  `generation_asset_deletions`, preview lineage/watermark/dimension columns, the
  status-flow / identity-immutability / terminal-freeze / append-only triggers,
  and four unique idempotency indexes.
* `0025_generation_templates_seed.sql` — the original six-scene picture-book
  scaffold (scenes, placeholders, structured layout config), eight prompt
  versions (four published offline + four draft `http`), eight operator-editable
  limits and the published consent version whose hash matches its wording.

**Routes added:** `POST /api/v1/user-books/:id/generations`,
`GET /api/v1/user-books/:id/generation`,
`GET /api/v1/user-books/:id/previews(/:version)`,
`POST /api/v1/user-books/:id/revisions`, `POST /api/v1/user-books/:id/approvals`,
`POST /api/v1/user-books/:id/generation/{cancel,retry}`,
`GET /previews/:key{.+}`, `GET /api/v1/admin/generation/providers`, and the admin
HTML screens `/admin/generation/{templates,jobs,previews}(/:id)`.

## Security/privacy decisions

* **Originals are never served.** `GET /previews/:key` rejects any key outside
  `gen/preview/` before doing entitlement work, so an unwatermarked original is
  unreachable even by its owner (asserted in the E2E journey and in a unit test).
* **Previews are watermarked at write time.** A visible tiled label plus a
  pixel-level provenance marker; `preview_assets.is_watermarked` is enforced by a
  DB trigger, and every stored preview is re-read from R2 and its marker verified
  before the preview version is published.
* **No signed URLs anywhere.** Private bytes are streamed through an
  entitlement-checked route with `Cache-Control: private, no-store`,
  `X-Robots-Tag: noindex, noimageindex` and `Referrer-Policy: no-referrer`.
* **Provider secrets cannot leak.** Errors never echo the endpoint, the key or
  the provider body; provider events are a sanitized allow-listed projection
  (statuses, counts, durations, model names — never a payload, a signed URL or a
  prompt value); the admin health endpoint reports configured/disabled only.
* **A child's name is never logged.** Prompts are resolved in memory; the prompt
  itself is stored only as a SHA-256 hash on the asset.
* **Structure is data, not code.** `layout_json` and `constraints_json` are
  strictly validated (unknown fields rejected, no `{{...}}` in a subject, no
  markup characters, bounded numbers) and are never evaluated, compiled, used as
  a regex source, or interpolated into SQL/HTML.
* **Fail closed.** No configured provider means no preview and an honest
  `generation_failed` — never synthetic output presented as real. A safety
  rejection dead-letters immediately rather than retrying.
* **Abuse and spend are bounded**: per-request rate limits, a per-owner job
  quota, a deployment-wide job quota and a deployment-wide spend cap, all read
  from operator-editable rows, plus a hard cap on scenes per job.

## Verification

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | 0 | 0 errors |
| `npm run test` | 0 | **547 passed / 547** across 32 files (baseline 492/30; **+55 tests in 3 new files**) |
| `npm run test:integration` | 0 | **11/11 scenarios**, including the new `[phase3 upgrade]` (83 tables; 0024-0025 applied over existing Phase-2 rows; scaffold/prompts/limits/consent seeded once; every pre-existing row unchanged; no generation row invented; duplicate-job, illegal-transition, unwatermarked-preview and append-only guarantees asserted) |
| `npm run secrets:scan` | 0 | no matches (294 files) |
| `npm run secrets:scan -- --mode=archive` | 0 | no matches (295 files) |
| `npm run build` | 0 | `dist/_worker.js` 577.88 kB (gzip 155.45 kB) |
| `npm run test:e2e` | 0 | 12 journey groups, including the new `phase3-generation-preview` group |
| `npm run audit:frontend -- phase3-generation` | 0 | **0 findings**: 29 public routes at 360/390/768/1024/1440/1920, the admin surfaces at desktop + mobile, and the accessibility pass at all six widths |
| `npm audit --omit=dev` | 0 | 0 vulnerabilities |
| `npm audit` | 1 | 3 high, dev-only `sharp <0.35.4` ← `miniflare` ← `wrangler`; **pre-existing and unchanged** (fixing it is a deliberate toolchain bump) |

New test files: `phase3-generation-pipeline.test.ts` (23),
`phase3-templates-preview-admin.test.ts` (32); plus `test/helpers/generationFixtures.ts`.

## Data migration/backfill result

`[phase3 upgrade]` applies `0001`–`0023`, inserts real Phase-2-shaped rows
(product, user, order, prospect, photo upload, user book at version 3 with an
immutable revision), then applies `0024`–`0025` and asserts: the scaffold,
six scenes, eleven placeholders, eight prompt versions, eight limits and one
consent version are seeded exactly once (and not duplicated by a re-apply of the
idempotent seed migration); the consent `text_hash` matches the seeded wording;
**no** pre-existing row changed (book state/version/revision pointer, order
status/total, revision content); the book's `consent_version` stays NULL rather
than being back-filled with a guess; zero generation rows are invented; and the
four database-level guarantees the pipeline relies on actually hold (duplicate
job refused, `queued -> succeeded` refused, unwatermarked preview asset refused,
cost ledger append-only).

## Diff/secret/reference-content review

* `secrets:scan` clean in both modes; the only flag raised during development was
  a **synthetic** test fixture, which was rewritten so its shape cannot be
  mistaken for a credential.
* No PII, child image, provider payload, signed URL or storage key is committed.
  Provider events are stored as a sanitized projection, and preview URLs are
  opaque app routes.
* **All Phase-3 content is original**: the six scene subjects, the prompt texts,
  the consent wording and the deterministic illustrations are authored in this
  phase. Nothing is copied from any reference product, and the Phase-2
  reference-content guards remain green.
* `0001`–`0023` are byte-identical to the accepted Phase-2 tree; all schema
  change is `0024`+.
* `.openclaw_test_out.txt` was never staged (explicit paths only).

## Remaining risks or owner decisions

1. **No real AI provider is configured (GEN-03).** The four HTTP adapters are
   complete, hardened and health-reported, and the deterministic offline
   providers are what run locally and in CI. The owner must supply endpoints +
   keys and publish an `http` prompt version before any real generation happens.
   This is why every automated run makes **zero paid calls**.
2. **Queue producer binding (GEN-04).** If the deployment cannot host a producer,
   generation still completes via the companion Worker's cron (≤1 minute). The
   owner decides whether to move the app to Workers-with-assets for instant
   wake-ups.
3. **Retention is still not scheduled (S-11 → Phase 8).** The sweep now purges
   generated originals and previews and is tested, but no cron deploys it.
4. **Legal review (S-14).** The consent wording is an authored draft marked as
   such; counsel must review it before real customers (it is referenced by hash,
   so replacing it means publishing a new consent version — which is the intended
   mechanism).
5. **Watermark strength (GEN-08).** Visible label + provenance marker, not a
   forensic watermark that survives re-encoding or cropping.
6. **Static per-currency prices and the dev-only `npm audit` chain** carry over
   unchanged from Phase 2.

## Exact next phase recommendation

V2 **Phase 4 — Server Cart, Money, Quotes, Payments and Refunds**
(`feat/commerce-payments-v2`), starting from this branch's tip. Phase 4 owns
COM-01…COM-14 and ADM-03/04/12/16; it should reconcile the client-held cart with
the server cart, introduce integer-minor-unit quotes/price versions/addresses,
and consume the generation ledger's cost data as the unit economics input rather
than inventing a second one.

## Confirmation

* `main` (`4d76779`) untouched: never merged, checked out or pushed.
* Published migrations `0001`–`0023` untouched (no diff).
* Nothing pushed; AutoCoder reviews and pushes.
* `.openclaw_test_out.txt` not staged.
* **Zero real/paid provider calls** in code, tests, e2e and audits: the
  deterministic offline providers are the only ones configured, and a fetch spy
  asserts no external endpoint is contacted.
