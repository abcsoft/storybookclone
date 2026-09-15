// COM-01/COM-13: the compatibility bridge for the browser's OFFLINE cart.
//
// The storefront keeps a localStorage cart so the pages work offline and render
// instantly. Those lines are NOT authoritative: before they can influence a
// displayed total they are resolved to real catalog rows here, and anything that
// cannot be resolved (unknown slug, withdrawn product) is reported rather than
// priced.
//
// Note what this function deliberately does NOT return: a user_book reference.
// A `userBookId` from localStorage is opaque to the server, and trusting it here
// would let a crafted request price someone else's personalization. The
// authoritative path for a personalized line is the SERVER cart
// (POST /api/v1/cart/items), which resolves ownership properly.
import { clampQty } from './cart'

export type ResolvedCartLine = { product_id: number; variant_code: string; qty: number; user_book_id: number | null }

export type ResolveClientResult = { items: ResolvedCartLine[]; rejected: Array<{ slug: string; reason: string }> }

export async function resolveClientLines(db: D1Database, rawItems: unknown[]): Promise<ResolveClientResult> {
  const items: ResolvedCartLine[] = []
  const rejected: Array<{ slug: string; reason: string }> = []
  const list = Array.isArray(rawItems) ? rawItems.slice(0, 50) : []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const slug = String(entry.slug || '').trim()
    if (!slug) continue
    const product = await db.prepare('SELECT id FROM products WHERE slug = ? AND active = 1').bind(slug).first<{ id: number }>()
    if (!product) {
      rejected.push({ slug, reason: 'Unknown or unavailable product.' })
      continue
    }
    const variantCode = String(entry.coverType ?? entry.variantCode ?? '').trim()
    items.push({ product_id: product.id, variant_code: variantCode, qty: clampQty(entry.qty), user_book_id: null })
  }
  return { items, rejected }
}

/** Convenience wrapper used by the display-only quote path. */
export async function cartLinesFromClient(db: D1Database, rawItems: unknown[]): Promise<ResolvedCartLine[]> {
  return (await resolveClientLines(db, rawItems)).items
}
