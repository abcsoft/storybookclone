#!/usr/bin/env node
// Lightweight, dependency-free secret scan over tracked files (Phase 0:
// "Perform a secrets scan and inspect git diff/status"). Intentionally
// pattern-based and conservative — it is a safety net for this baseline,
// not a replacement for GitHub secret scanning / push protection (see
// docs/SECURITY_INCIDENT_REMEDIATION.md).
//
// IMPORTANT: this script must never print a matched secret value, only its
// location — matched text is redacted before logging.
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const PATTERNS = [
  { name: 'PBKDF2/bcrypt-style password hash literal', re: /pbkdf2\$[0-9a-f]{16,}\$[0-9a-f]{16,}/gi },
  { name: 'AWS access key ID', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'Generic API key assignment', re: /(api[_-]?key|apikey|secret[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/gi },
  { name: 'Stripe secret key', re: /sk_(live|test)_[0-9a-zA-Z]{16,}/g },
  { name: 'Private key block', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'JWT-looking token', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'Hard-coded default admin credential', re: /admin123/gi }
]

const IGNORE_FILES = new Set([
  'scripts/secrets-scan.mjs', // contains the patterns themselves
  'docs/SECURITY_INCIDENT_REMEDIATION.md', // documents the historical incident by pattern name, not by value
  'package-lock.json'
])

// Scan tracked files AND untracked-but-not-gitignored files (not just what's
// already staged/committed) — otherwise a brand-new file scanned before its
// first `git add` produces a false "clean" that a later `git add -A` silently
// invalidates. `--cached` + `--others --exclude-standard` covers both.
const trackedFiles = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((f) => !IGNORE_FILES.has(f))

let findings = 0

for (const file of trackedFiles) {
  let content
  try {
    content = readFileSync(file, 'utf8')
  } catch {
    continue // binary or unreadable; skip
  }
  for (const { name, re } of PATTERNS) {
    const matches = content.match(re)
    if (matches && matches.length) {
      findings += matches.length
      console.error(`POSSIBLE SECRET: ${file} — ${name} (${matches.length} match${matches.length > 1 ? 'es' : ''}, value redacted)`)
    }
  }
}

if (findings > 0) {
  console.error(`\nsecrets:scan found ${findings} possible secret(s). Investigate and remove/rotate before committing.`)
  process.exit(1)
}

console.log('secrets:scan: no matches for known secret patterns in tracked files.')
