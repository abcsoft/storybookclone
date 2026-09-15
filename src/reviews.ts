// Reviews domain (V2 Phase 2).
//
// Scope: ADM-15 (moderation) + the PDP "verified reviews" section of SF-09.
//
// THE ONE RULE THAT MATTERS: a review shown on the storefront is a row in the
// `reviews` table with status='published'. There is no seed data, no fallback
// testimonial, no imported rating and no aggregate derived from anything else.
// A product with no published reviews renders an explicit empty state, because
// inventing social proof is precisely what Phase 1 removed.
//
// `verified_purchase` is derived on the SERVER from a real order row for the
// same product and the same author. The client can neither request nor forge
// it: `createReview` ignores any client-supplied value.

export type ReviewStatus = 'pending' | 'published' | 'rejected'

export type Review = {
  id: number
  productId: number
  productSlug?: string
  productTitle?: string
  userId: number | null
  authorName: string
  rating: number
  title: string
  body: string
  status: ReviewStatus
  verifiedPurchase: boolean
  createdAt: string
  moderatedAt: string | null
  moderationReason: string
}

export type ReviewSummary = {
  publishedCount: number
  /** null when there are no published reviews — never a fabricated default. */
  averageRating: number | null
  /** Distribution over published reviews only. */
  histogram: Record<1 | 2 | 3 | 4 | 5, number>
}

type Row = Record<string, any>

function toReview(r: Row): Review {
  return {
    id: Number(r.id),
    productId: Number(r.product_id),
    productSlug: r.product_slug == null ? undefined : String(r.product_slug),
    productTitle: r.product_title == null ? undefined : String(r.product_title),
    userId: r.user_id == null ? null : Number(r.user_id),
    authorName: String(r.author_name),
    rating: Number(r.rating),
    title: String(r.title || ''),
    body: String(r.body),
    status: String(r.status) as ReviewStatus,
    verifiedPurchase: Number(r.verified_purchase) === 1,
    createdAt: String(r.created_at || ''),
    moderatedAt: r.moderated_at == null ? null : String(r.moderated_at),
    moderationReason: String(r.moderation_reason || '')
  }
}

export const REVIEW_MAX_LENGTH = 2000
export const REVIEW_MIN_LENGTH = 20
export const REVIEW_TITLE_MAX = 120

export type ReviewInput = {
  productSlug: string
  rating: number
  title?: string
  body: string
  authorName: string
}

export type ValidationResult = { ok: true } | { ok: false; error: string }

/** Validates a submitted review. Returns the first problem, never a partial pass. */
export function validateReview(input: Partial<ReviewInput>): ValidationResult {
  const rating = Number(input.rating)
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { ok: false, error: 'Choose a rating from 1 to 5 stars.' }
  const body = String(input.body || '').trim()
  if (body.length < REVIEW_MIN_LENGTH) return { ok: false, error: `Write at least ${REVIEW_MIN_LENGTH} characters so the review is useful to other parents.` }
  if (body.length > REVIEW_MAX_LENGTH) return { ok: false, error: `Keep the review under ${REVIEW_MAX_LENGTH} characters.` }
  const title = String(input.title || '').trim()
  if (title.length > REVIEW_TITLE_MAX) return { ok: false, error: `Keep the headline under ${REVIEW_TITLE_MAX} characters.` }
  const authorName = String(input.authorName || '').trim()
  if (authorName.length < 2 || authorName.length > 60) return { ok: false, error: 'Enter the name you would like shown with the review (2–60 characters).' }
  // The photo/link guard: a review is text, not a place to advertise.
  if (/https?:\/\//i.test(body) || /<[a-z!/]/i.test(body)) return { ok: false, error: 'Links and markup are not allowed in a review.' }
  return { ok: true }
}

/** Published reviews for one product, newest first. One indexed query. */
export async function listPublishedReviews(db: D1Database, productId: number, limit = 20): Promise<Review[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM reviews WHERE product_id = ? AND status = 'published'
        ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .bind(productId, limit)
    .all<Row>()
  return (results || []).map(toReview)
}

/** The aggregate shown on a PDP, computed from published rows only. */
export async function reviewSummary(db: D1Database, productId: number): Promise<ReviewSummary> {
  const rows = (
    await db
      .prepare("SELECT rating, COUNT(*) AS n FROM reviews WHERE product_id = ? AND status = 'published' GROUP BY rating")
      .bind(productId)
      .all<Row>()
  ).results || []
  const histogram: ReviewSummary['histogram'] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  let count = 0
  let sum = 0
  for (const r of rows) {
    const star = Number(r.rating) as 1 | 2 | 3 | 4 | 5
    const n = Number(r.n) || 0
    if (star >= 1 && star <= 5) histogram[star] = n
    count += n
    sum += star * n
  }
  return {
    publishedCount: count,
    averageRating: count > 0 ? Math.round((sum / count) * 10) / 10 : null,
    histogram
  }
}

/**
 * Creates a PENDING review. Server-derived facts only:
 *   * `verified_purchase` is true only when a non-cancelled order owned by the
 *     author (signed-in user, or a guest token for the same order) contains
 *     that product;
 *   * one review per signed-in customer per product (enforced by a unique
 *     index AND checked here so the caller gets a readable error).
 */
export async function createReview(
  db: D1Database,
  input: ReviewInput,
  author: { userId: number | null }
): Promise<{ ok: true; id: number; verifiedPurchase: boolean } | { ok: false; error: string }> {
  const validation = validateReview(input)
  if (!validation.ok) return validation

  const product = await db.prepare('SELECT id FROM products WHERE slug = ? AND active = 1').bind(input.productSlug).first<{ id: number }>()
  if (!product) return { ok: false, error: 'That product is not available.' }

  if (author.userId != null) {
    const existing = await db
      .prepare('SELECT id FROM reviews WHERE product_id = ? AND user_id = ?')
      .bind(product.id, author.userId)
      .first<Row>()
    if (existing) return { ok: false, error: 'You have already reviewed this title.' }
  }

  const verified = await findVerifiedOrder(db, product.id, author.userId)
  const now = new Date().toISOString()
  const res = await db
    .prepare(
      `INSERT INTO reviews (product_id, user_id, author_name, rating, title, body, status, verified_purchase, order_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
    )
    .bind(
      product.id,
      author.userId,
      input.authorName.trim(),
      Number(input.rating),
      String(input.title || '').trim(),
      input.body.trim(),
      verified.orderId ? 1 : 0,
      verified.orderId,
      now,
      now
    )
    .run()
  return { ok: true, id: Number(res.meta?.last_row_id || 0), verifiedPurchase: !!verified.orderId }
}

/**
 * Looks for a real order that contains this product for this author. Only
 * orders that were actually recorded (any status — the order itself is the
 * proof of purchase in this build, which collects no payment) count.
 */
async function findVerifiedOrder(db: D1Database, productId: number, userId: number | null): Promise<{ orderId: number | null }> {
  if (userId != null) {
    const row = await db
      .prepare(
        `SELECT o.id FROM orders o
           JOIN order_items oi ON oi.order_id = o.id
          WHERE o.user_id = ? AND oi.product_id = ? AND o.status <> 'cancelled'
          ORDER BY o.id DESC LIMIT 1`
      )
      .bind(userId, productId)
      .first<Row>()
    if (row) return { orderId: Number(row.id) }
  }
  return { orderId: null }
}

// ---------------------------------------------------------------------------
// moderation (ADM-15)
// ---------------------------------------------------------------------------

export const REVIEW_STATUSES: ReviewStatus[] = ['pending', 'published', 'rejected']

export type ModerationAction = 'publish' | 'reject'

export async function moderateReview(
  db: D1Database,
  id: number,
  action: ModerationAction,
  moderatorId: number | null,
  reason = ''
): Promise<{ ok: true; status: ReviewStatus } | { ok: false; error: string }> {
  if (action !== 'publish' && action !== 'reject') return { ok: false, error: 'Unknown moderation action.' }
  const status: ReviewStatus = action === 'publish' ? 'published' : 'rejected'
  if (action === 'reject' && !reason.trim()) return { ok: false, error: 'A reason is required when rejecting a review.' }
  const existing = await db.prepare('SELECT id FROM reviews WHERE id = ?').bind(id).first<Row>()
  if (!existing) return { ok: false, error: 'That review no longer exists.' }
  await db
    .prepare('UPDATE reviews SET status = ?, moderated_by = ?, moderated_at = ?, moderation_reason = ?, updated_at = ? WHERE id = ?')
    .bind(status, moderatorId, new Date().toISOString(), reason.trim(), new Date().toISOString(), id)
    .run()
  return { ok: true, status }
}

export type ReviewListFilters = {
  status: ReviewStatus | 'all'
  productSlug: string
  q: string
  page: number
  perPage: number
}

export function parseReviewFilters(params: URLSearchParams): ReviewListFilters {
  const statusRaw = String(params.get('status') || 'pending')
  const status = (REVIEW_STATUSES as readonly string[]).concat('all').includes(statusRaw) ? (statusRaw as ReviewStatus | 'all') : 'pending'
  const page = Math.max(1, Number(params.get('page') || 1) || 1)
  return {
    status,
    productSlug: String(params.get('product') || '').trim(),
    q: String(params.get('q') || '').trim().slice(0, 80),
    page,
    perPage: 20
  }
}

/** The moderation queue. One COUNT + one page query, no per-row lookups. */
export async function listReviews(
  db: D1Database,
  f: ReviewListFilters
): Promise<{ items: Review[]; total: number; page: number; pageCount: number }> {
  const where: string[] = []
  const params: unknown[] = []
  if (f.status !== 'all') {
    where.push('r.status = ?')
    params.push(f.status)
  }
  if (f.productSlug) {
    where.push('p.slug = ?')
    params.push(f.productSlug)
  }
  if (f.q) {
    where.push('(LOWER(r.body) LIKE ? OR LOWER(r.author_name) LIKE ?)')
    const like = `%${f.q.toLowerCase()}%`
    params.push(like, like)
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const total = Number(
    (
      await db
        .prepare(`SELECT COUNT(*) AS n FROM reviews r JOIN products p ON p.id = r.product_id ${clause}`)
        .bind(...params)
        .first<Row>()
    )?.n || 0
  )
  const pageCount = Math.max(1, Math.ceil(total / f.perPage))
  const page = Math.min(f.page, pageCount)
  const rows =
    (
      await db
        .prepare(
          `SELECT r.*, p.slug AS product_slug, p.title AS product_title
             FROM reviews r JOIN products p ON p.id = r.product_id
             ${clause}
            ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.created_at DESC, r.id DESC
            LIMIT ? OFFSET ?`
        )
        .bind(...params, f.perPage, (page - 1) * f.perPage)
        .all<Row>()
    ).results || []
  return { items: rows.map(toReview), total, page, pageCount }
}

/** Counts per status for the admin badge. One query. */
export async function reviewStatusCounts(db: D1Database): Promise<Record<ReviewStatus, number>> {
  const rows = (await db.prepare('SELECT status, COUNT(*) AS n FROM reviews GROUP BY status').all<Row>()).results || []
  const out: Record<ReviewStatus, number> = { pending: 0, published: 0, rejected: 0 }
  for (const r of rows) {
    const s = String(r.status) as ReviewStatus
    if (s in out) out[s] = Number(r.n) || 0
  }
  return out
}
