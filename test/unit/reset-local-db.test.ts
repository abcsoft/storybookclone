// Regression coverage for the cross-platform `db:reset` path guards
// (scripts/reset-local-db.mjs). These are the safety invariants that keep a
// reset from ever deleting anything but this repo's exact local
// Wrangler D1 state directory.
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import {
  resolveSafeTarget,
  assertRealPathContained,
  isRepoToolCommandLine,
  stopRepoToolProcesses,
  removeTarget,
  D1_STATE_REL
} from '../../scripts/reset-local-db.mjs'

const tempDirs: string[] = []
function makeRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'ww-reset-'))
  tempDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
})

describe('resolveSafeTarget', () => {
  it('resolves the exact local Wrangler D1 state directory', () => {
    const root = makeRoot()
    const target = resolveSafeTarget(root)
    expect(target.replace(/\\/g, '/')).toContain('/.wrangler/state/v3/d1')
    expect(target.replace(/\\/g, '/').startsWith(root.replace(/\\/g, '/'))).toBe(true)
    expect(D1_STATE_REL.replace(/\\/g, '/')).toBe('.wrangler/state/v3/d1')
  })

  it('refuses a target outside the repo root', () => {
    const root = makeRoot()
    expect(() => resolveSafeTarget(root, '../../outside')).toThrow(/outside the repo root/)
    expect(() => resolveSafeTarget(root, '/etc')).toThrow(/outside the repo root/)
  })

  it('refuses the repo root itself and unexpected path shapes', () => {
    const root = makeRoot()
    expect(() => resolveSafeTarget(root, '.')).toThrow()
    expect(() => resolveSafeTarget(root, '.wrangler/state')).toThrow(/unexpected path/)
    expect(() => resolveSafeTarget(root, '.wrangler/state/v3')).toThrow(/unexpected path/)
  })
})

describe('assertRealPathContained (Phase-0 audit L-4 symlink chain)', () => {
  it('accepts a normal (or not-yet-existing) D1 state path', () => {
    const root = makeRoot()
    expect(assertRealPathContained(root, resolveSafeTarget(root))).toBe(true)
    mkdirSync(join(root, 'real-target'), { recursive: true })
    expect(assertRealPathContained(root, join(root, 'real-target'))).toBe(true)
  })

  it('refuses a symlinked ANCESTOR that escapes the repo root', () => {
    const root = makeRoot()
    const outside = makeRoot() // a different directory entirely
    try {
      symlinkSync(outside, join(root, '.wrangler'), 'junction')
    } catch (err: any) {
      if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'UNKNOWN') return
      throw err
    }
    expect(() => assertRealPathContained(root, join(root, '.wrangler', 'state', 'v3', 'd1'))).toThrow(/symlink escape|escapes the repo root/)
    // And the full guard (resolveSafeTarget) also refuses it.
    expect(() => resolveSafeTarget(root)).toThrow(/symlink escape|escapes the repo root/)
  })

  it('refuses a symlinked TARGET that escapes the repo root', () => {
    const root = makeRoot()
    const outside = makeRoot()
    mkdirSync(join(root, '.wrangler', 'state', 'v3'), { recursive: true })
    try {
      symlinkSync(outside, join(root, '.wrangler', 'state', 'v3', 'd1'), 'junction')
    } catch (err: any) {
      if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'UNKNOWN') return
      throw err
    }
    expect(() => assertRealPathContained(root, join(root, '.wrangler', 'state', 'v3', 'd1'))).toThrow(/symlink escape|escapes the repo root/)
  })
})

describe('isRepoToolCommandLine', () => {
  const root = makeRoot()
  it('matches this repo\u2019s workerd/wrangler processes for the current platform', () => {
    expect(isRepoToolCommandLine(`${join(root, 'node_modules', '@cloudflare', 'workerd', 'bin', 'workerd.exe')} serve`, root)).toBe(true)
    expect(isRepoToolCommandLine(`"node" "${join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js')}" pages dev dist`, root)).toBe(true)
  })

  it.skipIf(process.platform !== 'win32')('matches Windows backslash command lines too', () => {
    const winRoot = 'C:\\xampp_lite_8_3\\www\\storybooknewapps'
    expect(isRepoToolCommandLine('C:\\xampp_lite_8_3\\www\\storybooknewapps\\node_modules\\@cloudflare\\workerd-windows-64\\bin\\workerd.exe serve', winRoot)).toBe(true)
  })

  it('rejects unrelated processes and other checkouts even if they mention wrangler', () => {
    expect(isRepoToolCommandLine(`wrangler pages dev dist --port 3000`, root)).toBe(false)
    expect(isRepoToolCommandLine(`${join(makeRoot(), 'node_modules', 'wrangler', 'bin', 'wrangler.js')} pages dev`, root)).toBe(false)
    expect(isRepoToolCommandLine(join(root, 'code.exe'), root)).toBe(false)
    expect(isRepoToolCommandLine('', root)).toBe(false)
  })

  it('is not fooled by file names that merely contain a tool word (Phase-0 audit L-4)', () => {
    // `wrangler.jsonc` etc. must never look like a wrangler executable.
    expect(isRepoToolCommandLine(`node ${join(root, 'wrangler.jsonc')}`, root)).toBe(false)
    expect(isRepoToolCommandLine(`node ${join(root, 'my-wrangler-notes.txt')}`, root)).toBe(false)
    expect(isRepoToolCommandLine(`node ${join(root, 'miniflare-config.json')}`, root)).toBe(false)
    expect(isRepoToolCommandLine(`node ${join(root, 'scripts', 'wrangler-helper.mjs')}`, root)).toBe(false)
    // A word-boundary failure: a sibling checkout whose name CONTAINS this root.
    const sibling = root + '-backup'
    expect(isRepoToolCommandLine(`${join(sibling, 'node_modules', 'wrangler', 'bin', 'wrangler.js')} pages dev`, root)).toBe(false)
  })
})

describe('stopRepoToolProcesses', () => {
  it('kills only this repo\u2019s wrangler/workerd processes, never itself or unrelated ones', () => {
    const root = makeRoot()
    const workerd = join(root, 'node_modules', 'workerd', 'workerd.exe')
    const wrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
    const otherWrangler = join(makeRoot(), 'node_modules', 'wrangler', 'bin', 'wrangler.js')
    const list = () => [
      { pid: 1, ppid: 0, commandLine: `node ${join(root, 'scripts', 'reset-local-db.mjs')}` }, // self-like, not a tool name — skipped
      { pid: 2, ppid: 1, commandLine: `${workerd} serve` },
      { pid: 3, ppid: 0, commandLine: `${otherWrangler} pages dev` },
      { pid: 4, ppid: 0, commandLine: `${wrangler} pages dev` },
      { pid: 99, ppid: 0, commandLine: 'chrome.exe --type=renderer' }
    ]
    const killed: number[] = []
    const stopped = stopRepoToolProcesses(root, { list, kill: (pid: number) => killed.push(pid), selfPid: 1 })
    expect([...stopped].sort((a, b) => a - b)).toEqual([2, 4])
    expect([...killed].sort((a, b) => a - b)).toEqual([2, 4])
    expect(killed).not.toContain(1) // self
    expect(killed).not.toContain(3) // other checkout
    expect(killed).not.toContain(99) // unrelated app
  })
})

describe('removeTarget', () => {
  it('is idempotent when the target is already absent', () => {
    const root = makeRoot()
    expect(removeTarget(join(root, '.wrangler', 'state', 'v3', 'd1'))).toBe(true)
  })

  it('removes an existing target directory', () => {
    const root = makeRoot()
    const target = join(root, '.wrangler', 'state', 'v3', 'd1', 'D1DatabaseObject')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'metadata.sqlite'), 'x')
    expect(existsSync(join(root, '.wrangler'))).toBe(true)
    expect(removeTarget(join(root, '.wrangler', 'state', 'v3', 'd1'))).toBe(true)
    expect(existsSync(join(root, '.wrangler', 'state', 'v3', 'd1'))).toBe(false)
    // Never touches the home directory.
    expect(homedir()).toBeTruthy()
  })
})
