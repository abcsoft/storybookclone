// Order creation: server-authoritative pricing, atomic order+items writes,
// idempotent replay of duplicate submissions, and guest order access via an
// unforgeable HMAC-signed capability token (never a bare sequential ID).
import { quoteCart, shippingFor, round2, type CartLine } from './db'
import { checkUploadOwnership, markUploadsConsumed } from './uploads'
import { getOrCreateSecret, hmacSha256Hex, timingSafeEqual, sha256Hex } from './secrets'

export type OrderItemInput = {
  slug: string
  qty?: number
  childName?: string
  childAge?: number | string
  language?: string
  dedication?: string
  photoKey?: string
}

export type CreateOrderInput = {
  items: OrderItemInput[]
  fullName: string
  email: string
  address: string
  city: string
  country: string
  shippingMethod?: string
  code?: string
  paymentMethod?: string
  idempotencyKey?: string
}

export type CreateOrderResult =
  | { ok: true; orderId: number; guestToken: string; replayed: boolean }
  | { ok: false; status: number; error: string }

const TEST_PAYMENT_METHODS = new Set(['test-manual', 'manual-test', 'guest-manual'])

/** Stable JSON so the same logical payload always hashes the same way regardless of key order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonicalize((value as Record<string, unknown>)[k])])
    )
  }
  return value
}

export async function hashOrderPayload(input: CreateOrderInput): Promise<string> {
  const { idempotencyKey: _drop, ...rest } = input
  return sha256Hex(JSON.stringify(canonicalize(rest)))
}

export async function createOrder(
  db: D1Database,
  input: CreateOrderInput,
  ctx: { userId: number | null; uploadOwnerToken: string }
): Promise<CreateOrderResult> {
  const items = Array.isArray(input.items) ? input.items : []
  if (!items.length) return { ok: false, status: 400, error: 'Cart is empty.' }
  if (items.length > 20) return { ok: false, status: 400, error: 'Too many items in one order.' }

  const fullName = String(input.fullName || '').trim()
  const email = String(input.email || '').toLowerCase().trim()
  const address = String(input.address || '').trim()
  const city = String(input.city || '').trim()
  const country = String(input.country || '').trim()
  if (!fullName || !email.includes('@') || !address || !city || !country) {
    return { ok: false, status: 400, error: 'Please complete all shipping fields with a valid email.' }
  }

  const paymentMethod = String(input.paymentMethod || '')
  if (!TEST_PAYMENT_METHODS.has(paymentMethod)) {
    return {
      ok: false,
      status: 400,
      error:
        'This baseline does not integrate a real payment provider yet (see Phase 4). Pass an explicit test payment method, e.g. paymentMethod: "test-manual".'
    }
  }

  const idempotencyKey = String(input.idempotencyKey || crypto.randomUUID())
  const payloadHash = await hashOrderPayload(input)

  // Idempotent replay: same key seen before — short-circuit BEFORE
  // (re-)validating uploads. A legitimate retry of an already-succeeded
  // order must not fail just because its photo was already marked consumed
  // by the first, successful attempt.
  const existing = await db
    .prepare('SELECT id, idempotency_payload_hash, email FROM orders WHERE idempotency_key = ?')
    .bind(idempotencyKey)
    .first<{ id: number; idempotency_payload_hash: string | null; email: string }>()
  if (existing) {
    if (existing.idempotency_payload_hash !== payloadHash) {
      return { ok: false, status: 409, error: 'This idempotency key was already used with different order details.' }
    }
    return { ok: true, orderId: existing.id, guestToken: await signGuestOrderToken(db, existing.id), replayed: true }
  }

  for (const item of items) {
    if (!String(item.childName || '').trim()) return { ok: false, status: 400, error: 'Each item needs a child name.' }
    const key = String(item.photoKey || '')
    if (!key.startsWith('uploads/')) return { ok: false, status: 400, error: 'Each item needs an uploaded photo.' }
    const check = await checkUploadOwnership(db, key, ctx.uploadOwnerToken)
    if (!check.ok) {
      const messages: Record<string, string> = {
        missing: `Upload not found for one item — please re-upload the photo.`,
        expired: `The uploaded photo for one item has expired — please re-upload it.`,
        foreign: `One item references a photo upload that does not belong to this browser session.`,
        consumed: `One item's uploaded photo was already used in another order.`
      }
      return { ok: false, status: 400, error: messages[check.reason] }
    }
  }

  const cartLines: CartLine[] = items.map((i) => ({ slug: String(i.slug), kind: undefined, qty: i.qty }))
  const quote = await quoteCart(db, cartLines, input.code)
  if (quote.invalid.length) return { ok: false, status: 400, error: `Unknown product(s): ${quote.invalid.join(', ')}` }
  const ship = shippingFor(String(input.shippingMethod || 'standard'))
  const total = round2(quote.subtotal - quote.discount + ship.price)

  const orderStmt = db
    .prepare(
      `INSERT INTO orders (user_id, full_name, email, address, city, country, shipping_method, shipping, subtotal, discount, discount_code, total, status, idempotency_key, idempotency_payload_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_preview', ?, ?)`
    )
    .bind(ctx.userId, fullName, email, address, city, country, String(input.shippingMethod || 'standard'), ship.price, quote.subtotal, quote.discount, quote.appliedCode, total, idempotencyKey, payloadHash)

  // Item rows resolve their order_id via a subquery on the just-inserted
  // idempotency_key rather than a bound literal ID — that's what lets the
  // order insert AND every item insert commit as ONE atomic db.batch()
  // instead of two separate round-trips (order first, items after) where a
  // failure between them would orphan a paid-looking order with no items.
  const itemStmts = items.map((it) => {
    const meta = quote.priceMap.get(String(it.slug))!
    return db
      .prepare(
        `INSERT INTO order_items (order_id, product_id, slug, title, kind, unit_price, qty, child_name, child_age, language, dedication, photo_key)
         VALUES ((SELECT id FROM orders WHERE idempotency_key = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        idempotencyKey,
        meta.id,
        String(it.slug),
        meta.title,
        meta.kind,
        meta.price,
        Math.max(1, Math.min(10, Number(it.qty) || 1)),
        String(it.childName || '').slice(0, 24),
        it.childAge ? Number(it.childAge) : null,
        String(it.language || 'English').slice(0, 40),
        String(it.dedication || '').slice(0, 200),
        String(it.photoKey || '')
      )
  })

  try {
    await db.batch([orderStmt, ...itemStmts])
  } catch (err) {
    // Race: another request with the same idempotency key committed first
    // (UNIQUE constraint on orders.idempotency_key). Replay its result
    // instead of surfacing a spurious failure to a legitimate retry.
    const raced = await db
      .prepare('SELECT id, idempotency_payload_hash FROM orders WHERE idempotency_key = ?')
      .bind(idempotencyKey)
      .first<{ id: number; idempotency_payload_hash: string | null }>()
    if (raced) {
      if (raced.idempotency_payload_hash !== payloadHash) {
        return { ok: false, status: 409, error: 'This idempotency key was already used with different order details.' }
      }
      return { ok: true, orderId: raced.id, guestToken: await signGuestOrderToken(db, raced.id), replayed: true }
    }
    throw err
  }

  const created = await db.prepare('SELECT id FROM orders WHERE idempotency_key = ?').bind(idempotencyKey).first<{ id: number }>()
  const orderId = created!.id
  await markUploadsConsumed(db, items.map((i) => String(i.photoKey)))

  return { ok: true, orderId, guestToken: await signGuestOrderToken(db, orderId), replayed: false }
}

// ---- guest order access (HMAC capability token, not a bare sequential ID) ----

export async function signGuestOrderToken(db: D1Database, orderId: number): Promise<string> {
  const secret = await getOrCreateSecret(db, 'order_access_secret')
  return hmacSha256Hex(secret, `order:${orderId}`)
}

export async function verifyGuestOrderToken(db: D1Database, orderId: number, token: string): Promise<boolean> {
  if (!token) return false
  const expected = await signGuestOrderToken(db, orderId)
  return timingSafeEqual(expected, token)
}
