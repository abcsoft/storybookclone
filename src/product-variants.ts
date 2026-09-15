// Product ⇄ default-variant invariant service (V2 Phase 1 correction, L-C).
//
// The rule the database can express on its own is "AT MOST ONE default
// variant row per product": migration 0016's partial unique index
// `idx_product_variants_default ON product_variants(product_id) WHERE
// is_default = 1`. (0016's comment calls this "exactly one default variant
// per product", which is misleading — the index only bounds the count from
// above; it cannot require a default to EXIST. This module is where the
// "exactly" half is actually enforced.)
//
// The full business rule for an ACTIVE, purchasable product is:
//   * EXACTLY ONE ACTIVE default variant (is_default = 1 AND active = 1);
//   * product creation creates that default variant ATOMICALLY, so a new
//     product is never briefly active with no default;
//   * activating a product whose invariant is unmet FAILS, with a message
//     telling the operator how to fix it;
//   * deactivating/deleting the only active default requires naming another
//     valid (active) default, or the product must be deactivated first.
//
// Prices are NEVER invented here: a variant's price comes from whatever the
// caller supplies (the admin-configurable price), not from a hard-coded
// cover/format difference. The 0016 backfill priced every option from the
// product's own price for exactly that reason.

export type VariantTenant = { productId: number }

export type InvariantResult = { ok: true } | { ok: false; error: string }

export type NewProductInput = {
  slug: string
  title: string
  tagline?: string
  description?: string
  story?: string
  /** Authoritative integer minor-unit price (L-B). Must be a non-negative integer. */
  priceMinor: number
  compareAtPriceMinor?: number | null
  currency?: string
  image?: string
  gender?: string
  category?: string
  ages?: string
  ageMin?: number
  ageMax?: number
  pages?: number
  reviews?: number
  rating?: number
  bestseller?: boolean
  newRelease?: boolean
  career?: boolean
  traits?: string[]
  active?: boolean
  /** Default variant to create with the product. Defaults by category — never a price. */
  defaultVariant?: { code?: string; label?: string }
}

export type CreateProductResult =
  | { ok: true; productId: number; variantId: number; variantCode: string; variantLabel: string }
  | { ok: false; error: string }

const DEFAULT_VARIANT_FOR_CATEGORY: Record<string, { code: string; label: string }> = {
  book: { code: 'hardcover', label: 'Hardcover' },
  sticker: { code: 'standard', label: 'Standard' }
}

function defaultVariantFor(category: string): { code: string; label: string } {
  return DEFAULT_VARIANT_FOR_CATEGORY[category] || DEFAULT_VARIANT_FOR_CATEGORY.sticker
}

function moneyError(label: string, value: number): string | null {
  if (!Number.isFinite(value)) return `${label} must be a number.`
  if (!Number.isInteger(value)) return `${label} must be a whole number of minor units.`
  if (value < 0) return `${label} cannot be negative.`
  return null
}

/** Variants that satisfy the "active default" half of the invariant. */
export async function activeDefaultVariants(db: D1Database, productId: number): Promise<Array<{ id: number; code: string }>> {
  const rows = await db
    .prepare('SELECT id, code FROM product_variants WHERE product_id = ? AND is_default = 1 AND active = 1 ORDER BY sort_order, id')
    .bind(productId)
    .all<{ id: number; code: string }>()
  return rows.results || []
}

/**
 * The invariant for an ACTIVE product. A product row with NO variant rows at
 * all is reported as unmet here — reads still fall back to a synthetic
 * single-variant price (src/db.ts::getProductVariants) so the storefront
 * cannot crash, but the catalog write paths must not leave it in that state.
 */
export async function checkPurchasableVariantInvariant(db: D1Database, productId: number): Promise<InvariantResult> {
  const defaults = await activeDefaultVariants(db, productId)
  if (defaults.length === 1) return { ok: true }
  if (defaults.length === 0) {
    return { ok: false, error: 'An active product must have exactly one active default variant — it currently has none. Add or activate a default variant before activating the product.' }
  }
  return { ok: false, error: `An active product must have exactly one active default variant — it currently has ${defaults.length}. Deactivate the extra default(s) first.` }
}

/**
 * Creates a product AND its default variant in ONE atomic batch: either both
 * rows exist or neither does, so a product can never become visible as active
 * without a default. Returns a friendly error for invalid money rather than
 * letting the 0018 trigger abort the batch.
 */
export async function createProduct(db: D1Database, p: NewProductInput): Promise<CreateProductResult> {
  const priceMinor = Number(p.priceMinor)
  const priceIssue = moneyError('Price', priceMinor)
  if (priceIssue) return { ok: false, error: priceIssue }
  const compareAtPriceMinor = p.compareAtPriceMinor == null ? null : Number(p.compareAtPriceMinor)
  if (compareAtPriceMinor !== null) {
    const compareIssue = moneyError('Compare-at price', compareAtPriceMinor)
    if (compareIssue) return { ok: false, error: compareIssue }
  }
  const slug = String(p.slug || '').trim()
  if (!slug) return { ok: false, error: 'A URL slug is required.' }
  const title = String(p.title || '').trim()
  if (!title) return { ok: false, error: 'A title is required.' }

  const category = String(p.category || 'book')
  const currency = String(p.currency || 'USD')
  const active = p.active === false ? 0 : 1
  const chosen = p.defaultVariant || defaultVariantFor(category)
  const code = String(chosen.code || '').trim()
  const label = String(chosen.label || '').trim()
  if (!code || !label) return { ok: false, error: 'The default variant needs a code and a label.' }

  const productStmt = db
    .prepare(
      `INSERT INTO products (slug, title, tagline, description, story, price, price_minor, compare_at, compare_at_price_minor, currency, image, gender, category, ages, age_min, age_max, pages, reviews, rating, bestseller, new_release, career, traits_json, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      slug,
      title,
      String(p.tagline || ''),
      String(p.description || ''),
      String(p.story || ''),
      priceMinor / 100,
      priceMinor,
      compareAtPriceMinor === null ? null : compareAtPriceMinor / 100,
      compareAtPriceMinor,
      currency,
      String(p.image || ''),
      String(p.gender || 'unisex'),
      category,
      String(p.ages || ''),
      Number(p.ageMin ?? 2),
      Number(p.ageMax ?? 10),
      Number(p.pages ?? 32),
      Number(p.reviews ?? 0),
      Number(p.rating ?? 4.8),
      p.bestseller ? 1 : 0,
      p.newRelease ? 1 : 0,
      p.career ? 1 : 0,
      JSON.stringify(p.traits || []),
      active
    )

  // The variant's product_id is resolved from the just-inserted slug inside
  // the same batch (the same technique the order/item commit uses), so the
  // two rows really are one atomic write.
  const variantStmt = db
    .prepare(
      `INSERT INTO product_variants (product_id, code, label, price_minor, compare_at_price_minor, currency, is_default, active, sort_order)
       VALUES ((SELECT id FROM products WHERE slug = ?), ?, ?, ?, ?, ?, 1, 1, 0)`
    )
    .bind(slug, code, label, priceMinor, compareAtPriceMinor, currency)

  try {
    await db.batch([productStmt, variantStmt])
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    if (/UNIQUE|unique/i.test(message)) return { ok: false, error: 'That slug (or default variant code) already exists.' }
    return { ok: false, error: 'Could not create the product and its default variant.' }
  }

  const row = await db
    .prepare(
      `SELECT p.id AS product_id, v.id AS variant_id FROM products p
       JOIN product_variants v ON v.product_id = p.id AND v.is_default = 1
       WHERE p.slug = ?`
    )
    .bind(slug)
    .first<{ product_id: number; variant_id: number }>()
  if (!row) return { ok: false, error: 'Could not create the product and its default variant.' }
  return { ok: true, productId: row.product_id, variantId: row.variant_id, variantCode: code, variantLabel: label }
}

/**
 * Activation gate: an ACTIVE purchasable product must satisfy the invariant,
 * so flipping `active` to 1 is refused when it does not. Deactivation is
 * always allowed (which is the documented escape hatch from the
 * "no other default to choose" case).
 */
export async function assertCanActivate(db: D1Database, productId: number): Promise<InvariantResult> {
  return checkPurchasableVariantInvariant(db, productId)
}

export type UpdateProductInput = NewProductInput & { id: number }

/**
 * Updates an existing product's editable fields. `price` and `price_minor`
 * are written together from the SAME integer (there is no path where one is
 * derived from a stale value of the other), and ACTIVATING the product runs
 * the variant-invariant gate first.
 */
export async function updateProduct(db: D1Database, p: UpdateProductInput): Promise<InvariantResult> {
  const priceMinor = Number(p.priceMinor)
  const priceIssue = moneyError('Price', priceMinor)
  if (priceIssue) return { ok: false, error: priceIssue }
  const compareAtPriceMinor = p.compareAtPriceMinor == null ? null : Number(p.compareAtPriceMinor)
  if (compareAtPriceMinor !== null) {
    const compareIssue = moneyError('Compare-at price', compareAtPriceMinor)
    if (compareIssue) return { ok: false, error: compareIssue }
  }
  const existing = await db.prepare('SELECT id, active FROM products WHERE id = ?').bind(p.id).first<{ id: number; active: number }>()
  if (!existing) return { ok: false, error: 'Product not found.' }

  const active = p.active === false ? 0 : 1
  if (active === 1 && !existing.active) {
    const gate = await checkPurchasableVariantInvariant(db, p.id)
    if (!gate.ok) return gate
  }

  await db
    .prepare(
      `UPDATE products SET title=?, tagline=?, description=?, story=?, price=?, price_minor=?, compare_at=?, compare_at_price_minor=?, image=?, gender=?, category=?, ages=?, age_min=?, age_max=?, pages=?, reviews=?, rating=?, bestseller=?, new_release=?, career=?, traits_json=?, active=? WHERE id=?`
    )
    .bind(
      String(p.title || ''),
      String(p.tagline || ''),
      String(p.description || ''),
      String(p.story || ''),
      priceMinor / 100,
      priceMinor,
      compareAtPriceMinor === null ? null : compareAtPriceMinor / 100,
      compareAtPriceMinor,
      String(p.image || ''),
      String(p.gender || 'unisex'),
      String(p.category || 'book'),
      String(p.ages || ''),
      Number(p.ageMin ?? 2),
      Number(p.ageMax ?? 10),
      Number(p.pages ?? 32),
      Number(p.reviews ?? 0),
      Number(p.rating ?? 4.8),
      p.bestseller ? 1 : 0,
      p.newRelease ? 1 : 0,
      p.career ? 1 : 0,
      JSON.stringify(p.traits || []),
      active,
      p.id
    )
    .run()
  return { ok: true }
}

/** Makes `variantId` the product's single default, atomically clearing any other default. */
export async function setDefaultVariant(db: D1Database, productId: number, variantId: number): Promise<InvariantResult> {
  const variant = await db.prepare('SELECT id, active FROM product_variants WHERE id = ? AND product_id = ?').bind(variantId, productId).first<{ id: number; active: number }>()
  if (!variant) return { ok: false, error: 'That variant does not belong to this product.' }
  if (!variant.active) return { ok: false, error: 'Only an active variant can be the default.' }
  // Clear-then-set in ONE batch: the partial unique index would otherwise see
  // two default rows mid-sequence.
  await db.batch([
    db.prepare('UPDATE product_variants SET is_default = 0 WHERE product_id = ? AND is_default = 1 AND id <> ?').bind(productId, variantId),
    db.prepare('UPDATE product_variants SET is_default = 1 WHERE id = ? AND product_id = ?').bind(variantId, productId)
  ])
  return { ok: true }
}

/**
 * Deactivates a variant. Removing the product's ONLY active default is
 * refused unless a replacement (another ACTIVE variant of the same product)
 * is named — otherwise the operator must deactivate the product instead.
 */
export async function deactivateVariant(db: D1Database, productId: number, variantId: number, replacementVariantId?: number | null): Promise<InvariantResult> {
  const plan = await planDefaultRemoval(db, productId, variantId, replacementVariantId)
  if (!plan.ok) return plan
  await db.batch([
    db.prepare('UPDATE product_variants SET is_default = 0, active = 0 WHERE id = ? AND product_id = ?').bind(variantId, productId),
    ...plan.statements
  ])
  return { ok: true }
}

/** Deletes a variant under the same rule as deactivation. */
export async function deleteVariant(db: D1Database, productId: number, variantId: number, replacementVariantId?: number | null): Promise<InvariantResult> {
  const plan = await planDefaultRemoval(db, productId, variantId, replacementVariantId)
  if (!plan.ok) return plan
  await db.batch([db.prepare('DELETE FROM product_variants WHERE id = ? AND product_id = ?').bind(variantId, productId), ...plan.statements])
  return { ok: true }
}

type RemovalPlan = { ok: true; statements: D1PreparedStatement[] } | { ok: false; error: string }

/**
 * Decides whether removing `variantId` is safe, and — when it is the only
 * active default of an ACTIVE product — requires a valid replacement.
 */
async function planDefaultRemoval(db: D1Database, productId: number, variantId: number, replacementVariantId?: number | null): Promise<RemovalPlan> {
  const variant = await db.prepare('SELECT id FROM product_variants WHERE id = ? AND product_id = ?').bind(variantId, productId).first<{ id: number }>()
  if (!variant) return { ok: false, error: 'That variant does not belong to this product.' }

  const defaults = await activeDefaultVariants(db, productId)
  const isOnlyDefault = defaults.length === 1 && defaults[0].id === variantId
  if (!isOnlyDefault) return { ok: true, statements: [] }

  const product = await db.prepare('SELECT active FROM products WHERE id = ?').bind(productId).first<{ active: number }>()
  if (product && !product.active) return { ok: true, statements: [] } // inactive product: no invariant to keep

  if (replacementVariantId == null) {
    return {
      ok: false,
      error: 'This is the product’s only active default variant. Choose another active variant as the default, or deactivate the product first.'
    }
  }
  const replacement = await db
    .prepare('SELECT id, active FROM product_variants WHERE id = ? AND product_id = ?')
    .bind(replacementVariantId, productId)
    .first<{ id: number; active: number }>()
  if (!replacement) return { ok: false, error: 'The replacement default does not belong to this product.' }
  if (!replacement.active) return { ok: false, error: 'The replacement default must be an active variant.' }
  return {
    ok: true,
    statements: [db.prepare('UPDATE product_variants SET is_default = 1 WHERE id = ? AND product_id = ?').bind(replacement.id, productId)]
  }
}
