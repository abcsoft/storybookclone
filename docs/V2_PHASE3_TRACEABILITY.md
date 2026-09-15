# V2 Phase 3 Traceability — Templates, Real AI Generation and Preview Pipeline

Branch: `feat/generation-pipeline-v2`
Baseline HEAD: `5a17cd2046caf8c27e9bab8e6a992d7a3bd91fbb` (accepted Phase-2 tip)
Migrations added: `0024_generation_pipeline.sql`, `0025_generation_templates_seed.sql`
(forward-only; `0001`–`0023` byte-identical)

Every row below is a claim backed by a code path AND a test (or a browser
journey). A row with no proof does not appear here. "Limitation" states
honestly what the row does NOT cover.

## GEN-01 — Versioned templates, scenes, placeholders and prompt/model configuration

| | |
|---|---|
| Code | `migrations/0024_generation_pipeline.sql` (`prompt_versions`, `template_prompt_versions`), `migrations/0025_generation_templates_seed.sql` (`template_scaffolds`, `template_scaffold_scenes`, `template_scaffold_placeholders` + the original six-scene scaffold and prompt texts), `src/generation/templates.ts` (`ensurePublishedTemplateForProduct`, `loadTemplate`, `cloneTemplateToDraft`, `validateTemplateForPublish`, `publishTemplate`, `retireTemplate`, `saveDraftScene`, `saveDraftPlaceholder`, `bindDraftPrompt`, `clonePromptVersionToDraft`, `publishPromptVersion`, `resolvePromptTemplate`), `src/generation/layout.ts` (strict `layout_json` / `constraints_json` validation) |
| Test proof | `phase3-templates-preview-admin.test.ts`: provisioning is idempotent and produces 6 ordered scenes with validated config; a published template is immutable at the DB level (identity, no-unpublish, no-revive, frozen scenes and placeholders) and the only edit path is clone→edit draft→publish (which retires the previous version in one atomic step); an incomplete draft cannot be published and the error names what is missing; the only published template cannot be retired; layout/constraint validation rejects unknown fields, contradictory geometry, an unreachable declared PPI, a subject containing `{{...}}`, an out-of-page slot, an invalid placeholder source and contradictory min/max; `resolvePromptTemplate` substitutes only declared tokens, inserts values verbatim (no recursive expansion) and errors on an undeclared token; a published prompt's text/model/provider cannot be edited and publishing a clone retires its predecessor |
| Browser proof | `/admin/generation/templates` and `/admin/generation/templates/:id` audited at 360/390/768/1024/1440/1920; the E2E journey drives generation from the provisioned scaffold |
| Limitation | The scaffold is authored in migration `0025`; adding a *new* story structure is a reviewed migration + provisioning change, not an admin-only action. Scene/placeholder editing beyond subject and order (adding a brand-new placeholder, changing a canvas) requires the admin service calls that exist but are not all exposed as forms yet. |

## GEN-02 — Provider interfaces plus deterministic test fakes

| | |
|---|---|
| Code | `src/generation/providers/types.ts` (face, story-text, translation, illustration, validation, storage interfaces), `providers/fake.ts` (deterministic offline adapters, including a real JPEG renderer in `fake-image.ts`), `providers/disabled.ts` (fail-closed adapters), `providers/pixels.ts` (the shared pixel-barcode primitives) |
| Test proof | `phase3-generation-pipeline.test.ts`: provider health reports one entry per capability and never a credential; the fakes are deterministic (byte-identical output for an identical request); the `zero paid provider calls` suite injects a fetch spy and asserts it is never invoked; `the fakes are refused outside an explicitly configured development environment` asserts every capability resolves to `disabled` under `ENVIRONMENT=production` and that calling one throws honestly |
| Limitation | The fakes exist for development and automated tests only, and are refused outside `ENVIRONMENT=development`. Their output is intentionally synthetic. |

## GEN-03 — At least one real environment-configured integration

| | |
|---|---|
| Code | `src/generation/providers/http.ts` (`HttpStoryTextProvider`, `HttpTranslationProvider`, `HttpIllustrationProvider`, `HttpValidationProvider`, `HttpFaceProvider`), `providers/index.ts` (`capabilityConfig`, `getGenerationProviders`), `src/worker.ts` |
| Config | `GENERATION_STORY_API_URL`/`_API_KEY`, `GENERATION_ILLUSTRATION_API_URL`/`_API_KEY`, `GENERATION_TRANSLATION_API_URL`/`_API_KEY`, `GENERATION_VALIDATION_API_URL`/`_API_KEY`; a prompt version's `provider` column selects `http` vs `deterministic-fake`; `GENERATION_DISABLED=1` is the kill switch |
| Test proof | `phase3-generation-pipeline.test.ts`: a URL without a key is NOT a provider (fail-closed) and reports exactly which value is missing; a non-HTTPS endpoint is refused outside development; a complete secure configuration is reported as active `http`. `phase3-templates-preview-admin.test.ts`: `/api/v1/admin/generation/providers` reports configured/disabled per capability and leaks neither the key nor the endpoint |
| Limitation | **No real provider is configured in this repository or in CI.** The adapters are complete, hardened and health-reported, but the owner must supply endpoints + keys (and publish an `http` prompt version) before any real call happens. Automated tests make ZERO external calls. |

## GEN-04 — Asynchronous queue-driven generation

| | |
|---|---|
| Code | `src/generation/queue.ts` (`CloudflareQueueProducer`, `NullQueueProducer`, `dispatchGenerationJob`, `consumeBatch`), `src/generation/pipeline.ts` (`processJob`, `consumeGenerationMessage`, `drainDueJobs`), `src/worker.ts` (`queue()`, `scheduled()`), `wrangler.generation-worker.jsonc` |
| Test proof | `phase3-generation-pipeline.test.ts`: a request creates a `queued` job and inline dispatch runs it to `succeeded`; the admin dispatch sweep claims due work and is audited; the deployment decision and the cron fallback are documented in `docs/V2_ARCHITECTURE_BASELINE.md` |
| Browser proof | The E2E journey clicks the real "Create my preview" control and the pipeline completes in the browser's session |
| Limitation | Pages cannot host the producer binding; the companion Worker's cron is the always-available path, so a deployment without a producer wakes work at cron granularity (≤1 minute) rather than instantly. |

## GEN-05 — Idempotent jobs, attempts, leases, heartbeat, retry and dead-letter

| | |
|---|---|
| Code | `src/generation/jobs.ts` (`enqueueGenerationJob`, `claimJob`, `heartbeatJob`, `markJobRunning`, `completeJob`, `scheduleJobRetry`, `promoteDueRetries`, `failJobPermanently`, `deadLetter`, `resolveDeadLetter`, `cancelJob`, `retryJob`, `recoverExpiredLeases`, `backoffSeconds`, `recordAttempt`, `recordProviderEvent`, `recordUsage`), `migrations/0024` (status-flow, identity-immutability, terminal-freeze and append-only triggers; four unique idempotency indexes) |
| Test proof | `phase3-generation-pipeline.test.ts`: duplicate delivery is acknowledged and changes nothing; two concurrent consumers → exactly one preview and no duplicate cost row; an expired lease is reclaimed (requeued, not dead-lettered) and recorded as a `lease_expired` attempt; a transient failure is retried with backoff (and NOT before it is due); a permanent misconfiguration fails without a retry loop; a malformed provider response is retried and then dead-lettered with an unresolved `generation_dead_letters` row that an explicit retry resolves; cancellation is idempotent and terminal; the integration scenario proves the duplicate-job index and the illegal-transition trigger hold at the schema level |
| Limitation | `max_retries` on the Cloudflare queue itself (5) is a second, coarser layer; the authoritative budget is the D1 one (`generation.max_attempts`). |

## GEN-06 — Per-scene text/image generation and lineage

| | |
|---|---|
| Code | `src/generation/pipeline.ts` (`planTasks`, `runStoryTextTask`, `runIllustrationTask`, `runTranslationTask`, `previewObjectKey`/`originalObjectKey`), `migrations/0024` (`generated_assets` with provider, model, `prompt_version_id`, `prompt_hash`, `checksum`, dimensions, tokens, cost) |
| Test proof | `phase3-generation-pipeline.test.ts` (happy path): 6 scene tasks, 6 originals, 6 watermarked derivatives, generated story text that names the child, per-attempt provider/model/prompt-version lineage rows, and a per-unit cost ledger; `phase3-templates-preview-admin.test.ts` (admin job detail) shows attempts, usage per unit/provider/model and the sanitized provider events |
| Limitation | Translation runs only when the book's language differs from the template's language and a translation prompt is pinned; a scene with no generated-prose placeholder gets no translation task (documented in `planTasks`). |

## GEN-07 — Output dimension, identity, semantic and safety validation

| | |
|---|---|
| Code | `src/generation/validation.ts` (`measureIllustration`, `geometryFailures`, `validateIllustrationOutput`, `validateStoryTextOutput`, `classifyFailure`), `providers/fake-image.ts` (`readMarker` — the validator reads its verdict out of real decoded pixels) |
| Test proof | `phase3-generation-pipeline.test.ts`: a wrong-size output fails the dimension check even though the provider reported success; a child-count mismatch and a semantic mismatch both fail and publish nothing; an unsafe output is dead-lettered on the first attempt rather than retried; an undecodable output is dead-lettered after the budget; the layout validator refuses a config whose own print geometry cannot reach its declared PPI |
| Limitation | Identity/face-count, semantic and safety verdicts come from the configured ValidationProvider. With no validation provider configured, generation fails closed (no preview) rather than publishing unverified output. |

## GEN-08 — Immutable watermarked preview versions and private assets

| | |
|---|---|
| Code | `src/generation/watermark.ts` (`watermarkImage`, `readWatermark`, `normalizeWatermarkLabel`), `src/generation/pipeline.ts` (`finalizePreview`, manifest checksum), `migrations/0024` (`preview_versions`/`preview_assets` additions + the `must be watermarked` insert trigger), `providers/storage.ts` (namespace-enforcing `StorageProvider`), `src/generation/routes.ts` (`GET /previews/:key{.+}`) |
| Test proof | `phase3-templates-preview-admin.test.ts`: the watermark changes real pixels, is verifiable from the stored bytes, is deterministic per label and absent from the original; a different label yields different provenance; every stored preview asset is watermarked, under `gen/preview/`, with a 64-hex checksum, and re-read from R2 where its marker is verified; the originals sit under `gen/original/`, are unwatermarked, and the storage provider refuses cross-namespace writes; the database refuses to insert an unwatermarked preview asset |
| Browser proof | The E2E journey fetches a preview image over the private route (HTTP 200, real JPEG magic bytes, `Cache-Control: private, no-store`, ≥5 KB), asserts the ORIGINALS are 404 for the owner, and that a second user and an anonymous caller get 404 |
| Limitation | The watermark is a visible label plus a machine-verifiable provenance marker — it is not a forensic/robust watermark that survives re-encoding or cropping. No thumbnail derivative is produced (only `page_preview`), because none is fabricated. |

## GEN-09 — Customer progress, failure and recovery UI that survives refresh

| | |
|---|---|
| Code | `src/pages_generation.ts` (`renderGenerationPanel` — server-rendered from real rows), `public/static/generation.js` (bounded polling of the real endpoint, progress bar, retry/cancel/approve/revision controls), `public/static/api.js` (the named generation helpers), `src/index.tsx` (`loadGenerationPanelState` on the reader route), `src/personalization/state-machine.ts` (`queueGeneration`, `markGenerating`, `buildPreviewReadyStatements`, `markGenerationFailed`, `requestRevision`, `markApproved`, `noteRevisionAfterPreview`) |
| Test proof | `phase3-generation-pipeline.test.ts`: the status endpoint reports real phase/scene progress/cost; failure surfaces a code + message and moves the book to `generation_failed` with `canRetry: true`; the panel's server-rendered state is derived from the same rows |
| Browser proof | The E2E journey asserts the panel renders with a working control for a ready book, that it does not claim generation is off when it is configured, that clicking it produces 6 preview images, and that a **full page reload** still shows all 6 pages and names the stored version |
| Limitation | The panel polls (4 s interval, bounded to 90 polls); there is no websocket/SSE push. A job that never reaches a terminal state stops being polled and the customer sees the last real state. |

## GEN-10 — Admin observability, cost and safe retry/cancel

| | |
|---|---|
| Code | `src/generation/admin.ts` (`adminGenerationJobs`, `adminGenerationJobDetail`, `adminGenerationPreviews`), `src/admin_routes.ts` (`/admin/generation/jobs(/:id)`, `retry`, `cancel`, `dispatch`), `src/admin.ts` (navigation), `src/admin-audit.ts` (one immutable audit event per mutation) |
| Test proof | `phase3-templates-preview-admin.test.ts`: anonymous and non-admin callers are denied on every admin generation route (and no audit row is written by a denied attempt); an admin sees the real status, attempt counts, per-unit cost/tokens, append-only attempts and dead letters, and the surface renders NO storage key, provider payload or credential; retry requeues a dead-lettered job and writes one audit event; cancellation without a reason is refused and with one is audited; the dispatch sweep runs due work and audits its outcome |
| Limitation | Cost is reported in the provider's own currency in integer minor units as reported by the provider; there is no currency conversion and no invoice reconciliation (Phase 4's ledger work). |

## GEN-11 — Revision invalidates approval; stale jobs cannot overwrite

| | |
|---|---|
| Code | `src/generation/pipeline.ts` (`preflight` revision re-check, `finalizePreview` guarded CAS + compensating cleanup), `src/personalization/state-machine.ts` (`buildPreviewReadyStatements` with `current_revision` in the CAS), `src/personalization/user-books.ts` (`noteRevisionAfterPreview`, approval invalidation in the same atomic batch), `src/generation/routes.ts` (approval refused for a non-current revision) |
| Test proof | `phase3-generation-pipeline.test.ts`: an edit mid-flight makes the job `superseded` with NO preview version, NO preview assets, the original revision row unchanged and the book not left in `preview_ready`; a NEW revision produces its own preview version while the earlier revision keeps its history; an approval is invalidated by a new revision and re-approving the stale version returns 409 |
| Browser proof | The E2E journey approves a preview, then edits the details and asserts the approval row becomes `invalidated`, the revision advances to 2, and approving version 1 is refused with 409 |
| Limitation | A preview version is unique per (book, revision, template), so regenerating the *same* revision returns the existing version rather than a variant. |

## GEN-12 — Abuse, quota and cost control

| | |
|---|---|
| Code | `migrations/0024` (`generation_quota_windows`, `generation_limits`), `migrations/0025` (seeded limits), `src/generation/jobs.ts` (`loadGenerationLimits`, `reserveGenerationQuota`, `recordGenerationCost`), `src/generation/routes.ts` (rate limit + quota + existing-job short-circuit), `src/generation/pipeline.ts` (max scenes per job) |
| Test proof | `phase3-generation-pipeline.test.ts`: the per-owner quota refuses beyond the limit with an honest 429 and creates NO job; the deployment spend cap refuses new jobs; the cost ledger deduplicates per attempt and is append-only; a duplicate request returns the SAME job (200) and consumes no extra quota; the integration scenario proves the duplicate-job unique index and that the seeded limits are all positive |
| Limitation | The cost cap is a window-based safety net using provider-reported cost; a provider that under-reports cost would under-count. The quota window is a fixed window, not a sliding one. |

## PER-06 — Face analysis and accessible multi-face selection (on the new pipeline)

| | |
|---|---|
| Code | `src/generation/pipeline.ts` (`preflight` face/photo integrity re-check, minimum-confidence enforcement from the scene's own placeholder constraints), `src/personalization/state-machine.ts` (`selectFace`, the 0011 trigger), `src/generation/routes.ts` (`face_required`) |
| Test proof | `phase3-templates-preview-admin.test.ts`: generation is refused with `face_required` when the template needs a face and none is selected (no job created); a face belonging to a different photo cannot be selected (route check + DB trigger backstop); the minimum-confidence constraint from the scene config is enforced |
| Limitation | Confidence comes from the configured face provider; with no provider, the Phase-2 manual-review path applies and no automated confidence claim is made. |

## PER-07 — Immutable personalization revisions

| | |
|---|---|
| Code | `migrations/0011` (`personalization_inputs` immutability trigger, unchanged), `src/generation/jobs.ts` (`input_revision` frozen by `trg_generation_jobs_identity_immutable`), `src/generation/pipeline.ts` (the job and every asset record the exact revision) |
| Test proof | `phase3-templates-preview-admin.test.ts`: the job references the exact revision; mutating a revision row is refused by the schema; after a later edit revision 1 is byte-identical, the published preview still points at revision 1, and its generated text still names the original child |
| Limitation | Editing details creates a new revision; there is no "edit in place". That is the contract, not a gap. |

## PER-09 — Consent version and retention deadline honoured

| | |
|---|---|
| Code | `src/personalization/consent.ts` (`getPublishedConsent`, `recordConsent`, `consentStateOf`, `assertNotExpired`, `DEFAULT_RETENTION_DAYS`), `migrations/0024`/`0025` (`consent_versions` + `consent_version` columns + the published row), `src/personalization/user-books.ts` (consent recorded when the photo is attached; consent surfaced in the schema endpoint), `src/generation/routes.ts` (generation refused past the deadline), `src/personalization/retention.ts` (generated originals AND previews purged; retryable tombstones; books kept until every object is confirmed gone) |
| Test proof | `phase3-templates-preview-admin.test.ts`: consent is recorded against the published version with a real deadline derived from the documented window, with an append-only `consent_recorded` event; re-saving does not extend the deadline; the stored consent hash matches the stored wording; the customer schema names the version; generation past the deadline is refused with `retention_expired` and creates no job; the sweep deletes all 12 generated objects and the book row; a failing storage delete queues 12 tombstones, keeps the book row, and the next sweep resolves them and then purges the book |
| Limitation | Retention is not yet scheduled (no cron deploys it — PLT-10, Phase 8); the sweep is callable and tested, and the companion Worker can run it explicitly. Legal wording still needs counsel review (S-14). |

## ADM-08 — Templates/scenes/placeholders/prompt versions/publish

| | |
|---|---|
| Code | `src/generation/admin.ts` (`adminGenerationTemplates`, `adminGenerationTemplateDetail`), `src/admin_routes.ts` (templates list/detail, clone, publish, retire-with-reason, draft scene edit, prompt binding, prompt clone/publish), `src/admin.ts` (nav) |
| Test proof | `phase3-templates-preview-admin.test.ts` (admin surfaces): the screen states immutability, offers clone→publish, lists prompt versions with their provider, and no route is reachable without the admin guard. `phase3-templates-preview-admin.test.ts` (GEN-01) covers the service-level rules the forms call. |
| Browser proof | `/admin/generation/templates` audited at six widths; the E2E journey opens the admin generation screens |
| Limitation | The admin UI exposes subject/order editing plus prompt (re)binding; adding a new scene or placeholder is available through the service and validated, but not yet through a dedicated form. |

## ADM-09 — Languages/translations/completeness

| | |
|---|---|
| Code | `src/generation/admin.ts` (`generationLanguageCompleteness`) rendered inside the existing `adminLocalization` screen |
| Test proof | `phase3-templates-preview-admin.test.ts`: the localization screen reports generation-template coverage per language, showing a language with no published template as `none` (never as complete) and naming which prompt kinds are published |
| Limitation | Completeness is measured in published template versions and published prompt kinds; it does not (yet) compare translated *wording* quality, and the storefront honestly reports English-only content. |

## ADM-10 — Generation jobs/attempts/cost/manual review

| | |
|---|---|
| Code | `src/generation/admin.ts` (`adminGenerationJobs`, `adminGenerationJobDetail`) |
| Test proof | `phase3-templates-preview-admin.test.ts`: the list shows unresolved dead letters, overdue leases and 30-day spend; the detail shows tasks, per-unit cost/tokens, generated-asset totals, the append-only attempts and the sanitized provider events; a retry and a cancellation are audited |
| Limitation | Manual review of a photo relies on the Phase-2 `manual_photo_review` book state; there is no separate "review this generated page" queue (revision requests + approvals serve that role in ADM-11). |

## ADM-11 — Preview/revision/approval queues

| | |
|---|---|
| Code | `src/generation/admin.ts` (`adminGenerationPreviews`), `src/admin_routes.ts` (`/admin/generation/previews`) |
| Test proof | `phase3-templates-preview-admin.test.ts`: the screen explains that no fabricated pending preview exists, classifies each version (awaiting approval / approved / changes requested), marks historical vs current revisions, and lists revision requests with their notes |
| Browser proof | `/admin/generation/previews` audited at six widths |
| Limitation | The queue is read-only for an operator; approving or requesting changes is the customer's action (correctly), and an operator-initiated re-generate is expressed as a retry of a failed job. |
