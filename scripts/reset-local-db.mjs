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
import { existsSync, rmSync, lstatSync, unlinkSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
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

  return targetAbs
}

/** True when a command line belongs to THIS repo's wrangler/workerd/miniflare. */
export function isRepoToolCommandLine(commandLine, root) {
  if (!commandLine) return false
  // Windows command lines use backslashes; normalize both sides to '/' so the
  // same comparison works on every platform.
  const cl = commandLine.replace(/\\/g, '/').toLowerCase()
  const rootNorm = normalize(root).toLowerCase()
  if (!cl.includes(rootNorm)) return false
  return /(workerd|wrangler|miniflare)/i.test(cl)
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
    // Only workerd/wrangler/miniflare processes, never arbitrary ones whose
    // command line merely mentions this path (e.g. an editor indexing it).
    if (!/\b(workerd|wrangler|miniflare)\b/i.test(p.commandLine)) continue
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
