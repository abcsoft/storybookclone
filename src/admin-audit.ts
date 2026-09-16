// Immutable admin audit trail (S-09 prerequisite for Phase 6's full RBAC).
//
// Every high-risk admin mutation appends exactly one row to
// `admin_audit_events` (migration 0015): who did it, what they did, to which
// entity, an optional human reason and redacted metadata. The table is
// append-only at the DB level (UPDATE/DELETE blocked by triggers).
//
// Redaction is enforced here, not by convention: any metadata key that looks
// like a secret/token/hash/photo key is dropped before the row is written, so
// an audit event can never become a second place a secret leaks from.

/** Metadata keys that must never be persisted in an audit row. */
const REDACTED_KEY = /(secret|token|password|passwd|hash|api[_-]?key|authorization|cookie|photo|upload|r2|signature|card|cvv)/i

export type AdminAuditInput = {
  actorUserId: number | null
  actorEmail: string | null
  /** V2 Phase 6 (ADM-20): the roles the actor held at the time, e.g. "finance operations". */
  actorRole?: string | null
  /** V2 Phase 6: the request correlation id, so an event can be tied to a log line. */
  requestId?: string | null
  /** V2 Phase 6: 'ui' | 'api' | 'system' — which surface the action came from. */
  source?: string | null
  action: string
  entityType: string
  entityId?: string | number | null
  reason?: string | null
  metadata?: Record<string, unknown>
}

export function redactAuditMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(metadata || {})) {
    if (REDACTED_KEY.test(k)) continue
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      // Recurse — a nested { password } must be dropped just like a top-level one.
      out[k] = redactAuditMetadata(v as Record<string, unknown>)
      continue
    }
    if (typeof v === 'string' && v.length > 200) {
      out[k] = v.slice(0, 200) + '…'
      continue
    }
    if (Array.isArray(v)) {
      out[k] = v.map((item) => (item && typeof item === 'object' ? redactAuditMetadata(item as Record<string, unknown>) : item))
      continue
    }
    out[k] = v
  }
  return out
}

/**
 * Appends one audit event. Never throws: a failure to audit must surface to
 * the caller (which decides whether to fail the action), so the boolean is
 * returned rather than an exception being swallowed.
 */
export async function recordAdminAudit(db: D1Database, input: AdminAuditInput): Promise<boolean> {
  try {
    await db
      .prepare(
        `INSERT INTO admin_audit_events (actor_user_id, actor_email, actor_role, request_id, source, action, entity_type, entity_id, reason, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.actorUserId ?? null,
        input.actorEmail ?? null,
        input.actorRole ? String(input.actorRole).slice(0, 200) : null,
        input.requestId ? String(input.requestId).slice(0, 80) : null,
        input.source ? String(input.source).slice(0, 16) : null,
        String(input.action),
        String(input.entityType),
        input.entityId == null ? null : String(input.entityId),
        input.reason ? String(input.reason).slice(0, 500) : null,
        JSON.stringify(redactAuditMetadata(input.metadata))
      )
      .run()
    return true
  } catch (err) {
    console.error('[admin-audit] failed to record event:', err instanceof Error ? err.message : err)
    return false
  }
}
