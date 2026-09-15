// Phase 1 correction — M-2: `CF-Connecting-IP` must not be trusted
// unconditionally, or any non-Cloudflare caller (or the local dev server) can
// manufacture unlimited rate-limit identities by rotating the header.
//
// Required behaviour under test:
//   * rotating forged forwarding headers cannot create distinct buckets;
//   * a constant Cloudflare identity is honoured ONLY at the verified
//     production boundary;
//   * local dev and production-boundary behaviour are both covered for the
//     real limiter keys (login/register/contact/newsletter/upload/order).
import { describe, it, expect, beforeEach } from 'vitest'
import type { Context } from 'hono'
import { app, freshEnv, type TestEnv } from '../helpers/testApp'
import { clientIp, rateLimitKey, cloudflareBoundaryVerified, isIpLiteral, SHARED_RATE_LIMIT_BUCKET } from '../../src/security'

let env: TestEnv

beforeEach(() => {
  env = freshEnv()
})

/** Minimal Context stub — `clientIp`/`rateLimitKey` only touch `env` + `req.header`. */
function stub(headers: Record<string, string>, bindings: Record<string, string | undefined>): Context {
  return {
    env: bindings,
    req: { header: (name: string) => headers[name.toLowerCase()] }
  } as unknown as Context
}

const ALL_LIMITER_ACTIONS = ['login', 'register', 'admin-login', 'contact', 'newsletter', 'upload-initiate', 'upload-complete', 'user-book-create', 'order-create']

describe('M-2 clientIp only trusts a VERIFIED Cloudflare production boundary', () => {
  it('local development never trusts the header, even with TRUSTED_PROXY set', () => {
    expect(cloudflareBoundaryVerified({ ENVIRONMENT: 'development', TRUSTED_PROXY: 'cloudflare' })).toBe(false)
    const c = stub({ 'cf-connecting-ip': '203.0.113.9' }, { ENVIRONMENT: 'development', TRUSTED_PROXY: 'cloudflare' })
    expect(clientIp(c)).toBe(SHARED_RATE_LIMIT_BUCKET)
  })

  it('production WITHOUT the explicit opt-in never trusts the header', () => {
    expect(cloudflareBoundaryVerified({ ENVIRONMENT: 'production' })).toBe(false)
    const c = stub({ 'cf-connecting-ip': '203.0.113.9' }, { ENVIRONMENT: 'production' })
    expect(clientIp(c)).toBe(SHARED_RATE_LIMIT_BUCKET)
  })

  it('an unset/unknown environment fails closed (treated as production)', () => {
    const c = stub({ 'cf-connecting-ip': '203.0.113.9' }, {})
    expect(clientIp(c)).toBe(SHARED_RATE_LIMIT_BUCKET)
  })

  it('rotating forged CF-Connecting-IP headers cannot create distinct buckets', () => {
    const bindings = { ENVIRONMENT: 'development', TRUSTED_PROXY: 'cloudflare' }
    const keys = new Set<string>()
    for (let i = 0; i < 25; i++) keys.add(rateLimitKey('login', stub({ 'cf-connecting-ip': `198.51.100.${i}` }, bindings)))
    expect(keys.size).toBe(1)
    // The same is true for every limiter key the app actually uses.
    for (const action of ALL_LIMITER_ACTIONS) {
      const distinct = new Set(
        ['10.0.0.1', '10.0.0.2', '10.0.0.3'].map((ip) => rateLimitKey(action, stub({ 'cf-connecting-ip': ip }, bindings), 'user@example.com'))
      )
      expect(distinct.size, action).toBe(1)
    }
  })

  it('rotating X-Forwarded-For / X-Real-IP is never trusted, even at the boundary', () => {
    const bindings = { ENVIRONMENT: 'production', TRUSTED_PROXY: 'cloudflare' }
    const distinct = new Set(
      ['10.0.0.1', '10.0.0.2', '10.0.0.3'].map((ip) =>
        rateLimitKey('login', stub({ 'x-forwarded-for': ip, 'x-real-ip': ip }, bindings), 'user@example.com')
      )
    )
    expect(distinct.size).toBe(1)
    expect(clientIp(stub({ 'x-forwarded-for': '10.0.0.1' }, bindings))).toBe(SHARED_RATE_LIMIT_BUCKET)
  })

  it('a malformed CF-Connecting-IP at the boundary falls back to the shared bucket', () => {
    const bindings = { ENVIRONMENT: 'production', TRUSTED_PROXY: 'cloudflare' }
    for (const junk of ['not-an-ip', '999.999.999.999', '1.2.3', '01.2.3.4', '1.2.3.4:80', '', 'evil.example.com']) {
      expect(clientIp(stub({ 'cf-connecting-ip': junk }, bindings)), junk).toBe(SHARED_RATE_LIMIT_BUCKET)
    }
    expect(isIpLiteral('203.0.113.9')).toBe(true)
    expect(isIpLiteral('2001:db8::1')).toBe(true)
    expect(isIpLiteral('2001:db8:::1')).toBe(false)
    expect(isIpLiteral('203.0.113.256')).toBe(false)
  })

  it('a constant Cloudflare identity is honoured at the verified boundary', () => {
    const bindings = { ENVIRONMENT: 'production', TRUSTED_PROXY: 'cloudflare' }
    expect(cloudflareBoundaryVerified(bindings)).toBe(true)
    const a = rateLimitKey('login', stub({ 'cf-connecting-ip': '203.0.113.9' }, bindings), 'user@example.com')
    const b = rateLimitKey('login', stub({ 'cf-connecting-ip': '203.0.113.9' }, bindings), 'user@example.com')
    const other = rateLimitKey('login', stub({ 'cf-connecting-ip': '203.0.113.10' }, bindings), 'user@example.com')
    expect(a).toBe(b)
    expect(a).not.toBe(other)
  })
})

describe('M-2 route-level limiter behaviour', () => {
  async function newsletter(ip: string, e: TestEnv = env): Promise<Response> {
    return app.request(
      '/api/newsletter',
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify({ email: 'm2@example.com' }) },
      e
    )
  }

  it('local dev: rotating forged IP headers all share ONE bucket and get limited', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) statuses.push((await newsletter(`198.51.100.${i}`)).status)
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200])
    expect(statuses[5]).toBe(429)
  })

  it('non-Cloudflare production (no opt-in): rotating forged headers still share ONE bucket', async () => {
    const prod = freshEnv({ ENVIRONMENT: 'production' })
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) statuses.push((await newsletter(`198.51.100.${i}`, prod)).status)
    expect(statuses[5]).toBe(429)
  })

  it('verified Cloudflare boundary: distinct real IPs are distinct identities; a repeated IP is limited', async () => {
    const prod = freshEnv({ ENVIRONMENT: 'production', TRUSTED_PROXY: 'cloudflare' })
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) statuses.push((await newsletter(`198.51.100.${i}`, prod)).status)
    expect(statuses).toEqual([200, 200, 200, 200, 200])

    const repeated: number[] = []
    for (let i = 0; i < 6; i++) repeated.push((await newsletter('203.0.113.77', prod)).status)
    expect(repeated).toContain(429)
  })

  it('login is limited on one shared bucket in dev despite rotating forged headers', async () => {
    let blocked = false
    for (let i = 0; i < 15; i++) {
      const res = await app.request(
        '/login',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': `198.51.100.${i}` },
          body: new URLSearchParams({ email: 'm2-login@example.com', password: 'wrong-password' })
        },
        env
      )
      if ((await res.text()).includes('Too many attempts')) {
        blocked = true
        break
      }
    }
    expect(blocked).toBe(true)
  })
})
