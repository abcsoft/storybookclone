// Shared types for the Phase 2 personalization domain. Kept separate from
// src/db.ts's existing storefront types (Product, ProductRow) — this is a
// distinct bounded context.

// The currently-valid states. `user_books.state` itself has NO CHECK enum in
// the database (see migration 0011's comment on why) — this is the single
// source of truth for "what's valid right now". Later phases extend this
// list, never rewrite it.
//
// `manual_photo_review` is the ONE honest modelled outcome when no
// production face-analysis provider is configured: the book is explicitly
// flagged for human review and checkout is allowed (see C-01/C-02/C-03).
//
// V2 Phase 3 EXTENDED this list (never rewrote it) with the generation half of
// the canonical state contract in §7 of the coding pack: generation_queued,
// generating, preview_ready, revision_requested, approved, production_queued,
// production_ready and the companion terminal states photo_rejected,
// generation_failed and production_failed. Only the states up to
// `revision_requested` are reachable in Phase 3; the production states are
// declared here so the contract is complete and Phase 7 does not have to
// invent them.
export type UserBookState =
  | 'draft'
  | 'awaiting_photo_analysis'
  | 'awaiting_face_selection'
  | 'ready_to_generate'
  | 'manual_photo_review'
  | 'generation_queued'
  | 'generating'
  | 'preview_ready'
  | 'revision_requested'
  | 'approved'
  | 'production_queued'
  | 'production_ready'
  | 'photo_rejected'
  | 'generation_failed'
  | 'production_failed'
  | 'expired'
  | 'cancelled'

export const USER_BOOK_STATES: readonly UserBookState[] = [
  'draft',
  'awaiting_photo_analysis',
  'awaiting_face_selection',
  'ready_to_generate',
  'manual_photo_review',
  'generation_queued',
  'generating',
  'preview_ready',
  'revision_requested',
  'approved',
  'production_queued',
  'production_ready',
  'photo_rejected',
  'generation_failed',
  'production_failed',
  'expired',
  'cancelled'
]

export type ActorType = 'user' | 'prospect' | 'admin' | 'system'

export type UserBookRow = {
  id: number
  public_id: string
  product_id: number
  template_id: number | null
  user_id: number | null
  prospect_id: string | null
  state: string
  current_revision: number
  selected_upload_key: string | null
  selected_face_id: string | null
  idempotency_key: string | null
  consent_at: string | null
  // PER-09: the consent wording version the owner accepted. NULL means the
  // book predates consent versioning — never back-filled with a guess.
  consent_version: string | null
  retention_deadline: number | null
  version: number
  created_at: string
  updated_at: string
}

export type DetectedFaceRow = {
  id: string
  upload_key: string
  sort_order: number
  bbox_x: number
  bbox_y: number
  bbox_w: number
  bbox_h: number
  confidence: number
  category: 'child' | 'adult' | 'unknown'
  crop_object_key: string | null
  created_at: string
}

export type PersonalizationInputRow = {
  id: number
  user_book_id: number
  revision: number
  child_name: string
  child_age: number | null
  language_code: string
  dedication: string
  photo_upload_key: string
  created_at: string
}

/** A stable, machine-readable error every domain service throws — never a bare Error. */
export class DomainError extends Error {
  code: string
  status: number
  fields?: Record<string, string>
  constructor(code: string, message: string, status = 400, fields?: Record<string, string>) {
    super(message)
    this.code = code
    this.status = status
    this.fields = fields
  }
}

/** The canonical JSON error shape every Phase 2 route returns. */
export function errorBody(err: DomainError, requestId: string) {
  return {
    error: {
      code: err.code,
      message: err.message,
      fields: err.fields,
      requestId
    }
  }
}

export function newRequestId(): string {
  return crypto.randomUUID()
}
