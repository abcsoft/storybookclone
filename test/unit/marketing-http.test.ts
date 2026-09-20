import { describe, expect, it, beforeEach } from 'vitest'
import { app, freshEnv, type TestEnv } from '../helpers/testApp'
import { CookieJar } from '../helpers/cookieJar'
import { seedStaff, staffJar } from '../helpers/adminFixtures'
import { resolveAdminPolicy } from '../../src/admin-console/policy'
import { acceptAllConsent, serializeConsent } from '../../src/marketing/index'

const FAKE_IDS = {
  MARKETING_TRACKING_ENABLED: '1',
  META_PIXEL_ID: '123456789012345',
  TIKTOK_PIXEL_ID: 'CFAKETIKTOKPIXEL1234',
  GA4_MEASUREMENT_ID: 'G-FAKE1234',
  GOOGLE_ADS_ID: 'AW-123456789',
  GOOGLE_ADS_PURCHASE_LABEL: 'AbCdEfGhIj'
}

async function get(path: string, env: TestEnv, headers: Record<string, string> = {}) {
  return app.request(path, { headers }, env as never)
}

describe('marketing HTTP — bootstrap is only emitted where it is allowed', () => {
  let env: TestEnv
  beforeEach(() => {
    env = freshEnv(FAKE_IDS)
  })

  it('is absent when tracking is disabled (the default)', async () => {
    const off = freshEnv()
    const html = await (await get('/', off)).text()
    expect(html).not.toContain('ww-marketing-config')
    // The preference panel still exists (hidden) and the footer link is present.
    expect(html).toContain('id="cookie-consent"')
    expect(html).toContain('id="cookie-preferences-open"')
  })

  it('is present, with PUBLIC ids only, on an allowed public page', async () => {
    const html = await (await get('/', env)).text()
    expect(html).toContain('ww-marketing-config')
    expect(html).toContain('123456789012345')
    expect(html).toContain('G-FAKE1234')
    // No secret is ever inlined (there are none by design, but assert the shape).
    expect(html).not.toMatch(/purchaseLabel[^}]*sk_/i)
  })

  it('the consent panel is visible until a decision exists, then hidden', async () => {
    const before = await (await get('/', env)).text()
    expect(before).toMatch(/class="cookie-consent" aria-labelledby/)
    expect(before).not.toMatch(/class="cookie-consent" hidden/)

    const consent = serializeConsent(acceptAllConsent())
    const after = await (await get('/', env, { Cookie: `ww_consent=${encodeURIComponent(consent)}` })).text()
    expect(after).toMatch(/class="cookie-consent" hidden/)
  })

  it('is absent on private/denied routes', async () => {
    for (const path of ['/my-books', '/api/v1/uploads/photo-policy']) {
      const res = await get(path, env)
      const body = await res.text()
      expect(body, path).not.toContain('ww-marketing-config')
    }
    const admin = await get('/admin', env)
    expect(admin.status).not.toBe(200)
  })

  it('is present on the cart and checkout pages (where the commerce events fire)', async () => {
    for (const path of ['/cart', '/checkout']) {
      const body = await (await get(path, env)).text()
      expect(body, path).toContain('ww-marketing-config')
    }
  })
})

describe('marketing HTTP — CSP reflects only the configured adapters', () => {
  it('no marketing ⇒ no vendor host anywhere in the CSP', async () => {
    const res = await get('/', freshEnv())
    const csp = res.headers.get('content-security-policy') || ''
    expect(csp).not.toContain('facebook')
    expect(csp).not.toContain('googletagmanager')
    expect(csp).not.toContain('tiktok')
  })

  it('full config ⇒ exact hosts, no wildcards', async () => {
    const res = await get('/', freshEnv(FAKE_IDS))
    const csp = res.headers.get('content-security-policy') || ''
    expect(csp).toContain('https://connect.facebook.net')
    expect(csp).toContain('https://analytics.tiktok.com')
    expect(csp).toContain('https://www.googletagmanager.com')
    expect(csp).not.toMatch(/\*\./)
  })
})

describe('marketing HTTP — the admin diagnostics screen', () => {
  it('has a policy entry', () => {
    const entry = resolveAdminPolicy('GET', '/admin/marketing')
    expect(entry?.permission).toBe('integrations.read')
  })

  it('is not reachable anonymously or by a customer, and never leaks a whole id', async () => {
    const env = freshEnv(FAKE_IDS)
    expect((await get('/admin/marketing', env)).status).not.toBe(200)

    const customer = new CookieJar()
    const reg = await app.request(
      '/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ name: 'Cust', email: `mkt-${Date.now()}@x.test`, password: 'password123' })
      },
      env as never
    )
    customer.observe(reg)
    expect((await get('/admin/marketing', env, { ...customer.headers() })).status).not.toBe(200)

    await seedStaff(env, { email: 'mkt-admin@example.test', role: 'super_admin' })
    const jar = await staffJar(env, 'mkt-admin@example.test')
    const res = await get('/admin/marketing', env, { ...jar.headers() })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Marketing &amp; analytics')
    expect(body).toContain('12…45') // masked
    expect(body).not.toContain('123456789012345') // never the whole id
    expect(body).toContain('Purchase tracking')
    // No way to inject a script from this screen.
    expect(body).not.toMatch(/<textarea/i)
  })
})
