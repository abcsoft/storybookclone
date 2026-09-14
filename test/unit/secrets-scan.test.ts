// Regression coverage for the Phase-0 secret-scanner contract
// (scripts/secrets-scan.mjs):
//   * git-mode discovery still works inside a real checkout;
//   * archive-mode discovery works with NO `.git` (the previously-failing case);
//   * build/dependency/generated output and audit-evidence/ are excluded, while
//     source/migrations/docs/config/.env stay in scope;
//   * a synthetic secret is detected (negative control) and its VALUE is never
//     exposed in the findings;
//   * the CLI exits non-zero on a finding and zero on a clean tree.
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  shouldExcludeRelPath,
  discoverArchiveFiles,
  discoverGitFiles,
  scanFiles,
  scanText,
  run
} from '../../scripts/secrets-scan.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const scriptPath = join(repoRoot, 'scripts', 'secrets-scan.mjs')

// Built by concatenation (not a literal) so this test file does not itself
// trip the scanner it is testing.
const FAKE_STRIPE = 'sk_' + 'live_' + 'A'.repeat(24)

const tempDirs: string[] = []
function makeTempTree() {
  const dir = mkdtempSync(join(tmpdir(), 'ww-secrets-scan-'))
  tempDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
})

describe('secrets-scan path exclusions', () => {
  it('excludes dependency, build, generated and audit-evidence paths', () => {
    for (const p of [
      'node_modules/pkg/index.js',
      'dist/_worker.js',
      '.wrangler/state/v3/d1/x.sqlite',
      'audit-evidence/homepage/after.png',
      'coverage/lcov.info',
      'some/nested/node_modules/dep/a.js'
    ]) {
      expect(shouldExcludeRelPath(p), p).toBe(true)
    }
  })

  it('keeps source, migrations, scripts, docs and config file types in scope', () => {
    for (const p of ['src/index.tsx', 'migrations/0014_retention_failures.sql', 'scripts/secrets-scan.mjs', 'docs/API_V1.md', '.env', '.dev.vars', 'wrangler.jsonc', 'seed.sql']) {
      // secrets-scan.mjs is only ignored as a specific allow-listed file, not because
      // its directory is excluded — assert the general rule, then the allow-list.
      expect(shouldExcludeRelPath(p) === false || p === 'scripts/secrets-scan.mjs', p).toBe(true)
    }
  })
})

describe('archive-mode discovery (no .git)', () => {
  it('walks project files but skips excluded directories', () => {
    const root = makeTempTree()
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'migrations'), { recursive: true })
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
    mkdirSync(join(root, 'dist'), { recursive: true })
    mkdirSync(join(root, '.wrangler', 'state'), { recursive: true })
    mkdirSync(join(root, 'audit-evidence'), { recursive: true })

    writeFileSync(join(root, 'src', 'index.tsx'), 'export default 1')
    writeFileSync(join(root, 'migrations', '0001_initial.sql'), 'CREATE TABLE x (id INTEGER)')
    writeFileSync(join(root, 'docs', 'API_V1.md'), '# docs')
    writeFileSync(join(root, '.env'), 'FOO=bar')
    writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'const x = 1')
    writeFileSync(join(root, 'dist', '_worker.js'), 'built')
    writeFileSync(join(root, '.wrangler', 'state', 'x'), 'state')
    writeFileSync(join(root, 'audit-evidence', 'shot.txt'), 'evidence')

    const files = discoverArchiveFiles(root)
    expect(files).toContain('src/index.tsx')
    expect(files).toContain('migrations/0001_initial.sql')
    expect(files).toContain('docs/API_V1.md')
    expect(files).toContain('.env')
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false)
    expect(files.some((f) => f.startsWith('dist/'))).toBe(false)
    expect(files.some((f) => f.startsWith('.wrangler/'))).toBe(false)
    expect(files.some((f) => f.startsWith('audit-evidence/'))).toBe(false)
  })

  it('detects a synthetic secret in a scanned file without exposing its value', () => {
    const root = makeTempTree()
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'leak.ts'), `const key = "${FAKE_STRIPE}"`)
    writeFileSync(join(root, 'src', 'clean.ts'), 'const safe = "nothing to see"')

    const files = discoverArchiveFiles(root)
    const findings = scanFiles(root, files)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings.some((f) => f.file === 'src/leak.ts' && f.rule === 'Stripe secret key')).toBe(true)
    // Negative control: a clean file produces no finding.
    expect(findings.some((f) => f.file === 'src/clean.ts')).toBe(false)
    // The matched value must never appear anywhere in the findings payload.
    expect(JSON.stringify(findings)).not.toContain(FAKE_STRIPE)
  })
})

describe('scanText rules', () => {
  it('reports rule names but never the matched value', () => {
    const value = 'AKIA' + 'B'.repeat(16)
    const hits = scanText(`aws_key = "${value}"`)
    expect(hits.some((h) => h.rule === 'AWS access key ID')).toBe(true)
    expect(JSON.stringify(hits)).not.toContain(value)
  })
})

describe('git-mode discovery', () => {
  it('finds tracked project files when a .git checkout is present', () => {
    if (!existsSync(join(repoRoot, '.git'))) return // archive-only environment
    const files = discoverGitFiles(repoRoot)
    expect(files).toContain('migrations/0001_initial.sql')
    expect(files).toContain('src/index.tsx')
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false)
    expect(files).not.toContain('scripts/secrets-scan.mjs') // allow-listed
  })
})

describe('CLI contract (exit codes and redaction)', () => {
  const cli = (args: string[], cwd: string) => {
    try {
      const stdout = execFileSync('node', [scriptPath, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { status: 0, output: stdout }
    } catch (err: any) {
      return { status: err.status, output: `${err.stdout || ''}${err.stderr || ''}` }
    }
  }

  it('exits 1 on a finding and never prints the secret value', () => {
    const root = makeTempTree()
    writeFileSync(join(root, 'leak.txt'), `token=${FAKE_STRIPE}`)
    const { status, output } = cli(['--mode=archive', `--root=${root}`], root)
    expect(status).toBe(1)
    expect(output).toContain('leak.txt')
    expect(output).toContain('Stripe secret key')
    expect(output).not.toContain(FAKE_STRIPE)
  })

  it('exits 0 on a clean tree', () => {
    const root = makeTempTree()
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'ok.ts'), 'export const ok = true')
    const { status } = cli(['--mode=archive', `--root=${root}`], root)
    expect(status).toBe(0)
  })

  it('run() returns non-zero for an unknown mode', () => {
    expect(run(['--mode=bogus'])).toBe(2)
  })
})
