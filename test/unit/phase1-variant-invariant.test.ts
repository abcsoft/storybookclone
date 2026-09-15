// Phase 1 correction — L-C: an ACTIVE purchasable product must have EXACTLY
// ONE ACTIVE default variant.
//
// The database keeps the "at most one default row" half (0016's partial unique
// index). The "exactly one active default for an active product" half is
// enforced by src/product-variants.ts: product creation writes the product and
// its default variant in ONE atomic batch, activation is gated, and removing
// the only default requires naming a replacement or deactivating the product.
// No price difference between cover/format options is invented anywhere.
import { describe, it, expect, beforeEach } from 'vitest'
import { app, freshEnv, type TestEnv } from '../helpers/testApp'
import { CookieJar } from '../helpers/cookieJar'
import { hashPassword } from '../../src/auth'
import { createProduct, updateProduct, setDefaultVariant, deactivateVariant, deleteVariant, checkPurchasableVariantInvariant } from '../../src/product-variants'

let env: TestEnv

beforeEach(() => {
  env = freshEnv()
})

async function variantRows(productId: number) {
  return (await env.DB.prepare('SELECT id, code, is_default, active, price_minor FROM product_variants WHERE product_id = ? ORDER BY sort_order, id').bind(productId).all<any>()).results || []
}

describe('L-C product creation creates the default variant atomically', () => {
  it('creates an active product WITH exactly one active default variant, priced from the supplied price', async () => {
    const res = await createProduct(env.DB, { slug: 'lc-book', title: 'LC Book', priceMinor: 3499, category: 'book', active: true })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const variants = await variantRows(res.productId)
    expect(variants).toHaveLength(1)
    expect(variants[0]).toMatchObject({ code: 'hardcover', is_default: 1, active: 1, price_minor: 3499 })
    expect(await checkPurchasableVariantInvariant(env.DB, res.productId)).toEqual({ ok: true })
    // No invented cover/format price difference: the default is priced at the
    // product's own price, and only one option exists.
    const product = await env.DB.prepare('SELECT price_minor, currency FROM products WHERE id = ?').bind(res.productId).first<any>()
    expect(product.price_minor).toBe(3499)
    expect(product.currency).toBe('USD')
  })

  it('uses the sticker default for a sticker and never invents a second option', async () => {
    const res = await createProduct(env.DB, { slug: 'lc-sticker', title: 'LC Sticker', priceMinor: 1499, category: 'sticker', active: true })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect((await variantRows(res.productId)).map((v) => v.code)).toEqual(['standard'])
  })

  it('is atomic: a failing product insert leaves NEITHER row behind', async () => {
    await env.DB.prepare(`INSERT INTO products (slug, title, price, price_minor, image, category, age_min, age_max, active) VALUES ('dup-slug','Dup',1,100,'','book',4,8,1)`).run()
    const before = (await env.DB.prepare('SELECT COUNT(*) AS n FROM product_variants').first<{ n: number }>())!.n
    const res = await createProduct(env.DB, { slug: 'dup-slug', title: 'Dup', priceMinor: 500, category: 'book', active: true })
    expect(res.ok).toBe(false)
    const dupProduct = await env.DB.prepare("SELECT id FROM products WHERE slug = 'dup-slug'").first<{ id: number }>()
    expect(await variantRows(dupProduct!.id)).toHaveLength(0) // no orphan variant
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM product_variants').first<{ n: number }>())!.n).toBe(before)
  })

  it('rejects invalid money instead of letting the database trigger abort the batch', async () => {
    expect(await createProduct(env.DB, { slug: 'neg', title: 'N', priceMinor: -1, category: 'book' })).toMatchObject({ ok: false })
    expect(await createProduct(env.DB, { slug: 'nan', title: 'N', priceMinor: Number.NaN, category: 'book' })).toMatchObject({ ok: false })
    expect(await createProduct(env.DB, { slug: 'frac', title: 'N', priceMinor: 10.5, category: 'book' })).toMatchObject({ ok: false })
    expect(await env.DB.prepare("SELECT id FROM products WHERE slug IN ('neg','nan','frac')").first()).toBeNull()
  })
})

describe('L-C the invariant is enforced on activation and variant removal', () => {
  it('rejects an ACTIVE product with ZERO active defaults', async () => {
    const created = await createProduct(env.DB, { slug: 'lc-zero', title: 'Z', priceMinor: 1000, category: 'book', active: true })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    await env.DB.prepare('UPDATE product_variants SET active = 0 WHERE product_id = ?').bind(created.productId).run()
    const check = await checkPurchasableVariantInvariant(env.DB, created.productId)
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.error).toMatch(/exactly one active default variant/i)
  })

  it('rejects a duplicate default variant at the database level (at most one default row)', async () => {
    const created = await createProduct(env.DB, { slug: 'lc-dup', title: 'D', priceMinor: 1000, category: 'book', active: true })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    await expect(
      env.DB.prepare(`INSERT INTO product_variants (product_id, code, label, price_minor, currency, is_default, active, sort_order) VALUES (?, 'softcover', 'Softcover', 1000, 'USD', 1, 1, 1)`)
        .bind(created.productId)
        .run()
    ).rejects.toThrow(/UNIQUE|unique/)
    expect((await variantRows(created.productId)).filter((v) => v.is_default === 1)).toHaveLength(1)
  })

  it('refuses to ACTIVATE a product whose invariant is unmet, and does not change it', async () => {
    const created = await createProduct(env.DB, { slug: 'lc-inactive', title: 'I', priceMinor: 1000, category: 'book', active: false })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    await env.DB.prepare('UPDATE product_variants SET active = 0 WHERE product_id = ?').bind(created.productId).run()

    const res = await updateProduct(env.DB, { id: created.productId, slug: '', title: 'I', priceMinor: 1000, category: 'book', active: true })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/exactly one active default variant/i)
    const product = await env.DB.prepare('SELECT active FROM products WHERE id = ?').bind(created.productId).first<{ active: number }>()
    expect(product!.active).toBe(0)
  })

  it('allows activation once a valid default exists', async () => {
    const created = await createProduct(env.DB, { slug: 'lc-activate', title: 'A', priceMinor: 1000, category: 'book', active: false })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const res = await updateProduct(env.DB, { id: created.productId, slug: '', title: 'A', priceMinor: 1000, category: 'book', active: true })
    expect(res.ok).toBe(true)
    const product = await env.DB.prepare('SELECT active FROM products WHERE id = ?').bind(created.productId).first<{ active: number }>()
    expect(product!.active).toBe(1)
  })

  it('refuses to deactivate OR delete the only active default without a replacement', async () => {
    const created = await createProduct(env.DB, { slug: 'lc-only', title: 'O', priceMinor: 1000, category: 'book', active: true })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const only = (await variantRows(created.productId))[0]

    const deactivate = await deactivateVariant(env.DB, created.productId, only.id, null)
    expect(deactivate.ok).toBe(false)
    if (!deactivate.ok) expect(deactivate.error).toMatch(/only active default variant/i)
    const del = await deleteVariant(env.DB, created.productId, only.id, null)
    expect(del.ok).toBe(false)

    // The variant is untouched.
    expect(await variantRows(created.productId)).toHaveLength(1)
  })

  it('allows the removal once a replacement active variant is named', async () => {
    const created = await createProduct(env.DB, { slug: 'lc-replace', title: 'R', priceMinor: 1000, category: 'book', active: true })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    await env.DB.prepare(`INSERT INTO product_variants (product_id, code, label, price_minor, currency, is_default, active, sort_order) VALUES (?, 'softcover', 'Softcover', 1000, 'USD', 0, 1, 1)`)
      .bind(created.productId)
      .run()
    const rows = await variantRows(created.productId)
    const only = rows.find((v) => v.is_default === 1)!
    const replacement = rows.find((v) => v.is_default === 0)!

    const res = await deactivateVariant(env.DB, created.productId, only.id, replacement.id)
    expect(res.ok).toBe(true)
    const after = await variantRows(created.productId)
    expect(after.find((v) => v.id === only.id)).toMatchObject({ active: 0, is_default: 0 })
    expect(after.find((v) => v.id === replacement.id)).toMatchObject({ active: 1, is_default: 1 })
    expect(after.filter((v) => v.is_default === 1 && v.active === 1)).toHaveLength(1)
  })

  it('allows removing the only default when the PRODUCT is deactivated (the documented escape hatch)', async () => {
    const created = await createProduct(env.DB, { slug: 'lc-escape', title: 'E', priceMinor: 1000, category: 'book', active: true })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const only = (await variantRows(created.productId))[0]
    // Deactivate the product first, then the variant may be removed.
    await updateProduct(env.DB, { id: created.productId, slug: '', title: 'E', priceMinor: 1000, category: 'book', active: false })
    expect((await deleteVariant(env.DB, created.productId, only.id, null)).ok).toBe(true)
    expect(await variantRows(created.productId)).toHaveLength(0)
  })

  it('rejects a replacement that is not an active variant of the same product', async () => {
    const a = await createProduct(env.DB, { slug: 'lc-a', title: 'A', priceMinor: 1000, category: 'book', active: true })
    const b = await createProduct(env.DB, { slug: 'lc-b', title: 'B', priceMinor: 1000, category: 'book', active: true })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    const onlyA = (await variantRows(a.productId))[0]
    const foreign = (await variantRows(b.productId))[0]
    expect(await deactivateVariant(env.DB, a.productId, onlyA.id, foreign.id)).toMatchObject({ ok: false })
    await env.DB.prepare('UPDATE product_variants SET active = 0 WHERE id = ?').bind(foreign.id).run()
    expect(await deactivateVariant(env.DB, a.productId, onlyA.id, foreign.id)).toMatchObject({ ok: false })
  })

  it('setDefaultVariant moves the default atomically (never two defaults)', async () => {
    const created = await createProduct(env.DB, { slug: 'lc-move', title: 'M', priceMinor: 1000, category: 'book', active: true })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    await env.DB.prepare(`INSERT INTO product_variants (product_id, code, label, price_minor, currency, is_default, active, sort_order) VALUES (?, 'softcover', 'Softcover', 1000, 'USD', 0, 1, 1)`)
      .bind(created.productId)
      .run()
    const rows = await variantRows(created.productId)
    const res = await setDefaultVariant(env.DB, created.productId, rows[1].id)
    expect(res.ok).toBe(true)
    const after = await variantRows(created.productId)
    expect(after.find((v) => v.id === rows[1].id)!.is_default).toBe(1)
    expect(after.find((v) => v.id === rows[0].id)!.is_default).toBe(0)
    expect(after.filter((v) => v.is_default === 1)).toHaveLength(1)
  })
})

describe('L-C the admin product route uses the service', () => {
  async function adminJar(): Promise<CookieJar> {
    await env.DB.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'lc-admin@example.com', ?, 'admin')")
      .bind(await hashPassword('lc-admin-pass-1'))
      .run()
    const jar = new CookieJar()
    const login = await app.request(
      '/admin/login',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'lc-admin@example.com', password: 'lc-admin-pass-1' }) },
      env
    )
    jar.observe(login)
    expect(jar.get('ww_session')).toBeTruthy()
    return jar
  }

  it('creating a product through the admin form also creates its default variant', async () => {
    const jar = await adminJar()
    const res = await app.request(
      '/admin/products/new',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() },
        body: new URLSearchParams({ slug: 'lc-form', title: 'LC Form', price: '34.99', category: 'book', active: '1' })
      },
      env
    )
    expect(res.status).toBe(302)
    const product = await env.DB.prepare("SELECT id, price_minor, active FROM products WHERE slug = 'lc-form'").first<any>()
    expect(product).toBeTruthy()
    expect(product.price_minor).toBe(3499)
    const variants = await variantRows(product.id)
    expect(variants).toHaveLength(1)
    expect(variants[0]).toMatchObject({ is_default: 1, active: 1, price_minor: 3499 })
  })

  it('activating a default-less product through the admin form is refused with the reason shown', async () => {
    const created = await createProduct(env.DB, { slug: 'lc-form-2', title: 'F2', priceMinor: 1000, category: 'book', active: false })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const jar = await adminJar()
    // Put the product's variants out of play AFTER the one-time local
    // bootstrap has run — its idempotent variant sync would otherwise
    // restore a default for a product that has no variant rows at all.
    await env.DB.prepare('UPDATE product_variants SET active = 0 WHERE product_id = ?').bind(created.productId).run()

    const res = await app.request(
      `/admin/products/${created.productId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() },
        body: new URLSearchParams({ title: 'F2', price: '10', category: 'book', active: '1' })
      },
      env
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toMatch(/exactly one active default variant/i)
    const product = await env.DB.prepare('SELECT active FROM products WHERE id = ?').bind(created.productId).first<{ active: number }>()
    expect(product!.active).toBe(0)
  })
})
