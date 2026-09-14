// Regression coverage for the Phase-0 audit L-2 corrections
// (scripts/audit-frontend.mjs):
//   * an isolated free port is chosen instead of a fixed one;
//   * the StorybookClone `photo-policy` fingerprint (+ storefront marker) is
//     verified BEFORE any audit work;
//   * a foreign app is rejected (never audited as if it were this repo);
//   * findings produce a non-zero exit code.
import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import {
  checkPolicyFingerprint,
  verifyServerFingerprint,
  exitCodeForFindings,
  findFreePort,
  isPortFree,
  isMainModule,
  FINGERPRINT_PATH,
  STOREFRONT_MARKER
} from '../../scripts/audit-frontend.mjs'

const VALID_POLICY = { allowedFormats: ['jpeg', 'png'], minDimensionPx: 800, maxDimensionPx: 4000, maxMB: 10 }

let servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))))
  servers = []
})

/** Start a throwaway HTTP server; `handler` decides every response. */
function startServer(handler: (url: string) => { status: number; body: string; type?: string }) {
  return new Promise<number>((resolve) => {
    const server = createServer((req, res) => {
      const out = handler(req.url || '/')
      res.writeHead(out.status, { 'content-type': out.type || 'application/json' })
      res.end(out.body)
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port))
  })
}

/** A server that behaves exactly like this repo's app for fingerprinting. */
function startFingerprintServer(policy = VALID_POLICY, home = `<html><script src="${STOREFRONT_MARKER}"></script></html>`) {
  return startServer((url) => {
    if (url.startsWith(FINGERPRINT_PATH)) return { status: 200, body: JSON.stringify(policy) }
    return { status: 200, body: home, type: 'text/html' }
  })
}

describe('checkPolicyFingerprint (pure schema check)', () => {
  it('accepts the repo contract shape', () => {
    expect(checkPolicyFingerprint(VALID_POLICY).ok).toBe(true)
  })

  it('rejects a policy that advertises webp (which this repo deliberately rejects)', () => {
    const res = checkPolicyFingerprint({ ...VALID_POLICY, allowedFormats: ['jpeg', 'png', 'webp'] })
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/webp/i)
  })

  it('rejects missing formats, non-arrays and non-numeric bounds', () => {
    expect(checkPolicyFingerprint(null).ok).toBe(false)
    expect(checkPolicyFingerprint({ ...VALID_POLICY, allowedFormats: 'jpeg' }).ok).toBe(false)
    expect(checkPolicyFingerprint({ ...VALID_POLICY, allowedFormats: ['jpeg'] }).ok).toBe(false)
    expect(checkPolicyFingerprint({ ...VALID_POLICY, maxMB: '10' }).ok).toBe(false)
    expect(checkPolicyFingerprint({ ...VALID_POLICY, minDimensionPx: NaN }).ok).toBe(false)
  })
})

describe('verifyServerFingerprint (positive)', () => {
  it('accepts the repo app (valid policy + storefront marker)', async () => {
    const port = await startFingerprintServer()
    const res = await verifyServerFingerprint(port)
    expect(res.ok).toBe(true)
  })
})

describe('verifyServerFingerprint (negative — foreign apps are rejected)', () => {
  it('rejects a server whose fingerprint endpoint 404s', async () => {
    const port = await startServer(() => ({ status: 404, body: 'not found', type: 'text/plain' }))
    const res = await verifyServerFingerprint(port)
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/404/)
  })

  it('rejects a server returning non-JSON', async () => {
    const port = await startServer((url) =>
      url.startsWith(FINGERPRINT_PATH) ? { status: 200, body: '<html>hello</html>', type: 'text/html' } : { status: 200, body: '<html></html>', type: 'text/html' }
    )
    const res = await verifyServerFingerprint(port)
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/JSON/)
  })

  it('rejects a generic app that accepts webp', async () => {
    const port = await startFingerprintServer({ ...VALID_POLICY, allowedFormats: ['jpeg', 'png', 'webp'] })
    const res = await verifyServerFingerprint(port)
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/webp/i)
  })

  it('rejects a compatible policy when the storefront marker is absent', async () => {
    const port = await startFingerprintServer(VALID_POLICY, '<html><body>some other app</body></html>')
    const res = await verifyServerFingerprint(port)
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/foreign app|marker/i)
  })

  it('rejects when nothing is listening', async () => {
    const port = await findFreePort(9400, 1)
    const res = await verifyServerFingerprint(port)
    expect(res.ok).toBe(false)
  })
})

describe('port isolation', () => {
  it('findFreePort skips a busy port', async () => {
    const busy = await startFingerprintServer()
    // The busy port is taken, so a 1-attempt search starting there must fail.
    await expect(findFreePort(busy, 1)).rejects.toThrow()
    // With a wider window it moves on and returns something usable.
    const free = await findFreePort(busy, 50)
    expect(await isPortFree(free)).toBe(true)
  })
})

describe('exit-code contract', () => {
  it('is zero for no findings and non-zero for any finding', () => {
    expect(exitCodeForFindings([])).toBe(0)
    expect(exitCodeForFindings([{ path: '/', viewport: 'desktop', issue: 'boom' }])).toBe(1)
    expect(exitCodeForFindings(undefined as any)).toBe(0)
  })
})

describe('import safety', () => {
  it('does not run main() when imported (isMainModule is false under vitest)', () => {
    expect(isMainModule()).toBe(false)
  })
})
