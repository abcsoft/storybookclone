// ADM-05/ADM-11 — the User Books operator surface.
//
// Before this module, `/admin/books` listed books and every row linked to
// `/admin/books/:id`, which did not exist: a dead link, and `books.manage` was
// granted to two seeded roles but gated NOTHING. This is the read model and the
// one state action behind that screen, so the §10 "User Books → inputs/faces,
// generations/previews, revisions/approvals" node is real rather than a list.
//
// The rules the rest of the admin panel already follows apply here:
//   * bounded reads, ordered, with an explicit limit (no N+1);
//   * a valid TRANSITION rather than a free-text status field;
//   * an accepted change goes through the domain state machine (one CAS update
//     plus one append-only `user_book_events` row), never a direct UPDATE here.
import { cancelUserBook, expireUserBook } from '../personalization/state-machine'
import { isOrderableBookState } from '../personalization/types'
import type { UserBookRow } from '../personalization/types'

/** Every state an operator may move a book TO through this surface. */
export const USER_BOOK_OPERATOR_STATES = ['cancelled', 'expired'] as const
export type UserBookOperatorState = (typeof USER_BOOK_OPERATOR_STATES)[number]

export function isUserBookOperatorState(value: string): value is UserBookOperatorState {
  return (USER_BOOK_OPERATOR_STATES as readonly string[]).includes(value)
}

/** The states a book can still be moved out of; terminal states refuse. */
const TERMINAL_STATES = new Set(['expired', 'cancelled'])

export type UserBookRevision = {
  revision: number
  childName: string
  childAge: number | null
  languageCode: string
  dedication: string
  hasPhoto: boolean
  isCurrent: boolean
  createdAt: string | null
}

export type UserBookFace = {
  id: string
  sortOrder: number
  confidence: number
  category: string
  selected: boolean
}

export type UserBookJob = {
  publicId: string
  status: string
  inputRevision: number
  attempts: number
  maxAttempts: number
  createdAt: string | null
  updatedAt: string | null
}

export type UserBookPreview = {
  id: number
  version: number
  inputRevision: number
  status: string
  sceneCount: number
  pageAssets: number
  watermarkLabel: string | null
  finalizedAt: string | null
  approved: boolean
}

export type UserBookEvent = {
  eventType: string
  actorType: string
  fromState: string | null
  toState: string
  createdAt: string | null
}

export type UserBookDetail = {
  book: {
    publicId: string
    state: string
    currentRevision: number
    version: number
    retentionDeadline: string | null
    consentAt: string | null
    createdAt: string | null
    updatedAt: string | null
    ownerType: 'user' | 'prospect'
    ownerLabel: string
    productTitle: string | null
  }
  revisions: UserBookRevision[]
  faces: UserBookFace[]
  jobs: UserBookJob[]
  previews: UserBookPreview[]
  events: UserBookEvent[]
  /** True when the cart/order path would accept this book right now. */
  orderable: boolean
}

/** Read-side bound. A book rarely has more than a handful of these. */
const DETAIL_LIMIT = 25

/**
 * Everything the detail screen shows, in a fixed number of queries (no N+1):
 * the book + owner, its revisions, the faces detected on the SELECTED photo,
 * its generation jobs, its preview versions with their watermarked page counts,
 * and its recent domain events.
 */
export async function userBookDetail(db: D1Database, publicId: string): Promise<UserBookDetail | null> {
  const book = await db
    .prepare(
      `SELECT b.*, u.email AS owner_email, u.name AS owner_name, p.title AS product_title
         FROM user_books b
         LEFT JOIN users u ON u.id = b.user_id
         LEFT JOIN products p ON p.id = b.product_id
        WHERE b.public_id = ?`
    )
    .bind(publicId)
    .first<Record<string, any>>()
  if (!book) return null

  const [revisions, faces, jobs, previews, events] = await Promise.all([
    db
      .prepare(
        `SELECT revision, child_name, child_age, language_code, dedication, photo_upload_key, created_at
           FROM personalization_inputs WHERE user_book_id = ? ORDER BY revision DESC LIMIT ?`
      )
      .bind(book.id, DETAIL_LIMIT)
      .all<Record<string, any>>(),
    book.selected_upload_key
      ? db
          .prepare('SELECT id, sort_order, confidence, category FROM detected_faces WHERE upload_key = ? ORDER BY sort_order LIMIT ?')
          .bind(book.selected_upload_key, DETAIL_LIMIT)
          .all<Record<string, any>>()
      : Promise.resolve({ results: [] as Record<string, any>[] }),
    db
      .prepare(
        `SELECT public_id, status, input_revision, attempt_count, max_attempts, created_at, updated_at
           FROM generation_jobs WHERE user_book_id = ? ORDER BY id DESC LIMIT ?`
      )
      .bind(book.id, DETAIL_LIMIT)
      .all<Record<string, any>>(),
    db
      .prepare(
        `SELECT pv.id, pv.input_revision, pv.status, pv.scene_count, pv.watermark_label, pv.finalized_at, pv.created_at,
                (SELECT COUNT(*) FROM preview_assets pa WHERE pa.preview_version_id = pv.id AND pa.asset_type = 'page_preview') AS page_assets
           FROM preview_versions pv WHERE pv.user_book_id = ? ORDER BY pv.id DESC LIMIT ?`
      )
      .bind(book.id, DETAIL_LIMIT)
      .all<Record<string, any>>(),
    db
      .prepare(
        `SELECT event_type, actor_type, from_state, to_state, created_at
           FROM user_book_events WHERE user_book_id = ? ORDER BY id DESC LIMIT ?`
      )
      .bind(book.id, DETAIL_LIMIT)
      .all<Record<string, any>>()
  ])

  const approvedVersionIds = new Set<number>()
  const approvalRows = await db
    .prepare("SELECT preview_version_id, decision FROM approvals WHERE user_book_id = ? ORDER BY id")
    .bind(book.id)
    .all<{ preview_version_id: number; decision: string }>()
  {
    // The LAST decision per version wins (the log is append-only).
    const latest = new Map<number, string>()
    for (const row of approvalRows.results || []) latest.set(Number(row.preview_version_id), String(row.decision))
    for (const [id, decision] of latest) if (decision === 'approved') approvedVersionIds.add(id)
  }

  return {
    book: {
      publicId: String(book.public_id),
      state: String(book.state),
      currentRevision: Number(book.current_revision ?? 0),
      version: Number(book.version ?? 0),
      retentionDeadline: book.retention_deadline ?? null,
      consentAt: book.consent_at ?? null,
      createdAt: book.created_at ?? null,
      updatedAt: book.updated_at ?? null,
      ownerType: book.user_id ? 'user' : 'prospect',
      ownerLabel: String(book.owner_email || book.owner_name || book.prospect_id || 'prospect'),
      productTitle: book.product_title ?? null
    },
    revisions: (revisions.results || []).map((r) => ({
      revision: Number(r.revision),
      childName: String(r.child_name ?? ''),
      childAge: r.child_age == null ? null : Number(r.child_age),
      languageCode: String(r.language_code ?? ''),
      dedication: String(r.dedication ?? ''),
      hasPhoto: !!r.photo_upload_key,
      isCurrent: Number(r.revision) === Number(book.current_revision),
      createdAt: r.created_at ?? null
    })),
    faces: (faces.results || []).map((f) => ({
      id: String(f.id),
      sortOrder: Number(f.sort_order ?? 0),
      confidence: Number(f.confidence ?? 0),
      category: String(f.category ?? 'unknown'),
      selected: String(f.id) === String(book.selected_face_id ?? '')
    })),
    jobs: (jobs.results || []).map((j) => ({
      publicId: String(j.public_id),
      status: String(j.status),
      inputRevision: Number(j.input_revision ?? 0),
      attempts: Number(j.attempt_count ?? 0),
      maxAttempts: Number(j.max_attempts ?? 0),
      createdAt: j.created_at ?? null,
      updatedAt: j.updated_at ?? null
    })),
    previews: (previews.results || []).map((p) => ({
      id: Number(p.id),
      version: Number(p.input_revision ?? 0),
      inputRevision: Number(p.input_revision ?? 0),
      status: String(p.status),
      sceneCount: Number(p.scene_count ?? 0),
      pageAssets: Number(p.page_assets ?? 0),
      watermarkLabel: p.watermark_label ?? null,
      finalizedAt: p.finalized_at ?? null,
      approved: approvedVersionIds.has(Number(p.id))
    })),
    events: (events.results || []).map((e) => ({
      eventType: String(e.event_type),
      actorType: String(e.actor_type),
      fromState: e.from_state ?? null,
      toState: String(e.to_state),
      createdAt: e.created_at ?? null
    })),
    orderable: isOrderableBookState(String(book.state)) && Number(book.current_revision ?? 0) > 0
  }
}

export type SetUserBookStateResult = { ok: true; state: string } | { ok: false; message: string }

/**
 * Move a book to `cancelled` or `expired` through the domain state machine.
 *
 * Refused (with a statement of the rule, not a raw DB error):
 *   * an unknown target state (this is a TRANSITION, not a status field),
 *   * a missing reason (every lifecycle change here records one),
 *   * a book already in a terminal state,
 *   * an optimistic-concurrency clash (the caller passed a stale version).
 */
export async function setUserBookState(
  db: D1Database,
  input: { publicId: string; to: string; actorUserId: number; reason: string; expectedVersion?: number }
): Promise<SetUserBookStateResult> {
  const reason = String(input.reason || '').trim()
  if (!isUserBookOperatorState(input.to)) {
    return { ok: false, message: `A book can only be moved to: ${USER_BOOK_OPERATOR_STATES.join(', ')}.` }
  }
  if (!reason) return { ok: false, message: 'A reason is required.' }
  if (reason.length > 500) return { ok: false, message: 'The reason is too long (500 characters maximum).' }

  const book = await db.prepare('SELECT * FROM user_books WHERE public_id = ?').bind(input.publicId).first<UserBookRow>()
  if (!book) return { ok: false, message: 'That user book does not exist.' }
  if (TERMINAL_STATES.has(String(book.state))) {
    return { ok: false, message: `This book is already ${String(book.state)}.` }
  }
  if (input.expectedVersion != null && Number(book.version) !== Number(input.expectedVersion)) {
    return { ok: false, message: 'This book changed while the page was open. Reload and check before acting.' }
  }

  // The domain state machine takes the actor separately from the reason; the
  // reason lands in the append-only event metadata it writes.
  const ctx = { actorType: 'admin' as const, actorId: String(input.actorUserId) }
  try {
    const updated: UserBookRow =
      input.to === 'cancelled' ? await cancelUserBook(db, book, ctx, reason) : await expireUserBook(db, book, ctx, reason)
    return { ok: true, state: String(updated.state) }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The book could not be updated.'
    return { ok: false, message }
  }
}
