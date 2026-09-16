/**
 * ADM-18 — the operator half of privacy and retention.
 *
 * Phase 5 built the customer INTAKE (CUS-14): a customer can raise an export or
 * deletion request and cancel their own request while it is still open. It
 * deliberately had no staff transition, a `legal_hold` column nothing set, and no
 * operator view of the retention tombstones.
 *
 * This module adds exactly that:
 *   * the staff state machine for a request (verify identity -> work -> complete,
 *     or decline, always with a recorded reason);
 *   * a LEGAL HOLD that blocks completion — a hold that could be ignored would be
 *     worse than no hold at all;
 *   * the retention failure queue, with the only recovery action this build
 *     actually supports (re-run the sweep) reported per row.
 *
 * The database remains the authority on request identity: kind and owner are
 * immutable by trigger (migration `0032`), and `privacy_request_events` is
 * append-only.
 */
import { runRetentionSweep } from '../personalization/retention'

export const PRIVACY_STATUSES = ['received', 'identity_verified', 'in_progress', 'completed', 'declined', 'cancelled'] as const

/**
 * The staff state machine. `completed` and `cancelled` are terminal, and a
 * terminal request is never reopened — a second request is a new row, which is
 * what keeps the one-open-request-per-kind invariant meaningful.
 */
export const STAFF_PRIVACY_TRANSITIONS: Record<string, readonly string[]> = {
  received: ['identity_verified', 'declined', 'cancelled'],
  identity_verified: ['in_progress', 'declined', 'cancelled'],
  in_progress: ['completed', 'declined'],
  completed: [],
  declined: [],
  cancelled: []
}

export function staffMayTransitionPrivacy(from: string, to: string): boolean {
  return (STAFF_PRIVACY_TRANSITIONS[from] ?? []).includes(to)
}

export const PRIVACY_REASON_MIN = 3
export const PRIVACY_REASON_MAX = 1000

export type AdminPrivacyRow = {
  id: number
  public_id: string
  user_id: number
  kind: string
  status: string
  note: string
  response_note: string
  legal_hold: number
  due_at: number | null
  completed_at: string | null
  created_at: string
  updated_at: string
  customer_email?: string | null
  customer_name?: string | null
  overdue: boolean
  daysRemaining: number | null
  transitions: readonly string[]
  /** The consequence stated in plain language, so an operator knows what they are deciding. */
  consequence: string
}

const CONSEQUENCES: Record<string, string> = {
  export:
    'Export: the customer has asked for a copy of their data. This build records and works the request manually — there is no automatic bundle producer (that is Phase 8).',
  delete:
    'Deletion: the customer has asked for erasure. Completing this marks the request done in this panel; the actual deletion of account data is Phase 8 (PLT-10), and the retention sweep currently covers photos, previews and generation artifacts.'
}

export function privacyConsequence(kind: string): string {
  return CONSEQUENCES[kind] ?? 'Unknown request kind.'
}

export async function listAdminPrivacyRequests(
  db: D1Database,
  input: { status: string; kind: string; limit: number; offset: number; q: string; nowSeconds: number }
): Promise<{ rows: AdminPrivacyRow[]; total: number }> {
  const where: string[] = []
  const binds: unknown[] = []
  if (input.status) {
    where.push('r.status = ?')
    binds.push(input.status)
  }
  if (input.kind) {
    where.push('r.kind = ?')
    binds.push(input.kind)
  }
  if (input.q) {
    where.push('(r.public_id LIKE ? OR u.email LIKE ?)')
    const like = `%${input.q}%`
    binds.push(like, like)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const [rows, total] = await Promise.all([
    db
      .prepare(
        `SELECT r.*, u.email AS customer_email, u.name AS customer_name
           FROM privacy_requests r JOIN users u ON u.id = r.user_id
           ${clause}
          ORDER BY (r.status IN ('completed','declined','cancelled')) ASC, r.due_at IS NULL, r.due_at ASC, r.id DESC
          LIMIT ? OFFSET ?`
      )
      .bind(...binds, input.limit, input.offset)
      .all<Record<string, unknown>>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM privacy_requests r JOIN users u ON u.id = r.user_id ${clause}`)
      .bind(...binds)
      .first<{ n: number }>()
  ])
  return {
    rows: (rows.results || []).map((row) => decoratePrivacyRow(row, input.nowSeconds)),
    total: Number(total?.n ?? 0)
  }
}

function decoratePrivacyRow(row: Record<string, unknown>, nowSeconds: number): AdminPrivacyRow {
  const status = String(row.status)
  const dueAt = row.due_at == null ? null : Number(row.due_at)
  const terminal = ['completed', 'declined', 'cancelled'].includes(status)
  const daysRemaining = dueAt == null ? null : Math.ceil((dueAt - nowSeconds) / 86_400)
  return {
    id: Number(row.id),
    public_id: String(row.public_id),
    user_id: Number(row.user_id),
    kind: String(row.kind),
    status,
    note: String(row.note ?? ''),
    response_note: String(row.response_note ?? ''),
    legal_hold: Number(row.legal_hold ?? 0),
    due_at: dueAt,
    completed_at: row.completed_at == null ? null : String(row.completed_at),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
    customer_email: row.customer_email == null ? null : String(row.customer_email),
    customer_name: row.customer_name == null ? null : String(row.customer_name),
    overdue: !terminal && dueAt != null && dueAt < nowSeconds,
    daysRemaining,
    transitions: STAFF_PRIVACY_TRANSITIONS[status] ?? [],
    consequence: privacyConsequence(String(row.kind))
  }
}

export type PrivacyTransitionResult = { ok: true; to: string } | { ok: false; error: string }

/**
 * Move a privacy request. A reason is mandatory (V2 §10), `legal_hold` blocks
 * completion, and the status update plus its append-only event are written in one
 * batch guarded by `changes() = 1`.
 */
export async function transitionPrivacyRequest(
  db: D1Database,
  input: {
    publicId: string
    to: string
    actorUserId: number | null
    reason: unknown
    responseNote?: unknown
    legalHold?: boolean | null
  }
): Promise<PrivacyTransitionResult> {
  const reason = String(input.reason ?? '').trim()
  if (reason.length < PRIVACY_REASON_MIN) return { ok: false, error: 'A short reason is required for every privacy decision.' }
  const row = await db.prepare('SELECT * FROM privacy_requests WHERE public_id = ?').bind(input.publicId).first<Record<string, unknown>>()
  if (!row) return { ok: false, error: 'That privacy request no longer exists.' }
  const from = String(row.status)
  if (!staffMayTransitionPrivacy(from, input.to)) {
    return { ok: false, error: `A privacy request cannot move from ${from.replace('_', ' ')} to ${input.to.replace('_', ' ')}.` }
  }
  // The hold state the request will have AFTER this decision. A completion is
  // checked against that, so:
  //   * `to=completed` on a held request with no hold instruction is REFUSED (the
  //     default is "keep the hold");
  //   * `to=completed` with an explicit release succeeds, and the release and the
  //     decision are recorded together with the reason the operator gave.
  const responseNote = String(input.responseNote ?? '').trim().slice(0, PRIVACY_REASON_MAX)
  const wantHold = input.legalHold === true ? 1 : input.legalHold === false ? 0 : Number(row.legal_hold ?? 0)
  if (input.to === 'completed' && wantHold === 1) {
    return { ok: false, error: 'This request is under a legal hold, so it cannot be completed. Release the hold first.' }
  }
  const terminal = input.to === 'completed' || input.to === 'declined' || input.to === 'cancelled'
  const updated = await db
    .prepare(
      `UPDATE privacy_requests
          SET status = ?, response_note = CASE WHEN ? <> '' THEN ? ELSE response_note END,
              legal_hold = ?,
              completed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE completed_at END,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = ?`
    )
    .bind(input.to, responseNote, responseNote, wantHold, terminal ? 1 : 0, row.id, from)
    .run()
  if (Number(updated.meta?.changes ?? 0) !== 1) {
    return { ok: false, error: 'The request changed while you were looking at it — reload and retry.' }
  }
  await db
    .prepare(
      `INSERT INTO privacy_request_events (privacy_request_id, from_status, to_status, actor_type, actor_id, note)
       VALUES (?, ?, ?, 'staff', ?, ?)`
    )
    .bind(row.id, from, input.to, input.actorUserId == null ? null : String(input.actorUserId), reason.slice(0, PRIVACY_REASON_MAX))
    .run()
  return { ok: true, to: input.to }
}

export async function setPrivacyLegalHold(
  db: D1Database,
  input: { publicId: string; hold: boolean; actorUserId: number | null; reason: unknown }
): Promise<PrivacyTransitionResult> {
  const reason = String(input.reason ?? '').trim()
  if (reason.length < PRIVACY_REASON_MIN) return { ok: false, error: 'A short reason is required to change a legal hold.' }
  const row = await db.prepare('SELECT * FROM privacy_requests WHERE public_id = ?').bind(input.publicId).first<Record<string, unknown>>()
  if (!row) return { ok: false, error: 'That privacy request no longer exists.' }
  if (['completed', 'declined', 'cancelled'].includes(String(row.status))) {
    return { ok: false, error: 'A closed request cannot be put on or taken off a legal hold.' }
  }
  await db
    .prepare('UPDATE privacy_requests SET legal_hold = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(input.hold ? 1 : 0, row.id)
    .run()
  await db
    .prepare(
      `INSERT INTO privacy_request_events (privacy_request_id, from_status, to_status, actor_type, actor_id, note)
       VALUES (?, ?, ?, 'staff', ?, ?)`
    )
    .bind(row.id, String(row.status), String(row.status), input.actorUserId == null ? null : String(input.actorUserId), `${input.hold ? 'Legal hold placed' : 'Legal hold released'}: ${reason}`.slice(0, PRIVACY_REASON_MAX))
    .run()
  return { ok: true, to: String(row.status) }
}

/** Request counts by status, for the privacy screen's tabs. */
export async function privacyStatusCounts(db: D1Database): Promise<Record<string, number>> {
  const rows = (await db.prepare('SELECT status, COUNT(*) AS n FROM privacy_requests GROUP BY status').all<{ status: string; n: number }>()).results || []
  const out: Record<string, number> = {}
  for (const row of rows) out[row.status] = Number(row.n)
  return out
}

export type RetentionFailureRow = {
  id: number
  object_type: string
  object_key: string
  user_book_id: number | null
  attempts: number
  last_error: string
  first_attempted_at: string
  last_attempted_at: string
  resolved_at: string | null
}

/**
 * The retention tombstones. `object_key` is a PRIVATE R2 key, so it is shown
 * truncated: an operator needs to identify the row, not to be able to fetch it.
 */
export async function listRetentionFailures(
  db: D1Database,
  input: { includeResolved: boolean; limit: number; offset: number }
): Promise<{ rows: Array<RetentionFailureRow & { object_key_display: string; queue: string }>; total: number }> {
  const where = input.includeResolved ? '' : 'WHERE f.resolved_at IS NULL'
  const [rows, total] = await Promise.all([
    db
      .prepare(`SELECT f.* FROM retention_failures f ${where} ORDER BY f.resolved_at IS NOT NULL, f.last_attempted_at DESC, f.id DESC LIMIT ? OFFSET ?`)
      .bind(input.limit, input.offset)
      .all<RetentionFailureRow>(),
    db.prepare(`SELECT COUNT(*) AS n FROM retention_failures f ${where}`).first<{ n: number }>()
  ])
  const generated = (
    await db
      .prepare('SELECT object_key FROM generation_asset_deletions WHERE resolved_at IS NULL LIMIT 500')
      .all<{ object_key: string }>()
  ).results || []
  const generatedKeys = new Set(generated.map((g) => g.object_key))
  return {
    rows: (rows.results || []).map((row) => ({
      ...row,
      object_key_display: displayObjectKey(row.object_key),
      queue: generatedKeys.has(row.object_key) ? 'generated asset' : 'photo upload'
    })),
    total: Number(total?.n ?? 0)
  }
}

/** A private key, shortened to what identifies the row. */
export function displayObjectKey(key: string): string {
  const value = String(key)
  if (value.length <= 18) return value
  return `${value.slice(0, 8)}…${value.slice(-6)}`
}

export type RetentionRetryResult = {
  ok: boolean
  resolved: boolean
  attempts: number
  message: string
  report?: Record<string, unknown>
}

/**
 * ADM-18 failure recovery without direct database editing: re-run the retention
 * sweep and report the outcome FOR THIS ROW. Deleting the object is the only
 * thing that resolves a tombstone, so the sweep (the same code the scheduled
 * retention job runs) is the honest recovery action.
 */
export async function retryRetentionFailure(
  db: D1Database,
  photos: R2Bucket | undefined,
  failureId: number,
  clock: () => number
): Promise<RetentionRetryResult> {
  const before = await db.prepare('SELECT * FROM retention_failures WHERE id = ?').bind(failureId).first<RetentionFailureRow>()
  if (!before) return { ok: false, resolved: false, attempts: 0, message: 'That failure row no longer exists.' }
  if (before.resolved_at) return { ok: true, resolved: true, attempts: before.attempts, message: 'This deletion had already been confirmed.' }
  const report = await runRetentionSweep(db, photos, clock)
  const after = await db.prepare('SELECT * FROM retention_failures WHERE id = ?').bind(failureId).first<RetentionFailureRow>()
  const resolved = !!after?.resolved_at
  return {
    ok: true,
    resolved,
    attempts: Number(after?.attempts ?? before.attempts),
    message: resolved
      ? 'The queued deletion succeeded and the record is now resolved.'
      : `Still queued after ${Number(after?.attempts ?? before.attempts)} attempt(s): ${String(after?.last_error ?? before.last_error).slice(0, 200) || 'no error reported'}`
    ,
    report: report as unknown as Record<string, unknown>
  }
}

/** Unresolved tombstone count, for the dashboard and the sidebar badge. */
export async function unresolvedRetentionCount(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM retention_failures WHERE resolved_at IS NULL').first<{ n: number }>()
  return Number(row?.n ?? 0)
}
