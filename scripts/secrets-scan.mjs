#!/usr/bin/env node
// Lightweight, dependency-free secret scan for this repository. It is a
// safety net for the baseline, not a replacement for GitHub secret scanning /
// push protection (see docs/SECURITY_INCIDENT_REMEDIATION.md).
//
// Two discovery modes:
//   * git     — `git ls-files --cached --others --exclude-standard` (tracked
//               + untracked-but-not-ignored files). Used inside a checkout.
//   * archive — a safe filesystem walk. Used when `.git` is absent (e.g. the
//               source tarball/zip a reviewer is handed), which previously
//               made the scan crash instead of reporting.
//   auto (default) picks git mode when a usable `.git` exists in the scan
//   root, otherwise archive mode.
//
// Scope: source, migrations, scripts, docs, config and fixtures are all
// scanned. Only build/dependency/generated output is excluded:
// node_modules, dist, .wrangler, Vite/Vitest caches, coverage and the
// owner-approved local `audit-evidence/` directory. `.sql`/`.env`/`.vars`
// files are deliberately NOT excluded — those are exactly where a committed
// secret is most damaging.
//
// Privacy: a matched secret VALUE is never printed — findings report the
// file path and the rule name only. Exit code is non-zero on any finding.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PATTERNS = [
  { name: 'PBKDF2/bcrypt-style password hash literal', re: /pbkdf2\$[0-9a-f]{16,}\$[0-9a-f]{16,}/gi },
  { name: 'AWS access key ID', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'Generic API key assignment', re: /(api[_-]?key|apikey|secret[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/gi },
  { name: 'Stripe secret key', re: /sk_(live|test)_[0-9a-zA-Z]{16,}/g },
  { name: 'Private key block', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'JWT-looking token', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'Hard-coded default admin credential', re: /admin123/gi }
]

// Files that legitimately contain the pattern text (documentation of the
// incident by pattern name, the scanner itself, and the dependency lockfile
// whose hashes can resemble a JWT at a glance).
export const IGNORE_FILES = new Set([
  'scripts/secrets-scan.mjs',
  'docs/SECURITY_INCIDENT_REMEDIATION.md',
  'package-lock.json'
])

// Directory names that are never scanned in archive mode. These are build
// output, dependency trees or the owner-approved local audit-evidence store —
// not source that could ship a secret.
export const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.wrangler', '.git', 'audit-evidence', 'coverage', '.vite', '.cache'])

function toPosix(p) {
  return p.split(sep).join('/')
}

/** True if a repo-relative path should be skipped entirely. */
export function shouldExcludeRelPath(relPath) {
  const posix = toPosix(relPath).replace(/^\.\//, '')
  if (!posix) return true
  if (IGNORE_FILES.has(posix)) return true
  const segments = posix.split('/')
  return segments.some((s) => EXCLUDED_DIRS.has(s))
}

/** Tracked + untracked-but-not-ignored files, repo-relative posix paths. */
export function discoverGitFiles(cwd, { exec = execFileSync } = {}) {
  const out = exec('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd, encoding: 'utf8' })
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(toPosix)
    .filter((f) => !shouldExcludeRelPath(f))
}

/** Safe recursive walk used when there is no `.git`. */
export function discoverArchiveFiles(rootDir) {
  const found = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      let rel
      try {
        rel = toPosix(relative(rootDir, abs))
      } catch {
        continue
      }
      if (shouldExcludeRelPath(rel)) continue
      if (entry.isDirectory()) {
        walk(abs)
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        found.push(rel)
      }
    }
  }
  walk(rootDir)
  return found.sort()
}

/** Scans text content, returning the names of rules that matched (never values). */
export function scanText(content) {
  const hits = []
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0
    const matches = content.match(re)
    if (matches && matches.length) hits.push({ rule: name, count: matches.length })
  }
  return hits
}

/**
 * Scans a set of repo-relative files under `rootDir`. Returns a list of
 * `{ file, rule, count }` — deliberately never the matched value.
 */
export function scanFiles(rootDir, files, { readFile = (p) => readFileSync(p, 'utf8'), allowList = IGNORE_FILES } = {}) {
  const findings = []
  for (const file of files) {
    if (shouldExcludeRelPath(file) || allowList.has(toPosix(file))) continue
    let content
    try {
      content = readFile(join(rootDir, file))
    } catch {
      continue // unreadable/binary — skip
    }
    if (typeof content !== 'string' || content.includes('\u0000')) continue // binary
    for (const hit of scanText(content)) {
      findings.push({ file: toPosix(file), rule: hit.rule, count: hit.count })
    }
  }
  return findings
}

/** Chooses a discovery mode: explicit `git`/`archive`, or `auto`. */
export function resolveMode(rootDir, requested = 'auto') {
  if (requested === 'git' || requested === 'archive') return requested
  return existsSync(join(rootDir, '.git')) ? 'git' : 'archive'
}

export function discoverFiles(rootDir, mode) {
  if (mode === 'git') return discoverGitFiles(rootDir)
  return discoverArchiveFiles(rootDir)
}

export function parseArgs(argv) {
  const opts = { mode: 'auto', root: process.cwd() }
  for (const arg of argv) {
    if (arg.startsWith('--mode=')) opts.mode = arg.slice('--mode='.length)
    else if (arg.startsWith('--root=')) opts.root = arg.slice('--root='.length)
    else if (arg === '--archive') opts.mode = 'archive'
    else if (arg === '--git') opts.mode = 'git'
  }
  if (!['auto', 'git', 'archive'].includes(opts.mode)) {
    throw new Error(`unknown --mode "${opts.mode}" (expected auto, git or archive)`)
  }
  return opts
}

export function run(argv = process.argv.slice(2)) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    console.error(`secrets:scan: ${err.message}`)
    return 2
  }
  const rootDir = opts.root
  if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) {
    console.error(`secrets:scan: scan root is not a directory: ${rootDir}`)
    return 2
  }

  let mode
  try {
    mode = resolveMode(rootDir, opts.mode)
  } catch (err) {
    console.error(`secrets:scan: ${err.message}`)
    return 2
  }
  if (opts.mode === 'git' && mode !== 'git') return 2

  let files
  try {
    files = discoverFiles(rootDir, mode)
  } catch (err) {
    // A forced git mode with no usable .git is an operator error, not a pass.
    console.error(`secrets:scan: ${mode} mode failed to discover files: ${err.message}`)
    return 2
  }

  const findings = scanFiles(rootDir, files)
  for (const f of findings) {
    console.error(`POSSIBLE SECRET: ${f.file} — ${f.rule} (${f.count} match${f.count > 1 ? 'es' : ''}, value redacted)`)
  }
  if (findings.length > 0) {
    console.error(`\nsecrets:scan [${mode}] found ${findings.length} possible secret(s) across ${new Set(findings.map((f) => f.file)).size} file(s). Investigate and remove/rotate before committing.`)
    return 1
  }
  console.log(`secrets:scan [${mode}]: no matches for known secret patterns across ${files.length} file(s).`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(run())
}
