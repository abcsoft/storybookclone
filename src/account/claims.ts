// CUS-04 — verified guest draft/order claiming.
//
// THE SECURITY RULE, STATED ONCE: knowing a guest's email address is NOT
// authorization. Every claim this module performs is gated on ONE of exactly two
// proven capabilities, and `guest_claims.verified_via` is CHECK-constrained to
// those two values so no future code path can record anything else:
//
//   * 'guest_capability' — the order's own HMAC capability token, which only the
//     browser that placed the order holds. Nothing to verify by mail.
//   * 'email_token'      — a single-use token DELIVERED to the guest address and
//     consumed by the signed-in account that requested it. Typing an address into
//     a form produces only a request to SEND that token; it never claims
//     anything, and if the mailbox is not yours the token never arrives.
//
// The transfer itself is a compare-and-swap (`WHERE user_id IS NULL`), so two
// accounts racing for the same order can only ever have one winner, and the
// UNIQUE(resource_type, resource_ref) index on guest_claims is the database-level
// backstop against a second claim of the same resource.
import { brand } from '../brand'
import { DomainError } from '../generation/types'
import { resolveGuestOrderTokenSecrets, MissingSecretError } from '../secrets'
import { verifyGuestOrderToken } from '../orders'
import { sendEmailNow } from '../mail/outbox'
import type { MailEnv } from '../mail/provider'
import { isEmailShaped, issueEmailToken, consumeEmailToken, normalizeEmail } from './profile'
import { recordSecurityEvent, notifyAccountSecurity } from './security'
import { provisionEntitlementsForOrder } from './downloads'

export type ClaimEnv = MailEnv & {
  GUEST_ORDER_TOKEN_SECRET?: string
  GUEST_ORDER_TOKEN_SECRET_PREV?: string
  GUEST_ORDER_TOKEN_SECRET_PREV_DEADLINE?: string
  GUEST_ORDER_TOKEN_TTL_SECONDS?: string
  IP_HASH_SECRET?: string
}

export type EligibleGuestOrder = { id: number; email: string; createdAt: string; itemCount: number }

/**
 * The email-based claim path requires a CONFIRMED address on the claimant's own
 * account. It is not a formality: it stops a throwaway, unverified account from
 * harvesting orders by guessing addresses, and it keeps the API in step with the
 * UI (which only offers the form once the address is confirmed).
 */
async function requireVerifiedAccountEmail(db: D1Database, userId: number): Promise<void> {
  const row = await db.prepare('SELECT email_verified FROM users WHERE id = ?').bind(userId).first<{ email_verified: number }>()
  if (!row) throw new DomainError('not_found', 'Not found.', 404)
  if (Number(row.email_verified) !== 1) {
    throw new DomainError('email_not_verified', 'Confirm the email address on your account first, then ask for the claim link.', 403)
  }
}

/** Guest orders placed with `email` that nobody has claimed yet, newest first. */
export async function eligibleGuestOrdersForEmail(db: D1Database, email: string): Promise<EligibleGuestOrder[]> {
  const rows = await db
    .prepare(
      `SELECT o.id, o.email, o.created_at AS created_at, (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count
         FROM orders o
        WHERE o.user_id IS NULL
          AND lower(o.email) = ?
          AND NOT EXISTS (SELECT 1 FROM guest_claims c WHERE c.resource_type = 'order' AND c.resource_ref = CAST(o.id AS TEXT))
        ORDER BY o.id DESC
        LIMIT 50`
    )
    .bind(normalizeEmail(email))
    .all<{ id: number; email: string; created_at: string; item_count: number }>()
  return (rows.results || []).map((r) => ({ id: Number(r.id), email: r.email, createdAt: r.created_at, itemCount: Number(r.item_count) }))
}

export type ClaimOutcome = {
  claimedOrders: number[]
  claimedBooks: string[]
  skippedBooks: string[]
  verifiedVia: 'email_token' | 'guest_capability'
}

/**
 * Transfers ONE order (and the user_books its items are built from) to `userId`.
 *
 * The order UPDATE is a compare-and-swap on `user_id IS NULL`, and the claim row
 * INSERT is attempted FIRST so that a claimed row's UNIQUE constraint is what
 * stops a concurrent second claimant before any ownership moves.
 */
async function claimOrder(db: D1Database, userId: number, orderId: number, verifiedVia: ClaimOutcome['verifiedVia'], verifiedEmail: string, evidenceHash: string): Promise<{ claimed: boolean; books: string[]; skippedBooks: string[] }> {
  const publicId = `gc_${crypto.randomUUID().replace(/-/g, '')}`
  try {
    await db
      .prepare('INSERT INTO guest_claims (public_id, user_id, resource_type, resource_ref, verified_via, verified_email, evidence_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(publicId, userId, 'order', String(orderId), verifiedVia, verifiedEmail, evidenceHash)
      .run()
  } catch {
    // Already claimed (by this account earlier, or by someone else). Not an
    // error — the resource simply is not available to claim.
    return { claimed: false, books: [], skippedBooks: [] }
  }

  const moved = await db.prepare('UPDATE orders SET user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id IS NULL').bind(userId, orderId).run()
  if (Number(moved.meta?.changes ?? 0) === 0) {
    // The claim row was ours but the order was already owned (e.g. claimed by
    // the capability path in the same instant). Roll the claim row back so the
    // bookkeeping does not claim a transfer that did not happen.
    await db.prepare('DELETE FROM guest_claims WHERE public_id = ?').bind(publicId).run()
    return { claimed: false, books: [], skippedBooks: [] }
  }

  // The draft/revision the customer built as a guest is the point of claiming:
  // move those books too, so their personalization is not stranded on a
  // prospect nobody can authenticate as.
  const books =
    (
      await db.prepare('SELECT user_book_id FROM order_items WHERE order_id = ? AND user_book_id IS NOT NULL').bind(orderId).all<{ user_book_id: number }>()
    ).results || []
  // CUS-11: the order now has an ACCOUNT, so its download entitlement can finally
  // be granted (a guest order has nowhere to attach one). Idempotent.
  await provisionEntitlementsForOrder(db, orderId).catch(() => undefined)

  const claimedBooks: string[] = []
  const skippedBooks: string[] = []
  for (const row of books) {
    const book = await db.prepare('SELECT * FROM user_books WHERE id = ?').bind(row.user_book_id).first<{ id: number; public_id: string; user_id: number | null; prospect_id: string | null; state: string }>()
    if (!book) continue
    if (book.user_id === userId) {
      claimedBooks.push(book.public_id)
      continue
    }
    if (book.user_id !== null) {
      // Someone else already owns it: never steal it.
      skippedBooks.push(book.public_id)
      continue
    }
    // Exactly-one-owner CHECK: both columns move in ONE statement.
    const bookMoved = await db
      .prepare('UPDATE user_books SET user_id = ?, prospect_id = NULL, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id IS NULL')
      .bind(userId, book.id)
      .run()
    if (Number(bookMoved.meta?.changes ?? 0) === 0) {
      skippedBooks.push(book.public_id)
      continue
    }
    try {
      await db
        .prepare('INSERT INTO guest_claims (public_id, user_id, resource_type, resource_ref, verified_via, verified_email, evidence_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(`gc_${crypto.randomUUID().replace(/-/g, '')}`, userId, 'user_book', book.public_id, verifiedVia, verifiedEmail, evidenceHash)
        .run()
    } catch {
      /* already recorded by an earlier claim of the same order */
    }
    if (book.prospect_id) {
      await db.prepare('UPDATE prospects SET claimed_by_user_id = COALESCE(claimed_by_user_id, ?), claimed_at = COALESCE(claimed_at, CURRENT_TIMESTAMP) WHERE id = ?').bind(userId, book.prospect_id).run()
    }
    // A claim moves OWNERSHIP, not state: the event records the same state on
    // both sides (user_book_events.to_state is NOT NULL by schema), so the history
    // says exactly what changed and nothing more.
    await db
      .prepare("INSERT INTO user_book_events (user_book_id, actor_type, actor_id, from_state, to_state, event_type, metadata_json) VALUES (?, 'user', ?, ?, ?, 'guest_claim_transferred', ?)")
      .bind(book.id, String(userId), book.state, book.state, JSON.stringify({ orderId, verifiedVia }))
      .run()
    claimedBooks.push(book.public_id)
  }
  return { claimed: true, books: claimedBooks, skippedBooks }
}

/**
 * PATH 1 — the guest order's own capability token.
 *
 * No email is involved at all: possession of the token IS the proof. This is the
 * path a customer who still has their order confirmation link uses, and it is
 * what makes "sign up afterwards and keep the order" work without ever mailing
 * anything.
 */
export async function claimOrderWithCapability(
  db: D1Database,
  env: ClaimEnv,
  input: { userId: number; orderId: number; guestToken: string }
): Promise<ClaimOutcome> {
  const orderId = Number(input.orderId)
  if (!Number.isInteger(orderId) || orderId <= 0) throw new DomainError('validation_failed', 'A valid order is required.', 400, { orderId: 'is required' })
  const token = String(input.guestToken ?? '').trim()
  if (!token) throw new DomainError('capability_required', 'This order can only be added with its confirmation link, or by confirming the email address it was placed with.', 403)

  let verified = false
  try {
    const cfg = resolveGuestOrderTokenSecrets(env)
    verified = await verifyGuestOrderToken(cfg.secrets, orderId, token, { previousDeadline: cfg.previousDeadline })
  } catch (err) {
    if (!(err instanceof MissingSecretError)) throw err
    verified = false
  }
  if (!verified) throw new DomainError('capability_invalid', 'That confirmation link is invalid or has expired.', 403)

  const existing = await db.prepare('SELECT id, user_id FROM orders WHERE id = ?').bind(orderId).first<{ id: number; user_id: number | null }>()
  if (!existing) throw new DomainError('not_found', 'Order not found.', 404)
  if (existing.user_id !== null && existing.user_id !== input.userId) {
    // Someone else's order. Say nothing beyond "not found" so an order id cannot
    // be probed — even with a token, which should not exist for it.
    throw new DomainError('not_found', 'Order not found.', 404)
  }
  if (existing.user_id === input.userId) {
    return { claimedOrders: [orderId], claimedBooks: [], skippedBooks: [], verifiedVia: 'guest_capability' }
  }

  const outcome = await claimOrder(db, input.userId, orderId, 'guest_capability', '', token.slice(-12))
  if (!outcome.claimed) return { claimedOrders: [], claimedBooks: [], skippedBooks: [], verifiedVia: 'guest_capability' }
  await recordSecurityEvent(db, { userId: input.userId, eventType: 'guest_resources_claimed', metadata: { orderId, verifiedVia: 'guest_capability', books: outcome.books.length } })
  return { claimedOrders: [orderId], claimedBooks: outcome.books, skippedBooks: outcome.skippedBooks, verifiedVia: 'guest_capability' }
}

/**
 * PATH 2a — REQUEST the email proof. Deliberately reveals nothing: the response
 * is identical whether or not this address has any guest order, and the token is
 * only sent when there is something to claim (so a stranger's address is never
 * spammed). The caller cannot distinguish those two cases.
 */
export async function requestGuestClaim(
  db: D1Database,
  env: ClaimEnv,
  input: { userId: number; name: string; email: string; baseUrl: string; correlationId?: string }
): Promise<{ requested: true }> {
  const email = normalizeEmail(input.email)
  if (!isEmailShaped(email)) return { requested: true }
  // A CONFIRMED address on the claimant's own account is a precondition of the
  // email-based path. Possession of the order's own confirmation link (the other
  // path) needs no such thing, because it is already proof.
  await requireVerifiedAccountEmail(db, input.userId)

  const eligible = await eligibleGuestOrdersForEmail(db, email)
  if (!eligible.length) return { requested: true }

  const { token, ttlSeconds } = await issueEmailToken(db, { userId: input.userId, purpose: 'claim_resources', targetEmail: email })
  await sendEmailNow(db, env, {
    dedupeKey: `guest-claim:${input.userId}:${email}:${token}`,
    templateKey: 'guest_claim',
    to: email,
    userId: input.userId,
    correlationId: input.correlationId,
    variables: {
      brandName: brand().name,
      actionUrl: `${input.baseUrl}/account/confirm-claim?token=${token}`,
      expiresMinutes: String(Math.round(ttlSeconds / 60))
    }
  })
  return { requested: true }
}

/**
 * PATH 2b — CONSUME the email proof. Requires ALL of:
 *   * a valid, unexpired, unconsumed token for purpose 'claim_resources';
 *   * the signed-in account IS the account that requested it (so a stolen link
 *     alone is useless);
 *   * the token's target address matches the address on the eligible orders.
 * Only then does ownership move.
 */
export async function confirmGuestClaim(db: D1Database, env: ClaimEnv, input: { userId: number; rawToken: string }): Promise<ClaimOutcome & { verifiedEmail: string }> {
  await requireVerifiedAccountEmail(db, input.userId)
  // The account check happens INSIDE the consumption, so a token presented by the
  // wrong account is refused without being burned.
  const consumed = await consumeEmailToken(db, 'claim_resources', input.rawToken, { expectedUserId: input.userId })
  if (!consumed) throw new DomainError('invalid_token', 'This confirmation link is invalid or has expired.', 400)

  const email = normalizeEmail(consumed.targetEmail)
  // Consuming a token delivered to this address PROVES control of it, so the
  // account's own address is verified at the same time when it is the same one.
  const user = await db.prepare('SELECT id, email, email_verified FROM users WHERE id = ?').bind(input.userId).first<{ id: number; email: string; email_verified: number }>()
  if (user && normalizeEmail(user.email) === email && Number(user.email_verified) !== 1) {
    await db.prepare('UPDATE users SET email_verified = 1, email_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(input.userId).run()
    await recordSecurityEvent(db, { userId: input.userId, eventType: 'email_verified', metadata: { email, via: 'claim_token' } })
  }

  const eligible = await eligibleGuestOrdersForEmail(db, email)
  const claimedOrders: number[] = []
  const claimedBooks: string[] = []
  const skippedBooks: string[] = []
  for (const order of eligible) {
    const outcome = await claimOrder(db, input.userId, order.id, 'email_token', email, consumed.row.token_hash.slice(0, 16))
    if (outcome.claimed) claimedOrders.push(order.id)
    claimedBooks.push(...outcome.books)
    skippedBooks.push(...outcome.skippedBooks)
  }
  if (claimedOrders.length) {
    await recordSecurityEvent(db, { userId: input.userId, eventType: 'guest_resources_claimed', metadata: { orders: claimedOrders.length, books: claimedBooks.length, verifiedVia: 'email_token' } })
    await notifyAccountSecurity(db, env, {
      userId: input.userId,
      eventType: 'guest_resources_claimed',
      eventTitle: 'a guest order was added to your account',
      eventSummary: `${claimedOrders.length} order(s) placed with ${email} were added to your account after you confirmed that address.`
    }).catch(() => undefined)
  }
  return { claimedOrders, claimedBooks, skippedBooks, verifiedVia: 'email_token', verifiedEmail: email }
}

/** The claimable resources a signed-in account can currently see (its own address only). */
export async function claimableForUser(db: D1Database, userId: number, email: string): Promise<EligibleGuestOrder[]> {
  return eligibleGuestOrdersForEmail(db, email)
}

/** The claims already recorded for an account — the customer-visible history. */
export async function listClaimsForUser(db: D1Database, userId: number): Promise<Array<{ id: string; resourceType: string; resourceRef: string; verifiedVia: string; createdAt: string }>> {
  const rows = await db
    .prepare('SELECT public_id, resource_type, resource_ref, verified_via, created_at FROM guest_claims WHERE user_id = ? ORDER BY id DESC LIMIT 100')
    .bind(userId)
    .all<{ public_id: string; resource_type: string; resource_ref: string; verified_via: string; created_at: string }>()
  return (rows.results || []).map((r) => ({ id: r.public_id, resourceType: r.resource_type, resourceRef: r.resource_ref, verifiedVia: r.verified_via, createdAt: r.created_at }))
}
