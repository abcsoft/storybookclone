# Phase 0 Completion Report

Verdict: **COMPLETE**
Branch: `audit/current-baseline-v2`
Baseline HEAD: `f76f44621d7364224f274aa61f97a8d0932ae128`
Final HEAD: recorded in the Phase-0 commit on this branch (see §"Final HEAD" below)

## Confirmed starting state

- Repo root = bound workspace; already on `audit/current-baseline-v2` created from
  `feat/personalization-domain@f76f446`. `main` is at the obsolete `4d76779`
  and was **not** touched.
- `git status` at start: only two untracked files — `STORYBOOKCLONE_COMPLETE_CODING_PACK_V2.md`
  (authoritative pack, staged by this phase) and `.openclaw_test_out.txt` (stray
  diagnostic, deliberately left untracked).
- Migrations `0001`–`0014` present; 42 application tables; 14 triggers; 46 indexes.
- Confirmed the audited Phase-2 baseline: `npm run typecheck` 0 errors,
  `npm run test` **204/204** across 11 files.
- Confirmed the reported defects are real against source (see §"Root causes reproduced").

## Requirement IDs addressed

Phase 0 is an audit/baseline phase; it closes two operational gaps and freezes
every other contract. No Phase-1 business fix was implemented.

| ID | Code path | Test / proof |
|---|---|---|
| **S-15** (secret scanner requires `.git`) | `scripts/secrets-scan.mjs` — git + archive modes, exclusions | `test/unit/secrets-scan.test.ts` (git mode, archive mode, exclusions, synthetic-secret negative control, CLI exit codes); archive run on a `.git`-less copy → exit 0; forced `--mode=git` without `.git` → exit 2 (not a false PASS) |
| **S-16** (`ensureSchema()` inline fallback far behind migrations) | `src/index.tsx` — retired inline `CREATE TABLE`/seed fallback; added `assertMigrationsApplied()`, `bootstrapLocalDefaults()`, `ensureSchemaReady()`; actionable `SchemaOutOfDateError` | `test/unit/admin-bootstrap.test.ts` — unmigrated DB throws actionable error and creates **zero** tables; migrated DB passes; bootstrap still once-per-isolate |
| **PLT-14** (clean install/seed/test/build) | `scripts/reset-local-db.mjs`, `package.json` `db:reset` | `test/unit/reset-local-db.test.ts` (path guards, idempotent missing target, existing-target removal, repo-scoped process filter); live `npm run db:reset` → exit 0 |
| **PLT-09** (responsive/browser gates) | `scripts/test-e2e.mjs` (isolated port + fingerprint + guaranteed cleanup), `scripts/audit-frontend.mjs` (server-tree terminate + explicit exit, no foreign-app kill) | `npm run test:e2e` PASS; `npm run audit:frontend` exit 0 |
| **PLT-04** (secret/env handling) / migration authority | `src/index.tsx` (`SchemaOutOfDateError` names the exact command) | `test/unit/admin-bootstrap.test.ts` |

Traceability contract: `docs/V2_BASELINE_TRACEABILITY.md` maps **every** finding
ID (`C-01`…`C-07`, `D-01`…`D-10`, `T-01`…`T-08`, `S-01`…`S-16`) and **every**
requirement ID (`SF-*`, `PER-*`, `GEN-*`, `COM-*`, `CUS-*`, `ADM-*`, `FUL-*`,
`PLT-*`) to an owner phase, expected code proof, expected test/browser proof and
current status. No ID is omitted or left without an owner phase.

## Root causes reproduced

1. **E2E BLOCKED (the Phase-0 headline blocker).** `npm run test:e2e` failed
   before any browser step at `execSync('npm run db:reset')`. Root cause:
   `db:reset` was `rm -rf .wrangler/state/v3/d1 && …`; (a) `rm -rf` is not
   portable to cmd.exe/PowerShell, and (b) even under Git Bash it failed with
   `Device or resource busy` because a stray `wrangler pages dev`/workerd process
   from a previously-crashed run still held the local D1 SQLite file lock.
   Reproduced exactly: `rm: cannot remove '…/metadata.sqlite': Device or resource busy`.
   Fixed by `scripts/reset-local-db.mjs` (Node fs/path, repo-scoped process stop,
   retrying delete, migrations + seed, non-zero propagation). E2E now runs.
2. **`ensureSchema()` drift.** The inline fallback created only the 0001-era
   tables; any request against an unmigrated DB silently produced a half-schema
   and failed later with confusing errors. Retired in favour of an explicit
   migration-authority failure.
3. **`npm run audit:frontend` never exited.** It completed its work and wrote
   `findings.json` but hung because the spawned `wrangler`/workerd tree kept the
   Node stdio handles open (and its cleanup only killed "whatever is on the
   port", Windows-only). Fixed: kill the spawned server **tree** in `finally`
   and `process.exit` explicitly; never touch a foreign app.

## Implementation

### Files changed
| File | Change | Reason |
|---|---|---|
| `scripts/reset-local-db.mjs` | **added** | Cross-platform, fail-closed local D1 reset |
| `test/unit/reset-local-db.test.ts` | **added** | Guard/behavior regression coverage |
| `scripts/secrets-scan.mjs` | rewritten | Git + archive discovery, exclusions, redaction, exit codes |
| `test/unit/secrets-scan.test.ts` | **added** | Git/archive/exclusion/negative-control/CLI coverage |
| `src/index.tsx` | edited | Retired inline schema creation; added migration guard + split bootstrap |
| `test/unit/admin-bootstrap.test.ts` | edited | Re-pointed to migrated DB; added migration-authority regressions |
| `scripts/test-e2e.mjs` | edited | Isolated free port, project fingerprint, no foreign-app kill, guaranteed cleanup |
| `scripts/audit-frontend.mjs` | edited | Terminate spawned server tree + explicit exit; removed port-wide kill |
| `package.json` | edited | `db:reset` → `node scripts/reset-local-db.mjs` |
| `STORYBOOKCLONE_COMPLETION_CODING_PACK.md` | edited | Prefixed historical/superseded banner (file retained) |
| `STORYBOOKCLONE_COMPLETE_CODING_PACK_V2.md` | **tracked** | Authoritative spec now version-controlled |
| `docs/V2_BASELINE_TRACEABILITY.md` | **added** | Deliverable A |
| `docs/V2_ARCHITECTURE_BASELINE.md` | **added** | Deliverable B |
| `docs/V2_PHASE0_COMPLETION_REPORT.md` | **added** | This report |

### Migrations added
**None.** `0001`–`0014` are untouched (verified: no `migrations/` entry in
`git status`/`git diff`). Forward migrations start at `0015` (Phase 1).

### Routes / jobs / UI added
No product routes or jobs were added. New internal functions:
`assertMigrationsApplied`, `bootstrapLocalDefaults`, `ensureSchemaReady`,
`SchemaOutOfDateError` (`src/index.tsx`); `resolveSafeTarget`,
`isRepoToolCommandLine`, `stopRepoToolProcesses`, `removeTarget` (`scripts/reset-local-db.mjs`);
`discoverGitFiles`, `discoverArchiveFiles`, `scanText`, `scanFiles`,
`shouldExcludeRelPath`, `resolveMode`, `run` (`scripts/secrets-scan.mjs`).

## Security/privacy decisions

- The reset script deletes **only** `<repo-root>/.wrangler/state/v3/d1`, resolved
  from its own file location; it fails closed on an outside-repo/unexpected
  target, never resolves a symlink outward, never touches the repo root, home
  directory or a drive root, and stops only this repo's wrangler/workerd/miniflare
  processes (a process must mention both the repo path and a tool name).
- The secret scanner still reports **paths and rule names only**, never a matched
  value, and now exits non-zero on a finding in both modes. `.sql`, `.env`,
  `.vars`, docs and config files remain in scope; only `node_modules`, `dist`,
  `.wrangler`, caches and the owner-approved `audit-evidence/` are excluded.
- Migration authority is explicit: an unmigrated database now fails with an
  actionable error instead of being half-created at runtime.
- Fail-closed defaults (face analysis, email) were **not** weakened.
- Deliberately **not** done: no CSRF/cookie/CORS/header/rate-limit changes, no
  `gando` removal, no upload-completion guard fix, no payment/email/generation
  work — all are Phase 1+ per the pack. No migration was modified. No test was
  weakened or skipped.

## Verification

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | 0 | **PASS** — 0 errors |
| `npm run test` | 0 | **PASS** — **226/226** tests, 13 files (baseline 204/204, 11 files; +22) |
| `npm run test:integration` | 0 | **PASS** — 8/8 migration scenarios (empty, Phase-0 baseline, Phase-1 0004/0005, row-preservation, 0009 schema, Phase-2 row survival, repeat-apply) |
| `npm run secrets:scan` | 0 | **PASS** — git mode, 170 files, 0 findings |
| `npm run secrets:scan` (archive, `.git`-less copy) | 0 | **PASS** — archive mode, 0 findings; forced git mode without `.git` → exit 2 (fail-closed) |
| `npm run build` | 0 | **PASS** — `dist/_worker.js` 258.80 kB, gzip 75.94 kB |
| `npm run test:e2e` | 0 | **PASS** — real Chromium against local D1/R2 on an auto-selected free port; fingerprint verified; guest, authenticated, double-submission and multi-face journeys all passed |
| `npm run audit:frontend` | 0 | **PASS** — 0 findings; public + admin routes at desktop (1280×900) and mobile (390×844); customer→admin role denial incl. direct POST |
| `npm audit --omit=dev` | 0 | **PASS** — 0 production vulnerabilities |
| `npm audit` | **1** | **FAIL (pre-existing, dev-only)** — 3 high severity via `sharp ← miniflare ← wrangler`. Not production runtime; must be resolved by a Wrangler/miniflare update + re-audit before release (carried as a release-gate risk) |

### E2E detail (actually ran)
`npm run test:e2e` executed the full browser suite; exit 0. Journeys:
guest checkout (order `user_id` NULL verified in D1, guest token replay/
tamper/cross-order denials, reader link, PDF-request capability incl. expiry),
authenticated checkout (registration, My Books, second-customer denial,
password reset via dev console adapter), browser-level double submission
(exactly one logical order; changed-payload → 409), and deterministic
multi-face selection. Browser routes exercised include `/books/:slug`,
`/cart`, `/checkout`, `/order-success`, `/my/books/:slug`, `/my-books`,
`/register`, `/login`, `/admin/login`, `/admin`.

### Browser routes/viewports (audit)
Desktop 1280×900 and mobile 390×844 over 17 public routes, the admin route set,
representative product-detail + PDP editor, and a cross-role denial pass.
Evidence written to `audit-evidence/` (gitignored, **not** committed).

## Data migration/backfill result

No data migration or backfill was performed (no migrations added). The local
D1 was rebuilt from `0001`–`0014` via the new reset path and seeded; no
production data, dump, hash, token or dump-derived fixture was read or printed.
The two pre-existing operational defects found in the pack (`S-15`, `S-16`) are
closed; the pre-existing `main`-baseline divergence is documented, not merged.

## Diff/secret/reference-content review

- `git status` shows exactly the intended files; **`.openclaw_test_out.txt` was
  left untracked and was not staged**; no `git add -A`/`git add .` was used.
- `npm run secrets:scan` (git and archive modes) reports 0 findings.
- No migrations, dumps, customer data, child-photo keys, signed URLs, hashes or
  tokens were added. `dist/`, `.wrangler/` and `audit-evidence/` remain ignored.
- The superseded pack was modified only by prepending a deprecation banner
  (content retained, not deleted).

## Remaining risks or owner decisions

1. **Placeholder D1 `database_id`** (`wrangler.jsonc` → `local-dev-placeholder`)
   blocks a real deploy — owner phase 9.
2. **3 high dev-tool vulnerabilities** (`sharp` via `wrangler`/`miniflare`) —
   update + re-audit before release; production runtime audit is clean.
3. **No Queue/Cron bindings**; retention exists but is not deployed (`S-11`).
4. **`npm audit` exit 1** is accepted for this phase as a documented dev-only
   toolchain finding (production audit clean), to be cleared in Phase 8/9.
5. All critical journey blockers (`C-01`…`C-07`), data defects (`D-01`…`D-10`)
   and truthful-claim defects (`T-01`…`T-08`) remain open by design — Phase 1.
6. Extension of scope beyond the literal list: `scripts/audit-frontend.mjs` was
   fixed for the same spawned-process/port issue as the E2E script, because the
   `audit:frontend` gate otherwise could not exit. No behavior of the audit
   itself changed.

## Exact next phase recommendation

Proceed to **Phase 1 — Critical Correctness, Security and Truth Recovery** on
branch `fix/phase2-critical-recovery`, closing `C-01`…`C-07`, `D-01`…`D-09`,
`T-01`…`T-08` and the prerequisite `S-*` items, with optional
`0015_integrity_security_recovery.sql`. Do not modify `0001`–`0014`. Do not
start Phase 2+ until Phase 1 acceptance browser journeys pass.

## Final HEAD

Final HEAD: the tip of `audit/current-baseline-v2` — a single Phase-0 commit
(`chore(phase0): re-baseline at f76f446, lock contract, unblock real-browser gates`)
whose parent is the baseline `f76f446`. The exact hash is reported in the
Phase-0 handoff (a hash cannot be embedded in its own commit without changing
it).

## Confirmation

- No merge, no deploy, no push, no `main` update.
- No secrets/customer data/dump committed or printed.
- No blocked/skipped test reported as passed. The only non-zero gate
  (`npm audit`, exit 1) is reported as a FAIL with its exact cause, not hidden.
