# V2 Autonomous Completion — Progress Record

Purpose: a single, current record of what was done autonomously, what is
verified, what still needs an owner/external input, and what the next automatic
action would be. Written for handoff — every claim here was executed in this
session; nothing is aspirational.

## 1. Branch / commits

| Item | Value |
|---|---|
| Branch | `fix/phase2-critical-recovery` |
| Audited baseline | `f6f9873` (`docs(phase1): completion report, traceability, architecture and README/API updates`) |
| Task origin | V2 Phase-1 Independent Audit (findings M-1…M-3, L-A…L-E) |
| Phase-0 audited tip | `6e080e8` |
| `main` | `4d76779` — **untouched** (never merged, never pushed, never checked out) |
| Pushed? | **Yes** - `24f342a` was pushed to `origin/fix/phase2-critical-recovery` after AutoCoder review (fast-forward from `f6f9873`; no force, no rewrite). |
| History rewritten? | **No.** `f6f9873` was not amended, rebased or rewritten; all work is new commits on top. |

Coherent fix commits added (on top of `f6f9873`):

| SHA | One-line summary |
|---|---|
| `35288cc` | `fix(orders)`: make the status CAS and its history event one atomic operation (M-1) |
| `7e3e3e1` | `fix(security)`: verified trusted-proxy client identity + guest origin proof (M-2, L-A) |
| `4195b3a` | `fix(personalization)`: harden the HTTP face-provider boundary (M-3) |
| `9969b81` | `fix(commerce)`: database-enforced money invariants + exactly-one-default variant rule (L-B, L-C) |
| `7119720` | `fix(identity)`: one brand/configuration boundary, no legacy brand, no dead payment CSS (L-D, L-E) |
| _this commit_ | `docs(phase1)`: correction-cycle report, traceability rows and this progress record |

**Final SHA:** the branch tip after this docs commit (`git rev-parse HEAD` on
`fix/phase2-critical-recovery`).

## 2. Migrations

| Migration | State | Contents |
|---|---|---|
| `0001`–`0017` | **PUBLISHED — untouched** (verified by diff) | — |
| `0018_money_invariants.sql` | **new, forward-only** | `iso_currencies` ISO-4217 allowlist; deterministic NULL-minor reconciliation that never marks an order paid; `BEFORE INSERT` / `BEFORE UPDATE OF <money cols>` triggers on `orders`, `order_items`, `products`, `product_variants` (L-B) |
| `0019_neutral_ai_settings_defaults.sql` | **new, forward-only** | neutralises the brand-derived `ai_settings` seed values that the admin AI page renders; only a row still carrying all three legacy values is rewritten (L-D) |

Both are idempotent and were re-applied by the migration smoke test's
"repeated behavior" scenario.

## 3. Requirement IDs

### 3.1 Audit findings — all closed

| ID | Severity | Status | Regression test |
|---|---|---|---|
| M-1 | blocker | **closed** | `test/unit/phase1-transition-atomicity.test.ts` |
| M-2 | major | **closed** | `test/unit/phase1-client-identity.test.ts` |
| M-3 | major | **closed** | `test/unit/phase1-face-provider-hardening.test.ts` |
| L-A | lesser | **closed** | `test/unit/phase1-guest-origin.test.ts` |
| L-B | lesser | **closed** | `test/unit/phase1-money-invariants.test.ts` + `scripts/test-integration.mjs` |
| L-C | lesser | **closed** | `test/unit/phase1-variant-invariant.test.ts` |
| L-D | lesser | **closed** | `test/unit/phase1-brand-boundary.test.ts` + e2e identity gate |
| L-E | lesser | **closed** | `test/unit/phase1-brand-boundary.test.ts` (dead-selector assertions) |

### 3.2 Phase-1 C/D/T/S IDs

No Phase-1 ID was re-opened by this cycle, and two status wordings were
corrected in `docs/V2_BASELINE_TRACEABILITY.md`:

- **S-07** — annotated as corrected by M-1 (atomic CAS + event).
- **S-06** — annotated as corrected by M-2 (verified trusted-proxy boundary).
- **S-13** — the earlier "partial (rendered reference assets/copy removed)"
  wording **overclaimed** and is corrected to "partial — not complete": the
  reference screenshots/mockups and the legacy brand string are gone, but the
  reference site's catalog cover/marketing artwork is still shipped and the
  owner must supply the final brand + artwork (Phase 2 / SF-01).

### 3.3 Deferred / open (unchanged from the Phase-1 report)

S-08 (RBAC, Phase 6), S-09 (re-auth, Phase 6), S-11 (retention not scheduled,
Phase 8), S-14 (legal content is a draft requiring owner + counsel), plus the
owner decision on whether to rewrite history for the previously removed
personal photographs. None of these is a regression; each has an owning phase.

## 4. Exact verification (this session, final code state)

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | `0` | 0 errors |
| `npm run test` | `0` | **428 passed / 428** across 26 files (baseline was 343/19; +85 new tests) |
| `npm run test:integration` | `0` | **9/9** scenarios, "Migration smoke tests passed" (45 tables + 12 new columns; 0018 triggers asserted; legacy order still unpaid) |
| `npm run secrets:scan` | `0` | git mode: no matches across 186 files (includes this record) |
| `npm run secrets:scan -- --mode=archive` | `0` | archive mode: no matches across 187 files |
| `npm run build` | `0` | `dist/_worker.js` 291.75 kB (gzip 87.40 kB) |
| `npm run test:e2e` | `0` | all 10 journey groups passed, real Chromium against a locally-built server |
| `npm run audit:frontend -- phase1-correction` | `0` | 0 findings, desktop 1280 + mobile 390, every public/admin route |
| `npm audit --omit=dev` | `0` | 0 vulnerabilities |
| `npm audit` | `1` | 3 high — dev-only `sharp <0.35.4` ← `miniflare` ← `wrangler` (not shipped in `_worker.js`); **pre-existing, unchanged** |

New test files and counts: `phase1-transition-atomicity` 6,
`phase1-client-identity` 11, `phase1-face-provider-hardening` 21,
`phase1-guest-origin` 9, `phase1-money-invariants` 14,
`phase1-variant-invariant` 15, `phase1-brand-boundary` 9 → **85 new tests**.

## 5. Browser journeys (real Chromium, local D1 + R2, no external calls)

`npm run test:e2e` passed all of: identity gate (repo + live server fingerprint,
now brand-derived from `src/brand.ts`, and it fails the run if any legacy brand
renders), guest journey (product → upload → personalize → cart → checkout →
order success → reader → PDF status), authenticated journey (checkout, My Books,
cross-customer denial, logout/login, password reset), double-submission race,
multi-face selection, upload-attack denials, cart reload, cover/variant
agreement, CSRF/origin (including the no-proof and foreign-Origin rejections),
admin (rendered picker, transitions, concurrent renders) and
disabled-capability truthfulness.

`npm run audit:frontend -- phase1-correction` produced 0 findings at both
viewports across every public and admin route (screenshots + `findings.json` in
the gitignored `audit-evidence/phase1-correction/`).

## 6. Audit verdict

All eight audit findings (M-1…M-3, L-A…L-E) are **fixed with real regression
tests** and the full gate set is green. The one remaining red gate is
`npm audit` (3 high in the dev-only `wrangler`/`miniflare`/`sharp` chain), which
is pre-existing, unrelated to this cycle, and not shipped in the worker bundle.

## 7. External credentials / owner inputs still required

Nothing below blocks the work completed here; each is an owner/Phase input.

1. **Final brand + artwork (L-D / SF-01).** The neutral default is
   `Storybook Studio` and the contact address is the RFC-2606 reserved
   `support@storybook-studio.example`. The owner must supply the real name,
   logo, tagline, contact address, social handles and legal entity (set the
   `BRAND_*` values / CMS), plus replacement catalog cover artwork — the
   reference site's artwork is still shipped.
2. **Legal review (S-14).** The legal pages are explicit drafts and must be
   replaced by counsel-reviewed, jurisdiction-aware text before accepting real
   customers, payments or child photographs.
3. **History decision (S-12).** The previously removed personal photographs are
   still reachable in git history; the owner must decide whether to rewrite
   history (and, if this repo was ever pushed, treat them as disclosed).
4. **Face-analysis provider (M-3 / GEN-03, Phase 3).** The hardened HTTP adapter
   is production-configurable but no provider credential is configured, so the
   honest behaviour today is `manual_photo_review`. Configuring a real provider
   needs its endpoint + bearer key as deployment secrets.
5. **Deploy/notifications/revenue (later phases).** No real payment (Phase 4),
   email provider (Phase 3/5), PDF/print/fulfilment (Phase 7), AI generation
   (Phase 3), shipping/refunds/tracking (Phase 4/7), retention cron (Phase 8) or
   RBAC/re-auth (Phase 6). All are disabled with honest responses; none was
   faked.
6. **`npm audit` dev chain.** Fixing the 3 high advisories requires bumping
   `wrangler`/`miniflare`/`sharp` — a toolchain change the owner should
   schedule deliberately (it was left untouched to keep this cycle
   dependency-neutral).

## 8. Next automatic action

**None without owner input.** The audit correction is complete and verified;
starting V2 Phase 2 (original storefront / catalog / CMS) was explicitly out of
scope for this task. When authorised, the next automatic action would be:

1. create `feat/original-storefront-cms` from this branch tip;
2. begin with the owner-input items in §7.1/§7.2 (brand + artwork + legal text
   feed the CMS boundary created in `src/brand.ts`);
3. keep the rendered-route truth guards
   (`test/unit/phase1-truthful-claims.test.ts`) and the brand guard
   (`test/unit/phase1-brand-boundary.test.ts`) in place while the CMS content
   replaces the hard-coded catalog/blog/FAQ data.

## 9. Deviations and disclosures

- **Commit hygiene:** the deletion of the two unreferenced reference-content
  images (`public/static/img/expressions.webp`,
  `public/static/img/cart-cross-sell-bubble.webp`) landed in commit `35288cc`
  (the M-1 commit) rather than the L-D commit, because `git rm` stages the
  deletion and every subsequent `git commit` publishes the whole index.
  Amending history is prohibited by the task constraints, so the record is
  corrected in commit `7119720`'s message and here instead. No other file was
  affected and no finding's verdict depends on it.
- **Extra defect fixed:** the admin product create/update handlers had a
  pre-existing column/argument arity defect (24 columns vs 21–23 bound values)
  that made the admin product form unable to create or save a product at all.
  It was found on the required L-C repair path and fixed there; it was not in
  the audit list.
- **No test was weakened, skipped or deleted.** Existing tests were updated only
  where the new, stronger contract required it: money fixtures now supply the
  minor-unit values 0018 mandates, and e2e browser API calls that carry cookies
  now send the Origin header a real same-origin browser sends (including one
  guest-journey request whose status was previously never asserted, now
  asserted).
- **No real external call** was made by any test or gate: mocked fetch,
  deterministic fakes, local D1/R2 and a local dev server only.
- `.openclaw_test_out.txt` (untracked diagnostic) was never staged.
