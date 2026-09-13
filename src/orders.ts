// Order creation: server-authoritative pricing, atomic order+items+photo-
// claim writes, idempotent replay of duplicate submissions, and guest order
// access via an unforgeable HMAC-signed capability token (never a bare
// sequential ID). Signing secrets come from environment bindings — see
// src/secrets.ts resolveGuestOrderTokenSecrets() — never the database.
import { quoteCart, shippingFor, round2, type CartLine } from './db'
import { checkUploadOwnership } from './uploads'
import { sha256Hex, signWithRotation, hmacSha256Hex, timingSafeEqual, DEFAULT_GUEST_ORDER_TOKEN_TTL_SECONDS, type RotatingSecrets } from './secrets'

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

function uploadOwnershipErrorMessage(reason: 'missing' | 'expired' | 'foreign' | 'consumed'): string {
  const messages: Record<string, string> = {
    missing: `Upload not found for one item — please re-upload the photo.`,
    expired: `The uploaded photo for one item has expired — please re-upload it.`,
    foreign: `One item references a photo upload that does not belong to this browser session.`,
    consumed: `One item's uploaded photo was already used in another order.`
  }
  return messages[reason]
}

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
  ctx: { userId: number | null; uploadOwnerToken: string; secrets: RotatingSecrets; guestTokenTtlSeconds?: number }
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
  // order must not fail just because its photo was already claimed by the
  // first, successful attempt.
  const existing = await db
    .prepare('SELECT id, idempotency_payload_hash, email FROM orders WHERE idempotency_key = ?')
    .bind(idempotencyKey)
    .first<{ id: number; idempotency_payload_hash: string | null; email: string }>()
  if (existing) {
    if (existing.idempotency_payload_hash !== payloadHash) {
      return { ok: false, status: 409, error: 'This idempotency key was already used with different order details.' }
    }
    return { ok: true, orderId: existing.id, guestToken: await signGuestOrderToken(ctx.secrets, existing.id, { ttlSeconds: ctx.guestTokenTtlSeconds }), replayed: true }
  }

  for (const item of items) {
    if (!String(item.childName || '').trim()) return { ok: false, status: 400, error: 'Each item needs a child name.' }
    const key = String(item.photoKey || '')
    if (!key.startsWith('uploads/')) return { ok: false, status: 400, error: 'Each item needs an uploaded photo.' }
    // Fast pre-check for the common (non-racing) bad-request case — the
    // atomic upload_claims insert in the batch below is the real,
    // race-proof authority (see the concurrency comment further down).
    const check = await checkUploadOwnership(db, key, ctx.uploadOwnerToken)
    if (!check.ok) return { ok: false, status: 400, error: uploadOwnershipErrorMessage(check.reason) }
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

  // Atomic photo claiming: one item in the SAME order may legitimately
  // reuse a photoKey (e.g. a matching sticker pack added alongside a book —
  // see the cart cross-sell), so claim/consume each UNIQUE key once, not
  // once per item.
  const uniquePhotoKeys = [...new Set(items.map((it) => String(it.photoKey)))]
  // Two independent, atomic guarantees on this one INSERT, both enforced
  // BY THE DATABASE, not application code (migration 0006):
  //  1) upload_claims.upload_key is PRIMARY KEY: if a DIFFERENT,
  //     concurrently-committing order already claimed one of these keys,
  //     this INSERT hits a UNIQUE-constraint violation.
  //  2) trg_upload_claims_enforce_ownership (a BEFORE INSERT trigger)
  //     RAISE(ABORT)s unless a matching photo_uploads row — same
  //     upload_key, same owner_token, consumed_at IS NULL, unexpired —
  //     genuinely exists AT THE MOMENT THIS STATEMENT RUNS. This is the
  //     authoritative check; checkUploadOwnership() above is only a fast,
  //     friendly pre-check for the common non-racing case, and can be
  //     stale by the time the batch actually executes (an upload expiring
  //     in that window, for example) — the trigger is what actually closes
  //     that gap.
  // Either failure fails the WHOLE db.batch() — order and item rows
  // included — atomically. That's what closes the TOCTOU window the old
  // two-step "insert order, then separately mark uploads consumed" flow
  // had: exactly one of two concurrent checkouts racing for the same photo
  // can ever win.
  const claimStmts = uniquePhotoKeys.map((key) =>
    db
      .prepare(`INSERT INTO upload_claims (upload_key, order_id, owner_token) VALUES (?, (SELECT id FROM orders WHERE idempotency_key = ?), ?)`)
      .bind(key, idempotencyKey, ctx.uploadOwnerToken)
  )
  const consumeStmts = uniquePhotoKeys.map((key) => db.prepare('UPDATE photo_uploads SET consumed_at = CURRENT_TIMESTAMP WHERE upload_key = ?').bind(key))

  try {
    await db.batch([orderStmt, ...itemStmts, ...claimStmts, ...consumeStmts])
  } catch (err) {
    // Two distinct races can land here — diagnose in priority order so the
    // caller gets a deterministic, specific error either way.

    // 1) Someone else committed the SAME idempotency key first (a genuine
    // duplicate submission/retry) — replay their result.
    const racedOrder = await db
      .prepare('SELECT id, idempotency_payload_hash FROM orders WHERE idempotency_key = ?')
      .bind(idempotencyKey)
      .first<{ id: number; idempotency_payload_hash: string | null }>()
    if (racedOrder) {
      if (racedOrder.idempotency_payload_hash !== payloadHash) {
        return { ok: false, status: 409, error: 'This idempotency key was already used with different order details.' }
      }
      return { ok: true, orderId: racedOrder.id, guestToken: await signGuestOrderToken(ctx.secrets, racedOrder.id, { ttlSeconds: ctx.guestTokenTtlSeconds }), replayed: true }
    }

    // 2) A DIFFERENT idempotency key (a different, concurrent checkout) won
    // the race to claim one of these photos first — deterministic conflict,
    // not a duplicate of our own request.
    for (const key of uniquePhotoKeys) {
      const claimed = await db.prepare('SELECT order_id FROM upload_claims WHERE upload_key = ?').bind(key).first<{ order_id: number }>()
      if (claimed) {
        return { ok: false, status: 409, error: "One item's uploaded photo was just claimed by another order — please re-upload the photo and try again." }
      }
    }

    // 3) Nobody else claimed it (case 2 found nothing), yet the batch still
    // failed — the DB-enforced trigger (migration 0006) rejected our OWN
    // claim attempt: the upload expired, got consumed, or stopped matching
    // our owner_token in the window between the pre-check above and this
    // batch actually executing. Re-run the same ownership check so the
    // caller gets the same clear, specific error the pre-check would have
    // given, instead of a raw batch-failure exception.
    for (const item of items) {
      const key = String(item.photoKey || '')
      const check = await checkUploadOwnership(db, key, ctx.uploadOwnerToken)
      if (!check.ok) return { ok: false, status: 400, error: uploadOwnershipErrorMessage(check.reason) }
    }

    throw err
  }

  const created = await db.prepare('SELECT id FROM orders WHERE idempotency_key = ?').bind(idempotencyKey).first<{ id: number }>()
  const orderId = created!.id

  return { ok: true, orderId, guestToken: await signGuestOrderToken(ctx.secrets, orderId, { ttlSeconds: ctx.guestTokenTtlSeconds }), replayed: false }
}

// ---- guest order access (versioned, expiring HMAC capability token) ----
//
// Token shape: `v1.<orderId>.<issuedAt>.<expiresAt>.<nonce>.<hexHmac>` —
// versioned so a future format change is detected, not silently misparsed;
// orderId/issuedAt/expiresAt/nonce are all covered BY the signature (not
// just appended after it), so tampering with any one field invalidates the
// whole token. The nonce makes two tokens for the same order+instant
// unlinkable/non-deterministic (no more "the token is just a pure function
// of order id + secret" — see below); issuedAt/expiresAt bound its
// lifetime. A stolen D1 export alone can't forge a token: the signing
// secret lives only in the GUEST_ORDER_TOKEN_SECRET(_PREV) worker bindings
// (see src/secrets.ts), never the database.
//
// IMPORTANT: signGuestOrderToken() is only ever called from inside
// createOrder() above (order creation, or replaying an idempotent retry of
// THIS caller's own already-succeeded order) — never from a route that
// hands out a fresh token given only an order id. Keep it that way: a
// "resend my confirmation link" feature must re-verify the caller already
// holds a valid token/owns the order, not mint a new one from the id alone.
const GUEST_TOKEN_VERSION = 'v1'

export type ClockFn = () => number // Unix seconds, UTC
export type NonceFn = () => string
const defaultClock: ClockFn = () => Math.floor(Date.now() / 1000)
const defaultNonce: NonceFn = () => crypto.randomUUID().replace(/-/g, '')
// Absorbs ordinary clock jitter between the process that time-stamped a
// token and the process verifying it — NOT a security boundary (nonces +
// the signature already prevent forgery); without this a request whose
// worker instance's clock is a couple of seconds behind would wrongly
// reject a token issued moments ago by another instance.
const CLOCK_SKEW_TOLERANCE_SECONDS = 5

function guestTokenMessage(orderId: number, issuedAt: number, expiresAt: number, nonce: string): string {
  return `guest-order:${GUEST_TOKEN_VERSION}:${orderId}:${issuedAt}:${expiresAt}:${nonce}`
}

export async function signGuestOrderToken(
  secrets: RotatingSecrets,
  orderId: number,
  opts: { ttlSeconds?: number; now?: ClockFn; nonce?: NonceFn } = {}
): Promise<string> {
  const now = (opts.now || defaultClock)()
  const ttlSeconds = opts.ttlSeconds ?? DEFAULT_GUEST_ORDER_TOKEN_TTL_SECONDS
  const nonce = (opts.nonce || defaultNonce)()
  const expiresAt = now + ttlSeconds
  const sig = await signWithRotation(secrets, guestTokenMessage(orderId, now, expiresAt, nonce))
  return `${GUEST_TOKEN_VERSION}.${orderId}.${now}.${expiresAt}.${nonce}.${sig}`
}

export type GuestTokenVerifyOpts = {
  now?: ClockFn
  // Previous-key verification is only honored while now <= previousDeadline
  // (see resolveGuestOrderTokenSecrets in src/secrets.ts) — omit to disable
  // previous-key verification entirely, even if secrets.previous is set.
  previousDeadline?: number
}

export async function verifyGuestOrderToken(secrets: RotatingSecrets, orderId: number, token: string, opts: GuestTokenVerifyOpts = {}): Promise<boolean> {
  if (!token) return false
  const parts = token.split('.')
  if (parts.length !== 6) return false
  const [version, tokenOrderIdStr, issuedAtStr, expiresAtStr, nonce, sig] = parts
  if (version !== GUEST_TOKEN_VERSION) return false
  // Alphanumeric only — real tokens use crypto.randomUUID() (hex), but the
  // check only needs to rule out '.' (the field delimiter) and emptiness,
  // not force a specific charset test doubles must also match.
  if (!nonce || !/^[A-Za-z0-9]+$/.test(nonce)) return false
  if (!/^\d+$/.test(tokenOrderIdStr) || !/^\d+$/.test(issuedAtStr) || !/^\d+$/.test(expiresAtStr)) return false
  const tokenOrderId = Number(tokenOrderIdStr)
  const issuedAt = Number(issuedAtStr)
  const expiresAt = Number(expiresAtStr)
  if (tokenOrderId !== orderId) return false
  if (expiresAt <= issuedAt) return false // malformed: expiry not after issuance

  const now = (opts.now || defaultClock)()
  if (issuedAt > now + CLOCK_SKEW_TOLERANCE_SECONDS) return false // reject future-issued
  if (expiresAt < now) return false // expired

  const message = guestTokenMessage(tokenOrderId, issuedAt, expiresAt, nonce)
  const expectedCurrent = await hmacSha256Hex(secrets.current, message)
  if (timingSafeEqual(expectedCurrent, sig)) return true

  if (secrets.previous && opts.previousDeadline !== undefined && now <= opts.previousDeadline) {
    const expectedPrev = await hmacSha256Hex(secrets.previous, message)
    if (timingSafeEqual(expectedPrev, sig)) return true
  }
  return false
}
