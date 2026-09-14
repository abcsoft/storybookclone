#!/usr/bin/env node
// Cross-platform local D1 reset: `npm run db:reset`.
//
// Replaces the previous `rm -rf .wrangler/state/v3/d1 && npm run
// db:migrate:local && npm run db:seed` shell one-liner, which was not
// portable (no `rm -rf` in cmd.exe/PowerShell) and, even under a Unix shell,
// failed with "Device or resource busy" whenever a stray `wrangler pages
// dev`/workerd process from a previously-crashed run still held the local
// SQLite file lock — which is exactly what blocked Playwright E2E.
//
// Safety model (fail-closed):
//   * Only ONE path is ever deleted: <repo-root>/.wrangler/state/v3/d1,
//     resolved from this file's own location (never from cwd or env).
//   * The resolved target must be strictly inside the repo root AND have the
//     exact expected path shape. A symlinked or otherwise unexpected target
//     is refused rather than followed.
//   * It can never resolve to the repo root, the user's home directory, a
//     drive/filesystem root, a broad `.wrangler` tree, or an unresolved path.
//   * Before deleting, it stops only THIS repo's local wrangler/workerd
//     processes (a process is only a candidate if its command line mentions
//     both this repo's absolute path and wrangler/workerd/miniflare). An
//     unrelated app or a different checkout is never touched.
//   * A missing target is fine (idempotent). A locked target that cannot be
//     released is a hard error, never a silent skip.
//
// Usage: node scripts/reset-local-db.mjs
import { existsSync, rmSync, lstatSync, unlinkSync, realpathSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

/** Repo root, derived from this script's location (scripts/ -> root). */
export function repoRootFromScript(scriptUrl = import.meta.url) {
  return resolve(dirname(fileURLToPath(scriptUrl)), '..')
}

/** The one and only relative path this script is allowed to delete. */
export const D1_STATE_REL = join('.wrangler', 'state', 'v3', 'd1')

/** Expected trailing path segments, platform-normalized for comparison. */
const EXPECTED_TAIL = '.wrangler/state/v3/d1'

function normalize(p) {
  return resolve(p).replace(/\\/g, '/').replace(/\/+$/, '')
}

/** Is `child` inside `parent` (after normalization)? Boundary-aware, so a sibling `foo-backup` never matches. */
function isInside(parentNorm, childNorm) {
  return childNorm === parentNorm || childNorm.startsWith(parentNorm + '/')
}

/** Windows paths are case-insensitive; POSIX paths are not. */
const ci = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)

/**
 * Realpath containment (Phase-0 audit L-4): resolves the target AND every
 * existing ancestor with realpath, and refuses any component that is a
 * symlink escaping the repo root. A lexical `resolve()` alone cannot catch a
 * symlinked ancestor (e.g. `.wrangler/state` -> outside), which would make
 * `rmSync(recursive)` delete an external directory. A missing target is fine
 * (idempotent) — only existing components are resolved.
 */
export function assertRealPathContained(rootAbs, targetAbs) {
  let rootReal = rootAbs
  try {
    rootReal = realpathSync(rootAbs)
  } catch {
    /* root missing/unresolvable — lexical checks already cover it */
  }
  const rootRealNorm = normalize(rootReal)

  const rel = relative(rootAbs, targetAbs)
  const segments = rel.split(sep).filter(Boolean)
  let cur = rootAbs
  for (const segment of segments) {
    cur = join(cur, segment)
    let st
    try {
      st = lstatSync(cur)
    } catch {
      break // component does not exist yet — nothing further can exist either
    }
    if (st.isSymbolicLink()) {
      let real
      try {
        real = realpathSync(cur)
      } catch {
        throw new Error(`refusing to reset: cannot resolve symlink component ${cur}`)
      }
      if (!isInside(ci(rootRealNorm), ci(normalize(real)))) {
        throw new Error(`refusing to reset: symlink escape outside the repo root (${cur} -> ${real})`)
      }
    }
  }

  // Final backstop: if the target exists, its resolved path must still be
  // inside the repo root (and therefore inside the exact D1 state dir).
  if (existsSync(targetAbs)) {
    const realTarget = realpathSync(targetAbs)
    if (!isInside(ci(rootRealNorm), ci(normalize(realTarget)))) {
      throw new Error(`refusing to reset: resolved target escapes the repo root (${targetAbs} -> ${realTarget})`)
    }
  }
  return true
}

/**
 * Resolves and validates the deletion target. Throws on any unsafe shape.
 * Returns the absolute target path.
 */
export function resolveSafeTarget(root, rel = D1_STATE_REL) {
  const rootAbs = resolve(root)
  const targetAbs = resolve(rootAbs, rel)

  if (!isAbsolute(targetAbs)) throw new Error(`refusing to reset an unresolved target path: ${targetAbs}`)

  // Must be strictly inside the repo root (not the root itself, not outside).
  const relToRoot = relative(rootAbs, targetAbs)
  if (!relToRoot || relToRoot.startsWith('..') || isAbsolute(relToRoot)) {
    throw new Error(`refusing to reset a path outside the repo root: ${targetAbs} (repo root: ${rootAbs})`)
  }

  // Exact expected shape — guards against a future typo widening the scope.
  if (!normalize(targetAbs).endsWith('/' + EXPECTED_TAIL)) {
    throw new Error(`refusing to reset an unexpected path (expected to end with /${EXPECTED_TAIL}): ${targetAbs}`)
  }

  // Never the repo root, the home directory, or a filesystem/drive root.
  const homeAbs = normalize(homedir())
  const targetNorm = normalize(targetAbs)
  if (targetNorm === normalize(rootAbs)) throw new Error(`refusing to reset the repo root: ${targetAbs}`)
  if (targetNorm === homeAbs) throw new Error(`refusing to reset the user home directory: ${targetAbs}`)
  if (dirname(targetAbs) === targetAbs) throw new Error(`refusing to reset a filesystem root: ${targetAbs}`)

  // Realpath the whole ancestor chain (defeats a symlinked `.wrangler`/`state`).
  assertRealPathContained(rootAbs, targetAbs)

  return targetAbs
}

// A process only counts as this repo's tool if a command token is exactly a
// tool name (optionally with an executable/script extension) — never a mere
// substring match, so `wrangler.jsonc`, `my-wrangler-notes` and
// `miniflare-config.json` are NOT mistaken for an executable.
const TOOL_SEGMENT = /^(workerd|wrangler|miniflare)$/i
const TOOL_BASENAME = /^(workerd|wrangler|miniflare)\.(exe|cmd|bat|ps1|js|mjs|cjs)$/i

function commandMentionsToolToken(cl) {
  for (const token of cl.split(/[\\/\s"']+/)) {
    if (!token) continue
    if (TOOL_SEGMENT.test(token) || TOOL_BASENAME.test(token)) return true
  }
  return false
}

/**
 * True when a command line belongs to THIS repo's wrangler/workerd/miniflare.
 * Requires BOTH (a) a path genuinely under the repo root — a real path
 * boundary, so a sibling checkout `storybooknewapps-backup` never matches —
 * and (b) an actual tool executable token, not a filename that merely
 * contains the word.
 */
export function isRepoToolCommandLine(commandLine, root) {
  if (!commandLine) return false
  // Windows command lines use backslashes; normalize both sides to '/' so the
  // same comparison works on every platform.
  const cl = commandLine.replace(/\\/g, '/').toLowerCase()
  const rootNorm = normalize(root).toLowerCase()
  const mentionsRoot =
    cl.includes(rootNorm + '/') ||
    cl.split(/[\s"']+/).some((t) => t.replace(/[\\/]+$/, '') === rootNorm)
  if (!mentionsRoot) return false
  return commandMentionsToolToken(cl)
}

function listProcesses() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      )
      if (!out.trim()) return []
      const parsed = JSON.parse(out)
      const rows = Array.isArray(parsed) ? parsed : [parsed]
      return rows.map((r) => ({ pid: Number(r.ProcessId), ppid: Number(r.ParentProcessId), commandLine: String(r.CommandLine || '') }))
    }
    const out = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' })
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(\d+)\s+(\d+)\s+(.*)$/)
        return m ? { pid: Number(m[1]), ppid: Number(m[2]), commandLine: m[3] } : null
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

function ancestorsOf(pid, byPid) {
  const seen = new Set()
  let cur = pid
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    cur = byPid.get(cur)?.ppid ?? 0
  }
  return seen
}

/** Stops this repo's local wrangler/workerd processes. Returns the PIDs stopped. */
export function stopRepoToolProcesses(root, { list = listProcesses, kill = defaultKill, selfPid = process.pid } = {}) {
  const procs = list()
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const protectedPids = ancestorsOf(selfPid, byPid)
  protectedPids.add(selfPid)

  const stopped = []
  for (const p of procs) {
    if (protectedPids.has(p.pid)) continue
    // Only a real workerd/wrangler/miniflare executable under THIS repo —
    // never an unrelated process whose command line merely mentions the path
    // or a filename such as `wrangler.jsonc`.
    if (!isRepoToolCommandLine(p.commandLine, root)) continue
    try {
      kill(p.pid)
      stopped.push(p.pid)
    } catch {
      /* already gone */
    }
  }
  return stopped
}

function defaultKill(pid) {
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* fall through to SIGKILL below only if it still exists */
    }
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Removes a directory, retrying to ride out transient file locks. Also refuses to follow a symlink. */
export function removeTarget(target, { attempts = 4, onRetry } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (!existsSync(target)) return true
    try {
      const st = lstatSync(target)
      if (st.isSymbolicLink()) {
        unlinkSync(target) // remove the link itself, never its target
      } else {
        rmSync(target, { recursive: true, force: true })
      }
      if (!existsSync(target)) return true
    } catch (err) {
      if (attempt === attempts) return { ok: false, error: err }
    }
    if (attempt < attempts) {
      onRetry?.(attempt)
      sleepSync(250 * attempt)
    }
  }
  return !existsSync(target) ? true : { ok: false, error: new Error('target still present after retries') }
}

function runStep(label, command, args, cwd) {
  console.log(`[db:reset] ${label}: ${command} ${args.join(' ')}`)
  const res = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (res.error) {
    console.error(`[db:reset] ${label} failed to start: ${res.error.message}`)
    return 1
  }
  return typeof res.status === 'number' ? res.status : 1
}

export function main({ root = repoRootFromScript() } = {}) {
  let target
  try {
    target = resolveSafeTarget(root)
  } catch (err) {
    console.error(`[db:reset] FAIL-CLOSED: ${err.message}`)
    return 1
  }

  console.log(`[db:reset] repo root: ${resolve(root)}`)
  console.log(`[db:reset] target   : ${target}`)

  const stopped = stopRepoToolProcesses(root)
  if (stopped.length) console.log(`[db:reset] stopped this repo's local wrangler process(es): ${stopped.join(', ')}`)
  else console.log('[db:reset] no local wrangler process to stop')

  let removed = removeTarget(target, { onRetry: (n) => console.log(`[db:reset] target still locked, retry ${n}...`) })
  if (removed !== true) {
    // One more attempt after re-stopping, in case a process respawned.
    const again = stopRepoToolProcesses(root)
    if (again.length) console.log(`[db:reset] stopped ${again.join(', ')} before final retry`)
    removed = removeTarget(target, { attempts: 3 })
  }
  if (removed !== true) {
    console.error(`[db:reset] could not remove ${target}: ${removed.error?.message || 'unknown error'}`)
    console.error('[db:reset] Stop any running `wrangler pages dev` for this repo, then retry.')
    return 1
  }
  console.log('[db:reset] local D1 state removed (or already absent)')

  const migrateStatus = runStep('applying migrations', 'npx', ['wrangler', 'd1', 'migrations', 'apply', 'webapp-production', '--local'], root)
  if (migrateStatus !== 0) {
    console.error(`[db:reset] migrations failed with exit code ${migrateStatus}`)
    return migrateStatus
  }

  const seedStatus = runStep('seeding', 'npx', ['wrangler', 'd1', 'execute', 'webapp-production', '--local', '--file=./seed.sql'], root)
  if (seedStatus !== 0) {
    console.error(`[db:reset] seed failed with exit code ${seedStatus}`)
    return seedStatus
  }

  console.log('[db:reset] done — local D1 reset, migrated and seeded.')
  return 0
}

// Only run when executed directly (never when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
