# Security incident remediation — exposed database dump & default admin credential

This document exists because Phase 0 (`security/baseline-recovery`) removed
active sensitive material from the source tree. **Removing the file from the
branch HEAD does not undo any exposure that already happened.** The actions
below are for the repository owner (`abcsoft`) to perform; an automated
agent should not perform them without explicit owner approval, and this pack
does not rewrite published Git history automatically.

## What was found

1. **`wonderwraps_full_database_dump.sql`** (introduced in commit
   `593af7b`, "genspark auto-backup", and present at every commit since,
   including the `main` HEAD this pack was prepared against,
   `4d76779cd8547e4e0a6ee834c302c33fb4cbc7fa`) contained real `INSERT`
   statements for:
   - `users` — including a `password_hash` column (PBKDF2-SHA-256 hashes).
   - `sessions` — active session tokens with expiry timestamps.
   - `ai_settings` — an `api_key` column.

   The file has been removed from this branch's HEAD. It is **still present
   in the Git history of `main`** and of the public GitHub remote
   (`https://github.com/abcsoft/storybookclone`) until the owner performs a
   history rewrite (optional step below) — anyone who already cloned or
   fetched the repository, or GitHub's own caches/forks, may already have a
   copy.

2. **Hard-coded default admin credential** (`admin@wonderwraps.com` /
   `admin123`) was auto-created by `ensureSchema()` in `src/index.tsx` on
   first request in *every* environment, including a real deployment. This
   pack replaced that with an explicit, opt-in bootstrap
   (`ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD` env vars, or
   `npm run admin:bootstrap` for local-only use — see README). No code path
   in this branch creates that default account anymore.

## Required owner actions

Do these in order. None of them require code changes beyond what's already
in this branch.

### 1. Rotate/revoke credentials that may have leaked
- [ ] **Change the password** for any real account named `admin@wonderwraps.com`
      (or any other account whose `password_hash` appeared in the dump) on
      every system where that password (or a variant of it) is reused —
      assume the PBKDF2 hash is crackable offline given enough time.
- [ ] **Invalidate every session token** that was in the dump's `sessions`
      table. If you still have D1 access: `DELETE FROM sessions;` (forces
      all users to log in again — safe, sessions are meant to be disposable).
- [ ] **Rotate the API key** stored in `ai_settings.api_key`. Get a new key
      from whichever provider issued it, update it through the admin UI
      (`/admin` → AI settings) or a direct D1 `UPDATE`, and revoke the old
      key at the provider.
- [ ] Check the provider's usage/audit logs for the rotated API key for any
      usage you don't recognize during the exposure window (first commit
      containing the dump → today).

### 2. Enable GitHub protections on `abcsoft/storybookclone`
- [ ] Enable **secret scanning** (Settings → Code security → Secret
      scanning) so any future accidental commit of a real key/token is
      flagged automatically.
- [ ] Enable **push protection** (same page) so GitHub blocks the push
      before a recognized secret pattern lands in history at all.
- [ ] If the repository is public and contains real customer/session data
      in its history, consider requesting GitHub support to purge cached
      views, and review whether any Dependabot/Actions integrations already
      indexed the file.

### 3. (Optional, separately approved) Rewrite history to remove the file
This is **not done automatically by this pack** — it rewrites commit SHAs,
breaks any existing clones/forks/PRs, and must be coordinated with anyone
else who has a copy of the repository. Only do this after step 1
(credential rotation) — removing the file from history does not itself
invalidate anything that already leaked.

```bash
# Using git-filter-repo (recommended over filter-branch/BFG for correctness):
git clone --mirror https://github.com/abcsoft/storybookclone.git storybookclone-mirror
cd storybookclone-mirror
git filter-repo --path wonderwraps_full_database_dump.sql --invert-paths
git push --force --all origin
git push --force --tags origin
```
After this, every collaborator must re-clone (not just pull/rebase).

### 4. Verify
- [ ] `git log --all --oneline -- wonderwraps_full_database_dump.sql`
      returns nothing (after step 3, if performed).
- [ ] `npm run secrets:scan` on the current branch reports no matches.
- [ ] No system still authenticates with the old default admin credential.

## Contact / ownership
This checklist was generated as part of automated Phase 0 baseline recovery.
Assign an owner and a target date for each unchecked box above before
proceeding to Phase 1.
