// Append-only approval decisions (migration 0012). Nothing in Phase 2
// actually grants a real approval yet (there's no preview to approve) —
// this module exists so the invalidate-on-edit rule (section 5) is correct
// and tested now, ready for Phase 3 to call getActiveApproval()/insert the
// first real 'approved' row.
export type ApprovalRow = {
  id: number
  user_book_id: number
  preview_version_id: number
  input_revision: number
  decision: 'approved' | 'invalidated'
  decided_by_type: string
  decided_by_id: string | null
  created_at: string
}

/**
 * The active approval is simply "the most recent decision row for this
 * book, if it's 'approved'". Because invalidation always inserts a new
 * row (never edits the old one), an invalidated approval is always
 * superseded by a later row — so the latest row alone tells the whole
 * story; no need to reason about older rows for a different preview
 * version.
 */
export async function getActiveApproval(db: D1Database, userBookId: number): Promise<ApprovalRow | null> {
  const row = await db.prepare('SELECT * FROM approvals WHERE user_book_id = ? ORDER BY id DESC LIMIT 1').bind(userBookId).first<ApprovalRow>()
  return row && row.decision === 'approved' ? row : null
}

/** Returns the D1Statement to invalidate the currently-active approval (if any), for inclusion in an atomic batch — or null if there is nothing to invalidate. */
export function buildInvalidateActiveApprovalStmt(
  db: D1Database,
  active: ApprovalRow | null,
  ctx: { actorType: string; actorId: string | null }
) {
  if (!active) return null
  return db
    .prepare('INSERT INTO approvals (user_book_id, preview_version_id, input_revision, decision, decided_by_type, decided_by_id) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(active.user_book_id, active.preview_version_id, active.input_revision, 'invalidated', ctx.actorType, ctx.actorId)
}
