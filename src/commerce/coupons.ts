// COM-05: coupon/promotion rule evaluation — scope, date window, minimum,
// usage limits and stacking, with a DETERMINISTIC outcome.
//
// Determinism matters more than cleverness here: the same cart, code and clock
// must always produce the same discount, and two servers evaluating the same
// quote must agree to the cent. So candidates are ordered by an explicit total
// order (priority, then rate, then code), and the stacking rule below is a
// closed, documented procedure rather than "whatever the loop happened to do".
//
// All arithmetic is integer minor units + integer basis points (src/money.ts).
// Nothing here trusts a client-supplied rate, code list or total.
import { bpsOf } from '../money'

export type DiscountRuleRow = {
  id: number
  code: string
  percent: number
  percent_bps: number | null
  applies_to: string
  min_books: number
  auto_apply: number
  active: number
  scope: string
  starts_at: string | null
  ends_at: string | null
  min_subtotal_minor: number | null
  max_uses: number | null
  max_uses_per_owner: number | null
  stackable: number
  priority: number
  max_discount_minor: number | null
}

export type CouponLine = { kind: string; unitPriceMinor: number; qty: number; lineTotalMinor: number }

export type AppliedCoupon = {
  discountId: number
  code: string
  percentBps: number
  /** The base the rate was applied to (scope-filtered). */
  baseMinor: number
  amountMinor: number
}

export type CouponDecision = {
  applied: AppliedCoupon[]
  discountMinor: number
  requestedCode: string | null
  /** Why a requested code was NOT applied. Empty when it was applied. */
  rejection: { code: string; reason: string } | null
  /** Auto-apply codes that were skipped, with the reason (admin/debug visibility). */
  skipped: Array<{ code: string; reason: string }>
}

export const COUPON_SCOPES = ['books', 'stickers', 'all'] as const

/** The subtotal a scope is allowed to discount. Never the whole cart for a scoped coupon. */
export function scopeBaseMinor(scope: string, lines: CouponLine[]): number {
  if (scope === 'all') return lines.reduce((n, l) => n + l.lineTotalMinor, 0)
  const kind = scope === 'stickers' ? 'sticker' : 'book'
  return lines.filter((l) => l.kind === kind).reduce((n, l) => n + l.lineTotalMinor, 0)
}

/**
 * The number of BOOK units in the cart. The legacy `discounts.min_books` column
 * (and the storefront copy that promises "20% off when you order 2 or more
 * books") is a quantity rule, not a money threshold, so it is evaluated from
 * real quantities — never silently dropped because the new rule fields exist.
 */
export function bookCountOf(lines: CouponLine[]): number {
  return lines.filter((l) => l.kind === 'book').reduce((n, l) => n + l.qty, 0)
}

/** The authoritative integer rate: basis points, falling back to the legacy REAL column once. */
export function discountPercentBps(row: Pick<DiscountRuleRow, 'percent_bps' | 'percent'>): number {
  if (row.percent_bps != null) return Math.max(0, Math.min(10000, Number(row.percent_bps)))
  const legacy = Number(row.percent)
  if (!Number.isFinite(legacy)) return 0
  return Math.max(0, Math.min(10000, Math.round(legacy * 100)))
}

function withinWindow(row: DiscountRuleRow, nowIso: string): boolean {
  if (row.starts_at && nowIso < row.starts_at) return false
  if (row.ends_at && nowIso > row.ends_at) return false
  return true
}

export type CouponUsage = { totalUses: number; ownerUses: number }

/**
 * Evaluates the coupon rules for a priced cart.
 *
 * STACKING RULE (closed and deterministic):
 *   1. order the eligible candidates by (priority ASC, percentBps DESC, code ASC);
 *   2. if the highest-ranked candidate is NOT stackable, apply exactly that one;
 *   3. otherwise apply that one plus every following candidate that is also
 *      stackable, stopping at the first non-stackable candidate.
 * The combined discount can never exceed the scope base, nor a coupon's own
 * `max_discount_minor` cap.
 */
export async function evaluateCoupons(
  db: D1Database,
  opts: {
    lines: CouponLine[]
    currency: string
    couponCode?: string | null
    ownerKey: string
    now?: string
  }
): Promise<CouponDecision> {
  const nowIso = opts.now || new Date().toISOString()
  const requested = opts.couponCode == null || String(opts.couponCode).trim() === '' ? null : String(opts.couponCode).trim().toUpperCase()
  const rows =
    (
      await db
        .prepare('SELECT * FROM discounts WHERE active = 1')
        .all<DiscountRuleRow>()
    ).results || []

  const byCode = new Map(rows.map((r) => [String(r.code).toUpperCase(), r]))
  const eligible: DiscountRuleRow[] = []
  const skipped: Array<{ code: string; reason: string }> = []
  const rejection: { code: string; reason: string } | null = null

  // Candidate set: the explicitly requested code, or the auto-apply codes.
  let candidates: DiscountRuleRow[]
  if (requested) {
    const row = byCode.get(requested)
    if (!row) {
      return { applied: [], discountMinor: 0, requestedCode: requested, rejection: { code: requested, reason: 'That discount code is not valid.' }, skipped }
    }
    candidates = [row]
  } else {
    candidates = rows.filter((r) => !!r.auto_apply)
  }

  let firstRejection: { code: string; reason: string } | null = rejection
  for (const row of candidates) {
    const code = String(row.code).toUpperCase()
    const reason = await ineligibilityReason(db, row, opts, nowIso)
    if (reason) {
      skipped.push({ code, reason })
      if (requested && !firstRejection) firstRejection = { code, reason }
      continue
    }
    eligible.push(row)
  }

  eligible.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    const rateDiff = discountPercentBps(b) - discountPercentBps(a)
    if (rateDiff !== 0) return rateDiff
    return String(a.code).toUpperCase().localeCompare(String(b.code).toUpperCase())
  })

  const chosen: DiscountRuleRow[] = []
  if (eligible.length) {
    chosen.push(eligible[0])
    if (!!eligible[0].stackable) {
      for (let i = 1; i < eligible.length; i++) {
        if (!eligible[i].stackable) break
        chosen.push(eligible[i])
      }
    }
  }

  const cartSubtotal = opts.lines.reduce((n, l) => n + l.lineTotalMinor, 0)
  const applied: AppliedCoupon[] = []
  let remainingCap = cartSubtotal
  for (const row of chosen) {
    const base = scopeBaseMinor(row.scope, opts.lines)
    if (base <= 0) {
      skipped.push({ code: String(row.code).toUpperCase(), reason: 'This cart has nothing this code applies to.' })
      continue
    }
    const raw = bpsOf(base, discountPercentBps(row))
    const capped = row.max_discount_minor != null ? Math.min(raw, Number(row.max_discount_minor)) : raw
    const amountMinor = Math.max(0, Math.min(capped, remainingCap))
    if (amountMinor <= 0) continue
    remainingCap -= amountMinor
    applied.push({ discountId: row.id, code: String(row.code).toUpperCase(), percentBps: discountPercentBps(row), baseMinor: base, amountMinor })
  }

  return {
    applied,
    discountMinor: applied.reduce((n, a) => n + a.amountMinor, 0),
    requestedCode: requested,
    rejection: firstRejection,
    skipped
  }
}

/** The specific rule that makes a coupon unusable right now, or null when it is usable. */
async function ineligibilityReason(
  db: D1Database,
  row: DiscountRuleRow,
  opts: { lines: CouponLine[]; ownerKey: string },
  nowIso: string
): Promise<string | null> {
  if (!withinWindow(row, nowIso)) return 'That discount code is not active right now.'
  const scope = String(row.scope || row.applies_to || 'books')
  if (!(COUPON_SCOPES as readonly string[]).includes(scope)) return 'That discount code is misconfigured.'
  const base = scopeBaseMinor(scope, opts.lines)
  if (base <= 0) return 'This cart has nothing this code applies to.'
  if (Number(row.min_books || 0) > 0 && bookCountOf(opts.lines) < Number(row.min_books)) {
    return `This code needs at least ${Number(row.min_books)} book(s) in the cart.`
  }
  if (row.min_subtotal_minor != null && base < Number(row.min_subtotal_minor)) {
    return 'This cart does not yet meet the minimum for that code.'
  }
  if (row.max_uses != null) {
    const used = await db.prepare('SELECT COUNT(*) AS n FROM coupon_redemptions WHERE discount_id = ?').bind(row.id).first<{ n: number }>()
    if (Number(used?.n ?? 0) >= Number(row.max_uses)) return 'That discount code has reached its usage limit.'
  }
  if (row.max_uses_per_owner != null) {
    const used = await db
      .prepare('SELECT COUNT(*) AS n FROM coupon_redemptions WHERE discount_id = ? AND owner_key = ?')
      .bind(row.id, opts.ownerKey)
      .first<{ n: number }>()
    if (Number(used?.n ?? 0) >= Number(row.max_uses_per_owner)) return 'You have already used that discount code.'
  }
  return null
}

/**
 * Records the redemptions for an order. The unique (discount_id, order_id)
 * constraint is the authority: a replayed submission collides rather than
 * double-counting. Returns the number of redemptions actually written.
 */
export async function recordRedemptions(
  db: D1Database,
  opts: { orderId: number; ownerKey: string; currency: string; applied: AppliedCoupon[] }
): Promise<number> {
  let written = 0
  for (const coupon of opts.applied) {
    try {
      const result = await db
        .prepare(
          `INSERT OR IGNORE INTO coupon_redemptions (discount_id, order_id, owner_key, code, percent_bps, amount_minor, currency)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(coupon.discountId, opts.orderId, opts.ownerKey, coupon.code, coupon.percentBps, coupon.amountMinor, opts.currency)
        .run()
      const changes = Number((result as any)?.meta?.changes ?? 0)
      if (changes > 0) written += 1
    } catch {
      // A missing discount row (deleted between quote and order) must not fail
      // the order: the amount charged is already snapshotted on the order.
    }
  }
  return written
}
