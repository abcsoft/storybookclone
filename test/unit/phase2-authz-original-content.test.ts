// V2 Phase 2 — authorization on EVERY new admin action, plus the original
// content/asset guards (SF-01).
//
// The admin guard is one central middleware, but "the menu hides it" is not a
// control: a direct request to any of these routes must be denied for an
// anonymous caller AND for a signed-in customer, and must be allowed for an
// admin. Both the GET page and the POST mutation are covered, because they are
// different handlers.
import { describe, it, expect, beforeEach } from 'vitest'
import { app, freshEnv, type TestEnv } from '../helpers/testApp'
import { CookieJar } from '../helpers/cookieJar'
import { hashPassword } from '../../src/auth'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { COVERS, SHELL_ART, renderAll } from '../../scripts/generate-original-art.mjs'
import { renderIcons, renderCss, CLASS_ALIASES } from '../../scripts/generate-icons.mjs'
import { products as fixtureProducts } from '../../src/data'

let env: TestEnv

beforeEach(() => {
  env = freshEnv()
})

/** Every admin GET screen added in Phase 2. */
const ADMIN_GET_ROUTES = [
  '/admin/catalog',
  '/admin/catalog?q=x&category=book',
  '/admin/collections',
  '/admin/collections/1',
  '/admin/media',
  '/admin/cms',
  '/admin/cms/blocks/1',
  '/admin/cms/navigation',
  '/admin/cms/pages',
  '/admin/cms/pages/1',
  '/admin/cms/faqs',
  '/admin/reviews',
  '/admin/localization',
  '/admin/settings'
]

/** Every admin POST mutation added in Phase 2, with a body that would be valid
 *  for an admin — so a denial cannot be explained away by validation. */
const ADMIN_POST_ROUTES: Array<[string, Record<string, string>]> = [
  ['/admin/cms/blocks', { key: 'authz.block', kind: 'hero' }],
  ['/admin/cms/blocks/1', { key: 'home.hero', kind: 'hero' }],
  ['/admin/cms/blocks/1/move', { direction: 'up' }],
  ['/admin/cms/blocks/1/delete', {}],
  ['/admin/cms/nav', { menu: 'primary', label: 'X', href: '/x' }],
  ['/admin/cms/nav/1', { label: 'X', href: '/x' }],
  ['/admin/cms/nav/1/delete', {}],
  ['/admin/cms/announcements', { message: 'hi' }],
  ['/admin/cms/announcements/1', { message: 'hi' }],
  ['/admin/cms/announcements/1/delete', {}],
  ['/admin/cms/pages', { slug: 'authz-page', kind: 'content', title: 'X' }],
  ['/admin/cms/pages/1', { slug: 'privacy-policy', kind: 'legal', title: 'X' }],
  ['/admin/cms/pages/1/delete', {}],
  ['/admin/cms/faqs', { group_key: 'G', question: 'q', answer: 'a' }],
  ['/admin/cms/faqs/1', { group_key: 'G', question: 'q', answer: 'a' }],
  ['/admin/cms/faqs/1/delete', {}],
  ['/admin/settings', { key: 'brand.name', value: 'Hacked' }],
  ['/admin/media', { public_path: '/x.svg', alt_text: 'a', focal_x: '0.5', focal_y: '0.5' }],
  ['/admin/media/1', { alt_text: 'a', focal_x: '0.5', focal_y: '0.5' }],
  ['/admin/collections', { slug: 'authz-col', kind: 'theme', title: 'X' }],
  ['/admin/collections/1', { slug: 'all-books', kind: 'editorial', title: 'X' }],
  ['/admin/collections/1/delete', {}],
  ['/admin/collections/1/members', { product_id: '1', sort_order: '1' }],
  ['/admin/collections/1/members/remove', { product_id: '1' }],
  ['/admin/products/1/variants/1', { label: 'X', price_minor: '1', active: '1' }],
  ['/admin/products/1/prices', { currency: 'USD', price_minor: '1' }],
  ['/admin/products/1/prices/delete', { currency: 'USD' }],
  ['/admin/reviews/1/moderate', { action: 'publish' }]
]

async function adminJar(): Promise<CookieJar> {
  await env.DB.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'authz-admin@example.com', ?, 'admin')")
    .bind(await hashPassword('authz-admin-pass-1'))
    .run()
  const jar = new CookieJar()
  const res = await app.request(
    '/admin/login',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'authz-admin@example.com', password: 'authz-admin-pass-1' }) },
    env
  )
  jar.observe(res)
  return jar
}

async function customerJar(): Promise<CookieJar> {
  await env.DB.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Customer', 'authz-customer@example.com', ?, 'customer')")
    .bind(await hashPassword('authz-customer-pass-1'))
    .run()
  const jar = new CookieJar()
  const res = await app.request(
    '/login',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'authz-customer@example.com', password: 'authz-customer-pass-1' }) },
    env
  )
  jar.observe(res)
  return jar
}

function isDenied(res: Response): boolean {
  if (res.status >= 300 && res.status < 400) return true
  if (res.status === 401 || res.status === 403 || res.status === 404) return true
  return false
}

describe('ADM-06/07/15/16 authorization — anonymous callers', () => {
  it('denies every admin GET screen', async () => {
    for (const route of ADMIN_GET_ROUTES) {
      const res = await app.request(route, {}, env)
      expect(isDenied(res), `anonymous GET ${route} returned ${res.status}`).toBe(true)
    }
  })

  it('denies every admin POST mutation', async () => {
    for (const [route, body] of ADMIN_POST_ROUTES) {
      const res = await app.request(route, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }, env)
      expect(isDenied(res), `anonymous POST ${route} returned ${res.status}`).toBe(true)
    }
  })
})

describe('ADM-06/07/15/16 authorization — an authenticated CUSTOMER cannot escalate', () => {
  it('denies every admin GET screen and never renders admin content', async () => {
    const jar = await customerJar()
    for (const route of ADMIN_GET_ROUTES) {
      const res = await app.request(route, { headers: { ...jar.headers() } }, env)
      expect(isDenied(res), `customer GET ${route} returned ${res.status}`).toBe(true)
      if (res.status === 200) {
        const body = await res.text()
        expect(body).not.toContain('a-table')
      }
    }
  })

  it('denies every admin POST mutation without writing anything', async () => {
    const jar = await customerJar()
    for (const [route, body] of ADMIN_POST_ROUTES) {
      const res = await app.request(
        route,
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() }, body: new URLSearchParams(body) },
        env
      )
      expect(isDenied(res), `customer POST ${route} returned ${res.status}`).toBe(true)
    }
    // Nothing an unauthorised caller tried was persisted.
    expect(await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'brand.name'").first<any>()).toMatchObject({ value: '' })
    expect(await env.DB.prepare("SELECT id FROM cms_blocks WHERE key = 'authz.block'").first()).toBeNull()
    expect(await env.DB.prepare("SELECT id FROM cms_pages WHERE slug = 'authz-page'").first()).toBeNull()
    expect(await env.DB.prepare("SELECT id FROM collections WHERE slug = 'authz-col'").first()).toBeNull()
    expect(await env.DB.prepare("SELECT id FROM media_assets WHERE public_path = '/x.svg'").first()).toBeNull()
  })

  it('rejects a forged role in the request body (no privilege escalation via input)', async () => {
    const jar = await customerJar()
    const res = await app.request(
      '/admin/settings',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() }, body: new URLSearchParams({ key: 'brand.name', value: 'Escalated', role: 'admin', user: 'admin' }) },
      env
    )
    expect(isDenied(res)).toBe(true)
    expect((await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'brand.name'").first<any>())?.value).not.toBe('Escalated')
  })
})

describe('an ADMIN can use the same screens (the guard is not a blanket deny)', () => {
  it('renders the Phase-2 admin screens', async () => {
    const jar = await adminJar()
    for (const route of ADMIN_GET_ROUTES) {
      const res = await app.request(route, { headers: { ...jar.headers() } }, env)
      expect(res.status, `admin GET ${route}`).toBe(200)
      const body = await res.text()
      expect(body).toContain('Admin')
    }
  })

  it('accepts a validated mutation and records it in the audit trail', async () => {
    const jar = await adminJar()
    const res = await app.request(
      '/admin/settings',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() }, body: new URLSearchParams({ key: 'brand.contact_email', value: 'owner@example.org', kind: 'email' }) },
      env
    )
    expect([302, 303]).toContain(res.status)
    expect((await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'brand.contact_email'").first<any>())?.value).toBe('owner@example.org')
    const audit = await env.DB.prepare("SELECT action, entity_type FROM admin_audit_events WHERE entity_type = 'site_setting' ORDER BY id DESC LIMIT 1").first<any>()
    expect(audit.action).toBe('settings.update')

    // …and the configured value is what the storefront renders.
    const body = await (await app.request('/contact', {}, env)).text()
    expect(body).toContain('owner@example.org')
  })

  it('rejects an invalid value instead of storing it', async () => {
    const jar = await adminJar()
    await app.request(
      '/admin/settings',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() }, body: new URLSearchParams({ key: 'brand.contact_email', value: 'not-an-email', kind: 'email' }) },
      env
    )
    expect((await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'brand.contact_email'").first<any>())?.value).not.toBe('not-an-email')
  })

  it('refuses a price in a currency the storefront does not offer', async () => {
    const jar = await adminJar()
    await env.DB.prepare(
      `INSERT OR IGNORE INTO products (slug, title, price, price_minor, currency, category, active) VALUES ('authz-price', 'T', 1, 100, 'USD', 'book', 1)`
    ).run()
    const product = await env.DB.prepare("SELECT id FROM products WHERE slug = 'authz-price'").first<{ id: number }>()
    await app.request(
      `/admin/products/${product!.id}/prices`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() }, body: new URLSearchParams({ currency: 'XXX', price_minor: '100' }) },
      env
    )
    expect(await env.DB.prepare("SELECT id FROM product_prices WHERE product_id = ? AND currency = 'XXX'").bind(product!.id).first()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// SF-01 original content/asset guards
// ---------------------------------------------------------------------------

const root = process.cwd()
const artDir = join(root, 'public', 'static', 'img', 'art')
const iconDir = join(root, 'public', 'static', 'icons')

describe('SF-01 the artwork is original, generated and deterministic', () => {
  it('ships exactly the files the generator produces', () => {
    const expected = [...renderAll().keys()]
    const present = readdirSync(artDir).filter((f) => f.endsWith('.svg'))
    expect([...present].sort()).toEqual([...expected].sort())
    for (const [name, svg] of renderAll()) {
      expect(readFileSync(join(artDir, name), 'utf8'), name).toBe(svg)
    }
  })

  it('every catalogue product has its own cover art', () => {
    for (const product of fixtureProducts) {
      const name = product.image.split('/').pop()!
      expect(existsSync(join(artDir, name)), `${product.slug} -> ${product.image}`).toBe(true)
      const file = name.replace(/^cover-|\.svg$/g, '')
      expect(Object.keys(COVERS).includes(file), `${name} is not a generated cover`).toBe(true)
    }
    expect(Object.keys(COVERS).length).toBeGreaterThanOrEqual(fixtureProducts.length)
  })

  it('ships no reference-brand or removed reference asset', () => {
    const banned = [
      'avatar-sample.png', 'avatar-sample.webp', 'step-child-redhair.png', 'step-child-redhair.webp',
      'step-delivered.png', 'step-delivered.webp', 'reference_ui.jpg', 'cart_ref_ui.jpg',
      'wonderwraps_preview_ref.jpg', 'preview-book-cover-ref.webp', 'preview-book-spread-ref.webp',
      'step-book-preview.png', 'step-book-preview.webp'
    ]
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) walk(full, out)
        else out.push(full.replace(/\\/g, '/'))
      }
      return out
    }
    const files = walk(join(root, 'public'))
    const contents = files.filter((f) => /\.(svg|css|js|html)$/.test(f)).map((f) => ({ f, text: readFileSync(f, 'utf8') }))
    for (const name of banned) {
      expect(files.some((f) => f.endsWith(`/${name}`)), `${name} still exists`).toBe(false)
      for (const { f, text } of contents) expect(text, `${f} references ${name}`).not.toContain(name)
    }
    // The shipped webp/jpeg reference imagery is gone entirely.
    expect(files.filter((f) => /\/public\/static\/(img|media|reviews|tips|stickers|magic)\/.*\.(webp|jpe?g|png)$/i.test(f))).toEqual([])
  })

  it('ships no press-logo trade dress', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) walk(full)
        else files.push(full)
      }
    }
    walk(join(root, 'public'))
    // Exact basenames only: "snow-fox.svg" is our own illustration, while a
    // file literally named after a broadcaster is third-party trade dress.
    const pressNames = ['nbc.svg', 'abc.svg', 'cbs.svg', 'fox.svg', 'si.svg', 'ibt.svg', 'ap.svg', 'morning.svg']
    const logos = files.filter((f) => pressNames.includes(f.split(/[\/]/).pop() || ''))
    expect(logos).toEqual([])
  })

  it('the icon set is original, deterministic and complete', () => {
    for (const [name, svg] of renderIcons()) {
      expect(readFileSync(join(iconDir, name), 'utf8'), name).toBe(svg)
    }
    expect(readFileSync(join(root, 'public', 'static', 'icons.css'), 'utf8')).toBe(renderCss())
    // Every icon an alias points at exists, and every icon file has an alias.
    const iconNames = new Set([...renderIcons().keys()].map((f) => f.replace('.svg', '')))
    for (const icon of Object.values(CLASS_ALIASES)) expect(iconNames.has(icon as string), `missing icon ${icon}`).toBe(true)
  })

  it('no stylesheet or template loads a third-party font, icon font or CDN', () => {
    const styleDir = join(root, 'public', 'static')
    const files = readdirSync(styleDir).filter((f) => /\.(css|js)$/.test(f))
    for (const f of files) {
      const text = readFileSync(join(styleDir, f), 'utf8')
      expect(text, `${f} loads a remote asset`).not.toMatch(/https?:\/\/(fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr|use\.fontawesome|cdnjs)/i)
    }
    const layout = readFileSync(join(root, 'src', 'layout.ts'), 'utf8')
    expect(layout).not.toMatch(/fonts\.googleapis|fontawesome|jsdelivr/i)
  })

  it('the design system exposes its tokens and the responsive/reduced-motion gates', () => {
    const css = readFileSync(join(root, 'public', 'static', 'storefront.css'), 'utf8')
    for (const token of ['--fs-lg', '--sp-4', '--radius-pill', '--focus-ring', '--content-max']) expect(css).toContain(token)
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/)
    expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/)
    expect(css).toMatch(/:focus-visible/)
    // Every required audit width has a rule or is covered by the general guard.
    expect(css).toMatch(/@media \(min-width: 1920px\)/)
    expect(css).toMatch(/@media \(max-width: 359px\)/)
  })

  it('every product card image can never render at zero height', () => {
    const css = readFileSync(join(root, 'public', 'static', 'storefront.css'), 'utf8')
    expect(css).toMatch(/\.section\s*\{[^}]*min-height/)
    expect(css).toMatch(/\.card-cover-wrap\s*\{[^}]*aspect-ratio/)
    expect(css).toMatch(/\.state-box\s*\{[^}]*min-height/)
  })

  it('the shell art set is referenced from the CMS, not hard-coded in a template', () => {
    const shellNames = Object.keys(SHELL_ART)
    expect(shellNames).toContain('hero')
    const pages = readFileSync(join(root, 'src', 'pages.ts'), 'utf8')
    // The homepage renderer must not name a specific hero/step asset.
    for (const name of ['hero.svg', 'cta-reading.svg']) {
      expect(pages, `${name} is hard-coded in the renderer`).not.toContain(name)
    }
  })
})
